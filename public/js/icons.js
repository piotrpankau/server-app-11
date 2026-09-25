'use strict';
/* Inline SVG icons: app icons, file type icons and small toolbar glyphs. */
(function (WD) {
  const stroke = (d, extra = '') =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;

  // Small monochrome glyphs for toolbars and menus.
  const GLYPHS = {
    back: '<path d="M15 18l-6-6 6-6"/>',
    forward: '<path d="M9 18l6-6-6-6"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    newfolder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
    newfile: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 12v6M9 15h6"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    cut: '<circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.1 16L19 4M15.9 16L5 4"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    paste: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h6"/>',
    rename: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    open: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
    zip: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M11 5h2M11 8h2M11 11h2M10 14h4v3h-4z"/>',
    unzip: '<path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M12 10v6M9.5 13.5L12 16l2.5-2.5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    selectall: '<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 3"/><path d="M9 12l2 2 4-4"/>',
    save: '<path d="M5 4h11l4 4v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
    wrap: '<path d="M4 6h16M4 12h13a3 3 0 0 1 0 6h-4M4 18h5"/><path d="M15 16l-2 2 2 2"/>',
    zoomin: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5M11 8v6M8 11h6"/>',
    zoomout: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5M8 11h6"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    power: '<path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/>',
    home: '<path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    kill: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>'
  };
  WD.glyph = (name) => stroke(GLYPHS[name] || GLYPHS.info);

  // Colourful app icons.
  const APP_ICONS = {
    start: '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="9.5" height="9.5" rx="1.5" fill="#4cc2ff"/><rect x="12.5" y="2" width="9.5" height="9.5" rx="1.5" fill="#4cc2ff"/><rect x="2" y="12.5" width="9.5" height="9.5" rx="1.5" fill="#4cc2ff"/><rect x="12.5" y="12.5" width="9.5" height="9.5" rx="1.5" fill="#4cc2ff"/></svg>',
    computer: '<svg viewBox="0 0 48 48"><rect x="4" y="7" width="40" height="27" rx="3" fill="#2b88d8"/><rect x="7" y="10" width="34" height="21" rx="1.5" fill="#9fd4ff"/><path d="M7 31L41 10v21z" fill="#6cb6f0"/><rect x="18" y="34" width="12" height="4" fill="#5f6b7a"/><rect x="12" y="38" width="24" height="3" rx="1.5" fill="#7d8896"/></svg>',
    home: '<svg viewBox="0 0 48 48"><path d="M4 14a3 3 0 0 1 3-3h11l4 4h19a3 3 0 0 1 3 3v19a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z" fill="#e8a317"/><path d="M4 19h40v18a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z" fill="#ffc83d"/><path d="M17 28l7-6 7 6v7h-4.5v-4.5h-5V35H17z" fill="#fff"/></svg>',
    desktopfolder: '<svg viewBox="0 0 48 48"><path d="M4 14a3 3 0 0 1 3-3h11l4 4h19a3 3 0 0 1 3 3v19a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z" fill="#e8a317"/><path d="M4 19h40v18a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z" fill="#ffc83d"/><rect x="15" y="24" width="18" height="11" rx="1.5" fill="#2b88d8"/><rect x="21" y="35" width="6" height="2" fill="#fff"/></svg>',
    terminal: '<svg viewBox="0 0 48 48"><rect x="4" y="7" width="40" height="34" rx="4" fill="#1f2328"/><rect x="4" y="7" width="40" height="7" rx="4" fill="#3a3f47"/><path d="M11 22l6 5-6 5" fill="none" stroke="#5fd07c" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 32h11" stroke="#e6e6e6" stroke-width="3" stroke-linecap="round"/></svg>',
    editor: '<svg viewBox="0 0 48 48"><path d="M10 4h20l10 10v28a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="#fff" stroke="#9aa4b1" stroke-width="1.5"/><path d="M30 4v10h10" fill="#dfe4ea"/><path d="M14 20h18M14 25h20M14 30h14M14 35h17" stroke="#2b88d8" stroke-width="2.4" stroke-linecap="round"/></svg>',
    monitor: '<svg viewBox="0 0 48 48"><rect x="4" y="6" width="40" height="36" rx="4" fill="#0e7a53"/><path d="M9 30h6l4-12 6 18 5-12 3 6h6" fill="none" stroke="#b6ffd9" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    settings: '<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" fill="#6b7785"/><path d="M24 12l3 1 .7 3.4 2.6 1.5 3.3-1.1 2.2 2.2-1.1 3.3 1.5 2.6L39.6 26l.4 3-3.4.7-1.5 2.6 1.1 3.3-2.2 2.2-3.3-1.1-2.6 1.5L27 41.6l-3 .4-.7-3.4-2.6-1.5-3.3 1.1-2.2-2.2 1.1-3.3-1.5-2.6L11.4 29 11 26l3.4-.7 1.5-2.6-1.1-3.3 2.2-2.2 3.3 1.1 2.6-1.5z" fill="#dfe4ea" transform="translate(-1.5 -3)"/><circle cx="24" cy="24" r="5" fill="#6b7785"/></svg>',
    viewer: '<svg viewBox="0 0 48 48"><rect x="4" y="8" width="40" height="32" rx="4" fill="#2b88d8"/><circle cx="16" cy="18" r="4" fill="#ffd75e"/><path d="M4 34l12-11 9 8 6-5 13 11v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" fill="#5fd07c"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>'
  };
  WD.appIcon = (name) => APP_ICONS[name] || APP_ICONS.editor;

  const FOLDER = '<svg viewBox="0 0 48 48"><path d="M4 12a3 3 0 0 1 3-3h11l4 4h19a3 3 0 0 1 3 3v21a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z" fill="#e8a317"/><path d="M4 18h40v19a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z" fill="#ffc83d"/></svg>';
  const FILE_COLORS = {
    image: '#8e44ad', video: '#d9534f', audio: '#e67e22', archive: '#7f6a3b', pdf: '#c0392b',
    code: '#2b88d8', text: '#6b7785', file: '#95a0ad'
  };
  function fileIcon(type, ext) {
    const color = FILE_COLORS[type] || FILE_COLORS.file;
    const label = (ext || '').slice(0, 4).toUpperCase();
    return `<svg viewBox="0 0 48 48"><path d="M10 3h20l11 11v29a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="#fff" stroke="#c5ccd5" stroke-width="1.2"/><path d="M30 3v9a2 2 0 0 0 2 2h9" fill="#e6eaef" stroke="#c5ccd5" stroke-width="1.2"/>` +
      `<rect x="5" y="25" width="30" height="12" rx="2" fill="${color}"/>` +
      (label ? `<text x="20" y="34.2" font-family="Segoe UI, Arial, sans-serif" font-size="8" font-weight="700" fill="#fff" text-anchor="middle">${label}</text>` : '') +
      '</svg>';
  }

  WD.entryIcon = function (entry) {
    const type = WD.fileType(entry);
    if (type === 'dir') return FOLDER;
    return fileIcon(type, WD.path.ext(entry.name));
  };
  WD.folderIcon = FOLDER;

  // Replace every [data-icon] placeholder that is present in static HTML.
  WD.fillIcons = function (root) {
    for (const el of (root || document).querySelectorAll('[data-icon]')) {
      const n = el.dataset.icon;
      el.innerHTML = APP_ICONS[n] || WD.glyph(n);
      if (el.tagName === 'SPAN' && !el.classList.contains('ico')) el.style.display = 'inline-flex';
      el.removeAttribute('data-icon');
    }
  };
})(window.WD);
