'use strict';
/* Task Manager ("Menedżer zadań") modelled on the Windows one:
   Processes, Performance, Users, Details, Services and Startup. */
(function (WD) {
  const { h, api, fmt } = WD;
  const HISTORY = 60;
  const COLORS = { cpu: '#1a8fd6', mem: '#9b3cc4', disk: '#4da60c', net: '#c2710c' };
  const STATES = { R: 'Uruchomiony', S: 'Uśpiony', D: 'Czeka na dysk', Z: 'Zombie', T: 'Wstrzymany', t: 'Śledzony', I: 'Bezczynny', X: 'Zakończony' };
  const PRIORITIES = [
    { nice: -15, label: 'Wysoki' },
    { nice: -5, label: 'Powyżej normalnego' },
    { nice: 0, label: 'Normalny' },
    { nice: 5, label: 'Poniżej normalnego' },
    { nice: 12, label: 'Niski' },
    { nice: 19, label: 'Najniższy' }
  ];
  const SPEEDS = [[500, 'Wysoka (0,5 s)'], [1000, 'Normalna (1 s)'], [3000, 'Niska (3 s)'], [0, 'Wstrzymana']];

  const pct = (v, d = 0) => (v || 0).toLocaleString('pl-PL', { minimumFractionDigits: d, maximumFractionDigits: d }) + '%';
  const dec = (v, d = 1) => (v || 0).toLocaleString('pl-PL', { minimumFractionDigits: d, maximumFractionDigits: d });
  const rate = (b) => (b == null ? '—' : fmt.size(b) + '/s');
  function bits(bytesPerSec) {
    let v = (bytesPerSec || 0) * 8;
    const u = ['b/s', 'Kb/s', 'Mb/s', 'Gb/s'];
    let i = 0;
    while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
    return (i === 0 ? Math.round(v) : dec(v, v < 10 ? 1 : 0)) + ' ' + u[i];
  }
  const priorityLabel = (nice) => PRIORITIES.reduce((best, p) => (Math.abs(p.nice - nice) < Math.abs(best.nice - nice) ? p : best)).label;
  const duration = (sec) => {
    sec = Math.floor(sec);
    const d = Math.floor(sec / 86400);
    const hms = [Math.floor(sec % 86400 / 3600), Math.floor(sec % 3600 / 60), sec % 60].map((x) => String(x).padStart(2, '0')).join(':');
    return (d ? d + ':' : '') + hms;
  };
  const heat = (v) => (v > 0.002 ? `rgba(255, 190, 0, ${Math.min(0.62, 0.1 + v * 0.55)})` : '');

  // ---------- canvas graphs ----------
  function drawGraph(canvas, series, max, opts = {}) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const hh = canvas.clientHeight;
    if (!w || !hh) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hh * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    const color = series[0] ? series[0].color : '#888';
    if (opts.grid !== false) {
      ctx.strokeStyle = color + '33';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const cols = 10, rows = opts.small ? 2 : 10;
      for (let i = 1; i < cols; i++) { const x = Math.round((w / cols) * i) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, hh); }
      for (let i = 1; i < rows; i++) { const y = Math.round((hh / rows) * i) + 0.5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
      ctx.stroke();
    }
    for (const s of series) {
      const data = s.data;
      if (!data.length) continue;
      const step = w / (HISTORY - 1);
      const x0 = w - (data.length - 1) * step;
      const y = (v) => hh - Math.min(1, (v || 0) / (max || 1)) * (hh - 1) - 0.5;
      ctx.beginPath();
      data.forEach((v, i) => { if (i === 0) ctx.moveTo(x0, y(v)); else ctx.lineTo(x0 + i * step, y(v)); });
      if (s.fill !== false) {
        ctx.save();
        ctx.lineTo(x0 + (data.length - 1) * step, hh);
        ctx.lineTo(x0, hh);
        ctx.closePath();
        ctx.fillStyle = s.color + (s.fillAlpha || '2e');
        ctx.fill();
        ctx.restore();
        ctx.beginPath();
        data.forEach((v, i) => { if (i === 0) ctx.moveTo(x0, y(v)); else ctx.lineTo(x0 + i * step, y(v)); });
      }
      ctx.setLineDash(s.dashed ? [4, 3] : []);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = opts.small ? 1 : 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = color + '99';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, hh - 1);
  }

  // Rounds a byte-rate maximum up to a "nice" scale value for autoscaled graphs.
  function niceMax(values, min) {
    const m = Math.max(min, ...values);
    const p = Math.pow(10, Math.floor(Math.log10(m)));
    for (const k of [1, 2, 5, 10]) if (m <= k * p) return k * p;
    return 10 * p;
  }

  // ---------- generic sortable table ----------
  function table(cols, { sort, onSort }) {
    const thead = h('thead');
    const tbody = h('tbody');
    const el = h('table', { class: 'tm-table' }, thead, tbody);
    function header(totals) {
      thead.replaceChildren(h('tr', {}, ...cols.map((c) => {
        const arrow = sort.key === c.key ? (sort.dir > 0 ? '▲' : '▼') : '';
        return h('th', {
          class: (c.num ? 'num ' : '') + (c.cls || ''),
          style: c.width ? { width: c.width } : null,
          title: c.title || '',
          onclick: () => {
            if (c.sortable === false) return;
            sort.dir = sort.key === c.key ? -sort.dir : (c.num ? -1 : 1);
            sort.key = c.key;
            onSort();
          }
        },
        totals && totals[c.key] != null ? h('div', { class: 'tm-total' }, totals[c.key]) : null,
        h('div', { class: 'tm-label' }, c.label, arrow ? h('span', { class: 'tm-arrow' }, arrow) : null));
      })));
    }
    return { el, tbody, header };
  }

  function sorter(sort, cols) {
    const col = cols.find((c) => c.key === sort.key) || cols[0];
    const get = col.sortValue || ((r) => r[col.key]);
    const coll = new Intl.Collator('pl', { numeric: true, sensitivity: 'base' });
    return (a, b) => {
      const va = get(a), vb = get(b);
      const r = typeof va === 'string' || typeof vb === 'string' ? coll.compare(String(va ?? ''), String(vb ?? '')) : (va ?? -1) - (vb ?? -1);
      return r * sort.dir;
    };
  }

  // =====================================================================
  function launch(opts = {}) {
    const existing = WD.wm.find((w) => w.app === 'monitor');
    if (existing) { existing.focus(); if (opts.page) existing.tm.show(opts.page); return existing; }

    const state = {
      page: opts.page || WD.settings.get('tm.page', 'procs'),
      speed: WD.settings.get('tm.speed', 1000),
      kthreads: WD.settings.get('tm.kthreads', false),
      perf: null,
      procs: [],
      selfPid: 0,
      sessions: [],
      services: null,
      servicesError: '',
      serviceFilter: 'all',
      selected: null,           // { kind: 'pid'|'group'|'service'|'user', id }
      expanded: new Set(),
      perfItem: 'cpu',
      coresView: WD.settings.get('tm.cores', false),
      hist: { cpu: [], mem: [], cores: [], disk: {}, net: {} },
      sorts: {
        procs: { key: 'cpu', dir: -1 },
        details: { key: 'cpu', dir: -1 },
        users: { key: 'cpu', dir: -1 },
        services: { key: 'name', dir: 1 }
      }
    };
    let timer = null;
    let busy = { perf: false, procs: false };
    let closed = false;

    // ---------- layout ----------
    const NAV = [
      ['procs', 'Procesy', '<path d="M4 5h16v14H4z"/><path d="M4 9h16M8 13h8M8 16h5"/>'],
      ['perf', 'Wydajność', '<path d="M3 17l5-6 4 3 5-7 4 4"/><path d="M3 21h18"/>'],
      ['users', 'Użytkownicy', '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.3-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 14c2.6 0 4.5 1.6 5 4.5"/>'],
      ['details', 'Szczegóły', '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'],
      ['services', 'Usługi', '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>'],
      ['startup', 'Autostart', '<path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>']
    ];
    const navEl = h('nav', { class: 'tm-nav' });
    const navBtns = {};
    for (const [id, label, icon] of NAV) {
      navBtns[id] = h('button', { class: 'tm-navbtn', title: label, onclick: () => show(id) },
        h('span', { html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>` }),
        h('span', { class: 'tm-navlabel' }, label));
      navEl.append(navBtns[id]);
    }
    const settingsBtn = h('button', { class: 'tm-navbtn tm-navbottom', title: 'Opcje', onclick: (e) => optionsMenu(e) },
      h('span', { html: WD.glyph('info') }), h('span', { class: 'tm-navlabel' }, 'Opcje'));
    navEl.append(settingsBtn);

    const titleEl = h('h2', { class: 'tm-title' });
    const search = h('input', { class: 'field tm-search', type: 'search', placeholder: 'Wpisz nazwę, użytkownika lub PID…' });
    search.addEventListener('input', () => render());
    const actions = h('div', { class: 'tm-actions' });
    const pageEl = h('div', { class: 'tm-page', tabindex: '0' });
    const statusEl = h('div', { class: 'tm-status' });
    const root = h('div', { class: 'tm' }, navEl,
      h('div', { class: 'tm-main' }, h('div', { class: 'tm-head' }, titleEl, search, actions), pageEl, statusEl));

    const win = WD.wm.open({
      app: 'monitor',
      title: 'Menedżer zadań',
      icon: WD.appIcon('monitor'),
      width: 1040,
      height: 680,
      onResize: () => drawAll(),
      onClose: () => { closed = true; clearTimeout(timer); }
    });
    win.body.append(root);
    win.tm = { show };

    pageEl.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' && selectedPids().length) { e.preventDefault(); endTask(selectedPids(), 'SIGTERM'); }
    });

    function optionsMenu(e) {
      const r = e.currentTarget.getBoundingClientRect();
      WD.contextMenu(r.right + 4, r.top - 180, [
        ...SPEEDS.map(([ms, label]) => ({
          label: (state.speed === ms ? '● ' : '    ') + 'Szybkość aktualizacji: ' + label,
          action: () => { state.speed = ms; WD.settings.set('tm.speed', ms); schedule(0); }
        })),
        '-',
        { label: (state.kthreads ? '☑ ' : '☐ ') + 'Pokaż wątki jądra', action: () => { state.kthreads = !state.kthreads; WD.settings.set('tm.kthreads', state.kthreads); render(); } },
        { label: 'Odśwież teraz', icon: 'refresh', action: () => { if (isServicePage()) loadServices(); schedule(0); } }
      ]);
    }

    const isServicePage = () => state.page === 'services' || state.page === 'startup';

    function show(page) {
      state.page = page;
      WD.settings.set('tm.page', page);
      state.selected = null;
      if (page === 'startup') state.serviceFilter = 'enabled';
      else if (page === 'services' && state.serviceFilter === 'enabled') state.serviceFilter = 'all';
      if (isServicePage() && !state.services) loadServices();
      if (page === 'users') loadSessions();
      pageEl.scrollTop = 0;
      render(true);
      schedule(0);
    }

    // ---------- data ----------
    function push(arr, v) { arr.push(v); if (arr.length > HISTORY) arr.shift(); }

    async function tick() {
      if (closed) return;
      const needProcs = ['procs', 'details', 'users'].includes(state.page);
      const jobs = [];
      if (!busy.perf) {
        busy.perf = true;
        jobs.push(api.get('/api/perf').then((p) => {
          state.perf = p;
          const hs = state.hist;
          push(hs.cpu, p.cpu.usage);
          push(hs.mem, (p.memory.used / p.memory.total) * 100);
          p.cpu.perCore.forEach((v, i) => { hs.cores[i] = hs.cores[i] || []; push(hs.cores[i], v); });
          for (const d of p.disks) {
            const k = hs.disk[d.name] = hs.disk[d.name] || { active: [], read: [], write: [] };
            push(k.active, d.active); push(k.read, d.readRate); push(k.write, d.writeRate);
          }
          for (const n of p.net) {
            const k = hs.net[n.iface] = hs.net[n.iface] || { rx: [], tx: [] };
            push(k.rx, n.rxRate); push(k.tx, n.txRate);
          }
        }).finally(() => { busy.perf = false; }));
      }
      if (needProcs && !busy.procs) {
        busy.procs = true;
        jobs.push(api.get('/api/procs').then((r) => { state.procs = r.list; state.selfPid = r.self; }).finally(() => { busy.procs = false; }));
      }
      try { await Promise.all(jobs); } catch (err) { statusEl.textContent = 'Błąd: ' + err.message; }
      if (!closed) render();
      schedule();
    }

    function schedule(delay) {
      clearTimeout(timer);
      if (closed) return;
      if (delay === 0) { timer = setTimeout(tick, 0); return; }
      if (!state.speed) return;
      timer = setTimeout(tick, state.speed);
    }

    async function loadServices() {
      try {
        state.services = await api.get('/api/services');
        state.servicesError = '';
      } catch (err) {
        state.services = [];
        state.servicesError = err.message;
      }
      render();
    }

    async function loadSessions() {
      try { state.sessions = await api.get('/api/sessions'); } catch { state.sessions = []; }
    }

    const visibleProcs = () => state.procs.filter((p) => state.kthreads || !p.kthread);
    function matches(p) {
      const q = search.value.trim().toLowerCase();
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || p.cmd.toLowerCase().includes(q) || p.user.toLowerCase().includes(q) || String(p.pid) === q;
    }

    function selectedPids() {
      const s = state.selected;
      if (!s) return [];
      if (s.kind === 'pid') return [s.id];
      if (s.kind === 'group') return visibleProcs().filter((p) => p.name === s.id).map((p) => p.pid);
      return [];
    }

    // ---------- process actions ----------
    async function endTask(pids, signal, tree) {
      pids = pids.filter((p) => p !== state.selfPid);
      if (!pids.length) return WD.toast('Nie można zakończyć procesu samego panelu', 'error');
      const first = state.procs.find((p) => p.pid === pids[0]);
      const name = first ? first.name : 'PID ' + pids[0];
      const what = pids.length > 1 ? `${pids.length} procesów „${name}”` : `„${name}” (PID ${pids[0]})`;
      const verb = signal === 'SIGKILL' ? 'Wymusić zakończenie' : tree ? 'Zakończyć drzewo procesów' : 'Zakończyć';
      const ok = await WD.confirm('Menedżer zadań', `${verb} ${what}?` + (signal === 'SIGKILL' ? ' Niezapisane dane w tym programie zostaną utracone.' : ''), { okLabel: 'Zakończ', danger: true });
      if (!ok) return;
      let failed = 0;
      for (const pid of pids) {
        try { await api.post('/api/kill', { pid, signal, tree: !!tree }); } catch (err) { failed++; if (pids.length === 1) WD.error(err); }
      }
      if (failed && pids.length > 1) WD.toast(`Nie udało się zakończyć ${failed} procesów`, 'error');
      state.selected = null;
      setTimeout(() => schedule(0), 400);
    }

    async function sendSignal(pid, signal, okMsg) {
      try { await api.post('/api/kill', { pid, signal }); WD.toast(okMsg, 'ok'); schedule(0); } catch (err) { WD.error(err); }
    }

    async function setPriority(p) {
      const radios = PRIORITIES.map((pr) => {
        const input = h('input', { type: 'radio', name: 'prio', value: String(pr.nice) });
        if (priorityLabel(p.nice) === pr.label) input.checked = true;
        return h('label', { class: 'tm-radio' }, input, ` ${pr.label} `, h('span', { class: 'tm-dim' }, `(nice ${pr.nice})`));
      });
      const v = await WD.dialog({
        title: `Priorytet: ${p.name} (PID ${p.pid})`,
        body: h('div', {}, `Obecnie: ${priorityLabel(p.nice)} (nice ${p.nice}). Podwyższanie priorytetu wymaga uprawnień roota.`, ...radios),
        buttons: [{ label: 'Zmień priorytet', value: 'ok', kind: 'primary' }, { label: 'Anuluj', value: null }]
      });
      if (v !== 'ok') return;
      const chosen = radios.map((r) => r.querySelector('input')).find((i) => i.checked);
      if (!chosen) return;
      try {
        await api.post('/api/renice', { pid: p.pid, nice: Number(chosen.value) });
        WD.toast('Zmieniono priorytet', 'ok');
        schedule(0);
      } catch (err) { WD.error(err); }
    }

    async function openLocation(p, which) {
      try {
        const d = await api.get('/api/proc', { pid: p.pid });
        const target = which === 'cwd' ? d.cwd : d.exe && WD.path.dir(d.exe);
        if (!target) return WD.toast('Brak dostępu do lokalizacji tego procesu', 'error');
        WD.apps.explorer.launch({ path: target.replace(/ \(deleted\)$/, '') });
      } catch (err) { WD.error(err); }
    }

    async function properties(p) {
      let d;
      try { d = await api.get('/api/proc', { pid: p.pid }); } catch (err) { return WD.error(err); }
      const row = (k, v) => [h('dt', {}, k), h('dd', {}, v == null || v === '' ? '—' : String(v))];
      const body = h('div', {}, h('dl', { class: 'props' },
        row('Nazwa', d.name), row('PID', d.pid), row('Proces nadrzędny (PPID)', d.ppid),
        row('Użytkownik', `${d.user} (uid ${d.uid})`), row('Stan', STATES[d.state] || d.state),
        row('Plik programu', d.exe), row('Folder roboczy', d.cwd),
        row('Polecenie', d.cmdline.join(' ')),
        row('Uruchomiono', new Date(d.start).toLocaleString('pl-PL')),
        row('Czas procesora', duration(d.cpuTime)),
        row('Priorytet', `${priorityLabel(d.nice)} (nice ${d.nice})`),
        row('Wątki', d.threads), row('Otwarte pliki (dojścia)', d.fds),
        row('Pamięć (RSS)', fmt.size(d.rss)), row('Pamięć wirtualna', fmt.size(d.vsz)),
        row('Szczyt pamięci', d.vmPeak), row('W pliku wymiany', d.vmSwap),
        row('Odczytano z dysku', d.readBytes != null ? fmt.size(d.readBytes) : null),
        row('Zapisano na dysk', d.writeBytes != null ? fmt.size(d.writeBytes) : null),
        row('Przełączenia kontekstu', d.ctxSwitches.toLocaleString('pl-PL')),
        row('Procesy potomne', d.children.length ? d.children.join(', ') : 'brak')));
      const v = await WD.dialog({
        title: 'Właściwości procesu',
        body,
        buttons: [{ label: 'Zamknij', value: null, kind: 'primary' }, { label: 'Otwórz lokalizację', value: 'loc' }]
      });
      if (v === 'loc') openLocation(p, 'exe');
    }

    function processMenu(e, p) {
      e.preventDefault();
      const stopped = p.state === 'T';
      WD.contextMenu(e.clientX, e.clientY, [
        { label: 'Zakończ zadanie', icon: 'close', key: 'Del', action: () => endTask([p.pid], 'SIGTERM') },
        { label: 'Wymuś zakończenie', icon: 'kill', danger: true, action: () => endTask([p.pid], 'SIGKILL') },
        { label: 'Zakończ drzewo procesów', icon: 'kill', danger: true, action: () => endTask([p.pid], 'SIGTERM', true) },
        '-',
        stopped
          ? { label: 'Wznów proces', icon: 'forward', action: () => sendSignal(p.pid, 'SIGCONT', 'Wznowiono proces') }
          : { label: 'Wstrzymaj proces', icon: 'lock', action: () => sendSignal(p.pid, 'SIGSTOP', 'Wstrzymano proces') },
        { label: 'Ustaw priorytet…', icon: 'up', action: () => setPriority(p) },
        '-',
        { label: 'Otwórz lokalizację pliku', icon: 'open', action: () => openLocation(p, 'exe') },
        { label: 'Otwórz folder roboczy', icon: 'open', action: () => openLocation(p, 'cwd') },
        state.page !== 'details' ? { label: 'Przejdź do szczegółów', icon: 'list', action: () => { show('details'); state.selected = { kind: 'pid', id: p.pid }; render(); scrollToSelected(); } } : null,
        { label: 'Kopiuj polecenie', icon: 'copy', action: () => WD.fileOps.copyPath(p.cmd) },
        '-',
        { label: 'Właściwości', icon: 'info', action: () => properties(p) }
      ]);
    }

    function runNewTask() {
      const input = h('input', { class: 'field', placeholder: 'np. python3 skrypt.py albo htop', spellcheck: 'false' });
      const inTerm = h('input', { type: 'checkbox', checked: true });
      WD.dialog({
        title: 'Utwórz nowe zadanie',
        body: h('div', {}, 'Wpisz polecenie do uruchomienia na serwerze.', input,
          h('label', { class: 'tm-radio' }, inTerm, ' Uruchom w oknie terminala (widać wynik)')),
        buttons: [{ label: 'Uruchom', value: 'ok', kind: 'primary' }, { label: 'Anuluj', value: null }],
        onOpen: () => input.focus()
      }).then(async (v) => {
        const command = input.value.trim();
        if (v !== 'ok' || !command) return;
        if (inTerm.checked) return WD.apps.terminal.launch({ command });
        try {
          const r = await api.post('/api/run', { command });
          WD.toast(`Uruchomiono w tle (PID ${r.pid})`, 'ok');
          schedule(0);
        } catch (err) { WD.error(err); }
      });
    }

    // ---------- service actions ----------
    const SERVICE_ACTIONS = {
      start: ['Uruchom', 'Uruchomiono'],
      stop: ['Zatrzymaj', 'Zatrzymano'],
      restart: ['Uruchom ponownie', 'Uruchomiono ponownie'],
      enable: ['Włącz autostart', 'Włączono autostart i uruchomiono'],
      disable: ['Wyłącz autostart', 'Wyłączono autostart i zatrzymano']
    };
    async function serviceAction(name, action) {
      if (action === 'stop' || action === 'disable') {
        const ok = await WD.confirm('Usługi', `${SERVICE_ACTIONS[action][0]}: ${name}?`, { okLabel: SERVICE_ACTIONS[action][0], danger: true });
        if (!ok) return;
      }
      WD.toast(`${SERVICE_ACTIONS[action][0]}: ${name}…`);
      try {
        await api.post('/api/service', { name, action });
        WD.toast(`${SERVICE_ACTIONS[action][1]}: ${name}`, 'ok');
      } catch (err) { WD.error(err); }
      loadServices();
    }

    function serviceLogs(name) {
      const pre = h('pre', { class: 'tm-log' }, 'Wczytywanie…');
      const load = async () => {
        try { pre.textContent = (await api.get('/api/service-logs', { name })) || '(brak wpisów)'; } catch (err) { pre.textContent = err.message; }
        pre.scrollTop = pre.scrollHeight;
      };
      const w = WD.wm.open({ app: 'logs', title: `Logi: ${name}`, icon: WD.appIcon('editor'), width: 820, height: 520 });
      w.body.append(h('div', { class: 'toolbar' },
        h('button', { class: 'tbtn', onclick: load }, h('span', { html: WD.glyph('refresh'), style: { display: 'inline-flex' } }), 'Odśwież'),
        h('span', { class: 'tm-dim', style: { marginLeft: '8px', fontSize: '12px' } }, 'Ostatnie 300 wpisów z journalctl')), pre);
      load();
    }

    function serviceMenu(e, s) {
      e.preventDefault();
      const running = s.active === 'active' || s.active === 'activating';
      const enabled = s.enabled === 'enabled';
      WD.contextMenu(e.clientX, e.clientY, [
        { label: 'Uruchom', icon: 'forward', disabled: running, action: () => serviceAction(s.name, 'start') },
        { label: 'Zatrzymaj', icon: 'close', disabled: !running, action: () => serviceAction(s.name, 'stop') },
        { label: 'Uruchom ponownie', icon: 'refresh', action: () => serviceAction(s.name, 'restart') },
        '-',
        { label: 'Włącz autostart', icon: 'power', disabled: enabled || s.enabled === 'static' || s.enabled === 'masked', action: () => serviceAction(s.name, 'enable') },
        { label: 'Wyłącz autostart', icon: 'power', disabled: !enabled, action: () => serviceAction(s.name, 'disable') },
        '-',
        { label: 'Pokaż logi', icon: 'list', action: () => serviceLogs(s.name) },
        s.pid ? { label: 'Przejdź do procesu', icon: 'list', action: () => { show('details'); state.selected = { kind: 'pid', id: s.pid }; schedule(0); } } : null,
        { label: 'Kopiuj nazwę', icon: 'copy', action: () => WD.fileOps.copyPath(s.name) }
      ]);
    }

    // ---------- header buttons ----------
    function btn(label, icon, fn, opts2 = {}) {
      return h('button', { class: 'tbtn' + (opts2.primary ? ' tm-primary' : ''), disabled: opts2.disabled, title: opts2.title || label, onclick: fn },
        h('span', { html: WD.glyph(icon), style: { display: 'inline-flex' } }), h('span', { class: 'hide-sm' }, label));
    }

    function renderActions() {
      const pids = selectedPids();
      if (isServicePage()) {
        const s = state.selected && state.selected.kind === 'service' && (state.services || []).find((x) => x.name === state.selected.id);
        const running = s && (s.active === 'active' || s.active === 'activating');
        actions.replaceChildren(
          btn('Uruchom', 'forward', () => serviceAction(s.name, 'start'), { disabled: !s || running }),
          btn('Zatrzymaj', 'close', () => serviceAction(s.name, 'stop'), { disabled: !s || !running }),
          btn('Uruchom ponownie', 'refresh', () => serviceAction(s.name, 'restart'), { disabled: !s }),
          btn('Logi', 'list', () => serviceLogs(s.name), { disabled: !s }),
          btn('Odśwież', 'refresh', loadServices, { title: 'Odśwież listę usług' }));
      } else {
        actions.replaceChildren(...[
          btn('Uruchom nowe zadanie', 'newfile', runNewTask),
          state.page === 'perf' ? null : btn('Zakończ zadanie', 'close', () => endTask(pids, 'SIGTERM'), { disabled: !pids.length, primary: true })
        ].filter(Boolean));
      }
    }

    // ---------- rendering ----------
    let lastPage = null;
    function render(force) {
      if (closed) return;
      for (const [id] of NAV) navBtns[id].classList.toggle('on', state.page === id);
      titleEl.textContent = NAV.find((n) => n[0] === state.page)[1];
      search.hidden = state.page === 'perf';
      renderActions();
      renderStatus();
      if (force || lastPage !== state.page) { pageEl.textContent = ''; views = {}; lastPage = state.page; }
      ({ procs: renderProcs, perf: renderPerf, users: renderUsers, details: renderDetails, services: renderServices, startup: renderServices })[state.page]();
    }

    function renderStatus() {
      const p = state.perf;
      if (!p) { statusEl.textContent = 'Wczytywanie…'; return; }
      statusEl.replaceChildren(
        h('span', {}, `Procesy: ${p.cpu.processes}`),
        h('span', {}, `Użycie procesora: ${pct(p.cpu.usage)}`),
        h('span', {}, `Pamięć fizyczna: ${pct((p.memory.used / p.memory.total) * 100)}`),
        h('span', { class: 'hide-sm' }, `Czas działania: ${duration(p.uptime)}`),
        h('span', { class: 'tm-dim' }, state.speed ? '' : 'Aktualizacja wstrzymana'));
    }

    let views = {};
    function selectRow(sel) {
      state.selected = sel;
      render();
    }
    const isSel = (kind, id) => state.selected && state.selected.kind === kind && state.selected.id === id;
    function scrollToSelected() {
      requestAnimationFrame(() => {
        const el = pageEl.querySelector('tr.sel');
        if (el) el.scrollIntoView({ block: 'center' });
      });
    }

    // ----- Processes (grouped by name, like Windows "apps") -----
    const PROC_COLS = [
      { key: 'name', label: 'Nazwa', cls: 'tm-name' },
      { key: 'status', label: 'Stan', sortable: false, cls: 'hide-sm', width: '120px' },
      { key: 'user', label: 'Użytkownik', cls: 'hide-sm', width: '110px' },
      { key: 'cpu', label: 'Procesor', num: true, width: '90px' },
      { key: 'mem', label: 'Pamięć', num: true, width: '100px' },
      { key: 'disk', label: 'Dysk', num: true, width: '100px' }
    ];
    function renderProcs() {
      if (!views.procs) {
        views.procs = table(PROC_COLS, { sort: state.sorts.procs, onSort: () => render() });
        pageEl.append(views.procs.el);
      }
      const v = views.procs;
      const p = state.perf;
      const maxDisk = p && p.disks.length ? Math.max(...p.disks.map((d) => d.active)) : 0;
      v.header(p ? { cpu: pct(p.cpu.usage), mem: pct((p.memory.used / p.memory.total) * 100), disk: pct(maxDisk) } : null);

      const groups = new Map();
      for (const pr of visibleProcs()) {
        if (!matches(pr)) continue;
        let g = groups.get(pr.name);
        if (!g) groups.set(pr.name, g = { name: pr.name, list: [], cpu: 0, mem: 0, disk: 0, users: new Set() });
        g.list.push(pr);
        g.cpu += pr.cpu;
        g.mem += pr.mem;
        g.disk += pr.disk || 0;
        g.users.add(pr.user);
      }
      const cmp = sorter(state.sorts.procs, PROC_COLS);
      const rows = [...groups.values()].map((g) => ({ ...g, user: [...g.users].join(', ') })).sort(cmp);
      const memTotal = p ? p.memory.total : 1;
      const tr = [];
      const cells = (row, isGroup, count) => [
        h('td', { class: 'tm-name' },
          isGroup && count > 1 ? h('span', { class: 'tm-exp' + (state.expanded.has(row.name) ? ' open' : ''), onclick: (e) => { e.stopPropagation(); toggleGroup(row.name); } }, '›') : h('span', { class: 'tm-exp none' }),
          h('span', { class: 'tm-pico', html: procIcon(row) }),
          h('span', { class: 'tm-pname', title: isGroup ? row.name : row.cmd }, isGroup ? row.name + (count > 1 ? ` (${count})` : '') : row.cmd)),
        h('td', { class: 'hide-sm tm-dim' }, row.list ? groupStatus(row.list) : (STATES[row.state] || row.state)),
        h('td', { class: 'hide-sm tm-dim' }, row.user),
        h('td', { class: 'num', style: { background: heat(row.cpu / 100) } }, pct(row.cpu, 1)),
        h('td', { class: 'num', style: { background: heat(row.mem / memTotal * 2) } }, fmt.size(row.mem)),
        h('td', { class: 'num', style: { background: heat((row.disk || 0) / (20 * 1024 * 1024)) } }, row.disk ? rate(row.disk) : '0 B/s')
      ];
      for (const g of rows) {
        const single = g.list.length === 1;
        const id = single ? g.list[0].pid : g.name;
        const kind = single ? 'pid' : 'group';
        const rowData = single ? { ...g.list[0], name: g.name } : g;
        tr.push(h('tr', {
          class: isSel(kind, id) ? 'sel' : '',
          onclick: () => selectRow({ kind, id }),
          ondblclick: () => (single ? properties(g.list[0]) : toggleGroup(g.name)),
          oncontextmenu: (e) => (single ? processMenu(e, g.list[0]) : groupMenu(e, g))
        }, ...cells(rowData, true, g.list.length)));
        if (!single && state.expanded.has(g.name)) {
          for (const pr of g.list.slice().sort(cmp)) {
            tr.push(h('tr', {
              class: 'tm-child' + (isSel('pid', pr.pid) ? ' sel' : ''),
              onclick: () => selectRow({ kind: 'pid', id: pr.pid }),
              ondblclick: () => properties(pr),
              oncontextmenu: (e) => processMenu(e, pr)
            }, ...cells(pr, false, 1)));
          }
        }
      }
      if (!tr.length) tr.push(h('tr', {}, h('td', { colspan: '6', class: 'tm-empty' }, state.procs.length ? 'Brak pasujących procesów' : 'Wczytywanie…')));
      v.tbody.replaceChildren(...tr);
    }

    function groupStatus(list) {
      if (list.some((p) => p.state === 'T')) return 'Wstrzymany';
      if (list.some((p) => p.state === 'Z')) return 'Zombie';
      return list.some((p) => p.state === 'R') ? 'Uruchomiony' : 'Uśpiony';
    }

    function procIcon(row) {
      const n = (row.name || '?').replace(/[^\p{L}\p{N}]/gu, '');
      const letter = (n[0] || '?').toUpperCase();
      let hash = 0;
      for (const ch of row.name || '') hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
      const hue = hash % 360;
      return `<svg viewBox="0 0 20 20"><rect x="1" y="1" width="18" height="18" rx="4" fill="hsl(${hue} 55% 48%)"/><text x="10" y="14.2" font-size="11" font-weight="700" text-anchor="middle" fill="#fff" font-family="Segoe UI, Arial, sans-serif">${letter.replace(/[<&>]/g, '')}</text></svg>`;
    }

    function toggleGroup(name) {
      if (state.expanded.has(name)) state.expanded.delete(name); else state.expanded.add(name);
      render();
    }

    function groupMenu(e, g) {
      e.preventDefault();
      state.selected = { kind: 'group', id: g.name };
      render();
      WD.contextMenu(e.clientX, e.clientY, [
        { label: state.expanded.has(g.name) ? 'Zwiń' : 'Rozwiń', icon: 'list', action: () => toggleGroup(g.name) },
        '-',
        { label: `Zakończ zadanie (${g.list.length} procesów)`, icon: 'close', key: 'Del', action: () => endTask(g.list.map((p) => p.pid), 'SIGTERM') },
        { label: 'Wymuś zakończenie wszystkich', icon: 'kill', danger: true, action: () => endTask(g.list.map((p) => p.pid), 'SIGKILL') },
        '-',
        { label: 'Pokaż w szczegółach', icon: 'list', action: () => { search.value = g.name; show('details'); } }
      ]);
    }

    // ----- Details (flat list with every column) -----
    const DETAIL_COLS = [
      { key: 'name', label: 'Nazwa', cls: 'tm-name' },
      { key: 'pid', label: 'PID', num: true, width: '70px' },
      { key: 'state', label: 'Stan', width: '100px', sortValue: (r) => STATES[r.state] || r.state },
      { key: 'user', label: 'Użytkownik', width: '100px' },
      { key: 'cpu', label: 'Procesor', num: true, width: '80px' },
      { key: 'cpuTime', label: 'Czas procesora', num: true, width: '100px', cls: 'hide-sm' },
      { key: 'mem', label: 'Pamięć', num: true, width: '90px' },
      { key: 'vsz', label: 'Wirtualna', num: true, width: '90px', cls: 'hide-sm' },
      { key: 'threads', label: 'Wątki', num: true, width: '60px', cls: 'hide-sm' },
      { key: 'nice', label: 'Priorytet', width: '120px', cls: 'hide-sm' },
      { key: 'disk', label: 'Dysk', num: true, width: '90px', cls: 'hide-sm' },
      { key: 'start', label: 'Uruchomiono', num: true, width: '130px', cls: 'hide-sm' },
      { key: 'cmd', label: 'Wiersz polecenia', cls: 'hide-sm tm-cmd' }
    ];
    function renderDetails() {
      if (!views.details) {
        views.details = table(DETAIL_COLS, { sort: state.sorts.details, onSort: () => render() });
        pageEl.append(views.details.el);
      }
      const v = views.details;
      v.header(null);
      const rows = visibleProcs().filter(matches).sort(sorter(state.sorts.details, DETAIL_COLS));
      const memTotal = state.perf ? state.perf.memory.total : 1;
      v.tbody.replaceChildren(...rows.map((p) => h('tr', {
        class: isSel('pid', p.pid) ? 'sel' : '',
        onclick: () => selectRow({ kind: 'pid', id: p.pid }),
        ondblclick: () => properties(p),
        oncontextmenu: (e) => { state.selected = { kind: 'pid', id: p.pid }; render(); processMenu(e, p); }
      },
      h('td', { class: 'tm-name' }, h('span', { class: 'tm-pico', html: procIcon(p) }), h('span', { class: 'tm-pname' }, p.name)),
      h('td', { class: 'num' }, p.pid),
      h('td', { class: 'tm-dim' }, STATES[p.state] || p.state),
      h('td', { class: 'tm-dim' }, p.user),
      h('td', { class: 'num', style: { background: heat(p.cpu / 100) } }, pct(p.cpu, 1)),
      h('td', { class: 'num hide-sm' }, duration(p.cpuTime)),
      h('td', { class: 'num', style: { background: heat(p.mem / memTotal * 2) } }, fmt.size(p.mem)),
      h('td', { class: 'num hide-sm tm-dim' }, fmt.size(p.vsz)),
      h('td', { class: 'num hide-sm' }, p.threads),
      h('td', { class: 'hide-sm tm-dim' }, `${priorityLabel(p.nice)} (${p.nice})`),
      h('td', { class: 'num hide-sm' }, p.disk == null ? '—' : rate(p.disk)),
      h('td', { class: 'num hide-sm tm-dim' }, new Date(p.start).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })),
      h('td', { class: 'hide-sm tm-cmd', title: p.cmd }, p.cmd))));
      if (!rows.length) v.tbody.append(h('tr', {}, h('td', { colspan: String(DETAIL_COLS.length), class: 'tm-empty' }, state.procs.length ? 'Brak pasujących procesów' : 'Wczytywanie…')));
      if (state.selected && state.selected.kind === 'pid' && !v.scrolledTo) { v.scrolledTo = state.selected.id; scrollToSelected(); }
    }

    // ----- Users -----
    const USER_COLS = [
      { key: 'user', label: 'Użytkownik', cls: 'tm-name' },
      { key: 'status', label: 'Stan', sortable: false },
      { key: 'count', label: 'Procesy', num: true, width: '80px' },
      { key: 'cpu', label: 'Procesor', num: true, width: '90px' },
      { key: 'mem', label: 'Pamięć', num: true, width: '100px' }
    ];
    let sessionsLoadedAt = 0;
    function renderUsers() {
      if (Date.now() - sessionsLoadedAt > 10000) { sessionsLoadedAt = Date.now(); loadSessions(); }
      if (!views.users) {
        views.users = table(USER_COLS, { sort: state.sorts.users, onSort: () => render() });
        pageEl.append(views.users.el);
      }
      const v = views.users;
      const p = state.perf;
      v.header(p ? { cpu: pct(p.cpu.usage), mem: pct((p.memory.used / p.memory.total) * 100) } : null);
      const byUser = new Map();
      for (const pr of visibleProcs()) {
        if (!matches(pr)) continue;
        const u = byUser.get(pr.user) || { user: pr.user, count: 0, cpu: 0, mem: 0 };
        u.count++; u.cpu += pr.cpu; u.mem += pr.mem;
        byUser.set(pr.user, u);
      }
      for (const s of state.sessions) if (!byUser.has(s.user)) byUser.set(s.user, { user: s.user, count: 0, cpu: 0, mem: 0 });
      const rows = [...byUser.values()].sort(sorter(state.sorts.users, USER_COLS));
      const memTotal = p ? p.memory.total : 1;
      v.tbody.replaceChildren(...rows.map((u) => {
        const sess = state.sessions.filter((s) => s.user === u.user);
        const status = sess.length
          ? `Zalogowany · ${sess.map((s) => s.tty + (s.from ? ' z ' + s.from : '')).join(', ')}`
          : (u.user === WD.info.systemUser ? 'Panel WebPulpit' : '');
        return h('tr', {
          class: isSel('user', u.user) ? 'sel' : '',
          onclick: () => selectRow({ kind: 'user', id: u.user }),
          ondblclick: () => { search.value = u.user; show('details'); }
        },
        h('td', { class: 'tm-name' }, h('span', { class: 'avatar tm-avatar' }, u.user[0] || '?'), h('span', { class: 'tm-pname' }, u.user)),
        h('td', { class: 'tm-dim' }, status),
        h('td', { class: 'num' }, u.count),
        h('td', { class: 'num', style: { background: heat(u.cpu / 100) } }, pct(u.cpu, 1)),
        h('td', { class: 'num', style: { background: heat(u.mem / memTotal * 2) } }, fmt.size(u.mem)));
      }));
    }

    // ----- Services / Startup -----
    const SVC_STATE = (s) => {
      if (s.active === 'active') return s.sub === 'running' ? 'Uruchomiona' : s.sub === 'exited' ? 'Wykonana' : 'Aktywna (' + s.sub + ')';
      if (s.active === 'failed') return 'Błąd';
      if (s.active === 'activating') return 'Uruchamianie…';
      if (s.active === 'deactivating') return 'Zatrzymywanie…';
      return 'Zatrzymana';
    };
    const SVC_ENABLED = { enabled: 'Włączony', 'enabled-runtime': 'Włączony (tymczasowo)', disabled: 'Wyłączony', static: 'Statyczny', masked: 'Zablokowany', indirect: 'Pośredni', generated: 'Generowany', alias: 'Alias', transient: 'Tymczasowy' };
    const SVC_COLS = [
      { key: 'name', label: 'Nazwa', cls: 'tm-name' },
      { key: 'pid', label: 'PID', num: true, width: '70px' },
      { key: 'description', label: 'Opis', cls: 'hide-sm' },
      { key: 'state', label: 'Stan', width: '120px', sortValue: SVC_STATE },
      { key: 'enabled', label: 'Autostart', width: '120px', sortValue: (s) => SVC_ENABLED[s.enabled] || s.enabled },
      { key: 'memory', label: 'Pamięć', num: true, width: '90px', cls: 'hide-sm' }
    ];
    let servicesLoadedAt = 0;
    function renderServices() {
      if (Date.now() - servicesLoadedAt > 5000 && state.services) { servicesLoadedAt = Date.now(); loadServices(); }
      if (!views.services) {
        const filters = [['all', 'Wszystkie'], ['running', 'Uruchomione'], ['stopped', 'Zatrzymane'], ['failed', 'Z błędem'], ['enabled', 'Autostart włączony']];
        const bar = h('div', { class: 'tm-filters' }, ...filters.map(([id, label]) => h('button', {
          class: 'tm-chip', 'data-id': id,
          onclick: () => { state.serviceFilter = id; render(); }
        }, label)));
        const note = h('div', { class: 'tm-note' });
        views.services = table(SVC_COLS, { sort: state.sorts.services, onSort: () => render() });
        views.services.bar = bar;
        views.services.note = note;
        pageEl.append(bar, note, views.services.el);
      }
      const v = views.services;
      for (const c of v.bar.children) c.classList.toggle('on', c.dataset.id === state.serviceFilter);
      v.note.textContent = state.page === 'startup'
        ? 'Usługi uruchamiane automatycznie przy starcie serwera. Prawy przycisk myszy: włącz/wyłącz autostart.'
        : '';
      v.note.hidden = !v.note.textContent;
      v.header(null);
      if (state.servicesError) {
        v.tbody.replaceChildren(h('tr', {}, h('td', { colspan: '6', class: 'tm-empty' }, state.servicesError)));
        return;
      }
      if (!state.services) {
        v.tbody.replaceChildren(h('tr', {}, h('td', { colspan: '6', class: 'tm-empty' }, 'Wczytywanie usług…')));
        return;
      }
      const q = search.value.trim().toLowerCase();
      const f = state.serviceFilter;
      const rows = state.services.filter((s) => {
        if (q && !s.name.toLowerCase().includes(q) && !(s.description || '').toLowerCase().includes(q) && String(s.pid) !== q) return false;
        if (f === 'running') return s.active === 'active' && s.sub === 'running';
        if (f === 'stopped') return s.active === 'inactive';
        if (f === 'failed') return s.active === 'failed';
        if (f === 'enabled') return s.enabled === 'enabled';
        return true;
      }).sort(sorter(state.sorts.services, SVC_COLS));
      v.tbody.replaceChildren(...rows.map((s) => {
        const st = SVC_STATE(s);
        return h('tr', {
          class: isSel('service', s.name) ? 'sel' : '',
          onclick: () => selectRow({ kind: 'service', id: s.name }),
          ondblclick: () => serviceLogs(s.name),
          oncontextmenu: (e) => { state.selected = { kind: 'service', id: s.name }; render(); serviceMenu(e, s); }
        },
        h('td', { class: 'tm-name' }, h('span', { class: 'tm-dot ' + (s.active === 'failed' ? 'bad' : s.active === 'active' ? 'ok' : '') }), h('span', { class: 'tm-pname' }, s.name.replace(/\.service$/, ''))),
        h('td', { class: 'num' }, s.pid || ''),
        h('td', { class: 'hide-sm tm-dim tm-cmd', title: s.description }, s.description),
        h('td', { class: s.active === 'failed' ? 'tm-bad' : '' }, st),
        h('td', { class: 'tm-dim' }, SVC_ENABLED[s.enabled] || s.enabled || '—'),
        h('td', { class: 'num hide-sm' }, s.memory != null ? fmt.size(s.memory) : ''));
      }));
      if (!rows.length) v.tbody.append(h('tr', {}, h('td', { colspan: '6', class: 'tm-empty' }, 'Brak usług')));
    }

    // ----- Performance -----
    function renderPerf() {
      const p = state.perf;
      if (!p) { if (!pageEl.childElementCount) pageEl.append(h('div', { class: 'tm-empty' }, 'Wczytywanie…')); return; }
      const items = [
        { id: 'cpu', title: 'Procesor', color: COLORS.cpu },
        { id: 'mem', title: 'Pamięć', color: COLORS.mem },
        ...p.disks.map((d, i) => ({ id: 'disk:' + d.name, title: `Dysk ${i} (${d.name})`, color: COLORS.disk, disk: d })),
        ...p.net.map((n) => ({ id: 'net:' + n.iface, title: `${n.type} (${n.iface})`, color: COLORS.net, net: n }))
      ];
      if (!items.find((i) => i.id === state.perfItem)) state.perfItem = 'cpu';
      const key = items.map((i) => i.id).join('|') + '#' + state.perfItem + '#' + state.coresView;
      if (!views.perf || views.perf.key !== key) buildPerf(items, key);
      updatePerf(items);
    }

    function buildPerf(items, key) {
      pageEl.textContent = '';
      const list = h('div', { class: 'tm-plist' });
      const detail = h('div', { class: 'tm-pdetail' });
      const v = views.perf = { key, list, detail, side: {}, canvases: [] };
      for (const it of items) {
        const spark = h('canvas', { class: 'tm-spark' });
        const sub1 = h('div', { class: 'tm-psub' });
        const sub2 = h('div', { class: 'tm-psub' });
        const el = h('button', { class: 'tm-pitem' + (state.perfItem === it.id ? ' on' : ''), onclick: () => { state.perfItem = it.id; render(); } },
          spark, h('div', { class: 'tm-ptext' }, h('div', { class: 'tm-ptitle' }, it.title), sub1, sub2));
        v.side[it.id] = { spark, sub1, sub2 };
        list.append(el);
      }
      const it = items.find((i) => i.id === state.perfItem);
      v.head = h('div', { class: 'tm-dhead' }, h('h3', {}, it.title), h('span', { class: 'tm-model' }));
      v.graphLabel = h('div', { class: 'tm-glabel' }, h('span'), h('span'));
      v.main = h('canvas', { class: 'tm-graph' });
      v.second = null;
      v.coreGrid = null;
      const blocks = [v.head, v.graphLabel];
      if (it.id === 'cpu' && state.coresView) {
        v.coreGrid = h('div', { class: 'tm-cores' });
        v.coreCanvases = (state.perf.cpu.perCore || []).map((_, i) => {
          const c = h('canvas', { class: 'tm-core' });
          v.coreGrid.append(h('div', { class: 'tm-corewrap' }, c, h('span', {}, 'CPU ' + i)));
          return c;
        });
        blocks.push(v.coreGrid);
      } else {
        blocks.push(v.main);
      }
      if (it.disk || it.net) {
        v.secondLabel = h('div', { class: 'tm-glabel' }, h('span'), h('span'));
        v.second = h('canvas', { class: 'tm-graph tm-graph2' });
        if (it.disk) blocks.push(v.secondLabel, v.second);
      }
      if (it.id === 'mem') {
        v.compLabel = h('div', { class: 'tm-glabel' }, h('span', {}, 'Struktura pamięci'), h('span'));
        v.comp = h('div', { class: 'tm-comp' });
        blocks.push(v.compLabel, v.comp);
      }
      if (it.id === 'cpu') {
        v.coreToggle = h('button', { class: 'tbtn tm-small', onclick: () => { state.coresView = !state.coresView; WD.settings.set('tm.cores', state.coresView); render(); } },
          state.coresView ? 'Pokaż wykres ogólny' : 'Pokaż rdzenie logiczne');
        blocks.push(h('div', { class: 'tm-toggle' }, v.coreToggle));
      }
      v.stats = h('div', { class: 'tm-stats' });
      blocks.push(v.stats);
      detail.append(...blocks);
      pageEl.append(h('div', { class: 'tm-perf' }, list, detail));
    }

    function stat(label, value, big) {
      return h('div', { class: 'tm-stat' + (big ? ' big' : '') }, h('div', { class: 'tm-slabel' }, label), h('div', { class: 'tm-svalue' }, value));
    }

    function updatePerf(items) {
      const v = views.perf;
      const p = state.perf;
      const hs = state.hist;
      const mem = p.memory;
      for (const it of items) {
        const s = v.side[it.id];
        if (!s) continue;
        if (it.id === 'cpu') {
          s.sub1.textContent = `${pct(p.cpu.usage)}${p.cpu.mhz ? '  ' + dec(p.cpu.mhz / 1000, 2) + ' GHz' : ''}`;
          s.sub2.textContent = `${p.cpu.logical} proc. logicznych`;
          drawGraph(s.spark, [{ data: hs.cpu, color: it.color }], 100, { small: true, grid: false });
        } else if (it.id === 'mem') {
          s.sub1.textContent = `${dec(mem.used / 2 ** 30)}/${dec(mem.total / 2 ** 30)} GB (${pct((mem.used / mem.total) * 100)})`;
          s.sub2.textContent = mem.swapTotal ? `Wymiana: ${fmt.size(mem.swapUsed)}` : '';
          drawGraph(s.spark, [{ data: hs.mem, color: it.color }], 100, { small: true, grid: false });
        } else if (it.disk) {
          const d = p.disks.find((x) => x.name === it.disk.name) || it.disk;
          s.sub1.textContent = d.type + (d.mounts.length ? ' · ' + d.mounts[0] : '');
          s.sub2.textContent = pct(d.active);
          drawGraph(s.spark, [{ data: (hs.disk[d.name] || {}).active || [], color: it.color }], 100, { small: true, grid: false });
        } else if (it.net) {
          const n = p.net.find((x) => x.iface === it.net.iface) || it.net;
          const k = hs.net[n.iface] || { rx: [], tx: [] };
          s.sub1.textContent = `W: ${bits(n.txRate)}`;
          s.sub2.textContent = `O: ${bits(n.rxRate)}`;
          const max = niceMax([...k.rx, ...k.tx], 1250);
          drawGraph(s.spark, [{ data: k.rx, color: it.color }, { data: k.tx, color: it.color, dashed: true, fill: false }], max, { small: true, grid: false });
        }
      }

      const it = items.find((i) => i.id === state.perfItem);
      const [gl1, gl2] = v.graphLabel.children;
      const model = v.head.querySelector('.tm-model');
      if (it.id === 'cpu') {
        const c = p.cpu;
        model.textContent = c.model;
        gl1.textContent = state.coresView ? '% użycia każdego procesora logicznego w ciągu 60 sekund' : '% użycia w ciągu 60 sekund';
        gl2.textContent = '100%';
        if (v.coreGrid) v.coreCanvases.forEach((cv, i) => drawGraph(cv, [{ data: hs.cores[i] || [], color: it.color }], 100, { small: true }));
        else drawGraph(v.main, [{ data: hs.cpu, color: it.color }], 100);
        v.stats.replaceChildren(
          h('div', { class: 'tm-scol' },
            h('div', { class: 'tm-srow' }, stat('Użycie', pct(c.usage), true), stat('Szybkość', c.mhz ? dec(c.mhz / 1000, 2) + ' GHz' : '—', true)),
            h('div', { class: 'tm-srow' }, stat('Procesy', c.processes, true), stat('Wątki', c.threads, true), stat('Dojścia', c.handles.toLocaleString('pl-PL'), true)),
            stat('Czas działania', duration(p.uptime), true)),
          h('dl', { class: 'tm-kv' },
            ...kv('Szybkość podstawowa', c.baseMhz ? dec(c.baseMhz / 1000, 2) + ' GHz' : (c.mhz ? dec(c.mhz / 1000, 2) + ' GHz' : '—')),
            ...kv('Gniazda', c.sockets), ...kv('Rdzenie', c.cores), ...kv('Procesory logiczne', c.logical),
            ...kv('Wirtualizacja', c.virtSupport ? 'Włączone' : 'Niedostępne'),
            ...kv('Maszyna wirtualna', c.virtual ? 'Tak' : 'Nie'),
            ...kv('Pamięć podręczna', c.cache || '—'),
            ...kv('Średnie obciążenie', p.load.map((l) => dec(l, 2)).join(' / ')),
            ...kv('System', p.os), ...kv('Jądro', p.kernel)));
      } else if (it.id === 'mem') {
        model.textContent = `${dec(mem.total / 2 ** 30)} GB`;
        gl1.textContent = 'Użycie pamięci';
        gl2.textContent = `${dec(mem.total / 2 ** 30)} GB`;
        drawGraph(v.main, [{ data: hs.mem, color: it.color }], 100);
        const used = mem.used / mem.total * 100;
        const cached = Math.min(100 - used, (mem.cached + mem.buffers) / mem.total * 100);
        v.comp.replaceChildren(
          h('div', { class: 'tm-cseg used', style: { width: used + '%' }, title: `W użyciu: ${fmt.size(mem.used)}` }),
          h('div', { class: 'tm-cseg cached', style: { width: cached + '%' }, title: `W pamięci podręcznej: ${fmt.size(mem.cached + mem.buffers)}` }),
          h('div', { class: 'tm-cseg free', style: { flex: '1' }, title: `Wolna: ${fmt.size(mem.free)}` }));
        v.stats.replaceChildren(
          h('div', { class: 'tm-scol' },
            h('div', { class: 'tm-srow' }, stat('W użyciu', fmt.size(mem.used), true), stat('Dostępne', fmt.size(mem.available), true)),
            h('div', { class: 'tm-srow' }, stat('Zadeklarowane', `${dec(mem.committed / 2 ** 30)}/${dec(mem.commitLimit / 2 ** 30)} GB`, true), stat('Buforowane', fmt.size(mem.cached + mem.buffers), true)),
            h('div', { class: 'tm-srow' }, stat('Plik wymiany', mem.swapTotal ? `${fmt.size(mem.swapUsed)} / ${fmt.size(mem.swapTotal)}` : 'Brak', true))),
          h('dl', { class: 'tm-kv' },
            ...kv('Wolna', fmt.size(mem.free)), ...kv('Bufory', fmt.size(mem.buffers)),
            ...kv('Współdzielona', fmt.size(mem.shared)), ...kv('Do zapisu (dirty)', fmt.size(mem.dirty)),
            ...kv('Jądro (slab)', fmt.size(mem.slab))));
      } else if (it.disk) {
        const d = p.disks.find((x) => x.name === it.disk.name) || it.disk;
        const k = hs.disk[d.name] || { active: [], read: [], write: [] };
        model.textContent = d.model || d.name;
        gl1.textContent = 'Czas aktywności';
        gl2.textContent = '100%';
        drawGraph(v.main, [{ data: k.active, color: it.color }], 100);
        const max = niceMax([...k.read, ...k.write], 1024 * 1024);
        const [s1, s2] = v.secondLabel.children;
        s1.textContent = 'Szybkość transferu dysku (odczyt — ciągła, zapis — przerywana)';
        s2.textContent = fmt.size(max) + '/s';
        drawGraph(v.second, [{ data: k.read, color: it.color }, { data: k.write, color: it.color, dashed: true, fill: false }], max);
        v.stats.replaceChildren(
          h('div', { class: 'tm-scol' },
            h('div', { class: 'tm-srow' }, stat('Czas aktywności', pct(d.active), true)),
            h('div', { class: 'tm-srow' }, stat('Szybkość odczytu', rate(d.readRate), true), stat('Szybkość zapisu', rate(d.writeRate), true))),
          h('dl', { class: 'tm-kv' },
            ...kv('Pojemność', fmt.size(d.size)), ...kv('Sformatowane', d.fsTotal ? fmt.size(d.fsTotal) : '—'),
            ...kv('Zajęte', d.fsTotal ? `${fmt.size(d.used)} (${pct(d.used / d.fsTotal * 100)})` : '—'),
            ...kv('Wolne', d.fsTotal ? fmt.size(d.fsTotal - d.used) : '—'),
            ...kv('Dysk systemowy', d.system ? 'Tak' : 'Nie'), ...kv('Typ', d.type),
            ...kv('Punkty montowania', d.mounts.join(', ') || '—'), ...kv('Urządzenie', '/dev/' + d.name)));
      } else if (it.net) {
        const n = p.net.find((x) => x.iface === it.net.iface) || it.net;
        const k = hs.net[n.iface] || { rx: [], tx: [] };
        const max = niceMax([...k.rx, ...k.tx], 1250);
        model.textContent = n.iface;
        gl1.textContent = 'Przepustowość (odbieranie — ciągła, wysyłanie — przerywana)';
        gl2.textContent = bits(max);
        drawGraph(v.main, [{ data: k.rx, color: it.color }, { data: k.tx, color: it.color, dashed: true, fill: false }], max);
        v.stats.replaceChildren(
          h('div', { class: 'tm-scol' },
            h('div', { class: 'tm-srow' }, stat('Wysyłanie', bits(n.txRate), true), stat('Odbieranie', bits(n.rxRate), true)),
            h('div', { class: 'tm-srow' }, stat('Wysłano łącznie', fmt.size(n.tx), true), stat('Odebrano łącznie', fmt.size(n.rx), true))),
          h('dl', { class: 'tm-kv' },
            ...kv('Nazwa karty', n.iface), ...kv('Typ połączenia', n.type),
            ...kv('Adres IPv4', n.ipv4.join(', ') || '—'), ...kv('Adres IPv6', n.ipv6.join(', ') || '—'),
            ...kv('Adres MAC', n.mac || '—'), ...kv('Szybkość łącza', n.linkSpeed ? (n.linkSpeed >= 1000 ? dec(n.linkSpeed / 1000) + ' Gb/s' : n.linkSpeed + ' Mb/s') : '—')));
      }
    }

    function kv(k, val) { return [h('dt', {}, k), h('dd', {}, String(val))]; }

    function drawAll() {
      if (state.page === 'perf' && state.perf && views.perf) updatePerf(currentItems());
    }
    function currentItems() {
      const p = state.perf;
      return [
        { id: 'cpu', color: COLORS.cpu }, { id: 'mem', color: COLORS.mem },
        ...p.disks.map((d) => ({ id: 'disk:' + d.name, color: COLORS.disk, disk: d })),
        ...p.net.map((n) => ({ id: 'net:' + n.iface, color: COLORS.net, net: n }))
      ];
    }

    show(state.page);
    return win;
  }

  WD.apps = WD.apps || {};
  WD.apps.monitor = { name: 'Menedżer zadań', icon: 'monitor', launch };
})(window.WD);
