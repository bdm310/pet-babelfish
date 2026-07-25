#!/usr/bin/env python3
"""
Snap rough callout locations to pixel-tight glyph boxes - deterministically.

An agent only has to say roughly WHERE a number is (grid reading). This tool does
the precision: it binarizes the section's diagram, labels connected components, and
for each rough point returns the tight bounding box of the digit glyph there,
merging horizontally-adjacent components so a two-digit number ("24") returns one
box. Box precision no longer depends on the model, so a cheap model is fine.

Reads the locally-exported groundtruth/<catalog>/catalog.sqlite (fast, offline).
Coordinates in and out are the 0-10000 normalized callout space.

CLI (one section):
    uv run --with pillow --with numpy --with scipy python tools/tighten-box.py \
        --catalog 997-1Turbo-GT2_2007-2009 --section 502-000 --points '{"7":[980,5820]}'
  -> {"7":[926,5790,1040,5950]}

Importable:
    from importlib import import_module
    tighten(catalog, section, {num:[x,y]}) -> {num:[x0,y0,x1,y1] or None}
"""
import sys, json, io, sqlite3
from pathlib import Path

REPO = Path(__file__).parent.parent


def _load_glyphs(catalog, section):
    import numpy as np
    from scipy import ndimage
    from PIL import Image
    db = REPO / 'groundtruth' / catalog / 'catalog.sqlite'
    con = sqlite3.connect(db)
    row = con.execute("SELECT diagram_blob FROM section WHERE number=?", (section,)).fetchone()
    con.close()
    if not row or not row[0]:
        return None
    im = Image.open(io.BytesIO(bytes(row[0]))).convert('L')
    W, H = im.size
    arr = np.array(im)
    ink = arr < 128                                    # black glyphs on white
    lbl, n = ndimage.label(ink)
    slices = ndimage.find_objects(lbl)
    comps = []
    for i, sl in enumerate(slices, 1):
        if sl is None:
            continue
        ys, xs = sl
        h = ys.stop - ys.start; w = xs.stop - xs.start
        # discard components too large (line art / part bodies) or specks
        if h > H * 0.06 or h < H * 0.004 or w > W * 0.06:
            continue
        comps.append({'x0': xs.start, 'y0': ys.start, 'x1': xs.stop, 'y1': ys.stop,
                      'cx': (xs.start + xs.stop) / 2, 'cy': (ys.start + ys.stop) / 2,
                      'h': h, 'w': w})
    return W, H, comps


def tighten(catalog, section, points):
    """points: {num(str): [x,y] in 0-10000}. Returns {num: [x0,y0,x1,y1] 0-10000 or None}."""
    loaded = _load_glyphs(catalog, section)
    if not loaded:
        return {k: None for k in points}
    W, H, comps = loaded
    return {num: snap(W, H, comps, nx, ny) for num, (nx, ny) in points.items()}


def snap(W, H, comps, nx, ny):
    """Snap a single normalized point (0-10000) to the tight box of the glyph there,
    merging horizontally-adjacent same-line components (multi-digit). Returns a
    [x0,y0,x1,y1] box in 0-10000, or None if no glyph is near the point."""
    px, py = nx / 10000 * W, ny / 10000 * H
    near = min(comps, key=lambda c: (c['cx'] - px) ** 2 + (c['cy'] - py) ** 2, default=None) \
        if comps else None
    if near is None:
        return None
    # only accept a component within ~a few glyph-heights of the point
    if ((near['cx'] - px) ** 2 + (near['cy'] - py) ** 2) ** 0.5 > max(near['h'], 20) * 4:
        return None
    gx0, gy0, gx1, gy1 = near['x0'], near['y0'], near['x1'], near['y1']
    gh = near['h']
    changed = True
    while changed:
        changed = False
        for c in comps:
            if c['x1'] <= gx0:
                gap = gx0 - c['x1']
            elif c['x0'] >= gx1:
                gap = c['x0'] - gx1
            else:
                gap = 0
            v_overlap = min(gy1, c['y1']) - max(gy0, c['y0'])
            if gap < gh * 0.6 and v_overlap > gh * 0.3 and abs(c['h'] - gh) < gh * 0.6:
                nx0, ny0 = min(gx0, c['x0']), min(gy0, c['y0'])
                nx1, ny1 = max(gx1, c['x1']), max(gy1, c['y1'])
                if (nx0, ny0, nx1, ny1) != (gx0, gy0, gx1, gy1):
                    gx0, gy0, gx1, gy1 = nx0, ny0, nx1, ny1; changed = True
    return [round(gx0 / W * 10000), round(gy0 / H * 10000),
            round(gx1 / W * 10000), round(gy1 / H * 10000)]


if __name__ == '__main__':
    a = sys.argv[1:]
    def opt(n, d=None):
        try: return a[a.index(n) + 1]
        except (ValueError, IndexError): return d
    catalog = opt('--catalog'); section = opt('--section')
    points = json.loads(opt('--points', '{}'))
    print(json.dumps(tighten(catalog, section, points)))
