#!/usr/bin/env python3
"""
Fold agent-resolved callouts back into a catalog's ground truth.

Reads groundtruth/<catalog>/queue/<section>.result.json files (written by the
resolver agents) and merges the located callouts into groundtruth.json, tagging
them source='agent'. A section whose every missing callout is resolved (or
confirmed genuinely absent) is promoted to tier 'gold'.

Result file shape (one per queued section):
  { "section": "103-005",
    "callouts": [ {"num":10,"x0":.., "y0":.., "x1":.., "y1":.., "conf":90}, ... ],
    "absent":   [15] }        # missing numbers the agent judged not on the diagram

Coords are in the same 0-10000 space as everything else.

Usage:
    uv run --with pillow python tools/gt-queue-merge.py --catalog-id 996_1998-2005
"""
import sys, json, csv
from pathlib import Path

args = sys.argv[1:]
def opt(n, d=None):
    try:    return args[args.index(n) + 1]
    except (ValueError, IndexError): return d

cat = opt('--catalog-id')
if not cat:
    print("--catalog-id required"); sys.exit(1)

out_dir   = Path(__file__).parent.parent / 'groundtruth' / cat
queue_dir = out_dir / 'queue'
gt_path   = out_dir / 'groundtruth.json'
vision    = json.loads((out_dir / 'vision.json').read_text(encoding='utf-8'))
gt        = json.loads(gt_path.read_text(encoding='utf-8')) if gt_path.exists() else {}
expected  = json.loads((out_dir / 'expected.json').read_text(encoding='utf-8'))
num_to_sid = {r['number']: sid for sid, r in vision.items()}

# ids are string tokens ('2', '2/1') throughout
def natkey(tok):
    return tuple(int(p) for p in str(tok).split('/'))

missing_by_num = {}
for row in csv.DictReader(open(out_dir / 'reconcile.csv', encoding='utf-8')):
    if row['status'] == 'HUMAN' and row['missing']:
        missing_by_num[row['section']] = {x.strip() for x in row['missing'].split(',')}

def iou(a, b):
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, ix1 - ix0) * max(0, iy1 - iy0)
    if not inter:
        return 0.0
    aa = (a[2] - a[0]) * (a[3] - a[1]); bb = (b[2] - b[0]) * (b[3] - b[1])
    return inter / (aa + bb - inter)


_RANK = {'human': 3, 'agent': 2, 'vision': 1}

def dedup_callouts(callouts):
    """Drop overlapping boxes of one glyph, keeping the most trustworthy read
    (human > agent > vision, then confidence). Same-number overlaps merge at IoU>0.3,
    different-number (one glyph read two ways) at IoU>0.5. Real repeats don't overlap."""
    out = []
    for c in sorted(callouts, key=lambda c: (_RANK.get(c.get('source'), 0), c.get('conf', 0)),
                    reverse=True):
        box = [c['x0'], c['y0'], c['x1'], c['y1']]
        if any(iou([o['x0'], o['y0'], o['x1'], o['y1']], box) > (0.3 if o['num'] == c['num'] else 0.5)
               for o in out):
            continue
        out.append(c)
    return out


promoted = partial = 0
for res_file in sorted(queue_dir.glob('*.result.json')):
    res = json.loads(res_file.read_text(encoding='utf-8'))
    num = res['section']
    sid = num_to_sid.get(num)
    if not sid:
        print(f"  {num}: unknown section, skipping"); continue
    exp_missing = missing_by_num.get(num, set())
    exp_set = set(expected.get(sid, []))

    # Seed with Vision's IN-LIST found boxes (the callouts it did get right), tagged
    # source='vision'. HUMAN sections aren't in the silver groundtruth.json, so this
    # must come from vision.json, not from any prior gt entry.
    seed = [{'num': str(d['num']), 'x0': d['x0'], 'y0': d['y0'], 'x1': d['x1'], 'y1': d['y1'],
             'conf': d['conf'], 'source': 'vision'}
            for d in vision[sid]['detections'] if str(d['num']) in exp_set]
    seed_nums = {c['num'] for c in seed}

    resolved = set()
    agent_callouts = []
    for c in res.get('callouts', []):
        cnum = str(c['num']).strip()     # string id token
        cbox = [int(c['x0']), int(c['y0']), int(c['x1']), int(c['y1'])]
        # If this overlaps a seed box of the same number it's the SAME occurrence —
        # keep Vision's. Otherwise it's a DISTINCT repeat the agent found (a callout
        # stamped more than once): add it so multiplicity is preserved.
        if any(s['num'] == cnum and iou([s['x0'], s['y0'], s['x1'], s['y1']], cbox) > 0.3
               for s in seed):
            resolved.add(cnum); continue
        agent_callouts.append({'num': cnum, 'x0': cbox[0], 'y0': cbox[1],
                               'x1': cbox[2], 'y1': cbox[3], 'conf': c.get('conf', 0),
                               'source': 'agent'})
        resolved.add(cnum)
    absent = set(str(x).strip() for x in res.get('absent', []))

    still = exp_missing - resolved - absent
    entry = {'number': num, 'callouts': dedup_callouts(seed + agent_callouts),
             'absent': sorted(absent, key=natkey)}
    if not still:
        entry['tier'] = 'gold'; entry['source'] = 'vision+agent'; promoted += 1
    else:
        entry['tier'] = 'partial'; entry['source'] = 'vision+agent'
        entry['unresolved'] = sorted(still, key=natkey); partial += 1
    gt[sid] = entry

gt_path.write_text(json.dumps(gt, indent=1), encoding='utf-8')
print(f"Merged. Promoted to gold: {promoted}, partial: {partial}")
print(f"  groundtruth.json now has {len(gt)} sections.")
