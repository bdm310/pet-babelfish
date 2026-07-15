#!/usr/bin/env python3
"""Simulate the worker's OCR candidate selection on a native diagram image.
Replicates: binarize -> for each fontPt compute s -> upscale(only if s>1) -> findBlobs
-> count blobs in [minH,maxH] with aspect w/h<=2. Compares clamp variants / candidate sets."""
import sys
from PIL import Image
import numpy as np
from scipy import ndimage

img = Image.open(sys.argv[1]).convert('L')
base = np.array(img)
W_img = base.shape[1]
pxPerPt = W_img / 396.85
targetPx = 40.0
minH, maxH = targetPx*0.9, targetPx*1.1  # 36,44

def count_candidates(s):
    if s > 1:
        w = int(round(base.shape[1]*s)); h = int(round(base.shape[0]*s))
        a = np.array(Image.fromarray(base).resize((w,h), Image.BILINEAR))
    else:
        a = base  # upscale() no-ops for factor<=1
    ink = a < 128
    lbl, n = ndimage.label(ink)
    cnt = 0
    for sl in ndimage.find_objects(lbl):
        ys, xs = sl
        bh = ys.stop-ys.start; bw = xs.stop-xs.start
        if minH <= bh <= maxH and bw/bh <= 2:
            cnt += 1
    return cnt

def run(cands, clamp):
    best = 0; detail=[]
    for fp in cands:
        raw = targetPx/(fp*pxPerPt)
        s = max(1,raw) if clamp else raw
        c = count_candidates(s)
        detail.append(f"fp={fp}:s={s:.2f}->{c}")
        best = max(best,c)
    return best, detail

print(f"pxPerPt={pxPerPt:.2f}\n")
for label,cands,clamp in [
    ("CURRENT   [7,9,12] clamp",      [7,9,12], True),
    ("OPT1 remove clamp [7,9,12]",    [7,9,12], False),
    ("OPT2 add 6  [6,7,9,12] clamp",  [6,7,9,12], True),
    ("OPT2 add 5,6 [5,6,7,9,12] clamp",[5,6,7,9,12], True),
]:
    best,detail = run(cands,clamp)
    print(f"{label}: best candidates={best}")
    print("   ", " | ".join(detail))
