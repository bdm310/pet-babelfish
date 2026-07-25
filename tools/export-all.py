#!/usr/bin/env python3
"""
Export every catalog from the Playwright OPFS profile into a single zip file.
Use the resulting zip with the ↑ All button in catalog-browser.html.

Usage:
    uv run --with playwright python tools/export-all.py
    uv run --with playwright python tools/export-all.py --out my-catalogs.zip
    uv run --with playwright python tools/export-all.py --port 9090
"""
import sys, subprocess, time, urllib.request, base64, zipfile
from pathlib import Path

args = sys.argv[1:]


def opt(n, default=None):
    try:
        return args[args.index(n) + 1]
    except (ValueError, IndexError):
        return default


def flag(n):
    return n in args


port    = int(opt('--port', '8080'))
out     = Path(opt('--out', 'catalogs.zip'))
headed  = flag('--headed')

docs_dir    = Path(__file__).parent.parent / 'docs'
profile_dir = Path(__file__).parent / '.playwright-profile'
profile_dir.mkdir(exist_ok=True)

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

try:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(profile_dir),
            headless=not headed,
            args=['--no-first-run', '--no-default-browser-check'],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(f'{base_url}/index.html', wait_until='load')

        # Step 1: list all file paths in OPFS (just strings, small).
        # Diagrams live in section.diagram_blob, so the DB is the whole catalog.
        file_list = page.evaluate(
            """async () => {
                const root  = await navigator.storage.getDirectory();
                const paths = [];
                for await (const [catId, catHandle] of root.entries()) {
                    if (catHandle.kind !== 'directory') continue;
                    try { await catHandle.getFileHandle('catalog.sqlite'); }
                    catch { continue; }
                    paths.push(catId + '/catalog.sqlite');
                }
                return paths;
            }"""
        )

        if not file_list:
            print("No catalogs found in OPFS. Run tools/ingest.py first.")
            ctx.close()
            if server:
                server.terminate()
            sys.exit(1)

        catalog_ids = sorted({p.split('/')[0] for p in file_list})
        print(f"Found {len(catalog_ids)} catalog(s): {', '.join(catalog_ids)}")
        print(f"Total files: {len(file_list)}")

        # Step 2: fetch one file at a time to stay under Node's string size limit
        exports = {}
        for zip_path in file_list:
            b64 = page.evaluate(
                """async (path) => {
                    const segs   = path.split('/');
                    let handle   = await navigator.storage.getDirectory();
                    for (const seg of segs.slice(0, -1))
                        handle = await handle.getDirectoryHandle(seg);
                    const fh  = await handle.getFileHandle(segs[segs.length - 1]);
                    const buf = await (await fh.getFile()).arrayBuffer();
                    const arr = new Uint8Array(buf);
                    const CHUNK = 8192;
                    let bin = '';
                    for (let i = 0; i < arr.length; i += CHUNK)
                        bin += String.fromCharCode(...arr.subarray(i, i + CHUNK));
                    return btoa(bin);
                }""",
                zip_path,
            )
            exports[zip_path] = base64.b64decode(b64)
            print(f"  ✓ {zip_path}: {len(exports[zip_path]) / 1024:.0f} KB")

        ctx.close()

finally:
    if server:
        server.terminate()

if not exports:
    print("Nothing exported.")
    sys.exit(1)

# ── Write zip ─────────────────────────────────────────────────────────────────

# Stored, not deflated: most of each DB is WebP diagram blobs, which deflate
# shrinks by ~2% while costing seconds.
with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_STORED) as zf:
    for zip_path, data in exports.items():
        zf.writestr(zip_path, data)

print(f"\nSaved {len(exports)} catalog(s) → {out.resolve()}")
