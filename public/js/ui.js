'use strict';
/* Toasts, modal dialogs and context menus. */
(function (WD) {
  const { h } = WD;

  WD.toast = function (message, kind = '', ms = 3500) {
    const el = h('div', { class: 'toast ' + kind }, message);
    document.getElementById('toasts').append(el);
    setTimeout(() => el.remove(), ms);
  };
  WD.error = (err) => WD.toast(err && err.message ? err.message : String(err), 'error', 6000);

  // Generic modal. buttons: [{ label, value, kind }]. Resolves with the clicked value
  // (or null on Escape / backdrop click).
  WD.dialog = function ({ title, body, buttons, onOpen, validate }) {
    return new Promise((resolve) => {
      const content = typeof body === 'string' ? h('div', {}, body) : body;
      const actions = h('div', { class: 'd-actions' });
      const dlg = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
        h('h2', {}, title), h('div', { class: 'd-body' }, content), actions);
      const backdrop = h('div', { class: 'modal-backdrop' }, dlg);
      const prevFocus = document.activeElement;

      const done = (value) => {
        if (value != null && validate && validate(value) === false) return;
        backdrop.remove();
        document.removeEventListener('keydown', onKey, true);
        if (prevFocus && prevFocus.focus) prevFocus.focus();
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); done(null); }
        if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
          e.preventDefault();
          e.stopPropagation();
          const def = buttons.find((b) => b.kind === 'primary' || b.kind === 'danger');
          if (def) done(def.value);
        }
      };
      for (const b of buttons) {
        actions.append(h('button', { class: 'btn ' + (b.kind || ''), onclick: () => done(b.value) }, b.label));
      }
      backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) done(null); });
      document.addEventListener('keydown', onKey, true);
      document.body.append(backdrop);
      if (onOpen) onOpen(dlg);
      else (dlg.querySelector('.btn.primary, .btn.danger') || dlg.querySelector('.btn')).focus();
    });
  };

  WD.confirm = (title, message, { okLabel = 'OK', danger = false } = {}) =>
    WD.dialog({
      title,
      body: message,
      buttons: [{ label: okLabel, value: true, kind: danger ? 'danger' : 'primary' }, { label: 'Anuluj', value: false }]
    }).then((v) => v === true);

  WD.alert = (title, message) => WD.dialog({ title, body: message, buttons: [{ label: 'OK', value: true, kind: 'primary' }] });

  WD.prompt = function (title, label, value = '', { selectBase = false } = {}) {
    const input = h('input', { class: 'field', value, spellcheck: 'false' });
    return WD.dialog({
      title,
      body: h('div', {}, label, input),
      buttons: [{ label: 'OK', value: 'ok', kind: 'primary' }, { label: 'Anuluj', value: null }],
      onOpen: () => {
        input.focus();
        const dot = value.lastIndexOf('.');
        if (selectBase && dot > 0) input.setSelectionRange(0, dot);
        else input.select();
      }
    }).then((v) => (v === 'ok' ? input.value.trim() : null));
  };

  // ---------- Context menu ----------
  let openMenu = null;
  function closeMenu() {
    if (openMenu) { openMenu.remove(); openMenu = null; }
  }
  document.addEventListener('pointerdown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);

  // items: [{ label, icon, key, action, disabled, danger } | '-']
  WD.contextMenu = function (x, y, items) {
    closeMenu();
    const menu = h('div', { class: 'ctx', role: 'menu' });
    for (const it of items) {
      if (!it) continue;
      if (it === '-') { if (menu.lastChild && menu.lastChild.tagName !== 'HR') menu.append(h('hr')); continue; }
      menu.append(h('button', {
        class: it.danger ? 'danger' : '',
        disabled: it.disabled,
        role: 'menuitem',
        onclick: () => { closeMenu(); it.action(); }
      }, h('span', { html: it.icon ? WD.glyph(it.icon) : '', style: { display: 'inline-flex', width: '16px' } }), it.label, it.key ? h('span', { class: 'k' }, it.key) : null));
    }
    if (menu.lastChild && menu.lastChild.tagName === 'HR') menu.lastChild.remove();
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
    openMenu = menu;
    const first = menu.querySelector('button:not(:disabled)');
    if (first) first.focus({ preventScroll: true });
  };
  WD.closeMenu = closeMenu;
})(window.WD);
