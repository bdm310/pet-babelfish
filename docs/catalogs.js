// catalogs.js — the OPFS catalog directory, read the same way everywhere.
// Exposed as self.CATALOGS (browser <script>), the same module pattern as
// appl.js and schema.js.
//
// The catalog table is the only thing that knows a catalog's name, so listing
// opens each `<catalogId>/catalog.sqlite` and asks it. Every page that shows a
// catalog list calls this, so none of them can drift into labelling a catalog
// by its directory name.

(function (root) {
  'use strict';

  const DB_FILE = 'catalog.sqlite';
  // Pre-ingested catalogs shipped with the app, listed by docs/catalogs/manifest.json
  // (built from catalogs.zip; see tools/build-catalogs.py). Fetched lazily and copied
  // into OPFS on first open so they then behave exactly like a locally-ingested one.
  const MANIFEST_URL = 'catalogs/manifest.json';

  // "Porsche 911 Turbo/GT2 - 997T07". Either half may be missing on an odd
  // catalog, so drop the dash rather than print a dangling one; with neither,
  // the id is all we can say.
  function label(title, model, id) {
    return [title, model].filter(Boolean).join(' - ') || id || '';
  }

  // → [{ id, title, model, label }] for every catalog dir in OPFS.
  // A catalog written by an older schema has no title/model to read; it labels
  // as its id, which is also what the viewer tells you to re-ingest.
  async function list(SQL) {
    const found = [];
    let rootDir;
    try { rootDir = await navigator.storage.getDirectory(); } catch { return found; }

    for await (const [id, handle] of rootDir.entries()) {
      if (handle.kind !== 'directory') continue;
      let fh;
      try { fh = await handle.getFileHandle(DB_FILE); } catch { continue; }  // not a catalog dir

      let title = '', model = '', db = null;
      try {
        const buf = await (await fh.getFile()).arrayBuffer();
        db = new SQL.Database(new Uint8Array(buf));
        const row = db.exec('SELECT title, model FROM catalog LIMIT 1')[0]?.values?.[0];
        if (row) [title, model] = row;
      } catch { /* unreadable or pre-title schema — fall back to the id */ }
      finally { if (db) db.close(); }

      found.push({ id, title: title || '', model: model || '', label: label(title, model, id) });
    }
    return found;
  }

  // The bundled-catalog manifest, or [] when the app is served without one.
  // Each entry: { id, file, title, model, bytes, vinRanges:[{model_year,vin_from,vin_to,remark}] }.
  // vinRanges rides along so a VIN can pick a bundled catalog before it is downloaded.
  async function bundled() {
    try {
      const resp = await fetch(MANIFEST_URL, { cache: 'no-cache' });
      if (!resp.ok) return [];
      const list = await resp.json();
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  }

  // Copy a bundled catalog into OPFS under its id so the rest of the app — which
  // only ever reads OPFS — can open it. A catalog already in OPFS (installed
  // earlier, or re-ingested locally under the same id) is left untouched: we never
  // overwrite the user's own copy. Idempotent; returns when the file is present.
  async function install(entry) {
    const root = await navigator.storage.getDirectory();
    const dir  = await root.getDirectoryHandle(entry.id, { create: true });
    try { await dir.getFileHandle(DB_FILE); return; } catch {}   // already there
    const resp = await fetch('catalogs/' + encodeURIComponent(entry.file), { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`catalog fetch failed (${resp.status}): ${entry.file}`);
    const buf = await resp.arrayBuffer();
    const fh  = await dir.getFileHandle(DB_FILE, { create: true });
    const w   = await fh.createWritable();
    await w.write(buf);
    await w.close();
  }

  // Every catalog offered in a picker: those in OPFS first, then bundled ones not
  // yet installed. `installed` distinguishes them; a bundled id that shadows an OPFS
  // one is dropped (the local copy wins). Selecting a not-installed entry must
  // `install()` it before the catalog is opened.
  async function listAll(SQL) {
    const opfs = (await list(SQL)).map(c => ({ ...c, installed: true, file: null }));
    const have = new Set(opfs.map(c => c.id));
    const extra = (await bundled())
      .filter(b => !have.has(b.id))
      .map(b => ({ id: b.id, title: b.title || '', model: b.model || '',
                   label: label(b.title, b.model, b.id),
                   installed: false, file: b.file, bytes: b.bytes || 0 }));
    return [...opfs, ...extra];
  }

  root.CATALOGS = { DB_FILE, list, label, bundled, install, listAll };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.CATALOGS;
})(typeof self !== 'undefined' ? self : this);
