#!/usr/bin/env python3
"""Full P/R/F1/det-recall/mIoU from an ocr-detect-dump.py dump vs groundtruth.json,
using the same greedy IoU matching as ocr-eval.py. Lets us read the model path's
end-to-end callout metrics WITHOUT a full re-ingest (the dump's callouts are the real
model-path output per section)."""
import sys, json
from pathlib import Path
args = sys.argv[1:]
def opt(n, d=None):
    try: return args[args.index(n)+1]
    except (ValueError, IndexError): return d
cat = opt('--catalog-id'); dump_path = opt('--dump'); IOU=float(opt('--iou','0.3'))
root = Path(__file__).parent.parent
gt = json.loads((root/'groundtruth'/cat/'groundtruth.json').read_text(encoding='utf-8'))
dump = json.loads(Path(dump_path).read_text(encoding='utf-8'))
def iou(a,b):
    ix0,iy0=max(a[0],b[0]),max(a[1],b[1]); ix1,iy1=min(a[2],b[2]),min(a[3],b[3])
    iw,ih=max(0,ix1-ix0),max(0,iy1-iy0); inter=iw*ih
    if inter==0: return 0.0
    return inter/((a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-inter)
def num(s):
    s=str(s).strip().strip('()'); return int(s) if s.lstrip('-').isdigit() else None
def match(gl,pl,req):
    pairs=[]
    for gi,g in enumerate(gl):
        for pi,p in enumerate(pl):
            if req and g['num']!=p['num']: continue
            v=iou(g['box'],p['box'])
            if v>=IOU: pairs.append((v,gi,pi))
    pairs.sort(reverse=True); gu,pu,iv=set(),set(),[]
    for v,gi,pi in pairs:
        if gi in gu or pi in pu: continue
        gu.add(gi);pu.add(pi);iv.append(v)
    return len(gu),iv
TP=FP=FN=0; det=0; ious=[]
for sid,meta in gt.items():
    gl=[{'num':c['num'],'box':[c['x0'],c['y0'],c['x1'],c['y1']]} for c in meta['callouts']]
    dbg=dump.get(sid); pl=[]
    if dbg:
        for c in dbg['callouts']:
            n=num(c['number'])
            if n is not None: pl.append({'num':n,'box':c['box']})
    tp,iv=match(gl,pl,True); dtp,_=match(gl,pl,False)
    TP+=tp; FP+=len(pl)-tp; FN+=len(gl)-tp; det+=dtp; ious+=iv
P=TP/(TP+FP) if TP+FP else 0; R=TP/(TP+FN) if TP+FN else 0
F=2*P*R/(P+R) if P+R else 0; dR=det/(TP+FN) if TP+FN else 0
mi=sum(ious)/len(ious) if ious else 0
print(f"{cat}: TP {TP} FP {FP} FN {FN}  P {P:.3f} R {R:.3f} F1 {F:.3f}  detR {dR:.3f}  mIoU {mi:.3f}")
