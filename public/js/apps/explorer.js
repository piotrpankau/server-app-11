'use strict';
/* File Explorer ("Eksplorator plików") and file operations shared with the desktop. */
(function (WD) {
  const { h, api, path: P, fmt } = WD;
  const DRAG_TYPE = 'application/x-webpulpit-paths';

  // ================= Shared file operations =================
  const ops = WD.fileOps = {
    async open(fullPath, entry) {
      entry = entry || { name: P.base(fullPath), type: 'file' };
      const type = WD.fileType(entry);
      if (type === 'dir') return WD.apps.explorer.launch({ path: fullPath });
      if (type === 'image' || type === 'video' || type === 'audio' || type === 'pdf') return WD.apps.viewer.launch({ path: fullPath, type });
      if (type === 'text' || type === 'code') return WD.apps.editor.launch({ path: fullPath });
      if (WD.isArchive(entry.name)) {
        const v = await WD.dialog({
          title: entry.name,
          body: 'To jest archiwum. Co chcesz zrobić?',
          buttons: [{ label: 'Wypakuj tutaj', value: 'x', kind: 'primary' }, { label: 'Pobierz', value: 'd' }, { label: 'Anuluj', value: null }]
        });
        if (v === 'x') return ops.extract(fullPath);
        if (v === 'd') return WD.download([fullPath]);
        return;
      }
      const v = await WD.dialog({
        title: entry.name,
        body: 'Nie wiadomo, jak otworzyć ten plik w przeglądarce.',
        buttons: [{ label: 'Pobierz', value: 'd', kind: 'primary' }, { label: 'Otwórz w edytorze', value: 'e' }, { label: 'Anuluj', value: null }]
      });
      if (v === 'd') WD.download([fullPath]);
      if (v === 'e') WD.apps.editor.launch({ path: fullPath });
    },

    async newFolder(dir) {
      const name = await WD.prompt('Nowy folder', 'Nazwa folderu:', 'Nowy folder');
      if (!name) return null;
      if (!validName(name)) return null;
      try {
        await api.post('/api/mkdir', { path: P.join(dir, name) });
        WD.changed(dir);
        return name;
      } catch (err) { WD.error(err); return null; }
    },

    async newFile(dir) {
      const name = await WD.prompt('Nowy plik', 'Nazwa pliku:', 'Nowy plik.txt', { selectBase: true });
      if (!name || !validName(name)) return null;
      try {
        await api.post('/api/touch', { path: P.join(dir, name) });
        WD.changed(dir);
        return name;
      } catch (err) { WD.error(err); return null; }
    },

    async rename(fullPath) {
      const old = P.base(fullPath);
      const name = await WD.prompt('Zmień nazwę', 'Nowa nazwa:', old, { selectBase: true });
      if (!name || name === old || !validName(name)) return null;
      try {
        await api.post('/api/rename', { from: fullPath, to: P.join(P.dir(fullPath), name) });
        WD.changed(P.dir(fullPath));
        return name;
      } catch (err) { WD.error(err); return null; }
    },

    async remove(paths) {
      if (!paths.length) return false;
      const what = paths.length === 1 ? `„${P.base(paths[0])}”` : `${paths.length} elementy`;
      const ok = await WD.confirm('Usuń', `Czy na pewno trwale usunąć ${what}? Tej operacji nie można cofnąć.`, { okLabel: 'Usuń', danger: true });
      if (!ok) return false;
      try {
        await api.post('/api/delete', { paths });
        WD.changed(paths.map(P.dir));
        WD.toast(`Usunięto ${what}`, 'ok');
        return true;
      } catch (err) { WD.error(err); WD.changed(paths.map(P.dir)); return false; }
    },

    async transfer(mode, paths, dest) {
      if (!paths.length) return;
      if (mode === 'move' && paths.every((p) => P.dir(p) === dest)) return;
      try {
        await api.post(mode === 'copy' ? '/api/copy' : '/api/move', { paths, dest });
        WD.changed(dest, paths.map(P.dir));
      } catch (err) { WD.error(err); WD.changed(dest, paths.map(P.dir)); }
    },

    async paste(dest) {
      const { mode, paths } = WD.clipboard;
      if (!mode || !paths.length) return;
      if (mode === 'cut') {
        await ops.transfer('move', paths, dest);
        WD.setClipboard(null, []);
      } else {
        await ops.transfer('copy', paths, dest);
      }
    },

    async extract(fullPath) {
      WD.toast('Wypakowywanie…');
      try {
        const res = await api.post('/api/extract', { path: fullPath });
        WD.changed(P.dir(fullPath));
        WD.toast(`Wypakowano do „${P.base(res.path)}”`, 'ok');
      } catch (err) { WD.error(err); }
    },

    async compress(paths) {
      if (!paths.length) return;
      const def = paths.length === 1 ? P.base(paths[0]) + '.zip' : 'Archiwum.zip';
      const name = await WD.prompt('Kompresuj do ZIP', 'Nazwa archiwum:', def, { selectBase: true });
      if (!name) return;
      WD.toast('Tworzenie archiwum…');
      try {
        const res = await api.post('/api/compress', { paths, dest: P.dir(paths[0]), name });
        WD.changed(P.dir(paths[0]));
        WD.toast(`Utworzono „${P.base(res.path)}”`, 'ok');
      } catch (err) { WD.error(err); }
    },

    async properties(fullPath) {
      let s;
      try { s = await api.get('/api/stat', { path: fullPath }); } catch (err) { return WD.error(err); }
      const modeInput = h('input', { class: 'field', value: (s.mode & 0o7777).toString(8).padStart(3, '0'), style: { width: '90px', marginTop: 0 } });
      const body = h('div', {},
        h('dl', { class: 'props' },
          h('dt', {}, 'Nazwa'), h('dd', {}, P.base(fullPath)),
          h('dt', {}, 'Lokalizacja'), h('dd', {}, P.dir(fullPath)),
          h('dt', {}, 'Typ'), h('dd', {}, s.type === 'dir' ? 'Folder' : (P.ext(fullPath).toUpperCase() || 'Plik')),
          s.type !== 'dir' ? [h('dt', {}, 'Rozmiar'), h('dd', {}, `${fmt.size(s.size)} (${s.size.toLocaleString('pl-PL')} bajtów)`)] : null,
          h('dt', {}, 'Zmodyfikowano'), h('dd', {}, fmt.date(s.mtime)),
          h('dt', {}, 'Uprawnienia'), h('dd', {}, fmt.mode(s.mode)),
          h('dt', {}, 'chmod'), h('dd', {}, modeInput)
        ));
      const v = await WD.dialog({
        title: 'Właściwości',
        body,
        buttons: [{ label: 'Zapisz', value: 'save', kind: 'primary' }, { label: 'Zamknij', value: null }]
      });
      if (v === 'save' && modeInput.value !== (s.mode & 0o7777).toString(8).padStart(3, '0')) {
        try {
          await api.post('/api/chmod', { path: fullPath, mode: modeInput.value });
          WD.changed(P.dir(fullPath));
          WD.toast('Zmieniono uprawnienia', 'ok');
        } catch (err) { WD.error(err); }
      }
    },

    copyPath(p) {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(p).then(() => WD.toast('Skopiowano ścieżkę'), () => WD.prompt('Ścieżka', '', p));
      } else {
        WD.prompt('Ścieżka', 'Skopiuj ścieżkę:', p);
      }
    },

    // Menu entries for a selection of items (used by explorer and desktop).
    itemMenu(paths, entries, { onOpen, cwd } = {}) {
      const single = paths.length === 1 ? entries[0] : null;
      const isDir = single && single.type === 'dir';
      return [
        { label: 'Otwórz', icon: 'open', key: 'Enter', action: () => (onOpen ? onOpen(paths[0], single) : ops.open(paths[0], single)), disabled: !single },
        isDir ? { label: 'Otwórz w nowym oknie', icon: 'open', action: () => WD.apps.explorer.launch({ path: paths[0] }) } : null,
        single && !isDir ? { label: 'Edytuj jako tekst', icon: 'edit', action: () => WD.apps.editor.launch({ path: paths[0] }) } : null,
        isDir ? { label: 'Otwórz w terminalu', icon: 'terminal', action: () => WD.apps.terminal.launch({ cwd: paths[0] }) } : null,
        '-',
        { label: 'Pobierz' + (paths.length > 1 || isDir ? ' (ZIP)' : ''), icon: 'download', action: () => WD.download(paths) },
        '-',
        { label: 'Wytnij', icon: 'cut', key: 'Ctrl+X', action: () => WD.setClipboard('cut', paths) },
        { label: 'Kopiuj', icon: 'copy', key: 'Ctrl+C', action: () => WD.setClipboard('copy', paths) },
        isDir && WD.clipboard.mode ? { label: 'Wklej do folderu', icon: 'paste', action: () => ops.paste(paths[0]) } : null,
        '-',
        single && WD.isArchive(single.name) ? { label: 'Wypakuj tutaj', icon: 'unzip', action: () => ops.extract(paths[0]) } : null,
        { label: 'Kompresuj do ZIP', icon: 'zip', action: () => ops.compress(paths) },
        '-',
        { label: 'Zmień nazwę', icon: 'rename', key: 'F2', action: () => ops.rename(paths[0]), disabled: !single },
        { label: 'Usuń', icon: 'trash', key: 'Del', danger: true, action: () => ops.remove(paths) },
        '-',
        { label: 'Kopiuj ścieżkę', icon: 'copy', action: () => ops.copyPath(paths.join('\n')) },
        { label: 'Właściwości', icon: 'info', action: () => ops.properties(paths[0]), disabled: !single }
      ];
    },

    backgroundMenu(dir, extra = []) {
      return [
        ...extra,
        { label: 'Wklej', icon: 'paste', key: 'Ctrl+V', action: () => ops.paste(dir), disabled: !WD.clipboard.mode },
        '-',
        { label: 'Nowy folder', icon: 'newfolder', action: () => ops.newFolder(dir) },
        { label: 'Nowy plik tekstowy', icon: 'newfile', action: () => ops.newFile(dir) },
        '-',
        { label: 'Wyślij pliki z komputera…', icon: 'upload', action: () => WD.pickAndUpload(dir, false) },
        { label: 'Wyślij folder z komputera…', icon: 'upload', action: () => WD.pickAndUpload(dir, true) },
        '-',
        { label: 'Otwórz terminal tutaj', icon: 'terminal', action: () => WD.apps.terminal.launch({ cwd: dir }) },
        { label: 'Właściwości folderu', icon: 'info', action: () => ops.properties(dir) }
      ];
    },

    // ----- Drag & drop between windows -----
    dragStart(e, paths, entries) {
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
      e.dataTransfer.setData('text/plain', paths.join('\n'));
      // Chrome/Edge/Brave: dragging a single file out of the browser onto the
      // Windows desktop downloads it.
      if (paths.length === 1 && entries[0] && entries[0].type !== 'dir') {
        const url = new URL(api.downloadUrl(paths), location.href).href;
        e.dataTransfer.setData('DownloadURL', `application/octet-stream:${entries[0].name}:${url}`);
      }
    },
    isInternalDrag: (e) => Array.from(e.dataTransfer.types || []).includes(DRAG_TYPE),
    canDrop: (e) => ops.isInternalDrag(e) || WD.hasOsFiles(e),
    // Handles a drop onto a folder: moves/copies internal items or uploads OS files.
    handleDrop(e, destDir) {
      if (ops.isInternalDrag(e)) {
        let paths = [];
        try { paths = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)); } catch { return; }
        paths = paths.filter((p) => p !== destDir);
        if (!paths.length) return;
        const mode = e.ctrlKey || e.altKey ? 'copy' : 'move';
        ops.transfer(mode, paths, destDir);
      } else if (WD.hasOsFiles(e)) {
        WD.uploadDrop(e, destDir);
      }
    }
  };

  function validName(name) {
    if (name.includes('/') || name === '.' || name === '..') {
      WD.toast('Nazwa nie może zawierać znaku „/”', 'error');
      return false;
    }
    return true;
  }

  // ================= Explorer window =================
  class Explorer {
    constructor(opts) {
      this.path = opts.path || WD.info.home;
      this.back = [];
      this.fwd = [];
      this.entries = [];
      this.selected = new Set();
      this.anchor = null;
      this.view = WD.settings.get('ex.view', 'grid');
      this.showHidden = WD.settings.get('ex.hidden', false);
      this.sort = WD.settings.get('ex.sort', { key: 'name', dir: 1 });
      this.filter = '';
      this.lastPointer = 'mouse';
      this.build();
      this.navigate(this.path, false);
      this.offFs = WD.on('fs-changed', (dirs) => { if (dirs.has(this.path)) this.scheduleRefresh(); });
      this.offClip = WD.on('clipboard', () => this.render());
    }

    build() {
      const tb = (icon, title, fn, cls = '') => h('button', { class: 'tbtn ' + cls, title, html: WD.glyph(icon), onclick: fn });
      this.btnBack = tb('back', 'Wstecz (Alt+←)', () => this.goBack());
      this.btnFwd = tb('forward', 'Dalej (Alt+→)', () => this.goFwd());
      this.btnUp = tb('up', 'W górę (Backspace)', () => this.goUp());
      this.address = h('input', { class: 'field ex-address', spellcheck: 'false', title: 'Wpisz ścieżkę i naciśnij Enter' });
      this.address.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.navigate(this.address.value.trim().replace(/^~(?=\/|$)/, WD.info.home) || '/'); }
        if (e.key === 'Escape') { this.address.value = this.path; this.content.focus(); }
      });
      this.search = h('input', { class: 'field ex-search', placeholder: 'Szukaj w folderze', type: 'search' });
      this.search.addEventListener('input', () => { this.filter = this.search.value.toLowerCase(); this.render(); });

      const nav = h('div', { class: 'ex-nav' }, this.btnBack, this.btnFwd, this.btnUp,
        tb('refresh', 'Odśwież (F5)', () => this.refresh()), this.address, this.search);

      const label = (icon, text, title, fn) => {
        const b = h('button', { class: 'tbtn', title: title || text, onclick: fn }, h('span', { html: WD.glyph(icon), style: { display: 'inline-flex' } }), h('span', { class: 'hide-sm' }, text));
        return b;
      };
      this.btnCut = tb('cut', 'Wytnij (Ctrl+X)', () => this.clip('cut'));
      this.btnCopy = tb('copy', 'Kopiuj (Ctrl+C)', () => this.clip('copy'));
      this.btnPaste = tb('paste', 'Wklej (Ctrl+V)', () => ops.paste(this.path));
      this.btnRename = tb('rename', 'Zmień nazwę (F2)', () => this.renameSelected());
      this.btnDelete = tb('trash', 'Usuń (Delete)', () => this.deleteSelected());
      this.btnDownload = tb('download', 'Pobierz na komputer', () => this.downloadSelected());
      this.btnGrid = tb('grid', 'Duże ikony', () => this.setView('grid'));
      this.btnList = tb('list', 'Szczegóły', () => this.setView('list'));
      this.btnHidden = tb('eye', 'Pokaż ukryte pliki', () => {
        this.showHidden = !this.showHidden;
        WD.settings.set('ex.hidden', this.showHidden);
        this.render();
      });
      const ribbon = h('div', { class: 'toolbar' },
        label('newfolder', 'Nowy folder', null, () => ops.newFolder(this.path).then((n) => n && this.selectAfterRefresh(n))),
        label('newfile', 'Nowy plik', null, () => ops.newFile(this.path).then((n) => n && this.selectAfterRefresh(n))),
        label('upload', 'Wyślij', 'Wyślij pliki z komputera (albo po prostu je tu przeciągnij)', (e) => {
          const r = e.currentTarget.getBoundingClientRect();
          WD.contextMenu(r.left, r.bottom + 2, [
            { label: 'Wyślij pliki…', icon: 'upload', action: () => WD.pickAndUpload(this.path, false) },
            { label: 'Wyślij folder…', icon: 'upload', action: () => WD.pickAndUpload(this.path, true) }
          ]);
        }),
        h('span', { class: 'sep' }),
        this.btnCut, this.btnCopy, this.btnPaste, this.btnRename, this.btnDelete,
        h('span', { class: 'sep' }),
        this.btnDownload,
        h('span', { style: { flex: '1' } }),
        this.btnHidden, this.btnGrid, this.btnList
      );

      this.side = h('div', { class: 'ex-side' });
      this.buildSidebar();
      this.content = h('div', { class: 'ex-content', tabindex: '0' });
      this.status = h('div', { class: 'ex-status' }, h('span'), h('span'));
      this.root = h('div', { class: 'explorer' }, nav, ribbon, h('div', { class: 'ex-main' }, this.side, this.content), this.status);

      this.bindContent();

      this.win = WD.wm.open({
        app: 'explorer',
        title: 'Eksplorator plików',
        icon: WD.appIcon('home'),
        width: 920,
        height: 580,
        onFocus: () => {},
        onClose: () => { this.offFs(); this.offClip(); }
      });
      this.win.body.append(this.root);
      this.win.explorer = this;
    }

    buildSidebar() {
      const places = [
        { label: 'Pulpit', path: WD.info.desktop, icon: WD.appIcon('desktopfolder') },
        { label: 'Folder domowy', path: WD.info.home, icon: WD.appIcon('home') },
        { label: 'Ten komputer (/)', path: WD.info.root || '/', icon: WD.appIcon('computer') }
      ];
      const system = ['/etc', '/var/www', '/var/log', '/opt', '/srv', '/tmp', '/root', '/home'];
      const mk = (p) => {
        const btn = h('button', { class: 'item', title: p.path, 'data-path': p.path }, h('span', { class: 'ico', html: p.icon }), h('span', {}, p.label));
        btn.addEventListener('click', () => this.navigate(p.path));
        this.makeDropTarget(btn, () => p.path);
        return btn;
      };
      this.side.append(h('div', { class: 'group' }, 'Szybki dostęp'), ...places.map(mk));
      const sysGroup = h('div');
      this.side.append(h('div', { class: 'group' }, 'System'), sysGroup);
      // Only show system folders that exist and are readable.
      Promise.all(system.map((p) => api.get('/api/stat', { path: p }).then((s) => (s.type === 'dir' ? p : null)).catch(() => null)))
        .then((found) => {
          for (const p of found.filter(Boolean)) {
            if (p === WD.info.home) continue;
            sysGroup.append(mk({ label: p, path: p, icon: WD.folderIcon }));
          }
          this.updateSideActive();
        });
    }

    updateSideActive() {
      for (const b of this.side.querySelectorAll('.item')) b.classList.toggle('active', b.dataset.path === this.path);
    }

    makeDropTarget(el, getDir) {
      el.addEventListener('dragover', (e) => {
        if (!ops.canDrop(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = ops.isInternalDrag(e) && !(e.ctrlKey || e.altKey) ? 'move' : 'copy';
        el.classList.add('drop-over');
      });
      el.addEventListener('dragleave', () => el.classList.remove('drop-over'));
      el.addEventListener('drop', (e) => {
        el.classList.remove('drop-over');
        if (!ops.canDrop(e)) return;
        e.preventDefault();
        e.stopPropagation();
        this.content.classList.remove('drop-target');
        ops.handleDrop(e, getDir());
      });
    }

    bindContent() {
      const c = this.content;
      c.addEventListener('pointerdown', (e) => {
        this.lastPointer = e.pointerType;
        if (e.button !== 0) return;
        if (!e.target.closest('.f')) {
          if (!e.ctrlKey && !e.shiftKey) this.clearSelection();
          if (e.pointerType === 'mouse') this.startMarquee(e);
        }
      });
      c.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const f = e.target.closest('.f');
        if (f) {
          const name = f.dataset.name;
          if (!this.selected.has(name)) this.selectOnly(name);
          const names = [...this.selected];
          WD.contextMenu(e.clientX, e.clientY, ops.itemMenu(names.map((n) => P.join(this.path, n)), names.map((n) => this.entry(n)), {
            onOpen: (p, en) => this.openEntry(en)
          }));
        } else {
          this.clearSelection();
          WD.contextMenu(e.clientX, e.clientY, ops.backgroundMenu(this.path, [
            { label: 'Odśwież', icon: 'refresh', key: 'F5', action: () => this.refresh() },
            { label: 'Zaznacz wszystko', icon: 'selectall', key: 'Ctrl+A', action: () => this.selectAll() },
            '-'
          ]));
        }
      });
      c.addEventListener('keydown', (e) => this.onKey(e));

      // Drop onto the empty area = current folder.
      let depth = 0;
      c.addEventListener('dragenter', (e) => { if (ops.canDrop(e)) { depth++; c.classList.add('drop-target'); } });
      c.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) c.classList.remove('drop-target'); });
      c.addEventListener('dragover', (e) => {
        if (!ops.canDrop(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = ops.isInternalDrag(e) && !(e.ctrlKey || e.altKey) ? 'move' : 'copy';
      });
      c.addEventListener('drop', (e) => {
        depth = 0;
        c.classList.remove('drop-target');
        if (!ops.canDrop(e)) return;
        e.preventDefault();
        ops.handleDrop(e, this.path);
      });
    }

    startMarquee(e) {
      const c = this.content;
      const rect = c.getBoundingClientRect();
      const sx = e.clientX - rect.left + c.scrollLeft;
      const sy = e.clientY - rect.top + c.scrollTop;
      const base = new Set(e.ctrlKey ? this.selected : []);
      let box = null;
      const move = (ev) => {
        const x = ev.clientX - rect.left + c.scrollLeft;
        const y = ev.clientY - rect.top + c.scrollTop;
        if (!box) {
          if (Math.abs(x - sx) + Math.abs(y - sy) < 5) return;
          box = h('div', { class: 'marquee' });
          c.append(box);
        }
        const l = Math.min(x, sx), t = Math.min(y, sy), w = Math.abs(x - sx), hh = Math.abs(y - sy);
        Object.assign(box.style, { left: l + 'px', top: t + 'px', width: w + 'px', height: hh + 'px' });
        const sel = new Set(base);
        for (const el of c.querySelectorAll('.f')) {
          const r = el.getBoundingClientRect();
          const el_l = r.left - rect.left + c.scrollLeft, el_t = r.top - rect.top + c.scrollTop;
          if (el_l < l + w && el_l + r.width > l && el_t < t + hh && el_t + r.height > t) sel.add(el.dataset.name);
        }
        this.selected = sel;
        this.paintSelection();
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        if (box) box.remove();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    }

    onKey(e) {
      const ctrl = e.ctrlKey || e.metaKey;
      const sel = this.selectedPaths();
      if (e.key === 'Delete') { e.preventDefault(); this.deleteSelected(); }
      else if (e.key === 'F2') { e.preventDefault(); this.renameSelected(); }
      else if (e.key === 'F5') { e.preventDefault(); this.refresh(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (sel.length === 1) this.openEntry(this.entry([...this.selected][0])); }
      else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) { e.preventDefault(); this.goUp(); }
      else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); this.goBack(); }
      else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); this.goFwd(); }
      else if (ctrl && e.key.toLowerCase() === 'a') { e.preventDefault(); this.selectAll(); }
      else if (ctrl && e.key.toLowerCase() === 'c') { e.preventDefault(); this.clip('copy'); }
      else if (ctrl && e.key.toLowerCase() === 'x') { e.preventDefault(); this.clip('cut'); }
      else if (ctrl && e.key.toLowerCase() === 'v') { e.preventDefault(); ops.paste(this.path); }
      else if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); this.moveCursor(e.key, e.shiftKey); }
    }

    moveCursor(key, extend) {
      const items = this.visible();
      if (!items.length) return;
      const idx = items.findIndex((en) => en.name === this.anchor);
      let cols = 1;
      if (this.view === 'grid') {
        const first = this.content.querySelector('.f');
        if (first) cols = Math.max(1, Math.floor(this.content.clientWidth / (first.offsetWidth + 4)));
      }
      let next = idx < 0 ? 0 : idx;
      if (key === 'ArrowDown') next = idx < 0 ? 0 : idx + cols;
      if (key === 'ArrowUp') next = idx - cols;
      if (key === 'ArrowRight') next = this.view === 'grid' ? idx + 1 : idx;
      if (key === 'ArrowLeft') next = this.view === 'grid' ? idx - 1 : idx;
      if (key === 'Home') next = 0;
      if (key === 'End') next = items.length - 1;
      next = Math.max(0, Math.min(items.length - 1, next));
      const name = items[next].name;
      if (extend) this.selected.add(name);
      else this.selected = new Set([name]);
      this.anchor = name;
      this.paintSelection();
      const el = this.content.querySelector(`.f[data-name="${CSS.escape(name)}"]`);
      if (el) el.scrollIntoView({ block: 'nearest' });
    }

    // ----- navigation -----
    async navigate(p, pushHistory = true) {
      try {
        const data = await api.get('/api/list', { path: p });
        if (pushHistory && data.path !== this.path) { this.back.push(this.path); this.fwd = []; }
        this.path = data.path;
        this.parent = data.parent;
        this.entries = data.entries;
        this.selected.clear();
        this.anchor = null;
        this.search.value = '';
        this.filter = '';
        this.render();
        this.content.scrollTop = 0;
        this.content.focus({ preventScroll: true });
      } catch (err) {
        WD.error(err);
        this.address.value = this.path;
      }
    }

    async refresh() {
      try {
        const data = await api.get('/api/list', { path: this.path });
        this.entries = data.entries;
        this.parent = data.parent;
        const names = new Set(this.entries.map((e) => e.name));
        this.selected = new Set([...this.selected].filter((n) => names.has(n)));
        this.render();
      } catch (err) {
        // The folder disappeared: go to the nearest existing parent.
        if (this.path !== '/') this.navigate(P.dir(this.path), false);
        else WD.error(err);
      }
    }

    scheduleRefresh() {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this.refresh(), 150);
    }

    async selectAfterRefresh(name) {
      await this.refresh();
      this.selectOnly(name);
    }

    goBack() { if (this.back.length) { this.fwd.push(this.path); this.navigate(this.back.pop(), false); } }
    goFwd() { if (this.fwd.length) { this.back.push(this.path); this.navigate(this.fwd.pop(), false); } }
    goUp() { if (this.parent) this.navigate(this.parent); }

    setView(v) {
      this.view = v;
      WD.settings.set('ex.view', v);
      this.render();
    }

    // ----- selection helpers -----
    entry(name) { return this.entries.find((e) => e.name === name); }
    selectedPaths() { return [...this.selected].map((n) => P.join(this.path, n)); }
    clearSelection() { this.selected.clear(); this.paintSelection(); }
    selectOnly(name) { this.selected = new Set([name]); this.anchor = name; this.paintSelection(); }
    selectAll() { this.selected = new Set(this.visible().map((e) => e.name)); this.paintSelection(); }

    clip(mode) {
      const paths = this.selectedPaths();
      if (!paths.length) return;
      WD.setClipboard(mode, paths);
      WD.toast(`${mode === 'cut' ? 'Wycięto' : 'Skopiowano'}: ${paths.length} — wklej Ctrl+V w folderze docelowym`);
    }

    async renameSelected() {
      const paths = this.selectedPaths();
      if (paths.length !== 1) return;
      const name = await ops.rename(paths[0]);
      if (name) this.selectAfterRefresh(name);
    }

    deleteSelected() { ops.remove(this.selectedPaths()); }

    downloadSelected() {
      const paths = this.selectedPaths();
      if (paths.length) WD.download(paths);
      else WD.toast('Zaznacz pliki do pobrania');
    }

    openEntry(entry) {
      if (!entry) return;
      if (entry.type === 'dir') this.navigate(P.join(this.path, entry.name));
      else ops.open(P.join(this.path, entry.name), entry);
    }

    onItemClick(e, entry) {
      const name = entry.name;
      if (e.shiftKey && this.anchor) {
        const items = this.visible().map((x) => x.name);
        const a = items.indexOf(this.anchor), b = items.indexOf(name);
        const [s, t] = a < b ? [a, b] : [b, a];
        if (!(e.ctrlKey || e.metaKey)) this.selected.clear();
        for (let i = s; i <= t; i++) this.selected.add(items[i]);
      } else if (e.ctrlKey || e.metaKey) {
        if (this.selected.has(name)) this.selected.delete(name); else this.selected.add(name);
        this.anchor = name;
      } else {
        this.selected = new Set([name]);
        this.anchor = name;
        // On touch screens a single tap opens, like on a phone.
        if (this.lastPointer === 'touch') return this.openEntry(entry);
      }
      this.paintSelection();
    }

    // ----- rendering -----
    visible() {
      let list = this.entries;
      if (!this.showHidden) list = list.filter((e) => !e.name.startsWith('.'));
      if (this.filter) list = list.filter((e) => e.name.toLowerCase().includes(this.filter));
      const { key, dir } = this.sort;
      const coll = new Intl.Collator('pl', { numeric: true, sensitivity: 'base' });
      return list.slice().sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        let r = 0;
        if (key === 'size') r = a.size - b.size;
        else if (key === 'mtime') r = a.mtime - b.mtime;
        else if (key === 'type') r = coll.compare(P.ext(a.name), P.ext(b.name));
        return (r || coll.compare(a.name, b.name)) * dir;
      });
    }

    itemIcon(entry) {
      const full = P.join(this.path, entry.name);
      if (WD.fileType(entry) === 'image' && entry.size < 25 * 1024 * 1024) {
        return h('span', { class: 'ico' }, h('img', { src: api.rawUrl(full), loading: 'lazy', alt: '', draggable: 'false', onerror: function () { this.parentNode.innerHTML = WD.entryIcon(entry); } }));
      }
      return h('span', { class: 'ico', html: WD.entryIcon(entry) });
    }

    bindItem(el, entry) {
      el.dataset.name = entry.name;
      el.draggable = true;
      if (entry.name.startsWith('.')) el.classList.add('hidden-file');
      if (WD.clipboard.mode === 'cut' && WD.clipboard.paths.includes(P.join(this.path, entry.name))) el.classList.add('cut');
      el.addEventListener('click', (e) => this.onItemClick(e, entry));
      el.addEventListener('dblclick', () => this.openEntry(entry));
      el.addEventListener('dragstart', (e) => {
        if (!this.selected.has(entry.name)) this.selectOnly(entry.name);
        const names = [...this.selected];
        ops.dragStart(e, names.map((n) => P.join(this.path, n)), names.map((n) => this.entry(n)));
      });
      if (entry.type === 'dir') this.makeDropTarget(el, () => P.join(this.path, entry.name));
      return el;
    }

    render() {
      this.address.value = this.path;
      this.win.setTitle(this.path === '/' ? 'Ten komputer (/)' : P.base(this.path) + ' — Eksplorator');
      this.btnBack.disabled = !this.back.length;
      this.btnFwd.disabled = !this.fwd.length;
      this.btnUp.disabled = !this.parent;
      this.btnGrid.classList.toggle('on', this.view === 'grid');
      this.btnList.classList.toggle('on', this.view === 'list');
      this.btnHidden.classList.toggle('on', this.showHidden);
      this.btnPaste.disabled = !WD.clipboard.mode;
      this.updateSideActive();

      const items = this.visible();
      const scroll = this.content.scrollTop;
      this.content.textContent = '';
      if (!items.length) {
        this.content.append(h('div', { class: 'ex-empty' },
          h('strong', {}, this.filter ? 'Brak wyników' : 'Ten folder jest pusty'),
          this.filter ? '' : 'Przeciągnij tutaj pliki lub foldery z komputera, aby je wysłać.'));
      } else if (this.view === 'grid') {
        const grid = h('div', { class: 'ex-grid' });
        for (const en of items) {
          grid.append(this.bindItem(h('div', { class: 'f', title: this.tooltip(en) }, this.itemIcon(en), h('span', { class: 'name' }, en.name)), en));
        }
        this.content.append(grid);
      } else {
        const th = (key, label, cls) => {
          const arrow = this.sort.key === key ? (this.sort.dir > 0 ? ' ▲' : ' ▼') : '';
          return h('th', {
            class: cls || '',
            onclick: () => {
              this.sort = { key, dir: this.sort.key === key ? -this.sort.dir : 1 };
              WD.settings.set('ex.sort', this.sort);
              this.render();
            }
          }, label + arrow);
        };
        const tbody = h('tbody');
        for (const en of items) {
          tbody.append(this.bindItem(h('tr', { class: 'f', title: this.tooltip(en) },
            h('td', {}, h('div', { class: 'nm' }, this.itemIcon(en), h('span', {}, en.name + (en.link ? ' ↪' : '')))),
            h('td', { class: 'dim hide-sm' }, fmt.date(en.mtime)),
            h('td', { class: 'dim hide-sm' }, en.type === 'dir' ? 'Folder' : (P.ext(en.name).toUpperCase() || 'Plik')),
            h('td', { class: 'num' }, en.type === 'dir' ? '' : fmt.size(en.size))
          ), en));
        }
        this.content.append(h('table', { class: 'ex-list' },
          h('thead', {}, h('tr', {}, th('name', 'Nazwa'), th('mtime', 'Data modyfikacji', 'hide-sm'), th('type', 'Typ', 'hide-sm'), th('size', 'Rozmiar', 'num'))),
          tbody));
      }
      this.content.scrollTop = scroll;
      this.paintSelection();
    }

    tooltip(en) {
      return en.name + (en.type === 'dir' ? '' : '\nRozmiar: ' + fmt.size(en.size)) + '\nZmodyfikowano: ' + fmt.date(en.mtime);
    }

    paintSelection() {
      for (const el of this.content.querySelectorAll('.f')) el.classList.toggle('selected', this.selected.has(el.dataset.name));
      const n = this.selected.size;
      const has = n > 0;
      this.btnCut.disabled = this.btnCopy.disabled = this.btnDelete.disabled = this.btnDownload.disabled = !has;
      this.btnRename.disabled = n !== 1;
      const items = this.visible();
      const [left, right] = this.status.children;
      left.textContent = `Elementy: ${items.length}` + (has ? ` · zaznaczono ${n}` : '');
      const size = [...this.selected].map((nm) => this.entry(nm)).filter((e) => e && e.type !== 'dir').reduce((a, e) => a + e.size, 0);
      right.textContent = has && size ? fmt.size(size) : P.pretty(this.path);
    }
  }

  WD.apps = WD.apps || {};
  WD.apps.explorer = {
    name: 'Eksplorator plików',
    icon: 'home',
    launch: (opts = {}) => new Explorer(opts)
  };
})(window.WD);
