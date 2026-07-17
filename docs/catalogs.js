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

  root.CATALOGS = { DB_FILE, list, label };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.CATALOGS;
})(typeof self !== 'undefined' ? self : this);
