'use strict';
/* "Asystent Claude": chat with Claude that can look at (and, with permission, act on)
   this server. Conversations are stored as JSON files; the chat itself runs over a
   WebSocket so answers stream in and tool calls can wait for the user's approval. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const AnthropicSDK = require('@anthropic-ai/sdk');
const auth = require('./auth');
const config = require('./config');
const taskmgr = require('./taskmgr');
const sessions = require('./sessions');

const Anthropic = AnthropicSDK.default || AnthropicSDK;
const DATA_DIR = path.join(__dirname, '..', 'data', 'assistant');

const MODELS = {
  'claude-opus-5': { label: 'Claude Opus 5', thinking: true, fallbacks: true },
  'claude-sonnet-5': { label: 'Claude Sonnet 5', thinking: true, fallbacks: false },
  'claude-haiku-4-5': { label: 'Claude Haiku 4.5', thinking: false, fallbacks: false },
  'claude-fable-5-1': { label: 'Claude Fable 5.1', thinking: true, fallbacks: true }
};
const DEFAULT_MODEL = 'claude-opus-5';
const MODES = ['ask', 'auto', 'chat']; // ask before changes / run without asking / no tools
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// ---------- settings (stored in config.json) ----------
function settings(cfg) {
  const a = cfg.assistant || {};
  return {
    model: MODELS[a.model] ? a.model : DEFAULT_MODEL,
    mode: MODES.includes(a.mode) ? a.mode : 'ask',
    effort: EFFORTS.includes(a.effort) ? a.effort : 'high',
    apiKey: a.apiKey || process.env.ANTHROPIC_API_KEY || ''
  };
}

function publicSettings(cfg) {
  const s = settings(cfg);
  return {
    model: s.model,
    mode: s.mode,
    effort: s.effort,
    hasKey: !!s.apiKey,
    keyHint: s.apiKey ? s.apiKey.slice(0, 7) + '…' + s.apiKey.slice(-4) : '',
    models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label }))
  };
}

function saveSettings(cfg, body) {
  const stored = JSON.parse(fs.readFileSync(config.CONFIG_PATH, 'utf8'));
  const a = { ...(stored.assistant || {}) };
  if (typeof body.apiKey === 'string') {
    const key = body.apiKey.trim();
    if (key && !/^sk-ant-[\w-]{20,}$/.test(key)) throw Object.assign(new Error('To nie wygląda na klucz API Anthropic (powinien zaczynać się od sk-ant-)'), { status: 400 });
    a.apiKey = key;
  }
  if (body.model && MODELS[body.model]) a.model = body.model;
  if (body.mode && MODES.includes(body.mode)) a.mode = body.mode;
  if (body.effort && EFFORTS.includes(body.effort)) a.effort = body.effort;
  stored.assistant = a;
  config.save(stored);
  cfg.assistant = a;
  return publicSettings(cfg);
}

// ---------- conversation storage ----------
function convPath(id) {
  if (!/^[a-f0-9]{16}$/.test(String(id))) throw Object.assign(new Error('Nieprawidłowy identyfikator rozmowy'), { status: 400 });
  return path.join(DATA_DIR, id + '.json');
}

function loadConv(id) {
  try { return JSON.parse(fs.readFileSync(convPath(id), 'utf8')); } catch { return null; }
}

function saveConv(conv) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  conv.updated = Date.now();
  const file = convPath(conv.id);
  fs.writeFileSync(file + '.tmp', JSON.stringify(conv), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

function listConvs() {
  let files = [];
  try { files = fs.readdirSync(DATA_DIR).filter((f) => /^[a-f0-9]{16}\.json$/.test(f)); } catch { return []; }
  return files.map((f) => {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      return { id: c.id, title: c.title, updated: c.updated, created: c.created };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.updated - a.updated);
}

function deleteConv(id) {
  try { fs.unlinkSync(convPath(id)); } catch { /* already gone */ }
}

// ---------- tools ----------
const TOOLS = [
  {
    name: 'run_command',
    description: 'Uruchamia polecenie powłoki bash na serwerze i zwraca jego wyjście (stdout i stderr, maks. ok. 30 000 znaków) oraz kod wyjścia. Limit czasu: 120 sekund. Nie używaj poleceń interaktywnych (np. top, nano, less) - użyj wersji nieinteraktywnych (top -bn1, cat, itp.).',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Polecenie do wykonania w bash' },
        cwd: { type: 'string', description: 'Katalog roboczy (opcjonalnie, domyślnie katalog domowy)' }
      },
      required: ['command']
    },
    mutating: true
  },
  {
    name: 'read_file',
    description: 'Czyta plik tekstowy z serwera (maks. 200 KB). Używaj do przeglądania konfiguracji, logów i kodu.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Ścieżka bezwzględna do pliku' } },
      required: ['path']
    },
    mutating: false
  },
  {
    name: 'list_directory',
    description: 'Wyświetla zawartość folderu na serwerze: nazwy, typ (plik/folder), rozmiar i datę modyfikacji.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Ścieżka bezwzględna do folderu' } },
      required: ['path']
    },
    mutating: false
  },
  {
    name: 'write_file',
    description: 'Zapisuje (tworzy lub nadpisuje) plik tekstowy na serwerze podaną treścią. Przed nadpisaniem ważnego pliku konfiguracyjnego rozważ zrobienie kopii zapasowej.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ścieżka bezwzględna do pliku' },
        content: { type: 'string', description: 'Pełna nowa treść pliku' }
      },
      required: ['path', 'content']
    },
    mutating: true
  },
  {
    name: 'system_info',
    description: 'Zwraca bieżący stan serwera: system, procesor, pamięć, dyski, sieć, czas działania i procesy zużywające najwięcej zasobów.',
    input_schema: { type: 'object', properties: {} },
    mutating: false
  }
];
const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

function apiTools() {
  // eager_input_streaming: large inputs (file contents) stream as they are generated;
  // inputs are validated in validateInput() before anything runs.
  return TOOLS.map(({ mutating, ...t }) => ({ ...t, eager_input_streaming: true })); // eslint-disable-line no-unused-vars
}

function validateInput(tool, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const props = tool.input_schema.properties;
  for (const req of tool.input_schema.required || []) {
    if (typeof input[req] !== 'string') return false;
  }
  for (const [k, v] of Object.entries(input)) {
    if (!props[k] || (v != null && typeof v !== 'string')) return false;
  }
  return true;
}

const MAX_OUT = 30000;
function truncate(s, max = MAX_OUT) {
  if (s.length <= max) return s;
  return s.slice(0, max / 2) + `\n\n[… pominięto ${s.length - max} znaków …]\n\n` + s.slice(-max / 2);
}

function runCommand(command, cwd, signal) {
  return new Promise((resolve) => {
    const home = os.userInfo().homedir;
    let dir = cwd || home;
    try { if (!fs.statSync(dir).isDirectory()) dir = home; } catch { dir = home; }
    const child = spawn('/bin/bash', ['-lc', command], { cwd: dir, env: { ...process.env, TERM: 'dumb', PAGER: 'cat', DEBIAN_FRONTEND: 'noninteractive' } });
    let out = '';
    const add = (d) => { if (out.length < MAX_OUT * 4) out += d.toString('utf8'); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const kill = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
    const timer = setTimeout(() => { out += '\n[Przekroczono limit 120 s – proces przerwany]'; kill(); }, 120000);
    if (signal) signal.addEventListener('abort', kill, { once: true });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ output: truncate(out.trim() || '(brak wyjścia)'), isError: code !== 0, code });
    });
    child.on('error', (err) => { clearTimeout(timer); resolve({ output: err.message, isError: true, code: -1 }); });
  });
}

async function executeTool(name, input, files, signal) {
  try {
    if (name === 'run_command') {
      const r = await runCommand(input.command, input.cwd, signal);
      return { output: `Kod wyjścia: ${r.code}\n${r.output}`, isError: r.isError };
    }
    if (name === 'read_file') {
      const abs = files.resolve(input.path);
      const st = fs.statSync(abs);
      if (st.isDirectory()) return { output: 'To jest folder – użyj list_directory', isError: true };
      if (st.size > 200 * 1024) {
        const fd = fs.openSync(abs, 'r');
        const buf = Buffer.alloc(200 * 1024);
        fs.readSync(fd, buf, 0, buf.length, Math.max(0, st.size - buf.length));
        fs.closeSync(fd);
        return { output: `[Plik ma ${st.size} bajtów – pokazuję ostatnie 200 KB]\n` + buf.toString('utf8'), isError: false };
      }
      const text = fs.readFileSync(abs, 'utf8');
      if (text.includes('\u0000')) return { output: 'To jest plik binarny – nie można go wyświetlić jako tekst', isError: true };
      return { output: text || '(pusty plik)', isError: false };
    }
    if (name === 'list_directory') {
      const listing = await files.list(input.path);
      const lines = listing.entries
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
        .slice(0, 500)
        .map((e) => `${e.type === 'dir' ? '[DIR] ' : '      '}${e.name}${e.type === 'dir' ? '/' : `  (${e.size} B)`}  ${new Date(e.mtime).toISOString().slice(0, 16).replace('T', ' ')}`);
      return { output: `${listing.path} – ${listing.entries.length} elementów\n` + lines.join('\n'), isError: false };
    }
    if (name === 'write_file') {
      const abs = files.resolve(input.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, input.content, 'utf8');
      return { output: `Zapisano ${Buffer.byteLength(input.content)} bajtów do ${abs}`, isError: false };
    }
    if (name === 'system_info') {
      const p = await taskmgr.perf();
      const procs = taskmgr.processes().list.filter((x) => !x.kthread).sort((a, b) => b.mem - a.mem).slice(0, 12);
      const gb = (b) => (b / 2 ** 30).toFixed(2) + ' GB';
      const lines = [
        `Host: ${p.hostname}, ${p.os}, jądro ${p.kernel}, działa ${Math.floor(p.uptime / 3600)} godz.`,
        `CPU: ${p.cpu.model}, ${p.cpu.logical} rdzeni logicznych, obciążenie ${p.load.map((l) => l.toFixed(2)).join(' / ')}`,
        `Pamięć: używane ${gb(p.memory.used)} z ${gb(p.memory.total)}, swap ${gb(p.memory.swapUsed)} z ${gb(p.memory.swapTotal)}`,
        ...p.disks.map((d) => `Dysk ${d.name} (${d.mounts.join(', ') || 'brak montowania'}): zajęte ${gb(d.used)} z ${gb(d.fsTotal || d.size)}`),
        ...p.net.map((n) => `Sieć ${n.iface}: IPv4 ${n.ipv4.join(', ') || '-'}`),
        `Procesy: ${p.cpu.processes}. Najwięcej pamięci:`,
        ...procs.map((x) => `  PID ${x.pid} ${x.name} (${x.user}) – ${(x.mem / 2 ** 20).toFixed(0)} MB`)
      ];
      return { output: lines.join('\n'), isError: false };
    }
    return { output: 'Nieznane narzędzie', isError: true };
  } catch (err) {
    const msg = { ENOENT: 'Nie ma takiego pliku ani folderu', EACCES: 'Brak uprawnień', EISDIR: 'To jest folder' }[err.code] || err.message;
    return { output: msg, isError: true };
  }
}

function systemPrompt() {
  const u = os.userInfo();
  const osName = ((() => { try { return fs.readFileSync('/etc/os-release', 'utf8'); } catch { return ''; } })().match(/^PRETTY_NAME="?([^"\n]+)"?/m) || [])[1] || os.type();
  return [
    'Jesteś Claude, asystentem wbudowanym w WebPulpit – panel w przeglądarce, przez który użytkownik obsługuje swój serwer jak pulpit Windows (pliki, terminal, menedżer zadań).',
    `Serwer: ${os.hostname()}, system ${osName}, ${os.cpus().length} rdzeni, ${(os.totalmem() / 2 ** 30).toFixed(1)} GB RAM. Narzędzia działają jako użytkownik systemowy „${u.username}” (katalog domowy ${u.homedir}).`,
    'Użytkownik zwykle pisze po polsku i nie jest administratorem Linuksa – odpowiadaj w jego języku, prosto i konkretnie, bez zbędnego żargonu. Tłumacz, co robisz i dlaczego.',
    'Masz narzędzia do sprawdzania i zmieniania serwera. Kiedy pytanie dotyczy tego serwera, najpierw sprawdź faktyczny stan narzędziami, zamiast zgadywać. Zmiany (run_command, write_file) mogą wymagać zatwierdzenia przez użytkownika – jeśli odmówi, zaproponuj inne rozwiązanie albo wyjaśnij, jak zrobić to ręcznie.',
    'Przed poważnymi zmianami (usuwanie danych, zmiana konfiguracji SSH lub zapory, restart usług, instalacja pakietów) krótko wyjaśnij skutki. Nie zmieniaj konfiguracji SSH ani zapory w sposób, który mógłby odciąć użytkownikowi dostęp do serwera. Nie zatrzymuj usługi webpulpit – to przez nią użytkownik z Tobą rozmawia.',
    'Formatuj odpowiedzi w Markdown: krótkie akapity, listy, bloki kodu dla poleceń i plików.'
  ].join('\n\n');
}

// ---------- chat over WebSocket ----------
function attachAssistant(server, cfg, files) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws/assistant') return;
    const origin = req.headers.origin;
    let sameOrigin = false;
    try { sameOrigin = !!origin && new URL(origin).host === req.headers.host; } catch { /* invalid */ }
    const tok = sameOrigin && auth.sessionFromRequest(cfg, req);
    if (!tok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, tok.s));
  });

  wss.on('connection', (ws, sid) => {
    const onRevoke = (revoked) => { if (revoked === sid) ws.close(1000, 'wylogowano'); };
    sessions.bus.on('revoke', onRevoke);
    let busy = false;
    let abort = null;
    const approvals = new Map(); // tool_use_id -> resolve(bool)
    const send = (msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t === 'approve') {
        const r = approvals.get(msg.id);
        if (r) { approvals.delete(msg.id); r(!!msg.ok); }
        return;
      }
      if (msg.t === 'stop') {
        if (abort) abort.abort();
        for (const r of approvals.values()) r(false);
        approvals.clear();
        return;
      }
      if (msg.t !== 'send') return;
      if (busy) return send({ t: 'error', message: 'Poczekaj, aż skończę odpowiadać (albo kliknij Zatrzymaj).' });
      const text = String(msg.text || '').trim();
      if (!text) return;

      const s = settings(cfg);
      if (!s.apiKey) return send({ t: 'error', code: 'no_key', message: 'Najpierw dodaj klucz API w ustawieniach asystenta.' });

      let conv = msg.conv ? loadConv(msg.conv) : null;
      if (!conv) {
        conv = { id: crypto.randomBytes(8).toString('hex'), title: text.slice(0, 60), created: Date.now(), updated: Date.now(), messages: [] };
        send({ t: 'conv', id: conv.id, title: conv.title });
      }
      conv.messages.push({ role: 'user', content: text });
      saveConv(conv);
      sessions.log(sid, 'assistant', `Pytanie do asystenta: ${text.slice(0, 300)}`);

      busy = true;
      abort = new AbortController();
      try {
        await runTurn({ conv, s, files, send, approvals, signal: abort.signal, sid });
      } catch (err) {
        send({ t: 'error', message: describeError(err) });
      } finally {
        saveConv(conv);
        busy = false;
        abort = null;
        send({ t: 'idle' });
      }
    });

    ws.on('close', () => {
      sessions.bus.off('revoke', onRevoke);
      if (abort) abort.abort();
      for (const r of approvals.values()) r(false);
    });
  });
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Klucz API jest nieprawidłowy albo został unieważniony. Sprawdź go w ustawieniach asystenta.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'Ten klucz API nie ma dostępu do wybranego modelu. Wybierz inny model w ustawieniach.';
  if (err instanceof Anthropic.RateLimitError) return 'Przekroczono limit zapytań do API. Spróbuj ponownie za chwilę.';
  if (err instanceof Anthropic.BadRequestError) {
    if (/credit balance/i.test(err.message)) return 'Brak środków na koncie API Anthropic. Doładuj je na platform.claude.com (Billing).';
    return 'Błąd zapytania: ' + err.message;
  }
  if (err instanceof Anthropic.APIConnectionError) return 'Nie można połączyć się z API Anthropic. Sprawdź połączenie serwera z internetem.';
  if (err instanceof Anthropic.APIError) return `Błąd API (${err.status}): ${err.message}`;
  if (err.name === 'AbortError' || err instanceof Anthropic.APIUserAbortError) return 'Zatrzymano.';
  return err.message || String(err);
}

const TOOL_LOG = {
  run_command: (i) => `Asystent wykonał polecenie: ${i.command}`,
  write_file: (i) => `Asystent zapisał plik ${i.path}`,
  read_file: (i) => `Asystent przeczytał plik ${i.path}`,
  list_directory: (i) => `Asystent przejrzał folder ${i.path}`,
  system_info: () => 'Asystent sprawdził stan serwera'
};

async function runTurn({ conv, s, files, send, approvals, signal, sid }) {
  const client = new Anthropic({ apiKey: s.apiKey });
  const model = MODELS[s.model];
  const useTools = s.mode !== 'chat';
  let jsonRetries = 0;

  for (let step = 0; step < 40; step++) {
    if (signal.aborted) return;
    const params = {
      model: s.model,
      max_tokens: 64000,
      system: systemPrompt(),
      cache_control: { type: 'ephemeral' },
      messages: conv.messages
    };
    if (useTools) params.tools = apiTools();
    if (model.thinking) params.thinking = { type: 'adaptive', display: 'summarized' };
    if (model.thinking && s.effort !== 'high') params.output_config = { effort: s.effort };
    if (model.fallbacks) {
      // A declined request is re-run server-side on Anthropic's recommended fallback model.
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }

    const stream = client.beta.messages.stream(params, { signal });
    stream.on('text', (delta) => send({ t: 'delta', text: delta }));
    stream.on('thinking', (delta) => send({ t: 'thinking', text: delta }));
    stream.on('streamEvent', (ev) => {
      if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
        send({ t: 'tool_start', id: ev.content_block.id, name: ev.content_block.name });
      }
    });

    let message;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      if (signal.aborted) return;
      // With eager input streaming an unparseable tool input rejects here; re-issue the turn.
      if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
      send({ t: 'notice', text: 'Ponawiam odpowiedź…' });
      continue;
    }

    if (message.stop_reason === 'refusal') {
      send({ t: 'notice', text: 'Claude odmówił odpowiedzi na to pytanie. Spróbuj je sformułować inaczej.' });
      return;
    }
    if (message.stop_reason === 'pause_turn') {
      conv.messages.push({ role: 'assistant', content: message.content });
      continue;
    }

    const toolUses = message.content.filter((b) => b.type === 'tool_use');
    if (message.stop_reason === 'max_tokens' && toolUses.length) {
      send({ t: 'notice', text: 'Odpowiedź była zbyt długa i została ucięta.' });
      return;
    }
    conv.messages.push({ role: 'assistant', content: message.content });
    send({ t: 'message_done' });
    if (message.stop_reason !== 'tool_use' || !toolUses.length) return;

    const results = [];
    for (const tu of toolUses) {
      const tool = TOOL_BY_NAME[tu.name];
      if (!tool || !validateInput(tool, tu.input)) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ INVALID_JSON: JSON.stringify(tu.input) }) });
        continue;
      }
      if (signal.aborted) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: 'Użytkownik zatrzymał działanie.' });
        continue;
      }
      const needsApproval = tool.mutating && s.mode === 'ask';
      send({ t: 'tool', id: tu.id, name: tu.name, input: tu.input, needsApproval });
      if (needsApproval) {
        const ok = await new Promise((resolve) => approvals.set(tu.id, resolve));
        if (!ok) {
          send({ t: 'tool_result', id: tu.id, output: 'Odrzucono', isError: true, denied: true });
          results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: 'Użytkownik nie zgodził się na wykonanie tej operacji.' });
          continue;
        }
      }
      if (tool.mutating || tu.name === 'read_file') sessions.log(sid, 'assistant', TOOL_LOG[tu.name](tu.input).slice(0, 500));
      const r = await executeTool(tu.name, tu.input, files, signal);
      send({ t: 'tool_result', id: tu.id, output: r.output, isError: r.isError });
      results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: r.isError || undefined, content: r.output });
    }
    // Every tool_use must be answered in the next user turn - even after a stop -
    // so the saved history stays valid for the next question.
    conv.messages.push({ role: 'user', content: results });
    saveConv(conv);
    if (signal.aborted) return;
  }
  send({ t: 'notice', text: 'Osiągnięto limit kroków w jednej odpowiedzi.' });
}

module.exports = { attachAssistant, publicSettings, saveSettings, listConvs, loadConv, deleteConv };
