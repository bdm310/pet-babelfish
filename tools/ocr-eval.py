#!/usr/bin/env python3
"""
Grade the shipping Tesseract callout OCR against the ground-truth dataset.

Ground truth (groundtruth/<catalog>/groundtruth.json) holds, per section, the true
callout instances {num, box} in the 0-10000 space — silver (Vision multi-scale on
CLEAN sections) + gold (Vision+agent, every missing callout resolved/confirmed).
The system under test is the `callout` table in that catalog's SQLite (Tesseract's
own detections, same 0-10000 space). We match predictions to truth and report
per-instance precision/recall/F1 and localization IoU — a real metric, unlike the
old set-recall-only coverage check.

A prediction is a TRUE POSITIVE when it shares a truth callout's NUMBER and their
boxes overlap at IoU >= threshold. We also report a detection-only view (box match
ignoring the number) to separate localization from digit recognition.

Reports overall and gold-only (gold is human-verified; silver inherits Vision's
~93% and a few anchor-mislabels, so gold-only is the stricter number).

Usage:
    uv run --with pillow python tools/ocr-eval.py --catalog-id 997-1Turbo-GT2_2007-2009
    uv run ... tools/ocr-eval.py --catalog-id 996_1998-2005 --iou 0.3
"""
import sys, json, sqlite3, csv
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
args = sys.argv[1:]
def opt(n, d=None):
    try: return args[args.index(n) + 1]
    except (ValueError, IndexError): return d

cat = opt('--catalog-id')
iou_thr = float(opt('--iou', '0.3'))
if not cat:
    print("--catalog-id required"); sys.exit(1)

out_dir = Path(__file__).parent.parent / 'groundtruth' / cat
gt = json.loads((out_dir / 'groundtruth.json').read_text(encoding='utf-8'))
con = sqlite3.connect(out_dir / 'catalog.sqlite')

# Tesseract predictions from the callout table, keyed by section_id
preds = {}
for sid, num, x0, y0, x1, y1, conf in con.execute(
        "SELECT section_id, number, x0, y0, x1, y1, confidence FROM callout"):
    s = str(num).strip().strip('()')
    if not s.lstrip('-').isdigit():
        continue
    # ids are string tokens; a digit-only Tesseract pred can never match a compound
    # gold id ('3/1'), which correctly leaves that gold callout unmatched (an FN).
    preds.setdefault(str(sid), []).append({'num': s, 'box': [x0, y0, x1, y1], 'conf': conf})
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


def match(gt_list, pred_list, require_num):
    """Greedy IoU matching. Returns (tp, matched_ious, used_pred_idx)."""
    pairs = []
    for gi, g in enumerate(gt_list):
        for pi, p in enumerate(pred_list):
            if require_num and g['num'] != p['num']:
                continue
            v = iou(g['box'], p['box'])
            if v >= iou_thr:
                pairs.append((v, gi, pi))
    pairs.sort(reverse=True)
    gused, pused, ious = set(), set(), []
    for v, gi, pi in pairs:
        if gi in gused or pi in pused:
            continue
        gused.add(gi); pused.add(pi); ious.append(v)
    return len(gused), ious, pused


def evaluate(section_ids):
    TP = FP = FN = 0; ious = []
    det_TP = 0                         # detection-only (ignore number)
    rows = []
    for sid in section_ids:
        gt_list = [{'num': str(c['num']), 'box': [c['x0'], c['y0'], c['x1'], c['y1']]}
                   for c in gt[sid]['callouts']]
        pred_list = preds.get(sid, [])
        tp, mious, _ = match(gt_list, pred_list, require_num=True)
        dtp, _, _ = match(gt_list, pred_list, require_num=False)
        fp = len(pred_list) - tp; fn = len(gt_list) - tp
        TP += tp; FP += fp; FN += fn; det_TP += dtp; ious += mious
        rows.append((gt[sid]['number'], len(gt_list), len(pred_list), tp, fp, fn))
    prec = TP / (TP + FP) if TP + FP else 0
    rec  = TP / (TP + FN) if TP + FN else 0
    f1   = 2 * prec * rec / (prec + rec) if prec + rec else 0
    det_rec = det_TP / (TP + FN) if TP + FN else 0
    miou = sum(ious) / len(ious) if ious else 0
    return dict(TP=TP, FP=FP, FN=FN, prec=prec, rec=rec, f1=f1,
                det_rec=det_rec, miou=miou, rows=rows)


all_ids  = list(gt.keys())
gold_ids = [s for s in gt if gt[s].get('tier') == 'gold']


def show(name, r):
    print(f"\n── {name} ({len(r['rows'])} sections) ──")
    print(f"  truth callouts : {r['TP'] + r['FN']}")
    print(f"  TP {r['TP']}  FP {r['FP']}  FN {r['FN']}")
    print(f"  precision {r['prec']:.3f}   recall {r['rec']:.3f}   F1 {r['f1']:.3f}   (IoU>={iou_thr}, number must match)")
    print(f"  detection-only recall {r['det_rec']:.3f}   (box match, number ignored)")
    print(f"  → digit-recognition gap: {r['det_rec'] - r['rec']:.3f} of boxes found but mislabeled")
    print(f"  mean IoU of true positives: {r['miou']:.3f}")


print(f"=== OCR eval: {cat} ===")
rall = evaluate(all_ids); show("ALL (silver+gold)", rall)
rgold = evaluate(gold_ids); show("GOLD only (human-verified)", rgold)

with open(out_dir / 'eval.csv', 'w', newline='', encoding='utf-8') as f:
    w = csv.writer(f); w.writerow(['section', 'truth', 'pred', 'tp', 'fp', 'fn'])
    w.writerows(sorted(rall['rows']))
print(f"\nPer-section detail → {out_dir / 'eval.csv'}")
