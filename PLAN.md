# Status & remaining work

Architecture and the data model are in [ARCHITECTURE.md](ARCHITECTURE.md); this file is only the
roadmap.

## Done

1. **Old-dialect vehicle filtering** — a pre-VIN car's chassis number (356/911/996/Cayenne),
   typed into the VIN box, is matched directly against the old-dialect `vin_range` and pre-fills
   catalog + year + market, the same as a modern VIN. `vin.js` keys spaced and glued chassis
   numbers alike, treats an open `vin_to` as "from serial onward", and expands two-digit model
   years via the catalog's century pivot.

2. **Serial-breakpoint filter** — optional engine-number and **gearbox-number** inputs feed
   `appl.serialAdmits`; parts whose changeover is printed against a stamped engine/gearbox number
   are filtered within the car's own number block. (The gearbox number never *derives* the gearbox
   code — the A/G transmission serial ranges print byte-identical.)

3. **Bundled catalogs** — the 13 pre-ingested catalogs ship at `docs/catalogs/<id>.sqlite` (one
   object per catalog) with a manifest; the app lists them by default and copies one into OPFS on
   first open, after which it behaves like a locally-ingested catalog. `tools/build-catalogs.py`
   rebuilds them from `catalogs.zip`.

4. **Distribution / hosting** — `.github/workflows/pages.yml` publishes `docs/` (app + bundled
   catalogs) to GitHub Pages on every push to `main`.

5. **Compound-callout linking (911)** — parts with compound positions (`3/2`, `(3/1)`) now link to
   their diagram callouts. The recognizer was retrained to read the `/` in context, the
   callout-detector CNN to accept compound digit groups (`/` stroke stays ignore), and the ingest
   worker gained a compound pass that pairs adjacent digit groups and OCRs the whole span. On 911,
   148/208 gold compound boxes now match (was 0), 125 compound callouts link to a part, overall
   callout F1 0.939. Write-up: [ocr/COMPOUND_PLAN.md](ocr/COMPOUND_PLAN.md).

## Remaining work

None outstanding from the original roadmap. Possible follow-ups: extend compound-callout gold
beyond 911 to lift the 71% compound recall, and broaden OCR gold on the other old typefaces.
