#!/usr/bin/env python3
"""
Seed an editable ground-truth folder for a catalog WITHOUT Google Vision.

The normal seeder (tools/ocr-groundtruth.py) uses Vision as the strong labeler.
This one is the no-Vision variant: it seeds the editable GT layer straight from
our OWN heuristic Tesseract `callout` table, so a human hand-corrects it into gold
in the manual editor (tools/gt-editor.py). It replicates ocr-groundtruth.py's
output shapes exactly, minus Vision.

For each catalog it writes groundtruth/<catalog-id>/:
  catalog.sqlite    exported from the browser OPFS store
  expected.json     {sid: sorted(int)} parts-list completeness oracle
  groundtruth.json  {sid: {number,tier,source,callouts:[...]}} seeded from `callout`
                    (silver / tesseract) for every section that has callouts
  vision.json       {sid: {number,w,h,detections:[]}} - section scaffold, NO Vision
                    detections (blue layer empty). The editor enumerates sections
                    from this file and can't be modified here, so it must exist and
                    list every diagram section; detections stay [].
  reconcile.csv     per-section expected/detected/missing/rept/extra/status
  queue.txt         section numbers whose expected callouts aren't all detected

Coordinate space: the `callout` table x0..y1 are already round(px/imgDim*10000),
the identical 0-10000 space groundtruth.json/vision.json use - no conversion.

Usage:
    # all four no-Vision catalogs
    uv run --with playwright python tools/gt-init.py
    # one catalog
    uv run --with playwright python tools/gt-init.py --catalog-id 356_356A_1950-1959
    # list what's in OPFS
    uv run --with playwright python tools/gt-init.py --list
"""
import sys, subprocess, time, urllib.request, base64, sqlite3, tempfile, os, json, re, csv
from collections import Counter
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
args = sys.argv[1:]

def opt(n, d=None):
    try: return args[args.index(n) + 1]
    except (ValueError, IndexError): return d

def flag(n): return n in args

# The four catalogs seeded this round (folder name == OPFS catalog-id == PDF basename).
DEFAULT_CATALOGS = [
    '356_356A_1950-1959',
    '911Turbo_1975-1977',
    'Cayenne-955(E1)_2003-2006',
    'Boxster(987-1)_2005-2008',
]

filter_catalog = opt('--catalog-id')
port = int(opt('--port', '8080'))
repo_dir = Path(__file__).parent.parent
docs_dir = repo_dir / 'docs'
profile_dir = Path(__file__).parent / '.playwright-profile'
profile_dir.mkdir(exist_ok=True)
out_root = repo_dir / 'groundtruth'

# callout id token: 1-3 digits + optional /sub, outer parens stripped ('(3/1)'→'3/1', '5'→'5')
POS_RE = re.compile(r'^\(?(\d{1,3}(?:/\d{1,3})?)\)?$')

def pos_token(pos):
    m = POS_RE.match((pos or '').strip())
    return m.group(1) if m else None

def natkey(tok):
    # natural sort: leading int then sub-int, so '2' < '2/1' < '10'
    return tuple(int(p) for p in str(tok).split('/'))


def _server_up(p):
    try:
        urllib.request.urlopen(f'http://localhost:{p}/', timeout=0.5); return True
    except Exception:
        return False

def start_server(docs_dir, port):
    if _server_up(port):
        print(f"Server already running on :{port}, reusing it.")
        return None
    proc = subprocess.Popen(
        ['python', '-m', 'http.server', str(port), '--directory', str(docs_dir)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(40):
        if _server_up(port): return proc
        time.sleep(0.25)
    proc.terminate(); raise RuntimeError(f"HTTP server failed on :{port}")

def load_catalog_sqlite(page, cat_id):
    """Pull <cat_id>/catalog.sqlite out of OPFS into a temp file, return its path."""
    b64 = page.evaluate("""async (id) => {
        try {
            const root = await navigator.storage.getDirectory();
            const dir  = await root.getDirectoryHandle(id);
            const fh   = await dir.getFileHandle('catalog.sqlite');
            const buf  = await (await fh.getFile()).arrayBuffer();
            const arr  = new Uint8Array(buf);
            const CHUNK = 8192; let bin = '';
            for (let i = 0; i < arr.length; i += CHUNK)
                bin += String.fromCharCode(...arr.subarray(i, i + CHUNK));
            return btoa(bin);
        } catch (e) { return 'ERROR:' + e.message; }
    }""", cat_id)
    if b64.startswith('ERROR:'):
        raise RuntimeError(b64[6:])
    data = base64.b64decode(b64)
    tmp = tempfile.NamedTemporaryFile(suffix='.sqlite', delete=False)
    tmp.write(data); tmp.close()
    return tmp.name, len(data)


def build_catalog(cat, sqlite_path):
    """Read the exported sqlite and write all GT artifacts. Returns a stats dict."""
    out_dir = out_root / cat
    out_dir.mkdir(parents=True, exist_ok=True)
    # persist the exported db (the editor reads diagrams + callouts from it)
    (out_dir / 'catalog.sqlite').write_bytes(Path(sqlite_path).read_bytes())

    conn = sqlite3.connect(sqlite_path)
    cur = conn.cursor()

    # expected callout set per section (parts-list completeness oracle)
    expected = {}   # sid -> set(str)   string id tokens, e.g. '2', '2/1'
    for sid, pos in cur.execute("SELECT section_id, position FROM part WHERE position != ''"):
        t = pos_token(pos)
        if t:
            expected.setdefault(sid, set()).add(t)

    # sections that have a rendered diagram - these define the editor's worklist
    sections = cur.execute(
        "SELECT id, number, diagram_w, diagram_h FROM section "
        "WHERE diagram_blob IS NOT NULL ORDER BY number").fetchall()

    # Tesseract callouts per section from our own heuristic OCR table
    tess = {}   # sid -> [ {num,x0,y0,x1,y1,conf}, ... ]
    for sid, num, x0, y0, x1, y1, conf in cur.execute(
            "SELECT section_id, number, x0, y0, x1, y1, confidence FROM callout"):
        t = str(num).strip().strip('()')
        if not t.isdigit():
            continue
        tess.setdefault(sid, []).append(
            {'num': t, 'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1, 'conf': conf})
    conn.close()

    vision = {}          # scaffold enumerating diagram sections (no detections)
    gt = {}              # silver seed for sections that have callouts
    rows = []
    queue = []
    n_seeded = n_clean = n_human = n_noexp = 0
    total_callouts = 0

    for sid, number, w, h in sections:
        vision[str(sid)] = {'number': number, 'w': w, 'h': h, 'detections': []}
        dets = tess.get(sid, [])
        if dets:
            n_seeded += 1
            total_callouts += len(dets)
            gt[str(sid)] = {
                'number': number, 'tier': 'silver', 'source': 'tesseract',
                'callouts': [{'num': d['num'], 'x0': d['x0'], 'y0': d['y0'],
                              'x1': d['x1'], 'y1': d['y1'], 'conf': d['conf'],
                              'source': 'tesseract'} for d in dets],
            }
        # reconcile detected-set vs expected-set
        counts = Counter(d['num'] for d in dets)
        exp = expected.get(sid)
        if not exp:
            n_noexp += 1
            rows.append({'section': number, 'status': 'NO-EXPECT', 'expected': 0,
                         'found': 0, 'missing': '', 'rept': '', 'extra': len(counts)})
            continue
        found = {n for n in exp if counts.get(n)}
        missing = exp - found
        rept = {n for n in exp if counts.get(n, 0) > 1}
        extra = [n for n in counts if n not in exp]
        if not missing:
            status = 'CLEAN'; n_clean += 1
        else:
            status = 'HUMAN'; n_human += 1; queue.append(number)
        rows.append({
            'section': number, 'status': status, 'expected': len(exp),
            'found': len(found),
            'missing': ','.join(sorted(missing, key=natkey)),
            'rept': ','.join(sorted(rept, key=natkey)),
            'extra': len(extra),
        })

    (out_dir / 'expected.json').write_text(
        json.dumps({str(k): sorted(v, key=natkey) for k, v in expected.items()}, indent=1), encoding='utf-8')
    (out_dir / 'vision.json').write_text(json.dumps(vision, indent=1), encoding='utf-8')
    (out_dir / 'groundtruth.json').write_text(json.dumps(gt, indent=1), encoding='utf-8')
    with open(out_dir / 'reconcile.csv', 'w', newline='', encoding='utf-8') as f:
        wtr = csv.DictWriter(f, fieldnames=['section', 'status', 'expected', 'found', 'missing', 'rept', 'extra'])
        wtr.writeheader(); wtr.writerows(rows)
    (out_dir / 'queue.txt').write_text('\n'.join(queue) + ('\n' if queue else ''), encoding='utf-8')

    return {
        'sections': len(sections), 'seeded': n_seeded, 'callouts': total_callouts,
        'clean': n_clean, 'human': n_human, 'noexp': n_noexp, 'queue': len(queue),
        'out_dir': out_dir,
    }


# ── main ────────────────────────────────────────────────────────────────────────

server = start_server(docs_dir, port)
base_url = f'http://localhost:{port}'
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    if server: server.terminate()
    print("Playwright not found. Run with: uv run --with playwright python tools/gt-init.py")
    sys.exit(1)

targets = [filter_catalog] if filter_catalog else DEFAULT_CATALOGS
all_stats = {}
try:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(profile_dir), headless=True,
            args=['--no-first-run', '--no-default-browser-check'])
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

        if flag('--list') or not catalog_ids:
            print("OPFS catalogs:", ', '.join(catalog_ids) or '(none)')
            ctx.close(); server and server.terminate(); sys.exit(0)

        for cat in targets:
            if cat not in catalog_ids:
                print(f"  ! '{cat}' not in OPFS - skipping. Available: {', '.join(catalog_ids)}")
                continue
            print(f"Exporting {cat}/catalog.sqlite from OPFS…")
            sqlite_path, nbytes = load_catalog_sqlite(page, cat)
            try:
                stats = build_catalog(cat, sqlite_path)
                all_stats[cat] = stats
                print(f"  {cat}: {stats['sections']} diagram sections, "
                      f"{stats['seeded']} seeded ({stats['callouts']} callouts), "
                      f"CLEAN {stats['clean']} / HUMAN {stats['human']} / NO-EXPECT {stats['noexp']}, "
                      f"queue {stats['queue']}  ({nbytes//1024} KB)")
            finally:
                if os.path.exists(sqlite_path):
                    os.unlink(sqlite_path)
        ctx.close()
finally:
    if server: server.terminate()

print("\n── seed summary ──")
for cat, s in all_stats.items():
    print(f"  {cat:32} sections {s['sections']:4}  seeded {s['seeded']:4}  "
          f"callouts {s['callouts']:5}  queue {s['queue']:4}")
print(f"  → {out_root}")
