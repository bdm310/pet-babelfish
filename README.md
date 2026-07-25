# pet-babelfish

A browser-based tool for ingesting, searching, and browsing Porsche Electronic Toolbox (PET)
parts catalogs. It reads a catalog PDF, builds its own data model from it, and lets you filter the
catalog down to a specific vehicle, with everything running locally in the browser.

Catalog PDFs are published by Porsche and can be found via sources like
[9xxteile.com](https://www.9xxteile.com/en/pet) and
[Porsche Classic](https://www.porsche.com/usa/accessoriesandservice/classic/originalpartscatalogue/).

## Quickstart

Hosted at **https://bdm310.github.io/pet-babelfish/**
Pre-ingested catalogs
load on demand, so you can browse without ingesting anything.

To run it locally, WASM and OPFS require HTTP - serve `docs/`, don't open it as `file://`:

```
npx serve docs
# or
python -m http.server --directory docs 8080
```

Then open `http://localhost:8080/`:

- **Ingest a catalog** (`ingest.html`) - pick a PET PDF; it extracts parts + diagrams and stores
  the result in the browser (OPFS).
- **Browse parts** (`viewer.html`) - section tree, parts table, search, diagram view, spec filter.
- **Garage** (`garage.html`) - save vehicles with their catalog + spec filter 
- **Raw table browser** (`catalog-browser.html`) - inspect the ingested SQLite directly.

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** - the app and its data model.
- **[tools/README.md](tools/README.md)** - dev tooling usage.
- **[ocr/README.md](ocr/README.md)** - the diagram-callout detection + OCR pipeline.
