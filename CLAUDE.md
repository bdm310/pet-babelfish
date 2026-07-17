Be terse. Don't use more words when fewer will do.

Our goal is to build a system for downloading, ingesting, analyzing, and displaying the information contained in Porsche parts catalogs.

Things the user will want to do:
1. View the parts catalog filtered to a specific vehicle, vehicle+options, options alone, or any other partial or complete filter.
2. Quickly see what a part looks like and it's position in diagram views.
3. Search by name or part number
4. ???

These catalogs can be found as PDFs published by Porsche and may get supplemented by VIN decoding or manual entry of specific vehicle options. We won't distribute PDFs due to copyright concerns but we will build in automatic fetch from some existing sources. The catalog format is consistent across model lines. Most data is in real text in the PDF, with only the parts diagrams being images. Those diagrams do have cross-reference numbers in them which will need to be identified and extracted.

We need to ingest these catalogs and build our own data model from them in order to facilitate the kinds of manipulation and view the user will get at the end.

We'll use the simplest tools we can for each part. Everything will run local to the user's computer (outside of web fetches for data) and the UI should be a simple local hosted application.

There's two distinct portions of the project, separated by a clean interface. The first is ingesting and converting data to our model, which produces some output artifact(s) like data tables, part images, and diagrams. The second is the application which takes in those artifacts and allows the user to do their desired actions. These parts could share a single user interface or be entirely separate.

There's a selection of catalog PDFs in the pet-source-pdf folder in this repo.

## Development tools (`tools/`)

All tools use the same persistent Playwright profile (`tools/.playwright-profile/`) so OPFS catalog data survives between runs.

**One-time setup:**
```powershell
uv run --with playwright python -m playwright install chromium
```

### Ingest (`tools/ingest.py`)

Automates PDF ingest with no browser interaction. Starts a local server, uploads the PDF to `ingest.html` via Playwright, waits for the worker to finish.

```powershell
# First ingest — runs full pipeline including diagram rendering + OCR (slow)
uv run --with playwright python tools/ingest.py catalog.pdf --catalog-id 997tt

# Re-extract parts text only — skips OCR entirely (fast, use when iterating on part extraction)
uv run --with playwright python tools/ingest.py catalog.pdf --catalog-id 997tt --parts-only

# Re-run everything including OCR (use when diagram/OCR logic changes)
uv run --with playwright python tools/ingest.py catalog.pdf --catalog-id 997tt --force
```

`--parts-only` falls back to full ingest automatically if the catalog doesn't exist yet.

### Verify (`tools/verify.py`)

Exports the SQLite from OPFS, runs DB summary queries with Python `sqlite3`, and takes four screenshots of the live viewer. Output goes to a timestamped `verify-output/` directory.

```powershell
uv run --with playwright python tools/verify.py --catalog-id 997tt
uv run --with playwright python tools/verify.py --catalog-id 997tt --section 101-000 --search "Bremsbelag"
```

Screenshots produced: `viewer-loaded.png`, `viewer-section.png`, `viewer-search.png`, `catalog-browser.png`. Summary stats (counts, OCR confidence, sample parts) written to `summary.txt`.

### Screenshot (`tools/screenshot.py`)

Single-shot screenshot or JS eval against any page. Useful for quick visual checks without running the full verify suite.

```powershell
uv run --with playwright python tools/screenshot.py --catalog 997tt --start-server
uv run --with playwright python tools/screenshot.py --url http://localhost:8080/viewer.html --out before.png
uv run --with playwright python tools/screenshot.py --eval "document.getElementById('statusBar').textContent"
```

### Inspect PDF (`tools/inspect-pdf.py`)

Dumps page text from a source PDF for comparison against ingested DB data.

```powershell
uv run --with pdfplumber python tools/inspect-pdf.py catalog.pdf --toc
uv run --with pdfplumber python tools/inspect-pdf.py catalog.pdf --pages 10-20 --search "Bremsbelag"
```

### DB queries (interactive)

Two ways to run SQL against the live in-browser database:

**Via wrapper script** (requires `serve.ps1` running and a catalog open in the browser):
```powershell
.\tools\db-query.ps1 "SELECT COUNT(*) FROM part WHERE applicability != ''"
```

**Export SQLite to file** (then query with any SQL tool):
```powershell
.\tools\export-sqlite.ps1 -Out my-catalog.sqlite
```

### Serve + query bridge (`serve.ps1`)

Starts the static file server on `:8080` and the query bridge on `:9876` together. The query bridge lets `db-query.ps1` and `export-sqlite.ps1` talk to whichever catalog is open in `catalog-browser.html` or `viewer.html`.

```powershell
.\serve.ps1
```

## Database access (live query bridge)

The database lives in the browser (sql.js + OPFS). To query it live:

1. Run `.\query-bridge.ps1` in a terminal and leave it running.
2. Open `docs/catalog-browser.html` in the browser and select a catalog.
3. Query via PowerShell:

```powershell
Invoke-WebRequest http://localhost:9876/query -Method POST -Body "SELECT ..." -UseBasicParsing | Out-Null
Start-Sleep -Seconds 2
(Invoke-WebRequest http://localhost:9876/result -UseBasicParsing).Content
```

The browser polls `/query` every 500ms, executes against the live DB, and POSTs JSON results to `/result`. When no catalog is selected the bridge silently idles.

## Data model summary

Tables: `catalog`, `main_group`, `section`, `part`, `callout`, `pr_code`, `sales_type`, `vin_range`, `engine_code`, `transmission_code`, `engine_number_range`, `transmission_number_range`

**Parts catalog (core)**
- **catalog**: one row per ingested PDF (`id`, `model`, `page_count`, `ingested_at`)
- **main_group**: top-level groups 0-9 (Engine, Gearbox, Body, etc.)
- **section**: numbered like `103-010`; has `parts_page`, `diagram_page`, `diagram_image` path, `title_remark` (left/right), `applicability` (section-level scope printed on the title row — gates every part in the section, e.g. `701-000` = `PR:480`)
  - `title_model` is the Model column **as printed** and is display-only — it conflates engine, gearbox, model line and body style in one free-text string. `engine_code`, `gearbox_code`, `body_line`, `body_style` hold the same tokens typed and separated, each a canonical OR-list (`gearbox_code = 'G9750,G9788'` = either gearbox); NULL means the section does not constrain that facet. Filter on these, never on `title_model`.
  - A section title's engine/gearbox code is the **union** of the codes inside, not a per-part gate: gearbox-specific parts carry their own code, genuinely shared parts (fluid, bearings) carry none. Match it as an OR-list — `title_model == vehicle.engine` breaks the parts behind `9770+` and `G9750,G9788`.
- **part**: `position` is either plain `1`/`2` or parenthesized `(1)`/`(5)` (the latter are diagram callout refs); `applicability` encodes PR option codes + variant token + market + model year range, e.g. `TURBO/COUPE PR:098,490,981 | D >> - MJ 2007`
  - `parent_id` — colour/trim variants are **child rows** of their parent block. They carry no `position`. Top-level parts are `parent_id IS NULL`.
  - A child's `applicability` is empty when it shares the parent's scope, and the viewer inherits via `COALESCE(NULLIF(p.applicability,''), pp.applicability)`. When a variant carries its own scope (its own Model text, or a year footer printed under it) the child stores its **full effective scope** — the parent's facets already merged in — because that COALESCE *replaces* rather than merges, and a child holding only its own delta would silently escape the parent's PR gate.
  - `colour_code` — the trim code on a variant row (`FSA`), also retained as a suffix on `part_number`.
  - A part is a **block**: a header row plus continuation rows that extend each column independently. `extractParts()` is block-oriented; a row-oriented read of this PDF is wrong. A year footer scopes the single row it is printed under, not the run of rows above it.
  - Applicability also carries **serial breakpoints**: `F >> 99-8S780 473` (chassis) and `M >> 628 01460` (engine number). These are not a flat number line — the catalog allocates a separate block per variant/market, so a breakpoint only speaks about a car in its own `vin_range`/`engine_number_range` block. `APPL.serialAdmits` enforces that; the viewer resolves the car's block and passes it in.
- **callout**: OCR-extracted bounding boxes (pixel coords at 2× scale) per section diagram; links to parts via matching `number` against the stripped position value within the same `section_id`

**V-pages (model/option info, parsed from intro pages)**
- **pr_code**: option code → description, e.g. `480` = "6-speed manual transmission", `XAA` = "Aerokit Cup"; used to decode `part.applicability`
- **sales_type**: body/trim variants, e.g. `997840` = "Turbo GT2"; has `mount_from`/`mount_to` (MM/YY)
- **vin_range**: VIN ranges by `model_year`, `vin_from`, `vin_to`, `start_date`, `remark` (market, e.g. "997 Turbo (USA, CN, CDN, MEX, BR)")
- **engine_code**: EC codes with `displacement_l`, `power_kw`, `power_hp`, `cylinders`, date range
- **transmission_code**: TC codes with `type_code` (e.g. "6S", "5A"), date range
- **engine_number_range**: serial ranges (`number_from`/`number_to`) per `model_year` + `vehicle_type` + `engine_type`. Sound — an engine number resolves to exactly one row, so this is how `vfEngine` is derived.
- **transmission_number_range**: serial ranges per `model_year` + `vehicle_type` + `gearbox_type`. **Never derive a gearbox from this table.** The `A9750` and `G9750` ranges are byte-identical in every model year, so it structurally cannot tell Tiptronic from manual, and a real serial resolves to the wrong code. Gearbox comes from a PR code or from the user.

## Applicability grammar (`docs/appl.js`)

One parser, shared by `ingest.worker.js` (via `importScripts`) and the viewer/garage (via `<script src>`), same module pattern as `vin.js`. It is the only thing that understands the scope language printed in the Model column and in year/breakpoint footers: `PR:` option slots (OR within a token, AND across tokens, `-nnn` negates), model lines, body styles, engine/gearbox codes, `MJ` year ranges, quoted markets (`"ROK"`, `-"CN."`), and chassis/engine serial breakpoints. `,` is OR and `+` is AND — a `+` that dangles at the end of a column has simply lost its right operand to the column split.

`parse()` returns typed, separate facets; `matches(parsed, vehicle)` evaluates them against a vehicle spec. Two invariants: **a blank vehicle field never constrains and never rejects**, and **an unrecognised token is captured in `unknown` and never enforced** (which is what keeps `Z97.00`, a code with no V-page table, permissive rather than fatal). Vehicle facets (`vfLine`, `vfBody`, `vfEngine`, `vfGearbox`, `vfYear`, `vfMarket`, `vfPrCodes`) are user-editable per vehicle in the garage, offered from the catalog's own tables and VIN-prefilled only where a sound derivation exists.

`tools/appl-test.js` holds the assertions (run via the repo's Chromium — there is no node here). Extend it alongside any grammar change.