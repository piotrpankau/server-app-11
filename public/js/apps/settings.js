'use strict';
/* Settings ("Ustawienia"): theme, wallpaper, password. */
(function (WD) {
  const { h, api } = WD;

  WD.WALLPAPERS = [
    'linear-gradient(135deg, #0f3d7a 0%, #1b6fc2 45%, #5aa7e6 100%)',
    'radial-gradient(ellipse at 30% 20%, #3a7bd5 0%, #0b1d3a 70%)',
    'linear-gradient(135deg, #1d2b64 0%, #7b4397 100%)',
    'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)',
    'linear-gradient(135deg, #e96443 0%, #904e95 100%)',
    'linear-gradient(135deg, #134e5e 0%, #71b280 100%)',
    'linear-gradient(135deg, #232526 0%, #414345 100%)',
    'linear-gradient(160deg, #772953 0%, #e95420 100%)'
  ];

  WD.applyAppearance = function () {
    const theme = WD.settings.get('theme', 'system');
    const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const wp = WD.settings.get('wallpaper', 0);
    document.getElementById('desktop').style.background = WD.WALLPAPERS[wp] || WD.WALLPAPERS[0];
  };
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => WD.applyAppearance());

  function launch() {
    const existing = WD.wm.find((w) => w.app === 'settings');
    if (existing) return existing.focus();

    const seg = (key, options, def) => {
      const wrap = h('div', { class: 'seg' });
      const cur = WD.settings.get(key, def);
      for (const [value, label] of options) {
        const b = h('button', { class: value === cur ? 'on' : '' }, label);
        b.addEventListener('click', () => {
          WD.settings.set(key, value);
          for (const x of wrap.children) x.classList.remove('on');
          b.classList.add('on');
          WD.applyAppearance();
        });
        wrap.append(b);
      }
      return wrap;
    };

    const walls = h('div', { class: 'wall-grid' });
    const curWp = WD.settings.get('wallpaper', 0);
    WD.WALLPAPERS.forEach((bg, i) => {
      const w = h('button', { class: 'wall' + (i === curWp ? ' on' : ''), style: { background: bg }, title: 'Tapeta ' + (i + 1) });
      w.addEventListener('click', () => {
        WD.settings.set('wallpaper', i);
        for (const x of walls.children) x.classList.remove('on');
        w.classList.add('on');
        WD.applyAppearance();
      });
      walls.append(w);
    });

    const oldPw = h('input', { class: 'field', type: 'password', placeholder: 'Obecne hasło', autocomplete: 'current-password' });
    const newPw = h('input', { class: 'field', type: 'password', placeholder: 'Nowe hasło (min. 8 znaków)', autocomplete: 'new-password' });
    const newPw2 = h('input', { class: 'field', type: 'password', placeholder: 'Powtórz nowe hasło', autocomplete: 'new-password' });
    const pwBtn = h('button', { class: 'btn primary', style: { justifySelf: 'start' } }, 'Zmień hasło');
    pwBtn.addEventListener('click', async () => {
      if (newPw.value !== newPw2.value) return WD.toast('Nowe hasła się różnią', 'error');
      try {
        await api.post('/api/password', { oldPassword: oldPw.value, newPassword: newPw.value });
        oldPw.value = newPw.value = newPw2.value = '';
        WD.toast('Hasło zostało zmienione', 'ok');
      } catch (err) { WD.error(err); }
    });

    const info = WD.info;
    const root = h('div', { class: 'settings' },
      h('h3', {}, 'Motyw'),
      seg('theme', [['light', 'Jasny'], ['dark', 'Ciemny'], ['system', 'Systemowy']], 'system'),
      h('h3', {}, 'Tapeta'),
      walls,
      h('h3', {}, 'Hasło do panelu'),
      h('div', { class: 'pw-form' }, oldPw, newPw, newPw2, pwBtn),
      h('h3', {}, 'Aktualizacje'),
      h('div', { class: 'upd-row' }, h('span', { class: 'grow about' }, 'Aktualizacje WebPulpit (z GitHuba) i systemu Ubuntu.'),
        h('button', { class: 'btn primary', onclick: () => WD.apps.updates.launch() }, 'Otwórz Aktualizacje')),
      h('h3', {}, 'Informacje'),
      h('div', { class: 'about' },
        h('div', {}, `Serwer: ${info.hostname}`),
        h('div', {}, `Zalogowano jako: ${info.username}`),
        h('div', {}, `Pliki i terminal działają jako użytkownik systemowy: ${info.systemUser}`),
        h('div', {}, `Folder domowy: ${info.home}`),
        h('div', {}, 'WebPulpit ' + (WD.info.version || '')))
    );

    const win = WD.wm.open({ app: 'settings', title: 'Ustawienia', icon: WD.appIcon('settings'), width: 560, height: 600 });
    win.body.append(root);
    return win;
  }

  WD.apps = WD.apps || {};
  WD.apps.settings = { name: 'Ustawienia', icon: 'settings', launch };
})(window.WD);
