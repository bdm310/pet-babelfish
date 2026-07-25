#!/usr/bin/env python3
"""
Automated PDF ingest via Playwright - no human interaction required.
Starts a local HTTP server, uploads the PDF to ingest.html, waits for completion.
OPFS data persists in tools/.playwright-profile/ for subsequent verify.py runs.

Usage:
    uv run --with playwright python tools/ingest.py <pdf> [options]

    First-time Chromium install (~120 MB):
        uv run --with playwright python -m playwright install chromium

Options:
    --catalog-id ID   Storage key (default: PDF filename without .pdf)
    --port N          HTTP server port (default: 8080)
    --parts-only      Re-extract parts text, skip diagram rendering and OCR.
                      Use this when iterating on part extraction logic.
                      If the catalog does not yet exist, a full ingest runs instead.
    --force           Full ingest regardless of existing data (re-runs OCR).
    --headed          Show browser window (useful for debugging)
    --timeout N       Max ingest minutes (default: 30)
"""
import sys, subprocess, time, urllib.request
sys.stdout.reconfigure(encoding='utf-8')
from pathlib import Path

# ── Arg parsing ──────────────────────────────────────────────────────────────

args = sys.argv[1:]


def flag(n):
    return n in args


def opt(n, default=None):
    try:
        return args[args.index(n) + 1]
    except (ValueError, IndexError):
        return default


pdf_path = next(
    (Path(a).resolve() for a in args if not a.startswith('--') and a.lower().endswith('.pdf')),
    None,
)
port = int(opt('--port', '8080'))
force = flag('--force')
parts_only = flag('--parts-only')
headed = flag('--headed')
timeout_min = int(opt('--timeout', '30'))

catalog_id = opt('--catalog-id')
if not catalog_id and pdf_path:
    catalog_id = pdf_path.stem.replace(' ', '-')

if not pdf_path or not catalog_id:
    print(__doc__)
    sys.exit(1)

if not pdf_path.exists():
    print(f"Error: PDF not found: {pdf_path}")
    sys.exit(1)

docs_dir = Path(__file__).parent.parent / 'docs'

# ── HTTP server ───────────────────────────────────────────────────────────────

def _server_up(port):
    try:
        urllib.request.urlopen(f'http://localhost:{port}/', timeout=0.5)
        return True
    except Exception:
        return False


def start_server(docs_dir, port):
    if _server_up(port):
        print(f"Server already running on port {port}, reusing it.")
        return None  # caller won't need to stop it
    proc = subprocess.Popen(
        ['python', '-m', 'http.server', str(port), '--directory', str(docs_dir)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(40):
        if _server_up(port):
            return proc
        time.sleep(0.25)
    proc.terminate()
    raise RuntimeError(f"HTTP server failed to start on port {port}")


print(f"Starting HTTP server on :{port}...")
server = start_server(docs_dir, port)

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
base_url = f'http://localhost:{port}'

# Clear V8 code cache so changes to ingest.worker.js always take effect.
import shutil
for cache_name in ('Cache', 'Code Cache'):
    p = profile_dir / 'Default' / cache_name
    if p.exists():
        shutil.rmtree(p, ignore_errors=True)

try:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(profile_dir),
            headless=not headed,
            viewport={'width': 1440, 'height': 900},
            args=['--no-first-run', '--no-default-browser-check', '--disk-cache-size=1'],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        # ── Check existing ─────────────────────────────────────────────────────
        print(f"Checking OPFS for catalog '{catalog_id}'...")
        page.goto(f'{base_url}/index.html', wait_until='load')
        already = page.evaluate(
            """async (id) => {
                try {
                    const root = await navigator.storage.getDirectory();
                    await (await root.getDirectoryHandle(id)).getFileHandle('catalog.sqlite');
                    return true;
                } catch { return false; }
            }""",
            catalog_id,
        )
        # ── Decide mode ────────────────────────────────────────────────────────
        if force:
            # --force always runs full ingest regardless of everything else
            do_parts_only = False
        elif parts_only and already:
            # Catalog exists and we only care about parts - skip OCR
            do_parts_only = True
        elif parts_only and not already:
            # Can't skip OCR on first ingest - diagrams haven't been extracted yet
            print("Note: catalog not found in OPFS; running full ingest (OCR required for first ingest).")
            do_parts_only = False
        elif already:
            print(f"Catalog '{catalog_id}' already ingested. Use --parts-only to re-extract parts or --force to re-run OCR.")
            ctx.close()
            sys.exit(0)
        else:
            do_parts_only = False

        # ── Ingest ────────────────────────────────────────────────────────────
        mode_label = 'parts-only re-ingest' if do_parts_only else 'full ingest (OCR)'
        print(f"{mode_label}: '{pdf_path.name}' -> catalog '{catalog_id}'")
        page.goto(f'{base_url}/ingest.html', wait_until='load')

        page.fill('#catalogId', catalog_id)
        page.locator('#fileInput').set_input_files(str(pdf_path))
        if do_parts_only:
            page.check('#partsOnly')

        # Button enables once file + ID are set
        page.wait_for_selector('#ingestBtn:not([disabled])', timeout=10_000)
        page.click('#ingestBtn')
        print(f"Worker started. Waiting up to {timeout_min} minutes...")

        def _log_progress():
            """Print latest log line for visibility."""
            try:
                last = page.locator('.log-line').last
                if last.count():
                    txt = last.inner_text()
                    if txt:
                        print(f"  {txt[:120]}", end='\r')
            except Exception:
                pass

        # Poll until done or error. Completion is signalled by the #result panel
        # becoming visible (the worker un-hides it on 'done'); check real visibility
        # via offsetParent, NOT viewerLink.style.display - the link carries no inline
        # display, so a style check reads '' and fires before the ingest even starts.
        result_handle = page.wait_for_function(
            """() => {
                const res = document.getElementById('result');
                const errs = document.querySelectorAll('.log-line.err');
                if (res && res.offsetParent !== null) return 'done';
                if (errs.length) return 'error:' + errs[0].textContent.trim();
                return null;
            }""",
            timeout=timeout_min * 60 * 1000,
            polling=2000,
        )
        print()  # newline after \r progress

        outcome = result_handle.json_value()
        if outcome == 'done':
            stats = page.evaluate(
                "() => document.getElementById('result')?.innerText.trim() || ''"
            )
            print(f"✓ Ingest complete. {stats}")
        else:
            print(f"✗ {outcome}")
            ctx.close()
            sys.exit(1)

        ctx.close()

except KeyboardInterrupt:
    print("\nAborted.")
    sys.exit(1)
finally:
    if server:
        server.terminate()
