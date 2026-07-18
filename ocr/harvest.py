#!/usr/bin/env python3
"""
Harvest REAL per-digit glyph images from the ground-truth callout boxes of every
ingested catalog and write them as Tesseract training triples (.tif/.gt.txt/.box)
into ocr/train/ground-truth/. This replaces the single-synthetic-font training set
(ipa_font only) with real glyphs from BOTH the 996 and 997 fonts — the fix for the
996 "1"/"11" recognition gap, which is a font-coverage problem.

Method: for each GT callout box, connected-component the ink inside it. If the number
of digit-sized components equals the number of digits, assign components left->right to
the digits and emit one training image per (component, digit). Boxes whose component
count disagrees (touching or broken glyphs) are skipped — never guess a label.

Each emitted glyph is normalized exactly like the detector normalizes a candidate
(height OCR_H, white pad) so training matches inference.

Usage:
    uv run --with opencv-python-headless --with pillow --with numpy python ocr/harvest.py
    ... --montage         # also write a labeled montage for eyeball validation
    ... --catalogs 996_1998-2005,997-1Turbo-GT2_2007-2009
"""
import sys, json, io, sqlite3
from collections import Counter
from pathlib import Path
import cv2, numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding='utf-8')
args = sys.argv[1:]
def opt(n, d=None):
    try: return args[args.index(n)+1]
    except (ValueError, IndexError): return d
def flag(n): return n in args

REPO = Path(__file__).parent.parent
GT_DIR = REPO / 'ocr' / 'train' / 'ground-truth'
SCRATCH = Path(r"C:\Users\chell\AppData\Local\Temp\claude\c--Users-chell-Documents-GitHub-pet-babelfish\5ff7abcc-85c8-4cc8-bfc5-5db8d324af3d\scratchpad")
cats = (opt('--catalogs') or '996_1998-2005,997-1Turbo-GT2_2007-2009').split(',')

BIN_THRESH = 160
OCR_H = 48
PAD = 14
PAD_BOX = 3      # px pad around GT box before component analysis (0-10000 -> px)


def norm_glyph(mask):
    h, w = mask.shape
    sc = OCR_H / max(1, h)
    rw = max(1, int(round(w*sc)))
    g = cv2.resize(mask, (rw, OCR_H), interpolation=cv2.INTER_CUBIC)
    canvas = np.zeros((OCR_H+2*PAD, rw+2*PAD), np.uint8)
    canvas[PAD:PAD+OCR_H, PAD:PAD+rw] = g
    return 255 - ((canvas >= 128).astype(np.uint8)*255)  # black glyph on white


def harvest():
    GT_DIR.mkdir(parents=True, exist_ok=True)
    for f in GT_DIR.glob('real_*'):
        f.unlink()
    emitted = Counter(); skipped = 0; total_boxes = 0
    montage_tiles = []
    idx = 0
    for cat in cats:
        gt = json.loads((REPO/'groundtruth'/cat/'groundtruth.json').read_text('utf-8'))
        con = sqlite3.connect(REPO/'groundtruth'/cat/'catalog.sqlite')
        blobcache = {}
        for sid, e in gt.items():
            num_key = e['number']
            if num_key not in blobcache:
                row = con.execute("SELECT diagram_blob FROM section WHERE number=?", (num_key,)).fetchone()
                blobcache[num_key] = np.array(Image.open(io.BytesIO(bytes(row[0]))).convert('L')) if row and row[0] else None
            im = blobcache[num_key]
            if im is None: continue
            H, W = im.shape
            for c in e['callouts']:
                total_boxes += 1
                digits = str(c['num'])
                x0 = int(c['x0']/10000*W)-PAD_BOX; y0 = int(c['y0']/10000*H)-PAD_BOX
                x1 = int(c['x1']/10000*W)+PAD_BOX; y1 = int(c['y1']/10000*H)+PAD_BOX
                x0, y0 = max(0, x0), max(0, y0); x1, y1 = min(W, x1), min(H, y1)
                crop = im[y0:y1, x0:x1]
                if crop.size == 0: continue
                ink = (crop < BIN_THRESH).astype(np.uint8)
                n, labels, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
                boxH = y1-y0
                comps = [i for i in range(1, n) if stats[i][3] >= 0.45*boxH and stats[i][4] >= 6]
                comps.sort(key=lambda i: stats[i][0])   # left -> right
                if len(comps) != len(digits):
                    skipped += 1
                    continue
                for ci, d in zip(comps, digits):
                    x, y, w, h, area = stats[ci]
                    mask = (labels[y:y+h, x:x+w] == ci).astype(np.uint8)*255
                    g = norm_glyph(mask)
                    stem = f"real_{idx:05d}_{d}"
                    Image.fromarray(g).save(str(GT_DIR/f"{stem}.tif"), dpi=(300, 300))
                    (GT_DIR/f"{stem}.gt.txt").write_text(d, encoding='utf-8')
                    gh, gw = g.shape
                    (GT_DIR/f"{stem}.box").write_bytes(f"WordStr 0 0 {gw-1} {gh-1} 0 #{d}\n".encode('utf-8'))
                    emitted[d] += 1; idx += 1
                    if flag('--montage') and len(montage_tiles) < 240 and idx % 7 == 0:
                        montage_tiles.append((d, g))
        con.close()
    print(f"boxes seen {total_boxes}  emitted {sum(emitted.values())} glyphs  skipped(box) {skipped}")
    print("per-digit yield:", dict(sorted(emitted.items())))
    if flag('--montage') and montage_tiles:
        cell = 64; cols = 20; rows = (len(montage_tiles)+cols-1)//cols
        M = np.full((rows*cell, cols*cell), 255, np.uint8)
        for j, (d, g) in enumerate(montage_tiles):
            gg = cv2.resize(g, (cell-8, cell-8))
            r, cc = divmod(j, cols)
            M[r*cell+4:r*cell+4+gg.shape[0], cc*cell+4:cc*cell+4+gg.shape[1]] = gg
        Mrgb = cv2.cvtColor(M, cv2.COLOR_GRAY2BGR)
        for j, (d, g) in enumerate(montage_tiles):
            r, cc = divmod(j, cols)
            cv2.putText(Mrgb, d, (cc*cell+2, r*cell+14), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0,0,255), 1)
        p = SCRATCH/'harvest_montage.png'; cv2.imwrite(str(p), Mrgb); print("montage", p)

harvest()
