'use strict';
/* "Asystent Claude": chat with Claude about (and on) this server. */
(function (WD) {
  const { h, api } = WD;

  // ---------- tiny, safe Markdown renderer ----------
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = esc(s)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
  }
  WD.markdown = function (text) {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0;
    let para = [];
    const flush = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
      if (fence) {
        flush();
        const lang = fence[1].toLowerCase();
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
        i++;
        out.push(`<div class="as-code" data-lang="${esc(lang)}"><div class="as-codebar"><span>${esc(lang || 'kod')}</span></div><pre><code>${esc(body.join('\n'))}</code></pre></div>`);
        continue;
      }
      const hd = line.match(/^(#{1,4})\s+(.*)$/);
      if (hd) { flush(); out.push(`<h${hd[1].length + 2}>${inline(hd[2])}</h${hd[1].length + 2}>`); i++; continue; }
      if (/^\s*(---|\*\*\*)\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush();
        const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push(`<div class="as-tablewrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (li) {
        flush();
        const ordered = /\d/.test(li[2]);
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (m && /\d/.test(m[2]) === ordered) { items.push(inline(m[3])); i++; }
          else if (m) { items.push(inline(m[3])); i++; }
          else if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += '<br>' + inline(lines[i].trim()); i++; }
          else break;
        }
        out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${x}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        flush();
        const q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`);
        continue;
      }
      if (!line.trim()) { flush(); i++; continue; }
      para.push(line);
      i++;
    }
    flush();
    return out.join('');
  };

  // Adds "copy" / "run in terminal" buttons to rendered code blocks.
  function enhanceCode(root) {
    for (const block of root.querySelectorAll('.as-code:not(.done)')) {
      block.classList.add('done');
      const code = block.querySelector('code').textContent;
      const bar = block.querySelector('.as-codebar');
      const copy = h('button', { class: 'as-mini', onclick: () => {
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(code).then(() => WD.toast('Skopiowano'));
        else WD.prompt('Kopiuj', '', code);
      } }, 'Kopiuj');
      bar.append(copy);
      if (['bash', 'sh', 'shell', 'console', 'zsh'].includes(block.dataset.lang) && code.trim() && !code.includes('\n\n')) {
        bar.append(h('button', { class: 'as-mini', title: 'Otwiera terminal i wykonuje to polecenie', onclick: async () => {
          const ok = await WD.confirm('Uruchomić w terminalu?', h('pre', { class: 'as-confirm-code' }, code), { okLabel: 'Uruchom' });
          if (ok) WD.apps.terminal.launch({ command: code.replace(/^\$\s+/gm, '') });
        } }, 'Uruchom w terminalu'));
      }
    }
  }

  const TOOL_LABELS = {
    run_command: (i) => ['Polecenie', i.command || ''],
    read_file: (i) => ['Czytam plik', i.path || ''],
    list_directory: (i) => ['Przeglądam folder', i.path || ''],
    write_file: (i) => ['Zapis pliku', i.path || ''],
    system_info: () => ['Sprawdzam stan serwera', '']
  };

  const SUGGESTIONS = [
    'Ile mam wolnego miejsca na dysku i co zajmuje najwięcej?',
    'Co teraz najbardziej obciąża serwer?',
    'Sprawdź, czy serwer jest dobrze zabezpieczony (SSH, zapora, aktualizacje)',
    'Pomóż mi postawić prostą stronę WWW na nginx'
  ];

  function launch() {
    const existing = WD.wm.find((w) => w.app === 'assistant');
    if (existing) return existing.focus();

    let settings = null;
    let convId = null;
    let ws = null;
    let busy = false;
    let live = null; // { el, text, textEl, thinkEl, tools: Map }
    let closed = false;

    const list = h('div', { class: 'as-list' });
    const side = h('div', { class: 'as-side' },
      h('button', { class: 'btn primary as-new', onclick: () => openConv(null) }, '+ Nowa rozmowa'),
      list,
      h('button', { class: 'tbtn as-settings-btn', onclick: () => openSettings() }, h('span', { html: WD.glyph('info'), style: { display: 'inline-flex' } }), 'Ustawienia asystenta'));
    const feed = h('div', { class: 'as-feed' });
    const input = h('textarea', { class: 'as-input', rows: '1', placeholder: 'Napisz wiadomość… (Enter – wyślij, Shift+Enter – nowa linia)' });
    const sendBtn = h('button', { class: 'btn primary as-send', onclick: () => (busy ? stop() : sendMessage()) }, 'Wyślij');
    const modeChip = h('button', { class: 'as-chip', onclick: () => openSettings() });
    const composer = h('div', { class: 'as-composer' }, h('div', { class: 'as-inputrow' }, input, sendBtn), h('div', { class: 'as-meta' }, h('button', { class: 'as-chip as-mobile-only', onclick: () => openConv(null) }, '+ Nowa rozmowa'), modeChip, h('span', { class: 'as-hint' }, 'Claude może się mylić – sprawdzaj ważne zmiany.')));
    const main = h('div', { class: 'as-main' }, feed, composer);
    const root = h('div', { class: 'as' }, side, main);

    const win = WD.wm.open({
      app: 'assistant', title: 'Asystent Claude', icon: WD.appIcon('assistant'), width: 980, height: 680,
      onFocus: () => input.focus(),
      onClose: () => { closed = true; if (ws) ws.close(); }
    });
    win.body.append(root);

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) sendMessage(); }
    });
    input.addEventListener('input', autosize);
    function autosize() {
      input.style.height = 'auto';
      input.style.height = Math.min(200, input.scrollHeight) + 'px';
    }

    const MODE_LABELS = { ask: 'Pyta przed zmianami na serwerze', auto: 'Wykonuje zmiany bez pytania', chat: 'Tylko rozmowa (bez dostępu do serwera)' };
    function updateChip() {
      if (!settings) return;
      const model = (settings.models.find((m) => m.id === settings.model) || {}).label || settings.model;
      modeChip.textContent = `${model} · ${MODE_LABELS[settings.mode]}`;
      modeChip.classList.toggle('warn', settings.mode === 'auto');
    }

    // ---------- conversations ----------
    async function refreshList() {
      let convs = [];
      try { convs = await api.get('/api/assistant/convs'); } catch { /* ignore */ }
      list.replaceChildren(...convs.map((c) => h('div', { class: 'as-item' + (c.id === convId ? ' on' : ''), title: c.title, onclick: () => openConv(c.id) },
        h('span', { class: 'as-ititle' }, c.title || 'Rozmowa'),
        h('span', { class: 'as-idate' }, new Date(c.updated).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' })),
        h('button', { class: 'as-del', title: 'Usuń rozmowę', html: WD.glyph('trash'), onclick: async (e) => {
          e.stopPropagation();
          if (!(await WD.confirm('Usuń rozmowę', `Usunąć rozmowę „${c.title}”?`, { okLabel: 'Usuń', danger: true }))) return;
          await api.post('/api/assistant/conv/delete', { id: c.id });
          if (c.id === convId) openConv(null); else refreshList();
        } }))));
      if (!convs.length) list.append(h('div', { class: 'as-empty' }, 'Brak zapisanych rozmów'));
    }

    async function openConv(id) {
      if (busy) return WD.toast('Poczekaj, aż Claude skończy odpowiadać', 'error');
      convId = id;
      live = null;
      feed.textContent = '';
      if (!id) { renderWelcome(); refreshList(); input.focus(); return; }
      try {
        const conv = await api.get('/api/assistant/conv', { id });
        renderHistory(conv.messages);
      } catch (err) { WD.error(err); renderWelcome(); }
      refreshList();
      input.focus();
    }

    function renderWelcome() {
      feed.textContent = '';
      if (settings && !settings.hasKey) return renderSetup();
      const cc = h('div', { class: 'as-card' },
        h('strong', {}, 'Masz subskrypcję Claude Pro lub Max?'),
        h('p', {}, 'Możesz też używać Claude Code bezpośrednio w terminalu serwera – logujesz się swoim kontem Claude, bez klucza API.'),
        h('button', { class: 'btn', onclick: () => launchClaudeCode() }, 'Otwórz Claude Code w terminalu'));
      feed.append(h('div', { class: 'as-welcome' },
        h('div', { class: 'as-logo', html: WD.appIcon('assistant') }),
        h('h2', {}, 'W czym mogę pomóc?'),
        h('p', { class: 'as-sub' }, 'Zapytaj o cokolwiek. Mogę sprawdzić stan serwera, przejrzeć pliki i logi, a za Twoją zgodą wykonać polecenia.'),
        h('div', { class: 'as-sugg' }, ...SUGGESTIONS.map((s) => h('button', { class: 'as-suggbtn', onclick: () => { input.value = s; sendMessage(); } }, s))),
        cc));
    }

    function renderSetup() {
      const key = h('input', { class: 'field', type: 'password', placeholder: 'sk-ant-…', autocomplete: 'off', spellcheck: 'false' });
      const save = h('button', { class: 'btn primary' }, 'Zapisz klucz');
      save.addEventListener('click', async () => {
        try {
          settings = await api.post('/api/assistant/settings', { apiKey: key.value });
          updateChip();
          WD.toast('Zapisano klucz API', 'ok');
          renderWelcome();
        } catch (err) { WD.error(err); }
      });
      key.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
      feed.append(h('div', { class: 'as-welcome' },
        h('div', { class: 'as-logo', html: WD.appIcon('assistant') }),
        h('h2', {}, 'Połącz asystenta z Claude'),
        h('div', { class: 'as-card as-setup' },
          h('p', {}, 'Asystent korzysta z API Anthropic. Potrzebny jest klucz API (płatny osobno od subskrypcji Claude, rozliczany za użycie):'),
          h('ol', {},
            h('li', {}, 'Wejdź na ', h('a', { href: 'https://platform.claude.com/settings/keys', target: '_blank', rel: 'noopener noreferrer' }, 'platform.claude.com → API Keys'), ' i zaloguj się.'),
            h('li', {}, 'Doładuj konto w zakładce Billing (np. kilka dolarów wystarczy na długo).'),
            h('li', {}, 'Kliknij „Create Key”, skopiuj klucz i wklej go poniżej.')),
          h('div', { class: 'as-keyrow' }, key, save),
          h('p', { class: 'as-hint' }, 'Klucz jest zapisywany tylko na Twoim serwerze (w config.json) i nie jest nigdzie wysyłany poza API Anthropic.')),
        h('div', { class: 'as-card' },
          h('strong', {}, 'Nie chcesz klucza API?'),
          h('p', {}, 'Z subskrypcją Claude Pro/Max możesz używać Claude Code w terminalu serwera.'),
          h('button', { class: 'btn', onclick: () => launchClaudeCode() }, 'Otwórz Claude Code w terminalu'))));
      setTimeout(() => key.focus(), 50);
    }

    async function launchClaudeCode() {
      let st = { installed: false };
      try { st = await api.get('/api/assistant/claude-code'); } catch { /* assume not installed */ }
      if (st.installed) return WD.apps.terminal.launch({ command: 'claude' });
      const ok = await WD.confirm('Claude Code', 'Claude Code nie jest jeszcze zainstalowany na serwerze. Zainstalować go teraz (npm install -g @anthropic-ai/claude-code) i uruchomić? Po starcie zaloguj się swoim kontem Claude – terminal pokaże link.', { okLabel: 'Zainstaluj i uruchom' });
      if (ok) WD.apps.terminal.launch({ command: 'npm install -g @anthropic-ai/claude-code && claude' });
    }

    // ---------- rendering messages ----------
    function userBubble(text) {
      return h('div', { class: 'as-msg user' }, h('div', { class: 'as-bubble' }, text));
    }

    function assistantShell() {
      const body = h('div', { class: 'as-body' });
      const el = h('div', { class: 'as-msg bot' }, h('div', { class: 'as-avatar', html: WD.appIcon('assistant') }), body);
      return { el, body };
    }

    function textBlock(text) {
      const d = h('div', { class: 'as-md', html: WD.markdown(text) });
      enhanceCode(d);
      return d;
    }

    function thinkingBlock(text) {
      return h('details', { class: 'as-think' }, h('summary', {}, 'Przemyślenia'), h('div', { class: 'as-thinktext' }, text));
    }

    function toolCard(id, name, inputObj) {
      const [label, detail] = (TOOL_LABELS[name] || (() => [name, '']))(inputObj || {});
      const status = h('span', { class: 'as-tstatus' }, '');
      const out = h('pre', { class: 'as-tout' });
      const outWrap = h('details', { class: 'as-toutwrap', hidden: true }, h('summary', {}, 'Wynik'), out);
      const actions = h('div', { class: 'as-tactions', hidden: true });
      const detailEl = h('code', { class: 'as-tdetail' }, detail);
      const contentBox = (text) => h('details', { class: 'as-toutwrap as-wcontent' }, h('summary', {}, `Treść (${text.split('\n').length} linii)`), h('pre', { class: 'as-tout' }, text));
      const extra = name === 'write_file' && inputObj && inputObj.content != null ? contentBox(inputObj.content) : null;
      const el = h('div', { class: 'as-tool', 'data-id': id },
        h('div', { class: 'as-thead' }, h('span', { class: 'as-tico', html: WD.glyph(name === 'run_command' ? 'terminal' : name === 'write_file' ? 'save' : name === 'system_info' ? 'info' : 'open') }),
          h('span', { class: 'as-tlabel' }, label), status),
        detail ? detailEl : null, extra, actions, outWrap);
      const card = {
        el, status, out, outWrap, actions,
        setInput(inp) {
          const [, d] = (TOOL_LABELS[name] || (() => [name, '']))(inp || {});
          detailEl.textContent = d;
          if (d && !detailEl.parentNode) el.insertBefore(detailEl, actions);
          if (name === 'write_file' && inp && inp.content != null && !el.querySelector('.as-wcontent')) {
            el.insertBefore(contentBox(inp.content), actions);
          }
        },
        setResult(output, isError, denied) {
          status.textContent = denied ? 'odrzucono' : isError ? 'błąd' : 'gotowe';
          status.className = 'as-tstatus ' + (denied ? 'denied' : isError ? 'err' : 'ok');
          actions.hidden = true;
          if (!denied) { out.textContent = output; outWrap.hidden = false; if (isError) outWrap.open = true; }
        }
      };
      return card;
    }

    function renderHistory(messages) {
      feed.textContent = '';
      const cards = new Map();
      for (const m of messages) {
        if (m.role === 'user') {
          if (typeof m.content === 'string') { feed.append(userBubble(m.content)); continue; }
          for (const b of m.content) {
            if (b.type === 'tool_result' && cards.has(b.tool_use_id)) {
              const text = typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x.text || '').join('\n');
              cards.get(b.tool_use_id).setResult(text, !!b.is_error, /nie zgodził się/.test(text));
            } else if (b.type === 'text') feed.append(userBubble(b.text));
          }
          continue;
        }
        const shell = assistantShell();
        for (const b of m.content || []) {
          if (b.type === 'text' && b.text.trim()) shell.body.append(textBlock(b.text));
          else if (b.type === 'thinking' && b.thinking && b.thinking.trim()) shell.body.append(thinkingBlock(b.thinking));
          else if (b.type === 'tool_use') {
            const c = toolCard(b.id, b.name, b.input);
            c.status.textContent = '…';
            cards.set(b.id, c);
            shell.body.append(c.el);
          }
        }
        if (shell.body.childElementCount) {
          // Merge consecutive assistant turns (tool loop) into one visual message.
          const last = feed.lastElementChild;
          if (last && last.classList.contains('bot')) last.querySelector('.as-body').append(...shell.body.childNodes);
          else feed.append(shell.el);
        }
      }
      scrollDown(true);
    }

    function scrollDown(force) {
      const near = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 160;
      if (force || near) feed.scrollTop = feed.scrollHeight;
    }

    // ---------- live streaming ----------
    function ensureLive() {
      if (live) return live;
      const last = feed.lastElementChild;
      let body;
      if (last && last.classList.contains('bot')) body = last.querySelector('.as-body');
      else { const shell = assistantShell(); feed.append(shell.el); body = shell.body; }
      live = { body, textEl: null, text: '', thinkEl: null, tools: new Map(), typing: null };
      return live;
    }
    let renderPending = false;
    function renderLiveText() {
      if (renderPending) return;
      renderPending = true;
      requestAnimationFrame(() => {
        renderPending = false;
        if (live && live.textEl) { live.textEl.innerHTML = WD.markdown(live.text); scrollDown(); }
      });
    }
    function showTyping(on) {
      const l = ensureLive();
      if (on && !l.typing) { l.typing = h('div', { class: 'as-typing' }, h('i'), h('i'), h('i')); l.body.append(l.typing); }
      if (!on && l.typing) { l.typing.remove(); l.typing = null; }
    }

    function onServer(msg) {
      if (msg.t === 'conv') { convId = msg.id; refreshList(); return; }
      if (msg.t === 'delta') {
        const l = ensureLive();
        showTyping(false);
        l.thinkEl = null;
        if (!l.textEl) { l.textEl = h('div', { class: 'as-md' }); l.text = ''; l.body.append(l.textEl); }
        l.text += msg.text;
        renderLiveText();
        return;
      }
      if (msg.t === 'thinking') {
        const l = ensureLive();
        showTyping(false);
        if (!l.thinkEl) {
          const det = thinkingBlock('');
          det.querySelector('summary').textContent = 'Myślę…';
          l.thinkEl = det;
          l.body.append(det);
          l.textEl = null;
        }
        l.thinkEl.querySelector('.as-thinktext').textContent += msg.text;
        return;
      }
      if (msg.t === 'tool_start') {
        const l = ensureLive();
        showTyping(false);
        if (l.textEl) { l.textEl.innerHTML = WD.markdown(l.text); enhanceCode(l.textEl); }
        l.textEl = null; l.thinkEl = null;
        const c = toolCard(msg.id, msg.name, {});
        c.status.textContent = 'przygotowuję…';
        l.tools.set(msg.id, c);
        l.body.append(c.el);
        scrollDown();
        return;
      }
      if (msg.t === 'tool') {
        const l = ensureLive();
        let c = l.tools.get(msg.id);
        if (!c) { c = toolCard(msg.id, msg.name, msg.input); l.tools.set(msg.id, c); l.body.append(c.el); }
        else c.setInput(msg.input);
        if (msg.needsApproval) {
          c.status.textContent = 'czeka na Twoją zgodę';
          c.status.className = 'as-tstatus wait';
          c.actions.hidden = false;
          c.actions.replaceChildren(
            h('span', { class: 'as-ask' }, msg.name === 'write_file' ? 'Claude chce zapisać ten plik.' : 'Claude chce wykonać to polecenie.'),
            h('button', { class: 'btn primary', onclick: () => approve(msg.id, true, c) }, 'Zezwól'),
            h('button', { class: 'btn', onclick: () => approve(msg.id, false, c) }, 'Odrzuć'));
          WD.toast('Claude czeka na Twoją zgodę', '', 3000);
        } else {
          c.status.textContent = 'wykonuję…';
        }
        scrollDown(true);
        return;
      }
      if (msg.t === 'tool_result') {
        const l = ensureLive();
        const c = l.tools.get(msg.id);
        if (c) c.setResult(msg.output, msg.isError, msg.denied);
        showTyping(true);
        scrollDown();
        return;
      }
      if (msg.t === 'message_done') {
        if (live && live.textEl) { live.textEl.innerHTML = WD.markdown(live.text); enhanceCode(live.textEl); }
        if (live) { live.textEl = null; live.thinkEl = null; }
        return;
      }
      if (msg.t === 'notice') { ensureLive().body.append(h('div', { class: 'as-notice' }, msg.text)); return; }
      if (msg.t === 'error') {
        if (live) showTyping(false);
        feed.append(h('div', { class: 'as-error' }, msg.message));
        if (msg.code === 'no_key') loadSettings().then(() => renderWelcome());
        scrollDown(true);
        return;
      }
      if (msg.t === 'idle') {
        setBusy(false);
        if (live) {
          showTyping(false);
          if (live.textEl) { live.textEl.innerHTML = WD.markdown(live.text); enhanceCode(live.textEl); }
        }
        live = null;
        refreshList();
      }
    }

    function approve(id, ok, card) {
      card.actions.hidden = true;
      card.status.textContent = ok ? 'wykonuję…' : 'odrzucono';
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'approve', id, ok }));
    }

    function connect() {
      return new Promise((resolve, reject) => {
        if (ws && ws.readyState === WebSocket.OPEN) return resolve(ws);
        ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/assistant`);
        ws.onopen = () => resolve(ws);
        ws.onerror = () => reject(new Error('Nie można połączyć się z asystentem'));
        ws.onmessage = (e) => { try { onServer(JSON.parse(e.data)); } catch (err) { console.error(err); } };
        ws.onclose = () => {
          if (busy && !closed) {
            feed.append(h('div', { class: 'as-error' }, 'Połączenie przerwane. Odpowiedź mogła nie zostać dokończona.'));
            setBusy(false);
            live = null;
          }
        };
      });
    }

    function setBusy(b) {
      busy = b;
      sendBtn.textContent = b ? 'Zatrzymaj' : 'Wyślij';
      sendBtn.classList.toggle('danger', b);
      sendBtn.classList.toggle('primary', !b);
    }

    async function sendMessage() {
      const text = input.value.trim();
      if (!text || busy) return;
      if (settings && !settings.hasKey) { WD.toast('Najpierw dodaj klucz API', 'error'); return; }
      const welcome = feed.querySelector('.as-welcome');
      if (welcome) welcome.remove();
      try { await connect(); } catch (err) { return WD.error(err); }
      input.value = '';
      autosize();
      feed.append(userBubble(text));
      live = null;
      showTyping(true);
      scrollDown(true);
      setBusy(true);
      ws.send(JSON.stringify({ t: 'send', conv: convId, text }));
    }

    function stop() {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'stop' }));
    }

    // ---------- settings ----------
    async function loadSettings() {
      try { settings = await api.get('/api/assistant/settings'); } catch (err) { WD.error(err); }
      updateChip();
    }

    async function openSettings() {
      await loadSettings();
      if (!settings) return;
      const key = h('input', { class: 'field', type: 'password', placeholder: settings.hasKey ? `zapisany: ${settings.keyHint} (zostaw puste, aby nie zmieniać)` : 'sk-ant-…', autocomplete: 'off' });
      const model = h('select', { class: 'field' }, ...settings.models.map((m) => h('option', { value: m.id, selected: m.id === settings.model }, m.label + (m.id === 'claude-opus-5' ? ' (zalecany)' : ''))));
      const effort = h('select', { class: 'field' }, ...[['low', 'Niski – szybciej i taniej'], ['medium', 'Średni'], ['high', 'Wysoki (domyślny)'], ['xhigh', 'Bardzo wysoki'], ['max', 'Maksymalny – najdokładniej']].map(([v, l]) => h('option', { value: v, selected: v === settings.effort }, l)));
      const modes = [['ask', 'Pytaj przed każdą zmianą (zalecane)', 'Czytanie plików i stanu serwera bez pytania; polecenia i zapis plików po Twojej zgodzie.'],
        ['auto', 'Wykonuj bez pytania', 'Claude sam uruchamia polecenia jako ' + (WD.info.systemUser || 'root') + '. Szybciej, ale ryzykowniej.'],
        ['chat', 'Tylko rozmowa', 'Bez dostępu do serwera – jak zwykły czat.']];
      const radios = modes.map(([v, l, d]) => h('label', { class: 'tm-radio as-mode' }, h('input', { type: 'radio', name: 'as-mode', value: v, checked: v === settings.mode }), h('span', {}, h('strong', {}, l), h('br'), h('span', { class: 'tm-dim' }, d))));
      const remove = settings.hasKey ? h('button', { class: 'btn', onclick: async () => {
        if (!(await WD.confirm('Usuń klucz', 'Usunąć zapisany klucz API z serwera?', { okLabel: 'Usuń', danger: true }))) return;
        settings = await api.post('/api/assistant/settings', { apiKey: '' });
        updateChip();
        // Close the settings dialog through its own "Anuluj" button.
        const cancel = document.querySelector('.modal-backdrop .d-actions .btn:last-child');
        if (cancel) cancel.click();
        renderWelcome();
      } }, 'Usuń klucz') : null;
      const v = await WD.dialog({
        title: 'Ustawienia asystenta',
        body: h('div', {},
          h('label', {}, 'Klucz API Anthropic'), key,
          h('label', {}, 'Model'), model,
          h('label', {}, 'Staranność (dłuższe myślenie = dokładniej, ale wolniej i drożej)'), effort,
          h('label', {}, 'Dostęp do serwera'), ...radios,
          remove ? h('div', { style: { marginTop: '12px' } }, remove) : null),
        buttons: [{ label: 'Zapisz', value: 'save', kind: 'primary' }, { label: 'Anuluj', value: null }]
      });
      if (v !== 'save') return;
      const body = { model: model.value, effort: effort.value, mode: (radios.map((r) => r.querySelector('input')).find((r) => r.checked) || {}).value };
      if (key.value.trim()) body.apiKey = key.value.trim();
      try {
        settings = await api.post('/api/assistant/settings', body);
        updateChip();
        WD.toast('Zapisano ustawienia', 'ok');
        if (!convId) renderWelcome();
      } catch (err) { WD.error(err); }
    }

    (async () => {
      await loadSettings();
      openConv(null);
    })();
    return win;
  }

  WD.apps = WD.apps || {};
  WD.apps.assistant = { name: 'Asystent Claude', icon: 'assistant', launch };
})(window.WD);
