'use strict';
/* Upload queue: drag & drop of files and whole folders from the computer, with progress. */
(function (WD) {
  const { h } = WD;
  const CONCURRENCY = 3;
  const queue = [];
  let active = 0;
  let seq = 0;
  let hideTimer = null;

  const panel = () => document.getElementById('upload-panel');
  const list = () => document.getElementById('upload-list');
  const tray = () => document.getElementById('upload-tray');

  // Is this drag event carrying files from the operating system?
  WD.hasOsFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

  function readAllEntries(reader) {
    return new Promise((resolve, reject) => {
      const all = [];
      const next = () => reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        next();
      }, reject);
      next();
    });
  }

  async function walk(entry, prefix, out) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.files.push({ file, rel: prefix + file.name });
    } else if (entry.isDirectory) {
      const children = await readAllEntries(entry.createReader());
      if (!children.length) out.dirs.push(prefix + entry.name);
      for (const c of children) await walk(c, prefix + entry.name + '/', out);
    }
  }

  // Must be called synchronously inside the drop handler (DataTransfer is cleared afterwards).
  WD.uploadDrop = function (e, destDir) {
    const dt = e.dataTransfer;
    const entries = [];
    const plainFiles = [];
    for (const item of Array.from(dt.items || [])) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) entries.push(entry);
      else if (item.getAsFile()) plainFiles.push(item.getAsFile());
    }
    if (!entries.length && !plainFiles.length) for (const f of Array.from(dt.files || [])) plainFiles.push(f);

    (async () => {
      const out = { files: plainFiles.map((f) => ({ file: f, rel: f.name })), dirs: [] };
      for (const en of entries) await walk(en, '', out);
      await enqueue(out, destDir);
    })().catch(WD.error);
  };

  // From an <input type="file"> (optionally with webkitdirectory).
  WD.uploadFiles = function (fileList, destDir) {
    const files = Array.from(fileList).map((f) => ({ file: f, rel: f.webkitRelativePath || f.name }));
    enqueue({ files, dirs: [] }, destDir).catch(WD.error);
  };

  WD.pickAndUpload = function (destDir, folder) {
    const input = h('input', { type: 'file', multiple: true, style: { display: 'none' } });
    if (folder) input.webkitdirectory = true;
    input.addEventListener('change', () => { WD.uploadFiles(input.files, destDir); input.remove(); });
    document.body.append(input);
    input.click();
  };

  async function enqueue({ files, dirs }, destDir) {
    if (!files.length && !dirs.length) return;
    // Detect name conflicts on the top level of the target folder.
    let existing = new Set();
    try {
      const listing = await WD.api.get('/api/list', { path: destDir });
      existing = new Set(listing.entries.map((e) => e.name));
    } catch (err) {
      return WD.error(err);
    }
    const tops = new Set([...files.map((f) => f.rel.split('/')[0]), ...dirs.map((d) => d.split('/')[0])]);
    const conflicts = [...tops].filter((n) => existing.has(n));
    let overwrite = false;
    if (conflicts.length) {
      const names = conflicts.slice(0, 5).map((n) => '„' + n + '”').join(', ') + (conflicts.length > 5 ? ` i ${conflicts.length - 5} innych` : '');
      const choice = await WD.dialog({
        title: 'Pliki już istnieją',
        body: `W folderze docelowym już są: ${names}. Co zrobić?`,
        buttons: [
          { label: 'Zastąp', value: 'replace', kind: 'primary' },
          { label: 'Pomiń', value: 'skip' },
          { label: 'Anuluj', value: null }
        ]
      });
      if (!choice) return;
      if (choice === 'skip') {
        files = files.filter((f) => !existing.has(f.rel.split('/')[0]));
        dirs = dirs.filter((d) => !existing.has(d.split('/')[0]));
      } else {
        overwrite = true;
      }
    }

    for (const d of dirs) {
      WD.api.post('/api/mkdir', { path: WD.path.join(destDir, d) }).catch(() => {});
    }
    if (dirs.length) WD.changed(destDir);

    for (const f of files) {
      const item = {
        id: ++seq,
        file: f.file,
        target: WD.path.join(destDir, f.rel),
        destDir,
        overwrite,
        status: 'waiting',
        loaded: 0
      };
      item.el = h('div', { class: 'up-item' },
        h('div', { class: 'up-name' }, h('b', { title: item.target }, f.rel), h('span', {}, 'Oczekuje')),
        h('div', { class: 'progress' }, h('i')));
      list().prepend(item.el);
      queue.push(item);
    }
    if (files.length) {
      panel().hidden = false;
      updateTray();
      pump();
    }
  }

  function setStatus(item, status, text) {
    item.status = status;
    item.el.className = 'up-item ' + status;
    item.el.querySelector('.up-name span').textContent = text;
  }

  function pump() {
    while (active < CONCURRENCY) {
      const item = queue.find((i) => i.status === 'waiting');
      if (!item) break;
      start(item);
    }
    updateTray();
  }

  function start(item) {
    active++;
    setStatus(item, 'uploading', '0%');
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    const q = new URLSearchParams({ path: item.target });
    if (item.overwrite) q.set('overwrite', '1');
    xhr.open('POST', '/api/upload?' + q);
    xhr.setRequestHeader('X-WebPulpit', '1');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    const bar = item.el.querySelector('.progress > i');
    const t0 = Date.now();
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = e.total ? Math.round((e.loaded / e.total) * 100) : 100;
      bar.style.width = pct + '%';
      const speed = e.loaded / Math.max(0.5, (Date.now() - t0) / 1000);
      item.el.querySelector('.up-name span').textContent = `${pct}% · ${WD.fmt.size(speed)}/s`;
    };
    xhr.onload = () => {
      active--;
      if (xhr.status >= 200 && xhr.status < 300) {
        bar.style.width = '100%';
        setStatus(item, 'done', WD.fmt.size(item.file.size));
        WD.changed(item.destDir, WD.path.dir(item.target));
      } else {
        let msg = 'Błąd ' + xhr.status;
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* not JSON */ }
        if (xhr.status === 401) location.href = '/login';
        setStatus(item, 'error', msg);
      }
      pump();
    };
    xhr.onerror = () => { active--; setStatus(item, 'error', 'Błąd połączenia'); pump(); };
    xhr.onabort = () => { active--; setStatus(item, 'error', 'Anulowano'); pump(); };
    xhr.send(item.file);
  }

  function updateTray() {
    const pending = queue.filter((i) => i.status === 'waiting' || i.status === 'uploading').length;
    const t = tray();
    t.hidden = queue.length === 0;
    t.querySelector('.count').textContent = pending ? String(pending) : '';
    document.getElementById('upload-title').textContent = pending
      ? `Wysyłanie: pozostało ${pending}`
      : `Wysłano (${queue.filter((i) => i.status === 'done').length} plików)`;
    if (!pending) {
      const failed = queue.filter((i) => i.status === 'error' && !i.reported);
      for (const i of failed) i.reported = true;
      if (failed.length) WD.toast(`Nie udało się wysłać ${failed.length} plików`, 'error');
      // Everything went fine: hide the panel after a moment.
      clearTimeout(hideTimer);
      if (queue.length && !queue.some((i) => i.status === 'error')) {
        hideTimer = setTimeout(() => { panel().hidden = true; }, 4000);
      }
    } else {
      clearTimeout(hideTimer);
    }
  }

  window.addEventListener('beforeunload', (e) => {
    if (active > 0) { e.preventDefault(); e.returnValue = ''; }
  });

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('upload-close').addEventListener('click', () => { panel().hidden = true; });
    document.getElementById('upload-tray').addEventListener('click', () => { panel().hidden = !panel().hidden; });
    document.getElementById('upload-clear').addEventListener('click', () => {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].status === 'done' || queue[i].status === 'error') {
          queue[i].el.remove();
          queue.splice(i, 1);
        }
      }
      updateTray();
      if (!queue.length) panel().hidden = true;
    });
  });
})(window.WD);
