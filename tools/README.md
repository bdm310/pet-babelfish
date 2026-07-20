# Dev tooling

Automation and diagnostics for the pipeline. None of it ships in the app (`docs/`) — it's for
ingesting in bulk, inspecting the live in-browser database, and running the OCR/ground-truth loop.
Python is run via `uv`; PowerShell scripts are `.ps1`.

All Playwright tools share one persistent profile (`tools/.playwright-profile/`, gitignored) so the
OPFS catalog data survives between runs.

**One-time setup:**
```powershell
uv run --with playwright python -m playwright install chromium
```

## Ingest & inspect

### `ingest.py` — automated PDF ingest
Starts a local server, uploads the PDF to `ingest.html` via Playwright, waits for the worker.
```powershell
# First ingest — full pipeline incl. diagram render + OCR (slow)
uv run --with playwright python tools/ingest.py catalog.pdf --catalog-id 997tt
# Re-extract parts text only — skips OCR (fast; iterating on part extraction)
uv run --with playwright python tools/ingest.py catalog.pdf --catalog-id 997tt --parts-only
# Re-run everything incl. OCR (diagram/OCR logic changed)
uv run --with playwright python tools/ingest.py catalog.pdf --catalog-id 997tt --force
```
`--parts-only` falls back to full ingest if the catalog doesn't exist yet.
`ingest-all.ps1` batch-ingests every source PDF; `verify-all.ps1` batch-verifies.

### `verify.py` — DB summary + screenshots
Exports the SQLite from OPFS, runs summary queries with Python `sqlite3`, and takes four viewer
screenshots. Output goes to a timestamped `verify-output/` dir (gitignored).
```powershell
uv run --with playwright python tools/verify.py --catalog-id 997tt
uv run --with playwright python tools/verify.py --catalog-id 997tt --section 101-000 --search "Bremsbelag"
```

### `screenshot.py` — single-shot screenshot / JS eval
```powershell
uv run --with playwright python tools/screenshot.py --catalog 997tt --start-server
uv run --with playwright python tools/screenshot.py --eval "document.getElementById('statusBar').textContent"
```

### `inspect-pdf.py` — dump source-PDF page text
For comparing the PDF against ingested DB data.
```powershell
uv run --with pdfplumber python tools/inspect-pdf.py catalog.pdf --toc
uv run --with pdfplumber python tools/inspect-pdf.py catalog.pdf --pages 10-20 --search "Bremsbelag"
```

## Live database access

The DB lives in the browser (sql.js + OPFS). To query it live, run the bridge and open a catalog
in `catalog-browser.html` or `viewer.html`:

```powershell
.\serve.ps1          # static server :8080 + query bridge :9876 together
```
The browser polls `/query`, executes against the live DB, and POSTs JSON back to `/result`
(idles silently when no catalog is open). Then:
```powershell
.\tools\db-query.ps1 "SELECT COUNT(*) FROM part WHERE applicability != ''"
.\tools\export-sqlite.ps1 -Out my-catalog.sqlite    # dump to a file for any SQL tool
```
`query-bridge.ps1` runs the bridge alone. `export-opfs.py` / `export-all.py` export catalog
SQLite(s) from OPFS to disk (used by the OCR eval tools, which read the exported file directly).

## Applicability tests

`appl-test.js` holds the grammar assertions for `docs/appl.js`; `appl-test.py` runs them in the
repo's Chromium (there is no Node here). Extend the `.js` alongside any grammar change.
```powershell
uv run --with playwright python tools/appl-test.py
```

## OCR / ground-truth pipeline

The diagram-callout detector's ground-truth builder, editor, retraining data, and eval harness.
The pipeline is documented in **[../ocr/README.md](../ocr/README.md)**; the tools:

| Tool | Role |
|---|---|
| `ocr-groundtruth.py` | Build GT for a catalog (Cloud Vision multi-scale + parts-list reconcile). |
| `gt-init.py` | Seed a GT folder with no Vision (heuristic/model callouts as a baseline). |
| `gt-editor.py` + `.html` | Browser GT editor — review/add/move/resize callout boxes per section. |
| `gt-queue-prep.py` / `gt-queue-merge.py` | Render the human-review queue / fold results back into GT. |
| `tighten-box.py` / `gt-retighten.py` | Snap GT boxes to true glyph bounds (deterministic). |
| `gt-ocr-verify.py` | Re-OCR every GT box to flag mislabeled numbers. |
| `ocr-eval.py` / `ocr-eval-subset.py` | Grade the `callout` table vs GT (P/R/F1 at IoU≥thr); subset = honest threshold selection. |
| `ocr-diagnose.py` | Categorize every FN/FP (missed / misread-near / spurious). |
| `ocr-render.py` | Draw GT + predicted boxes on a diagram. |
| `ocr-lab.py` | Fast detection/grouping iteration harness (system Tesseract, not the shipping one). |
| `ocr-detect-dump.py` / `ocr-detect-attribute.py` / `ocr-eval-dump.py` | Per-blob CNN-detector diagnostics. |
