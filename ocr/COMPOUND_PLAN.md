# Compound-callout (`n/n`) OCR — plan & findings

Older catalogs (911, and 356-family sub-positions) number some diagram callouts compoundly:
`3/2`, `(3/1)`, `10/1`. The parts carry these positions and are searchable, but the diagram
callout never links to them because the OCR can't produce the `/`. This is PLAN item 3.

The link layer is **not** the gap: `docs/schema.js` stores `callout.number` as free `TEXT`, and
`viewer.html`'s `_posNum()` already passes `n/n` through unchanged — the moment a `callout` row
holds `"3/2"`, it matches part position `3/2`/`(3/2)` with zero viewer changes. The entire gap is
upstream, in the ingest OCR.

## Where the pipeline blocks compound numbers (`docs/ingest.worker.js`)

The live path is `ocrDiagramModel()`. Per-candidate connected-component blobs are gated by the CNN,
each **accepted blob is OCR'd individually as a single character**, and a number is assembled by
joining horizontally-adjacent single-digit reads. Blocks:

1. **Whitelist** `tessedit_char_whitelist: '0123456789'` (two `runPass` sites) structurally excludes
   `/`.
2. **Per-blob digit model** — each blob is read in isolation and gated `/^\d$/`; there is no slot
   for a separator, and grouping is pure digit-to-digit adjacency.
3. **Caps** — `≤2 digits per group` and `OCR_MAX_CALLOUT=99` reject longer runs (`36/1` is four
   glyphs).
4. **CNN training** (`ocr/dataset.py`) treats every compound box as an **ignore** region — the gate
   is never taught the `/` or the compound digit layout.
5. **Recognition model** (`ocr/porsche.traineddata`) was fine-tuned on **isolated digit glyphs
   only**. `/` is in its unicharset (inherited from base `eng`) but was never reinforced.

## Two experiments that set the direction

**A. The digit-only model cannot read `/`, even whitelisted.** Cropping real 911 compound callouts
(`2/1`, `10/1`) from the decoded diagram and running `porsche` with whitelist `0123456789/`, PSM 8:

    2/1  -> "211"     10/1 -> "101"

The `/` is read as `1` (or dropped). So a whitelist change alone is not enough — the model must be
retrained. (Confirms the expectation that "the model will require training.")

**B. Isolated `/` and `1` are the same glyph in this typeface.** Harvesting the `/` connected
component from each compound box (148 of them) and viewing them as a montage: the slash is a thin,
often near-vertical stroke **visually indistinguishable from the digit `1`** in isolation. So the
existing `harvest.py` approach — train on isolated single-glyph images — **cannot** learn `/`: an
isolated slanted stroke and a `1` occupy the same feature space. The only disambiguating signal is
**context**: a stroke sitting *between two digit groups* with compound spacing is a `/`; the same
stroke standing alone is a `1`.

## Recommended approach — whole-box sequence recognition

Train and infer on the **whole compound box as a sequence**, not per glyph, so the LSTM uses context
to separate `/` from `1`.

1. **Recognition (train `/` in context).**
   - Harvest **whole** compound-callout box crops from gold GT (911 has 208), label each with its
     full string (`"3/2"`), normalized exactly as the worker crops (height `OCR_H`, white pad,
     binarize). Decode diagrams with `ocr/ccitt_decode.py` — `harvest.py` still uses the pre-CCITT
     `Image.open` path and must be updated (the GT-dir catalog.sqlite is also absent; read the
     shipped `docs/catalogs/<id>.sqlite`).
   - Keep the existing isolated-digit set (normal callouts) and **add** the whole-box compound
     crops, oversampled so ~200 boxes register against ~15k digit glyphs. Hold out ~20% of compound
     boxes for validation.
   - Retrain (`ocr/train.py`, `--continue_from` the current checkpoint). Validate on the held-out
     compound crops: success = reads `\d+/\d+` correctly at usable rate without regressing digits.

2. **Detection / grouping (worker).** Add a compound pass *after* normal digit grouping: when two
   digit clusters sit on one row separated by a compound-consistent gap (wider than intra-number,
   narrower than inter-callout), form a candidate from their **union box** and OCR that whole box
   (PSM 8, whitelist `0123456789/`); accept when it reads `^\d{1,3}/\d{1,3}$` and emit one compound
   callout in place of the two sub-groups. The union box already spans the `/`, so no `/` blob need
   pass the CNN gate — this sidesteps blocker 4 and keeps the digit-only pass (and its precision)
   intact for normal callouts. Relax the caps for this pass only.

3. **Re-ingest 911 + eval.** `tools/ingest.py 911… --force`, then `tools/ocr-eval.py`: compound
   recall should rise from 0 while non-compound P/R/F1 and the 996/997TT baselines do **not** regress
   (gate: F1 ≥ current, no failure bucket regresses).

## Status (this pass)

**Recognition — DONE and validated.** Retrained `porsche.traineddata` on whole
compound-box crops (911 gold, 167 train boxes × 14 augmentations, 41 held out) via
`ocr/harvest_compound.py` + `ocr/train.py` (resume from the digit checkpoint, target
error 0 so the digit-dominated set doesn't stop early). Results:
- Held-out compound crops: **41/41 (100%)** exact reads with the retrained model, vs
  **5/41 (12%)** with the shipped digit-only model.
- No digit regression: 911 digits 98% = 98%, 997 digits 100% = 100%, and the retrained
  model produced **zero** stray `/` on 120 digit callouts.
- Confirmed in the **Tesseract.js WASM** runtime (not just the CLI): 12/12 held-out
  compound crops read exactly. The model is deployed (`docs/tessdata/…gz` + mirror).

**Worker pass — implemented, gated off (`OCR_COMPOUND=false`).** The compound pass
(step 6b in `ocrDiagramModel`) and `renderRegionCanvas` are in place and the whole-span
OCR reads correctly in isolation (the union of a real 911 "2/1"'s detected sub-groups
OCRs to "2/1"). But a full 911 re-ingest emitted **zero** compound callouts, for two
reasons found by localizing against gold:
1. **Detection is the binding constraint.** The CNN treats compound boxes as ignore
   regions, so it under-detects their digit groups — e.g. gold "10/1" yielded a single
   blob. With the digit groups missing, the pairing pass has nothing to combine. Fixing
   this needs the Phase-C CNN retrain (un-mask compound digit CCs in `ocr/dataset.py` as
   positives — keep the thin `/` stroke as ignore — retrain, and re-eval all five gold
   catalogs so precision does not regress).
2. Even where digits *were* detected ("2/1" → "21"+"1"), the in-worker pass did not emit,
   though the same union OCRs correctly out of band — a render/scale detail still to
   debug once (1) makes enough boxes detectable to iterate against.

So the flag stays off until the CNN is retrained; enabling it before then only adds OCR
cost. The recognition half — the part that genuinely needed a trained model — is done.

## Risk

`/`≈`1` separability is genuinely poor (experiment B). Whole-box context is the mitigation, but even
so some compound reads will be wrong (`3/2`↔`312`↔`31/2`). The compound pass must therefore be
**additive and conservative** — a wrong compound read that matches no part is a benign orphan, but it
must never cannibalize a correct plain-digit callout. Keep it behind its own gap/aspect gate and keep
the plain pass authoritative.
