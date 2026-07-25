#!/usr/bin/env python3
"""
Export a catalog's SQLite from the browser OPFS store to a file - headless, no
screenshots (unlike verify.py). Used by the OCR validation loop to refresh
groundtruth/<cat>/catalog.sqlite after a re-ingest so ocr-eval.py can grade it.

Usage:
    uv run --with playwright python tools/export-opfs.py --catalog-id 996_1998-2005 \
        --out groundtruth/996_1998-2005/catalog.sqlite
"""
import sys, subprocess, time, urllib.request, base64
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

docs_dir = Path(__file__).parent.parent / 'docs'

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

from playwright.sync_api import sync_playwright
profile_dir = Path(__file__).parent / '.playwright-profile'
try:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(str(profile_dir), headless=True,
                args=['--no-first-run', '--no-default-browser-check'])
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(f'http://localhost:{port}/index.html', wait_until='load')
        b64 = page.evaluate("""async (id) => {
            try {
                const root = await navigator.storage.getDirectory();
                const dir = await root.getDirectoryHandle(id);
                const fh = await dir.getFileHandle('catalog.sqlite');
                const buf = await (await fh.getFile()).arrayBuffer();
                const arr = new Uint8Array(buf); let bin='';
                for (let i=0;i<arr.length;i++) bin += String.fromCharCode(arr[i]);
                return btoa(bin);
            } catch(e){ return 'ERROR:'+e.message; }
        }""", cat)
        ctx.close()
    if b64.startswith('ERROR:'):
        print("export failed:", b64); sys.exit(1)
    data = base64.b64decode(b64)
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_bytes(data)
    print(f"exported {len(data)//1024} KB -> {out}")
finally:
    if server: server.terminate()
