#!/usr/bin/env python3
"""
Re-tighten every ground-truth box to the actual glyph bounds - deterministically.

Human review placed boxes roughly; this snaps each one to the true digit box via
the same connected-component tightener used to build the data (tighten-box.snap),
seeded from the box's own centre. It only replaces a box when the snap clearly lands
on the same glyph (guards below), so a mis-snap or a leader-line fusion leaves the
original box untouched. Numbers, source and conf are preserved - only coords change.

Guards (skip, keep original) when the snapped box:
  · is None (no glyph near the centre)
  · overlaps the original at IoU < --iou-min (snap wandered off)
  · is more than --max-grow× the original area (likely fused with a leader line/part)

Dry-run by default: prints stats and writes a before(red)/after(green) montage to
groundtruth/<cat>/_retighten_preview.png. Re-run with --apply to write (backs up
groundtruth.json to groundtruth.json.bak first).

Usage:
    uv run --with pillow --with numpy --with scipy python tools/gt-retighten.py --catalog-id 996_1998-2005
    uv run ... tools/gt-retighten.py --catalog-id 996_1998-2005 --apply
"""
import sys, json, io, sqlite3, importlib.util, random
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
args = sys.argv[1:]
def opt(n, d=None):
    try: return args[args.index(n) + 1]
    except (ValueError, IndexError): return d
def flag(n): return n in args

cat = opt('--catalog-id')
apply = flag('--apply')
IOU_MIN = float(opt('--iou-min', '0.10'))
MAX_GROW = float(opt('--max-grow', '3.0'))
if not cat:
    print("--catalog-id required"); sys.exit(1)

REPO = Path(__file__).parent.parent
out_dir = REPO / 'groundtruth' / cat

# import tighten-box (hyphen → importlib)
spec = importlib.util.spec_from_file_location('tb', Path(__file__).parent / 'tighten-box.py')
tb = importlib.util.module_from_spec(spec); spec.loader.exec_module(tb)

gt = json.loads((out_dir / 'groundtruth.json').read_text('utf-8'))


def iou(a, b):
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, ix1 - ix0) * max(0, iy1 - iy0)
    if not inter: return 0.0
    aa = (a[2]-a[0])*(a[3]-a[1]); bb = (b[2]-b[0])*(b[3]-b[1])
    return inter / (aa + bb - inter)
def area(b): return max(0, b[2]-b[0]) * max(0, b[3]-b[1])

_RANK = {'human': 3, 'agent': 2, 'vision': 1}
def dedup_callouts(callouts):
    """Tightening can snap two boxes for the same glyph (e.g. a 6 and a 9 stacked on
    one digit) onto identical bounds. Drop such overlaps, keeping the most trustworthy
    read (human>agent>vision, then conf); same-number IoU>0.3, different-number >0.5."""
    out = []
    for c in sorted(callouts, key=lambda c: (_RANK.get(c.get('source'), 0), c.get('conf', 0)),
                    reverse=True):
        box = [c['x0'], c['y0'], c['x1'], c['y1']]
        if any(iou([o['x0'], o['y0'], o['x1'], o['y1']], box) > (0.3 if o['num'] == c['num'] else 0.5)
               for o in out):
            continue
        out.append(c)
    return out

n_total = n_changed = n_none = n_lowiou = n_oversize = 0
ious = []
changes = []          # (sid, number, num, orig, new) for montage

for sid, e in gt.items():
    number = e.get('number')
    loaded = tb._load_glyphs(cat, number)
    if not loaded:
        n_total += len(e['callouts']); continue
    W, H, comps = loaded
    for c in e['callouts']:
        n_total += 1
        orig = [c['x0'], c['y0'], c['x1'], c['y1']]
        cx = (c['x0'] + c['x1']) / 2; cy = (c['y0'] + c['y1']) / 2
        new = tb.snap(W, H, comps, cx, cy)
        if new is None:
            n_none += 1; continue
        if iou(new, orig) < IOU_MIN:
            n_lowiou += 1; continue
        if area(new) > MAX_GROW * max(1, area(orig)):
            n_oversize += 1; continue
        if new == orig:
            continue
        n_changed += 1; ious.append(iou(new, orig))
        changes.append((sid, number, c['num'], orig, new))
        c['x0'], c['y0'], c['x1'], c['y1'] = new   # tighten in memory (write gated by --apply)

# collapse any overlaps the tightening produced
n_dedup = 0
for sid, e in gt.items():
    before = len(e['callouts'])
    e['callouts'] = dedup_callouts(e['callouts'])
    n_dedup += before - len(e['callouts'])

# ── montage (before red / after green) ──────────────────────────────────────────
def montage(sample):
    from PIL import Image, ImageDraw
    con = sqlite3.connect(out_dir / 'catalog.sqlite')
    tiles = []
    for sid, number, cnum, orig, new in sample:
        row = con.execute("SELECT diagram_blob FROM section WHERE number=?", (number,)).fetchone()
        if not row or not row[0]: continue
        im = Image.open(io.BytesIO(bytes(row[0]))).convert('RGB'); W, H = im.size
        ux = lambda v: v/10000*W; uy = lambda v: v/10000*H
        u = [min(orig[0], new[0]), min(orig[1], new[1]), max(orig[2], new[2]), max(orig[3], new[3])]
        padx = (u[2]-u[0])*0.6 + 60; pady = (u[3]-u[1])*0.6 + 60
        cx0, cy0 = max(0, ux(u[0])-padx), max(0, uy(u[1])-pady)
        cx1, cy1 = min(W, ux(u[2])+padx), min(H, uy(u[3])+pady)
        crop = im.crop((int(cx0), int(cy0), int(cx1), int(cy1)))
        sc = max(3, int(160 / max(1, crop.height)))
        crop = crop.resize((crop.width*sc, crop.height*sc), Image.NEAREST)
        d = ImageDraw.Draw(crop)
        for box, col in ((orig, (230, 60, 60)), (new, (40, 200, 90))):
            d.rectangle([(ux(box[0])-cx0)*sc, (uy(box[1])-cy0)*sc,
                         (ux(box[2])-cx0)*sc, (uy(box[3])-cy0)*sc], outline=col, width=2)
        tiles.append((f"{number} #{cnum}", crop))
    con.close()
    if not tiles: return None
    from PIL import Image, ImageDraw
    pad = 8; cols = 3
    rows = (len(tiles)+cols-1)//cols
    cw = max(t[1].width for t in tiles)+140; ch = max(t[1].height for t in tiles)+pad
    M = Image.new('RGB', (cw*cols, ch*rows), (255, 255, 255)); dd = ImageDraw.Draw(M)
    for j, (name, crop) in enumerate(tiles):
        x = (j % cols)*cw; y = (j//cols)*ch
        dd.text((x+4, y+crop.height//2), name, fill=(0, 0, 0))
        M.paste(crop, (x+130, y))
    p = out_dir / '_retighten_preview.png'; M.save(p); return p

# ── report ──────────────────────────────────────────────────────────────────────
print(f"=== re-tighten {cat} ===")
print(f"  callouts total        : {n_total}")
print(f"  would change          : {n_changed}" + (" (APPLIED)" if apply else ""))
print(f"  kept - no glyph found : {n_none}")
print(f"  kept - snap off (IoU<{IOU_MIN}) : {n_lowiou}")
print(f"  kept - oversize (>{MAX_GROW}x)   : {n_oversize}")
print(f"  overlaps removed after tighten  : {n_dedup}")
if ious:
    ious.sort()
    print(f"  change IoU: min {ious[0]:.2f}  median {ious[len(ious)//2]:.2f}  "
          f"(lower = bigger correction)")

if apply:
    bak = out_dir / 'groundtruth.json.bak'
    bak.write_text((out_dir / 'groundtruth.json').read_text('utf-8'), 'utf-8')
    (out_dir / 'groundtruth.json').write_text(json.dumps(gt, indent=1), 'utf-8')
    print(f"  backup → {bak.name}   written → groundtruth.json")
else:
    sample = random.Random(1).sample(changes, min(15, len(changes))) if changes else []
    p = montage(sample)
    if p: print(f"\n  preview (red=before, green=after) → {p}")
    print("  dry run - re-run with --apply to write")
