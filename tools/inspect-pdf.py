#!/usr/bin/env python3
"""
Inspect a Porsche PET catalog PDF — show page text, TOC, and structure.
Useful for comparing what the source PDF contains against what was ingested.

Usage:
    uv run --with pdfplumber python tools/inspect-pdf.py <pdf> [options]

Options:
    --pages 1-10     Only show pages in this range (1-indexed, inclusive)
    --search TEXT    Only show pages containing TEXT (case-insensitive)
    --toc            Show PDF outline/bookmarks and exit
    --head N         Max chars to show per page (default: 800)
    --tables         Try to extract tables from pages (slower)
"""
import sys
from pathlib import Path

# Page text and the rule lines contain characters cp1252 can't encode; without this
# a piped or redirected run raises UnicodeEncodeError instead of printing.
for _s in (sys.stdout, sys.stderr):
    try: _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception: pass

args = sys.argv[1:]


def flag(n):
    return n in args


def opt(n, default=None):
    try:
        return args[args.index(n) + 1]
    except (ValueError, IndexError):
        return default


pdf_path = next((a for a in args if not a.startswith("--")), None)
if not pdf_path:
    print(__doc__)
    sys.exit(1)

try:
    import pdfplumber
except ImportError:
    print("pdfplumber not installed. Run:")
    print("  uv run --with pdfplumber python tools/inspect-pdf.py ...")
    sys.exit(1)


def parse_range(s):
    if not s:
        return None
    parts = s.split("-")
    lo = int(parts[0])
    hi = int(parts[1]) if len(parts) > 1 else lo
    return range(lo - 1, hi)


page_range = parse_range(opt("--pages"))
search_text = (opt("--search") or "").lower()
head_n = int(opt("--head", "800"))
show_toc = flag("--toc")
show_tables = flag("--tables")

with pdfplumber.open(pdf_path) as pdf:
    print(f"PDF:   {pdf_path}")
    print(f"Pages: {len(pdf.pages)}")

    # Outline/bookmarks via underlying pdfminer doc
    try:
        toc = pdf.doc.get_toc()
        if toc:
            print(f"\nOutline ({len(toc)} entries):")
            for level, title, page in toc[:80]:
                indent = "  " * (level - 1)
                print(f"  {indent}p{page:>4}  {title}")
            if len(toc) > 80:
                print(f"  ... ({len(toc) - 80} more)")
        else:
            print("\nNo PDF outline found.")
    except Exception as e:
        print(f"\nOutline unavailable: {e}")

    if show_toc:
        sys.exit(0)

    pages_to_show = page_range if page_range is not None else range(len(pdf.pages))
    shown = 0
    for i in pages_to_show:
        if i >= len(pdf.pages):
            break
        pg = pdf.pages[i]
        text = pg.extract_text() or ""
        if search_text and search_text not in text.lower():
            continue

        print(f"\n{'=' * 70}")
        print(f"Page {i + 1}  ({pg.width:.0f} x {pg.height:.0f} pt)")
        print("─" * 70)

        if show_tables:
            tables = pg.extract_tables()
            if tables:
                for ti, tbl in enumerate(tables):
                    print(f"[Table {ti + 1}]")
                    for row in tbl:
                        cells = [str(c or "").replace("\n", " ") for c in row]
                        print("  | " + " | ".join(cells))
                print()

        snippet = text[:head_n]
        print(snippet)
        if len(text) > head_n:
            print(f"  … ({len(text) - head_n} more chars, use --head to expand)")

        shown += 1
        if shown >= 50:
            print(f"\n[Stopped after 50 pages — use --pages to narrow range]")
            break

    if shown == 0:
        if search_text:
            print(f'\nNo pages matched "{search_text}".')
        else:
            print("\nNo pages to show.")
