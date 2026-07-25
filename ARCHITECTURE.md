# Architecture

The application and its data model. For *what the project is* and how to run it, see
[README.md](README.md); for dev tooling, [tools/README.md](tools/README.md); for the callout
detector/OCR, [ocr/README.md](ocr/README.md).

## Two stages, one interface

The project splits cleanly in two, joined only by a file:

```
PET PDF ──[ ingest ]──▶  <catalogId>/catalog.sqlite  ──[ app ]──▶  filtered parts view
             docs/ingest.*            (in OPFS)              docs/viewer.html, garage.html
```

1. **Ingest** parses a PDF entirely in the browser and writes one SQLite file per catalog to
   OPFS (Origin-Private File System). Nothing about ingest is visible to the app except that file.
2. **App** opens that file and lets the user filter, search, and browse.

Both run as client-side JavaScript hosted from `docs/`. No server, no backend - Python under
`tools/` and `ocr/` is dev/automation only. HTTP is required (WASM + OPFS do not work on
`file://`).

**No build step.** Vendored from CDN: PDF.js 3.11, sql.js 1.10.3 (FTS**4** - the cdnjs build has
no FTS5), Tesseract.js 7, onnxruntime-web 1.20.1, Alpine.js 3.13.

## Files in `docs/` (the app)

| File | Role |
|---|---|
| `index.html` | Landing page / links. |
| `ingest.html` + `ingest.worker.js` | Ingest UI; the worker does all PDF parse + OCR + SQLite writes off the main thread. |
| `viewer.html` | Parts viewer: section tree, parts table, FTS search, diagram + callout overlay, spec filter. |
| `garage.html` + `garage.js` | Saved vehicles (identity + spec filter + per-part Ok/Notes) in a single OPFS `garage.json`. |
| `catalog-browser.html` | Raw SQLite table inspector. |
| `appl.js` | Applicability grammar - the scope language parser/matcher (see below). |
| `vin.js` | VIN decode + chassis/market matching. |
| `schema.js` | The `catalog.sqlite` DDL - the single definition of a catalog's shape. |
| `catalogs.js` | Lists OPFS catalogs by opening each DB and reading its `catalog` row. |
| `ccitt.js` | CCITT Group 4 decoder for `diagram_blob`. |
| `callout-cnn.onnx` | Trained callout-detector model (see [ocr/README.md](ocr/README.md)). |
| `tessdata/porsche.traineddata[.gz]` | Tesseract model that *recognizes* digits in accepted callout boxes. |
| `theme.js` + `theme.css` | Light/dark theming. |

`appl.js`, `vin.js`, `schema.js` use one module pattern (`self.X` in the browser/worker via
`<script src>`/`importScripts`, `module.exports` for the node-less tests) so ingest and app share
one implementation, never two that can drift.

## Data model

One catalog is exactly one file, `<catalogId>/catalog.sqlite`. `schema.js` is the authoritative
DDL; this section is the prose behind it. Nothing migrates - a DB whose shape no longer matches
`schema.js` is re-ingested, never patched (`SCHEMA.matches()` decides by comparing against a fresh
empty DB, so adding a column needs no second edit anywhere).

Tables: `catalog`, `main_group`, `section`, `part`, `part_fts`, `callout`, `pr_code`,
`sales_type`, `vin_range`, `engine_code`, `transmission_code`, `engine_number_range`,
`transmission_number_range`.

### Parts catalog (core)

**catalog** - one row per ingested PDF (`id`, `title`, `model`, `page_count`, `ingested_at`,
`dialect`, `year_pivot`).
- `title` is the TOC's top-level title (`Porsche 911 Turbo/GT2`); `model` is the code every V-page
  header keys on (`997T07`), parsed from `Model: <code> Model life <years>`. The code is not a
  single token (`356 50`, `9PA 03`), so `Model life` marks its right edge. Displayed as
  `title - model`.
- `dialect` (`modern` | `old`) is detected once from V-page header vocabulary and read back by the
  viewer to gate the old-dialect grammar forms. `year_pivot` is the Model-life start year - the
  century pivot for two-digit years.

**main_group** - top-level groups 0–9 (Engine, Gearbox, Body, …).

**section** - numbered like `103-010`.
- `parts_page`, `diagram_page`; `diagram_blob` is the rendered diagram as a raw **CCITT Group 4**
  (ITU-T T.6) bitstream - bilevel line art, ~44% the size of the lossy WebP it replaced, decoded by
  `ccitt.js` for display. T.6 has no header, so `diagram_w`/`diagram_h` carry the pixel dimensions
  the decoder needs. It lives in the DB because OPFS costs ~2.6 ms per file however small - a file
  per diagram costs ~7.4 s per import vs ~0.3 s for the same bytes inside the DB. **Never SELECT
  `diagram_blob` in a list query** - read it by section id only when a diagram is actually shown, or
  a list of titles drags every diagram into memory. One file also means `viewer.html?sqlite=URL`
  can show diagrams.
- `applicability` - scope printed on the section's title row (e.g. `701-000` = `PR:480`). It gates
  every part in the section - AND-ed with each part's own applicability.
- `title_model` is the Model column **as printed**, display-only: it conflates engine, gearbox,
  model line and body style in one free-text string. `engine_code`, `gearbox_code`, `body_line`,
  `body_style`, `drive_code` (2=RWD / 4=AWD), `trim_code` (S/GTS/RS/…) hold the same tokens typed
  and separated, each a canonical OR-list (`gearbox_code = 'G9750,G9788'` = either gearbox). NULL
  means the section does not constrain that facet; only facets **invariant** across a title's
  OR-of-variants are populated. **Filter on these, never on `title_model`.**
- A section title's engine/gearbox code is the **union** of the codes inside, not a per-part gate:
  gearbox-specific parts carry their own code, genuinely shared parts (fluid, bearings) carry none.
  Match it as an OR-list - `title_model == vehicle.engine` breaks the parts behind `9770+` and
  `G9750,G9788`.

**part** - `position`, `part_number`, `colour_code`, `description`, `quantity`, `remarks`,
`applicability`, `parent_id`.
- A part is a **block**: a header row plus continuation rows that extend each column independently.
  `extractParts()` is block-oriented; a row-oriented read of this PDF is wrong. A year footer scopes
  the single row it is printed under, not the run of rows above it.
- `position` is plain `1`/`2`, parenthesized `(1)`/`(5)` (diagram callout refs), or compound
  `3/2` / `(3/1)` (older catalogs).
- `parent_id` - colour/trim variants are **child rows** of their parent block. They carry no
  `position` and inherit the parent's applicability/quantity/remark. Top-level parts are
  `parent_id IS NULL`.
- A child's `applicability` is empty when it shares the parent's scope; the viewer inherits via
  `COALESCE(NULLIF(p.applicability,''), pp.applicability)`. When a variant carries its own scope
  (its own Model text, or a year footer under it) the child stores its **full effective scope** -
  parent facets already merged in - because that COALESCE *replaces* rather than merges, so a child
  holding only its delta would escape the parent's PR gate.
- `colour_code` - the trim code on a variant row (`FSA`), also kept as a suffix on `part_number`.
- Applicability also carries **serial breakpoints**: `F >> 99-8S780 473` (chassis) and
  `M >> 628 01460` (engine number). Not a flat number line - the catalog allocates a separate block
  per variant/market, so a breakpoint only speaks about a car in its own
  `vin_range`/`engine_number_range` block. `APPL.serialAdmits` enforces that; the viewer resolves
  the car's block and passes it in.

**part_fts** - FTS4 virtual table over `part_number` + `description`; the viewer's search falls
back to LIKE when FTS is unavailable.

**callout** - one row per detected diagram callout: `number` (string token, `\d{1,3}(/\d{1,3})?`),
`x0,y0,x1,y1` and `confidence`. Boxes are stored in a **per-axis 0–10000 normalized** space
(`x` by width, `y` by height), not pixels - so they overlay any render scale. Links to parts by
matching `number` against the stripped `position` within the same `section_id`. Callouts are not a
subset of part positions (the shared diagram shows every position; the parts list shows only those
applicable to this variant), so orphan callouts are normal and benign.

### V-pages (model/option info, parsed from the intro pages)

| Table | Contents |
|---|---|
| `pr_code` | Option code → description (`480` = 6-speed manual, `XAA` = Aerokit Cup); decodes `part.applicability`. |
| `sales_type` | Body/trim variants (`997840` = Turbo GT2); `mount_from`/`mount_to` (MM/YY). |
| `vin_range` | Chassis serial ranges by `model_year`, `vin_from`, `vin_to`, `start_date`, `remark` (market). |
| `engine_code` | EC codes: `displacement_l`, `power_kw`, `power_hp`, `cylinders`, date range. |
| `transmission_code` | TC codes: `type_code` (`6S`, `5A`), date range. |
| `engine_number_range` | Serial ranges per `model_year` + `vehicle_type` + `engine_type`. Sound - a number resolves to exactly one row, so `vfEngine` derives from it. |
| `transmission_number_range` | Serial ranges per `model_year` + `vehicle_type` + `gearbox_type`. **Never derive a gearbox from this.** The `A9750` and `G9750` ranges are byte-identical every year, so it cannot tell Tiptronic from manual. Gearbox comes from a PR code or the user. |

## Applicability grammar (`docs/appl.js`)

One parser, shared by `ingest.worker.js` (`importScripts`) and the viewer/garage (`<script src>`).
It is the only thing that understands the scope language printed in the Model column and in
year/breakpoint footers: `PR:` option slots (OR within a token, AND across tokens, `-nnn`
negates), model lines, body styles, engine/gearbox codes, `MJ` year ranges, quoted markets
(`"ROK"`, `-"CN."`), and chassis/engine serial breakpoints. **`,` is OR and `+` is AND** - a `+`
dangling at the end of a column has just lost its right operand to the column split.

`parse()` returns typed, separate facets; `matches(parsed, vehicle)` evaluates them against a
vehicle spec. Two invariants:
- **A blank vehicle field never constrains and never rejects.**
- **An unrecognised token is captured in `unknown` and never enforced** - this keeps `Z97.00` (a
  code with no V-page table) permissive rather than fatal.

Vehicle facets (`vfLine`, `vfBody`, `vfEngine`, `vfGearbox`, `vfYear`, `vfMarket`, `vfPrCodes`) are
user-editable per vehicle in the garage, offered from the catalog's own tables and VIN-prefilled
only where a sound derivation exists.

`tools/appl-test.js` holds the assertions (run via the repo's Chromium - there is no node here).
Extend it alongside any grammar change.

## Non-obvious, load-bearing gotchas

- **PDF.js in a Worker** - every `getDocument()` must pass `cMapUrl` + `standardFontDataUrl` (else
  CID fonts decode to empty strings) and an OffscreenCanvas-based `canvasFactory` (else
  `document.createElement('canvas')` throws in the worker). `pdf.min.js` also touches
  `document`/`window`, so a minimal polyfill is installed before `importScripts`.
- **Callout numbers are image pixels, not text** - confirmed absent from `getTextContent()`. OCR is
  the only route; there are no selectable overlays.
- **Parts-list layout** - the TOC destination is the diagram page; the parts list starts at diagram
  +1 and may overflow further. Column origins are calibrated from each page's header row (no
  hardcoded x). Applicability lives on continuation rows below each part row.
- **Alpine `x-if` renders only `content.firstElementChild`** - a template wrapping several siblings
  silently renders the first and drops the rest, with no error. Mutually exclusive states must be
  flat sibling templates (`!searchMode && <state>`), not one nested template.
- **onnxruntime-web's shared `InferenceSession` is not reentrant** - concurrent `session.run()`
  under `Promise.all` clobbers the shared output binding and throws. Inference is serialized through
  a promise chain (`runOrt()`); Tesseract stays parallel. See [ocr/README.md](ocr/README.md).
