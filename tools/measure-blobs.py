#!/usr/bin/env python3
"""Connected-component blob heights on a 1-bpp diagram, replicating the worker's findBlobs.
Reports how digit-sized blobs compare to the OCR candidate window."""
import sys
from PIL import Image
import numpy as np
from scipy import ndimage

img = Image.open(sys.argv[1]).convert('L')
a = np.array(img)
W_img = a.shape[1]
ink = a < 128  # dark pixels are ink
lbl, n = ndimage.label(ink)
print(f"image {a.shape[1]}x{a.shape[0]}, {n} components")
hs = []
digit_like = []
objs = ndimage.find_objects(lbl)
for sl in objs:
    ys, xs = sl
    h = ys.stop - ys.start
    w = xs.stop - xs.start
    hs.append(h)
    # digit-ish: aspect w/h <= 2, reasonable height
    if h >= 10 and w/h <= 2 and h <= 200:
        digit_like.append(h)
hs = np.array(sorted(hs))
print("all blob height pct: p10=%d p50=%d p90=%d max=%d" % (
    np.percentile(hs,10), np.percentile(hs,50), np.percentile(hs,90), hs.max()))
dl = np.array(sorted(digit_like))
print(f"digit-like blobs (aspect<=2, 10<=h<=200): n={len(dl)}")
if len(dl):
    import collections
    # histogram of heights
    print("  height p10=%d p25=%d p50=%d p75=%d p90=%d" % (
        np.percentile(dl,10),np.percentile(dl,25),np.percentile(dl,50),np.percentile(dl,75),np.percentile(dl,90)))
    # cluster the tallest cluster (likely the callout digits)
    c = collections.Counter((dl//5*5))
    print("  height histogram (bucket:count):", dict(sorted(c.items())))
print()
# Worker math
pxPerPt = W_img / 396.85
print(f"pxPerPt = {W_img}/396.85 = {pxPerPt:.2f}")
for fontPt in (7,9,12):
    s = max(1, 40/(fontPt*pxPerPt))
    print(f"  fontPt={fontPt}: s={s:.3f}  candidate window in NATIVE px = [{36/s:.1f}, {44/s:.1f}]")
