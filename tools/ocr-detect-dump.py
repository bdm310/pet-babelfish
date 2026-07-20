#!/usr/bin/env python3
"""
Phase 4.5 diagnostic driver. Runs the REAL model path (ocrDiagramModel with debug=on)
over every GT section's stored diagram blob and dumps per-section
  { candidates:[{box,prob,accepted}], accepted:[box], digits:[{box,text}], callouts:[{box,number}] }
to scratchpad JSON. Attribution (A/B/C/D) is a separate step (ocr-detect-attribute.py).

Usage:
    uv run --with playwright python tools/ocr-detect-dump.py --catalog-id 996_1998-2005 --out dump-996.json
"""
import sys, subprocess, time, urllib.request, base64, json, sqlite3
from pathlib import Path

args = sys.argv[1:]
def opt(n, d=None):
    try: return args[args.index(n)+1]
    except (ValueError, IndexError): return d

cat = opt('--catalog-id')
out = opt('--out')
port = int(opt('--port', '8080'))
if not cat or not out:
    print("--catalog-id and --out required"); sys.exit(1)

root = Path(__file__).parent.parent
docs_dir = root / 'docs'
gt = json.loads((root / 'groundtruth' / cat / 'groundtruth.json').read_text(encoding='utf-8'))
con = sqlite3.connect(root / 'groundtruth' / cat / 'catalog.sqlite')

sections = []
for sid in gt.keys():
    r = con.execute('SELECT diagram_blob, diagram_w, diagram_h FROM section WHERE id=?', (int(sid),)).fetchone()
    if not r or not r[0]:
        continue
    blob, w, h = r
    sections.append((sid, base64.b64encode(blob).decode('ascii'), w, h))
con.close()
lim = opt('--limit')
if lim: sections = sections[:int(lim)]
print(f"{cat}: {len(sections)} sections to run")

def up(port):
    try: urllib.request.urlopen(f'http://localhost:{port}/', timeout=0.5); return True
    except Exception: return False

server = None
if not up(port):
    server = subprocess.Popen(['python', '-m', 'http.server', str(port), '--directory', str(docs_dir)],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(40):
        if up(port): break
        time.sleep(0.25)

INIT_JS = """
() => new Promise((resolve) => {
  const w = new Worker('ingest.worker.js?v=' + Date.now());
  window.__w = w; window.__pending = null; window.__errs = [];
  w.onmessage = (e) => {
    const d = e.data;
    if (d.type === 'debug-detections-result') {
      const p = window.__pending; window.__pending = null; if (p) p.resolve(d.debug);
    } else if (d.type === 'error') {
      const p = window.__pending;
      if (p) { window.__pending = null; p.reject(new Error(d.message)); }
      else window.__errs.push(d.message);
    }
  };
  window.__run = (b64, ww, hh) => new Promise((res, rej) => {
    const bin = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    window.__pending = { resolve: res, reject: rej };
    window.__w.postMessage({ type: 'debug-detections', blob: arr, w: ww, h: hh }, [arr.buffer]);
  });
  resolve(true);
})
"""

from playwright.sync_api import sync_playwright
profile_dir = Path(__file__).parent / '.playwright-profile'
results = {}
try:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(str(profile_dir), headless=True,
                args=['--no-first-run', '--no-default-browser-check'])
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.on('console', lambda m: None)
        page.goto(f'http://localhost:{port}/index.html', wait_until='load')
        page.evaluate(INIT_JS)
        t0 = time.time()
        for i, (sid, b64, w, h) in enumerate(sections):
            try:
                dbg = page.evaluate("([b,w,h]) => window.__run(b,w,h)", [b64, w, h])
            except Exception as e:
                print(f"  {sid}: ERROR {str(e)[:200]}")
                dbg = None
            results[sid] = dbg
            if (i + 1) % 25 == 0:
                print(f"  {i+1}/{len(sections)}  ({time.time()-t0:.0f}s)")
        ctx.close()
finally:
    if server: server.terminate()

Path(out).write_text(json.dumps(results), encoding='utf-8')
print(f"wrote {out}  ({sum(1 for v in results.values() if v)} sections with debug)")
