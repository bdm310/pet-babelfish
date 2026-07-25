#!/usr/bin/env python3
"""
Prepare the Vision "missing" queue for agent resolution.

For every HUMAN section in a catalog's reconcile.csv (Vision missed >=1 expected
callout), render an annotated diagram and a task file that an LLM agent can resolve:

  <section>.png        the diagram, upscaled for legibility, with
                         - a light labeled grid in the 0-10000 callout space
                         - Vision's already-found callouts drawn as blue ANCHORS
  <section>.task.json  { section, missing:[n...], anchors:{n:[x0,y0,x1,y1]} }

The agent's job is recognition, not detection: it is told exactly which numbers to
find and can read their location off the grid / relative to the anchors, which is
far more reliable than asking an LLM for absolute pixel coordinates.

Agents write <section>.result.json next to these; gt-queue-merge.py folds them in.

Usage:
    uv run --with playwright --with pillow python tools/gt-queue-prep.py --catalog-id 996_1998-2005
"""
import sys, subprocess, time, urllib.request, base64, sqlite3, tempfile, os, io, json, csv
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
args = sys.argv[1:]


def opt(n, d=None):
    try:    return args[args.index(n) + 1]
    except (ValueError, IndexError): return d


filter_catalog = opt('--catalog-id')
port      = int(opt('--port', '8080'))
long_side = int(opt('--long', '2200'))     # upscale target for legibility

repo_dir    = Path(__file__).parent.parent
docs_dir    = repo_dir / 'docs'
profile_dir = Path(__file__).parent / '.playwright-profile'
out_dir     = repo_dir / 'groundtruth' / (filter_catalog or '')
queue_dir   = out_dir / 'queue'

if not filter_catalog:
    print("--catalog-id required"); sys.exit(1)
if not (out_dir / 'vision.json').exists():
    print(f"Run ocr-groundtruth.py for {filter_catalog} first."); sys.exit(1)


def _server_up(p):
    try: urllib.request.urlopen(f'http://localhost:{p}/', timeout=0.5); return True
    except Exception: return False


def start_server():
    if _server_up(port): return None
    proc = subprocess.Popen(['python', '-m', 'http.server', str(port), '--directory', str(docs_dir)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(40):
        if _server_up(port): return proc
        time.sleep(0.25)
    proc.terminate(); raise RuntimeError("server failed")


# ── which sections need resolving ──────────────────────────────────────────────

vision = json.loads((out_dir / 'vision.json').read_text(encoding='utf-8'))
num_to_sid = {r['number']: sid for sid, r in vision.items()}

missing_by_num = {}   # section number -> [missing ints]
for row in csv.DictReader(open(out_dir / 'reconcile.csv', encoding='utf-8')):
    if row['status'] == 'HUMAN' and row['missing']:
        missing_by_num[row['section']] = [int(x) for x in row['missing'].split(',')]

if not missing_by_num:
    print("Nothing queued - no HUMAN sections."); sys.exit(0)
print(f"{len(missing_by_num)} sections to prepare.")

# ── pull blobs from OPFS ───────────────────────────────────────────────────────

server = start_server()
try:
    from playwright.sync_api import sync_playwright
    from PIL import Image, ImageDraw, ImageFont
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(str(profile_dir), headless=True,
                                                    args=['--no-first-run', '--no-default-browser-check'])
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(f'http://localhost:{port}/index.html', wait_until='load')
        b64 = page.evaluate("""async id=>{const root=await navigator.storage.getDirectory();
            const d=await root.getDirectoryHandle(id);const fh=await d.getFileHandle('catalog.sqlite');
            const buf=await(await fh.getFile()).arrayBuffer();const a=new Uint8Array(buf);let s='';
            for(let i=0;i<a.length;i+=8192)s+=String.fromCharCode(...a.subarray(i,i+8192));return btoa(s);}""",
            filter_catalog)
        ctx.close()
finally:
    if server: server.terminate()

tmp = tempfile.NamedTemporaryFile(suffix='.sqlite', delete=False)
tmp.write(base64.b64decode(b64)); tmp.close()
con = sqlite3.connect(tmp.name)

queue_dir.mkdir(parents=True, exist_ok=True)


def draw_grid(draw, W, H, font):
    for i in range(0, 11):
        x = round(i / 10 * W); y = round(i / 10 * H)
        draw.line([(x, 0), (x, H)], fill=(210, 210, 210), width=1)
        draw.line([(0, y), (W, y)], fill=(210, 210, 210), width=1)
        lbl = str(i * 1000)
        draw.text((x + 2, 2), lbl, fill=(160, 160, 160), font=font)
        draw.text((2, y + 2), lbl, fill=(160, 160, 160), font=font)


manifest = []
for num, missing in sorted(missing_by_num.items()):
    sid = num_to_sid.get(num)
    row = con.execute("SELECT diagram_blob FROM section WHERE number=? AND catalog_id=?",
                      (num, filter_catalog)).fetchone()
    if not row or not row[0]:
        row = con.execute("SELECT diagram_blob FROM section WHERE number=?", (num,)).fetchone()
    if not row or not row[0]:
        print(f"  {num}: no blob, skipping"); continue
    im = Image.open(io.BytesIO(bytes(row[0]))).convert('RGB')
    W0, H0 = im.size
    f = max(1.0, long_side / max(W0, H0))
    W, H = int(W0 * f), int(H0 * f)
    im = im.resize((W, H), Image.LANCZOS)
    draw = ImageDraw.Draw(im)
    try:    font = ImageFont.truetype("arial.ttf", max(14, W // 90))
    except Exception: font = ImageFont.load_default()
    draw_grid(draw, W, H, font)

    anchors = {}
    for d in vision[sid]['detections']:
        ax0, ay0 = d['x0'] / 10000 * W, d['y0'] / 10000 * H
        ax1, ay1 = d['x1'] / 10000 * W, d['y1'] / 10000 * H
        draw.rectangle([ax0, ay0, ax1, ay1], outline=(30, 90, 220), width=2)
        draw.text((ax0, max(0, ay0 - font.size - 1)), str(d['num']), fill=(30, 90, 220), font=font)
        # a number can be stamped more than once - keep every box, not just the last
        anchors.setdefault(str(d['num']), []).append([d['x0'], d['y0'], d['x1'], d['y1']])

    im.save(queue_dir / f"{num}.png")
    task = {'catalog': filter_catalog, 'section': num, 'missing': missing, 'anchors': anchors}
    (queue_dir / f"{num}.task.json").write_text(json.dumps(task, indent=1), encoding='utf-8')
    manifest.append(num)

con.close(); os.unlink(tmp.name)
(queue_dir / 'manifest.json').write_text(json.dumps(manifest, indent=1), encoding='utf-8')
print(f"Prepared {len(manifest)} tasks → {queue_dir}")
