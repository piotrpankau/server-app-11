'use strict';
/* "Mój serwer": the customer's view of their hosted Valheim server.
   One screen: status, address, resources, power buttons, and tabs for log, settings,
   players, backups, schedule and plan. Everything is enforced again on the server side. */
(function (WD) {
  const { h, api, fmt } = WD;

  const ALL_PERMS = ['power', 'reset', 'backup', 'settings', 'lists', 'schedule'];
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
    let tab = 'log';
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
    const TABS = [['log', 'Log'], ['settings', 'Ustawienia'], ['players', 'Gracze'], ['backups', 'Kopie zapasowe'], ['schedule', 'Harmonogram'], ['plan', 'Pakiet']];
    function renderTabs() {
      tabsEl.replaceChildren(...TABS.map(([id, label]) => h('button', { class: 'gm-tab' + (tab === id ? ' on' : ''), onclick: () => { tab = id; renderTabs(); renderPane(); } }, label)));
    }
    function renderPane() {
      ({ log: paneLog, settings: paneSettings, players: panePlayers, backups: paneBackups, schedule: paneSchedule, plan: panePlan })[tab]();
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
        h('div', { class: 'tm-dim', style: { marginTop: '14px' } }, 'Chcesz więcej? Napisz do administratora – pakiety i opcje dodatkowe włącza on w panelu.')));
    }

    init();
    return win;
  }

  WD.apps = WD.apps || {};
  WD.apps.myserver = { name: 'Mój serwer', icon: 'games', launch };
})(window.WD);
