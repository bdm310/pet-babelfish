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

## Remaining work

1. **Compound-callout linking (911)** — parts with compound positions (`3/2`, `(3/1)`) show and
   are searchable, but the diagram callout doesn't link. **Recognition is solved**: the OCR model
   was retrained to read the `/` in context (validated 100% on held-out 911 compound crops, in the
   WASM runtime, no digit regression). The remaining gap is **detection**: the callout-detector CNN
   was trained with compound boxes as ignore regions and under-detects their digit groups, so the
   (implemented, currently-off) worker compound pass has nothing to pair. Next step: un-mask
   compound digit CCs in `ocr/dataset.py`, retrain the CNN without regressing the five gold
   catalogs, then enable `OCR_COMPOUND`. Full write-up: [ocr/COMPOUND_PLAN.md](ocr/COMPOUND_PLAN.md).
