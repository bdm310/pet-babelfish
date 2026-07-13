#!/usr/bin/env python3
"""
Verify viewer and data quality with zero human interaction.
Starts a local HTTP server, exports the catalog from OPFS, runs DB queries
with Python sqlite3, and takes screenshots of the live viewer.

Usage:
    uv run --with playwright python tools/verify.py --catalog-id ID [options]

Options:
    --catalog-id ID   Catalog to verify (required)
    --port N          HTTP server port (default: 8080)
    --out DIR         Output directory (default: verify-output)
    --section NUM     Section number to open for screenshot (default: first)
    --search QUERY    Search term for search screenshot (default: Schraube)
    --headed          Show browser window
"""
import sys, subprocess, time, urllib.request, base64, sqlite3, tempfile, os
from pathlib import Path
from datetime import datetime

# ── Arg parsing ──────────────────────────────────────────────────────────────

args = sys.argv[1:]


def flag(n):
    return n in args


def opt(n, default=None):
    try:
        return args[args.index(n) + 1]
    except (ValueError, IndexError):
        return default


catalog_id = opt('--catalog-id')
if not catalog_id:
    print(__doc__)
    sys.exit(1)

port = int(opt('--port', '8080'))
out_root = Path(opt('--out', 'verify-output'))
target_section = opt('--section')
search_query = opt('--search', 'Schraube')
headed = flag('--headed')

docs_dir = Path(__file__).parent.parent / 'docs'
run_dir = out_root / datetime.now().strftime('%Y-%m-%d_%H%M%S')
run_dir.mkdir(parents=True, exist_ok=True)

# ── HTTP server ───────────────────────────────────────────────────────────────

def _server_up(port):
    try:
        urllib.request.urlopen(f'http://localhost:{port}/', timeout=0.5)
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


print(f"Starting HTTP server on :{port}...")
server = start_server(docs_dir, port)
base_url = f'http://localhost:{port}'

# ── Playwright ────────────────────────────────────────────────────────────────

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    if server:
        server.terminate()
    print("Playwright not found. Run:")
    print("  uv run --with playwright python -m playwright install chromium")
    sys.exit(1)

profile_dir = Path(__file__).parent / '.playwright-profile'
profile_dir.mkdir(exist_ok=True)

lines = []  # summary lines


def note(msg):
    print(msg)
    lines.append(msg)


note(f"Verifying catalog: {catalog_id}")
note(f"Output: {run_dir}")
note("")

try:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(profile_dir),
            headless=not headed,
            viewport={'width': 1440, 'height': 900},
            args=['--no-first-run', '--no-default-browser-check'],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        # ── Export SQLite from OPFS ────────────────────────────────────────────
        note("Exporting SQLite from OPFS...")
        page.goto(f'{base_url}/index.html', wait_until='load')

        sqlite_b64 = page.evaluate(
            """async (id) => {
                try {
                    const root = await navigator.storage.getDirectory();
                    const dir  = await root.getDirectoryHandle(id);
                    const fh   = await dir.getFileHandle('catalog.sqlite');
                    const buf  = await (await fh.getFile()).arrayBuffer();
                    const arr  = new Uint8Array(buf);
                    let bin = '';
                    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
                    return btoa(bin);
                } catch (e) { return 'ERROR:' + e.message; }
            }""",
            catalog_id,
        )

        if sqlite_b64.startswith('ERROR:'):
            note(f"✗ Could not load catalog from OPFS: {sqlite_b64[6:]}")
            note("  Run tools/ingest.py first to ingest a catalog.")
            ctx.close()
            sys.exit(1)

        sqlite_bytes = base64.b64decode(sqlite_b64)
        note(f"  SQLite size: {len(sqlite_bytes) / 1024:.0f} KB")

        # ── Save SQLite to output dir ─────────────────────────────────────────
        sqlite_out = run_dir / 'catalog.sqlite'
        sqlite_out.write_bytes(sqlite_bytes)
        note(f"  Saved → {sqlite_out}")

        # ── Query with sqlite3 ────────────────────────────────────────────────
        note("\n─── Database summary ────────────────────────────────────────────")

        tmp_f = tempfile.NamedTemporaryFile(suffix='.sqlite', delete=False)
        try:
            tmp_f.write(sqlite_bytes)
            tmp_f.close()
            conn = sqlite3.connect(tmp_f.name)
            cur = conn.cursor()

            def q(sql, *params):
                cur.execute(sql, params)
                return cur.fetchall()

            # Counts
            counts = {
                'sections':  q('SELECT COUNT(*) FROM section')[0][0],
                'parts':     q('SELECT COUNT(*) FROM part')[0][0],
                'callouts':  q('SELECT COUNT(*) FROM callout')[0][0],
                'pr_codes':  q('SELECT COUNT(*) FROM pr_code')[0][0],
                'vin_ranges': q('SELECT COUNT(*) FROM vin_range')[0][0],
            }
            for k, v in counts.items():
                note(f"  {k:<14} {v:>6}")

            # Callout confidence
            conf_row = q('SELECT AVG(confidence), MIN(confidence), MAX(confidence) FROM callout')
            if conf_row and conf_row[0][0]:
                avg, lo, hi = conf_row[0]
                note(f"\n  OCR confidence  avg={avg:.1f}%  min={lo:.1f}%  max={hi:.1f}%")

            # Parts with applicability
            appl_count = q('SELECT COUNT(*) FROM part WHERE applicability IS NOT NULL AND applicability != ""')[0][0]
            note(f"  parts w/ appl   {appl_count:>6} ({100*appl_count//max(counts['parts'],1)}%)")

            # Sample parts
            note("\n  Sample parts:")
            for row in q('SELECT section_id, position, part_number, description FROM part WHERE part_number != "" LIMIT 5'):
                note(f"    sec={row[0]} pos={row[1]} pn={row[2]} {row[3][:40]}")

            # Main groups
            note("\n  Main groups:")
            for row in q('SELECT number, title FROM main_group ORDER BY CAST(number AS INTEGER)'):
                note(f"    {row[0]}: {row[1]}")

            # First section in first group (for screenshot)
            first_section = q(
                """SELECT s.number FROM section s
                   JOIN main_group mg ON s.main_group_id = mg.id
                   ORDER BY CAST(mg.number AS INTEGER), s.number LIMIT 1"""
            )
            first_section_num = first_section[0][0] if first_section else None

            conn.close()
        finally:
            os.unlink(tmp_f.name)

        # ── Screenshots ────────────────────────────────────────────────────────
        note("\n─── Screenshots ─────────────────────────────────────────────────")
        viewer_url = f'{base_url}/viewer.html?catalog={catalog_id}'

        # 1. Viewer initial load
        print("  Taking viewer-loaded.png...")
        page.goto(viewer_url, wait_until='networkidle')
        page.wait_for_function(
            """() => {
                const sb = document.getElementById('statusBar');
                return sb && /sections/.test(sb.textContent);
            }""",
            timeout=30_000,
        )
        page.screenshot(path=str(run_dir / 'viewer-loaded.png'))
        note("  viewer-loaded.png")

        # 2. Open first section
        section_num = target_section or first_section_num
        if section_num:
            print(f"  Opening section {section_num}...")
            try:
                # Expand first main group (click its header)
                page.locator('.mg-header').first.click()
                page.wait_for_selector('.sec-item', timeout=5_000)

                # Click matching section or just first
                if section_num:
                    sec_el = page.locator(f'.sec-item .sec-num:text("{section_num}")').first
                    if sec_el.count():
                        sec_el.click()
                    else:
                        page.locator('.sec-item').first.click()
                else:
                    page.locator('.sec-item').first.click()

                page.wait_for_timeout(2000)
                page.screenshot(path=str(run_dir / 'viewer-section.png'))
                note("  viewer-section.png")
            except Exception as e:
                note(f"  viewer-section.png  (skipped: {e})")

        # 3. Search
        print(f"  Searching for '{search_query}'...")
        try:
            search_input = page.locator('input[type=search]')
            search_input.fill(search_query)
            page.wait_for_timeout(600)
            page.wait_for_selector('.search-result-row, .parts-placeholder', timeout=5_000)
            page.screenshot(path=str(run_dir / 'viewer-search.png'))
            note("  viewer-search.png")
        except Exception as e:
            note(f"  viewer-search.png  (skipped: {e})")

        # 4. Catalog browser with 'part' table
        print("  Taking catalog-browser.png...")
        try:
            page.goto(
                f'{base_url}/catalog-browser.html?catalog={catalog_id}&table=part',
                wait_until='networkidle',
            )
            page.wait_for_function(
                "() => document.querySelector('table.raw tbody tr')",
                timeout=15_000,
            )
            page.screenshot(path=str(run_dir / 'catalog-browser.png'))
            note("  catalog-browser.png")
        except Exception as e:
            note(f"  catalog-browser.png  (skipped: {e})")

        ctx.close()

except KeyboardInterrupt:
    print("\nAborted.")
    sys.exit(1)
finally:
    if server:
        server.terminate()

# ── Write summary ─────────────────────────────────────────────────────────────

note(f"\nDone. Output: {run_dir}")
summary_path = run_dir / 'summary.txt'
summary_path.write_text('\n'.join(lines))
print(f"Summary written to {summary_path}")
