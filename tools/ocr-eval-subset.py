#!/usr/bin/env python3
"""
End-to-end callout eval (same metric as ocr-eval.py) restricted to a SUBSET of
sections, given by their section NUMBERS (e.g. the 996-val held-out set). Used for
honest threshold selection: 997TT and non-val 996 sections must not inform it.

Usage:
    uv run python tools/ocr-eval-subset.py --catalog-id 996_1998-2005 \
        --sections 004-00,103-11,... --iou 0.3
    (or --sections-file path with one section number per line)
"""
import sys, json, sqlite3
from pathlib import Path

args = sys.argv[1:]
def opt(n, d=None):
    try: return args[args.index(n) + 1]
    except (ValueError, IndexError): return d

cat = opt('--catalog-id')
iou_thr = float(opt('--iou', '0.3'))
sec_arg = opt('--sections')
sec_file = opt('--sections-file')
if not cat:
    print("--catalog-id required"); sys.exit(1)

want = set()
if sec_arg:
    want |= {s.strip() for s in sec_arg.split(',') if s.strip()}
if sec_file:
    want |= {l.strip() for l in Path(sec_file).read_text().splitlines() if l.strip()}

out_dir = Path(__file__).parent.parent / 'groundtruth' / cat
gt = json.loads((out_dir / 'groundtruth.json').read_text(encoding='utf-8'))
con = sqlite3.connect(out_dir / 'catalog.sqlite')
preds = {}
for sid, num, x0, y0, x1, y1, conf in con.execute(
        "SELECT section_id, number, x0, y0, x1, y1, confidence FROM callout"):
    s = str(num).strip().strip('()')
    if not s.lstrip('-').isdigit():
        continue
    preds.setdefault(str(sid), []).append({'num': int(s), 'box': [x0, y0, x1, y1]})
con.close()

def iou(a, b):
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0, ix1 - ix0), max(0, iy1 - iy0)
    inter = iw * ih
    if inter == 0: return 0.0
    aa = (a[2]-a[0])*(a[3]-a[1]); bb = (b[2]-b[0])*(b[3]-b[1])
    return inter / (aa + bb - inter)

def match(gt_list, pred_list, require_num):
    pairs = []
    for gi, g in enumerate(gt_list):
        for pi, p in enumerate(pred_list):
            if require_num and g['num'] != p['num']: continue
            v = iou(g['box'], p['box'])
            if v >= iou_thr: pairs.append((v, gi, pi))
    pairs.sort(reverse=True)
    gused, pused, ious = set(), set(), []
    for v, gi, pi in pairs:
        if gi in gused or pi in pused: continue
        gused.add(gi); pused.add(pi); ious.append(v)
    return len(gused), ious

sel = [s for s in gt if gt[s]['number'] in want] if want else list(gt.keys())
missing = want - {gt[s]['number'] for s in sel}
TP=FP=FN=det_TP=0; ious=[]
for sid in sel:
    gt_list=[{'num':c['num'],'box':[c['x0'],c['y0'],c['x1'],c['y1']]} for c in gt[sid]['callouts']]
    pred_list=preds.get(sid, [])
    tp,mi=match(gt_list,pred_list,True)
    dtp,_=match(gt_list,pred_list,False)
    fp=len(pred_list)-tp; fn=len(gt_list)-tp
    TP+=tp; FP+=fp; FN+=fn; det_TP+=dtp; ious+=mi
prec=TP/(TP+FP) if TP+FP else 0
rec=TP/(TP+FN) if TP+FN else 0
f1=2*prec*rec/(prec+rec) if prec+rec else 0
det_rec=det_TP/(TP+FN) if TP+FN else 0
miou=sum(ious)/len(ious) if ious else 0
print(f"cat={cat} sections={len(sel)} (missing_from_gt={sorted(missing)})")
print(f"  truth={TP+FN} TP={TP} FP={FP} FN={FN}")
print(f"  P={prec:.4f} R={rec:.4f} F1={f1:.4f} detR={det_rec:.4f} mIoU={miou:.4f} (IoU>={iou_thr})")
# machine-readable
print(f"RESULT\tP={prec:.4f}\tR={rec:.4f}\tF1={f1:.4f}\tdetR={det_rec:.4f}\tmIoU={miou:.4f}\tTP={TP}\tFP={FP}\tFN={FN}")
