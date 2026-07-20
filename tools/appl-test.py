#!/usr/bin/env python3
"""Run tools/appl-test.js against docs/appl.js in the repo's chromium.

There is no node in this environment, but Playwright's chromium is already a
project dependency, so the JS self-test runs there instead.

    uv run --with playwright python tools/appl-test.py
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
APPL = ROOT / "docs" / "appl.js"
TEST = ROOT / "tools" / "appl-test.js"

for _s in (sys.stdout, sys.stderr):
    try: _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception: pass

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.on("console", lambda m: print(m.text))
    page.on("pageerror", lambda e: print(f"PAGE ERROR: {e}"))
    page.goto("about:blank")
    page.add_script_tag(content=APPL.read_text(encoding="utf-8"))
    page.add_script_tag(content=TEST.read_text(encoding="utf-8"))
    result = page.evaluate("window.__APPL_TEST__ || {pass: 0, fail: -1}")
    browser.close()

if result["fail"] != 0:
    print(f"\n{result['fail']} FAILED")
    sys.exit(1)
print("OK")
