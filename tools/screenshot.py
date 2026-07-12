#!/usr/bin/env python3
"""
Screenshot the viewer (or any page) using a persistent Playwright browser context.
The browser profile persists in tools/.playwright-profile/, so OPFS catalog data
survives between runs once a catalog has been ingested.

Usage:
    uv run --with playwright python tools/screenshot.py [options]

First-time setup (install Chromium, ~120 MB):
    uv run --with playwright python -m playwright install chromium

Automated ingest (no human needed — use ingest.py instead for full automation):
    uv run --with playwright python tools/screenshot.py --headed --url http://localhost:8080/ingest.html

Options:
    --url URL         Page to load (default: http://localhost:8080/viewer.html)
    --out FILE        Screenshot output path (default: screenshot.png)
    --headed          Show browser window
    --wait N          Extra seconds to wait after page load (default: 1)
    --start-server    Start HTTP server on :8080 before opening browser (auto-stops after)
    --eval JS      Evaluate JS expression and print result instead of screenshot
    --catalog ID   Append ?catalog=ID to URL (shorthand)
    --sqlite URL   Append ?sqlite=URL to URL (shorthand for file-mode viewer)
    --width W      Viewport width (default: 1440)
    --height H     Viewport height (default: 900)
"""
import sys
import time
import subprocess
import urllib.request
from pathlib import Path

args = sys.argv[1:]


def flag(name):
    return name in args


def opt(name, default=None):
    try:
        return args[args.index(name) + 1]
    except (ValueError, IndexError):
        return default


url = opt("--url", "http://localhost:8080/viewer.html")
out = opt("--out", "screenshot.png")
headed = flag("--headed")
wait = float(opt("--wait", "1"))
js_eval = opt("--eval")
catalog = opt("--catalog")
sqlite_url = opt("--sqlite")
width = int(opt("--width", "1440"))
height = int(opt("--height", "900"))
start_server = flag("--start-server")

if catalog:
    sep = "&" if "?" in url else "?"
    url += f"{sep}catalog={catalog}"
if sqlite_url:
    sep = "&" if "?" in url else "?"
    url += f"{sep}sqlite={sqlite_url}"

profile_dir = Path(__file__).parent / ".playwright-profile"
profile_dir.mkdir(exist_ok=True)

# Optionally start HTTP server
_server_proc = None
if start_server:
    docs_dir = Path(__file__).parent.parent / "docs"
    _server_proc = subprocess.Popen(
        ["python", "-m", "http.server", "8080", "--directory", str(docs_dir)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(30):
        try:
            urllib.request.urlopen("http://localhost:8080/", timeout=0.5)
            break
        except Exception:
            time.sleep(0.25)

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    if _server_proc:
        _server_proc.terminate()
    print("Playwright not installed. Run:")
    print("  uv run --with playwright python -m playwright install chromium")
    sys.exit(1)

try:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(profile_dir),
            headless=not headed,
            viewport={"width": width, "height": height},
            args=["--no-first-run", "--no-default-browser-check"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        print(f"Loading: {url}")
        page.goto(url, wait_until="networkidle")

        if wait > 0:
            time.sleep(wait)

        if js_eval:
            result = page.evaluate(js_eval)
            print(result)
        else:
            page.screenshot(path=out, full_page=False)
            print(f"Saved:   {out}")

        if not headed:
            ctx.close()
        else:
            print("Browser open — press Enter to close.")
            input()
            ctx.close()
finally:
    if _server_proc:
        _server_proc.terminate()
