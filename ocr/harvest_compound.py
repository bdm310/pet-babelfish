#!/usr/bin/env python3
"""Harvest WHOLE-BOX compound-callout crops ("3/2", "10/1") as Tesseract training
triples, so the recognition model learns to read the slash *in context*.

Why whole-box and not per-glyph (harvest.py): in the old typefaces an isolated "/"
glyph is visually indistinguishable from a "1" (both thin near-vertical strokes), so
per-glyph training can't learn it — the disambiguating signal is that the slash sits
*between two digit groups*. Training on the full compound box as a sequence lets the
LSTM use that context. See ocr/COMPOUND_PLAN.md.

Reads diagrams from the shipped CCITT catalogs (docs/catalogs/<id>.sqlite) via
ccitt_decode — the GT-dir catalog.sqlite is gitignored/local-only and harvest.py's
Image.open() path predates the CCITT change.

    uv run --with opencv-python-headless --with pillow --with numpy \
        python ocr/harvest_compound.py --catalogs 911Turbo_1975-1977 --aug 14

Writes comp_*.{tif,gt.txt,box} into ocr/train/ground-truth/ alongside the digit
glyphs, plus a held-out set (labels.json + pngs) for validation. Then retrain with
ocr/train.py (which picks up the new lstmf) and validate the held-out set.
"""
import sys, json, re, os, random
from pathlib import Path
import numpy as np, cv2
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from ccitt_decode import decode

REPO   = Path(__file__).resolve().parent.parent
GT_DIR = REPO / 'ocr' / 'train' / 'ground-truth'
HELD   = REPO / 'ocr' / 'train' / 'compound-heldout'
OCR_H, PAD, BIN = 48, 14, 160

args = sys.argv[1:]
def opt(n, d=None):
    try: return args[args.index(n) + 1]
    except (ValueError, IndexError): return d
cats = (opt('--catalogs') or '911Turbo_1975-1977').split(',')
AUG  = int(opt('--aug', '14'))
random.seed(0)

COMPOUND = re.compile(r'^\d{1,3}/\d{1,3}$')


def norm_box(crop):
    """A grayscale crop (white bg) -> tight, height-normalized black-on-white glyph run."""
    ink = (crop < BIN).astype(np.uint8)
    ys, xs = np.where(ink)
    if len(ys) == 0:
        return None
    g = ink[ys.min():ys.max()+1, xs.min():xs.max()+1] * 255
    h, w = g.shape
    rw = max(1, int(round(OCR_H / max(1, h) * w)))
    g = cv2.resize(g, (rw, OCR_H), interpolation=cv2.INTER_CUBIC)
    canvas = np.zeros((OCR_H + 2*PAD, rw + 2*PAD), np.uint8)
    canvas[PAD:PAD+OCR_H, PAD:PAD+rw] = g
    return 255 - ((canvas >= 128).astype(np.uint8) * 255)


def jitter(crop):
    h, w = crop.shape
    M = cv2.getRotationMatrix2D((w/2, h/2), random.uniform(-4, 4), 1.0)
    M[0, 2] += random.randint(-2, 2); M[1, 2] += random.randint(-2, 2)
    return cv2.warpAffine(crop, M, (w, h), borderValue=255)


def collect(cat):
    import sqlite3
    gt = json.loads((REPO/'groundtruth'/cat/'groundtruth.json').read_text('utf-8'))
    con = sqlite3.connect(REPO/'docs'/'catalogs'/f'{cat}.sqlite')
    cache, boxes = {}, []
    for _, e in gt.items():
        num = e['number']
        if num not in cache:
            r = con.execute("SELECT diagram_blob,diagram_w,diagram_h FROM section WHERE number=?", (num,)).fetchone()
            cache[num] = 255 - (np.array(decode(bytes(r[0]), r[1], r[2])) * 255).astype(np.uint8) if r and r[0] else None
        im = cache[num]
        if im is None:
            continue
        H, W = im.shape
        for c in e['callouts']:
            s = str(c['num'])
            if not COMPOUND.match(s):
                continue
            x0, x1 = int(c['x0']/10000*W), int(c['x1']/10000*W)
            y0, y1 = int(c['y0']/10000*H), int(c['y1']/10000*H)
            px, py = int((x1-x0)*0.18), int((y1-y0)*0.18)
            crop = im[max(0, y0-py):min(H, y1+py), max(0, x0-px):min(W, x1+px)]
            if crop.size:
                boxes.append((s, crop))
    con.close()
    return boxes


def main():
    GT_DIR.mkdir(parents=True, exist_ok=True)
    HELD.mkdir(parents=True, exist_ok=True)
    for f in GT_DIR.glob('comp_*'): f.unlink()
    for f in HELD.glob('*'): f.unlink()

    boxes = []
    for cat in cats:
        boxes += collect(cat)
    random.shuffle(boxes)
    n_test = max(8, len(boxes) // 5)
    test, train = boxes[:n_test], boxes[n_test:]
    print(f"compound boxes {len(boxes)}  train {len(train)}  held-out {len(test)}")

    labels = {}
    for i, (s, crop) in enumerate(test):
        g = norm_box(crop)
        if g is None: continue
        Image.fromarray(g).save(HELD/f"t{i:03d}.png"); labels[f"t{i:03d}.png"] = s
    (HELD/'labels.json').write_text(json.dumps(labels))

    idx = 0
    for s, crop in train:
        for a in range(AUG):
            g = norm_box(crop if a == 0 else jitter(crop))
            if g is None: continue
            stem = f"comp_{idx:05d}"
            Image.fromarray(g).save(GT_DIR/f"{stem}.tif", dpi=(300, 300))
            (GT_DIR/f"{stem}.gt.txt").write_text(s, encoding='utf-8')
            gh, gw = g.shape
            (GT_DIR/f"{stem}.box").write_bytes(f"WordStr 0 0 {gw-1} {gh-1} 0 #{s}\n".encode('utf-8'))
            idx += 1
    print(f"wrote {idx} augmented compound triples -> {GT_DIR}")
    print(f"held-out -> {HELD}/labels.json")


if __name__ == '__main__':
    main()
