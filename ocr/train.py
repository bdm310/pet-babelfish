# /// script
# requires-python = ">=3.11"
# dependencies = ["requests"]
# ///
"""Fine-tune Tesseract eng LSTM on IPA-font digit data.

Prerequisites:
  - Tesseract 5 installed (winget install UB-Mannheim.TesseractOCR)
  - Run generate.py first to produce ocr/train/ground-truth/

Usage:  uv run ocr/train.py
Output: ocr/porsche.traineddata
"""

import gzip
import random
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

TESS_DIR    = Path(r"C:\Program Files\Tesseract-OCR")
OCR_DIR     = Path(__file__).resolve().parent
BUILD_DIR   = OCR_DIR / "train"
GT_DIR      = BUILD_DIR / "ground-truth"
LSTMF_DIR   = BUILD_DIR / "lstmf"
MODEL_DIR   = BUILD_DIR / "model"

TESS      = TESS_DIR / "tesseract.exe"
LSTMTRAIN = TESS_DIR / "lstmtraining.exe"
COMBINE   = TESS_DIR / "combine_tessdata.exe"
TESSDATA  = TESS_DIR / "tessdata"

# Fine-tuning requires a floating-point (best) model - fast/integer models cannot
# be continued from. Use the 4.0.0_best from projectnaptha, which matches the
# architecture Tesseract.js's WASM was compiled against (not the 5.x tessdata_best
# from UB-Mannheim, which triggers DotProductSSE paths absent from the WASM binary).
ENG_BEST_URL = "https://tessdata.projectnaptha.com/4.0.0_best/eng.traineddata.gz"
ENG_BEST     = BUILD_DIR / "eng.traineddata"
ENG_LSTM     = BUILD_DIR / "eng.lstm"
TRAIN_LIST   = BUILD_DIR / "train.list"
EVAL_LIST    = BUILD_DIR / "eval.list"
OUT_MODEL    = OCR_DIR / "porsche.traineddata"


def run(*args: object) -> None:
    cmd = [str(a) for a in args]
    print("$", " ".join(cmd))
    subprocess.run(cmd, check=True)


def download_best() -> None:
    if ENG_BEST.exists():
        return
    print("Downloading tessdata 4.0.0_best/eng.traineddata.gz…")
    gz_path = TRAIN_DIR / "eng.traineddata.gz"
    with requests.get(ENG_BEST_URL, stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(gz_path, "wb") as f:
            for chunk in r.iter_content(65536):
                f.write(chunk)
    print("  decompressing…")
    with gzip.open(gz_path, "rb") as gz_in, open(ENG_BEST, "wb") as out:
        out.write(gz_in.read())
    gz_path.unlink()
    print(f"  {ENG_BEST.stat().st_size // 1_000_000} MB")


def extract_lstm() -> None:
    if not ENG_LSTM.exists():
        run(COMBINE, "-e", ENG_BEST, ENG_LSTM)


def gen_lstmf() -> None:
    """Generate .lstmf files using the installed UB-Mannheim tessdata.

    The installed lstm.train config combines tessedit_train_line_recognizer T and
    tessedit_init_config_only T, which produces lstmf files in the format that
    lstmtraining 5.x expects.  A custom tessdata-local with only the first flag
    produces an incompatible (Tesseract 4-era) format.

    Box files must be single-line WordStr format - the trailing \\t end-of-word
    line bleeds into the transcription and causes encoding failures.
    """
    LSTMF_DIR.mkdir(exist_ok=True)

    tifs    = sorted(GT_DIR.glob("*.tif"))
    done    = {f.stem for f in LSTMF_DIR.glob("*.lstmf")}
    pending = [t for t in tifs if t.stem not in done]
    print(f"Generating lstmf files: {len(pending)} remaining of {len(tifs)} total")

    def one(tif):
        outbase = tif.with_suffix("")   # co-located so Tesseract finds the .box
        subprocess.run([str(TESS), str(tif), str(outbase), "--psm", "6", "-l", "eng",
                        "--tessdata-dir", str(TESSDATA), "lstm.train"],
                       check=True, capture_output=True)
        generated = tif.with_suffix(".lstmf")
        if generated.exists():
            generated.replace(LSTMF_DIR / generated.name)

    done_n = 0
    with ThreadPoolExecutor(max_workers=16) as ex:
        for _ in ex.map(one, pending):
            done_n += 1
            if done_n % 500 == 0:
                print(f"  {done_n}/{len(pending)}")


def write_lists() -> None:
    all_lstmf = sorted(LSTMF_DIR.glob("*.lstmf"))
    if not all_lstmf:
        sys.exit("No .lstmf files found - lstmf generation may have failed")
    random.seed(0)
    random.shuffle(all_lstmf)
    n_eval = max(1, len(all_lstmf) // 10)
    EVAL_LIST.write_bytes(("\n".join(str(f) for f in all_lstmf[:n_eval])).encode())
    TRAIN_LIST.write_bytes(("\n".join(str(f) for f in all_lstmf[n_eval:])).encode())
    print(f"Train: {len(all_lstmf) - n_eval}  Eval: {n_eval}")


def train() -> None:
    MODEL_DIR.mkdir(exist_ok=True)
    run(LSTMTRAIN,
        "--continue_from", ENG_LSTM,
        "--model_output",  MODEL_DIR / "porsche",
        "--traineddata",   ENG_BEST,
        "--train_listfile", TRAIN_LIST,
        "--eval_listfile",  EVAL_LIST,
        "--max_iterations", "4000",
        "--target_error_rate", "0.01")


def package() -> None:
    checkpoint = MODEL_DIR / "porsche_checkpoint"
    if not checkpoint.exists():
        sys.exit(f"Checkpoint not found: {checkpoint}")
    run(LSTMTRAIN,
        "--stop_training",
        "--convert_to_int",
        "--continue_from", checkpoint,
        "--traineddata",   ENG_BEST,
        "--model_output",  OUT_MODEL)
    print(f"\nModel: {OUT_MODEL}")


def main() -> None:
    for exe in (TESS, LSTMTRAIN, COMBINE):
        if not exe.exists():
            sys.exit(f"Missing: {exe}\n  Install: winget install UB-Mannheim.TesseractOCR")
    if not GT_DIR.exists() or not any(GT_DIR.glob("*.tif")):
        sys.exit("No training data - run generate.py first:\n  uv run ocr/generate.py")

    download_best()
    extract_lstm()
    gen_lstmf()
    write_lists()
    train()
    package()


if __name__ == "__main__":
    main()
