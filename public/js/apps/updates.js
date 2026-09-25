'use strict';
/* Updates ("Aktualizacje"): WebPulpit itself from GitHub, Ubuntu packages, reboot. */
(function (WD) {
  const { h, api } = WD;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Waits until the panel answers again after a restart/reboot, then reloads the page.
  async function waitForServer(msgEl, prevCommit) {
    const start = Date.now();
    while (Date.now() - start < 10 * 60 * 1000) {
      await sleep(2500);
      try {
        const v = await fetch('/api/version', { credentials: 'same-origin', cache: 'no-store' });
        if (v.status === 401) { location.href = '/login'; return; }
        if (!v.ok) continue;
        const data = await v.json();
        if (prevCommit && data.commit === prevCommit && Date.now() - start < 60000) continue;
        msgEl.textContent = 'Gotowe! Odświeżam stronę…';
        await sleep(1200);
        location.reload();
        return;
      } catch { /* still restarting */ }
    }
    msgEl.textContent = 'Serwer nie odpowiada od 10 minut. Odśwież stronę ręcznie.';
  }

  function launch() {
    const existing = WD.wm.find((w) => w.app === 'updates');
    if (existing) return existing.focus();

    const btn = (label, icon, fn, primary) => h('button', { class: 'btn' + (primary ? ' primary' : ''), onclick: fn },
      icon ? h('span', { html: WD.glyph(icon), style: { display: 'inline-flex', width: '14px', marginRight: '6px', verticalAlign: '-2px' } }) : null, label);

    // ----- WebPulpit -----
    const appVer = h('div', { class: 'grow' }, 'Wersja: …');
    const appCheck = btn('Sprawdź aktualizacje', 'refresh', () => checkApp(), true);
    const appUpdate = btn('Aktualizuj', 'download', () => updateApp());
    appUpdate.hidden = true;
    const appMsg = h('div', { class: 'upd-msg' });
    const appList = h('ul', { class: 'upd-list', hidden: true });
    const appLog = h('pre', { class: 'upd-log', hidden: true });
    let appInfo = null;

    // ----- Ubuntu -----
    const sysCheck = btn('Sprawdź aktualizacje', 'refresh', () => checkSystem(), true);
    const sysUpdate = btn('Zainstaluj aktualizacje', 'download', () => upgradeSystem());
    sysUpdate.hidden = true;
    const sysMsg = h('div', { class: 'upd-msg' }, 'Kliknij „Sprawdź aktualizacje”, aby zobaczyć dostępne poprawki systemu.');
    const sysList = h('ul', { class: 'upd-list', hidden: true });
    const sysLog = h('pre', { class: 'upd-log', hidden: true });
    const rebootBox = h('div', { class: 'upd-box', hidden: true },
      h('div', { class: 'upd-row' },
        h('div', { class: 'grow' }, h('strong', {}, 'Wymagane ponowne uruchomienie'), h('div', { class: 'upd-msg' }, 'Część aktualizacji zacznie działać dopiero po restarcie serwera.')),
        btn('Uruchom ponownie serwer', 'power', () => rebootServer())));
    const rootNote = h('div', { class: 'upd-msg warn', hidden: true }, 'Panel nie działa jako root — instalowanie aktualizacji jest niedostępne, możesz je tylko sprawdzić.');

    const root = h('div', { class: 'settings' },
      h('h3', {}, 'WebPulpit'),
      h('div', { class: 'upd-box' }, h('div', { class: 'upd-row' }, appVer, appCheck, appUpdate), appMsg, appList, appLog),
      h('h3', {}, 'System Ubuntu'),
      rootNote,
      h('div', { class: 'upd-box' }, h('div', { class: 'upd-row' }, h('div', { class: 'grow' }, 'Pakiety systemowe (apt)'), sysCheck, sysUpdate), sysMsg, sysList, sysLog),
      rebootBox,
      h('div', { class: 'upd-row', style: { marginTop: '6px' } }, h('span', { class: 'grow tm-dim' }, 'Restart całego serwera (np. po aktualizacji jądra).'),
        btn('Uruchom ponownie serwer', 'power', () => rebootServer())));

    const win = WD.wm.open({ app: 'updates', title: 'Aktualizacje', icon: WD.appIcon('updates'), width: 640, height: 640, onClose: () => { closed = true; } });
    let closed = false;
    win.body.append(root);

    const setBusy = (b, busy, label) => { b.disabled = busy; if (label) b.lastChild.textContent = label; };

    async function loadVersion() {
      try {
        const v = await api.get('/api/version');
        appVer.textContent = `Wersja ${v.version}` + (v.commit ? ` (${v.commit.slice(0, 7)})` : '') + (v.date ? ` · zainstalowano ${new Date(v.date).toLocaleDateString('pl-PL')}` : '');
        rootNote.hidden = v.root;
        return v;
      } catch (err) { appVer.textContent = 'Wersja: nieznana'; return null; }
    }

    async function checkApp() {
      setBusy(appCheck, true, 'Sprawdzanie…');
      appMsg.className = 'upd-msg';
      appMsg.textContent = 'Łączenie z GitHubem…';
      try {
        appInfo = await api.get('/api/update/app');
        WD.settings.set('upd.lastCheck', Date.now());
        if (!appInfo.supported) {
          appMsg.className = 'upd-msg warn';
          appMsg.textContent = appInfo.reason;
        } else if (appInfo.available) {
          appMsg.className = 'upd-msg';
          appMsg.textContent = `Dostępna aktualizacja: ${appInfo.commits.length} ${appInfo.commits.length === 1 ? 'zmiana' : 'zmian'}.` + (appInfo.canInstall ? '' : ' Instalacja wymaga uruchomienia panelu jako root.');
          appList.replaceChildren(...appInfo.commits.map((c) => h('li', {}, h('code', {}, c.hash), ' ', c.subject, c.date ? h('span', { class: 'tm-dim' }, ' · ' + new Date(c.date).toLocaleDateString('pl-PL')) : '')));
          appList.hidden = false;
          appUpdate.hidden = !appInfo.canInstall;
        } else {
          appMsg.className = 'upd-msg ok';
          appMsg.textContent = `Masz najnowszą wersję (sprawdzono ${new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}).`;
          appList.hidden = true;
          appUpdate.hidden = true;
        }
      } catch (err) {
        appMsg.className = 'upd-msg warn';
        appMsg.textContent = err.message;
      }
      setBusy(appCheck, false, 'Sprawdź aktualizacje');
    }

    async function updateApp() {
      const ok = await WD.confirm('Aktualizacja WebPulpit', 'Pobrać i zainstalować nową wersję? Panel uruchomi się ponownie (około minuty), a strona odświeży się sama. Otwarte okna terminala zostaną rozłączone.', { okLabel: 'Aktualizuj' });
      if (!ok) return;
      const prev = (await loadVersion() || {}).commit;
      try {
        await api.post('/api/update/app');
      } catch (err) { return WD.error(err); }
      appUpdate.hidden = true;
      setBusy(appCheck, true, 'Aktualizowanie…');
      appMsg.className = 'upd-msg';
      appMsg.textContent = 'Instalowanie aktualizacji…';
      followJob('app', appLog, appMsg, prev);
    }

    async function checkSystem() {
      setBusy(sysCheck, true, 'Sprawdzanie…');
      sysMsg.className = 'upd-msg';
      sysMsg.textContent = 'Pobieranie listy pakietów (apt update) — to może potrwać do minuty…';
      try {
        const r = await api.get('/api/update/system');
        const n = r.packages.length;
        const sec = r.packages.filter((p) => p.security).length;
        if (n) {
          sysMsg.textContent = `Dostępne aktualizacje: ${n}` + (sec ? `, w tym bezpieczeństwa: ${sec}` : '') + '.';
          sysList.replaceChildren(...r.packages.slice(0, 300).map((p) => h('li', {}, h('strong', {}, p.name), ` ${p.from} → ${p.version}`, p.security ? h('span', { class: 'badge' }, 'bezpieczeństwo') : null)));
          sysList.hidden = false;
          sysUpdate.hidden = !r.canInstall;
        } else {
          sysMsg.className = 'upd-msg ok';
          sysMsg.textContent = 'System jest aktualny.';
          sysList.hidden = true;
          sysUpdate.hidden = true;
        }
        if (r.warnings && r.warnings.length) {
          sysMsg.append(h('div', { class: 'upd-msg warn' }, 'Ostrzeżenia apt: ' + r.warnings.join(' | ')));
        }
        rebootBox.hidden = !r.rebootRequired;
      } catch (err) {
        sysMsg.className = 'upd-msg warn';
        sysMsg.textContent = err.message;
      }
      setBusy(sysCheck, false, 'Sprawdź aktualizacje');
    }

    async function upgradeSystem() {
      const ok = await WD.confirm('Aktualizacja systemu', 'Zainstalować wszystkie dostępne aktualizacje pakietów Ubuntu? Możesz dalej korzystać z panelu w trakcie.', { okLabel: 'Zainstaluj' });
      if (!ok) return;
      try { await api.post('/api/update/system'); } catch (err) { return WD.error(err); }
      sysUpdate.hidden = true;
      setBusy(sysCheck, true, 'Instalowanie…');
      sysMsg.className = 'upd-msg';
      sysMsg.textContent = 'Instalowanie aktualizacji systemu…';
      followJob('system', sysLog, sysMsg);
    }

    async function rebootServer() {
      const ok = await WD.confirm('Uruchom ponownie serwer', 'Na pewno uruchomić ponownie cały serwer? Wszystkie programy zostaną zamknięte, a panel będzie niedostępny przez około minutę.', { okLabel: 'Uruchom ponownie', danger: true });
      if (!ok) return;
      try { await api.post('/api/reboot'); } catch (err) { return WD.error(err); }
      const msg = h('div', { class: 'upd-msg' }, 'Serwer uruchamia się ponownie… strona odświeży się sama.');
      WD.dialog({ title: 'Ponowne uruchamianie', body: msg, buttons: [{ label: 'OK', value: true, kind: 'primary' }] });
      await sleep(5000);
      waitForServer(msg);
    }

    // Polls a background job's log; for the app update it also waits for the restart.
    async function followJob(name, logEl, msgEl, prevCommit) {
      logEl.hidden = false;
      let failures = 0;
      while (!closed) {
        let st;
        try {
          st = await api.get('/api/update/job', { name });
          failures = 0;
        } catch {
          // During the app update the panel restarts, so requests fail for a while.
          if (name === 'app' && ++failures >= 2) {
            msgEl.textContent = 'Panel uruchamia się ponownie…';
            return waitForServer(msgEl, prevCommit);
          }
          await sleep(1500);
          continue;
        }
        logEl.textContent = st.log || '';
        logEl.scrollTop = logEl.scrollHeight;
        if (!st.running) {
          if (st.exitCode === 0) {
            msgEl.className = 'upd-msg ok';
            if (name === 'app') {
              msgEl.textContent = 'Zaktualizowano. Panel uruchamia się ponownie…';
              return waitForServer(msgEl, prevCommit);
            }
            msgEl.textContent = 'Aktualizacje zostały zainstalowane.';
            setBusy(sysCheck, false, 'Sprawdź aktualizacje');
            checkSystem();
          } else {
            msgEl.className = 'upd-msg warn';
            msgEl.textContent = `Aktualizacja nie powiodła się (kod ${st.exitCode}). Szczegóły w logu poniżej.`;
            setBusy(name === 'app' ? appCheck : sysCheck, false, 'Sprawdź aktualizacje');
          }
          return;
        }
        await sleep(1500);
      }
    }

    (async () => {
      await loadVersion();
      // Resume showing a job that is still running (e.g. the window was closed meanwhile).
      for (const [name, logEl, msgEl, b] of [['app', appLog, appMsg, appCheck], ['system', sysLog, sysMsg, sysCheck]]) {
        try {
          const st = await api.get('/api/update/job', { name });
          if (st.running) {
            setBusy(b, true, name === 'app' ? 'Aktualizowanie…' : 'Instalowanie…');
            msgEl.textContent = 'Trwa aktualizacja…';
            followJob(name, logEl, msgEl, name === 'app' ? (await loadVersion() || {}).commit : undefined);
          }
        } catch { /* ignore */ }
      }
      checkApp();
    })();
    return win;
  }

  // Quietly check for a new WebPulpit version at most every 12 hours.
  WD.backgroundUpdateCheck = async function () {
    const last = WD.settings.get('upd.lastCheck', 0);
    if (Date.now() - last < 12 * 3600 * 1000) return;
    WD.settings.set('upd.lastCheck', Date.now());
    try {
      const r = await api.get('/api/update/app');
      if (r.supported && r.available) {
        WD.toast(h('span', {}, 'Dostępna nowa wersja WebPulpit. ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); launch(); } }, 'Otwórz Aktualizacje')), '', 10000);
      }
    } catch { /* offline or not supported */ }
  };

  WD.apps = WD.apps || {};
  WD.apps.updates = { name: 'Aktualizacje', icon: 'updates', launch };
})(window.WD);
