// Garage store - persistent, multi-vehicle collection kept OUTSIDE catalog SQLite
// (catalog DBs are regenerated on re-ingest). One JSON file in OPFS root.
//
// A vehicle bundles an identity (nickname / VIN / decoded fields) with a saved
// spec filter { vfYear, vfMarket, vfLine, vfBody, vfEngine, vfGearbox, engineNo,
// gearboxNo, vfChassis, vfPrCodes } so "Open in viewer" restores the exact parts
// view, plus `partMeta` -
// the owner's per-part ok/notes marks (see setPartMeta). Every spec field is one
// facet of the catalog's applicability grammar; a blank one does not filter.
// Reserved field (savedParts) is carried through untouched for later phases.
// Exposed as window.Garage.
(function (root) {
  'use strict';

  const FILE    = 'garage.json';
  const VERSION = 1;

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'v-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function empty() { return { version: VERSION, vehicles: [] }; }

  // Every write is a whole-file read-modify-write, so serialize them: a burst of
  // part-meta edits would otherwise interleave load/save and drop entries.
  let queue = Promise.resolve();
  function serialized(fn) {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  }

  // The parsed garage is held in memory and reused: every mutation goes through
  // this module, so re-reading + re-parsing the whole file on each write was pure
  // overhead. `cache` is authoritative once populated; only verified-good data (or
  // a confirmed-absent file) is cached, so a transient read error can't poison it
  // into clobbering a real file on the next save. `dirty` tracks part-meta edits
  // whose disk write is still pending (see scheduleFlush).
  let cache = null;
  let dirty = false, flushTimer = null;

  async function load() {
    if (cache) return cache;
    let fh;
    try {
      const rootDir = await navigator.storage.getDirectory();
      fh = await rootDir.getFileHandle(FILE);                  // throws if absent
    } catch (e) {
      // No file yet (first run): start empty and cache it. Any other storage
      // error: return empty WITHOUT caching, so a later read can recover and a
      // save() can't overwrite a file we merely failed to read this once.
      if (e && e.name === 'NotFoundError') return (cache = empty());
      return empty();
    }
    try {
      const data = JSON.parse(await (await fh.getFile()).text());
      if (!data || !Array.isArray(data.vehicles)) return empty();   // corrupt: don't cache/clobber
      // Heal id-less vehicles (e.g. saved before the upsert id fix) so they
      // render with a stable key and can be opened/deleted; persist the repair.
      let healed = false;
      for (const v of data.vehicles) if (v.id == null) { v.id = uuid(); healed = true; }
      cache = data;
      if (healed) await save(data);
      return cache;
    } catch { return empty(); }
  }

  // Immediate whole-file write. Not pretty-printed - no human reads this file, and
  // the indentation roughly doubled every byte written and later re-parsed. A full
  // save persists the entire cache, so it also satisfies any pending part-meta flush.
  async function save(data) {
    cache = data;
    dirty = false;
    clearTimeout(flushTimer); flushTimer = null;
    const rootDir = await navigator.storage.getDirectory();
    const fh = await rootDir.getFileHandle(FILE, { create: true });
    const w  = await fh.createWritable();
    await w.write(JSON.stringify(data));
    await w.close();
    return data;
  }

  // Part marks land in a burst (mark-all's siblings, rapid checkbox clicks). The
  // in-memory cache is updated synchronously so the caller sees the change at once;
  // the disk write is coalesced to one per quiet window. A backgrounded/closed page
  // flushes first (listener below), so the only exposure is a hard crash inside the
  // window - at most the last few marks, which are re-markable.
  function scheduleFlush() {
    dirty = true;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(queueFlush, 600);
  }
  // Run the pending write through the same queue as every other mutation so it
  // can't interleave with an upsert/remove. A failed write keeps `dirty` set, so
  // the next mark or the page-hide listener retries it rather than losing marks.
  function queueFlush() { return serialized(flush).catch(() => {}); }
  async function flush() {
    clearTimeout(flushTimer); flushTimer = null;
    if (!dirty || !cache) return;
    try { await save(cache); }
    catch (e) { dirty = true; throw e; }
  }

  async function list() { return (await load()).vehicles; }

  async function get(id) { return (await load()).vehicles.find(v => v.id === id) || null; }

  // Insert (no id) or update (matching id). Stamps timestamps. Returns the vehicle.
  async function upsert(vehicle) {
    return serialized(async () => {
      const data = await load();
      const now  = new Date().toISOString();
      // Note: id/createdAt/updatedAt are set AFTER the spread so an incoming
      // `id: undefined` (the form always sends the key) can't clobber them.
      const i = vehicle.id != null ? data.vehicles.findIndex(v => v.id === vehicle.id) : -1;
      if (i >= 0) {
        vehicle = { ...data.vehicles[i], ...vehicle, id: data.vehicles[i].id, updatedAt: now };
        data.vehicles[i] = vehicle;
      } else {
        vehicle = { partMeta: {}, savedParts: [], ...vehicle,
                    id: vehicle.id != null ? vehicle.id : uuid(),
                    createdAt: now, updatedAt: now };
        data.vehicles.push(vehicle);
      }
      await save(data);
      return vehicle;
    });
  }

  async function remove(id) {
    return serialized(async () => {
      const data = await load();
      data.vehicles = data.vehicles.filter(v => v.id !== id);
      await save(data);
    });
  }

  // ── Per-part metadata ───────────────────────────────────────────────
  // vehicle.partMeta maps a part key -> { ok, notes }: the owner's record of a
  // part's physical condition on their own car. Keys come from the viewer
  // (`_partKey`) and are content-derived - catalog rowids are reassigned on
  // re-ingest, which would silently move marks onto different parts.

  // Merge a patch ({ ok?, notes? }) into each key of `patches`, then schedule a
  // single coalesced write - marking a whole diagram, or a burst of clicks, must
  // not cost one whole-file rewrite per part. A patch merges over the existing
  // entry, so setting `ok` in bulk keeps any note already on that part. Entries
  // left carrying no information are dropped so the file stays sparse. Returns the
  // vehicle's (in-memory) partMeta, or null if the vehicle is gone.
  async function setPartMetaMany(vehicleId, patches) {
    return serialized(async () => {
      const data = await load();
      const v = data.vehicles.find(x => x.id === vehicleId);
      if (!v) return null;
      if (!v.partMeta) v.partMeta = {};
      for (const [key, patch] of Object.entries(patches)) {
        const entry = { ...(v.partMeta[key] || {}), ...patch };
        const notes = (entry.notes || '').trim();
        if (entry.ok || notes) v.partMeta[key] = { ok: !!entry.ok, notes };
        else delete v.partMeta[key];
      }
      v.updatedAt = new Date().toISOString();
      // `data` is the cache, mutated in place above; persist it on a debounce
      // rather than rewriting the whole file on every single mark.
      scheduleFlush();
      return v.partMeta;
    });
  }

  // Single-part convenience. Returns the entry, or null if it was dropped /
  // the vehicle is gone.
  async function setPartMeta(vehicleId, key, patch) {
    const meta = await setPartMetaMany(vehicleId, { [key]: patch });
    return meta ? (meta[key] || null) : null;
  }

  // Persist pending marks before the page goes away. visibilitychange->hidden
  // fires while the page is still alive (tab switch, navigation, most closes), so
  // the flush can actually complete - unlike work started from unload/pagehide.
  if (typeof document !== 'undefined' && typeof addEventListener === 'function')
    addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') queueFlush();
    });

  const Garage = { load, save, list, get, upsert, remove,
                   setPartMeta, setPartMetaMany, flush: queueFlush, uuid, VERSION };
  if (typeof module !== 'undefined' && module.exports) module.exports = Garage;
  else root.Garage = Garage;
})(typeof self !== 'undefined' ? self : this);
