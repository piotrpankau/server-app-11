'use strict';
/* Text editor ("Notatnik") with line numbers, Ctrl+S save and word wrap. */
(function (WD) {
  const { h, api, path: P } = WD;

  async function launch(opts = {}) {
    // Re-use an already open editor for the same file.
    const existing = opts.path && WD.wm.find((w) => w.app === 'editor' && w.filePath === opts.path);
    if (existing) return existing.focus();

    let filePath = opts.path || null;
    let saved = '';
    let dirty = false;
    let lineCount = 0;

    const gutter = h('div', { class: 'gutter' }, '1');
    const ta = h('textarea', { spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off' });
    const wrapOn = WD.settings.get('ed.wrap', false);
    if (wrapOn) ta.classList.add('wrap');
    const pos = h('span', {}, 'Wiersz 1, kolumna 1');
    const info = h('span', {}, '');

    const saveBtn = h('button', { class: 'tbtn', title: 'Zapisz (Ctrl+S)', onclick: () => save() },
      h('span', { html: WD.glyph('save'), style: { display: 'inline-flex' } }), 'Zapisz');
    const saveAsBtn = h('button', { class: 'tbtn', title: 'Zapisz jako…', onclick: () => save(true) }, 'Zapisz jako…');
    const wrapBtn = h('button', { class: 'tbtn' + (wrapOn ? ' on' : ''), title: 'Zawijanie wierszy', html: WD.glyph('wrap') });
    wrapBtn.addEventListener('click', () => {
      const on = ta.classList.toggle('wrap');
      wrapBtn.classList.toggle('on', on);
      gutter.hidden = on;
      WD.settings.set('ed.wrap', on);
    });
    gutter.hidden = wrapOn;
    const dlBtn = h('button', { class: 'tbtn', title: 'Pobierz', html: WD.glyph('download'), onclick: () => filePath && WD.download([filePath]) });

    const win = WD.wm.open({
      app: 'editor',
      title: 'Notatnik',
      icon: WD.appIcon('editor'),
      width: 820,
      height: 560,
      onFocus: () => ta.focus(),
      onClose: async () => {
        if (!dirty) return true;
        const v = await WD.dialog({
          title: 'Notatnik',
          body: `Czy zapisać zmiany w „${filePath ? P.base(filePath) : 'Bez tytułu'}”?`,
          buttons: [{ label: 'Zapisz', value: 'save', kind: 'primary' }, { label: 'Nie zapisuj', value: 'discard' }, { label: 'Anuluj', value: null }]
        });
        if (v === 'save') return save();
        return v === 'discard';
      }
    });
    win.filePath = filePath;
    win.body.append(
      h('div', { class: 'toolbar' }, saveBtn, saveAsBtn, h('span', { class: 'sep' }), wrapBtn, dlBtn),
      h('div', { class: 'editor' }, gutter, ta),
      h('div', { class: 'ex-status' }, pos, info)
    );

    function updateTitle() {
      win.setTitle(`${dirty ? '● ' : ''}${filePath ? P.base(filePath) : 'Bez tytułu'} — Notatnik`);
      info.textContent = filePath ? P.pretty(filePath) : '';
    }

    function updateGutter() {
      const lines = ta.value.split('\n').length;
      if (lineCount !== lines) {
        lineCount = lines;
        let s = '';
        for (let i = 1; i <= lines; i++) s += i + '\n';
        gutter.textContent = s;
      }
      gutter.scrollTop = ta.scrollTop;
    }

    function updatePos() {
      const before = ta.value.slice(0, ta.selectionStart);
      const line = before.split('\n').length;
      const col = ta.selectionStart - before.lastIndexOf('\n');
      pos.textContent = `Wiersz ${line}, kolumna ${col}`;
    }

    ta.addEventListener('input', () => {
      const d = ta.value !== saved;
      if (d !== dirty) { dirty = d; updateTitle(); }
      updateGutter();
    });
    ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
    ta.addEventListener('keyup', updatePos);
    ta.addEventListener('click', updatePos);
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save(e.shiftKey);
      } else if (e.key === 'Tab' && !e.ctrlKey) {
        e.preventDefault();
        document.execCommand('insertText', false, '    ');
      }
    });

    async function save(as) {
      let target = filePath;
      if (as || !target) {
        const dir = target ? P.dir(target) : WD.info.desktop;
        const name = await WD.prompt('Zapisz jako', `Pełna ścieżka pliku:`, P.join(dir, target ? P.base(target) : 'Nowy plik.txt'));
        if (!name) return false;
        target = name.replace(/^~(?=\/)/, WD.info.home);
      }
      try {
        await api.post('/api/write', { path: target, content: ta.value });
        filePath = win.filePath = target;
        saved = ta.value;
        dirty = false;
        updateTitle();
        WD.changed(P.dir(target));
        WD.toast('Zapisano', 'ok', 1500);
        return true;
      } catch (err) {
        WD.error(err);
        return false;
      }
    }

    updateTitle();
    if (filePath) {
      ta.disabled = true;
      ta.value = 'Wczytywanie…';
      try {
        const text = await api.get('/api/read', { path: filePath });
        if (text.includes('\u0000')) {
          const ok = await WD.confirm('Plik binarny', 'Ten plik wygląda na binarny (nie tekstowy). Edycja może go uszkodzić. Otworzyć mimo to?', { okLabel: 'Otwórz' });
          if (!ok) return win.close(true);
        }
        ta.value = saved = text;
      } catch (err) {
        WD.error(err);
        return win.close(true);
      }
      ta.disabled = false;
    }
    updateGutter();
    ta.focus();
    ta.setSelectionRange(0, 0);
    return win;
  }

  WD.apps = WD.apps || {};
  WD.apps.editor = { name: 'Notatnik', icon: 'editor', launch };
})(window.WD);
