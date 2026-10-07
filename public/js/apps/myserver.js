'use strict';
/* "Mój serwer": the customer's view of their hosted Valheim server.
   One screen: status, address, resources, power buttons, and tabs for log, settings,
   players, backups, schedule and plan. Everything is enforced again on the server side. */
(function (WD) {
  const { h, api, fmt } = WD;

  const ALL_PERMS = ['power', 'reset', 'backup', 'settings', 'lists', 'schedule', 'mods'];
  const LIST_LABELS = { permitted: 'Lista dozwolonych (whitelist)', admin: 'Administratorzy serwera', banned: 'Zbanowani' };
  const LIST_HELP = {
    permitted: 'Gdy lista nie jest pusta, wejdą tylko wpisani gracze (poza hasłem serwera).',
    admin: 'Ci gracze mogą używać komend administratora w grze (F5 → kick, ban).',
    banned: 'Ci gracze nie wejdą na serwer.'
  };

  function launch(opts = {}) {
    const existing = WD.wm.find((w) => w.app === 'myserver');
    if (existing) { existing.focus(); return existing; }

    let g = null;            // server (public view)
    let st = {};             // status
    let us = {};             // usage
    let on = { count: 0, ids: [], supported: false };
    let tab = opts.tab || 'log';
    let closed = false;
    let timer = null;
    let slowTick = 0;
    let busyUi = false;
    let pickList = [];

    const perms = (WD.info.role === 'client' ? (WD.info.perms || []) : ALL_PERMS);
    const can = (p) => perms.includes(p);
    const isAdmin = WD.info.role === 'admin';

    const top = h('div', { class: 'ms-top' });
    const tabsEl = h('div', { class: 'gm-tabs ms-tabs' });
    const pane = h('div', { class: 'ms-pane' });
    const root = h('div', { class: 'ms' }, top, tabsEl, pane);
    const win = WD.wm.open({
      app: 'myserver', title: 'Mój serwer', icon: WD.appIcon('games'), width: 860, height: 720,
      onClose: () => { closed = true; clearTimeout(timer); }
    });
    win.body.append(root);

    async function pickServer() {
      const list = await api.get('/api/games');
      pickList = list.filter((x) => x.template === 'valheim');
      if (!pickList.length) { top.replaceChildren(h('div', { class: 'gm-welcome' }, h('h2', {}, 'Brak serwera'), h('p', {}, 'Do Twojego konta nie przypisano jeszcze żadnego serwera. Napisz do administratora.'))); return null; }
      return pickList.find((x) => x.id === opts.id) || pickList[0];
    }

    async function init() {
      try { const first = await pickServer(); if (!first) return; g = first; } catch (err) { return WD.error(err); }
      await refresh(true);
      loop();
    }

    function loop() {
      if (closed) return;
      timer = setTimeout(async () => { await refresh(false); loop(); }, 3000);
    }

    async function refresh(full) {
      try {
        const [info, status] = await Promise.all([api.get(`/api/games/${g.id}/info`), api.get(`/api/games/${g.id}`)]);
        g = info; st = status;
        if (full || (++slowTick % 2 === 0)) {
          [us, on] = await Promise.all([api.get(`/api/games/${g.id}/usage`).catch(() => us), api.get(`/api/games/${g.id}/online`).catch(() => on)]);
        }
      } catch (err) { if (full) WD.error(err); return; }
      renderTop();
      if (full) renderTabs();
      if (tab === 'log') updateLog();
      if (full) renderPane();
    }

    const stateOf = () => {
      if (st.installing) return ['inst', 'Instalacja…'];
      if (st.busy) return ['inst', 'Trwa: ' + st.busy];
      if (!g.installed) return ['stop', 'Nie zainstalowany'];
      return st.running ? ['run', 'Działa'] : ['stop', 'Zatrzymany'];
    };

    function meter(label, value, max, textFn) {
      const pct = max ? Math.min(100, Math.round((value || 0) / max * 100)) : 0;
      return h('div', { class: 'ms-stat' },
        h('div', { class: 'ms-stat-l' }, label),
        h('div', { class: 'ms-stat-v' }, textFn()),
        max ? h('div', { class: 'ms-bar' }, h('div', { class: 'ms-barfill' + (pct > 90 ? ' hot' : ''), style: { width: pct + '%' } })) : null);
    }

    function renderTop() {
      const [cls, label] = stateOf();
      const host = WD.info.publicHost || location.hostname;
      const addr = `${host}:${g.settings.port}`;
      const paid = g.paid || {};
      const banner = paid.state === 'warn' ? ['warn', `Usługa wygasa za ${paid.daysLeft} ${paid.daysLeft === 1 ? 'dzień' : 'dni'} (${fmt.date(paid.until)}). Skontaktuj się z administratorem, aby ją przedłużyć.`]
        : paid.state === 'grace' ? ['bad', `Usługa wygasła ${fmt.date(paid.until)}. Serwer działa jeszcze do końca okresu karencji (${paid.graceDays} dni), potem zostanie zatrzymany.`]
        : paid.state === 'expired' ? ['bad', 'Usługa wygasła, serwer jest zatrzymany. Skontaktuj się z administratorem, aby ją przedłużyć.'] : null;
      const lim = g.limits || {};
      const busy = !!st.busy || st.installing;
      const btn = (text, fn, o = {}) => h('button', { class: 'btn ' + (o.cls || ''), disabled: busyUi || busy || o.disabled || !o.perm, title: o.perm ? '' : 'Brak uprawnienia', onclick: fn }, text);
      top.replaceChildren(
        banner ? h('div', { class: 'ms-banner ' + banner[0] }, banner[1]) : null,
        h('div', { class: 'ms-head' },
          h('div', { class: 'ms-title' }, h('h2', {}, g.settings.serverName || g.name), h('div', { class: 'ms-sub' }, g.name, lim.planLabel ? ' · pakiet ' + lim.planLabel : '', paid.until ? ' · ważny do ' + new Date(paid.until).toLocaleDateString('pl-PL') : '')),
          h('span', { class: 'gm-pill ' + cls }, label)),
        h('div', { class: 'ms-addr' },
          h('div', {}, h('div', { class: 'ms-stat-l' }, 'Adres serwera'), h('code', { class: 'ms-code' }, addr)),
          h('button', { class: 'btn', onclick: () => copy(addr) }, 'Kopiuj'),
          h('div', {}, h('div', { class: 'ms-stat-l' }, 'Hasło'), h('code', { class: 'ms-code ms-pw', title: 'Kliknij, aby pokazać', onclick: (e) => { e.currentTarget.classList.toggle('show'); } }, h('span', { class: 'pw-real' }, g.settings.password || '(brak)'), h('span', { class: 'pw-mask' }, g.settings.password ? '••••••••' : '(brak)')))),
        h('div', { class: 'ms-stats' },
          h('div', { class: 'ms-stat' }, h('div', { class: 'ms-stat-l' }, 'Gracze online'), h('div', { class: 'ms-stat-v big' }, on.supported && st.running ? String(on.count) : '—')),
          meter('Pamięć', us.memoryBytes, us.memoryLimitBytes, () => us.memoryBytes != null ? `${fmt.size(us.memoryBytes)}${us.memoryLimitBytes ? ' / ' + fmt.size(us.memoryLimitBytes) : ''}` : '—'),
          meter('Procesor', us.cpuPercent, us.cpuQuota, () => us.cpuPercent != null ? `${us.cpuPercent.toFixed(0)}%${us.cpuQuota ? ' / ' + us.cpuQuota + '%' : ''}` : '—'),
          h('div', { class: 'ms-stat' }, h('div', { class: 'ms-stat-l' }, 'Dysk'), h('div', { class: 'ms-stat-v' }, us.diskBytes != null ? fmt.size(us.diskBytes) : '—'))),
        h('div', { class: 'gm-actions ms-actions' },
          st.running ? btn('Zatrzymaj', () => power('stop'), { cls: 'danger', perm: can('power') }) : btn('Uruchom', () => power('start'), { cls: 'primary', perm: can('power'), disabled: !g.installed || paid.state === 'expired' }),
          btn('Restart', () => power('restart'), { perm: can('power'), disabled: !st.running }),
          btn('Kopia zapasowa', () => makeBackup(), { perm: can('backup'), disabled: !g.installed }),
          btn('Reset świata…', () => resetWorld(), { cls: 'danger-outline', perm: can('reset'), disabled: !g.installed })));
    }

    async function copy(text) {
      try { await navigator.clipboard.writeText(text); WD.toast('Skopiowano: ' + text, 'ok'); } catch { WD.toast(text); }
    }

    async function guarded(fn) {
      busyUi = true; renderTop();
      try { return await fn(); } catch (err) { WD.error(err); } finally { busyUi = false; await refresh(false); }
    }
    const power = (action) => guarded(async () => {
      if (action === 'stop' && !(await WD.confirm('Zatrzymać serwer?', 'Serwer zapisze świat i się wyłączy. Gracze zostaną rozłączeni.', { okLabel: 'Zatrzymaj', danger: true }))) return;
      if (action === 'restart' && on.count > 0 && !(await WD.confirm('Gracze są online', `Na serwerze gra teraz ${on.count} os. Restart ich rozłączy. Kontynuować?`, { okLabel: 'Restartuj', danger: true }))) return;
      await api.post(`/api/games/${g.id}/${action}`);
      WD.toast({ start: 'Serwer się uruchamia…', stop: 'Serwer zatrzymany', restart: 'Serwer zrestartowany' }[action], 'ok');
    });
    const makeBackup = () => guarded(async () => {
      await api.post(`/api/games/${g.id}/backup`);
      WD.toast('Kopia zapasowa gotowa', 'ok');
      if (tab === 'backups') renderPane();
    });

    async function resetWorld() {
      const hasKeep = (g.limits && g.limits.world2) || isAdmin;
      const mode = h('select', { class: 'field' }, h('option', { value: 'wipe' }, 'Wyczyść świat i zacznij od nowa (nowy seed)'), hasKeep ? h('option', { value: 'keep' }, 'Nowy świat obok starego (stary zostaje na dysku)') : null);
      const newName = h('input', { class: 'field', placeholder: 'nazwa nowego świata', hidden: true, spellcheck: 'false' });
      mode.addEventListener('change', () => { newName.hidden = mode.value !== 'keep'; });
      const confirmI = h('input', { class: 'field', placeholder: g.name, spellcheck: 'false' });
      const v = await WD.dialog({
        title: 'Reset świata',
        body: h('div', {}, h('p', {}, 'Przed resetem automatycznie powstanie kopia zapasowa, więc w razie pomyłki można ją przywrócić w zakładce „Kopie zapasowe”.'),
          h('label', {}, 'Co zrobić'), mode, newName,
          h('label', { style: { marginTop: '10px' } }, `Aby potwierdzić, wpisz nazwę serwera: ${g.name}`), confirmI),
        buttons: [{ label: 'Resetuj świat', value: 'go', kind: 'danger' }, { label: 'Anuluj', value: null }],
        validate: (val) => (val === 'go' && confirmI.value.trim() !== g.name ? (WD.toast('Wpisz dokładną nazwę serwera', 'error'), false) : true)
      });
      if (v !== 'go') return;
      guarded(async () => {
        const out = await api.post(`/api/games/${g.id}/reset-world`, { mode: mode.value, newWorld: newName.value.trim() });
        WD.toast(out.mode === 'keep' ? `Nowy świat „${out.world}” gotowy` : 'Świat wyczyszczony. Nowy powstanie przy starcie serwera.', 'ok');
      });
    }

    // ----- tabs -----
    const tabList = () => [['log', 'Log'], ['settings', 'Ustawienia'], ...((g.limits && g.limits.mods) || isAdmin ? (can('mods') ? [['mods', 'Mody']] : []) : []), ['players', 'Gracze'], ['backups', 'Kopie zapasowe'], ['schedule', 'Harmonogram'], ['plan', 'Pakiet']];
    function renderTabs() {
      if (!tabList().some(([id]) => id === tab)) tab = 'log';
      tabsEl.replaceChildren(...tabList().map(([id, label]) => h('button', { class: 'gm-tab' + (tab === id ? ' on' : ''), onclick: () => { tab = id; renderTabs(); renderPane(); } }, label)));
    }
    function renderPane() {
      ({ log: paneLog, settings: paneSettings, mods: paneMods, players: panePlayers, backups: paneBackups, schedule: paneSchedule, plan: panePlan })[tab]();
    }

    // ----- log -----
    let logEl = null;
    function paneLog() {
      logEl = h('pre', { class: 'gm-log ms-log' }, 'Wczytywanie logu…');
      pane.replaceChildren(h('div', { class: 'tm-dim', style: { marginBottom: '6px' } }, 'Ostatnie linie logu serwera (odświeża się samo).'), logEl);
      updateLog(true);
    }
    async function updateLog(force) {
      if (!logEl || tab !== 'log') return;
      try {
        const text = await api.get(`/api/games/${g.id}/console`, { lines: 300 });
        if (!logEl || tab !== 'log') return;
        if (text === logEl.dataset.last && !force) return;
        const atEnd = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
        logEl.textContent = text; logEl.dataset.last = text;
        if (atEnd || force) logEl.scrollTop = logEl.scrollHeight;
      } catch { /* ignore */ }
    }

    // ----- settings -----
    function paneSettings() {
      const lim = g.limits || {};
      const editable = can('settings');
      const name = h('input', { class: 'field', value: g.settings.serverName || '', disabled: !editable, maxlength: 50 });
      const pw = h('input', { class: 'field', value: g.settings.password || '', disabled: !editable, spellcheck: 'false', autocomplete: 'off' });
      const pub = h('input', { type: 'checkbox', checked: g.settings.public === true || g.settings.public === 'true', disabled: !editable });
      const cross = h('input', { type: 'checkbox', checked: g.settings.crossplay === true || g.settings.crossplay === 'true', disabled: !editable || (!lim.crossplay && !isAdmin) });
      const auto = h('input', { type: 'checkbox', checked: !!g.autostart, disabled: !editable });
      const save = h('button', { class: 'btn primary', disabled: !editable, onclick: () => guarded(async () => {
        await api.post(`/api/games/${g.id}/settings`, { serverName: name.value, password: pw.value, public: pub.checked, crossplay: cross.checked, autostart: auto.checked });
        WD.toast(st.running ? 'Zapisano. Zmiany zadziałają po restarcie serwera.' : 'Zapisano', 'ok');
      }) }, 'Zapisz ustawienia');
      pane.replaceChildren(h('div', { class: 'gm-form' },
        h('label', {}, 'Nazwa serwera (widoczna dla graczy)'), name,
        h('label', {}, 'Hasło serwera (min. 5 znaków, bez nazwy świata)'), pw,
        h('label', { class: 'tm-radio' }, pub, ' Pokaż serwer na publicznej liście Valheim'),
        h('label', { class: 'tm-radio', title: lim.crossplay || isAdmin ? '' : 'Dostępne w pakiecie Plus' }, cross, ' Crossplay (Xbox / Game Pass)', (lim.crossplay || isAdmin) ? null : h('span', { class: 'tm-dim' }, ' · tylko pakiet Plus')),
        h('label', { class: 'tm-radio' }, auto, ' Uruchamiaj serwer automatycznie po restarcie maszyny'),
        h('div', { class: 'tm-dim', style: { marginTop: '12px' } }, `Świat: ${g.settings.world} · port ${g.settings.port}/UDP (serwer używa ${g.settings.port}–${+g.settings.port + 2}). Port i nazwę świata zmienia administrator albo reset świata.`),
        h('div', { class: 'gm-formbtns' }, save)));
    }

    // ----- mods -----
    const sizeTxt = (n) => (n ? fmt.size(n) : '');
    async function paneMods() {
      pane.replaceChildren(h('div', { class: 'gm-welcome' }, 'Wczytywanie…'));
      let info; try { info = await api.get(`/api/games/${g.id}/mods`); } catch (err) { return WD.error(err); }
      const box = h('div', { class: 'ms-mods' });
      const reload = () => paneMods();
      const modsOn = info.modded && info.installed;
      const ramLow = info.ram && info.ram.availMb != null && info.ram.availMb < (modsOn ? info.ram.needMb : info.ram.moddedMb) * 0.85;

      // switch
      const sw = h('div', { class: 'ms-listbox' },
        h('h4', {}, 'Tryb z modami'),
        h('div', { class: 'tm-dim' }, modsOn ? 'Serwer startuje z BepInEx i modami z listy poniżej.' : info.installed ? 'BepInEx jest zainstalowany, ale tryb z modami jest wyłączony.' : 'Serwer działa bez modów. Włączenie pobierze i zainstaluje BepInEx (około minuty).'),
        info.ram && info.ram.moddedMb ? h('div', { class: 'tm-dim' }, `Serwer z modami zwykle potrzebuje ok. ${info.ram.moddedMb} MB pamięci${info.memoryMb ? ` (limit pakietu: ${info.memoryMb} MB)` : ''}. Teraz wolne na maszynie: ${info.ram.availMb} MB.`) : null,
        ramLow ? h('div', { class: 'ms-banner warn' }, 'Na maszynie jest teraz mało wolnej pamięci. Start serwera z modami może zostać odrzucony, dopóki administrator nie zwolni zasobów.') : null,
        h('div', {}, h('button', { class: 'btn ' + (modsOn ? 'danger-outline' : 'primary'), disabled: busyUi, onclick: () => guarded(async () => {
          if (modsOn && !(await WD.confirm('Wyłączyć mody?', 'Serwer przy następnym starcie ruszy bez modów. Pliki modów zostają na dysku. Uwaga: świat zapisany z modami może nie działać poprawnie bez nich.', { okLabel: 'Wyłącz', danger: true }))) return;
          WD.toast(modsOn ? 'Wyłączam tryb z modami…' : 'Instaluję BepInEx, to potrwa chwilę…');
          await api.post(`/api/games/${g.id}/mods/enable`, { enabled: !modsOn });
          WD.toast(modsOn ? 'Mody wyłączone (od następnego startu)' : 'Mody włączone. Zainstaluj mody i zrestartuj serwer.', 'ok'); reload();
        }) }, modsOn ? 'Wyłącz mody' : 'Włącz mody (zainstaluj BepInEx)')),
        info.running ? h('div', { class: 'tm-dim' }, 'Serwer działa: zmiany modów i ich ustawień zadziałają po restarcie.') : null);
      box.append(sw);
      if (!info.installed) { pane.replaceChildren(box); return; }

      // install by name / search
      const ref = h('input', { class: 'field', placeholder: 'Autor-Nazwa albo adres ze strony Thunderstore (np. ValheimModding-Jotunn)', spellcheck: 'false' });
      const installBtn = h('button', { class: 'btn primary', disabled: busyUi, onclick: () => installRef(ref.value) }, 'Zainstaluj');
      const q = h('input', { class: 'field', placeholder: 'Szukaj na Thunderstore (np. epic loot, jotunn, backpacks)…', spellcheck: 'false' });
      const results = h('div', { class: 'ms-results' });
      let qt; q.addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(doSearch, 350); });
      async function doSearch() {
        if (q.value.trim().length < 2) { results.replaceChildren(); return; }
        results.replaceChildren(h('div', { class: 'tm-dim' }, 'Szukam…'));
        try {
          const found = await api.get(`/api/games/${g.id}/mods/search`, { q: q.value });
          results.replaceChildren(...found.map((m) => h('div', { class: 'ms-result' },
            h('div', { class: 'ms-rinfo' }, h('div', {}, h('b', {}, m.name), ` ${m.version} · ${m.owner} `, h('span', { class: 'gb-badge' }, { server: 'serwer', client: 'tylko klient', both: 'serwer + klient' }[m.side])), h('div', { class: 'tm-dim' }, m.description), h('div', { class: 'tm-dim' }, `${(m.downloads / 1000).toFixed(0)}k pobrań · ${fmt.size(m.size)}`)),
            h('button', { class: 'btn', disabled: busyUi, onclick: () => installRef(m.full) }, 'Zainstaluj'))));
          if (!found.length) results.replaceChildren(h('div', { class: 'tm-dim' }, 'Nic nie znaleziono.'));
        } catch (err) { results.replaceChildren(); WD.error(err); }
      }
      function installRef(r, force) {
        if (!r.trim()) return;
        return guarded(async () => {
          WD.toast('Pobieram i instaluję mod z zależnościami…');
          const out = await api.post(`/api/games/${g.id}/mods/install`, { package: r.trim(), force: !!force });
          WD.toast(out.installed.length ? `Zainstalowano: ${out.installed.join(', ')}` : 'Wszystko już jest zainstalowane', 'ok', 7000);
          reload();
        });
      }
      box.append(h('div', { class: 'ms-listbox' }, h('h4', {}, 'Dodaj mod'),
        h('div', { class: 'ms-row' }, ref, installBtn), q, results,
        h('div', { class: 'ms-row' }, h('button', { class: 'btn', disabled: busyUi, onclick: () => upload() }, 'Wgraj własny mod (.zip / .dll)'),
          h('span', { class: 'tm-dim' }, 'Własne pliki uruchamiają się na serwerze – wgrywaj tylko to, czemu ufasz.'))));

      // installed list
      const rows = info.mods.map((m) => h('div', { class: 'ms-mod' + (m.enabled ? '' : ' off') },
        h('div', { class: 'ms-minfo' }, h('div', { class: 'ms-mname' }, m.name, m.version ? h('span', { class: 'tm-dim' }, ' ' + m.version) : null),
          h('div', { class: 'tm-dim' }, `${m.source === 'thunderstore' ? 'Thunderstore' : m.source === 'upload' || m.source === 'local' ? 'własny' : m.source === 'cloned' ? 'skopiowany' : 'nieznane źródło'}${m.size ? ' · ' + sizeTxt(m.size) : ''}`)),
        h('div', { class: 'ms-mbtns' },
          h('button', { class: 'btn', disabled: busyUi, onclick: () => guarded(async () => { await api.post(`/api/games/${g.id}/mods/toggle`, { name: m.name, enabled: !m.enabled }); reload(); }) }, m.enabled ? 'Wyłącz' : 'Włącz'),
          m.source === 'thunderstore' ? h('button', { class: 'btn', disabled: busyUi, title: 'Pobierz najnowszą wersję', onclick: () => installRef(m.name, true) }, 'Aktualizuj') : null,
          h('button', { class: 'btn danger-outline', disabled: busyUi, onclick: async () => { if (await WD.confirm('Usuń mod', `Usunąć „${m.name}”? Pliki moda zostaną skasowane (jego ustawienia zostają).`, { okLabel: 'Usuń', danger: true })) guarded(async () => { await api.post(`/api/games/${g.id}/mods/remove`, { name: m.name }); reload(); }); } }, 'Usuń'))));
      box.append(h('div', { class: 'ms-listbox wide' },
        h('div', { class: 'ms-row' }, h('h4', { style: { flex: 1 } }, `Zainstalowane mody (${info.mods.length})`),
          h('button', { class: 'btn', onclick: () => configDialog() }, 'Ustawienia modów…'), h('button', { class: 'btn', onclick: () => playerListDialog() }, 'Lista dla graczy'),
          isAdmin ? h('button', { class: 'btn', onclick: () => cloneDialog() }, 'Skopiuj z naszego serwera…') : null),
        rows.length ? h('div', { class: 'ms-modlist' }, ...rows) : h('div', { class: 'tm-dim' }, 'Brak modów. Dodaj pierwszy powyżej.')));
      pane.replaceChildren(box);
    }

    function upload() {
      const f = h('input', { type: 'file', accept: '.zip,.dll', style: { display: 'none' } });
      f.addEventListener('change', () => {
        const file = f.files[0]; if (!file) return;
        guarded(async () => {
          WD.toast(`Wgrywam ${file.name} (${fmt.size(file.size)})…`);
          const r = await fetch(`/api/games/${g.id}/mods/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', credentials: 'same-origin', headers: { 'X-WebPulpit': '1', 'Content-Type': 'application/octet-stream' }, body: file });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.error || `Błąd ${r.status}`);
          WD.toast('Mod wgrany', 'ok'); paneMods();
        });
      });
      document.body.append(f); f.click(); setTimeout(() => f.remove(), 60000);
    }

    async function configDialog() {
      let files; try { files = await api.get(`/api/games/${g.id}/mods/configs`); } catch (err) { return WD.error(err); }
      if (!files.length) return WD.alert('Brak plików', 'Mody nie utworzyły jeszcze plików ustawień. Pojawią się po pierwszym uruchomieniu serwera z modami.');
      const filter = h('input', { class: 'field', placeholder: 'Filtruj pliki…', spellcheck: 'false' });
      const sel = h('select', { class: 'field', size: 6, style: { height: '130px' } });
      const fill = () => { sel.replaceChildren(...files.filter((f) => f.file.toLowerCase().includes(filter.value.toLowerCase())).map((f) => h('option', { value: f.file }, f.file))); };
      filter.addEventListener('input', fill); fill();
      const ta = h('textarea', { class: 'gm-configta', spellcheck: 'false', style: { minHeight: '260px', width: '100%' } });
      sel.addEventListener('change', async () => { try { ta.value = await api.get(`/api/games/${g.id}/mods/config`, { file: sel.value }); } catch (err) { WD.error(err); } });
      const v = await WD.dialog({ title: 'Ustawienia modów', body: h('div', { style: { width: 'min(640px, 86vw)' } }, filter, sel, ta, h('div', { class: 'tm-dim' }, 'Zmiany zadziałają po restarcie serwera. Uważaj na składnię – zły plik może zablokować moda.')),
        buttons: [{ label: 'Zapisz plik', value: 'save', kind: 'primary' }, { label: 'Zamknij', value: null }], validate: (val) => { if (val !== 'save') return true; if (!sel.value) { WD.toast('Wybierz plik z listy', 'error'); return false; } return true; } });
      if (v !== 'save') return;
      try { await api.post(`/api/games/${g.id}/mods/config`, { file: sel.value, content: ta.value }); WD.toast('Zapisano ' + sel.value, 'ok'); } catch (err) { WD.error(err); }
    }

    async function playerListDialog() {
      let pl; try { pl = await api.get(`/api/games/${g.id}/mods/playerlist`); } catch (err) { return WD.error(err); }
      const text = pl.thunderstore.join('\n');
      const ta = h('textarea', { class: 'gm-configta', readonly: true, style: { minHeight: '200px', width: '100%' } }); ta.value = text;
      await WD.dialog({ title: 'Mody, które muszą mieć gracze', body: h('div', { style: { width: 'min(560px, 86vw)' } },
        h('div', { class: 'tm-dim', style: { marginBottom: '6px' } }, 'Gracze potrzebują tych samych wersji po swojej stronie (r2modman / Thunderstore: Import → wpisz kody modów). Mody tylko serwerowe nie są potrzebne u graczy.'),
        ta, pl.manual.length ? h('div', { class: 'tm-dim', style: { marginTop: '8px' } }, 'Własne mody (przekaż graczom pliki ręcznie): ' + pl.manual.join(', ')) : null),
        buttons: [{ label: 'Kopiuj listę', value: 'copy', kind: 'primary' }, { label: 'Zamknij', value: null }] }).then((v) => { if (v === 'copy') copy(text); });
    }

    async function cloneDialog() {
      const cfgBox = h('input', { type: 'checkbox', checked: true });
      const enf = h('input', { type: 'checkbox', checked: true });
      const v = await WD.dialog({ title: 'Skopiuj mody z naszego serwera', body: h('div', {},
        h('p', {}, 'Skopiuje wszystkie mody z głównego serwera Valheim na ten serwer i włączy tryb z modami. Obecne mody tego serwera zostaną zastąpione. Operacja może potrwać kilkadziesiąt sekund.'),
        h('label', { class: 'tm-radio' }, cfgBox, ' Skopiuj też ustawienia modów (BepInEx/config)'),
        h('label', { class: 'tm-radio' }, enf, ' Pomiń ValheimEnforcer i ModProfiler (zalecane – Enforcer wyrzuca graczy spoza naszej listy)')),
        buttons: [{ label: 'Kopiuj', value: 'go', kind: 'primary' }, { label: 'Anuluj', value: null }] });
      if (v !== 'go') return;
      guarded(async () => {
        WD.toast('Kopiuję mody…', '', 8000);
        const out = await api.post(`/api/games/${g.id}/mods/clone`, { config: cfgBox.checked, skipEnforcer: enf.checked });
        await WD.alert('Gotowe', h('div', {}, `Skopiowano z ${out.source}. Pominięto: ${out.removed.length ? out.removed.join(', ') : 'nic'}.`,
          out.sensitive.length ? h('p', {}, 'Uwaga: te pliki ustawień mogą zawierać hasła, tokeny albo webhooki – sprawdź je w „Ustawienia modów”: ' + out.sensitive.join(', ')) : null));
        paneMods();
      });
    }

    // ----- players -----
    async function panePlayers() {
      pane.replaceChildren(h('div', { class: 'gm-welcome' }, 'Wczytywanie…'));
      let lists; try { lists = await api.get(`/api/games/${g.id}/players`); } catch (err) { return WD.error(err); }
      const editable = can('lists');
      const blocks = ['permitted', 'admin', 'banned'].map((k) => {
        const ta = h('textarea', { class: 'ms-ids', rows: 5, spellcheck: 'false', disabled: !editable, placeholder: '76561198…  (jeden SteamID64 w linii)' });
        ta.value = (lists[k] || []).join('\n');
        const save = h('button', { class: 'btn', disabled: !editable, onclick: async () => {
          try { const out = await api.post(`/api/games/${g.id}/players`, { list: k, ids: ta.value.split(/[\s,;]+/).filter(Boolean) }); ta.value = out.ids.join('\n'); WD.toast('Zapisano listę', 'ok'); } catch (err) { WD.error(err); }
        } }, 'Zapisz');
        return h('div', { class: 'ms-listbox' }, h('h4', {}, LIST_LABELS[k]), h('div', { class: 'tm-dim' }, LIST_HELP[k]), ta, h('div', {}, save));
      });
      const onlineBox = h('div', { class: 'ms-listbox' }, h('h4', {}, `Teraz online: ${on.supported && st.running ? on.count : 0}`),
        h('div', { class: 'ms-chips' }, ...(on.ids || []).map((id) => h('span', { class: 'ms-chip', title: 'Kliknij, aby skopiować', onclick: () => copy(id) }, id))),
        h('div', { class: 'tm-dim' }, 'SteamID64 znajdziesz w profilu Steam (adres lub steamid.io). Zmiany list działają bez restartu serwera.'));
      pane.replaceChildren(onlineBox, ...blocks);
    }

    // ----- backups -----
    async function paneBackups() {
      pane.replaceChildren(h('div', { class: 'gm-welcome' }, 'Wczytywanie…'));
      let list; try { list = await api.get(`/api/games/${g.id}/backups`); } catch (err) { return WD.error(err); }
      const max = g.limits && g.limits.backups;
      const rows = list.map((b) => h('div', { class: 'gm-bk' },
        h('span', { html: WD.glyph('zip'), class: 'gm-bkico' }),
        h('div', { class: 'gm-bktext' }, h('div', {}, b.name), h('div', { class: 'tm-dim' }, fmt.size(b.size) + ' · ' + fmt.date(b.mtime))),
        h('button', { class: 'btn', onclick: () => restore(b) }, 'Przywróć'),
        h('a', { class: 'tbtn', href: `/api/games/${g.id}/backup/download?name=${encodeURIComponent(b.name)}`, title: 'Pobierz', html: WD.glyph('download') }),
        h('button', { class: 'tbtn', title: 'Usuń', html: WD.glyph('trash'), onclick: async () => { if (await WD.confirm('Usuń kopię', `Usunąć „${b.name}”?`, { okLabel: 'Usuń', danger: true })) { await api.post(`/api/games/${g.id}/backup/delete`, { name: b.name }).catch(WD.error); paneBackups(); } } })));
      pane.replaceChildren(
        h('div', { class: 'gm-confhead' }, h('button', { class: 'btn primary', disabled: busyUi || !g.installed, onclick: makeBackup }, 'Utwórz kopię teraz'),
          h('span', { class: 'tm-dim' }, max ? `Pakiet pozwala trzymać ${max} kopii. Najstarsze są usuwane automatycznie.` : 'Kopia zapisuje świat do pliku .tar.gz.')),
        rows.length ? h('div', { class: 'gm-bklist' }, ...rows) : h('div', { class: 'gm-welcome' }, 'Brak kopii zapasowych.'));
    }
    async function restore(b) {
      if (!(await WD.confirm('Przywrócić kopię?', `Serwer zostanie zatrzymany, świat zastąpiony kopią z ${fmt.date(b.mtime)} i uruchomiony ponownie. Aktualny stan zapisze się jako nowa kopia.`, { okLabel: 'Przywróć', danger: true }))) return;
      guarded(async () => { await api.post(`/api/games/${g.id}/backup/restore`, { name: b.name }); WD.toast('Kopia przywrócona', 'ok'); });
    }

    // ----- schedule -----
    function paneSchedule() {
      const lim = g.limits || {};
      const sc = g.schedule || {};
      const editable = can('schedule');
      const restartOk = lim.schedule || isAdmin;
      const backupOk = lim.autoBackup || isAdmin;
      const rEnable = h('input', { type: 'checkbox', checked: !!sc.restartAt, disabled: !editable || !restartOk });
      const rTime = h('input', { class: 'field', type: 'time', value: sc.restartAt || '04:30', disabled: !editable || !restartOk, style: { maxWidth: '140px' } });
      const every = h('select', { class: 'field', disabled: !editable || !backupOk, style: { maxWidth: '260px' } },
        ...[[0, 'Wyłączone'], [1, 'co godzinę'], [2, 'co 2 godziny'], [3, 'co 3 godziny'], [4, 'co 4 godziny'], [6, 'co 6 godzin'], [8, 'co 8 godzin'], [12, 'co 12 godzin'], [24, 'raz dziennie'], [48, 'co 2 dni'], [72, 'co 3 dni'], [168, 'raz w tygodniu']].map(([v, t]) => h('option', { value: v, selected: Number(sc.backupEveryH || 0) === v }, t)));
      const save = h('button', { class: 'btn primary', disabled: !editable || (!restartOk && !backupOk), onclick: () => guarded(async () => {
        await api.post(`/api/games/${g.id}/schedule`, { restartAt: rEnable.checked ? rTime.value : null, backupEveryH: Number(every.value) });
        WD.toast('Zapisano harmonogram', 'ok');
      }) }, 'Zapisz harmonogram');
      const hook = h('input', { class: 'field', placeholder: 'https://discord.com/api/webhooks/…', disabled: !editable || !(lim.discord || isAdmin), value: '' });
      const hookSave = h('button', { class: 'btn', disabled: !editable || !(lim.discord || isAdmin), onclick: () => guarded(async () => {
        const out = await api.post(`/api/games/${g.id}/discord`, { url: hook.value.trim() });
        WD.toast(out.discordSet ? 'Webhook zapisany – wiadomości pojawią się na kanale' : 'Webhook usunięty', 'ok'); hook.value = '';
      }) }, g.discordSet ? 'Zmień / usuń webhook' : 'Zapisz webhook');
      pane.replaceChildren(h('div', { class: 'gm-form' },
        h('h4', {}, 'Codzienny restart'),
        restartOk ? null : h('div', { class: 'tm-dim' }, 'Dostępne w pakiecie Plus.'),
        h('label', { class: 'tm-radio' }, rEnable, ' Restartuj serwer codziennie o'), rTime,
        h('div', { class: 'tm-dim' }, 'Czas polski. Restart wykona się tylko, gdy nikt nie gra. Jeśli ktoś gra, panel czeka do godziny, potem pomija dzień.'),
        h('h4', { style: { marginTop: '18px' } }, 'Automatyczne kopie zapasowe'),
        backupOk ? null : h('div', { class: 'tm-dim' }, 'Dostępne w pakiecie Plus.'), every,
        h('div', { class: 'gm-formbtns' }, save),
        h('h4', { style: { marginTop: '22px' } }, 'Powiadomienia na Discordzie'),
        (lim.discord || isAdmin) ? h('div', { class: 'tm-dim' }, g.discordSet ? 'Webhook jest ustawiony. Wklej nowy adres, aby go zmienić, albo zostaw puste i zapisz, aby usunąć.' : 'Wklej adres webhooka z ustawień kanału Discord (Integracje → Webhooki). Dostaniesz wiadomości o starcie, zatrzymaniu, resecie oraz wejściach graczy.')
          : h('div', { class: 'tm-dim' }, 'Opcja dodatkowa „Powiadomienia Discord”. Zapytaj administratora.'),
        hook, h('div', {}, hookSave)));
    }

    // ----- plan -----
    function panePlan() {
      const lim = g.limits || {};
      const paid = g.paid || {};
      const row = (k, v) => h('div', { class: 'ms-prow' }, h('span', {}, k), h('b', {}, v));
      const yes = (x) => (x ? 'tak' : 'nie');
      pane.replaceChildren(h('div', { class: 'gm-form' },
        row('Pakiet', lim.planLabel || 'bez limitów'),
        row('Ważny do', paid.until ? new Date(paid.until).toLocaleDateString('pl-PL') : 'bez terminu'),
        row('Limit pamięci', lim.memoryMb ? lim.memoryMb + ' MB' : 'brak'),
        row('Limit procesora', lim.cpuQuota ? lim.cpuQuota + '%' : 'brak'),
        row('Kopie zapasowe', lim.backups ? 'do ' + lim.backups : 'bez limitu'),
        row('Codzienny restart', yes(lim.schedule)),
        row('Automatyczne kopie', yes(lim.autoBackup)),
        row('Crossplay', yes(lim.crossplay)),
        row('Powiadomienia Discord', yes(lim.discord)),
        row('Drugi świat', yes(lim.world2)),
        row('Mody (BepInEx)', yes(lim.mods)),
        h('div', { class: 'tm-dim', style: { marginTop: '14px' } }, 'Chcesz więcej? Napisz do administratora – pakiety i opcje dodatkowe włącza on w panelu.')));
    }

    init();
    return win;
  }

  WD.apps = WD.apps || {};
  WD.apps.myserver = { name: 'Mój serwer', icon: 'games', launch };
})(window.WD);
