#!/usr/bin/env python3
"""
Check diagram OCR callout coverage across all ingested catalogs.
Finds sections where callout numbers expected from the parts list
were not discovered by OCR.

Usage:
    uv run --with playwright python tools/ocr-coverage.py
    uv run --with playwright python tools/ocr-coverage.py --catalog-id 997tt
    uv run --with playwright python tools/ocr-coverage.py --verbose
"""

import sys, subprocess, time, urllib.request, base64, sqlite3, tempfile, os
from pathlib import Path

args = sys.argv[1:]


def flag(n):
    return n in args


def opt(n, default=None):
    try:
        return args[args.index(n) + 1]
    except (ValueError, IndexError):
        return default


filter_catalog = opt('--catalog-id')
verbose = flag('--verbose') or flag('-v')
port = int(opt('--port', '8080'))

docs_dir    = Path(__file__).parent.parent / 'docs'
profile_dir = Path(__file__).parent / '.playwright-profile'
profile_dir.mkdir(exist_ok=True)

# ── HTTP server ───────────────────────────────────────────────────────────────

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


server = start_server(docs_dir, port)
base_url = f'http://localhost:{port}'

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    if server:
        server.terminate()
    print("Playwright not found. Run:")
    print("  uv run --with playwright python -m playwright install chromium")
    sys.exit(1)

try:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(profile_dir),
            headless=True,
            args=['--no-first-run', '--no-default-browser-check'],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(f'{base_url}/index.html', wait_until='load')

        # Discover available catalogs
        catalog_ids = page.evaluate("""async () => {
            const root = await navigator.storage.getDirectory();
            const ids = [];
            for await (const [id, handle] of root.entries()) {
                if (handle.kind !== 'directory') continue;
                try { await handle.getFileHandle('catalog.sqlite'); ids.push(id); }
                catch { /* no sqlite */ }
            }
            return ids.sort();
        }""")

        if not catalog_ids:
            print("No catalogs found in OPFS. Run tools/ingest.py first.")
            ctx.close()
            sys.exit(1)

        if filter_catalog:
            if filter_catalog not in catalog_ids:
                print(f"Catalog '{filter_catalog}' not found. Available: {', '.join(catalog_ids)}")
                ctx.close()
                sys.exit(1)
            catalog_ids = [filter_catalog]

        print(f"Analyzing {len(catalog_ids)} catalog(s): {', '.join(catalog_ids)}\n")

        for cat_id in catalog_ids:
            print(f"=== {cat_id} ===")

            sqlite_b64 = page.evaluate("""async (id) => {
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

            if sqlite_b64.startswith('ERROR:'):
                print(f"  Could not load: {sqlite_b64[6:]}\n")
                continue

            sqlite_bytes = base64.b64decode(sqlite_b64)

            tmp_f = tempfile.NamedTemporaryFile(suffix='.sqlite', delete=False)
            try:
                tmp_f.write(sqlite_bytes)
                tmp_f.close()
                conn = sqlite3.connect(tmp_f.name)
                cur = conn.cursor()

                total_callouts = cur.execute('SELECT COUNT(*) FROM callout').fetchone()[0]
                sections_with_callout_parts = cur.execute("""
                    SELECT COUNT(DISTINCT s.id)
                    FROM section s JOIN part p ON p.section_id = s.id
                    WHERE p.position GLOB '(*)'
                """).fetchone()[0]
                total_expected = cur.execute("""
                    SELECT COUNT(*) FROM (
                        SELECT s.id, p.position
                        FROM section s JOIN part p ON p.section_id = s.id
                        WHERE p.position GLOB '(*)'
                        GROUP BY s.id, p.position
                    )
                """).fetchone()[0]

                # Per-section gap analysis
                rows = cur.execute("""
                    WITH expected AS (
                        SELECT
                            s.id   AS section_id,
                            s.number AS section_number,
                            mg.number AS mg_number,
                            CAST(TRIM(REPLACE(REPLACE(p.position,'(',''),')','')) AS INTEGER) AS expected_num
                        FROM section s
                        JOIN main_group mg ON s.main_group_id = mg.id
                        JOIN part p ON p.section_id = s.id
                        WHERE p.position GLOB '(*)'
                        GROUP BY s.id, p.position
                    ),
                    matched AS (
                        SELECT
                            e.section_id, e.section_number, e.mg_number, e.expected_num,
                            CASE WHEN c.number IS NULL THEN 0 ELSE 1 END AS found
                        FROM expected e
                        LEFT JOIN callout c
                            ON c.section_id = e.section_id AND c.number = e.expected_num
                    )
                    SELECT
                        section_number,
                        mg_number,
                        COUNT(*)       AS expected_count,
                        SUM(found)     AS found_count,
                        COUNT(*) - SUM(found) AS missing_count,
                        GROUP_CONCAT(CASE WHEN found=0 THEN expected_num END) AS missing_nums
                    FROM matched
                    GROUP BY section_id, section_number
                    HAVING missing_count > 0
                    ORDER BY missing_count DESC, section_number
                """).fetchall()

                total_missing = sum(r[4] for r in rows)
                pct_found = 100 * (total_expected - total_missing) // max(total_expected, 1)

                print(f"  Sections w/ callout parts : {sections_with_callout_parts}")
                print(f"  Expected callout positions: {total_expected}")
                print(f"  OCR'd callouts in DB      : {total_callouts}")
                print(f"  Missing                   : {total_missing} ({100 - pct_found}%)")
                print(f"  Sections with gaps        : {len(rows)}")

                if rows:
                    print(f"\n  {'Section':<12} {'MG':>3}  {'Exp':>4} {'Fnd':>4} {'Miss':>5}  Missing nums")
                    print(f"  {'-'*12} {'-'*3}  {'-'*4} {'-'*4} {'-'*5}  {'-'*30}")
                    for section_num, mg_num, expected, found, missing, missing_nums in rows:
                        nums_str = missing_nums or ''
                        # Sort missing nums numerically
                        try:
                            sorted_nums = sorted(int(n) for n in nums_str.split(',') if n)
                            nums_str = ','.join(str(n) for n in sorted_nums)
                        except Exception:
                            pass
                        if not verbose and len(nums_str) > 40:
                            nums_str = nums_str[:37] + '...'
                        print(f"  {section_num:<12} {mg_num:>3}  {expected:>4} {found:>4} {missing:>5}  {nums_str}")

                # Summary: sections with perfect coverage
                perfect = cur.execute("""
                    WITH expected AS (
                        SELECT s.id, COUNT(DISTINCT p.position) AS cnt
                        FROM section s JOIN part p ON p.section_id = s.id
                        WHERE p.position GLOB '(*)'
                        GROUP BY s.id
                    ),
                    found AS (
                        SELECT section_id, COUNT(*) AS cnt FROM callout GROUP BY section_id
                    )
                    SELECT COUNT(*) FROM expected e
                    JOIN found f ON f.section_id = e.id AND f.cnt >= e.cnt
                """).fetchone()[0]
                print(f"\n  Sections with full coverage: {perfect}/{sections_with_callout_parts}")

                conn.close()
            finally:
                os.unlink(tmp_f.name)

            print()

        ctx.close()

finally:
    if server:
        server.terminate()
