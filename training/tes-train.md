# Tesseract LSTM Fine-Tuning on Windows

How to train a custom Tesseract 5 model on Windows using the UB-Mannheim build, and the two non-obvious bugs you'll hit.

## What we're training

A fine-tune of the Tesseract 4.0.0-best `eng` model to recognise IPA-font digits as they appear in Porsche parts catalog diagrams. Training data is 600 synthetic images (6/7/8 pt, 200 each) generated from `ipa_font.ttf` using Pillow.

**Base model:** `tessdata.projectnaptha.com/4.0.0_best/eng.traineddata.gz` — the same model Tesseract.js's WASM is compiled against. Fast (integer) models cannot be fine-tuned; only floating-point best models support `lstmtraining --continue_from`. Using tessdata_best from Tesseract 5.x (UB-Mannheim local) instead triggers `DotProductSSE` code paths absent from the Tesseract.js WASM binary.

**Output:** `training/porsche.traineddata` — drop-in replacement for `eng.traineddata`.

## Pipeline

```
uv run training/generate.py   # generates training/ground-truth/ (tif + gt.txt + box)
uv run training/train.py      # downloads tessdata_best, generates lstmf, trains, packages
```

`train.py` is incremental: re-running it skips already-generated lstmf files and picks up from the latest checkpoint.

## Bug 1 — lstmf format mismatch (Deserialize header failed)

**Symptom:** `lstmtraining.exe` prints `Deserialize header failed: <file>.lstmf` for every file and exits without training.

**Cause:** The UB-Mannheim `lstm.train` config contains *both*:

```
tessedit_train_line_recognizer T
tessedit_init_config_only T
```

If you only use `tessedit_train_line_recognizer T` (e.g. in a custom tessdata-local directory), Tesseract generates lstmf files in a Tesseract 4-era binary format that `lstmtraining` 5.x cannot read.

Using *both* flags together — i.e. pointing `--tessdata-dir` at the installed tessdata — generates the format that `lstmtraining` 5.x expects.

**Fix:** Pass `--tessdata-dir` to the UB-Mannheim tessdata directly. Do not create a custom tessdata-local with a stripped-down `lstm.train`.

```python
cmd = [tesseract, tif, outbase, "--psm", "6", "-l", "eng",
       "--tessdata-dir", r"C:\Program Files\Tesseract-OCR\tessdata",
       "lstm.train"]
```

## Bug 2 — box file trailing line corrupts transcription (Failure bytes: 9 30)

**Symptom:** `lstmtraining.exe` loads the lstmf files fine but spams:

```
Encoding of string failed! Failure bytes: 9 30
Can't encode transcription: '... <last_word>\t0' in language ''
```

**Cause:** The WordStr box file format has an optional end-of-word second line:

```
WordStr 0 0 595 41 0 #some text here
	0 0 0 0 0
```

The `\t0 0 0 0 0` line (tab + coordinates) bleeds into the transcription stored in the lstmf as the bytes `\t` (0x09) and `0` (0x30). Tab is not in the English unicharset, so encoding fails.

This is compounded by Python's `write_text()` on Windows adding `\r\n` line endings, which can further confuse the box parser.

**Fix:** Use a single-line WordStr box file, written in binary mode:

```python
box = f"WordStr 0 0 {W-1} {H-1} 0 #{text}\n"
(path / f"{stem}.box").write_bytes(box.encode("utf-8"))
```

## Training result

600 training images, 90/10 train/eval split, fine-tuned from `4.0.0_best/eng.lstm`, 1000 iterations (~8 epochs):

```
BCER train = 0.036%   BWER train = 0.192%
```

Output: `training/porsche.traineddata` (15 MB).

## Files

| File | Purpose |
|---|---|
| `generate.py` | Renders synthetic training images from `ipa_font.ttf` |
| `train.py` | Full pipeline: download → extract → lstmf → train → package |
| `ground-truth/` | Generated tif + gt.txt + box files (gitignored) |
| `lstmf/` | Generated binary training data (gitignored) |
| `model/` | Checkpoints during training (gitignored) |
| `eng.traineddata` | Downloaded tessdata_best base model (gitignored) |
| `eng.lstm` | Extracted LSTM weights for fine-tuning (gitignored) |
| `porsche.traineddata` | Final packaged model (gitignored) |
