// Garage store — persistent, multi-vehicle collection kept OUTSIDE catalog SQLite
// (catalog DBs are regenerated on re-ingest). One JSON file in OPFS root.
//
// A vehicle bundles an identity (nickname / VIN / decoded fields) with a saved
// spec filter { vfYear, vfMarket, vfLine, vfBody, vfEngine, vfGearbox, engineNo,
// vfPrCodes } so "Open in viewer" restores the exact parts view, plus `partMeta` —
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

  async function load() {
    try {
      const rootDir = await navigator.storage.getDirectory();
      const fh   = await rootDir.getFileHandle(FILE);          // throws if absent
      const text = await (await fh.getFile()).text();
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.vehicles)) return empty();
      // Heal id-less vehicles (e.g. saved before the upsert id fix) so they
      // render with a stable key and can be opened/deleted; persist the repair.
      let healed = false;
      for (const v of data.vehicles) if (v.id == null) { v.id = uuid(); healed = true; }
      if (healed) await save(data);
      return data;
    } catch { return empty(); }
  }

  async function save(data) {
    const rootDir = await navigator.storage.getDirectory();
    const fh = await rootDir.getFileHandle(FILE, { create: true });
    const w  = await fh.createWritable();
    await w.write(JSON.stringify(data, null, 2));
    await w.close();
    return data;
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
  // (`_partKey`) and are content-derived — catalog rowids are reassigned on
  // re-ingest, which would silently move marks onto different parts.

  // Merge a patch ({ ok?, notes? }) into each key of `patches` in ONE file
  // rewrite — marking a whole diagram must not cost one read-modify-write per
  // part. A patch merges over the existing entry, so setting `ok` in bulk keeps
  // any note already on that part. Entries left carrying no information are
  // dropped so the file stays sparse. Returns the vehicle's partMeta, or null if
  // the vehicle is gone.
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
      await save(data);
      return v.partMeta;
    });
  }

  // Single-part convenience. Returns the entry, or null if it was dropped /
  // the vehicle is gone.
  async function setPartMeta(vehicleId, key, patch) {
    const meta = await setPartMetaMany(vehicleId, { [key]: patch });
    return meta ? (meta[key] || null) : null;
  }

  const Garage = { load, save, list, get, upsert, remove,
                   setPartMeta, setPartMetaMany, uuid, VERSION };
  if (typeof module !== 'undefined' && module.exports) module.exports = Garage;
  else root.Garage = Garage;
})(typeof self !== 'undefined' ? self : this);
