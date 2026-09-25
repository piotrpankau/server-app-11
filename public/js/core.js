'use strict';
/* Core helpers shared by every app: API calls, paths, formatting, events, settings. */
window.WD = window.WD || {};

(function (WD) {
  // ---------- DOM ----------
  WD.h = function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'html') el.innerHTML = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  };

  // ---------- API ----------
  async function handle(res) {
    if (res.status === 401) {
      location.href = '/login';
      throw new Error('Sesja wygasła');
    }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error((data && data.error) || `Błąd ${res.status}`);
    return data;
  }

  WD.api = {
    get(url, params) {
      const q = params ? '?' + new URLSearchParams(params) : '';
      return fetch(url + q, { credentials: 'same-origin' }).then(handle);
    },
    post(url, body) {
      return fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-WebPulpit': '1' },
        body: JSON.stringify(body || {})
      }).then(handle);
    },
    rawUrl(path) { return '/api/raw?' + new URLSearchParams({ path }); },
    downloadUrl(paths) {
      return paths.length === 1
        ? '/api/download?' + new URLSearchParams({ path: paths[0] })
        : '/api/download?' + new URLSearchParams({ paths: JSON.stringify(paths) });
    }
  };

  WD.download = function (paths) {
    const a = WD.h('a', { href: WD.api.downloadUrl(paths), download: '' });
    document.body.append(a);
    a.click();
    a.remove();
  };

  // ---------- Paths ----------
  WD.path = {
    join(dir, name) { return (dir.endsWith('/') ? dir : dir + '/') + name; },
    base(p) { if (p === '/') return '/'; const s = p.replace(/\/+$/, ''); return s.slice(s.lastIndexOf('/') + 1); },
    dir(p) { const s = p.replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i <= 0 ? '/' : s.slice(0, i); },
    ext(name) { const m = /\.([^./]+)$/.exec(name); return m ? m[1].toLowerCase() : ''; },
    // Shows the home folder as "~" in titles.
    pretty(p) {
      const home = WD.info && WD.info.home;
      if (home && home !== '/' && (p === home || p.startsWith(home + '/'))) return '~' + p.slice(home.length);
      return p;
    }
  };

  // ---------- Formatting ----------
  WD.fmt = {
    size(n) {
      if (n == null) return '';
      const u = ['B', 'KB', 'MB', 'GB', 'TB'];
      let i = 0;
      while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
      return (i === 0 ? String(n) : n.toFixed(n < 10 ? 1 : 0).replace('.', ',')) + ' ' + u[i];
    },
    date(ms) {
      if (!ms) return '';
      return new Date(ms).toLocaleString('pl-PL', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    },
    duration(sec) {
      sec = Math.floor(sec);
      const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
      return (d ? d + ' d ' : '') + (h ? h + ' godz. ' : '') + m + ' min';
    },
    mode(m) {
      const s = 'rwxrwxrwx';
      let out = '';
      for (let i = 0; i < 9; i++) out += (m & (1 << (8 - i))) ? s[i] : '-';
      return out + ' (' + (m & 0o777).toString(8).padStart(3, '0') + ')';
    }
  };

  // ---------- File types ----------
  const TYPES = {
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'],
    video: ['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'ogv'],
    audio: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'],
    archive: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'txz', 'tbz2', '7z', 'rar'],
    pdf: ['pdf'],
    code: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'php', 'rb', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'java', 'kt', 'cs', 'html', 'htm', 'css', 'scss', 'json', 'yml', 'yaml', 'xml', 'sql', 'toml', 'lua', 'pl', 'vue', 'svelte'],
    text: ['txt', 'md', 'log', 'conf', 'cfg', 'ini', 'env', 'csv', 'tsv', 'service', 'list', 'properties', 'gitignore', 'dockerfile', 'lock']
  };
  const EXT_TYPE = {};
  for (const [t, exts] of Object.entries(TYPES)) for (const e of exts) EXT_TYPE[e] = t;
  const TEXT_NAMES = /^(\.?[a-z]*rc|\.profile|\.bash_\w+|makefile|dockerfile|readme|license|changelog|hosts|fstab|crontab|authorized_keys|known_hosts|config|\.env.*|\.gitignore|\.gitconfig|.*\.conf\.d)$/i;

  WD.fileType = function (entry) {
    if (entry.type === 'dir') return 'dir';
    const ext = WD.path.ext(entry.name);
    if (EXT_TYPE[ext]) return EXT_TYPE[ext];
    // Files without an extension on Linux are usually config/text files.
    if (!ext || TEXT_NAMES.test(entry.name)) return 'text';
    return 'file';
  };
  WD.isArchive = (name) => /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/i.test(name);

  // ---------- Events ----------
  const listeners = {};
  WD.on = (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); return () => WD.off(ev, fn); };
  WD.off = (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); };
  WD.emit = (ev, data) => { for (const fn of listeners[ev] || []) { try { fn(data); } catch (e) { console.error(e); } } };
  // Tell every open folder view that the contents of these folders changed.
  WD.changed = (...dirs) => WD.emit('fs-changed', new Set(dirs.flat()));

  // ---------- Settings (per browser) ----------
  WD.settings = {
    get(key, def) {
      try { const v = localStorage.getItem('wp.' + key); return v == null ? def : JSON.parse(v); } catch { return def; }
    },
    set(key, value) {
      try { localStorage.setItem('wp.' + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
    }
  };

  // ---------- Clipboard (files) ----------
  WD.clipboard = { mode: null, paths: [] };
  WD.setClipboard = (mode, paths) => {
    WD.clipboard = { mode, paths: paths.slice() };
    WD.emit('clipboard');
  };
})(window.WD);
