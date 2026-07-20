# Status & remaining work

Architecture and the data model are in [ARCHITECTURE.md](ARCHITECTURE.md); this file is only the
roadmap. We're at the **first-pass full-functionality milestone**: a catalog can be ingested and
browsed end-to-end, and modern cars (997/987) can be filtered to a specific vehicle.

## Shipped

- **Ingest** (`docs/ingest.worker.js`) — outline → sections → block-oriented parts extraction
  (self-calibrating columns, applicability continuation rows, colour/trim child rows, compound
  position ids), per-section diagram render to CCITT G4 blobs, and V-page decoding into the
  vehicle/option tables. Handles multi-page sections; partial (`--parts-only`) re-ingest supported.
  Modern and old (356/911) V-page dialects both parse.
- **Callout detection** — a trained CNN (`docs/callout-cnn.onnx`, `OCR_USE_MODEL=true`) gates
  connected-component candidates; Tesseract reads the digits in accepted boxes. Trained on 5 gold
  catalogs. Detail and the ground-truth/eval pipeline: [ocr/README.md](ocr/README.md).
- **Applicability** — one shared grammar (`docs/appl.js`) parses the scope language and matches it
  against a vehicle spec (conjunction-of-disjunctions PR logic, year ranges, markets, model/body,
  engine/gearbox codes, serial breakpoints). Used by both ingest and the app.
- **Viewer** — section tree, parts table, FTS4 search (LIKE fallback), diagram pane with
  interactive callout ↔ part overlay, and spec filtering that runs `appl.js` at query time.
- **Garage** — saved vehicles (identity + spec filter) in one OPFS `garage.json`; per-part **Ok**
  status + **Notes** editable inline; **Hide Ok** turns the view into "what's left to do". Marks
  are keyed by content (`catalog|section|position|part_number|occurrence`), so re-ingest doesn't
  lose them.
- **VIN → vehicle** — `docs/vin.js` decodes modern 997/987/Cayenne VINs, scans every OPFS
  catalog's `vin_range`, auto-selects the matching catalog, and pre-fills year + market group.
  Manual PR-code entry (validated/labeled against `pr_code`) is the option source for all regimes.
- All 13 source catalogs ingest cleanly.

## Remaining work

Roughly in priority order.

1. **Old-dialect vehicle filtering** — old catalogs (356, 911) populate `vin_range` and the
   number-range tables, but `VIN.decodeVin` only handles the 17-char modern VIN, so VIN pre-fill is
   inert for them and `pr_code`/`sales_type` are empty by design (no PR system pre-modern). The
   garage still filters these cars via manually entered facets; wiring old chassis numbers into the
   decode path would make VIN pre-fill work for them too.

2. **Serial-breakpoint filter (Cayenne, 356)** — these catalogs scope parts by engine/gearbox
   *number* cut-in points, which a VIN doesn't contain. `appl.serialAdmits` already enforces the
   per-block breakpoint logic; what's missing is the UI: optional engine-number / gearbox-number
   inputs feeding it.

3. **Compound-callout linking (911)** — parts with compound positions (`3/2`, `(3/1)`) are
   extracted and searchable, but the digit-only OCR can't read the `/`, so those callouts don't
   link to their parts. Parts show; the diagram cross-link is the gap.

4. **OCR coverage on older typefaces** — the CNN generalizes cleanly to modern catalogs but needs
   gold from each old typeface to reach full recall (LOCO recall drops on unseen old glyphs). Extend
   gold and retrain per [ocr/README.md](ocr/README.md); chase residual 997-class precision.

5. **Auto-fetch** — direct browser fetch of catalog PDFs is CORS-blocked; ingest is file-picker
   only. Revisit if a fetch-friendly source or proxy appears.

6. **Distribution / hosting** — decide whether to publish `docs/` (GitHub Pages, via a
   Pages-from-Actions workflow so the served folder isn't tied to the `/docs` convention) and
   whether/how any pre-ingested catalog data is shared, given PDF copyright constraints.

## Explicitly out of scope

- **Auto-deriving the option list from a VIN** — needs a Porsche Kardex / third-party decoder:
  gated, variable accuracy, and a network dependency counter to the local-first design. Options stay
  user-entered. Revisit only if a reliable source appears.
