# pet-babelfish: Implementation Plan

## Goal

A fully browser-based system for ingesting Porsche PET (Electronic Toolbox) catalog PDFs and
browsing the extracted parts data. Everything — PDF parsing, ingestion pipeline, search, and
viewing UI — runs as JavaScript in the user's browser. Hosted on GitHub Pages; no server, no
Python, no backend.

---

## Architecture

```
GitHub Pages (docs/)
├── index.html            landing page + spike index
├── ingest.html           ingestion UI: file picker → pipeline → OPFS storage
├── viewer.html           parts viewer: browse, search, filter
├── ingest.worker.js      Web Worker: PDF parsing + SQLite writes (off main thread)
└── spikes/               standalone investigation pages (not production code)
```

**No build step.** All vendor JS from CDN. Local dev: `npx serve docs` or
`python -m http.server --directory docs 8080` — HTTP required (WASM + OPFS won't work on
`file://`).

GitHub Pages: enable Pages on `docs/` in repo settings.

---

## Technology Stack

| Concern | Choice | Notes |
|---|---|---|
| PDF parsing | PDF.js 3.11 (cdnjs CDN) | Must pass `cMapUrl` + `standardFontDataUrl` + `canvasFactory` — see below |
| PDF input | `<input type="file">` / drag-and-drop | CORS from 9xxteile.com is blocked (Spike 1) |
| In-browser SQLite | sql.js 1.10.3 (cdnjs CDN) | FTS4 only — cdnjs build does not include FTS5 |
| Persistent storage | OPFS (Origin Private File System) | No size limit; works on localhost + GitHub Pages |
| Heavy work | Web Worker (`ingest.worker.js`) | PDF.js runs in worker with `document` polyfill |
| UI | Alpine.js 3.13 (CDN) + vanilla HTML/CSS | No build step |

### Critical PDF.js configuration

All `pdfjsLib.getDocument()` calls **must** include:

```js
{
  data: arrayBuffer,
  cMapUrl:             'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
  cMapPacked:          true,
  standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/standard_fonts/',
  canvasFactory:       CANVAS_FACTORY,   // OffscreenCanvas-based — required in worker
}
```

Without `cMapUrl`/`standardFontDataUrl`, PDF.js cannot decode CID fonts, returning empty strings.
Without `canvasFactory`, `pdf.min.js` calls `document.createElement('canvas')`, which throws
`ReferenceError: document is not defined` in a Web Worker.

### PDF.js-in-Worker polyfill

`pdf.min.js` is the main-thread API layer and references `document` and `window` in several
places even when a custom `canvasFactory` is provided. Add this before `importScripts`:

```js
if (typeof document === 'undefined') {
  self.document = {
    createElement(tag) { return tag === 'canvas' ? new OffscreenCanvas(1,1) : {}; },
    createElementNS(_ns, tag) { return self.document.createElement(tag); },
    documentElement: { style: {} },
    fonts: { ready: Promise.resolve(), add() {}, check() { return true; } },
    readyState: 'complete',
  };
}
if (typeof window === 'undefined') self.window = self;
```

---

## Spike Results

### Spike 1 — Fetch ✓ DONE
Direct browser `fetch()` from 9xxteile.com is CORS-blocked. **File picker only** for v1.

### Spike 2 — PDF structure ✓ DONE (post-CMap fix)
- **TOC outline is machine-readable** ✓ — clean 3-level hierarchy:
  - Level 1: Model (`Porsche 911 Turbo/GT2`)
  - Level 2: Main groups (`Main group 1: Engine`)
  - Level 3: Sections (`101-000`, `101-005`, …) with page destinations
- **Page layout confirmed** ✓ — TOC destination links to the **diagram page**; the **parts list
  is always diagram page + 1**. Set `diagram_page = toc_dest`, `parts_page = toc_dest + 1`.
- **Column headers confirmed** ✓ (from live rows view on a parts-list page):
  `Pos | Part Number | Description | Remark | Qty | Model`
- **Part number tokenisation** ✓ — Porsche part numbers arrive as multiple separate PDF text
  items because each space-separated group is its own glyph run (e.g. `997 100 970 X` = 4 items).
  Collect all items whose x falls in the Part Number column range and join with a single space.
- **Row types identified** ✓ — see "Parts-list row classification" section below.
- **Column x-boundaries** — derived from header row item positions at parse time; no hardcoded values needed.

### Spike 3 — Diagram callouts ✓ DONE
- **Callout numbers are baked into the diagram image** — not selectable text in any PDF viewer,
  confirmed absent from `getTextContent()` even after CMap fix.
- Clickable overlays are not feasible without OCR/CV.
- **Parts lists and diagrams are on separate pages** ✓
- v1 plan stands: render diagram as PNG; user visually locates callout numbers.

### Spike 4 — Applicability format ✓ DONE (observed in live rows)
- Applicability data appears on **continuation rows immediately below each part row**, not
  in the same y-band. Two token types observed:
  - `PR:480` — Production Release / sales option code (one or more per part)
  - `D-MJ2007>>-MJ2007` — market + model-year range:
    - `D` = Destination (market region, e.g. D = domestic/Germany)
    - `MJ` = Modelljahr (Model Year)
    - `>>` = range separator (from … to)
    - Leading `-` on the right side means "same destination implied"
  - These rows have 1–7 items and sit between the part row above and the next part row below.
  - Parse strategy: after identifying a part row, accumulate all following rows that do not
    match a part-row or group-header pattern as that part's applicability continuation.

---

## Parts-list row classification

Rows within a parts-list page fall into one of these types. **Order matters** — part rows must
be tested before applicability rows because part rows often contain `PR:` codes in the Model
column, which would otherwise trigger the applicability heuristic.

| Type | Item count | Key signal | Action |
|---|---|---|---|
| Section header | 1 | Matches `/^Illustration:\s/` | Skip |
| Model filter | 3–5 | Contains `"Model:"` | Skip |
| **Column header** | 6 | Matches the literal set {Pos, Part Number, …} | Calibrate column origins; skip |
| **Part row** | ≥5 | First item matches `/^\d{1,3}$/` | Flush current part; start new part |
| Sub-part inclusion | ≥4 | First item is `"-"` | Skip — included component, not orderable |
| Applicability continuation | 1–7 | Any item matches `/^PR:/`, `>>`, or `/MJ\d{4}/` | Append to current part's applicability |
| **Diagram title block** | 1–4 | Before first part row; no Pos, no Part Number; has Description/Remark/Model | Accumulate into section title_remark/title_model; may span multiple rows |
| Group headers / notes | any | None of the above | Skip |

After the last row on the page, emit the final in-progress part.

### Column assignment for part rows

The column header row itself defines the boundaries — no hardcoded x values needed.

1. When the column header row is found, record each header item's x as that column's origin:
   ```js
   // e.g. { Pos: 42, 'Part Number': 65, Description: 180, Remark: 380, Qty: 470, Model: 510 }
   const colOrigins = Object.fromEntries(headerItems.map(it => [it.str, it.transform[4]]));
   ```
2. Sort `colOrigins` entries by x to get an ordered list of `[name, x]` pairs.
3. For each item in a data row, assign it to the column whose origin is the largest x ≤ item.x:
   ```js
   function assignCol(itemX, cols) {
     let col = cols[0];
     for (const c of cols) { if (c.x <= itemX + 5) col = c; }
     return col.name;
   }
   ```
4. Group assigned items by column name; join multi-item columns (Part Number, Description) with `" "`.

This self-calibrates per page — if column positions vary between catalog editions, it still works.

---

## Immediate Next Steps

1. **Test ingestion end-to-end** — load a catalog PDF in `ingest.html`, watch the log, verify:
   - Section count matches expected (~hundreds)
   - Part count in the done message is non-zero
   - `catalog.sqlite` appears in OPFS (check DevTools → Application → Storage → OPFS)
   - A diagram PNG for one section renders correctly

2. **Spot-check parse quality** — open browser console, load the SQLite file and run:
   ```js
   // After ingestion, read DB from OPFS and spot-check
   db.exec("SELECT COUNT(*) FROM part");
   db.exec("SELECT position, part_number, description, applicability FROM part LIMIT 20");
   ```

3. **Handle multi-page sections** — some sections may overflow onto a third page
   (parts list spanning diagram+1 and diagram+2). Confirm whether this occurs, then extend
   `extractParts` to follow continuation pages if needed.

4. **Build viewer.html**

---

## Data Model (SQLite, stored in OPFS)

```sql
CREATE TABLE catalog (
    id          TEXT PRIMARY KEY,   -- e.g. "997TT-2005"
    model       TEXT,               -- e.g. "Porsche 911 Turbo/GT2"
    page_count  INTEGER,
    ingested_at TEXT
);

CREATE TABLE main_group (
    id          INTEGER PRIMARY KEY,
    catalog_id  TEXT REFERENCES catalog(id),
    number      TEXT,               -- e.g. "1"
    title       TEXT                -- e.g. "Engine"
);

CREATE TABLE section (
    id              INTEGER PRIMARY KEY,
    main_group_id   INTEGER REFERENCES main_group(id),
    catalog_id      TEXT REFERENCES catalog(id),
    number          TEXT,           -- e.g. "101-000"
    title           TEXT,           -- from TOC if present; overridden by parts-list title row description
    parts_page      INTEGER,        -- 1-based PDF page number
    diagram_page    INTEGER,
    diagram_image   TEXT,           -- OPFS path to PNG
    title_remark    TEXT,           -- remark column of the parts-list title row (e.g. "right")
    title_model     TEXT            -- model column of the parts-list title row (e.g. "9770")
);

CREATE TABLE part (
    id            INTEGER PRIMARY KEY,
    section_id    INTEGER REFERENCES section(id),
    catalog_id    TEXT REFERENCES catalog(id),
    position      TEXT,               -- callout number matching diagram
    part_number   TEXT,               -- e.g. "997 361 701 00"
    description   TEXT,
    quantity      TEXT,
    unit          TEXT,               -- not populated in v1 (no Unit column in PET)
    remarks       TEXT,
    applicability TEXT,               -- raw continuation rows; structured parsing deferred
    raw_columns   TEXT                -- JSON of all column value arrays
);

-- Full-text search (FTS4 — FTS5 not compiled into the cdnjs sql.js build)
CREATE VIRTUAL TABLE part_fts USING fts4(
    content="part",
    part_number, description
);
```

`raw_columns` preserves all column data. `applicability` stores raw continuation-row text
(pipe-separated tokens) while structured PR-code / model-year parsing is deferred.

---

## Ingestion Pipeline (browser, `ingest.worker.js`) ✓ BUILT

```
load PDF  (pdf.min.js + document polyfill + OffscreenCanvas canvasFactory)
  → parse outline → section list (catalog / main_group / section rows)
  → for each section:
      diagram_page = toc_dest
      first_parts_page = toc_dest + 1
      next_diagram_page = sections[i+1].diagramPage  (hard boundary)

      render diagram_page → OffscreenCanvas → PNG → OPFS

      for p = first_parts_page .. next_diagram_page - 1:
        extractParts(p):
          getTextContent() → groupIntoRows() → classify rows (see table above)
          → calibrate column origins from header row
          → emit parts with applicability text
        if page returned 0 parts → break  (hit next diagram page naturally)

  → INSERT all parts via prepared statement
  → INSERT INTO part_fts(part_fts) VALUES('rebuild')
  → db.export() → write catalog.sqlite to OPFS/{catalogId}/catalog.sqlite
```

Diagram PNGs stored at `OPFS/{catalogId}/images/{sectionNum}.png` at 2× scale.

---

## Viewer (`viewer.html`) ✓ BUILT

3-panel layout (Alpine.js 3.13):
- **Left**: collapsible main-group → section tree; click to load section
- **Center**: parts table (Pos / Part Number / Description / Qty / Remark); applicability
  shown inline under Description via `▼ appl.` toggle (Alpine `x-for` only processes one
  root element — sibling `<template>` blocks are silently ignored; inline `x-show` required)
- **Right**: diagram PNG loaded from OPFS via `URL.createObjectURL`; blob URL revoked on navigation
- **Search**: FTS4 with LIKE fallback; results show section badge; click jumps to section

---

## Verified results (997 Turbo/GT2 2007–2009 catalog)

| Metric | Value |
|---|---|
| Sections | 247 |
| Parts | 9,628 |
| Section titles | Populated from the diagram title block on each parts-list page (TOC has section numbers only in this catalog) |
| Part numbers | Correct format throughout (`997 721 115 00`, `7PP 010 707 K`, `3B0 010 219 B`) |
| Applicability | Captured as raw tokens for simple parts; complex multi-variant parts accumulate verbose but correct applicability strings |
| Duplicates | Same part in multiple sections (e.g. assembly paste used in engine + transmission) — correct behaviour |

Console commands for spot-checking after ingestion:

```js
const SQL = await initSqlJs({ locateFile: () => 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.wasm' });
const buf = await (await (await (await (await navigator.storage.getDirectory())
  .getDirectoryHandle('YOUR-CATALOG-ID')).getFileHandle('catalog.sqlite')).getFile()).arrayBuffer();
const db = new SQL.Database(new Uint8Array(buf));
const q  = sql => db.exec(sql)[0];

console.log('sections:', q('SELECT COUNT(*) FROM section').values[0][0]);
console.log('parts:',    q('SELECT COUNT(*) FROM part').values[0][0]);
console.table(q('SELECT position, part_number, description, quantity, applicability FROM part LIMIT 20').values);
console.table(q('SELECT number, title, parts_page, diagram_page FROM section LIMIT 10').values);
```

---

## Diagram display (v1) ✓ DONE

Render diagram PNG next to parts table. User visually locates callout numbers.

Clickable overlays are not feasible — callout numbers are image pixels, not extractable text.

---

## Immediate Next Steps

1. **Ingest additional catalogs** — test against other model lines (996, Cayenne, etc.) to find
   edge cases in TOC structure, column layout, or row classification.

2. **Structured applicability parsing** — parse the raw `applicability` field into structured
   PR-code sets and model-year ranges to enable filtering by vehicle spec.

3. **Viewer: filter by section / model** — add filter controls to viewer.html once applicability
   is structured.

4. **Performance** — sql.js loads the full DB into memory on open. For large catalogs this may
   be slow; profile and consider pagination or lazy loading if needed.
