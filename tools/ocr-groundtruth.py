#!/usr/bin/env python3
"""
Build a ground-truth callout dataset for a catalog using Google Cloud Vision.

Vision is the strong, no-budget labeler; the parts list is the completeness
oracle. For every section that has a diagram, we OCR the *same* WebP the shipping
Tesseract pipeline saw (section.diagram_blob) and normalize Vision's pixel boxes
into the identical 0-10000 space the `callout` table uses. We then reconcile the
detected number-set against the parts-list expected-set (parenthesized positions)
and split sections into:

  MATCH     detected set == expected set  -> silver ground truth (auto-accepted)
  DISAGREE  missing / extra               -> human-verify queue (gold)
  NO-EXPECT diagram with no (n) positions -> detections saved, not reconciled

Outputs (groundtruth/<catalog-id>/):
  vision.json     raw Vision detections per section {num,x0,y0,x1,y1,conf}
  reconcile.csv   per-section expected/detected/missing/extra/status
  queue.txt       section numbers needing human verification
  summary printed to stdout

Coordinate space matches `callout`: x/y are round(px / imgDim * 10000).

Usage:
    uv run --with google-cloud-vision --with pillow --with playwright \
        python tools/ocr-groundtruth.py --catalog-id 997tt
    # list available catalogs:
    uv run --with playwright python tools/ocr-groundtruth.py
    # test on the first 20 diagrams:
    uv run ... python tools/ocr-groundtruth.py --catalog-id 996 --limit 20
"""
import sys, subprocess, time, urllib.request, base64, sqlite3, tempfile, os, io, json, re, csv
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
args = sys.argv[1:]


def opt(n, default=None):
    try:
        return args[args.index(n) + 1]
    except (ValueError, IndexError):
        return default


def flag(n):
    return n in args


filter_catalog = opt('--catalog-id')
port     = int(opt('--port', '8080'))
limit    = int(opt('--limit', '0'))          # 0 = all
no_cache = flag('--no-cache')
key_path = Path(opt('--key', str(Path(__file__).parent.parent / 'norse-feat-132423-0ce838834bcb.json')))

repo_dir    = Path(__file__).parent.parent
docs_dir    = repo_dir / 'docs'
profile_dir = Path(__file__).parent / '.playwright-profile'
profile_dir.mkdir(exist_ok=True)
out_root    = repo_dir / 'groundtruth'

NUM_RE = re.compile(r'^\(?(\d{1,3})\)?$')

def natkey(tok):
    # natural sort: leading int then sub-int, so '2' < '2/1' < '10'
    return tuple(int(p) for p in str(tok).split('/'))


# ── HTTP server (reused from the other tools) ──────────────────────────────────

def _server_up(p):
    try:
        urllib.request.urlopen(f'http://localhost:{p}/', timeout=0.5)
        return True
    except Exception:
        return False


def start_server(docs_dir, port):
    if _server_up(port):
        print(f"Server already running on :{port}, reusing it.")
        return None
    proc = subprocess.Popen(
        ['python', '-m', 'http.server', str(port), '--directory', str(docs_dir)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(40):
        if _server_up(port):
            return proc
        time.sleep(0.25)
    proc.terminate()
    raise RuntimeError(f"HTTP server failed on :{port}")


def load_catalog_sqlite(page, cat_id):
    """Pull <cat_id>/catalog.sqlite out of OPFS into a temp file, return its path."""
    b64 = page.evaluate("""async (id) => {
        try {
            const root = await navigator.storage.getDirectory();
            const dir  = await root.getDirectoryHandle(id);
            const fh   = await dir.getFileHandle('catalog.sqlite');
            const buf  = await (await fh.getFile()).arrayBuffer();
            const arr  = new Uint8Array(buf);
            const CHUNK = 8192;
            let bin = '';
            for (let i = 0; i < arr.length; i += CHUNK)
                bin += String.fromCharCode(...arr.subarray(i, i + CHUNK));
            return btoa(bin);
        } catch (e) { return 'ERROR:' + e.message; }
    }""", cat_id)
    if b64.startswith('ERROR:'):
        raise RuntimeError(b64[6:])
    tmp = tempfile.NamedTemporaryFile(suffix='.sqlite', delete=False)
    tmp.write(base64.b64decode(b64))
    tmp.close()
    return tmp.name


# ── Vision helpers ─────────────────────────────────────────────────────────────

def _iou(a, b):
    ix0, iy0 = max(a['x0'], b['x0']), max(a['y0'], b['y0'])
    ix1, iy1 = min(a['x1'], b['x1']), min(a['y1'], b['y1'])
    iw, ih = max(0, ix1 - ix0), max(0, iy1 - iy0)
    inter = iw * ih
    if inter == 0:
        return 0.0
    aa = (a['x1'] - a['x0']) * (a['y1'] - a['y0'])
    bb = (b['x1'] - b['x0']) * (b['y1'] - b['y0'])
    return inter / (aa + bb - inter)


def dedup(dets):
    """Collapse overlapping detections of one physical callout, keeping the
    higher-confidence box (we scan highest-conf first, so the first kept box wins):
      · SAME number, IoU>0.3  - a double-read of the same glyph.
      · DIFFERENT number, IoU>0.5 - one glyph read two ways (e.g. multi-scale calls
        it 6 and 9); keep the more confident reading rather than stacking both.
    Genuinely separate repeats (a callout stamped elsewhere on a symmetric diagram)
    don't overlap, so they survive as distinct instances."""
    out = []
    for d in sorted(dets, key=lambda x: -x['conf']):
        if any(_iou(o, d) > (0.3 if o['num'] == d['num'] else 0.5) for o in out):
            continue
        out.append(d)
    return out


def numeric_words(annotation, w, h):
    """Walk a full_text_annotation, yield {num,x0,y0,x1,y1,conf} for numeric words,
    coords normalized to the 0-10000 callout space."""
    out = []
    for pg in annotation.pages:
        for block in pg.blocks:
            for para in block.paragraphs:
                for word in para.words:
                    text = ''.join(sym.text for sym in word.symbols)
                    m = NUM_RE.match(text.strip())
                    if not m:
                        continue
                    n = int(m.group(1))
                    if n == 0:            # no callout is "0" - always a misread
                        continue
                    xs = [v.x for v in word.bounding_box.vertices]
                    ys = [v.y for v in word.bounding_box.vertices]
                    if not xs or not ys:
                        continue
                    x0, x1 = min(xs), max(xs)
                    y0, y1 = min(ys), max(ys)
                    out.append({
                        'num':  str(n),   # callout id is a string token end-to-end
                        'x0':   round(x0 / w * 10000),
                        'y0':   round(y0 / h * 10000),
                        'x1':   round(x1 / w * 10000),
                        'y1':   round(y1 / h * 10000),
                        'conf': round(float(word.confidence) * 100),
                    })
    return out


# ── Main ───────────────────────────────────────────────────────────────────────

server = start_server(docs_dir, port)
base_url = f'http://localhost:{port}'

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    if server:
        server.terminate()
    print("Playwright not found. Run with: uv run --with playwright ...")
    sys.exit(1)

sqlite_path = None
try:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(profile_dir), headless=True,
            args=['--no-first-run', '--no-default-browser-check'],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(f'{base_url}/index.html', wait_until='load')

        catalog_ids = page.evaluate("""async () => {
            const root = await navigator.storage.getDirectory();
            const ids = [];
            for await (const [id, handle] of root.entries()) {
                if (handle.kind !== 'directory') continue;
                try { await handle.getFileHandle('catalog.sqlite'); ids.push(id); }
                catch {}
            }
            return ids.sort();
        }""")

        if not catalog_ids:
            print("No catalogs in OPFS. Run tools/ingest.py first.")
            ctx.close(); sys.exit(1)

        if not filter_catalog:
            print("Available catalogs:", ', '.join(catalog_ids))
            print("Re-run with --catalog-id <id>")
            ctx.close(); sys.exit(0)

        if filter_catalog not in catalog_ids:
            print(f"Catalog '{filter_catalog}' not found. Available: {', '.join(catalog_ids)}")
            ctx.close(); sys.exit(1)

        print(f"Loading {filter_catalog}/catalog.sqlite from OPFS…")
        sqlite_path = load_catalog_sqlite(page, filter_catalog)
        ctx.close()
finally:
    if server:
        server.terminate()

# ── Read sections + expected callout sets ──────────────────────────────────────

conn = sqlite3.connect(sqlite_path)
cur = conn.cursor()

# The true expected callout set is EVERY position token, plain or parenthesized, incl.
# compound ids: the viewer strips outer parens, so '5'/'(5)' and '3/1'/'(3/1)' denote
# diagram callouts '5' and '3/1'. Tokens are strings end-to-end.
POS_RE = re.compile(r'^\(?(\d{1,3}(?:/\d{1,3})?)\)?$')
expected = {}   # section_id -> set(str)
for sid, pos in cur.execute("SELECT section_id, position FROM part WHERE position != ''"):
    m = POS_RE.match((pos or '').strip())
    if m:
        expected.setdefault(sid, set()).add(m.group(1))

sections = cur.execute(
    "SELECT id, number, diagram_blob FROM section "
    "WHERE diagram_blob IS NOT NULL ORDER BY number"
).fetchall()
if limit:
    sections = sections[:limit]

print(f"{len(sections)} sections with a diagram; "
      f"{sum(1 for s in sections if expected.get(s[0]))} of them have expected callouts.")

# ── Vision client ──────────────────────────────────────────────────────────────

try:
    from google.cloud import vision
    from google.oauth2 import service_account
    from PIL import Image
except ImportError:
    print("Missing deps. Run with:")
    print("  uv run --with google-cloud-vision --with pillow --with playwright python tools/ocr-groundtruth.py ...")
    conn.close(); sys.exit(1)

if not key_path.exists():
    print(f"Service account key not found: {key_path}")
    conn.close(); sys.exit(1)

creds = service_account.Credentials.from_service_account_file(str(key_path))
client = vision.ImageAnnotatorClient(credentials=creds)

# ── Cache ──────────────────────────────────────────────────────────────────────

out_dir = out_root / filter_catalog
out_dir.mkdir(parents=True, exist_ok=True)
vision_json = out_dir / 'vision.json'

results = {}   # str(section_id) -> {number, w, h, detections:[...]}
if vision_json.exists() and not no_cache:
    results = json.loads(vision_json.read_text(encoding='utf-8'))
    print(f"Loaded {len(results)} cached section results from {vision_json.name}")

# ── OCR pass ───────────────────────────────────────────────────────────────────
#
# Stored blobs render small/sparse diagrams tiny, and OCR (Vision *and* the shipping
# Tesseract) chokes on tiny digits: on a 700px diagram Vision found 3 of 12 callouts,
# but upscaled 3-4x it found most of them - no single scale is complete, so we OCR at
# several scales and union. Coords normalize to the same 0-10000 space at every scale,
# so cross-scale dedup is trivial. LANCZOS upscales; native is always included.
TARGET_LONG = (2600, 3800)   # upscale so the diagram's long side reaches these

def ocr_multiscale(blob):
    im = Image.open(io.BytesIO(blob)); W, H = im.size
    long = max(W, H)
    factors = {1.0}
    for target in TARGET_LONG:
        f = target / long
        if f > 1.05:
            factors.add(round(f, 2))
    dets = []
    for f in sorted(factors):
        if f == 1.0:
            content, w, h = blob, W, H
        else:
            w, h = int(W * f), int(H * f)
            if w * h > 70_000_000 or max(w, h) > 9000:
                continue
            buf = io.BytesIO(); im.resize((w, h), Image.LANCZOS).save(buf, 'PNG')
            content = buf.getvalue()
        resp = client.document_text_detection(image=vision.Image(content=content))
        if resp.error.message:
            raise RuntimeError(resp.error.message)
        dets += numeric_words(resp.full_text_annotation, w, h)
    return dedup(dets), W, H

todo = [(sid, num, blob) for (sid, num, blob) in sections if str(sid) not in results]
print(f"Sending {len(todo)} diagrams to Vision (multi-scale)…")

for i, (sid, num, blob) in enumerate(todo, 1):
    blob = bytes(blob)
    try:
        dets, w, h = ocr_multiscale(blob)
    except Exception as e:
        print(f"  [{i}/{len(todo)}] {num}: Vision error: {e}")
        continue
    results[str(sid)] = {'number': num, 'w': w, 'h': h, 'detections': dets}
    if i % 25 == 0 or i == len(todo):
        vision_json.write_text(json.dumps(results, indent=1), encoding='utf-8')
        print(f"  [{i}/{len(todo)}] {num}: {len(dets)} numeric tokens  (checkpoint saved)")

vision_json.write_text(json.dumps(results, indent=1), encoding='utf-8')

# ── Reconcile ──────────────────────────────────────────────────────────────────
#
# Diagrams legitimately carry more numbers than the parts list (torque, dimensions,
# thread specs), so an "extra" detection is usually NOT an OCR error and the parts
# list cannot adjudicate it. What the list *can* verify is the lower bound: every
# expected callout number should appear. So the human queue is driven by MISSING
# (a callout Vision didn't find). Repeats (REPT) are usually real - a callout stamped
# on both sides of a symmetric diagram - so after spatial dedup they're kept as
# multiple boxes, not treated as failures.
#
#   CLEAN     every expected callout found        -> silver ground truth
#   HUMAN     one or more expected callouts missing -> gold verification queue
#   NO-EXPECT diagram has no numeric part positions -> not reconcilable here
from collections import Counter

rows = []
silver = {}                                  # section_id -> accepted callout boxes
n_clean = n_human = n_noexp = 0
queue = []
for (sid, num, _blob) in sections:
    r = results.get(str(sid))
    if not r:
        continue
    dets   = dedup(r['detections'])
    counts = Counter(d['num'] for d in dets)
    exp = expected.get(sid)
    if not exp:
        n_noexp += 1
        rows.append({'section': num, 'status': 'NO-EXPECT', 'expected': 0,
                     'found': 0, 'missing': '', 'rept': '', 'extra': len(counts)})
        continue
    found   = {n for n in exp if counts.get(n)}
    missing = exp - found
    rept    = {n for n in exp if counts.get(n, 0) > 1}
    extra   = [n for n in counts if n not in exp]
    if not missing:
        status = 'CLEAN'; n_clean += 1
        silver[str(sid)] = {
            'number': num, 'tier': 'silver', 'source': 'vision',
            'callouts': [d for d in dets if d['num'] in exp],
        }
    else:
        status = 'HUMAN'; n_human += 1
        queue.append(num)
    rows.append({
        'section':  num, 'status': status, 'expected': len(exp),
        'found':    len(found),
        'missing':  ','.join(sorted(missing, key=natkey)),
        'rept':     ','.join(sorted(rept, key=natkey)),
        'extra':    len(extra),
    })

with open(out_dir / 'reconcile.csv', 'w', newline='', encoding='utf-8') as f:
    wtr = csv.DictWriter(f, fieldnames=['section', 'status', 'expected', 'found', 'missing', 'rept', 'extra'])
    wtr.writeheader()
    wtr.writerows(rows)

(out_dir / 'groundtruth.json').write_text(json.dumps(silver, indent=1), encoding='utf-8')
(out_dir / 'queue.txt').write_text('\n'.join(queue) + ('\n' if queue else ''), encoding='utf-8')
# expected callout set per section - the completeness oracle, needed by the queue merge
(out_dir / 'expected.json').write_text(
    json.dumps({str(k): sorted(v, key=natkey) for k, v in expected.items()}, indent=1), encoding='utf-8')

conn.close()
if sqlite_path and os.path.exists(sqlite_path):
    os.unlink(sqlite_path)

# ── Summary ────────────────────────────────────────────────────────────────────

reconciled = n_clean + n_human
print(f"\n── {filter_catalog} ground truth ──")
print(f"  Diagrams OCR'd             : {len(results)}")
print(f"  Reconcilable (has callouts): {reconciled}")
print(f"    CLEAN (silver, auto)     : {n_clean}"
      + (f"  ({100*n_clean//reconciled}%)" if reconciled else ""))
print(f"    HUMAN (gold queue)       : {n_human}")
print(f"  No numeric positions       : {n_noexp}")
print(f"\n  vision.json      : raw Vision detections (all numeric tokens)")
print(f"  groundtruth.json : {len(silver)} silver sections (auto-accepted callouts)")
print(f"  reconcile.csv    : per-section report")
print(f"  queue.txt        : {len(queue)} sections needing human verification")
print(f"  → {out_dir}")
