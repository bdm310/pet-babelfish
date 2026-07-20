Directives for AI assistants working in this repo. Reference material lives in the READMEs — see
the map at the bottom; read the relevant one before working on that area.

## How to work here

- **Be terse.** Don't use more words when fewer will do. This applies to code comments and docs too.
- **Nothing migrates.** Do not write or keep migration or backward-compatibility code, and never
  try to "fix" a stored database. Data-format changes are handled by re-ingesting or rebuilding.
  If a `catalog.sqlite` no longer matches `docs/schema.js`, it is re-ingested, not patched.
- **No node.** JavaScript tests run via the repo's bundled Chromium, not Node. `tools/appl-test.js`
  holds the applicability-grammar assertions — extend it alongside any change to `docs/appl.js`.
- **The app is `docs/`.** It is named `docs/` only for the GitHub Pages convention; do not treat it
  as a documentation folder or add prose there. Documentation lives at the repo root and in
  per-directory READMEs.
- **Verify against the real thing.** The database lives in the browser (sql.js + OPFS); use the
  tooling in [tools/README.md](tools/README.md) (Playwright ingest/verify, the live query bridge)
  rather than assuming.

## Where the reference lives

- [ARCHITECTURE.md](ARCHITECTURE.md) — the app, the data model, the applicability grammar, and the
  non-obvious gotchas. Read this before touching ingest, the viewer, or the schema.
- [tools/README.md](tools/README.md) — dev tooling (ingest, verify, query bridge, OCR harness).
- [ocr/README.md](ocr/README.md) — the diagram-callout detector + OCR pipeline and its training.
- [PLAN.md](PLAN.md) — current status and remaining work.
- [README.md](README.md) — project overview and design principles.
