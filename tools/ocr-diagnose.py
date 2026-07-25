#!/usr/bin/env python3
"""
Categorize every FN and FP of the shipping callout OCR vs ground truth, so we know
WHICH failure mode to attack. Complements ocr-eval.py (which only reports aggregate
P/R/F1). For each unmatched truth (FN) and unmatched prediction (FP) it finds the
nearest opposite-side item and classifies the error.

FN categories:
  misread-near   a pred box overlaps this truth box but the NUMBER differs
                 (detection ok, digit wrong - e.g. 996 "11"->"1")
  missed         no pred box overlaps at all (pure detection failure:
                 leader-line fusion, too-small blob, aspect filter, etc.)
FP categories:
  misread-near   overlaps a truth box whose number differs (the flip side of misread FN)
  spurious       overlaps no truth box (noise blob read as a digit, or a real
                 stray diagram number not in the parts list)

Usage:
    uv run --with pillow python tools/ocr-diagnose.py --catalog-id 996_1998-2005
"""
import sys, json, sqlite3
from collections import Counter
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
args = sys.argv[1:]
def opt(n, d=None):
    try: return args[args.index(n) + 1]
    except (ValueError, IndexError): return d

cat = opt('--catalog-id')
iou_thr = float(opt('--iou', '0.3'))
show_n = int(opt('--show', '40'))
if not cat:
    print("--catalog-id required"); sys.exit(1)

out_dir = Path(__file__).parent.parent / 'groundtruth' / cat
gt = json.loads((out_dir / 'groundtruth.json').read_text(encoding='utf-8'))
con = sqlite3.connect(out_dir / 'catalog.sqlite')

preds = {}
for sid, num, x0, y0, x1, y1, conf in con.execute(
        "SELECT section_id, number, x0, y0, x1, y1, confidence FROM callout"):
    s = str(num).strip().strip('()')
    if not s.lstrip('-').isdigit():
        continue
    preds.setdefault(str(sid), []).append({'num': int(s), 'box': [x0, y0, x1, y1], 'conf': conf})
con.close()


def iou(a, b):
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0, ix1 - ix0), max(0, iy1 - iy0)
    inter = iw * ih
    if inter == 0:
        return 0.0
    aa = (a[2] - a[0]) * (a[3] - a[1]); bb = (b[2] - b[0]) * (b[3] - b[1])
    return inter / (aa + bb - inter)


def overlaps(a, b):
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def match(gt_list, pred_list):
    pairs = []
    for gi, g in enumerate(gt_list):
        for pi, p in enumerate(pred_list):
            if g['num'] != p['num']:
                continue
            v = iou(g['box'], p['box'])
            if v >= iou_thr:
                pairs.append((v, gi, pi))
    pairs.sort(reverse=True)
    gused, pused = set(), set()
    for v, gi, pi in pairs:
        if gi in gused or pi in pused:
            continue
        gused.add(gi); pused.add(pi)
    return gused, pused


fn_cat = Counter(); fp_cat = Counter()
fn_pairs = Counter()   # (truth_num, pred_num) for misread FNs
fn_missed_nums = Counter()
fp_spurious_nums = Counter()
examples_missed = []; examples_misread = []; examples_spurious = []

for sid in gt:
    gt_list = [{'num': c['num'], 'box': [c['x0'], c['y0'], c['x1'], c['y1']]}
               for c in gt[sid]['callouts']]
    pred_list = preds.get(sid, [])
    gused, pused = match(gt_list, pred_list)
    secnum = gt[sid]['number']

    for gi, g in enumerate(gt_list):
        if gi in gused:
            continue
        # unmatched truth: does any pred box overlap it?
        near = [p for p in pred_list if overlaps(g['box'], p['box'])]
        if near:
            fn_cat['misread-near'] += 1
            pn = near[0]['num']
            fn_pairs[(g['num'], pn)] += 1
            if len(examples_misread) < show_n:
                examples_misread.append((secnum, g['num'], pn, g['box']))
        else:
            fn_cat['missed'] += 1
            fn_missed_nums[g['num']] += 1
            if len(examples_missed) < show_n:
                examples_missed.append((secnum, g['num'], g['box']))

    for pi, p in enumerate(pred_list):
        if pi in pused:
            continue
        near = [g for g in gt_list if overlaps(g['box'], p['box'])]
        if near:
            fp_cat['misread-near'] += 1
        else:
            fp_cat['spurious'] += 1
            fp_spurious_nums[p['num']] += 1
            if len(examples_spurious) < show_n:
                examples_spurious.append((secnum, p['num'], p['conf'], p['box']))

print(f"=== OCR diagnose: {cat} (IoU>={iou_thr}) ===\n")
print("FALSE NEGATIVES (missed truth):")
for k, v in fn_cat.most_common():
    print(f"  {k:14s} {v}")
print("\n  misread FN number pairs (truth -> pred):")
for (tn, pn), v in fn_pairs.most_common(20):
    print(f"    {tn} -> {pn}   x{v}")
print("\n  pure-missed FN by number:")
for n, v in fn_missed_nums.most_common(20):
    print(f"    {n}: {v}")

print("\nFALSE POSITIVES (spurious pred):")
for k, v in fp_cat.most_common():
    print(f"  {k:14s} {v}")
print("\n  spurious FP by number:")
for n, v in fp_spurious_nums.most_common(20):
    print(f"    {n}: {v}")

print("\n── examples: pure-missed (section, num, box) ──")
for e in examples_missed[:show_n]:
    print("  ", e)
print("\n── examples: misread FN (section, truth, pred, box) ──")
for e in examples_misread[:show_n]:
    print("  ", e)
print("\n── examples: spurious FP (section, num, conf, box) ──")
for e in examples_spurious[:show_n]:
    print("  ", e)
