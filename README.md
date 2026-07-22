# pet-babelfish

A browser-based tool for ingesting, searching, and browsing Porsche Electronic Toolbox (PET)
parts catalogs. It reads a catalog PDF, builds its own data model from it, and lets you filter the
catalog down to a specific vehicle — everything running locally in the browser, no server, no
backend.

## What it's for

Porsche publishes PET parts catalogs as PDFs. They're consistent in format across model lines,
mostly real text, with parts diagrams as images that have cross-reference callout numbers baked in
as pixels. This tool turns one into a queryable model so you can:

1. **Filter** the catalog to a specific vehicle, vehicle + options, options alone, or any partial
   filter — by VIN, by manually entered option (PR) codes, or both.
2. **See** what a part looks like and where it sits in the diagram (callout ↔ part linking).
3. **Search** by name or part number.

Catalog PDFs are published by Porsche and can be found via sources like
[9xxteile.com](https://www.9xxteile.com/en/pet) and
[Porsche Classic](https://www.porsche.com/usa/accessoriesandservice/classic/originalpartscatalogue/).
We don't distribute the PDFs (copyright); you supply your own via the file picker.

## Quickstart

Hosted at **https://bdm310.github.io/pet-babelfish/** — the 13 pre-ingested catalogs
load on demand, so you can browse without ingesting anything. (Deployed from `docs/`
by [.github/workflows/pages.yml](.github/workflows/pages.yml) on every push to `main`.)

To run it locally, WASM and OPFS require HTTP — serve `docs/`, don't open it as `file://`:

```
npx serve docs
# or
python -m http.server --directory docs 8080
```

Then open `http://localhost:8080/`:

- **Ingest a catalog** (`ingest.html`) — pick a PET PDF; it extracts parts + diagrams and stores
  the result in the browser (OPFS).
- **Browse parts** (`viewer.html`) — section tree, parts table, search, diagram view, spec filter.
- **Garage** (`garage.html`) — save vehicles (VIN or manual) with their catalog + spec filter for
  one-click browsing; track per-part Ok/Notes.
- **Raw table browser** (`catalog-browser.html`) — inspect the ingested SQLite directly.

For batch/automated ingest and other dev workflows, see [tools/README.md](tools/README.md).

## Design principles

- **Local-first.** Everything runs on the user's machine; the only network use is fetching data.
  The UI is a simple, locally hosted static app.
- **Simplest tool for each part.** No build step; vendored libraries from CDN.
- **Nothing migrates.** Data formats change by *re-ingesting*, never by patching a stored database.
  There is no migration code and no backward-compatibility layer — a catalog is cheap to rebuild
  from its PDF, so the model is free to change. (This is also a standing rule for contributors;
  see [CLAUDE.md](CLAUDE.md).)
- **Clean two-stage split.** Ingest (PDF → `catalog.sqlite`) and the app (browse that file) are
  joined only by the file. Either side can be rebuilt without touching the other.

## Repository layout

| Path | What |
|---|---|
| `docs/` | The application — ingest + viewer + garage, served statically. (Named `docs/` for the GitHub Pages convention; it is *not* a documentation folder.) |
| `tools/` | Dev/automation: Playwright-driven ingest/verify, the live query bridge, OCR ground-truth + eval harness. [tools/README.md](tools/README.md) |
| `ocr/` | The callout-detector model and its training/eval pipeline. [ocr/README.md](ocr/README.md) |
| `pet-source-pdf/` | Local source catalog PDFs (gitignored, not distributed). |

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — the app and its data model: file map, schema, the
  applicability grammar, and the load-bearing gotchas.
- **[PLAN.md](PLAN.md)** — current status and remaining work.
- **[tools/README.md](tools/README.md)** — dev tooling usage.
- **[ocr/README.md](ocr/README.md)** — the diagram-callout detection + OCR pipeline.
- **[CLAUDE.md](CLAUDE.md)** — directives for AI coding assistants working in this repo.
