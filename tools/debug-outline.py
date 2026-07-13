#!/usr/bin/env python3
"""Print the raw PDF outline structure as seen by pdf.js in the browser."""
import sys, urllib.request, subprocess, time
from pathlib import Path

pdf_path = Path(sys.argv[1]).resolve()
docs_dir = Path(__file__).parent.parent / 'docs'
port = 8080

def _server_up(port):
    try: urllib.request.urlopen(f'http://localhost:{port}/', timeout=0.5); return True
    except: return False

if not _server_up(port):
    proc = subprocess.Popen(['python', '-m', 'http.server', str(port), '--directory', str(docs_dir)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(40):
        if _server_up(port): break
        time.sleep(0.25)

from playwright.sync_api import sync_playwright
profile_dir = Path(__file__).parent / '.playwright-profile'

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        str(profile_dir), headless=True,
        viewport={'width': 1440, 'height': 900},
        args=['--no-first-run'],
    )
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.goto(f'http://localhost:{port}/index.html', wait_until='load')

    with open(pdf_path, 'rb') as f:
        pdf_bytes = f.read()

    result = page.evaluate("""async (pdfBytes) => {
        const pdfjsLib = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.min.mjs');
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.worker.min.mjs';
        const arr = new Uint8Array(pdfBytes);
        const pdf = await pdfjsLib.getDocument({ data: arr }).promise;
        const outline = await pdf.getOutline();
        if (!outline) return 'NO OUTLINE';
        const result = [];
        for (const l1 of outline.slice(0,3)) {
            result.push('L1: ' + l1.title);
            for (const l2 of (l1.items||[]).slice(0,3)) {
                result.push('  L2: ' + l2.title);
                for (const l3 of (l2.items||[]).slice(0,5)) {
                    result.push('    L3: ' + l3.title);
                }
            }
        }
        return result.join('\\n');
    }""", list(pdf_bytes))

    ctx.close()
    print(result)
