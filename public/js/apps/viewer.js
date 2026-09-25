'use strict';
/* Media viewer: images (with previous/next and zoom), video, audio, PDF. */
(function (WD) {
  const { h, api, path: P } = WD;

  async function launch(opts) {
    let filePath = opts.path;
    let siblings = [];
    const stage = h('div', { class: 'viewer' });
    const counter = h('span', { style: { marginLeft: '8px', color: 'var(--text-2)', fontSize: '12px' } });
    const btnPrev = h('button', { class: 'tbtn', title: 'Poprzedni (←)', html: WD.glyph('back'), onclick: () => step(-1) });
    const btnNext = h('button', { class: 'tbtn', title: 'Następny (→)', html: WD.glyph('forward'), onclick: () => step(1) });
    const btnActual = h('button', { class: 'tbtn', title: 'Rozmiar rzeczywisty / dopasuj', html: WD.glyph('fit') });
    const toolbar = h('div', { class: 'toolbar' }, btnPrev, btnNext, btnActual, counter, h('span', { style: { flex: '1' } }),
      h('button', { class: 'tbtn', title: 'Pobierz', html: WD.glyph('download'), onclick: () => WD.download([filePath]) }),
      h('button', { class: 'tbtn', title: 'Otwórz w nowej karcie', html: WD.glyph('open'), onclick: () => window.open(api.rawUrl(filePath), '_blank', 'noopener') }));

    const win = WD.wm.open({
      app: 'viewer',
      title: P.base(filePath),
      icon: WD.appIcon('viewer'),
      width: 860,
      height: 600
    });
    win.body.append(toolbar, stage);
    win.body.tabIndex = 0;
    win.body.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    });

    function show() {
      const entry = { name: P.base(filePath), type: 'file' };
      const type = WD.fileType(entry);
      win.setTitle(P.base(filePath) + ' — Podgląd');
      stage.textContent = '';
      const src = api.rawUrl(filePath);
      btnActual.hidden = type !== 'image';
      if (type === 'image') {
        const img = h('img', { src, alt: entry.name });
        btnActual.onclick = () => img.classList.toggle('actual');
        img.addEventListener('dblclick', () => img.classList.toggle('actual'));
        stage.append(img);
      } else if (type === 'video') {
        stage.append(h('video', { src, controls: true, autoplay: true }));
      } else if (type === 'audio') {
        stage.append(h('audio', { src, controls: true, autoplay: true }));
      } else if (type === 'pdf') {
        stage.append(h('iframe', { src, title: entry.name }));
      }
      updateNav();
      win.body.focus();
    }

    function updateNav() {
      const idx = siblings.indexOf(filePath);
      btnPrev.disabled = btnNext.disabled = siblings.length < 2;
      counter.textContent = siblings.length > 1 && idx >= 0 ? `${idx + 1} / ${siblings.length}` : '';
    }

    function step(d) {
      if (siblings.length < 2) return;
      const idx = siblings.indexOf(filePath);
      filePath = siblings[(idx + d + siblings.length) % siblings.length];
      show();
    }

    show();
    // Collect other files of the same kind in the folder for previous/next.
    try {
      const listing = await api.get('/api/list', { path: P.dir(filePath) });
      const kind = opts.type;
      const coll = new Intl.Collator('pl', { numeric: true, sensitivity: 'base' });
      siblings = listing.entries
        .filter((e) => e.type === 'file' && WD.fileType(e) === kind)
        .sort((a, b) => coll.compare(a.name, b.name))
        .map((e) => P.join(listing.path, e.name));
      updateNav();
    } catch { /* prev/next just stays disabled */ }
    return win;
  }

  WD.apps = WD.apps || {};
  WD.apps.viewer = { name: 'Podgląd', icon: 'viewer', launch, hidden: true };
})(window.WD);
