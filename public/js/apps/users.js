'use strict';
/* Users ("Użytkownicy"): admin manages panel accounts. */
(function (WD) {
  const { h, api } = WD;

  function launch() {
    const existing = WD.wm.find((w) => w.app === 'users');
    if (existing) return existing.focus();

    let list = [];
    let games = [];
    const body = h('div', { class: 'us-body' });
    const win = WD.wm.open({ app: 'users', title: 'Użytkownicy', icon: WD.appIcon('people'), width: 720, height: 560 });
    win.body.append(h('div', { class: 'settings' },
      h('div', { class: 'us-head' }, h('h3', { style: { margin: 0 } }, 'Konta panelu'),
        h('button', { class: 'btn primary', onclick: () => editUser(null) }, '+ Dodaj użytkownika')),
      h('p', { class: 'about' }, 'Administrator ma pełny dostęp. Zwykły użytkownik widzi tylko aplikację „Serwery gier” i przypisane mu serwery – bez terminala, plików i ustawień systemu.'),
      body));

    async function refresh() {
      try {
        [list, games] = await Promise.all([api.get('/api/users'), api.get('/api/games').catch(() => [])]);
      } catch (err) { return WD.error(err); }
      render();
    }

    function render() {
      body.replaceChildren(...list.map((u) => h('div', { class: 'us-row' },
        h('span', { class: 'avatar us-av' }, (u.username[0] || '?')),
        h('div', { class: 'us-info' },
          h('div', { class: 'us-name' }, u.username, u.id === WD.info.uid ? h('span', { class: 'ss-badge' }, 'to Ty') : null),
          h('div', { class: 'us-sub' }, u.role === 'admin' ? 'Administrator' : `Użytkownik · serwery: ${u.games && u.games.length ? u.games.length : 'brak'}`)),
        h('div', { class: 'us-actions' },
          h('button', { class: 'tbtn', title: 'Edytuj', html: WD.glyph('rename'), onclick: () => editUser(u) }),
          h('button', { class: 'tbtn', title: 'Usuń', html: WD.glyph('trash'), onclick: () => del(u) }))
      )));
      if (!list.length) body.append(h('div', { class: 'ex-empty' }, 'Brak kont'));
    }

    async function editUser(u) {
      const isNew = !u;
      const nameI = h('input', { class: 'field', value: u ? u.username : '', placeholder: 'login', spellcheck: 'false', disabled: !isNew });
      const passI = h('input', { class: 'field', type: 'password', placeholder: isNew ? 'hasło (min. 8 znaków)' : 'nowe hasło (puste = bez zmiany)', autocomplete: 'new-password' });
      const roleSel = h('select', { class: 'field' }, h('option', { value: 'user', selected: u && u.role === 'user' }, 'Użytkownik (tylko serwery gier)'), h('option', { value: 'admin', selected: u && u.role === 'admin' }, 'Administrator (pełny dostęp)'));
      const gameBoxes = games.map((g) => {
        const cb = h('input', { type: 'checkbox', value: g.id, checked: u && u.games && u.games.includes(g.id) });
        return h('label', { class: 'tm-radio' }, cb, ` ${g.name} `, h('span', { class: 'tm-dim' }, `(${g.templateLabel})`));
      });
      const gamesWrap = h('div', { class: 'us-games', hidden: roleSel.value === 'admin' },
        h('div', { class: 'tm-dim', style: { margin: '6px 0' } }, games.length ? 'Serwery, którymi może zarządzać ten użytkownik:' : 'Nie ma jeszcze żadnych serwerów gier.'), ...gameBoxes);
      roleSel.addEventListener('change', () => { gamesWrap.hidden = roleSel.value === 'admin'; });
      const v = await WD.dialog({
        title: isNew ? 'Nowy użytkownik' : `Edytuj: ${u.username}`,
        body: h('div', {}, h('label', {}, 'Login'), nameI, h('label', {}, 'Hasło'), passI, h('label', {}, 'Rola'), roleSel, gamesWrap),
        buttons: [{ label: 'Zapisz', value: 'save', kind: 'primary' }, { label: 'Anuluj', value: null }],
        onOpen: () => (isNew ? nameI : passI).focus()
      });
      if (v !== 'save') return;
      const chosenGames = gameBoxes.filter((b) => b.querySelector('input').checked).map((b) => b.querySelector('input').value);
      try {
        if (isNew) await api.post('/api/users', { username: nameI.value, password: passI.value, role: roleSel.value, games: chosenGames });
        else {
          const patch = { id: u.id, role: roleSel.value, games: chosenGames };
          if (passI.value) patch.password = passI.value;
          await api.post('/api/users/update', patch);
        }
        WD.toast('Zapisano', 'ok');
        refresh();
      } catch (err) { WD.error(err); }
    }

    async function del(u) {
      if (u.id === WD.info.uid) return WD.toast('Nie możesz usunąć własnego konta', 'error');
      if (!(await WD.confirm('Usuń użytkownika', `Usunąć konto „${u.username}”? Zostanie natychmiast wylogowany.`, { okLabel: 'Usuń', danger: true }))) return;
      try { await api.post('/api/users/delete', { id: u.id }); refresh(); } catch (err) { WD.error(err); }
    }

    refresh();
    return win;
  }

  WD.apps = WD.apps || {};
  WD.apps.users = { name: 'Użytkownicy', icon: 'people', launch };
})(window.WD);
