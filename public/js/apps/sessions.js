'use strict';
/* Sessions ("Sesje"): which computers are logged in and what each of them does. */
(function (WD) {
  const { h, api, fmt } = WD;

  const TYPE_ICON = {
    login: 'lock', logout: 'power', security: 'lock', file: 'open', delete: 'trash', upload: 'upload',
    download: 'download', command: 'terminal', terminal: 'terminal', process: 'kill', service: 'refresh',
    system: 'power', assistant: 'info', watch: 'eye'
  };
  const FILTERS = [
    ['all', 'Wszystko', null],
    ['files', 'Pliki', ['file', 'delete', 'upload', 'download']],
    ['terminal', 'Terminal', ['command', 'terminal', 'watch']],
    ['system', 'Procesy i system', ['process', 'service', 'system']],
    ['assistant', 'Asystent', ['assistant']],
    ['security', 'Logowania', ['login', 'logout', 'security']]
  ];
  const OS_ICON = {
    'Windows 10/11': 'computer', Windows: 'computer', macOS: 'computer', Linux: 'computer', ChromeOS: 'computer',
    Android: 'phone', iOS: 'phone'
  };
  const PHONE = '<svg viewBox="0 0 48 48"><rect x="14" y="4" width="20" height="40" rx="4" fill="#2b88d8"/><rect x="17" y="9" width="14" height="27" rx="1.5" fill="#9fd4ff"/><circle cx="24" cy="40" r="1.8" fill="#fff"/></svg>';

  function ago(t) {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 45) return 'przed chwilą';
    if (s < 3600) return `${Math.round(s / 60)} min temu`;
    if (s < 86400) return `${Math.round(s / 3600)} godz. temu`;
    return new Date(t).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  const time = (t) => new Date(t).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const day = (t) => new Date(t).toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' });
  const name = (s) => s.label || `${s.browser} na ${s.os}`;
  const APP_NAMES = { explorer: 'Eksplorator', terminal: 'Terminal', 'terminal-watch': 'Podgląd terminala', editor: 'Notatnik', viewer: 'Podgląd', monitor: 'Menedżer zadań', settings: 'Ustawienia', updates: 'Aktualizacje', assistant: 'Asystent', sessions: 'Sesje', logs: 'Logi' };

  // Collapses runs of similar events (e.g. 200 uploaded files) into one row.
  function group(events) {
    const out = [];
    for (const e of events) {
      const prev = out[out.length - 1];
      if (prev && e.type === 'upload' && prev.type === 'upload' && prev.sid === e.sid && prev.x && e.x && prev.x.dir === e.x.dir && prev.t - e.t < 120000) {
        prev.count = (prev.count || 1) + 1;
        prev.size = (prev.size || prev.x.size || 0) + (e.x.size || 0);
        prev.first = e.t;
        continue;
      }
      out.push({ ...e });
    }
    return out;
  }

  function launch(opts = {}) {
    const existing = WD.wm.find((w) => w.app === 'sessions');
    if (existing) { existing.focus(); return existing; }

    let list = [];
    let selected = opts.sid || 'all';
    let filter = 'all';
    let events = [];
    let oldestId = null;
    let noMore = false;
    let timer = null;
    let closed = false;

    const listEl = h('div', { class: 'ss-list' });
    const detail = h('div', { class: 'ss-detail' });
    const othersBtn = h('button', { class: 'btn', onclick: () => revokeOthers() }, 'Wyloguj wszystkie inne');
    const root = h('div', { class: 'ss' },
      h('div', { class: 'ss-side' }, h('div', { class: 'ss-sidehead' }, h('strong', {}, 'Zalogowane komputery'), othersBtn), listEl),
      detail);

    const win = WD.wm.open({ app: 'sessions', title: 'Sesje', icon: WD.appIcon('sessions'), width: 1000, height: 660, onClose: () => { closed = true; clearTimeout(timer); } });
    win.body.append(root);

    async function loadList() {
      try { list = await api.get('/api/panel/sessions'); } catch (err) { WD.error(err); }
      othersBtn.disabled = !list.some((s) => s.active && !s.current);
      renderList();
      if (selected !== 'all' && !list.find((s) => s.sid === selected)) selected = 'all';
      renderHeader();
    }

    async function loadEvents(reset) {
      const q = { limit: 150 };
      if (selected !== 'all') q.sid = selected;
      const f = FILTERS.find((x) => x[0] === filter);
      try {
        let got = await api.get('/api/panel/activity', q);
        if (f[2]) got = got.filter((e) => f[2].includes(e.type));
        if (reset) {
          events = got;
          noMore = got.length < 150 && !f[2];
        } else {
          const known = new Set(events.map((e) => e.id));
          events = [...got.filter((e) => !known.has(e.id)), ...events];
        }
        oldestId = events.length ? events[events.length - 1].id : null;
      } catch (err) { WD.error(err); }
      renderTimeline();
    }

    async function loadOlder() {
      if (!oldestId) return;
      const q = { limit: 300, before: oldestId };
      if (selected !== 'all') q.sid = selected;
      const f = FILTERS.find((x) => x[0] === filter);
      let got = await api.get('/api/panel/activity', q);
      if (got.length < 300) noMore = true;
      if (f[2]) got = got.filter((e) => f[2].includes(e.type));
      events = events.concat(got);
      oldestId = got.length ? got[got.length - 1].id : oldestId;
      if (!got.length) noMore = true;
      renderTimeline();
    }

    function sessionIcon(s) {
      return OS_ICON[s.os] === 'phone' ? PHONE : WD.appIcon('computer');
    }

    function renderList() {
      const allItem = h('div', { class: 'ss-item' + (selected === 'all' ? ' on' : ''), onclick: () => select('all') },
        h('span', { class: 'ss-ico', html: WD.appIcon('sessions') }),
        h('div', { class: 'ss-itext' }, h('div', { class: 'ss-iname' }, 'Wszystkie sesje'), h('div', { class: 'ss-isub' }, 'Wspólna oś czasu')));
      const active = list.filter((s) => s.active);
      const ended = list.filter((s) => !s.active);
      const item = (s) => h('div', { class: 'ss-item' + (selected === s.sid ? ' on' : '') + (s.active ? '' : ' ended'), onclick: () => select(s.sid) },
        h('span', { class: 'ss-ico', html: sessionIcon(s) }, h('i', { class: 'ss-dot ' + (s.online ? 'on' : s.active ? 'idle' : 'off') })),
        h('div', { class: 'ss-itext' },
          h('div', { class: 'ss-iname' }, name(s), s.current ? h('span', { class: 'ss-badge' }, 'to urządzenie') : null),
          h('div', { class: 'ss-isub' }, `${s.ip} · ${s.online ? 'online' : s.active ? 'aktywność ' + ago(s.lastSeen) : 'wylogowana'}`),
          s.online && s.windows && s.windows.length ? h('div', { class: 'ss-isub' }, 'Otwarte: ' + s.windows.map((w) => APP_NAMES[w.app] || w.app).join(', ')) : null));
      listEl.replaceChildren(...[allItem,
        h('div', { class: 'ss-group' }, `Aktywne (${active.length})`), ...active.map(item),
        ended.length ? h('div', { class: 'ss-group' }, `Zakończone (${ended.length})`) : null, ...ended.map(item)].filter(Boolean));
    }

    function select(sid) {
      selected = sid;
      events = [];
      oldestId = null;
      noMore = false;
      renderList();
      renderHeader(true);
      loadEvents(true);
    }

    let headEl = null;
    let timelineEl = null;
    function renderHeader(rebuild) {
      if (rebuild || !headEl) {
        detail.textContent = '';
        headEl = h('div', { class: 'ss-head' });
        const chips = h('div', { class: 'tm-filters ss-filters' }, ...FILTERS.map(([id, label]) => h('button', { class: 'tm-chip' + (filter === id ? ' on' : ''), 'data-id': id, onclick: () => { filter = id; for (const c of chips.children) c.classList.toggle('on', c.dataset.id === id); loadEvents(true); } }, label)));
        timelineEl = h('div', { class: 'ss-timeline' });
        detail.append(headEl, h('div', { class: 'ss-tlhead' }, h('strong', {}, 'Aktywność'), chips), timelineEl);
      }
      const s = list.find((x) => x.sid === selected);
      if (!s) {
        const online = list.filter((x) => x.online).length;
        headEl.replaceChildren(h('div', { class: 'ss-title' }, h('span', { class: 'ss-bigico', html: WD.appIcon('sessions') }),
          h('div', {}, h('h2', {}, 'Wszystkie sesje'), h('div', { class: 'tm-dim' }, `Online: ${online} · aktywne: ${list.filter((x) => x.active).length}. Kliknij sesję po lewej, aby zobaczyć tylko jej działania.`))));
        return;
      }
      const labelBtn = h('button', { class: 'tbtn', title: 'Nazwij to urządzenie, np. „Laptop w domu”', html: WD.glyph('rename'), onclick: async () => {
        const v = await WD.prompt('Nazwa sesji', 'Nazwa urządzenia (np. „Laptop w domu”):', s.label || '');
        if (v == null) return;
        await api.post('/api/panel/label', { sid: s.sid, label: v });
        loadList();
      } });
      const rows = [
        ['Stan', s.online ? 'Online – strona panelu jest otwarta' : s.active ? 'Zalogowana, strona zamknięta' : `Wylogowana${s.revokeReason ? ' (' + s.revokeReason + ')' : ''}`],
        ['Adres IP', s.ip],
        ['Przeglądarka', `${s.browser} na ${s.os}${s.screen ? ' · ekran ' + s.screen : ''}`],
        ['Zalogowano', new Date(s.created).toLocaleString('pl-PL')],
        ['Ostatnia aktywność', ago(s.lastSeen)]
      ];
      const windows = s.online && s.windows && s.windows.length
        ? h('div', { class: 'ss-block' }, h('div', { class: 'ss-btitle' }, 'Otwarte teraz'),
          h('div', { class: 'ss-wins' }, ...s.windows.map((w) => h('span', { class: 'ss-win' + (w.focused ? ' focused' : ''), title: w.title }, h('span', { class: 'ss-wico', html: WD.appIcon(w.app === 'terminal-watch' ? 'terminal' : w.app === 'explorer' ? 'home' : w.app) }), w.title || APP_NAMES[w.app] || w.app))))
        : null;
      const terms = s.terminals && s.terminals.length
        ? h('div', { class: 'ss-block' }, h('div', { class: 'ss-btitle' }, `Terminale (${s.terminals.length})`),
          ...s.terminals.map((t) => h('div', { class: 'ss-term' },
            h('span', { class: 'ss-wico', html: WD.appIcon('terminal') }),
            h('div', { class: 'ss-ttext' }, h('div', {}, `Otwarty ${ago(t.started)} w ${t.cwd}`),
              h('div', { class: 'tm-dim' }, t.fullscreen ? 'Działa program pełnoekranowy' : t.lastCommand ? `Ostatnie polecenie: ${t.lastCommand}` : 'Brak poleceń', t.watchers ? ` · oglądających: ${t.watchers}` : '')),
            h('button', { class: 'btn primary', onclick: () => WD.apps.terminal.launch({ watch: t.id, title: name(s) }) }, 'Podgląd na żywo'),
            s.current ? null : h('button', { class: 'btn', onclick: () => killTerminal(t) }, 'Zamknij'))))
        : null;
      headEl.replaceChildren(
        h('div', { class: 'ss-title' }, h('span', { class: 'ss-bigico', html: sessionIcon(s) }),
          h('div', { class: 'ss-tt' }, h('h2', {}, name(s), labelBtn), h('div', { class: 'tm-dim' }, s.current ? 'To jest sesja, z której teraz korzystasz' : `${s.browser} · ${s.ip}`)),
          s.active ? h('button', { class: 'btn danger', onclick: () => revoke(s) }, s.current ? 'Wyloguj mnie' : 'Wyloguj tę sesję') : null),
        h('dl', { class: 'props ss-props' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
        ...[windows, terms].filter(Boolean));
    }

    function renderTimeline() {
      if (!timelineEl) return;
      const showWho = selected === 'all';
      const rows = [];
      let lastDay = '';
      for (const e of group(events)) {
        const d = day(e.t);
        if (d !== lastDay) { rows.push(h('div', { class: 'ss-day' }, d)); lastDay = d; }
        const who = list.find((s) => s.sid === e.sid);
        const text = e.count ? `Wysłano ${e.count} plików do ${e.x.dir} (${fmt.size(e.size)})` : e.text;
        rows.push(h('div', { class: 'ss-ev ss-' + e.type },
          h('span', { class: 'ss-time' }, time(e.t)),
          h('span', { class: 'ss-evico', html: WD.glyph(TYPE_ICON[e.type] || 'info') }),
          h('div', { class: 'ss-evtext' },
            e.type === 'command' ? h('code', {}, text) : h('span', {}, text),
            showWho ? h('span', { class: 'ss-who', onclick: () => who && select(who.sid) }, who ? name(who) : 'bez sesji (np. nieudane logowanie)') : null)));
      }
      if (!rows.length) rows.push(h('div', { class: 'tm-empty' }, 'Brak zarejestrowanej aktywności'));
      if (!noMore && events.length) rows.push(h('button', { class: 'btn ss-more', onclick: loadOlder }, 'Pokaż starsze'));
      const atTop = timelineEl.scrollTop < 10;
      const prevH = timelineEl.scrollHeight;
      const prevTop = timelineEl.scrollTop;
      timelineEl.replaceChildren(...rows);
      if (!atTop) timelineEl.scrollTop = prevTop + (timelineEl.scrollHeight - prevH);
    }

    async function revoke(s) {
      const msg = s.current
        ? 'Wylogować tę sesję (czyli Ciebie)? Trzeba będzie zalogować się ponownie.'
        : `Wylogować sesję „${name(s)}” (${s.ip})? Jej terminale zostaną zamknięte, a strona panelu na tamtym komputerze od razu przejdzie do ekranu logowania.`;
      if (!(await WD.confirm('Wyloguj sesję', msg, { okLabel: 'Wyloguj', danger: true }))) return;
      try {
        await api.post('/api/panel/revoke', { sid: s.sid });
        WD.toast('Sesja została wylogowana', 'ok');
        loadList();
        loadEvents(false);
      } catch (err) { WD.error(err); }
    }

    async function revokeOthers() {
      const n = list.filter((s) => s.active && !s.current).length;
      if (!(await WD.confirm('Wyloguj inne sesje', `Wylogować wszystkie pozostałe sesje (${n})? Zostaniesz zalogowany tylko na tym komputerze.`, { okLabel: 'Wyloguj wszystkie', danger: true }))) return;
      try {
        const r = await api.post('/api/panel/revoke-others');
        WD.toast(`Wylogowano sesje: ${r.revoked}`, 'ok');
        loadList();
        loadEvents(false);
      } catch (err) { WD.error(err); }
    }

    async function killTerminal(t) {
      if (!(await WD.confirm('Zamknij terminal', `Zamknąć terminal w ${t.cwd}? Działające w nim programy zostaną przerwane.`, { okLabel: 'Zamknij', danger: true }))) return;
      try { await api.post('/api/panel/terminal/kill', { id: t.id }); loadList(); } catch (err) { WD.error(err); }
    }

    async function tick() {
      if (closed) return;
      await Promise.all([loadList(), loadEvents(false)]);
      timer = setTimeout(tick, 3000);
    }

    renderHeader(true);
    loadEvents(true);
    tick();
    return win;
  }

  WD.apps = WD.apps || {};
  WD.apps.sessions = { name: 'Sesje', icon: 'sessions', launch };
})(window.WD);
