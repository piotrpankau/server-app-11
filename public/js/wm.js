'use strict';
/* Window manager: draggable/resizable windows, snapping, taskbar buttons. */
(function (WD) {
  const { h } = WD;
  const desktop = () => document.getElementById('desktop');
  const tasks = () => document.getElementById('tasks');
  const windows = [];
  let zTop = 10;
  let cascade = 0;
  let idSeq = 0;

  const CTRL_ICONS = {
    min: '<svg viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" stroke-width="1"/></svg>',
    max: '<svg viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor"/></svg>',
    restore: '<svg viewBox="0 0 10 10"><rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor"/><path d="M2.5 2.5V.5h7v7h-2" fill="none" stroke="currentColor"/></svg>',
    close: '<svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1.1"/></svg>'
  };

  const isSmall = () => window.innerWidth < 700;

  function bounds() {
    const d = desktop();
    return { w: d.clientWidth, h: d.clientHeight };
  }

  class Win {
    constructor(opts) {
      this.id = 'w' + (++idSeq);
      this.opts = opts;
      this.app = opts.app;
      this.onClose = opts.onClose;
      this.onResize = opts.onResize;
      this.onFocus = opts.onFocus;
      this.maximized = false;
      this.minimized = false;
      this.build();
    }

    build() {
      const o = this.opts;
      const b = bounds();
      const w = Math.min(o.width || 820, b.w - 20);
      const hgt = Math.min(o.height || 540, b.h - 20);
      const off = (cascade++ % 8) * 28;
      const x = o.x != null ? o.x : Math.max(10, Math.round((b.w - w) / 2 - 100 + off));
      const y = o.y != null ? o.y : Math.max(10, Math.round((b.h - hgt) / 2 - 80 + off));

      this.iconEl = h('span', { class: 'ico', html: o.icon || '' });
      this.titleEl = h('span', { class: 'title' }, o.title || '');
      this.maxBtn = h('button', { class: 'max', title: 'Maksymalizuj', html: CTRL_ICONS.max, onclick: () => this.toggleMax() });
      this.titlebar = h('div', { class: 'titlebar' },
        this.iconEl, this.titleEl,
        h('div', { class: 'win-controls' },
          h('button', { class: 'min', title: 'Minimalizuj', html: CTRL_ICONS.min, onclick: () => this.minimize() }),
          this.maxBtn,
          h('button', { class: 'close', title: 'Zamknij', html: CTRL_ICONS.close, onclick: () => this.close() })
        )
      );
      this.body = h('div', { class: 'win-body' });
      this.el = h('div', { class: 'window', id: this.id, style: { left: x + 'px', top: y + 'px', width: w + 'px', height: hgt + 'px' } },
        this.titlebar, this.body,
        ...['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => h('div', { class: 'rh ' + d, 'data-dir': d }))
      );

      this.el.addEventListener('pointerdown', () => this.focus(), true);
      this.titlebar.addEventListener('dblclick', (e) => { if (!e.target.closest('.win-controls')) this.toggleMax(); });
      this.titlebar.addEventListener('pointerdown', (e) => this.startDrag(e));
      for (const rh of this.el.querySelectorAll('.rh')) rh.addEventListener('pointerdown', (e) => this.startResize(e, rh.dataset.dir));

      this.taskBtn = h('button', { class: 'tb-btn task', title: o.title || '' },
        h('span', { class: 'ico', html: o.icon || '' }), h('span', { class: 't' }, o.title || ''));
      this.taskBtn.addEventListener('click', () => {
        if (this.minimized) this.restore();
        else if (this.isFocused()) this.minimize();
        else this.focus();
      });

      desktop().append(this.el);
      tasks().append(this.taskBtn);
      windows.push(this);
      if (o.maximized || isSmall()) this.maximize();
      this.focus();
    }

    setTitle(title) {
      this.titleEl.textContent = title;
      this.taskBtn.title = title;
      this.taskBtn.querySelector('.t').textContent = title;
      WD.emit('windows-changed');
    }

    setIcon(svg) {
      this.iconEl.innerHTML = svg;
      this.taskBtn.querySelector('.ico').innerHTML = svg;
    }

    isFocused() { return this.el.classList.contains('focused'); }

    focus() {
      if (this.minimized) return this.restore();
      if (this.isFocused()) return;
      for (const w of windows) {
        w.el.classList.remove('focused');
        w.taskBtn.classList.remove('focused', 'active');
      }
      this.el.style.zIndex = ++zTop;
      this.el.classList.add('focused');
      this.taskBtn.classList.add('focused', 'active');
      if (this.onFocus) this.onFocus();
      WD.emit('windows-changed');
    }

    blur() {
      this.el.classList.remove('focused');
      this.taskBtn.classList.remove('focused', 'active');
    }

    minimize() {
      this.minimized = true;
      this.el.classList.add('minimized');
      this.blur();
      focusTopmost();
    }

    restore() {
      this.minimized = false;
      this.el.classList.remove('minimized');
      this.focus();
      this.resized();
    }

    maximize() {
      if (this.maximized) return;
      this.maximized = true;
      this.el.classList.add('maximized');
      this.maxBtn.innerHTML = CTRL_ICONS.restore;
      this.maxBtn.title = 'Przywróć';
      this.resized();
    }

    unmaximize() {
      if (!this.maximized) return;
      this.maximized = false;
      this.el.classList.remove('maximized');
      this.maxBtn.innerHTML = CTRL_ICONS.max;
      this.maxBtn.title = 'Maksymalizuj';
      this.resized();
    }

    toggleMax() { this.maximized ? this.unmaximize() : this.maximize(); }

    resized() {
      if (this.onResize) requestAnimationFrame(() => this.onResize());
    }

    async close(force) {
      if (!force && this.onClose) {
        const ok = await this.onClose();
        if (ok === false) return;
      }
      this.el.remove();
      this.taskBtn.remove();
      windows.splice(windows.indexOf(this), 1);
      WD.emit('window-closed', this);
      WD.emit('windows-changed');
      focusTopmost();
    }

    startDrag(e) {
      if (e.button !== 0 || e.target.closest('.win-controls')) return;
      e.preventDefault();
      const el = this.el;
      const b = bounds();
      let startX = e.clientX;
      let startY = e.clientY;
      let origX = el.offsetLeft;
      let origY = el.offsetTop;
      let moved = false;
      let snap = null;
      const preview = h('div', { id: 'snap-preview', hidden: true });
      document.body.append(preview);
      this.titlebar.setPointerCapture(e.pointerId);

      const move = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        if (!moved) {
          moved = true;
          el.classList.add('dragging');
          if (this.maximized) {
            // Restore under the cursor, keeping the grab point proportional.
            const ratio = (ev.clientX - el.getBoundingClientRect().left) / el.offsetWidth;
            this.unmaximize();
            origX = ev.clientX - el.offsetWidth * ratio;
            origY = 0;
            startX = ev.clientX;
            startY = ev.clientY;
          }
        }
        const nx = Math.min(Math.max(origX + ev.clientX - startX, -el.offsetWidth + 80), b.w - 80);
        const ny = Math.min(Math.max(origY + ev.clientY - startY, 0), b.h - 36);
        el.style.left = nx + 'px';
        el.style.top = ny + 'px';

        snap = null;
        if (ev.clientY <= 2) snap = { left: 0, top: 0, width: b.w, height: b.h, max: true };
        else if (ev.clientX <= 3) snap = { left: 0, top: 0, width: b.w / 2, height: b.h };
        else if (ev.clientX >= window.innerWidth - 4) snap = { left: b.w / 2, top: 0, width: b.w / 2, height: b.h };
        preview.hidden = !snap;
        if (snap) Object.assign(preview.style, { left: snap.left + 6 + 'px', top: snap.top + 6 + 'px', width: snap.width - 12 + 'px', height: snap.height - 12 + 'px' });
      };
      const up = () => {
        this.titlebar.removeEventListener('pointermove', move);
        this.titlebar.removeEventListener('pointerup', up);
        this.titlebar.removeEventListener('pointercancel', up);
        el.classList.remove('dragging');
        preview.remove();
        if (snap) {
          if (snap.max) this.maximize();
          else {
            Object.assign(el.style, { left: snap.left + 'px', top: '0px', width: snap.width + 'px', height: snap.height + 'px' });
            this.resized();
          }
        }
      };
      this.titlebar.addEventListener('pointermove', move);
      this.titlebar.addEventListener('pointerup', up);
      this.titlebar.addEventListener('pointercancel', up);
    }

    startResize(e, dir) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const el = this.el;
      const target = e.target;
      const start = { x: e.clientX, y: e.clientY, l: el.offsetLeft, t: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
      const minW = 280;
      const minH = 180;
      target.setPointerCapture(e.pointerId);
      el.classList.add('resizing');
      const move = (ev) => {
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        let { l, t, w, h: hh } = start;
        if (dir.includes('e')) w = Math.max(minW, start.w + dx);
        if (dir.includes('s')) hh = Math.max(minH, start.h + dy);
        if (dir.includes('w')) { w = Math.max(minW, start.w - dx); l = start.l + start.w - w; }
        if (dir.includes('n')) { hh = Math.max(minH, start.h - dy); t = Math.max(0, start.t + start.h - hh); }
        Object.assign(el.style, { left: l + 'px', top: t + 'px', width: w + 'px', height: hh + 'px' });
        if (this.onResize) this.onResize();
      };
      const up = () => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
        el.classList.remove('resizing');
        this.resized();
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
      target.addEventListener('pointercancel', up);
    }
  }

  function focusTopmost() {
    const visible = windows.filter((w) => !w.minimized);
    if (!visible.length) return;
    visible.sort((a, b) => Number(b.el.style.zIndex) - Number(a.el.style.zIndex));
    visible[0].focus();
  }

  window.addEventListener('resize', () => {
    for (const w of windows) {
      if (isSmall() && !w.maximized) w.maximize();
      else w.resized();
    }
  });

  WD.wm = {
    open: (opts) => new Win(opts),
    windows,
    focused: () => windows.find((w) => w.isFocused()),
    find: (pred) => windows.find(pred)
  };
})(window.WD);
