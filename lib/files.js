'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const archiver = require('archiver');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createFiles(cfg) {
  const root = path.resolve(cfg.rootDir || '/');

  // Normalises a client path into an absolute path and keeps it inside rootDir.
  function resolve(p) {
    if (typeof p !== 'string' || p === '') throw new HttpError(400, 'Brak ścieżki');
    const abs = path.resolve('/', p);
    if (root !== '/' && abs !== root && !abs.startsWith(root + path.sep)) {
      throw new HttpError(403, 'Ścieżka poza dozwolonym katalogiem');
    }
    return abs;
  }

  async function exists(p) {
    try {
      await fsp.lstat(p);
      return true;
    } catch {
      return false;
    }
  }

  // "plik.txt" -> "plik - kopia.txt" -> "plik - kopia (2).txt"
  async function uniqueName(dir, name, suffix = ' - kopia') {
    let candidate = path.join(dir, name);
    if (!(await exists(candidate))) return candidate;
    const ext = path.extname(name);
    const base = ext && ext !== name ? name.slice(0, -ext.length) : name;
    const realExt = ext && ext !== name ? ext : '';
    for (let i = 1; i < 10000; i++) {
      candidate = path.join(dir, `${base}${suffix}${i > 1 ? ` (${i})` : ''}${realExt}`);
      if (!(await exists(candidate))) return candidate;
    }
    throw new HttpError(409, 'Nie można wybrać wolnej nazwy');
  }

  async function list(dir) {
    const abs = resolve(dir);
    const st = await fsp.stat(abs);
    if (!st.isDirectory()) throw new HttpError(400, 'To nie jest folder');
    const dirents = await fsp.readdir(abs, { withFileTypes: true });
    const entries = await Promise.all(dirents.map(async (d) => {
      const full = path.join(abs, d.name);
      const entry = { name: d.name, type: 'file', size: 0, mtime: 0, mode: 0, link: false };
      try {
        let s = await fsp.lstat(full);
        if (s.isSymbolicLink()) {
          entry.link = true;
          try { s = await fsp.stat(full); } catch { entry.broken = true; }
        }
        entry.type = s.isDirectory() ? 'dir' : 'file';
        entry.size = s.isDirectory() ? 0 : s.size;
        entry.mtime = s.mtimeMs;
        entry.mode = s.mode & 0o7777;
      } catch {
        entry.error = true;
      }
      return entry;
    }));
    return {
      path: abs,
      parent: abs === root ? null : path.dirname(abs),
      entries
    };
  }

  async function stat(p) {
    const abs = resolve(p);
    const s = await fsp.stat(abs);
    return { path: abs, type: s.isDirectory() ? 'dir' : 'file', size: s.size, mtime: s.mtimeMs, mode: s.mode & 0o7777 };
  }

  async function readText(p, maxBytes = 10 * 1024 * 1024) {
    const abs = resolve(p);
    const s = await fsp.stat(abs);
    if (s.isDirectory()) throw new HttpError(400, 'To jest folder');
    if (s.size > maxBytes) throw new HttpError(413, 'Plik jest za duży do edycji w przeglądarce (max 10 MB)');
    return fsp.readFile(abs, 'utf8');
  }

  async function writeText(p, content) {
    const abs = resolve(p);
    await fsp.writeFile(abs, String(content ?? ''), 'utf8');
  }

  async function mkdir(p) {
    const abs = resolve(p);
    if (await exists(abs)) throw new HttpError(409, 'Taki element już istnieje');
    await fsp.mkdir(abs, { recursive: true });
    return abs;
  }

  async function touch(p) {
    const abs = resolve(p);
    if (await exists(abs)) throw new HttpError(409, 'Taki element już istnieje');
    await fsp.writeFile(abs, '');
    return abs;
  }

  async function rename(from, to) {
    const src = resolve(from);
    const dst = resolve(to);
    if (src === dst) return dst;
    if (await exists(dst)) throw new HttpError(409, 'Element o tej nazwie już istnieje');
    await fsp.rename(src, dst);
    return dst;
  }

  async function remove(paths) {
    for (const p of paths) {
      const abs = resolve(p);
      if (abs === '/' || abs === root) throw new HttpError(403, 'Nie można usunąć katalogu głównego');
      await fsp.rm(abs, { recursive: true, force: false });
    }
  }

  function assertNotInside(src, destDir) {
    if (destDir === src || destDir.startsWith(src + path.sep)) {
      throw new HttpError(400, `Nie można umieścić folderu „${path.basename(src)}” w nim samym`);
    }
  }

  async function copy(paths, dest) {
    const destDir = resolve(dest);
    const results = [];
    for (const p of paths) {
      const src = resolve(p);
      assertNotInside(src, destDir);
      const target = await uniqueName(destDir, path.basename(src));
      await fsp.cp(src, target, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      results.push(target);
    }
    return results;
  }

  async function move(paths, dest) {
    const destDir = resolve(dest);
    const results = [];
    for (const p of paths) {
      const src = resolve(p);
      if (path.dirname(src) === destDir) continue;
      assertNotInside(src, destDir);
      const target = path.join(destDir, path.basename(src));
      if (await exists(target)) throw new HttpError(409, `W folderze docelowym już jest „${path.basename(src)}”`);
      try {
        await fsp.rename(src, target);
      } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        await fsp.cp(src, target, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
        await fsp.rm(src, { recursive: true });
      }
      results.push(target);
    }
    return results;
  }

  async function chmod(p, mode) {
    const abs = resolve(p);
    const m = parseInt(String(mode), 8);
    if (!Number.isInteger(m) || m < 0 || m > 0o7777) throw new HttpError(400, 'Nieprawidłowe uprawnienia');
    await fsp.chmod(abs, m);
  }

  function run(cmd, args) {
    return new Promise((resolvePromise, reject) => {
      execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') return reject(new HttpError(500, `Brak programu „${cmd}” na serwerze (sudo apt install ${cmd})`));
          return reject(new HttpError(500, (stderr || err.message).trim().slice(0, 500)));
        }
        resolvePromise(stdout);
      });
    });
  }

  const ARCHIVE_RE = /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/i;

  async function extract(p) {
    const abs = resolve(p);
    const m = path.basename(abs).match(ARCHIVE_RE);
    if (!m) throw new HttpError(400, 'Nieobsługiwany format archiwum');
    const baseName = path.basename(abs).slice(0, -m[0].length) || 'archiwum';
    const target = await uniqueName(path.dirname(abs), baseName, ' - rozpakowane');
    await fsp.mkdir(target);
    try {
      if (m[1].toLowerCase() === 'zip') await run('unzip', ['-q', '-o', abs, '-d', target]);
      else await run('tar', ['-xf', abs, '-C', target]);
    } catch (err) {
      await fsp.rm(target, { recursive: true, force: true });
      throw err;
    }
    return target;
  }

  function zipTo(output, absPaths) {
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(output);
    for (const abs of absPaths) {
      const name = path.basename(abs) || 'root';
      const s = fs.statSync(abs);
      if (s.isDirectory()) archive.directory(abs, name);
      else archive.file(abs, { name });
    }
    archive.finalize();
    return archive;
  }

  async function compress(paths, destDir, name) {
    const absPaths = paths.map(resolve);
    const dir = resolve(destDir);
    let fileName = String(name || (absPaths.length === 1 ? path.basename(absPaths[0]) : 'Archiwum'));
    if (!fileName.toLowerCase().endsWith('.zip')) fileName += '.zip';
    const target = await uniqueName(dir, fileName, '');
    await new Promise((resolvePromise, reject) => {
      const out = fs.createWriteStream(target);
      out.on('close', resolvePromise);
      out.on('error', reject);
      const archive = zipTo(out, absPaths);
      archive.on('error', reject);
    });
    return target;
  }

  return {
    root, resolve, exists, list, stat, readText, writeText, mkdir, touch, rename, remove,
    copy, move, chmod, extract, compress, zipTo
  };
}

module.exports = { createFiles, HttpError };
