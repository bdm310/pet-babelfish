# Diagram-callout OCR

Parts diagrams carry cross-reference **callout** numbers baked into the image as pixels - confirmed
absent from the PDF text layer, so OCR is the only route. The pipeline has two independent halves:

1. **Detection** - *where* are the callouts? A trained CNN classifies connected-component
   candidates. This is the part under active development.
2. **Recognition** - *what digit* is in each accepted box? Tesseract.js with a custom model. Stable.

Both run in the browser inside `docs/ingest.worker.js`. Their output is the `callout` table
(one row per detected box, coords normalized per-axis to 0–10000).

```
diagram (CCITT G4)
  → findBlobs (connected components, native res)
  → 48×48 patch per candidate
  → CNN gate (callout-cnn.onnx, ONNX Runtime Web)   ── detection
  → group accepted blobs into numbers
  → Tesseract reads the digits in each group         ── recognition
  → callout rows
```

## Detection - the CNN gate

Candidate generation (connected components) has **candidate-recall ≥ 0.995** on every gold catalog,
so it's not the bottleneck - the classifier's whole job is **precision**: reject the ~68% of
candidates that are part edges, bolts, leader stubs, and legend digits.

**Model:** `callout-cnn.onnx` (~25.5k params, 102 KB, opset 13). Trained on 5 gold catalogs (996,
997TT, 356, Boxster, 911). In the worker it runs via onnxruntime-web (`OCR_USE_MODEL = true`,
`OCR_MODEL_THRESH` in `docs/ingest.worker.js`). Metadata + PR curve: `callout-cnn.meta.json`,
`callout-cnn.pr_curve.csv`.

**Preprocessing contract (must match between training and the worker):** input is NCHW
`[N,1,48,48]` float32, `patch/255` (0 = ink, 1 = white), **no** mean/std normalization; output is a
single sigmoid probability. The JS patch extractor ports cv2's `INTER_AREA` area-average resize
verbatim (mean abs diff vs Python ~0.0016/255).

**Operating threshold** is deliberately recall-favouring (`0.35`), not the max-F1 point. The model's
job includes *seeding* unseen catalogs, and a high threshold collapses out-of-distribution recall;
the in-distribution PR curve is flat (recall ≥0.998 down to ~0.2), so 0.35 costs almost nothing on
trained catalogs. Tune per-catalog when seeding a new one.

**Why a classifier, not an object detector:** candidate CC proposal already finds essentially every
callout, so a full detector would add cost for no recall we don't already have.

### Training the detector

```
uv run ocr/dataset.py           # build patches from gold GT → ocr/dataset/ (gitignored)
uv run ocr/train_classifier.py  # train → ocr/callout-cnn.onnx (+ .meta.json, .pr_curve.csv)
```

- `dataset.py` reads each gold catalog's `groundtruth.json` + its diagram blobs, decodes the CCITT
  G4 with `ccitt_decode.py`, and emits labeled 48×48 patches (`patches.npz`, `manifest.jsonl`).
  Positives = CC blobs that overlap a GT box (+ a safety-net patch per box); negatives = CC blobs
  outside every GT box. Inside a compound-callout box (`3/1`) the **digit** components are labeled
  positive (aligned left-to-right to the number's chars) but the **`/` stroke stays ignore** - an
  isolated slash is indistinguishable from a `1`, so making it a positive would cost precision.
- `train_classifier.py` trains with augmentation that helped (rot ±10°, trans ±4px, scale ±15%; no
  flips - they tilt digits) and `pos_weight` for imbalance. Verified vs PyTorch to 1e-7; same 102 KB
  ONNX / identical I/O contract each retrain.
- **Generalization:** the model transfers cleanly across modern catalogs, but each **old typeface**
  needs its own gold to reach full recall (leave-one-catalog-out recall drops on unseen old glyphs -
  e.g. unseen-911 0.688 → trained-911 0.969). Extend gold, don't port heuristics.

### Retraining loop

Add gold for a catalog → `dataset.py` → `train_classifier.py` → deploy to `docs/callout-cnn.onnx`
→ re-eval (below) → keep `OCR_USE_MODEL=true` only if it clears the bar (F1 ≥ heuristic and no
failure bucket regresses on any gold catalog).

## Recognition - Tesseract

Tesseract.js reads the digits in each accepted group, loading a custom `porsche` model from
`docs/tessdata/`. Recognition is strong and stable; almost all remaining callout misses are
detection, not misreads.

**Model:** `ocr/porsche.traineddata` - a fine-tune of Tesseract `4.0.0_best/eng` (the model
Tesseract.js's WASM is compiled against; fast/integer models can't be fine-tuned). Trained on
**14,937 real digit glyphs harvested from GT boxes** (both catalog fonts), which replaced the
original single synthetic font, plus **whole-box compound crops** so it reads the `/` in
compound callouts (`3/2`) in context - an isolated slash is indistinguishable from a `1`, so it
can only be learned from the full box; see [COMPOUND_PLAN.md](COMPOUND_PLAN.md).

```
uv run ocr/harvest.py           # split each GT box into per-digit CCs → real-glyph training set
uv run ocr/harvest_compound.py  # whole-box compound crops (911) → learn "/" in context
uv run ocr/train.py             # download base → generate lstmf → train → package porsche.traineddata
```

`generate.py` + `ipa_font.ttf` are the *legacy* synthetic-glyph path (superseded by `harvest.py`,
kept for reference). `train.py` is incremental (skips existing lstmf, resumes from the latest
checkpoint).

**Deploy gotcha:** Tesseract.js loads `docs/tessdata/porsche.traineddata.GZ`, **not** the
`.traineddata`. After training you must `gzip -9` the new model over the `.gz`, or the swap silently
does nothing.

### Tesseract training on Windows (UB-Mannheim), two non-obvious bugs

- **`Deserialize header failed`** - the lstmf files are in a Tesseract-4 binary format
  `lstmtraining` 5.x can't read. Fix: point `--tessdata-dir` at the installed UB-Mannheim tessdata
  (whose `lstm.train` sets *both* `tessedit_train_line_recognizer` and `tessedit_init_config_only`);
  don't build a stripped-down tessdata-local.
- **`Encoding of string failed! Failure bytes: 9 30`** - the WordStr box file's optional second
  line (`\t0 0 0 0 0`) bleeds a tab into the transcription, which isn't in the unicharset. Fix:
  write a single-line WordStr box in binary mode (`\n`, no `\r\n`).

## Ground truth

Evaluation and training data live under `groundtruth/<catalog>/` (gitignored - the only copies are
local). Boxes are per-axis 0–10000, the same space as the `callout` table. Tiers: **gold**
(human-verified), **silver** (Vision-derived, unverified).

Built and reviewed with the `tools/` GT pipeline (see [../tools/README.md](../tools/README.md)):
Cloud Vision multi-scale OCR (recall ~93%; single-scale only 86% because small diagrams render
tiny) proposes boxes and reconciles them against the parts-list expected set; a **Sonnet** resolver
locates the misses (Haiku mislocated ~40% - don't use it); `tighten-box.py` snaps to glyph bounds;
`gt-editor.py`/`.html` is the human last-mile editor. Note: callouts are **not** a subset of part
positions - the shared diagram shows every position while the parts list shows only the applicable
ones - so some real callouts have no part row, and gating callouts by the parts list *regresses*
the eval. Don't do it.

Compound ids (`2/1`, `(3/1)`, old catalogs) are **human-gold only**: the digit-only OCR can't read
the `/`, so they surface as expected-but-missing and stay unmatched FNs in the eval.

## Evaluation

`tools/ocr-eval.py` grades the `callout` table against `groundtruth.json` - per-instance P/R/F1 at
IoU≥thr, mean IoU, detection-only recall. Reference points (callout-level, IoU≥0.3):

| Catalog | Heuristic (old) | CNN model (current) |
|---|---|---|
| 996 | F1 0.976 | **0.986** |
| 997TT | F1 0.993 | 0.993 (near-tie) |

`ocr-diagnose.py` buckets every FN/FP (missed / misread-near / spurious); `ocr-render.py` draws the
boxes. Use `tools/export-opfs.py` to get a diagram-bearing SQLite for these first. The `ocr-lab.py`
harness uses **system** Tesseract, so it's for detection/grouping iteration only - re-check
recognition claims in-browser (production uses dual-PSM Tesseract.js).

## Gotchas

- **onnxruntime-web's shared `InferenceSession` is not reentrant.** Sections once ran under
  `Promise.all`; concurrent `session.run()` clobbered the shared output binding and threw, silently
  dropping every callout in the slowest sections. Inference is serialized through `runOrt()`;
  Tesseract stays parallel (net ~0.1 s/diagram, no speed cost).
- **Python tools can't `Image.open()` a diagram blob** - it's a raw CCITT G4 bitstream, not a
  container. Decode with `ccitt_decode.py` using `section.diagram_w/diagram_h`.

## Files

| Path | What |
|---|---|
| `callout-cnn.onnx` | Deployed detector model (mirror of `docs/callout-cnn.onnx`). |
| `callout-cnn.meta.json` / `.pr_curve.csv` | Threshold/metadata + full PR curve. |
| `dataset.py` | Build CNN training patches from gold GT. |
| `train_classifier.py` | Train the detector CNN → ONNX. |
| `ccitt_decode.py` | Python port of `docs/ccitt.js` - decode G4 diagram blobs. |
| `harvest.py` | Harvest real digit glyphs from GT boxes for Tesseract training. |
| `train.py` | Tesseract LSTM fine-tune pipeline → `porsche.traineddata`. |
| `generate.py` / `ipa_font.ttf` | Legacy synthetic-glyph generation (superseded by `harvest.py`). |
| `porsche.traineddata` | Packaged Tesseract recognition model (also in `docs/tessdata/`). |
| `train/`, `dataset/` | Gitignored training scratch / patch dataset. |
