#!/usr/bin/env python3
"""
Re-OCR every ground-truth box and flag boxes whose read digit disagrees with the
stored number - a check for mislabeled callouts, now that the boxes are tight.

Uses the system Tesseract 5.4 with the shipping `porsche` model (docs/tessdata),
so it is the same OCR the pipeline uses, independent of how each box was labeled
(Vision / agent / human). Each tight box is cropped, padded, upscaled and read;
the read is compared to the stored num.

Outputs (groundtruth/<cat>/):
  ocr_flags.json          per-section flags {cx,cy,gt,ocr,conf,kind} for the editor
  _ocrverify_preview.png  montage of mismatches (labelled GT vs OCR) for quick review
  ocr_flags.csv           section,num,ocr,conf,kind

kind = 'mismatch' (read a different number) or 'unread' (read nothing / low conf).

Usage:
    uv run --with pytesseract --with pillow python tools/gt-ocr-verify.py --catalog-id 996_1998-2005
    uv run ... tools/gt-ocr-verify.py --catalog-id 996_1998-2005 --limit 20      # test slice
    uv run ... tools/gt-ocr-verify.py --catalog-id 996_1998-2005 --min-conf 60   # flag threshold
"""
import sys, os, json, io, sqlite3, csv
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
args = sys.argv[1:]
def opt(n, d=None):
    try: return args[args.index(n) + 1]
    except (ValueError, IndexError): return d

cat = opt('--catalog-id')
limit = int(opt('--limit', '0'))
MIN_CONF = int(opt('--min-conf', '55'))     # a mismatch read must be at least this confident
if not cat:
    print("--catalog-id required"); sys.exit(1)

REPO = Path(__file__).parent.parent
out_dir = REPO / 'groundtruth' / cat
TESS_EXE = r'C:\Program Files\Tesseract-OCR\tesseract.exe'
TESSDATA = str(REPO / 'docs' / 'tessdata')      # holds porsche.traineddata

import pytesseract
from pytesseract import Output
from PIL import Image
pytesseract.pytesseract.tesseract_cmd = TESS_EXE
os.environ['TESSDATA_PREFIX'] = TESSDATA          # dir holding porsche.traineddata
# Read every box under TWO page-seg modes and accept if EITHER matches: PSM 8 (single
# word) reads lone digits well but collapses adjacent "1"s ("11"->"1"); PSM 6 (block)
# reads "11" right but occasionally misreads a single digit. Together they cover each
# other's blind spots, so a box only flags when BOTH disagree with the label.
WL = '-c tessedit_char_whitelist=0123456789'
CFG6 = f'--psm 6 {WL}'
CFG8 = f'--psm 8 {WL}'

gt = json.loads((out_dir / 'groundtruth.json').read_text('utf-8'))


def read_box(im, box, W, H):
    """OCR one tight box (0-10000). Returns (text, conf)."""
    # Crop EXACTLY the box (only 2px to avoid clipping the glyph edge - never a
    # percentage pad that would reach a neighbouring callout), upscale, then centre it
    # on a white canvas with a wide margin. Tesseract sees the box's own contents, big,
    # isolated and cleanly bordered - so a tight box can never be the reason it misreads.
    # Any disagreement then means the box's pixels really are that (wrong) number.
    x0, y0, x1, y1 = (int(box[0]/10000*W), int(box[1]/10000*H),
                      int(box[2]/10000*W), int(box[3]/10000*H))
    p = 2
    crop = im.crop((max(0, x0-p), max(0, y0-p), min(W, x1+p), min(H, y1+p)))
    if crop.width < 3 or crop.height < 3:
        return '', 0
    sc = max(2, round(60 / max(1, y1-y0)))
    crop = crop.resize((crop.width*sc, crop.height*sc), Image.LANCZOS).convert('L')
    m = 45
    canvas = Image.new('L', (crop.width + 2*m, crop.height + 2*m), 255)
    canvas.paste(crop, (m, m))
    canvas = canvas.point(lambda v: 0 if v < 128 else 255, 'L')
    return [_best(pytesseract.image_to_data(canvas, lang='porsche', config=cfg, output_type=Output.DICT))
            for cfg in (CFG6, CFG8)]


def _best(d):
    best, bestc = '', -1
    for t, c in zip(d['text'], d['conf']):
        t = t.strip()
        try: c = float(c)
        except: c = -1
        if t and c > bestc:
            best, bestc = t, c
    return best, int(bestc if bestc >= 0 else 0)


con = sqlite3.connect(out_dir / 'catalog.sqlite')
items = list(gt.items())
if limit: items = items[:limit]

flags = {}                # sid -> [{cx,cy,gt,ocr,conf,kind}]  - ALL surfaced for review
n_boxes = n_mismatch = n_partial = n_unread = n_ok = 0
for k, (sid, e) in enumerate(items, 1):
    row = con.execute("SELECT diagram_blob FROM section WHERE number=?", (e['number'],)).fetchone()
    if not row or not row[0]:
        continue
    im = Image.open(io.BytesIO(bytes(row[0]))).convert('L'); W, H = im.size
    for c in e['callouts']:
        n_boxes += 1
        box = [c['x0'], c['y0'], c['x1'], c['y1']]
        reads = read_box(im, box, W, H)          # [(psm6 text,conf), (psm8 text,conf)]
        gtn = str(c['num'])
        if gtn in [t for t, _ in reads]:         # either reader agreeing is enough
            n_ok += 1; continue
        read, conf = max(reads, key=lambda tc: tc[1], default=('', 0))
        # Any disagreement is surfaced - with a clean isolated crop the box can't be
        # blamed. kind just describes HOW it differs: a wrong digit (mismatch), a wrong
        # digit count i.e. the box likely bounds too few/many digits (partial), or
        # unreadable even isolated (unread - a hard glyph or a badly-placed box).
        if read == '' or conf < MIN_CONF:
            kind = 'unread'; n_unread += 1
        elif read != gtn and (read in gtn or gtn in read):
            kind = 'partial'; n_partial += 1
        else:
            kind = 'mismatch'; n_mismatch += 1
        flags.setdefault(sid, []).append({
            'cx': (c['x0']+c['x1'])//2, 'cy': (c['y0']+c['y1'])//2,
            'gt': c['num'], 'ocr': read, 'conf': conf, 'kind': kind})
    if k % 25 == 0:
        print(f"  {k}/{len(items)} sections… ({n_mismatch} mismatch, {n_partial} partial, {n_unread} unread)")

# ── montage of flags (mismatch first, then partial, then unread) ─────────────────
def montage():
    from PIL import ImageDraw
    order = {'mismatch': 0, 'partial': 1, 'unread': 2}
    sample = sorted(((sid, f) for sid, fl in flags.items() for f in fl),
                    key=lambda x: order.get(x[1]['kind'], 3))[:24]
    if not sample:
        return None
    tiles = []
    for sid, f in sample:
        row = con.execute("SELECT diagram_blob FROM section WHERE number=?", (gt[sid]['number'],)).fetchone()
        im = Image.open(io.BytesIO(bytes(row[0]))).convert('RGB'); W, H = im.size
        px, py = f['cx']/10000*W, f['cy']/10000*H
        r = 46
        crop = im.crop((int(max(0, px-r)), int(max(0, py-r)), int(min(W, px+r)), int(min(H, py+r))))
        crop = crop.resize((crop.width*3, crop.height*3), Image.LANCZOS)
        tiles.append((f"{gt[sid]['number']} {f['kind'][:4]} GT:{f['gt']} OCR:{f['ocr'] or '-'}", crop))
    cols = 4; cw = max(t[1].width for t in tiles)+8; ch = max(t[1].height for t in tiles)+20
    rows = (len(tiles)+cols-1)//cols
    M = Image.new('RGB', (cw*cols, ch*rows), (255, 255, 255)); dd = ImageDraw.Draw(M)
    for j, (name, crop) in enumerate(tiles):
        x = (j % cols)*cw; y = (j//cols)*ch
        M.paste(crop, (x+4, y+16)); dd.text((x+4, y+3), name, fill=(200, 0, 0))
    p = out_dir / '_ocrverify_preview.png'; M.save(p); return p

p = montage()
con.close()
(out_dir / 'ocr_flags.json').write_text(json.dumps(flags, indent=1), 'utf-8')
with open(out_dir / 'ocr_flags.csv', 'w', newline='', encoding='utf-8') as fp:
    w = csv.writer(fp); w.writerow(['section', 'gt', 'ocr', 'conf', 'kind'])
    for sid, fl in flags.items():
        for f in fl:
            w.writerow([gt[sid]['number'], f['gt'], f['ocr'], f['conf'], f['kind']])

n_flag = n_mismatch + n_partial + n_unread
print(f"\n=== OCR verify {cat} ===")
print(f"  boxes read     : {n_boxes}")
print(f"  agree with GT  : {n_ok}  ({100*n_ok//max(1,n_boxes)}%)")
print(f"  FLAGGED for review: {n_flag} in {len(flags)} sections")
print(f"    mismatch (wrong digit)        : {n_mismatch}")
print(f"    partial  (wrong digit count)  : {n_partial}")
print(f"    unread   (unreadable isolated): {n_unread}")
print(f"  → ocr_flags.json, ocr_flags.csv" + (f", {p.name}" if p else ""))
