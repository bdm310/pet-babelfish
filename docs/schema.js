// The catalog schema - the one definition of what a catalog.sqlite is.
// Exposed as self.SCHEMA (browser <script>, worker importScripts) and
// module.exports (node test), the same way appl.js is shared.
//
// Shared so the viewer can check a DB against the schema that wrote it without
// keeping its own list of expected columns. matches() derives the answer from
// this DDL, so a schema change needs no second edit anywhere: add a column here
// and every DB that predates it stops matching on its own.
//
// Nothing migrates. A DB that does not match is re-ingested, never patched.

(function (root) {
  'use strict';

  function create(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS catalog (
        -- title is the TOC's top-level title ("Porsche 911 Turbo/GT2"); model is the
        -- code the V-page headers key on ("997T07"). Displayed as "title - model".
        -- dialect ('modern'|'old') is detected once from V-page header vocabulary and
        -- read back by the viewer to gate the old-dialect grammar forms; year_pivot is
        -- the Model-life start year, the century pivot for two-digit years.
        id TEXT PRIMARY KEY, title TEXT, model TEXT, page_count INTEGER, ingested_at TEXT,
        dialect TEXT, year_pivot INTEGER
      );
      CREATE TABLE IF NOT EXISTS main_group (
        id INTEGER PRIMARY KEY, catalog_id TEXT, number TEXT, title TEXT
      );
      CREATE TABLE IF NOT EXISTS section (
        id INTEGER PRIMARY KEY, main_group_id INTEGER, catalog_id TEXT,
        -- diagram_blob is the rendered diagram as a raw CCITT Group 4 (ITU-T T.6)
        -- bitstream - bilevel line art, ~44% the size of the lossy WebP it replaced,
        -- decoded by ccitt.js for display. T.6 has no header, so diagram_w/diagram_h
        -- carry the pixel dimensions the decoder needs. It lives in the DB because OPFS
        -- costs ~2.6 ms per file however small, so a file per diagram costs ~7.4 s per
        -- import against ~0.3 s for the same bytes here. Never SELECT it in a list
        -- query - read it by section id only when a diagram is actually shown.
        number TEXT, title TEXT, parts_page INTEGER, diagram_page INTEGER,
        diagram_blob BLOB, diagram_w INTEGER, diagram_h INTEGER,
        title_remark TEXT, title_model TEXT,
        -- Scope printed on the section's title row (e.g. "PR:480" gating the whole
        -- manual-gearbox section). AND-ed with each part's own applicability.
        applicability TEXT,
        -- title_model conflates engine, gearbox, model line and body style in one
        -- free-text string, so nothing can filter on any of them. These hold the same
        -- tokens typed and separated, each as a canonical OR-list ("G9750,G9788" =
        -- either gearbox); title_model stays as printed because it is the display
        -- string. NULL means the section does not constrain that facet. drive_code
        -- (2=RWD/4=AWD) and trim_code (S/GTS/RS/RS 4.0) are the decomposed variant
        -- axes; only facets INVARIANT across a title's OR-of-variants are populated.
        engine_code TEXT, gearbox_code TEXT, body_line TEXT, body_style TEXT,
        drive_code TEXT, trim_code TEXT
      );
      -- parent_id: colour/trim variants of a part are CHILD rows. They stay orderable
      -- and searchable but occupy no position of their own and inherit the parent's
      -- applicability, quantity and remark.
      CREATE TABLE IF NOT EXISTS part (
        id INTEGER PRIMARY KEY, section_id INTEGER, catalog_id TEXT,
        parent_id INTEGER REFERENCES part(id),
        position TEXT, part_number TEXT, colour_code TEXT, description TEXT,
        quantity TEXT, remarks TEXT, applicability TEXT
      );
      CREATE INDEX IF NOT EXISTS part_parent_idx ON part(parent_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS part_fts USING fts4(
        content="part",
        part_number, description
      );
      CREATE TABLE IF NOT EXISTS callout (
        id INTEGER PRIMARY KEY, section_id INTEGER,
        number TEXT, x0 INTEGER, y0 INTEGER, x1 INTEGER, y1 INTEGER,
        confidence INTEGER
      );
      CREATE TABLE IF NOT EXISTS pr_code (
        id INTEGER PRIMARY KEY, catalog_id TEXT,
        code TEXT NOT NULL, description TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sales_type (
        id INTEGER PRIMARY KEY, catalog_id TEXT,
        sales_term TEXT NOT NULL, description TEXT NOT NULL,
        mount_from TEXT, mount_to TEXT, remark TEXT
      );
      CREATE TABLE IF NOT EXISTS vin_range (
        id INTEGER PRIMARY KEY, catalog_id TEXT,
        model_year INTEGER, start_date TEXT,
        vin_from TEXT, vin_to TEXT, remark TEXT
      );
      CREATE TABLE IF NOT EXISTS engine_code (
        id INTEGER PRIMARY KEY, catalog_id TEXT,
        ec TEXT NOT NULL, displacement_l TEXT,
        power_kw INTEGER, power_hp INTEGER, cylinders INTEGER,
        mount_from TEXT, mount_to TEXT, remark TEXT
      );
      CREATE TABLE IF NOT EXISTS transmission_code (
        id INTEGER PRIMARY KEY, catalog_id TEXT,
        tc TEXT NOT NULL, type_code TEXT,
        mount_from TEXT, mount_to TEXT, remark TEXT
      );
      CREATE TABLE IF NOT EXISTS engine_number_range (
        id INTEGER PRIMARY KEY, catalog_id TEXT,
        number_from TEXT, number_to TEXT,
        model_year INTEGER, vehicle_type TEXT, engine_type TEXT
      );
      CREATE TABLE IF NOT EXISTS transmission_number_range (
        id INTEGER PRIMARY KEY, catalog_id TEXT,
        number_from TEXT, number_to TEXT,
        model_year INTEGER, vehicle_type TEXT, gearbox_type TEXT
      );
    `);
  }

  // Structural fingerprint: every table and its column names. Read from the DB
  // itself rather than from the DDL text, so the reference and the candidate are
  // measured the same way and formatting can never register as a difference.
  function shape(db) {
    const tables = (db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )[0]?.values ?? []).map(r => r[0]);
    return tables.map(t => {
      const cols = (db.exec(`PRAGMA table_info("${t}")`)[0]?.values ?? [])
        .map(r => r[1]).sort();
      return `${t}(${cols.join(',')})`;
    }).join(';');
  }

  // Does this DB have the shape create() produces? Compared against a throwaway
  // empty DB rather than a hardcoded column list, so this never needs updating.
  function matches(SQL, db) {
    const ref = new SQL.Database();
    try {
      create(ref);
      return shape(ref) === shape(db);
    } catch {
      return false;
    } finally {
      ref.close();
    }
  }

  const SCHEMA = { create, shape, matches };
  if (typeof module !== 'undefined' && module.exports) module.exports = SCHEMA;
  else root.SCHEMA = SCHEMA;
})(typeof self !== 'undefined' ? self : this);
