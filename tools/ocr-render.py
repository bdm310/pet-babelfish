#!/usr/bin/env python3
"""
Render a section diagram with GT boxes (green) + shipping callout preds (orange),
FP preds (red), FN truth (magenta). Visual debugging for OCR failures.

Usage:
    uv run --with pillow python tools/ocr-render.py --catalog-id 996_1998-2005 --section 320-06
    uv run ... --catalog-id 996_1998-2005 --section 320-06 --crop 5418,5989,5482,6211  # zoom a box (0-10000)
"""
import sys, json, io, sqlite3
from pathlib import Path
from PIL import Image, ImageDraw

sys.stdout.reconfigure(encoding='utf-8')
args = sys.argv[1:]
def opt(n, d=None):
    try: return args[args.index(n) + 1]
    except (ValueError, IndexError): return d

cat = opt('--catalog-id'); secnum = opt('--section'); crop = opt('--crop')
iou_thr = float(opt('--iou', '0.3'))
out_dir = Path(__file__).parent.parent / 'groundtruth' / cat
gt = json.loads((out_dir / 'groundtruth.json').read_text(encoding='utf-8'))
con = sqlite3.connect(out_dir / 'catalog.sqlite')

sid = next(s for s in gt if gt[s]['number'] == secnum)
row = con.execute("SELECT diagram_blob FROM section WHERE number=?", (secnum,)).fetchone()
im = Image.open(io.BytesIO(bytes(row[0]))).convert('RGB'); W, H = im.size

preds = []
for num, x0, y0, x1, y1, conf in con.execute(
        "SELECT number, x0, y0, x1, y1, confidence FROM callout WHERE section_id=?", (sid,)):
    preds.append({'num': str(num).strip('()'), 'box': [x0, y0, x1, y1], 'conf': conf})
con.close()

def px(b): return [b[0]/10000*W, b[1]/10000*H, b[2]/10000*W, b[3]/10000*H]
def iou(a, b):
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1]); ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0, ix1-ix0), max(0, iy1-iy0); inter = iw*ih
    if inter == 0: return 0.0
    return inter / ((a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - inter)

gtc = [{'num': str(c['num']), 'box': [c['x0'], c['y0'], c['x1'], c['y1']]} for c in gt[sid]['callouts']]
matched_p = set()
for g in gtc:
    hit = None
    for i, p in enumerate(preds):
        if i in matched_p: continue
        if p['num'] == g['num'] and iou(g['box'], p['box']) >= iou_thr:
            hit = i; break
    g['matched'] = hit is not None
    if hit is not None: matched_p.add(hit)

d = ImageDraw.Draw(im)
for g in gtc:
    b = px(g['box']); col = (0, 170, 0) if g['matched'] else (255, 0, 255)
    d.rectangle(b, outline=col, width=2)
    if not g['matched']: d.text((b[0], b[1]-11), f"GT{g['num']}", fill=(255, 0, 255))
for i, p in enumerate(preds):
    b = px(p['box']); col = (255, 140, 0) if i in matched_p else (255, 0, 0)
    d.rectangle(b, outline=col, width=1)
    if i not in matched_p: d.text((b[2]+1, b[1]), f"{p['num']}", fill=(255, 0, 0))

if crop:
    cx0, cy0, cx1, cy1 = [float(v) for v in crop.split(',')]
    m = 400
    box = (max(0, cx0/10000*W-m), max(0, cy0/10000*H-m), min(W, cx1/10000*W+m), min(H, cy1/10000*H+m))
    im = im.crop([int(v) for v in box])

sc = opt('--scale')
if sc: im = im.resize((int(W*float(sc)), int(H*float(sc))), Image.LANCZOS) if not crop else \
              im.resize((int(im.width*float(sc)), int(im.height*float(sc))), Image.LANCZOS)
scratch = Path(r"C:\Users\chell\AppData\Local\Temp\claude\c--Users-chell-Documents-GitHub-pet-babelfish\5ff7abcc-85c8-4cc8-bfc5-5db8d324af3d\scratchpad")
p = scratch / f"render_{cat}_{secnum}.png"
im.save(p)
print(f"magenta=missed truth  red=spurious pred  green=matched GT  orange=matched pred")
print(f"GT={len(gtc)} pred={len(preds)} matched={len(matched_p)}")
print(p)
