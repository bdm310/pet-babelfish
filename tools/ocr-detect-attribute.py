#!/usr/bin/env python3
"""
Phase 4.5 miss-attribution. Reads a dump from ocr-detect-dump.py + groundtruth.json
and classifies EVERY GT callout box into one of:
  TP  - detected (box IoU>=0.3) AND number correct
  D   - recognition miss: box found (IoU>=0.3) but number wrong
  A   - candidate-gen miss: NO findBlobs candidate intersects the GT box
  B   - CNN-gate miss: a candidate intersects but every intersecting candidate scored prob<thr
  C   - grouping miss: >=1 intersecting candidate ACCEPTED, but no emitted callout box matches at IoU>=0.3

Usage:
    uv run python tools/ocr-detect-attribute.py --catalog-id 996_1998-2005 --dump dump-996.json
"""
import sys, json
from pathlib import Path

args = sys.argv[1:]
def opt(n, d=None):
    try: return args[args.index(n)+1]
    except (ValueError, IndexError): return d

cat = opt('--catalog-id'); dump_path = opt('--dump')
IOU_THR = float(opt('--iou', '0.3'))
root = Path(__file__).parent.parent
gt = json.loads((root / 'groundtruth' / cat / 'groundtruth.json').read_text(encoding='utf-8'))
dump = json.loads(Path(dump_path).read_text(encoding='utf-8'))

def iou(a, b):
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0, ix1 - ix0), max(0, iy1 - iy0)
    inter = iw * ih
    if inter == 0: return 0.0
    aa = (a[2]-a[0])*(a[3]-a[1]); bb = (b[2]-b[0])*(b[3]-b[1])
    return inter / (aa + bb - inter)

def intersects(a, b):
    return max(0, min(a[2],b[2])-max(a[0],b[0])) > 0 and max(0, min(a[3],b[3])-max(a[1],b[1])) > 0

def greedy(gt_boxes, pred, require_num):
    """Return set of matched gt indices and dict gi->pi."""
    pairs = []
    for gi, g in enumerate(gt_boxes):
        for pi, p in enumerate(pred):
            if require_num and int(g['num']) != _num(p['number']):
                continue
            v = iou(g['box'], p['box'])
            if v >= IOU_THR:
                pairs.append((v, gi, pi))
    pairs.sort(reverse=True)
    gused, pused, m = set(), set(), {}
    for v, gi, pi in pairs:
        if gi in gused or pi in pused: continue
        gused.add(gi); pused.add(pi); m[gi] = pi
    return gused, pused

def _num(s):
    s = str(s).strip().strip('()')
    return int(s) if s.lstrip('-').isdigit() else -999999

counts = dict(TP=0, D=0, A=0, B=0, C=0, NODBG=0)
c_examples = []   # (section_num, sid, detail)
b_examples = []
a_examples = []
d_examples = []

for sid, meta in gt.items():
    gt_boxes = [{'num': c['num'], 'box': [c['x0'], c['y0'], c['x1'], c['y1']]}
                for c in meta['callouts']]
    dbg = dump.get(sid)
    if dbg is None:
        counts['NODBG'] += len(gt_boxes); continue
    callouts = dbg['callouts']
    cands = dbg['candidates']

    num_matched, _ = greedy(gt_boxes, callouts, require_num=True)
    det_matched, _ = greedy(gt_boxes, callouts, require_num=False)

    sec_c = []
    for gi, g in enumerate(gt_boxes):
        if gi in num_matched:
            counts['TP'] += 1; continue
        if gi in det_matched:
            counts['D'] += 1
            # find the mismatched callout
            best = max(callouts, key=lambda p: iou(g['box'], p['box']))
            d_examples.append((meta['number'], sid, f"GT {g['num']} read as {best['number']}"))
            continue
        # detection miss -> A/B/C
        inter_cands = [c for c in cands if intersects(c['box'], g['box'])]
        if not inter_cands:
            counts['A'] += 1
            a_examples.append((meta['number'], sid, f"GT {g['num']} box {g['box']} no candidate"))
            continue
        acc = [c for c in inter_cands if c['accepted']]
        if not acc:
            counts['B'] += 1
            mx = max(inter_cands, key=lambda c: c['prob'])
            b_examples.append((meta['number'], sid, f"GT {g['num']}: {len(inter_cands)} cand, max prob {mx['prob']}"))
            continue
        counts['C'] += 1
        # what got emitted near this GT?
        near = [p for p in callouts if intersects(p['box'], g['box'])]
        sec_c.append(f"GT {g['num']} @ {g['box']}: {len(acc)} accepted cand intersect; "
                     f"emitted nearby={[(p['number'], round(iou(g['box'],p['box']),2)) for p in near]}")
    if sec_c:
        c_examples.append((meta['number'], sid, sec_c))

total = sum(v for k, v in counts.items() if k != 'NODBG')
print(f"=== {cat}  (IoU>={IOU_THR}, {total} GT boxes) ===")
for k in ['TP', 'D', 'A', 'B', 'C', 'NODBG']:
    print(f"  {k:5} {counts[k]:5}")
det_miss = counts['A'] + counts['B'] + counts['C']
print(f"  detection misses (A+B+C) = {det_miss}")
if det_miss:
    dom = max([('A', counts['A']), ('B', counts['B']), ('C', counts['C'])], key=lambda x: x[1])
    print(f"  dominant det-miss cause: {dom[0]} ({dom[1]}/{det_miss} = {dom[1]/det_miss:.0%})")

def dump_ex(name, ex, n=6):
    print(f"\n-- {name} examples ({len(ex)}) --")
    for num, sid, detail in ex[:n]:
        if isinstance(detail, list):
            print(f"  section {num} (sid {sid}):")
            for d in detail[:4]: print(f"      {d}")
        else:
            print(f"  section {num} (sid {sid}): {detail}")

dump_ex("C (grouping)", c_examples)
dump_ex("B (CNN gate)", b_examples)
dump_ex("A (candidate-gen)", a_examples)
dump_ex("D (recognition)", d_examples)
