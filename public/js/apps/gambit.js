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

  function launch() {
    const existing = WD.wm.find((w) => w.app === 'gambit');
    if (existing) { existing.focus(); return existing; }

    let builds = [];
    let query = '';
    let closed = false;
    let timer = null;
    const isAdmin = WD.info.role === 'admin';

    const search = h('input', { class: 'field', placeholder: 'Szukaj wersji (np. 0.8.2, P, v07)…', spellcheck: 'false', style: { flex: 1 } });
    search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); render(); });
    const latestBtn = h('button', { class: 'btn primary', onclick: () => { const b = newest(); if (b) open(b); } }, 'Uruchom najnowszą');
    const list = h('div', { class: 'gb-list' });
    const root = h('div', { class: 'gb' },
      h('div', { class: 'gb-bar' }, search, latestBtn, h('button', { class: 'btn', title: 'Odśwież listę', onclick: () => load(true) }, 'Odśwież')),
      h('div', { class: 'gb-hint tm-dim' }, 'Strona testowa prosi o login „gracz” i hasło (przeglądarka je zapamięta). Nowe wersje pojawiają się tu same po deployu.'),
      list);
    const win = WD.wm.open({ app: 'gambit', title: 'Emperor\'s Gambit', icon: WD.appIcon('gambit'), width: 860, height: 620, onClose: () => { closed = true; clearTimeout(timer); } });
    win.body.append(root);

    const newest = () => builds.slice().sort((a, b) => b.mtime - a.mtime)[0];
    const open = (b) => window.open(b.url, '_blank', 'noopener');

    function play(b) {
      const frame = h('iframe', { src: b.url, allow: 'fullscreen; autoplay; gamepad', style: { width: '100%', height: '100%', border: '0', background: '#000' } });
      const w = WD.wm.open({ app: 'gambit-play', title: `${b.label} – Emperor's Gambit`, icon: WD.appIcon('gambit'), width: 480, height: 820 });
      w.body.style.padding = '0';
      w.body.append(frame);
      WD.toast('Jeśli okno jest puste, otwórz wersję raz w nowej karcie i zaloguj się, potem wróć tutaj.', '', 6000);
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
            isNewest ? h('span', { class: 'gb-badge new' }, 'najnowsza') : null, b.isRoot ? h('span', { class: 'gb-badge' }, 'główny adres') : null),
          h('div', { class: 'gb-sub' }, `wdrożona ${ago(b.mtime)} (${fmt.date(b.mtime)}) · ${fmt.size(b.size)}${b.apk ? ' · APK ' + fmt.size(b.apk.size) : ''}`),
          b.note ? h('div', { class: 'gb-note' }, b.note) : null,
          h('div', { class: 'gb-url' }, b.url.replace(/^https?:\/\//, ''))),
        h('div', { class: 'gb-btns' },
          h('button', { class: 'btn primary', onclick: () => open(b) }, 'Uruchom'),
          h('button', { class: 'btn', title: 'Uruchom w oknie panelu', onclick: () => play(b) }, 'W oknie'),
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
    }

    async function load(fresh) {
      try { builds = await api.get('/api/gambit/builds', fresh ? { fresh: '1' } : undefined); render(); } catch (err) { if (fresh) WD.error(err); }
      if (!closed) { clearTimeout(timer); timer = setTimeout(() => load(false), 15000); }
    }
    load(true);
    return win;
  }

  WD.apps = WD.apps || {};
  WD.apps.gambit = { name: "Emperor's Gambit", icon: 'gambit', launch };
})(window.WD);
