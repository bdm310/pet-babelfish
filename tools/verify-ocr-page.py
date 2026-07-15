#!/usr/bin/env python3
"""Drive spike-ocr-callouts.html headless to OCR a single PDF page and print callouts.
Usage: uv run --with playwright python tools/verify-ocr-page.py <pdf> <page>"""
import sys, subprocess, time, urllib.request
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')

pdf = Path(sys.argv[1]).resolve()
page = sys.argv[2]
docs = Path(__file__).parent.parent / 'docs'
port = 8091

def up():
    try: urllib.request.urlopen(f'http://localhost:{port}/', timeout=0.5); return True
    except: return False

srv = None
if not up():
    srv = subprocess.Popen(['python','-m','http.server',str(port),'--directory',str(docs)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(40):
        if up(): break
        time.sleep(0.25)

from playwright.sync_api import sync_playwright
try:
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=['--no-first-run'])
        pg = b.new_page()
        errs = []
        pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
        pg.goto(f'http://localhost:{port}/spikes/spike-ocr-callouts.html', wait_until='load')
        pg.locator('#fileInput').set_input_files(str(pdf))
        pg.wait_for_function("() => document.getElementById('dropzone').textContent.includes('pages')", timeout=30000)
        pg.fill('#pageNum', str(page))
        pg.evaluate("() => runPage()")
        # Wait for results table or error
        pg.wait_for_function(
            "() => { const o=document.getElementById('output'); return o && (o.querySelector('table.results') || o.textContent.includes('Error') || o.textContent.includes('No image')); }",
            timeout=120000)
        res = pg.evaluate("""() => {
            const rows = [...document.querySelectorAll('table.results tbody tr.match')].map(r => {
                const td = r.querySelectorAll('td');
                return { num: td[0]?.textContent.trim(), conf: td[1]?.textContent.trim(), wh: td[2]?.textContent.trim() };
            });
            const stats = [...document.querySelectorAll('.stat')].map(s => s.textContent.trim());
            return { rows, stats };
        }""")
        print("STATS:", " | ".join(res['stats']))
        print(f"CALLOUTS ({len(res['rows'])}):")
        for r in res['rows']:
            print(f"  {r['num']:>4}  conf={r['conf']}  {r['wh']}")
        if errs: print("CONSOLE ERRORS:", errs[:5])
        b.close()
finally:
    if srv: srv.terminate()
