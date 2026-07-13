#!/usr/bin/env python3
"""Export a catalog's SQLite from OPFS and run targeted spot-check queries."""
import sys, base64, sqlite3, tempfile, os, urllib.request, subprocess, time
from pathlib import Path

catalog_id = sys.argv[1] if len(sys.argv) > 1 else "997-1"
sections = sys.argv[2:] if len(sys.argv) > 2 else []

docs_dir = Path(__file__).parent.parent / 'docs'

def _server_up(port):
    try:
        urllib.request.urlopen(f'http://localhost:{port}/', timeout=0.5)
        return True
    except Exception:
        return False

port = 8080
if not _server_up(port):
    proc = subprocess.Popen(
        ['python', '-m', 'http.server', str(port), '--directory', str(docs_dir)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(40):
        if _server_up(port): break
        time.sleep(0.25)

from playwright.sync_api import sync_playwright

profile_dir = Path(__file__).parent / '.playwright-profile'
with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        str(profile_dir), headless=True,
        viewport={'width': 1440, 'height': 900},
        args=['--no-first-run', '--no-default-browser-check'],
    )
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.goto(f'http://localhost:{port}/index.html', wait_until='load')

    sqlite_b64 = page.evaluate(
        """async (id) => {
            const root = await navigator.storage.getDirectory();
            const dir  = await root.getDirectoryHandle(id);
            const fh   = await dir.getFileHandle('catalog.sqlite');
            const buf  = await (await fh.getFile()).arrayBuffer();
            const arr  = new Uint8Array(buf);
            let bin = '';
            for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
            return btoa(bin);
        }""", catalog_id,
    )
    ctx.close()

sqlite_bytes = base64.b64decode(sqlite_b64)
tmp = tempfile.NamedTemporaryFile(suffix='.sqlite', delete=False)
tmp.write(sqlite_bytes); tmp.close()

conn = sqlite3.connect(tmp.name)
cur = conn.cursor()

def q(sql, *params):
    cur.execute(sql, params)
    return cur.fetchall()

print(f"\n=== Catalog: {catalog_id} ===")

# Overall stats
rows = q("SELECT COUNT(*) FROM section")[0][0]
parts = q("SELECT COUNT(*) FROM part")[0][0]
print(f"Sections: {rows}, Parts: {parts}")

# PR codes sample
pr = q("SELECT code, description FROM pr_code ORDER BY code LIMIT 10")
if pr:
    print(f"\nPR codes (first 10 of {q('SELECT COUNT(*) FROM pr_code')[0][0]}):")
    for code, desc in pr:
        print(f"  {code}: {desc}")

# VIN ranges sample
vins = q("SELECT model_year, vin_from, vin_to, remark FROM vin_range ORDER BY model_year LIMIT 10")
if vins:
    print(f"\nVIN ranges (first 10 of {q('SELECT COUNT(*) FROM vin_range')[0][0]}):")
    for my, vf, vt, rem in vins:
        print(f"  MY{my}: {vf} > {vt}  ({rem})")

# List first sections if no specific ones requested
if not sections:
    # Show schema first
    schema = q("SELECT sql FROM sqlite_master WHERE type='table' AND name='section'")
    print("\nSection schema:", schema[0][0][:200] if schema else "NOT FOUND")
    views = q("SELECT name,sql FROM sqlite_master WHERE type='view'")
    if views: print("Views:", views)
    print("\nFirst 10 sections (number | title | parts):")
    for row in q("SELECT s.number, s.title, COUNT(p.id) FROM section s LEFT JOIN part p ON p.section_id=s.id GROUP BY s.id ORDER BY s.id LIMIT 10"):
        print(f"  {row[0]!r:30} | {row[1]!r:20} | parts={row[2]}")
    # Also check raw section number with no join
    print("\nRaw section.number (no join):")
    for row in q("SELECT number FROM section ORDER BY id LIMIT 5"):
        print(f"  {row[0]!r}")

# Specific section parts
for sec_num in sections or []:
    rows = q("""SELECT p.position, p.part_number, p.description, p.applicability
                FROM part p JOIN section s ON p.section_id = s.id
                WHERE s.number = ? ORDER BY p.id""", sec_num)
    print(f"\nSection {sec_num} ({len(rows)} parts):")
    for pos, pn, desc, appl in rows:
        appl_str = f"  [{appl}]" if appl else ""
        print(f"  {pos:>4}  {pn:<20} {desc[:45]}{appl_str}")

conn.close()
os.unlink(tmp.name)
