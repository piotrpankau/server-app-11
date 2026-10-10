'use strict';
/* Emperor's Gambit: every deployed web build in one list. Run it in a new tab or inside a
   window, grab the APK, copy the link, name and pin versions, remove old ones (admin).
   New deploys appear on their own - the server scans the sites Caddy serves. */
(function (WD) {
  const { h, api, fmt } = WD;

  const ago = (ms) => {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 90) return 'przed chwilą';
    if (s < 3600) return `${Math.round(s / 60)} min temu`;
    if (s < 86400) return `${Math.round(s / 3600)} godz. temu`;
    return `${Math.round(s / 86400)} dni temu`;
  };

  // The game in a panel window. /play/ always leads to the current build; the page itself offers
  // "Aktualizuj teraz" when a newer one is deployed while it is open.
  function play(url, title) {
    const frame = h('iframe', { src: url, allow: 'fullscreen; autoplay; gamepad', style: { width: '100%', height: '100%', border: '0', background: '#000' } });
    const w = WD.wm.open({ app: 'gambit-play', title, icon: WD.appIcon('gambit'), width: 480, height: 820 });
    w.body.style.padding = '0';
    w.body.append(frame);
    return w;
  }

  // Hosting customers: one button, always the current version - nothing to choose, nothing to update.
  function launchClient() {
    const existing = WD.wm.find((w) => w.app === 'gambit');
    if (existing) { existing.focus(); return existing; }
    let closed = false;
    let timer = null;
    let cur = null;
    const info = h('div', { class: 'gb-sub' }, 'Sprawdzam wersję gry…');
    const playBtn = h('button', { class: 'btn primary', disabled: true, onclick: () => play('/play/', 'Emperor\'s Gambit') }, 'Graj');
    const tabBtn = h('button', { class: 'btn', disabled: true, onclick: () => window.open('/play/', '_blank', 'noopener') }, 'Graj w nowej karcie');
    const apk = h('div', { class: 'gb-hint tm-dim' });
    const root = h('div', { class: 'gb' },
      h('div', { class: 'gb-card' },
        h('div', { class: 'gb-main' }, h('div', { class: 'gb-title' }, 'Emperor\'s Gambit'), info),
        h('div', { class: 'gb-btns' }, playBtn, tabBtn)),
      h('div', { class: 'gb-hint tm-dim' }, 'Gra aktualizuje się sama: zawsze uruchamia się najnowsza wersja. Jeśli nowa wyjdzie, gdy grasz, w grze pojawi się przycisk „Aktualizuj teraz”.'),
      apk);
    const win = WD.wm.open({ app: 'gambit', title: 'Emperor\'s Gambit', icon: WD.appIcon('gambit'), width: 560, height: 330, onClose: () => { closed = true; clearTimeout(timer); } });
    win.body.append(root);

    async function load() {
      try {
        cur = await api.get('/api/gambit/current');
        if (!cur) info.textContent = 'Gra nie jest jeszcze dostępna na serwerze.';
        else info.textContent = `Wersja ${cur.label} · zaktualizowana ${ago(cur.mtime)}`;
        playBtn.disabled = tabBtn.disabled = !cur;
        apk.replaceChildren(...(cur && cur.apkUrl ? ['Na telefon z Androidem: ', h('a', { href: cur.apkUrl, target: '_blank', rel: 'noopener' }, `pobierz APK (${fmt.size(cur.apk.size)})`),
          '. Aplikacja z APK nie aktualizuje się sama – po aktualizacji pobierz ją ponownie albo graj w przeglądarce.'] : []));
      } catch (err) { info.textContent = 'Nie udało się sprawdzić wersji gry.'; }
      if (!closed) timer = setTimeout(load, 30000);
    }
    load();
    return win;
  }

  function launch() {
    if (WD.info.role === 'client') return launchClient();
    const existing = WD.wm.find((w) => w.app === 'gambit');
    if (existing) { existing.focus(); return existing; }

    let builds = [];
    let forClients = null;
    let query = '';
    let closed = false;
    let timer = null;
    const isAdmin = WD.info.role === 'admin';

    const search = h('input', { class: 'field', placeholder: 'Szukaj wersji (np. 0.8.2, P, v07)…', spellcheck: 'false', style: { flex: 1 } });
    search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); render(); });
    const latestBtn = h('button', { class: 'btn primary', onclick: () => { const b = newest(); if (b) open(b); } }, 'Uruchom najnowszą');
    const list = h('div', { class: 'gb-list' });
    // Which build hosting customers get. "auto" = always the newest, so their game updates with each deploy.
    const clientSel = h('select', { class: 'field', style: { flex: 1 }, onchange: () => setClients(clientSel.value) });
    const clientBar = h('div', { class: 'gb-bar' }, h('span', { class: 'tm-dim', style: { alignSelf: 'center' } }, 'Klienci hostingu grają w:'), clientSel);
    const root = h('div', { class: 'gb' },
      h('div', { class: 'gb-bar' }, search, latestBtn, h('button', { class: 'btn', title: 'Odśwież listę', onclick: () => load(true) }, 'Odśwież')),
      isAdmin ? clientBar : null,
      h('div', { class: 'gb-hint tm-dim' }, '„Uruchom” otwiera stronę testową (login „gracz”), „W oknie” gra przez panel bez osobnego hasła. Nowe wersje pojawiają się tu same po deployu.'),
      list);
    const win = WD.wm.open({ app: 'gambit', title: 'Emperor\'s Gambit', icon: WD.appIcon('gambit'), width: 860, height: 620, onClose: () => { closed = true; clearTimeout(timer); } });
    win.body.append(root);

    const newest = () => builds.slice().sort((a, b) => b.mtime - a.mtime)[0];
    const open = (b) => window.open(b.url, '_blank', 'noopener');

    const playIn = (b) => play(`/play/${b.id}/`, `${b.label} – Emperor's Gambit`);

    async function setClients(value) {
      try {
        forClients = await api.post('/api/gambit/clients', value === 'auto' ? { mode: 'auto' } : { mode: 'fixed', id: value });
        WD.toast(value === 'auto' ? 'Klienci grają zawsze w najnowszą wersję' : `Klienci grają w „${forClients.label}”`, 'ok');
        render();
      } catch (err) { WD.error(err); }
    }

    async function copy(text) {
      try { await navigator.clipboard.writeText(text); WD.toast('Skopiowano link', 'ok'); } catch { WD.toast(text); }
    }

    async function edit(b) {
      const label = h('input', { class: 'field', value: b.label, maxlength: 60 });
      const note = h('input', { class: 'field', value: b.note || '', maxlength: 300, placeholder: 'np. linie + balans, do testu z Michałem' });
      const pin = h('input', { type: 'checkbox', checked: b.pinned });
      const v = await WD.dialog({
        title: 'Opis wersji', body: h('div', {}, h('label', {}, 'Nazwa'), label, h('label', {}, 'Notatka'), note,
          h('label', { class: 'tm-radio', style: { marginTop: '10px' } }, pin, ' Przypnij na górze listy'),
          h('div', { class: 'tm-dim', style: { marginTop: '8px' } }, b.url)),
        buttons: [{ label: 'Zapisz', value: 'ok', kind: 'primary' }, { label: 'Anuluj', value: null }], onOpen: () => label.focus()
      });
      if (v !== 'ok') return;
      try { await api.post('/api/gambit/meta', { id: b.id, label: label.value, note: note.value, pinned: pin.checked }); load(true); } catch (err) { WD.error(err); }
    }

    async function del(b) {
      if (!(await WD.confirm('Usuń wersję', `Usunąć z serwera „${b.label}” (${b.url})? Plik APK i build znikną bezpowrotnie. Można je odtworzyć tylko ponownym deployem.`, { okLabel: 'Usuń', danger: true }))) return;
      try { await api.post('/api/gambit/delete', { id: b.id }); WD.toast('Usunięto wersję', 'ok'); load(true); } catch (err) { WD.error(err); }
    }

    function card(b, isNewest) {
      return h('div', { class: 'gb-card' + (b.pinned ? ' pinned' : '') },
        h('div', { class: 'gb-main' },
          h('div', { class: 'gb-title' }, b.pinned ? h('span', { class: 'gb-pin', title: 'Przypięta' }, '★ ') : null, b.label,
            isNewest ? h('span', { class: 'gb-badge new' }, 'najnowsza') : null, b.isRoot ? h('span', { class: 'gb-badge' }, 'główny adres') : null,
            isAdmin && forClients && forClients.id === b.id ? h('span', { class: 'gb-badge', title: 'W tę wersję grają klienci hostingu' }, 'klienci') : null),
          h('div', { class: 'gb-sub' }, `wdrożona ${ago(b.mtime)} (${fmt.date(b.mtime)}) · ${fmt.size(b.size)}${b.apk ? ' · APK ' + fmt.size(b.apk.size) : ''}`),
          b.note ? h('div', { class: 'gb-note' }, b.note) : null,
          h('div', { class: 'gb-url' }, b.url.replace(/^https?:\/\//, ''))),
        h('div', { class: 'gb-btns' },
          h('button', { class: 'btn primary', onclick: () => open(b) }, 'Uruchom'),
          h('button', { class: 'btn', title: 'Uruchom w oknie panelu', onclick: () => playIn(b) }, 'W oknie'),
          b.apkUrl ? h('a', { class: 'btn', href: b.apkUrl, title: 'Pobierz APK na telefon', target: '_blank', rel: 'noopener' }, 'APK') : null,
          h('button', { class: 'btn', onclick: () => copy(b.url) }, 'Link'),
          isAdmin ? h('button', { class: 'btn', title: 'Nazwa, notatka, przypięcie', onclick: () => edit(b) }, 'Opis') : null,
          isAdmin && b.removable ? h('button', { class: 'btn danger-outline', title: 'Usuń tę wersję z serwera', onclick: () => del(b) }, 'Usuń') : null));
    }

    function render() {
      const n = newest();
      const shown = builds.filter((b) => !query || `${b.label} ${b.rel} ${b.host} ${b.note}`.toLowerCase().includes(query));
      list.replaceChildren(...shown.map((b) => card(b, n && b.id === n.id)));
      if (!shown.length) list.append(h('div', { class: 'gm-welcome' }, builds.length ? 'Brak wersji pasujących do wyszukiwania.' : 'Nie znaleziono żadnej wersji gry na tym serwerze.'));
      latestBtn.disabled = !n;
      win.setTitle && win.setTitle(`Emperor's Gambit (${builds.length})`);
      if (isAdmin && document.activeElement !== clientSel) {
        const auto = !forClients || forClients.mode !== 'fixed';
        clientSel.replaceChildren(
          h('option', { value: 'auto' }, `Zawsze najnowsza – gra aktualizuje się sama${auto && forClients ? ` (teraz: ${forClients.label})` : ''}`),
          ...builds.map((b) => h('option', { value: b.id }, `Tylko: ${b.label}`)));
        clientSel.value = auto ? 'auto' : forClients.id;
      }
    }

    async function load(fresh) {
      try {
        [builds, forClients] = await Promise.all([
          api.get('/api/gambit/builds', fresh ? { fresh: '1' } : undefined),
          isAdmin ? api.get('/api/gambit/current') : Promise.resolve(null)
        ]);
        render();
      } catch (err) { if (fresh) WD.error(err); }
      if (!closed) { clearTimeout(timer); timer = setTimeout(() => load(false), 15000); }
    }
    load(true);
    return win;
  }

  WD.apps = WD.apps || {};
  WD.apps.gambit = { name: "Emperor's Gambit", icon: 'gambit', launch };
})(window.WD);
