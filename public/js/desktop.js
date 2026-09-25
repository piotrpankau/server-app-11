'use strict';
/* Desktop: icons (shortcuts + files from ~/Desktop), start menu, taskbar clock. */
(function (WD) {
  const { h, api, path: P } = WD;

  const shortcuts = () => [
    { name: 'Ten komputer', icon: 'computer', open: () => WD.apps.explorer.launch({ path: WD.info.root || '/' }), dir: WD.info.root || '/' },
    { name: 'Folder domowy', icon: 'home', open: () => WD.apps.explorer.launch({ path: WD.info.home }), dir: WD.info.home },
    { name: 'Terminal', icon: 'terminal', open: () => WD.apps.terminal.launch({}) },
    { name: 'Asystent Claude', icon: 'assistant', open: () => WD.apps.assistant.launch() },
    { name: 'Menedżer zadań', icon: 'monitor', open: () => WD.apps.monitor.launch() },
    { name: 'Notatnik', icon: 'editor', open: () => WD.apps.editor.launch({}) },
    { name: 'Ustawienia', icon: 'settings', open: () => WD.apps.settings.launch() }
  ];

  let deskEntries = [];
  let selected = new Set();

  async function init() {
    try {
      WD.info = await api.get('/api/info');
    } catch (err) {
      document.body.textContent = 'Nie można połączyć się z serwerem: ' + err.message;
      return;
    }
    WD.fillIcons();
    WD.applyAppearance();
    document.title = `WebPulpit — ${WD.info.hostname}`;
    setupStart();
    setupClock();
    setupDesktop();
    await loadDesktop();
    WD.on('fs-changed', (dirs) => { if (dirs.has(WD.info.desktop)) loadDesktop(); });
    WD.on('clipboard', renderDesktop);

    // Never let the browser open a file dropped outside a drop zone.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    setTimeout(() => WD.backgroundUpdateCheck(), 4000);
    setupLive();

    if (WD.settings.get('firstRun', true)) {
      WD.settings.set('firstRun', false);
      WD.toast('Witaj! Przeciągnij pliki z komputera na pulpit albo do okna Eksploratora, aby je wysłać na serwer.', '', 8000);
    }
  }

  // ---------- Desktop icons ----------
  async function loadDesktop() {
    try {
      const data = await api.get('/api/list', { path: WD.info.desktop });
      deskEntries = data.entries.filter((e) => !e.name.startsWith('.'));
    } catch {
      deskEntries = [];
    }
    renderDesktop();
  }

  function renderDesktop() {
    const wrap = document.getElementById('desktop-icons');
    wrap.textContent = '';
    for (const s of shortcuts()) {
      const el = h('div', { class: 'desk-icon', title: s.name }, h('span', { class: 'ico', html: WD.appIcon(s.icon) }), h('span', { class: 'label' }, s.name));
      el.addEventListener('pointerdown', (e) => { if (e.button === 0) select(el, 'sc:' + s.name, e); });
      el.addEventListener('dblclick', s.open);
      el.addEventListener('click', (e) => { if (lastPointer === 'touch') s.open(e); });
      el.dataset.key = 'sc:' + s.name;
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        WD.contextMenu(e.clientX, e.clientY, [
          { label: 'Otwórz', icon: 'open', action: s.open },
          s.dir ? { label: 'Otwórz w terminalu', icon: 'terminal', action: () => WD.apps.terminal.launch({ cwd: s.dir }) } : null,
          s.dir && WD.clipboard.mode ? { label: 'Wklej tutaj', icon: 'paste', action: () => WD.fileOps.paste(s.dir) } : null
        ]);
      });
      if (s.dir) dropTarget(el, () => s.dir);
      wrap.append(el);
    }
    const coll = new Intl.Collator('pl', { numeric: true, sensitivity: 'base' });
    const sorted = deskEntries.slice().sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : coll.compare(a.name, b.name)));
    for (const en of sorted) {
      const full = P.join(WD.info.desktop, en.name);
      const icon = WD.fileType(en) === 'image' && en.size < 25 * 1024 * 1024
        ? h('span', { class: 'ico' }, h('img', { src: api.rawUrl(full), alt: '', loading: 'lazy', draggable: 'false', style: { objectFit: 'cover', borderRadius: '3px' } }))
        : h('span', { class: 'ico', html: WD.entryIcon(en) });
      const el = h('div', { class: 'desk-icon', title: en.name, draggable: 'true' }, icon, h('span', { class: 'label' }, en.name));
      el.dataset.key = 'f:' + en.name;
      if (WD.clipboard.mode === 'cut' && WD.clipboard.paths.includes(full)) el.style.opacity = '0.5';
      el.addEventListener('pointerdown', (e) => { if (e.button === 0) select(el, el.dataset.key, e); });
      el.addEventListener('dblclick', () => WD.fileOps.open(full, en));
      el.addEventListener('click', () => { if (lastPointer === 'touch') WD.fileOps.open(full, en); });
      el.addEventListener('dragstart', (e) => {
        if (!selected.has(el.dataset.key)) { selected = new Set([el.dataset.key]); paint(); }
        const files = selectedFiles();
        WD.fileOps.dragStart(e, files.map((f) => f.path), files.map((f) => f.entry));
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!selected.has(el.dataset.key)) { selected = new Set([el.dataset.key]); paint(); }
        const files = selectedFiles();
        WD.contextMenu(e.clientX, e.clientY, WD.fileOps.itemMenu(files.map((f) => f.path), files.map((f) => f.entry)));
      });
      if (en.type === 'dir') dropTarget(el, () => full);
      wrap.append(el);
    }
    paint();
  }

  let lastPointer = 'mouse';
  function select(el, key, e) {
    lastPointer = e.pointerType;
    if (e.ctrlKey || e.metaKey) {
      if (selected.has(key)) selected.delete(key); else selected.add(key);
    } else if (!selected.has(key)) {
      selected = new Set([key]);
    }
    paint();
  }

  function paint() {
    for (const el of document.querySelectorAll('.desk-icon')) el.classList.toggle('selected', selected.has(el.dataset.key));
  }

  function selectedFiles() {
    return [...selected].filter((k) => k.startsWith('f:')).map((k) => {
      const name = k.slice(2);
      return { path: P.join(WD.info.desktop, name), entry: deskEntries.find((e) => e.name === name) || { name, type: 'file' } };
    });
  }

  function dropTarget(el, getDir) {
    el.addEventListener('dragover', (e) => {
      if (!WD.fileOps.canDrop(e)) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('drop-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-over'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop-over');
      if (!WD.fileOps.canDrop(e)) return;
      e.preventDefault();
      e.stopPropagation();
      document.getElementById('desktop').classList.remove('drop-target');
      WD.fileOps.handleDrop(e, getDir());
    });
  }

  function setupDesktop() {
    const desk = document.getElementById('desktop');
    const icons = document.getElementById('desktop-icons');
    const onBackground = (e) => e.target === desk || e.target === icons;

    desk.addEventListener('pointerdown', (e) => {
      if (onBackground(e)) { selected.clear(); paint(); }
      closeStart();
    });
    desk.addEventListener('contextmenu', (e) => {
      if (!onBackground(e)) return;
      e.preventDefault();
      WD.contextMenu(e.clientX, e.clientY, WD.fileOps.backgroundMenu(WD.info.desktop, [
        { label: 'Odśwież', icon: 'refresh', action: loadDesktop },
        { label: 'Otwórz folder Pulpit', icon: 'open', action: () => WD.apps.explorer.launch({ path: WD.info.desktop }) },
        '-'
      ]).concat(['-', { label: 'Ustawienia (tapeta, motyw)', icon: 'info', action: () => WD.apps.settings.launch() }]));
    });

    // Dropping files on the desktop background uploads them to ~/Desktop.
    let depth = 0;
    const isBg = (e) => !e.target.closest('.window');
    desk.addEventListener('dragenter', (e) => {
      if (!isBg(e) || !WD.fileOps.canDrop(e)) return;
      depth++;
      desk.classList.add('drop-target');
    });
    desk.addEventListener('dragleave', (e) => {
      if (!isBg(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) desk.classList.remove('drop-target');
    });
    desk.addEventListener('dragover', (e) => {
      if (!isBg(e) || !WD.fileOps.canDrop(e)) return;
      e.preventDefault();
    });
    desk.addEventListener('drop', (e) => {
      depth = 0;
      desk.classList.remove('drop-target');
      if (!isBg(e) || !WD.fileOps.canDrop(e)) return;
      e.preventDefault();
      WD.fileOps.handleDrop(e, WD.info.desktop);
    });
    // Windows cover parts of the desktop: clear the highlight when the drag enters one.
    document.addEventListener('dragenter', (e) => {
      if (e.target.closest && e.target.closest('.window')) { depth = 0; desk.classList.remove('drop-target'); }
    });

    document.addEventListener('keydown', (e) => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const files = selectedFiles();
      if (e.key === 'Delete' && files.length) WD.fileOps.remove(files.map((f) => f.path));
      if (e.key === 'F2' && files.length === 1) WD.fileOps.rename(files[0].path);
      if (e.key === 'Enter' && files.length === 1) WD.fileOps.open(files[0].path, files[0].entry);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && files.length) WD.setClipboard('copy', files.map((f) => f.path));
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x' && files.length) WD.setClipboard('cut', files.map((f) => f.path));
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') WD.fileOps.paste(WD.info.desktop);
    });
  }

  // ---------- Start menu ----------
  function startApps() {
    return [
      { name: 'Eksplorator plików', icon: 'home', open: () => WD.apps.explorer.launch({ path: WD.info.home }) },
      { name: 'Ten komputer', icon: 'computer', open: () => WD.apps.explorer.launch({ path: WD.info.root || '/' }) },
      { name: 'Pulpit', icon: 'desktopfolder', open: () => WD.apps.explorer.launch({ path: WD.info.desktop }) },
      { name: 'Terminal', icon: 'terminal', open: () => WD.apps.terminal.launch({}) },
      { name: 'Asystent Claude', icon: 'assistant', open: () => WD.apps.assistant.launch() },
      { name: 'Notatnik', icon: 'editor', open: () => WD.apps.editor.launch({}) },
      { name: 'Menedżer zadań', icon: 'monitor', open: () => WD.apps.monitor.launch() },
      { name: 'Ustawienia', icon: 'settings', open: () => WD.apps.settings.launch() },
      { name: 'Sesje', icon: 'sessions', open: () => WD.apps.sessions.launch() },
      { name: 'Aktualizacje', icon: 'updates', open: () => WD.apps.updates.launch() },
      { name: 'Wyślij pliki', icon: 'upload', open: () => WD.pickAndUpload(WD.info.desktop, false) }
    ];
  }

  function closeStart() {
    document.getElementById('start-menu').hidden = true;
    document.getElementById('start-btn').classList.remove('active');
  }

  function setupStart() {
    const menu = document.getElementById('start-menu');
    const btn = document.getElementById('start-btn');
    const search = document.getElementById('start-search');
    const appsEl = document.getElementById('start-apps');
    document.getElementById('start-username').textContent = `${WD.info.username} @ ${WD.info.hostname}`;
    document.getElementById('start-avatar').textContent = (WD.info.username || '?')[0];

    const render = () => {
      const q = search.value.trim().toLowerCase();
      appsEl.textContent = '';
      for (const a of startApps().filter((x) => !q || x.name.toLowerCase().includes(q))) {
        appsEl.append(h('button', {
          class: 'start-app',
          onclick: () => { closeStart(); a.open(); }
        }, h('span', { class: 'ico', html: a.icon === 'upload' ? WD.glyph('upload') : WD.appIcon(a.icon) }), a.name));
      }
    };
    search.addEventListener('input', render);
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const first = appsEl.querySelector('.start-app'); if (first) first.click(); }
      if (e.key === 'Escape') closeStart();
    });
    btn.addEventListener('click', () => {
      if (!menu.hidden) return closeStart();
      menu.hidden = false;
      btn.classList.add('active');
      search.value = '';
      render();
      search.focus();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) closeStart();
    });
    document.getElementById('logout-btn').addEventListener('click', async () => {
      try { await api.post('/api/logout'); } catch { /* ignore */ }
      location.href = '/login';
    });
  }

  // ---------- Live session features ----------
  // Server-Sent Events: new logins elsewhere, remote logout, someone watching our terminal.
  // The page also reports its open windows so other sessions can see what it is doing.
  function setupLive() {
    const tray = document.getElementById('sessions-tray');
    tray.addEventListener('click', () => WD.apps.sessions.launch());
    const refreshTray = async () => {
      try {
        const list = await api.get('/api/panel/sessions');
        const others = list.filter((s) => s.online && !s.current);
        tray.hidden = !others.length;
        tray.querySelector('.count').textContent = String(others.length);
        tray.title = others.length
          ? 'Inne zalogowane teraz komputery:\n' + others.map((s) => `${s.label || s.browser + ' na ' + s.os} (${s.ip})`).join('\n')
          : '';
      } catch { /* ignore */ }
    };
    refreshTray();
    setInterval(refreshTray, 20000);

    let es = null;
    const connect = () => {
      es = new EventSource('/api/events');
      es.addEventListener('login', (e) => {
        const d = JSON.parse(e.data);
        WD.toast(h('span', {}, `Nowe logowanie: ${d.browser} na ${d.os} (${d.ip}). `,
          h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); WD.apps.sessions.launch({ sid: d.sid }); } }, 'Pokaż sesje')), '', 10000);
        setTimeout(refreshTray, 1500);
      });
      es.addEventListener('revoked', (e) => {
        const d = JSON.parse(e.data);
        es.close();
        WD.alert('Wylogowano', `Ta sesja została wylogowana${d.reason ? ' (' + d.reason + ')' : ''}.`).then(() => { location.href = '/login'; });
        setTimeout(() => { location.href = '/login'; }, 8000);
      });
      es.addEventListener('watched', (e) => {
        const d = JSON.parse(e.data);
        WD.toast(d.on ? `Sesja „${d.by}” ogląda na żywo Twój terminal` : `Sesja „${d.by}” zakończyła podgląd Twojego terminala`, d.on ? 'error' : '', 6000);
      });
      es.onerror = () => {
        // Session expired or server restarting: EventSource reconnects by itself;
        // make sure we are still logged in.
        api.get('/api/info').catch(() => {});
      };
    };
    connect();

    let stateTimer = null;
    const brave = navigator.brave && typeof navigator.brave.isBrave === 'function';
    const report = () => {
      clearTimeout(stateTimer);
      stateTimer = setTimeout(() => {
        const focused = WD.wm.focused();
        api.post('/api/panel/state', {
          browser: brave ? 'Brave' : undefined,
          screen: `${window.screen.width}×${window.screen.height}`,
          windows: WD.wm.windows.map((w) => ({ app: w.app, title: w.titleEl.textContent, focused: w === focused }))
        }).catch(() => {});
      }, 800);
    };
    WD.on('windows-changed', report);
    report();
  }

  // ---------- Clock ----------
  function setupClock() {
    const el = document.getElementById('clock');
    const tick = () => {
      const d = new Date();
      el.querySelector('.time').textContent = d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
      el.querySelector('.date').textContent = d.toLocaleDateString('pl-PL');
      el.title = d.toLocaleDateString('pl-PL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    };
    tick();
    setInterval(tick, 10000);
    el.addEventListener('click', () => WD.apps.monitor.launch());
  }

  document.addEventListener('DOMContentLoaded', init);
})(window.WD);
