# Compound-callout (`n/n`) OCR - plan & findings

Older catalogs (911, and 356-family sub-positions) number some diagram callouts compoundly:
`3/2`, `(3/1)`, `10/1`. The parts carry these positions and are searchable, but the diagram
callout never links to them because the OCR can't produce the `/`. This is PLAN item 3.

The link layer is **not** the gap: `docs/schema.js` stores `callout.number` as free `TEXT`, and
`viewer.html`'s `_posNum()` already passes `n/n` through unchanged - the moment a `callout` row
holds `"3/2"`, it matches part position `3/2`/`(3/2)` with zero viewer changes. The entire gap is
upstream, in the ingest OCR.

## Where the pipeline blocks compound numbers (`docs/ingest.worker.js`)

The live path is `ocrDiagramModel()`. Per-candidate connected-component blobs are gated by the CNN,
each **accepted blob is OCR'd individually as a single character**, and a number is assembled by
joining horizontally-adjacent single-digit reads. Blocks:

1. **Whitelist** `tessedit_char_whitelist: '0123456789'` (two `runPass` sites) structurally excludes
   `/`.
2. **Per-blob digit model** - each blob is read in isolation and gated `/^\d$/`; there is no slot
   for a separator, and grouping is pure digit-to-digit adjacency.
3. **Caps** - `≤2 digits per group` and `OCR_MAX_CALLOUT=99` reject longer runs (`36/1` is four
   glyphs).
4. **CNN training** (`ocr/dataset.py`) treats every compound box as an **ignore** region - the gate
   is never taught the `/` or the compound digit layout.
5. **Recognition model** (`ocr/porsche.traineddata`) was fine-tuned on **isolated digit glyphs
   only**. `/` is in its unicharset (inherited from base `eng`) but was never reinforced.

## Two experiments that set the direction

**A. The digit-only model cannot read `/`, even whitelisted.** Cropping real 911 compound callouts
(`2/1`, `10/1`) from the decoded diagram and running `porsche` with whitelist `0123456789/`, PSM 8:

    2/1  -> "211"     10/1 -> "101"

The `/` is read as `1` (or dropped). So a whitelist change alone is not enough - the model must be
retrained. (Confirms the expectation that "the model will require training.")

**B. Isolated `/` and `1` are the same glyph in this typeface.** Harvesting the `/` connected
component from each compound box (148 of them) and viewing them as a montage: the slash is a thin,
often near-vertical stroke **visually indistinguishable from the digit `1`** in isolation. So the
existing `harvest.py` approach - train on isolated single-glyph images - **cannot** learn `/`: an
isolated slanted stroke and a `1` occupy the same feature space. The only disambiguating signal is
**context**: a stroke sitting *between two digit groups* with compound spacing is a `/`; the same
stroke standing alone is a `1`.

## Recommended approach - whole-box sequence recognition

Train and infer on the **whole compound box as a sequence**, not per glyph, so the LSTM uses context
to separate `/` from `1`.

1. **Recognition (train `/` in context).**
   - Harvest **whole** compound-callout box crops from gold GT (911 has 208), label each with its
     full string (`"3/2"`), normalized exactly as the worker crops (height `OCR_H`, white pad,
     binarize). Decode diagrams with `ocr/ccitt_decode.py` - `harvest.py` still uses the pre-CCITT
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
   pass the CNN gate - this sidesteps blocker 4 and keeps the digit-only pass (and its precision)
   intact for normal callouts. Relax the caps for this pass only.

3. **Re-ingest 911 + eval.** `tools/ingest.py 911… --force`, then `tools/ocr-eval.py`: compound
   recall should rise from 0 while non-compound P/R/F1 and the 996/997TT baselines do **not** regress
   (gate: F1 ≥ current, no failure bucket regresses).

## Status - DONE (compound callouts detect, read, and link end-to-end)

The full chain works. On 911 (208 gold compound boxes), a real re-ingest now emits **157
compound callouts**, **148/208 gold compound boxes match** (num + location; was 0), and
**125 compound callouts link to a part**. Overall 911 callout F1 **0.939**, detection-only
recall 0.954, mean IoU 0.970. `OCR_COMPOUND` is ON.

What it took, beyond the recognition retrain below:
1. **CNN detection** (`ocr/dataset.py`): un-mask compound boxes - align each box's
   components to the number's chars and label the DIGIT components as positives (the `/`
   stroke stays ignore). Compound-digit candidate-recall was already 1.0, so the digits
   were proposed; they just needed to be a positive class. Retrained → val cc-only F1
   0.9958 (up from 0.9938), no regression.
2. **Worker compound pass** (`ocrDiagramModel` step 6b): pairs adjacent digit groups and
   OCRs the whole span. Two real bugs fixed: (a) `renderRegionCanvas` pulled a leader-line
   stub into the padded region ("-2/1" → misread "21"); it now renders only ink inside the
   tight union box with a white-only margin. (b) The whole-span OCR shared the digit
   worker; it now runs on a **dedicated Tesseract worker** (`recognizeCompound`).
3. **Tooling** that had silently rotted: `tools/ingest.py` never actually ran (it checked
   `viewerLink.style.display`, but the UI hides the link via its parent, so it "completed"
   in 3 s without ingesting - every re-ingest for two days was a no-op); `initTesseract`
   now sets `cacheMethod: 'none'` (concurrent workers raced on the OPFS/IndexedDB model
   cache → `InvalidStateError`, and it also served a stale model after a retrain);
   `tools/ocr-eval.py` now scores `n/n` predictions instead of skipping them.

## Recognition - the retrain that started it

**Recognition - DONE and validated.** Retrained `porsche.traineddata` on whole
compound-box crops (911 gold, 167 train boxes × 14 augmentations, 41 held out) via
`ocr/harvest_compound.py` + `ocr/train.py` (resume from the digit checkpoint, target
error 0 so the digit-dominated set doesn't stop early). Results:
- Held-out compound crops: **41/41 (100%)** exact reads with the retrained model, vs
  **5/41 (12%)** with the shipped digit-only model.
- No digit regression: 911 digits 98% = 98%, 997 digits 100% = 100%, and the retrained
  model produced **zero** stray `/` on 120 digit callouts.
- Confirmed in the **Tesseract.js WASM** runtime (not just the CLI): 12/12 held-out
  compound crops read exactly. The model is deployed (`docs/tessdata/…gz` + mirror).

The detection retrain and the two worker bugs (see the DONE section above) closed the
remaining gap; `OCR_COMPOUND` is now on.

## Risk

`/`≈`1` separability is genuinely poor (experiment B). Whole-box context is the mitigation, but even
so some compound reads will be wrong (`3/2`↔`312`↔`31/2`). The compound pass must therefore be
**additive and conservative** - a wrong compound read that matches no part is a benign orphan, but it
must never cannibalize a correct plain-digit callout. Keep it behind its own gap/aspect gate and keep
the plain pass authoritative.
