'use strict';
/* Game servers ("Serwery gier"): create and run dedicated game servers, like a
   little game-hosting panel. List on the left, selected server on the right with
   status, live console, settings, config files and backups. */
(function (WD) {
  const { h, api, fmt } = WD;

  const STEAM_HINT = 'Pierwsza instalacja pobiera kilka GB i może potrwać kilkanaście minut.';

  function launch(opts = {}) {
    const existing = WD.wm.find((w) => w.app === 'games');
    if (existing) { existing.focus(); return existing; }

    let templates = [];
    let list = [];
    let selId = opts.id || null;
    let statusMap = {};
    let tab = 'console';
    let timer = null;
    let closed = false;
    let term = null;
    let termWs = null;
    let termId = null;

    const listEl = h('div', { class: 'gm-list' });
    const detail = h('div', { class: 'gm-detail' });
    const side = h('div', { class: 'gm-side' },
      h('button', { class: 'btn primary gm-new', onclick: () => createWizard() }, '+ Nowy serwer'),
      listEl);
    const root = h('div', { class: 'gm' }, side, detail);

    const win = WD.wm.open({
      app: 'games', title: 'Serwery gier', icon: WD.appIcon('games'), width: 1040, height: 700,
      onResize: () => { if (term && term.fit) try { term.fit.fit(); } catch { /* not visible */ } },
      onClose: () => { closed = true; clearTimeout(timer); disposeTerm(); }
    });
    win.body.append(root);

    async function loadAll() {
      try {
        if (!templates.length) templates = await api.get('/api/games/templates');
        list = await api.get('/api/games');
      } catch (err) { return WD.error(err); }
      if (!selId && list.length) selId = list[0].id;
      renderList();
      renderDetail();
    }

    function renderList() {
      listEl.replaceChildren(...list.map((g) => {
        const st = statusMap[g.id] || {};
        const dot = st.installing ? 'idle' : st.running ? 'on' : 'off';
        return h('div', { class: 'gm-item' + (g.id === selId ? ' on' : ''), onclick: () => select(g.id) },
          h('span', { class: 'gm-ico', style: { background: g.icon } }, h('span', { class: 'ss-dot ' + dot })),
          h('div', { class: 'gm-itext' }, h('div', { class: 'gm-iname' }, g.name), h('div', { class: 'gm-isub' }, g.templateLabel + (st.installing ? ' · instalacja…' : st.running ? ' · działa' : ' · zatrzymany'))));
      }));
      if (!list.length) listEl.append(h('div', { class: 'gm-empty2' }, 'Brak serwerów. Kliknij „Nowy serwer”.'));
    }

    function select(id) {
      if (id === selId) return;
      disposeTerm();
      selId = id;
      tab = 'console';
      renderList();
      renderDetail();
    }

    const cur = () => list.find((g) => g.id === selId);

    function renderDetail() {
      const g = cur();
      if (!g) { detail.replaceChildren(h('div', { class: 'gm-welcome' }, h('div', { class: 'gm-logo', html: WD.appIcon('games') }), h('h2', {}, 'Twoje serwery gier'), h('p', { class: 'as-sub' }, 'Postaw serwer Valheim, CS2, Minecraft i innych gier – kilkoma kliknięciami. Kliknij „Nowy serwer”.'))); return; }
      const st = statusMap[g.id] || {};
      const running = st.running;
      const btn = (label, icon, fn, cls) => h('button', { class: 'btn ' + (cls || ''), onclick: fn, disabled: st.installing }, icon ? h('span', { html: WD.glyph(icon), style: { display: 'inline-flex', width: '15px', marginRight: '6px', verticalAlign: '-2px' } }) : null, label);
      const statusPill = h('span', { class: 'gm-pill ' + (st.installing ? 'inst' : running ? 'run' : 'stop') },
        st.installing ? 'Instalacja…' : running ? 'Działa' : g.installed ? 'Zatrzymany' : 'Nie zainstalowany');
      const actions = h('div', { class: 'gm-actions' },
        running ? btn('Zatrzymaj', 'close', () => act('stop'), 'danger') : btn('Uruchom', 'forward', () => act('start'), 'primary'),
        btn('Restart', 'refresh', () => act('restart')),
        btn(g.installed ? 'Aktualizuj' : 'Zainstaluj', 'download', () => doInstall()));
      const ports = (st.ports && st.ports.length) ? st.ports.join(', ') : (g.ports && g.ports.length ? g.ports.join(', ') : '—');

      const tabs = h('div', { class: 'gm-tabs' }, ...[
        ['console', 'Konsola'], ['settings', 'Ustawienia'],
        ...(templates.find((t) => t.id === g.template) && hasConfig(g) ? [['config', 'Pliki konfiguracyjne']] : []),
        ['backups', 'Kopie zapasowe']
      ].map(([id, label]) => h('button', { class: 'gm-tab' + (tab === id ? ' on' : ''), onclick: () => { if (tab !== id) { disposeTerm(); tab = id; renderDetail(); } } }, label)));

      const pane = h('div', { class: 'gm-pane' });
      detail.replaceChildren(
        h('div', { class: 'gm-head' },
          h('span', { class: 'gm-bigico', style: { background: g.icon }, html: '<svg viewBox="0 0 48 48">' + WD.appIcon('games').replace(/^<svg[^>]*>|<\/svg>$/g, '') + '</svg>' }),
          h('div', { class: 'gm-htext' }, h('h2', {}, g.name), h('div', { class: 'gm-hsub' }, g.templateLabel, ' · porty: ', ports, st.size ? ' · ' + fmt.size(st.size) : '')),
          statusPill),
        actions, tabs, pane);
      renderPane(pane, g, st);
    }

    const hasConfig = (g) => { const t = templates.find((x) => x.id === g.template); return t && (g.template === 'minecraft'); };

    function renderPane(pane, g, st) {
      if (tab === 'console') return renderConsole(pane, g, st);
      if (tab === 'settings') return renderSettings(pane, g);
      if (tab === 'config') return renderConfig(pane, g);
      if (tab === 'backups') return renderBackups(pane, g);
    }

    // ----- console -----
    function renderConsole(pane, g, st) {
      if (st.installing) {
        const log = h('pre', { class: 'gm-log' }, 'Wczytywanie logu instalacji…');
        pane.replaceChildren(h('div', { class: 'gm-instbar' }, h('span', {}, 'Trwa instalacja / aktualizacja. ' + STEAM_HINT)), log);
        pollJob(g.id, log);
        return;
      }
      if (!g.installed) {
        pane.replaceChildren(h('div', { class: 'gm-welcome' },
          h('p', {}, 'Ten serwer nie jest jeszcze zainstalowany.'),
          h('button', { class: 'btn primary', onclick: () => doInstall() }, 'Zainstaluj teraz')));
        return;
      }
      const wrap = h('div', { class: 'term-wrap gm-term' });
      const input = h('input', { class: 'field gm-cmd', placeholder: running(g) ? 'Wpisz komendę serwera i naciśnij Enter…' : 'Serwer zatrzymany', disabled: !running(g) });
      pane.replaceChildren(wrap, h('div', { class: 'gm-cmdrow' }, input));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.value.trim()) {
          api.post(`/api/games/${g.id}/command`, { command: input.value }).catch(WD.error);
          input.value = '';
        }
      });
      openTerm(g.id, wrap);
    }
    const running = (g) => (statusMap[g.id] || {}).running;

    function openTerm(id, wrap) {
      disposeTerm();
      termId = id;
      term = new window.Terminal({ fontFamily: '"Cascadia Mono","Ubuntu Mono",Menlo,Consolas,monospace', fontSize: 13, scrollback: 4000, convertEol: true, theme: { background: '#0c0c0c', foreground: '#cccccc' } });
      const fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      term.fit = fit;
      term.open(wrap);
      requestAnimationFrame(() => { try { fit.fit(); } catch { /* not visible */ } });
      termWs = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/game?id=${encodeURIComponent(id)}`);
      termWs.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
      termWs.onopen = () => { try { fit.fit(); } catch { /* ignore */ } termWs.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows })); };
      termWs.onclose = () => { if (term && termId === id) term.write('\r\n\x1b[90m[Konsola rozłączona]\x1b[0m\r\n'); };
      term.onData((d) => { if (termWs && termWs.readyState === WebSocket.OPEN) termWs.send(JSON.stringify({ t: 'i', d })); });
    }
    function disposeTerm() {
      if (termWs) { try { termWs.close(); } catch { /* ignore */ } termWs = null; }
      if (term) { try { term.dispose(); } catch { /* ignore */ } term = null; }
      termId = null;
    }

    async function pollJob(id, log) {
      if (closed || selId !== id) return;
      try {
        const j = await api.get(`/api/games/${id}/job`);
        log.textContent = j.log || '(brak logu)';
        log.scrollTop = log.scrollHeight;
        if (!j.running) { setTimeout(() => refreshStatus(true), 500); return; }
      } catch { /* ignore */ }
      setTimeout(() => pollJob(id, log), 1500);
    }

    // ----- settings -----
    function renderSettings(pane, g) {
      const t = templates.find((x) => x.id === g.template);
      const fields = [];
      const nameI = h('input', { class: 'field', value: g.name });
      fields.push(h('label', {}, 'Nazwa serwera w panelu'), nameI);
      const inputs = {};
      for (const f of (t ? t.settings : [])) {
        let inp;
        if (f.type === 'bool') { inp = h('input', { type: 'checkbox', checked: g.settings[f.key] !== false && g.settings[f.key] !== 'false' }); fields.push(h('label', { class: 'tm-radio' }, inp, ' ' + f.label)); }
        else { inp = h('input', { class: 'field', type: f.type === 'password' ? 'text' : (f.type === 'number' ? 'number' : 'text'), value: g.settings[f.key] != null ? g.settings[f.key] : '' }); fields.push(h('label', {}, f.label), inp); }
        inputs[f.key] = inp;
      }
      const autoI = h('input', { type: 'checkbox', checked: g.autostart });
      fields.push(h('label', { class: 'tm-radio', title: 'Uruchamiaj automatycznie po restarcie serwera' }, autoI, ' Uruchamiaj automatycznie po restarcie serwera'));
      const save = h('button', { class: 'btn primary', onclick: async () => {
        const payload = { name: nameI.value, autostart: autoI.checked };
        for (const [k, inp] of Object.entries(inputs)) payload[k] = inp.type === 'checkbox' ? inp.checked : inp.value;
        try { await api.post(`/api/games/${g.id}/settings`, payload); WD.toast('Zapisano. Zmiany zadziałają po restarcie serwera.', 'ok'); loadAll(); } catch (err) { WD.error(err); }
      } }, 'Zapisz ustawienia');
      const del = h('button', { class: 'btn danger', onclick: () => removeServer(g) }, 'Usuń serwer');
      pane.replaceChildren(h('div', { class: 'gm-form' }, ...fields, h('div', { class: 'gm-formbtns' }, save, del)));
    }

    // ----- config files -----
    async function renderConfig(pane, g) {
      pane.replaceChildren(h('div', { class: 'gm-welcome' }, 'Wczytywanie…'));
      let cfg;
      try { cfg = await api.get(`/api/games/${g.id}/config`); } catch (err) { return WD.error(err); }
      if (!cfg.files.length) { pane.replaceChildren(h('div', { class: 'gm-welcome' }, 'Ten serwer nie ma plików konfiguracyjnych do edycji.')); return; }
      const sel = h('select', { class: 'field', style: { maxWidth: '260px' } }, ...cfg.files.map((f) => h('option', { value: f.path }, f.label)));
      const ta = h('textarea', { class: 'gm-configta', spellcheck: 'false' });
      const load = async () => { try { ta.value = await api.get(`/api/games/${g.id}/config/file`, { name: sel.value }); } catch (err) { WD.error(err); } };
      sel.addEventListener('change', load);
      const save = h('button', { class: 'btn primary', onclick: async () => { try { await api.post(`/api/games/${g.id}/config/file`, { name: sel.value, content: ta.value }); WD.toast('Zapisano', 'ok'); } catch (err) { WD.error(err); } } }, 'Zapisz plik');
      pane.replaceChildren(h('div', { class: 'gm-confhead' }, sel, save), ta);
      load();
    }

    // ----- backups -----
    async function renderBackups(pane, g) {
      pane.replaceChildren(h('div', { class: 'gm-welcome' }, 'Wczytywanie…'));
      let backups = [];
      try { backups = await api.get(`/api/games/${g.id}/backups`); } catch (err) { return WD.error(err); }
      const make = h('button', { class: 'btn primary', onclick: async () => {
        make.disabled = true; make.textContent = 'Tworzenie…';
        try { await api.post(`/api/games/${g.id}/backup`); WD.toast('Utworzono kopię', 'ok'); renderBackups(pane, g); } catch (err) { WD.error(err); make.disabled = false; make.textContent = 'Utwórz kopię teraz'; }
      } }, 'Utwórz kopię teraz');
      const rows = backups.map((b) => h('div', { class: 'gm-bk' },
        h('span', { html: WD.glyph('zip'), class: 'gm-bkico' }),
        h('div', { class: 'gm-bktext' }, h('div', {}, b.name), h('div', { class: 'tm-dim' }, fmt.size(b.size) + ' · ' + fmt.date(b.mtime))),
        h('a', { class: 'tbtn', href: `/api/games/${g.id}/backup/download?name=${encodeURIComponent(b.name)}`, title: 'Pobierz', html: WD.glyph('download') }),
        h('button', { class: 'tbtn', title: 'Usuń', html: WD.glyph('trash'), onclick: async () => { if (await WD.confirm('Usuń kopię', `Usunąć „${b.name}”?`, { okLabel: 'Usuń', danger: true })) { await api.post(`/api/games/${g.id}/backup/delete`, { name: b.name }); renderBackups(pane, g); } } })));
      pane.replaceChildren(
        h('div', { class: 'gm-confhead' }, make, h('span', { class: 'tm-dim' }, 'Kopia zapisuje świat / dane serwera do pliku .tar.gz.')),
        rows.length ? h('div', { class: 'gm-bklist' }, ...rows) : h('div', { class: 'gm-welcome' }, 'Brak kopii zapasowych.'));
    }

    // ----- actions -----
    async function act(action) {
      const g = cur();
      if (!g) return;
      try { await api.post(`/api/games/${g.id}/${action}`); setTimeout(() => refreshStatus(true), 400); } catch (err) { WD.error(err); }
    }
    async function doInstall() {
      const g = cur();
      if (!g) return;
      if (running(g) && !(await WD.confirm('Aktualizacja', 'Serwer działa. Zatrzymać go i zaktualizować?', { okLabel: 'Zatrzymaj i aktualizuj' }))) return;
      try { if (running(g)) await api.post(`/api/games/${g.id}/stop`); await api.post(`/api/games/${g.id}/install`); tab = 'console'; await refreshStatus(true); } catch (err) { WD.error(err); }
    }
    async function removeServer(g) {
      const files = h('input', { type: 'checkbox' });
      const v = await WD.dialog({ title: 'Usuń serwer', body: h('div', {}, `Usunąć serwer „${g.name}”?`, h('label', { class: 'tm-radio', style: { marginTop: '10px' } }, files, ' Usuń także wszystkie pliki serwera (świat, zapisy) z dysku')), buttons: [{ label: 'Usuń serwer', value: 'ok', kind: 'danger' }, { label: 'Anuluj', value: null }] });
      if (v !== 'ok') return;
      try { await api.post(`/api/games/${g.id}/delete`, { files: files.checked }); disposeTerm(); selId = null; WD.toast('Usunięto serwer', 'ok'); loadAll(); } catch (err) { WD.error(err); }
    }

    // ----- create wizard (pick game -> fill settings -> create) -----
    async function createWizard() {
      if (!templates.length) try { templates = await api.get('/api/games/templates'); } catch (err) { return WD.error(err); }
      const t = await pickTemplate();
      if (!t) return;
      await settingsDialog(t);
    }

    function pickTemplate() {
      return new Promise((resolve) => {
        const grid = h('div', { class: 'gm-tpls' }, ...templates.map((t) => h('button', { class: 'gm-tpl', onclick: () => { resolve(t); close(); } },
          h('span', { class: 'gm-tico', style: { background: t.icon } }, h('span', { html: WD.appIcon('games') })),
          h('span', { class: 'gm-tlabel' }, t.label),
          t.steam ? h('span', { class: 'gm-tag' }, 'Steam') : t.java ? h('span', { class: 'gm-tag' }, 'Java') : h('span', { class: 'gm-tag' }, 'własne'))));
        let close;
        WD.dialog({ title: 'Nowy serwer – wybierz grę', body: h('div', {}, grid), buttons: [{ label: 'Anuluj', value: null }], onOpen: (dlg) => { close = () => { const b = dlg.parentNode.querySelector('.d-actions .btn'); if (b) b.click(); }; } }).then(() => resolve(null));
      });
    }

    async function settingsDialog(t) {
      const nameI = h('input', { class: 'field', value: 'Mój ' + t.label, spellcheck: 'false' });
      const inputs = {};
      const fields = [h('label', {}, 'Nazwa serwera'), nameI];
      for (const f of t.settings) {
        let inp;
        if (f.type === 'bool') { inp = h('input', { type: 'checkbox', checked: f.def !== false }); fields.push(h('label', { class: 'tm-radio' }, inp, ' ' + f.label)); }
        else { inp = h('input', { class: 'field', type: f.type === 'number' ? 'number' : 'text', value: f.def != null ? f.def : '' }); fields.push(h('label', {}, f.label), inp); }
        inputs[f.key] = inp;
      }
      if (t.steam) fields.push(h('p', { class: 'tm-dim', style: { marginTop: '10px' } }, STEAM_HINT));
      const v = await WD.dialog({
        title: 'Nowy serwer: ' + t.label,
        body: h('div', {}, ...fields),
        buttons: [{ label: 'Utwórz', value: 'ok', kind: 'primary' }, { label: 'Wstecz', value: 'back' }],
        onOpen: () => nameI.focus()
      });
      if (v === 'back') return createWizard();
      if (v !== 'ok') return;
      const settings = {};
      for (const [k, inp] of Object.entries(inputs)) settings[k] = inp.type === 'checkbox' ? inp.checked : inp.value;
      try {
        const g = await api.post('/api/games', { name: nameI.value, template: t.id, settings });
        WD.toast('Utworzono serwer', 'ok');
        await loadAll();
        select(g.id);
        const ask = await WD.confirm('Instalacja', t.steam || t.java ? 'Zainstalować teraz pliki serwera? ' + (t.steam ? STEAM_HINT : '') : 'Serwer gotowy. Uruchomić go teraz?', { okLabel: t.steam || t.java ? 'Zainstaluj' : 'Uruchom' });
        if (ask) { if (t.steam || t.java) doInstall(); else act('start'); }
      } catch (err) { WD.error(err); }
    }

    loadAll();
    startPolling();
    return win;

    function startPolling() {
      const tick = async () => {
        if (closed) return;
        await refreshStatus(false);
        timer = setTimeout(tick, 3000);
      };
      timer = setTimeout(tick, 1500);
    }
    async function refreshStatus(rerender) {
      const before = JSON.stringify(statusMap[selId] || {});
      try {
        list = await api.get('/api/games');
      } catch { /* ignore */ }
      await Promise.all(list.map(async (g) => { try { statusMap[g.id] = await api.get(`/api/games/${g.id}`); } catch { /* ignore */ } }));
      renderList();
      const now = JSON.stringify(statusMap[selId] || {});
      // Re-render detail only when status meaningfully changed (avoid nuking the live console).
      if (rerender || (before !== now && tab !== 'console')) renderDetail();
      else if (before !== now && tab === 'console') updateConsoleControls();
    }
    function updateConsoleControls() {
      const g = cur();
      if (!g) return;
      const st = statusMap[g.id] || {};
      // If installing state or running state flipped, the console pane must change.
      const wasTermOpen = !!term;
      const shouldTerm = g.installed && !st.installing;
      if (wasTermOpen !== shouldTerm || (term && !running(g))) renderDetail();
    }
  }

  WD.apps = WD.apps || {};
  WD.apps.games = { name: 'Serwery gier', icon: 'games', launch };
})(window.WD);
