// Garage store — persistent, multi-vehicle collection kept OUTSIDE catalog SQLite
// (catalog DBs are regenerated on re-ingest). One JSON file in OPFS root.
//
// A vehicle bundles an identity (nickname / VIN / decoded fields) with a saved
// spec filter { vfYear, vfMarket, vfPrCodes } so "Open in viewer" restores the
// exact parts view. Reserved fields (notes, savedParts) are carried through
// untouched for later phases. Exposed as window.Garage.
(function (root) {
  'use strict';

  const FILE    = 'garage.json';
  const VERSION = 1;

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'v-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function empty() { return { version: VERSION, vehicles: [] }; }

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
    const data = await load();
    const now  = new Date().toISOString();
    // Note: id/createdAt/updatedAt are set AFTER the spread so an incoming
    // `id: undefined` (the form always sends the key) can't clobber them.
    const i = vehicle.id != null ? data.vehicles.findIndex(v => v.id === vehicle.id) : -1;
    if (i >= 0) {
      vehicle = { ...data.vehicles[i], ...vehicle, id: data.vehicles[i].id, updatedAt: now };
      data.vehicles[i] = vehicle;
    } else {
      vehicle = { notes: '', savedParts: [], ...vehicle,
                  id: vehicle.id != null ? vehicle.id : uuid(),
                  createdAt: now, updatedAt: now };
      data.vehicles.push(vehicle);
    }
    await save(data);
    return vehicle;
  }

  async function remove(id) {
    const data = await load();
    data.vehicles = data.vehicles.filter(v => v.id !== id);
    await save(data);
  }

  const Garage = { load, save, list, get, upsert, remove, uuid, VERSION };
  if (typeof module !== 'undefined' && module.exports) module.exports = Garage;
  else root.Garage = Garage;
})(typeof self !== 'undefined' ? self : this);
