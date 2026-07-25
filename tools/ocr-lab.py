#!/usr/bin/env python3
"""
OCR detection lab - fast offline iteration on callout candidate-detection + grouping,
graded against the ground truth. Uses cv2 for blob work and system Tesseract 5.4
(same porsche model the pipeline ships) so the algorithm can be tuned without the
browser round-trip. Once an approach wins here it is ported to ingest.worker.js.

Detector (v-current, see detect_callouts):
  - native-resolution connected components (no global font cascade)
  - per-candidate size normalization: each blob is upscaled to a fixed OCR height,
    so oversized callouts (whole sections the pipeline missed) read fine
  - magnitude/gap-aware grouping: callouts are 1-2 digits, value <= ~99; never emit
    a >2-digit group

Usage:
    uv run --with opencv-python-headless --with pytesseract --with pillow --with numpy \
        python tools/ocr-lab.py --catalog-id 996_1998-2005
    ... --catalog-id 996_1998-2005 --section 320-06 --render   # debug one section
    ... --catalog-id 996_1998-2005 --limit 40                   # quick slice
"""
import sys, os, json, io, sqlite3
from collections import Counter
from pathlib import Path

import cv2
import numpy as np
import pytesseract
from pytesseract import Output
from PIL import Image
from concurrent.futures import ThreadPoolExecutor

sys.stdout.reconfigure(encoding='utf-8')
args = sys.argv[1:]
def opt(n, d=None):
    try: return args[args.index(n) + 1]
    except (ValueError, IndexError): return d
def flag(n): return n in args

cat = opt('--catalog-id')
only_section = opt('--section')
render = flag('--render')
limit = int(opt('--limit', '0'))
iou_thr = float(opt('--iou', '0.3'))
if not cat:
    print("--catalog-id required"); sys.exit(1)

REPO = Path(__file__).parent.parent
TESS_EXE = r'C:\Program Files\Tesseract-OCR\tesseract.exe'
TESSDATA = opt('--tessdata', str(REPO / 'docs' / 'tessdata'))
pytesseract.pytesseract.tesseract_cmd = TESS_EXE
os.environ['TESSDATA_PREFIX'] = TESSDATA
LANG = opt('--lang', 'porsche')
SCRATCH = Path(r"C:\Users\chell\AppData\Local\Temp\claude\c--Users-chell-Documents-GitHub-pet-babelfish\5ff7abcc-85c8-4cc8-bfc5-5db8d324af3d\scratchpad")

out_dir = REPO / 'groundtruth' / cat
gt = json.loads((out_dir / 'groundtruth.json').read_text('utf-8'))
USE_EXPECTED = flag('--expected')
expected = json.loads((out_dir / 'expected.json').read_text('utf-8')) if USE_EXPECTED else {}
con = sqlite3.connect(out_dir / 'catalog.sqlite')

# ── tunables ──────────────────────────────────────────────────────────────────
BIN_THRESH   = 160     # ink threshold (0-255); < thresh = ink
OCR_H        = 48      # normalized glyph height fed to Tesseract
PAD          = 14      # white pad around normalized glyph
MIN_H_PX     = 9       # abs min component height
MAX_H_FRAC   = 0.10    # max component height as fraction of image height
MIN_AR       = 0.06    # min w/h (allow thin "1")
MAX_AR       = 1.6     # max w/h for a single glyph
MIN_CONF     = int(opt('--min-conf', '60'))
MAX_VALUE    = 99      # callouts never exceed this
USE_HIER     = not flag('--no-hier')
GAP_FRAC     = float(opt('--gap', '0.9'))   # max inter-digit gap as fraction of glyph height


def _norm_glyph(ink_crop):
    """Normalize one glyph mask (255=ink) to OCR_H tall, padded, black-on-white."""
    h, w = ink_crop.shape
    sc = OCR_H / max(1, h)
    rw, rh = max(1, int(round(w*sc))), OCR_H
    g = cv2.resize(ink_crop, (rw, rh), interpolation=cv2.INTER_CUBIC)
    canvas = np.zeros((rh + 2*PAD, rw + 2*PAD), np.uint8)
    canvas[PAD:PAD+rh, PAD:PAD+rw] = g
    img = 255 - canvas
    return ((img >= 128).astype(np.uint8))*255  # black glyph on white


_POOL = ThreadPoolExecutor(max_workers=int(opt('--jobs', '12')))

def _read_one(mask):
    """Faithful per-glyph OCR (PSM 10), same as production feeds one blob. Returns (digit,conf)."""
    img = _norm_glyph(mask)
    d = pytesseract.image_to_data(Image.fromarray(img), lang=LANG,
            config='--psm 10 -c tessedit_char_whitelist=0123456789', output_type=Output.DICT)
    best, bestc = '', -1
    for t, c in zip(d['text'], d['conf']):
        t = t.strip()
        try: c = float(c)
        except: c = -1
        if t and c > bestc: best, bestc = t, int(c)
    return best, (bestc if bestc >= 0 else 0)

def read_glyphs_batch(masks):
    """Per-glyph OCR, thread-pooled (subprocess is I/O-bound) for harness speed."""
    if not masks: return []
    return list(_POOL.map(_read_one, masks))


def component_depth(ink, labels, n):
    """Map each component label -> its ink-nesting depth via a filled depth-map. Depth 0 =
    outermost ink (page frame if any). Parts + callouts share the first CONTENT depth;
    things drawn INSIDE a closed shape (legend-box numbers, bolt holes, interior features)
    are deeper. A real callout never sits inside another blob, so it lives at the shallowest
    content level; deeper digit-shaped components are printed-in-diagram text or features.

    Mapping contour->component by centroid is wrong (a 0/8 centroid lands on its hole), so
    instead each even-depth (object) contour is drawn FILLED with its depth into a depth-map,
    deeper contours overwriting shallower; a component's depth is then read at its pixels."""
    contours, hier = cv2.findContours(ink, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    if hier is None: return {}
    hier = hier[0]
    dmap = np.full(labels.shape, -1, np.int32)
    items = []
    for i in range(len(contours)):
        d, p = 0, hier[i][3]
        while p != -1:
            d += 1; p = hier[p][3]
        if d % 2 == 0:                # even depth = an ink object (odd = a hole)
            items.append((d, i))
    items.sort()                      # shallow first, so deeper overwrites
    for d, i in items:
        cv2.drawContours(dmap, contours, i, int(d), thickness=cv2.FILLED)
    return dmap                        # per-pixel object depth (-1 outside any object)

def detect_callouts(im_gray):
    """im_gray: np.uint8 HxW. Returns list of {num:str, box:[x0,y0,x1,y1] 0-10000, conf}."""
    H, W = im_gray.shape
    ink = (im_gray < BIN_THRESH).astype(np.uint8)
    n, labels, stats, cents = cv2.connectedComponentsWithStats(ink, connectivity=8)
    dmap = component_depth(ink, labels, n) if USE_HIER else None

    cands = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if h < MIN_H_PX or h > MAX_H_FRAC*H:
            continue
        ar = w / h
        if ar < MIN_AR or ar > MAX_AR:
            continue
        if area < 0.10 * w * h:      # too sparse to be a glyph (outline fragment)
            continue
        cands.append((i, x, y, w, h))

    # hierarchy filter: keep candidates at the shallowest content depth. Digit-shaped
    # components drawn INSIDE a closed shape (legend/example boxes, interior part-features)
    # are deeper and dropped. Frame-agnostic (depth is relative). Per the domain fact that
    # a real callout never sits inside another blob.
    if USE_HIER and dmap is not None and cands:
        cdep = {}
        for i, x, y, w, h in cands:
            sub = dmap[y:y+h, x:x+w][labels[y:y+h, x:x+w] == i]
            sub = sub[sub >= 0]
            cdep[i] = int(np.median(sub)) if len(sub) else 0
        d0 = min(cdep.values())
        cands = [c for c in cands if cdep[c[0]] <= d0]

    # OCR all candidates (batched for harness speed)
    masks = [(labels[y:y+h, x:x+w] == i).astype(np.uint8)*255 for i, x, y, w, h in cands]
    reads = read_glyphs_batch(masks)
    digits = []
    for (i, x, y, w, h), (txt, conf) in zip(cands, reads):
        if len(txt) == 1 and txt.isdigit() and conf >= MIN_CONF:
            digits.append(dict(d=txt, conf=conf, x0=x, y0=y, x1=x+w, y1=y+h, w=w, h=h))

    # group into numbers: two digits of one callout are on the same baseline and their
    # inter-glyph gap scales with FONT SIZE (glyph height), not width - a width-based gap
    # is skewed tiny by narrow "1"s and wrongly splits "11"/"19". A callout is 1-2 digits,
    # value<=MAX_VALUE, so any wider run is a coincidence of two separate callouts.
    digits.sort(key=lambda g: g['x0'])
    groups = []
    for dg in digits:
        yc = (dg['y0']+dg['y1'])/2
        placed = False
        for grp in groups:
            last = grp['items'][-1]
            gap = dg['x0'] - grp['x1']
            yl = (last['y0']+last['y1'])/2
            hh = max(dg['h'], last['h'])
            same_row = abs(yc-yl) < 0.35*hh
            near = -0.15*hh <= gap < GAP_FRAC*hh
            if same_row and near and len(grp['items']) < 2:
                cand_val = int(''.join(it['d'] for it in grp['items']) + dg['d'])
                if cand_val <= MAX_VALUE:
                    grp['items'].append(dg)
                    grp['x1'] = max(grp['x1'], dg['x1']); grp['y0'] = min(grp['y0'], dg['y0'])
                    grp['y1'] = max(grp['y1'], dg['y1'])
                    placed = True; break
        if not placed:
            groups.append(dict(items=[dg], x0=dg['x0'], y0=dg['y0'], x1=dg['x1'], y1=dg['y1']))

    out = []
    for grp in groups:
        num = ''.join(it['d'] for it in grp['items'])
        if num.lstrip('0') == '': continue
        conf = int(np.mean([it['conf'] for it in grp['items']]))
        out.append(dict(num=num, conf=conf,
            box=[round(grp['x0']/W*10000), round(grp['y0']/H*10000),
                 round(grp['x1']/W*10000), round(grp['y1']/H*10000)]))
    return out


# ── grading ───────────────────────────────────────────────────────────────────
def iou(a, b):
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1]); ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0, ix1-ix0), max(0, iy1-iy0); inter = iw*ih
    if inter == 0: return 0.0
    return inter/((a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-inter)
def overlaps(a, b): return not (a[2]<=b[0] or b[2]<=a[0] or a[3]<=b[1] or b[3]<=a[1])

def match(gt_list, pred_list):
    pairs = []
    for gi, g in enumerate(gt_list):
        for pi, p in enumerate(pred_list):
            if g['num'] != int(p['num']): continue
            v = iou(g['box'], p['box'])
            if v >= iou_thr: pairs.append((v, gi, pi))
    pairs.sort(reverse=True)
    gused, pused = set(), set()
    for v, gi, pi in pairs:
        if gi in gused or pi in pused: continue
        gused.add(gi); pused.add(pi)
    return gused, pused

items = list(gt.items())
if only_section:
    items = [(s, e) for s, e in items if e['number'] == only_section]
if limit: items = items[:limit]

TP=FP=FN=0
fn_cat=Counter(); fp_cat=Counter(); fn_pairs=Counter(); fn_missed=Counter(); fp_spur=Counter()
for sid, e in items:
    row = con.execute("SELECT diagram_blob FROM section WHERE number=?", (e['number'],)).fetchone()
    if not row or not row[0]: continue
    im = np.array(Image.open(io.BytesIO(bytes(row[0]))).convert('L'))
    preds = detect_callouts(im)
    if USE_EXPECTED:
        exp = set(expected.get(sid, []))
        preds = [p for p in preds if int(p['num']) in exp]
    gt_list = [{'num': c['num'], 'box': [c['x0'],c['y0'],c['x1'],c['y1']]} for c in e['callouts']]
    gused, pused = match(gt_list, preds)
    TP += len(gused); FP += len(preds)-len(pused); FN += len(gt_list)-len(gused)
    for gi, g in enumerate(gt_list):
        if gi in gused: continue
        near = [p for p in preds if overlaps(g['box'], p['box'])]
        if near: fn_cat['misread-near']+=1; fn_pairs[(g['num'], near[0]['num'])]+=1
        else: fn_cat['missed']+=1; fn_missed[g['num']]+=1
    _sec_spur = 0
    for pi, p in enumerate(preds):
        if pi in pused: continue
        near = [g for g in gt_list if overlaps(g['box'], p['box'])]
        if near: fp_cat['misread-near']+=1
        else: fp_cat['spurious']+=1; fp_spur[p['num']]+=1; _sec_spur += 1
    if flag('--dump-spur') and _sec_spur >= int(opt('--dump-thresh', '3')):
        print(f"  SPUR {e['number']}: {_sec_spur} spurious")
    if render and only_section:
        rgb = cv2.cvtColor(im, cv2.COLOR_GRAY2BGR)
        Hh, Ww = im.shape
        for g in gt_list:
            b=g['box']; c=(0,170,0) if gi in gused else (255,0,255)
            cv2.rectangle(rgb,(b[0]*Ww//10000,b[1]*Hh//10000),(b[2]*Ww//10000,b[3]*Hh//10000),(0,170,0),2)
        for p in preds:
            b=p['box']; col=(0,140,255)
            cv2.rectangle(rgb,(b[0]*Ww//10000,b[1]*Hh//10000),(b[2]*Ww//10000,b[3]*Hh//10000),col,1)
            cv2.putText(rgb,p['num'],(b[2]*Ww//10000+2,b[3]*Hh//10000),cv2.FONT_HERSHEY_SIMPLEX,0.5,(0,0,255),1)
        pth = SCRATCH / f"lab_{cat}_{e['number']}.png"
        cv2.imwrite(str(pth), rgb); print("rendered", pth)

con.close()
prec = TP/(TP+FP) if TP+FP else 0
rec = TP/(TP+FN) if TP+FN else 0
f1 = 2*prec*rec/(prec+rec) if prec+rec else 0
print(f"\n=== ocr-lab: {cat} ({len(items)} sections, lang={LANG}) ===")
print(f"  TP {TP}  FP {FP}  FN {FN}")
print(f"  precision {prec:.3f}  recall {rec:.3f}  F1 {f1:.3f}  (IoU>={iou_thr})")
print(f"  FN: {dict(fn_cat)}   FP: {dict(fp_cat)}")
if fn_pairs: print("  misread pairs:", dict(fn_pairs.most_common(12)))
if fn_missed: print("  pure-missed by num:", dict(fn_missed.most_common(12)))
if fp_spur: print("  spurious by num:", dict(fp_spur.most_common(12)))
