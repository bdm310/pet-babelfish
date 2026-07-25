"""Phase 1: build a labeled training-patch dataset from diagram-callout ground truth.

Decodes each section's CCITT diagram, generates candidate connected-component blobs,
labels each against GT callout boxes, crops 48x48 context patches, and writes them
plus a manifest, report, and sample renders under ocr/dataset/.

Builds patches for every GOLD catalog and stores each patch's catalog + section so the
trainer can assign train/val/test splits at train time (leave-one-catalog-out or final
all-catalog). This script does NOT bake in a split.

    uv run --with numpy --with scipy --with opencv-python-headless --with pillow \
        python ocr/dataset.py [--catalog-id X] [--limit N]
"""
import sys, json, sqlite3, argparse
from pathlib import Path
import numpy as np
import cv2
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).parent))
from ccitt_decode import decode

REPO = Path(__file__).parent.parent
GT_DIR = REPO / 'groundtruth'
OUT = Path(__file__).parent / 'dataset'


def catalog_db(cat):
    """The diagram-bearing SQLite for a gold catalog. Prefers the local GT-dir copy;
    falls back to the shipped bundled catalog (docs/catalogs/<id>.sqlite), which is the
    committed canonical source since the GT-dir copies are gitignored."""
    gt = GT_DIR / cat / 'catalog.sqlite'
    return gt if gt.exists() else REPO / 'docs' / 'catalogs' / f'{cat}.sqlite'


# The 5 hand-verified GOLD catalogs we train on. Cayenne-955(E1)_2003-2006 is
# deliberately held out as a downstream seed target.
CATALOGS = ['996_1998-2005', '997-1Turbo-GT2_2007-2009',
            '356_356A_1950-1959', 'Boxster(987-1)_2005-2008',
            '911Turbo_1975-1977']
PATCH = 48
CTX = 2.75          # window side = CTX * max(bbox_w, bbox_h)


def candidates(img):
    """Permissive connected-component blobs. Returns list of (x0,y0,x1,y1) native px."""
    H, W = img.shape
    lbl, n = ndimage.label(img)
    out = []
    for sl in ndimage.find_objects(lbl):
        if sl is None:
            continue
        ys, xs = sl
        h = ys.stop - ys.start; w = xs.stop - xs.start
        area = int((lbl[sl] > 0).sum())
        if h < 8:                                   # too short to be a digit
            continue
        if h > 0.06 * H or w > 0.06 * W:            # part outlines / borders
            continue
        if area < 12:                               # specks
            continue
        out.append((xs.start, ys.start, xs.stop, ys.stop))
    return out


def gt_boxes_px(entry, W, H):
    """GT callout boxes -> list of (num, x0,y0,x1,y1) in native px."""
    res = []
    for co in entry['callouts']:
        x0 = co['x0'] / 10000 * W; x1 = co['x1'] / 10000 * W
        y0 = co['y0'] / 10000 * H; y1 = co['y1'] / 10000 * H
        res.append((co['num'], x0, y0, x1, y1))
    return res


def contained_frac(cc, gt):
    """Area of cc∩gt / area of cc."""
    ix0 = max(cc[0], gt[1]); iy0 = max(cc[1], gt[2])
    ix1 = min(cc[2], gt[3]); iy1 = min(cc[3], gt[4])
    iw = max(0.0, ix1 - ix0); ih = max(0.0, iy1 - iy0)
    ca = max(1e-9, (cc[2] - cc[0]) * (cc[3] - cc[1]))
    return (iw * ih) / ca


def is_compound(num):
    """A compound callout ('2/1') whose box bounds digits AND a '/' slash."""
    return '/' in str(num)


def compound_digit_boxes(img, g):
    """DIGIT-component bboxes inside a compound GT box, in native px.

    Connected-components the ink in the box and aligns them left-to-right to the
    number's characters (same method as ocr/harvest_compound.py). Returns the boxes
    of the DIGIT chars only - the '/' stroke is excluded so it stays an ignore region
    (an isolated slash is indistinguishable from a '1', so teaching the gate to accept
    it would cost precision). Returns [] when the component count doesn't match the
    char count (fused/broken glyphs), leaving the whole box as ignore - never guess.
    """
    num, gx0, gy0, gx1, gy1 = g
    chars = str(num)
    x0, y0 = max(0, int(gx0)), max(0, int(gy0))
    x1, y1 = int(np.ceil(gx1)), int(np.ceil(gy1))
    sub = img[y0:y1, x0:x1]
    if sub.size == 0:
        return []
    lbl, _ = ndimage.label(sub)
    boxH = y1 - y0
    comps = []
    for sl in ndimage.find_objects(lbl):
        if sl is None:
            continue
        ys, xs = sl
        h = ys.stop - ys.start; w = xs.stop - xs.start
        if h < 0.45 * boxH or w < 3:                # a real glyph, not dust
            continue
        comps.append((xs.start, (x0 + xs.start, y0 + ys.start, x0 + xs.stop, y0 + ys.stop)))
    comps.sort()
    if len(comps) != len(chars):
        return []
    return [bb for (_, bb), ch in zip(comps, chars) if ch != '/']


def center_in(cc, g):
    """cc center lies inside GT box g=(num,x0,y0,x1,y1)."""
    cx = (cc[0] + cc[2]) / 2; cy = (cc[1] + cc[3]) / 2
    return g[1] <= cx <= g[3] and g[2] <= cy <= g[4]


def label_cc(cc, gts):
    """Positive if cc center in some GT box AND >=60% area-contained in it."""
    cx = (cc[0] + cc[2]) / 2; cy = (cc[1] + cc[3]) / 2
    best = None
    for g in gts:
        _, gx0, gy0, gx1, gy1 = g
        if gx0 <= cx <= gx1 and gy0 <= cy <= gy1 and contained_frac(cc, g) >= 0.60:
            f = contained_frac(cc, g)
            if best is None or f > best[1]:
                best = (g, f)
    return best[0] if best else None


def crop_patch(gray, bbox):
    """Square window centered on bbox center, side=CTX*max(w,h), white-padded, 48x48."""
    H, W = gray.shape
    x0, y0, x1, y1 = bbox
    cx = (x0 + x1) / 2; cy = (y0 + y1) / 2
    side = CTX * max(x1 - x0, y1 - y0)
    half = side / 2
    wx0 = int(round(cx - half)); wy0 = int(round(cy - half))
    wx1 = int(round(cx + half)); wy1 = int(round(cy + half))
    win = np.full((wy1 - wy0, wx1 - wx0), 255, np.uint8)   # white pad
    sx0 = max(wx0, 0); sy0 = max(wy0, 0)
    sx1 = min(wx1, W); sy1 = min(wy1, H)
    if sx1 > sx0 and sy1 > sy0:
        win[sy0 - wy0:sy1 - wy0, sx0 - wx0:sx1 - wx0] = gray[sy0:sy1, sx0:sx1]
    return cv2.resize(win, (PATCH, PATCH), interpolation=cv2.INTER_AREA)


def build_catalog(cat, limit):
    db = catalog_db(cat)
    gt = json.loads((GT_DIR / cat / 'groundtruth.json').read_text())
    con = sqlite3.connect(db)
    rows = []             # (patch, label, source, gt_num, section_number, rowid, bbox)
    stats = dict(sections=0, candidates=0, pos_cc=0, pos_gt=0, neg=0, dropped=0,
                 gt_boxes=0, gt_boxes_noncomp=0, gt_boxes_compound=0, gt_unmatched=0,
                 pos_comp_cc=0, pos_comp_gt=0, comp_digit_boxes=0, comp_digit_unmatched=0)
    items = list(gt.items())
    if limit:
        items = items[:limit]
    for rowid, entry in items:
        r = con.execute("SELECT diagram_blob,diagram_w,diagram_h FROM section WHERE id=?",
                        (int(rowid),)).fetchone()
        if not r or not r[0]:
            continue
        blob, W, H = bytes(r[0]), r[1], r[2]
        img = decode(blob, W, H)                       # 0/1 ink
        gray = ((1 - img) * 255).astype(np.uint8)      # white=255, ink=0
        num = entry['number']
        stats['sections'] += 1
        gts = gt_boxes_px(entry, W, H)
        # Split GT boxes: compound ('2/1') boxes are IGNORE regions, not positives.
        gts_noncomp = [g for g in gts if not is_compound(g[0])]
        gts_comp = [g for g in gts if is_compound(g[0])]
        stats['gt_boxes'] += len(gts)
        stats['gt_boxes_noncomp'] += len(gts_noncomp)
        stats['gt_boxes_compound'] += len(gts_comp)
        # A compound box's DIGIT glyphs are real callout digits → positives; only its
        # '/' stroke stays ignore. Aligned per box (empty when the glyphs fuse). Kept
        # as pseudo-GT boxes ('D') so label_cc handles them exactly like non-compound.
        comp_digit = []
        for gc in gts_comp:
            comp_digit += [('D', *bb) for bb in compound_digit_boxes(img, gc)]
        stats['comp_digit_boxes'] += len(comp_digit)
        ccs = candidates(img)
        stats['candidates'] += len(ccs)
        matched_gt = set()
        matched_cd = set()
        for cc in ccs:
            g = label_cc(cc, gts_noncomp)              # positive vs non-compound
            if g is not None:
                matched_gt.add((g[0], round(g[1]), round(g[2])))
                stats['pos_cc'] += 1
                rows.append((crop_patch(gray, cc), 1, 'cc', g[0], num, int(rowid),
                             [cc[0], cc[1], cc[2], cc[3]]))
                continue
            cd = label_cc(cc, comp_digit)              # a compound-callout digit?
            if cd is not None:
                matched_cd.add((round(cd[1]), round(cd[2])))
                stats['pos_comp_cc'] += 1
                rows.append((crop_patch(gray, cc), 1, 'cc', 'D', num, int(rowid),
                             [cc[0], cc[1], cc[2], cc[3]]))
            elif any(center_in(cc, gc) for gc in gts_comp):
                # inside a compound box but not a clean digit (the '/' stroke, or a
                # fused piece): DROP so it pollutes neither class.
                stats['dropped'] += 1
            else:
                stats['neg'] += 1
                rows.append((crop_patch(gray, cc), 0, 'cc', None, num, int(rowid),
                             [cc[0], cc[1], cc[2], cc[3]]))
        # positives safety net: one patch per NON-compound GT box, plus one per
        # compound DIGIT box, plus candidate-recall accounting for both.
        for g in gts_noncomp:
            gnum, gx0, gy0, gx1, gy1 = g
            key = (gnum, round(gx0), round(gy0))
            if key not in matched_gt:
                stats['gt_unmatched'] += 1
            bb = [int(gx0), int(gy0), int(np.ceil(gx1)), int(np.ceil(gy1))]
            stats['pos_gt'] += 1
            rows.append((crop_patch(gray, (gx0, gy0, gx1, gy1)), 1, 'gt', gnum, num,
                         int(rowid), bb))
        for _, dx0, dy0, dx1, dy1 in comp_digit:
            if (round(dx0), round(dy0)) not in matched_cd:
                stats['comp_digit_unmatched'] += 1
            bb = [int(dx0), int(dy0), int(np.ceil(dx1)), int(np.ceil(dy1))]
            stats['pos_comp_gt'] += 1
            rows.append((crop_patch(gray, (dx0, dy0, dx1, dy1)), 1, 'gt', 'D', num,
                         int(rowid), bb))
    con.close()
    return rows, stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--catalog-id')
    ap.add_argument('--limit', type=int, default=0)
    args = ap.parse_args()
    cats = [args.catalog_id] if args.catalog_id else CATALOGS

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'samples').mkdir(exist_ok=True)

    all_rows = []; all_stats = {}
    for cat in cats:
        gt = json.loads((GT_DIR / cat / 'groundtruth.json').read_text())
        rows, stats = build_catalog(cat, args.limit)
        all_stats[cat] = stats
        for row in rows:
            all_rows.append((cat,) + row)
        render_samples(cat, gt, args.limit)

    write_outputs(all_rows, all_stats, cats)


def render_samples(cat, gt, limit, n=3):
    """Render a few diagrams with candidate + GT boxes drawn."""
    from PIL import Image, ImageDraw
    db = catalog_db(cat)
    con = sqlite3.connect(db)
    items = list(gt.items())
    if limit:
        items = items[:limit]
    # pick sections with a decent number of callouts
    items = sorted(items, key=lambda kv: -len(kv[1]['callouts']))[:n]
    for rowid, entry in items:
        r = con.execute("SELECT diagram_blob,diagram_w,diagram_h FROM section WHERE id=?",
                        (int(rowid),)).fetchone()
        if not r or not r[0]:
            continue
        blob, W, H = bytes(r[0]), r[1], r[2]
        img = decode(blob, W, H)
        rgb = np.stack([((1 - img) * 255).astype(np.uint8)] * 3, axis=-1)
        pim = Image.fromarray(rgb)
        dr = ImageDraw.Draw(pim)
        gts = gt_boxes_px(entry, W, H)
        gts_noncomp = [g for g in gts if not is_compound(g[0])]
        gts_comp = [g for g in gts if is_compound(g[0])]
        comp_digit = []
        for gc in gts_comp:
            comp_digit += [('D', *bb) for bb in compound_digit_boxes(img, gc)]
        for cc in candidates(img):
            g = label_cc(cc, gts_noncomp)
            if g is not None:
                color = (0, 170, 0)          # positive (non-compound)
            elif label_cc(cc, comp_digit) is not None:
                color = (0, 200, 200)        # positive (compound digit)
            elif any(center_in(cc, gc) for gc in gts_comp):
                color = (255, 165, 0)        # ignored (slash / fused inside compound box)
            else:
                color = (220, 0, 0)          # negative
            dr.rectangle([cc[0], cc[1], cc[2] - 1, cc[3] - 1], outline=color, width=2)
        for g in gts_noncomp:
            dr.rectangle([g[1], g[2], g[3], g[4]], outline=(0, 90, 255), width=1)
        for g in gts_comp:                    # compound ignore boxes in magenta
            dr.rectangle([g[1], g[2], g[3], g[4]], outline=(200, 0, 200), width=2)
        pim.save(OUT / 'samples' / f"{cat}_{entry['number']}.png")
    con.close()


def write_outputs(all_rows, all_stats, cats):
    patches = np.stack([r[1] for r in all_rows]).astype(np.uint8)
    labels = np.array([r[2] for r in all_rows], np.uint8)
    sources = np.array([r[3] for r in all_rows])
    catalogs = np.array([r[0] for r in all_rows])
    sections = np.array([r[6] for r in all_rows], np.int64)   # section rowid
    np.savez_compressed(OUT / 'patches.npz', patches=patches, label=labels,
                        source=sources, catalog=catalogs, section=sections)
    with open(OUT / 'manifest.jsonl', 'w') as f:
        for cat, patch, label, source, gt_num, sec_num, rowid, bbox in all_rows:
            f.write(json.dumps({'catalog': cat, 'section_number': sec_num,
                                'section_rowid': rowid, 'bbox': bbox, 'label': int(label),
                                'gt_num': gt_num, 'source': source}) + '\n')
    write_report(all_stats, catalogs, labels, sources, cats)
    print(f"Wrote {len(all_rows)} patches to {OUT}")


def write_report(all_stats, catalogs, labels, sources, cats):
    lines = ["# Phase 1 dataset - callout patch training set (5 GOLD catalogs)", ""]
    lines.append("Patches built for every gold catalog; the trainer assigns train/val/test "
                 "at train time (this file bakes in no split).")
    lines.append("Compound callouts ('2/1') are IGNORE regions: no positive patch, and CC "
                 "candidates overlapping only a compound box are dropped (neither class).")
    lines.append("")
    for cat in cats:
        s = all_stats[cat]
        gtb = s['gt_boxes_noncomp'] or 1
        recall = (gtb - s['gt_unmatched']) / gtb
        tot = s['pos_cc'] + s['neg']
        cdb = s['comp_digit_boxes'] or 1
        crecall = (s['comp_digit_boxes'] - s['comp_digit_unmatched']) / cdb
        lines += [f"## {cat}", "",
                  f"- sections processed: {s['sections']}",
                  f"- candidate CC blobs: {s['candidates']}",
                  f"- positives (cc): {s['pos_cc']}   positives (gt safety-net): {s['pos_gt']}",
                  f"- compound-digit positives: cc {s['pos_comp_cc']}, gt {s['pos_comp_gt']} "
                  f"(from {s['comp_digit_boxes']} digit boxes across {s['gt_boxes_compound']} compound boxes)",
                  f"- negatives: {s['neg']}   dropped (compound slash/fused): {s['dropped']}",
                  f"- CC class balance: {s['pos_cc']}/{tot} positive = {s['pos_cc']/max(1,tot):.3f}",
                  f"- GT boxes: {s['gt_boxes']} (non-compound {s['gt_boxes_noncomp']}, "
                  f"compound {s['gt_boxes_compound']})",
                  f"- non-compound GT boxes with NO matching CC: {s['gt_unmatched']}",
                  f"- **candidate-recall (non-compound GT boxes hit by a CC): {recall:.4f}**",
                  f"- **compound-digit candidate-recall: {crecall:.4f}** "
                  f"({s['comp_digit_boxes'] - s['comp_digit_unmatched']}/{s['comp_digit_boxes']})", ""]
    lines += ["## Totals (all patches, cc+gt)", ""]
    for cat in cats:
        m = catalogs == cat
        pos = int(labels[m].sum()); n = int(m.sum())
        cc = int((sources[m] == 'cc').sum()); g = int((sources[m] == 'gt').sum())
        lines.append(f"- {cat}: {n} patches, {pos} pos ({pos/n:.3f}), {n-pos} neg; source cc={cc} gt={g}")
    n = len(labels); pos = int(labels.sum())
    lines.append(f"- **ALL: {n} patches, {pos} pos ({pos/n:.3f}), {n-pos} neg**")
    lines += ["", "## Notes",
              "- Labeling: CC positive iff its center lies in a GT box AND >=60% of its area "
              "is inside that box; else negative.",
              "- GT safety-net rows (source=gt) guarantee every callout box is represented "
              "even when no CC matched (fused leader / thin '1').",
              "- candidate-recall < 1.0 is the ceiling for a CC-candidate-only detector; the "
              "gt-sourced positives let Phase 2 measure and weight around it."]
    (OUT / 'REPORT.md').write_text("\n".join(lines), encoding='utf-8')


if __name__ == '__main__':
    main()
