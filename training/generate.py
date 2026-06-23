# /// script
# requires-python = ">=3.11"
# dependencies = ["Pillow"]
# ///
"""Generate synthetic digit training images from ipa_font.ttf.

Usage:  uv run training/generate.py
Output: training/ground-truth/  (.tif + .gt.txt pairs)
"""

import random
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

REPO_ROOT  = Path(__file__).resolve().parent.parent
FONT_PATH  = REPO_ROOT / "ipa_font.ttf"
OUTPUT_DIR = Path(__file__).resolve().parent / "ground-truth"
DPI        = 300
SIZES_PT   = [6, 7, 8]
N_PER_SIZE = 200

random.seed(42)


def pt_to_px(pt: float) -> int:
    return round(pt * DPI / 72)


def rand_line() -> str:
    """Random space-separated sequence of 1–3 digit numbers, like catalog callouts."""
    n = random.randint(6, 14)
    return " ".join(str(random.randint(1, 999)) for _ in range(n))


def render(text: str, font: ImageFont.FreeTypeFont) -> Image.Image:
    probe = Image.new("L", (1, 1))
    bb    = ImageDraw.Draw(probe).textbbox((0, 0), text, font=font)
    pad   = 10
    img   = Image.new("L", (bb[2] - bb[0] + 2 * pad, bb[3] - bb[1] + 2 * pad), 255)
    ImageDraw.Draw(img).text((pad - bb[0], pad - bb[1]), text, font=font, fill=0)
    return img


OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
total = 0

for pt in SIZES_PT:
    font = ImageFont.truetype(str(FONT_PATH), pt_to_px(pt))
    for i in range(N_PER_SIZE):
        text = rand_line()
        img  = render(text, font)
        W, H = img.size
        stem = f"d_{pt}pt_{i:04d}"
        img.save(str(OUTPUT_DIR / f"{stem}.tif"), dpi=(DPI, DPI))
        (OUTPUT_DIR / f"{stem}.gt.txt").write_text(text, encoding="utf-8")
        # WordStr box: tesseract lstm.train requires a .box file alongside the .tif.
        # Single line only — the trailing \t end-of-word line corrupts the transcription.
        # Write bytes directly to avoid Windows CRLF translation.
        box = f"WordStr 0 0 {W-1} {H-1} 0 #{text}\n"
        (OUTPUT_DIR / f"{stem}.box").write_bytes(box.encode("utf-8"))
        total += 1

print(f"Generated {total} pairs -> {OUTPUT_DIR}")
