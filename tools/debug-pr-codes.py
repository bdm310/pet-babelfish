#!/usr/bin/env python3
"""
Simulate the JS parsePRCodesPage logic on the actual PDF to diagnose
why only ~20 PR codes are being extracted.

Usage:
    uv run --with pdfplumber python tools/debug-pr-codes.py <pdf>
"""
import sys, re

try:
    import pdfplumber
except ImportError:
    print("pdfplumber not installed. Run with: uv run --with pdfplumber python ...")
    sys.exit(1)

pdf_path = next((a for a in sys.argv[1:] if not a.startswith('--')), None)
if not pdf_path:
    print(__doc__)
    sys.exit(1)

TOLERANCE = 3

def group_into_rows(words, page_height):
    """Simulate JS groupIntoRows(items, pageHeight, tolerance=3)."""
    rows = {}  # y -> [word, ...]
    for w in words:
        # pdfplumber word dict has 'top' (distance from top of page)
        # JS uses: y = Math.round(pageHeight - it.transform[5])  (transform[5] is y from bottom)
        # pdfplumber 'top' ≈ pageHeight - transform[5], so we use top directly
        y = round(w['top'])
        placed = False
        for ry in list(rows.keys()):
            if abs(ry - y) <= TOLERANCE:
                rows[ry].append(w)
                placed = True
                break
        if not placed:
            rows[y] = [w]
    # Sort by y (top to bottom), items within row sorted by x
    return [
        sorted(ws, key=lambda w: w['x0'])
        for _, ws in sorted(rows.items())
    ]

CODE_RE = re.compile(r'^\d{3}$|^[A-Z][A-Z0-9]{2,3}$')

def parse_pr_codes_page(rows):
    in_data = False
    current = None
    codes = []

    for row_words in rows:
        texts = [w['text'].strip() for w in row_words if w['text'].strip()]
        if not texts:
            continue

        if not in_data:
            if 'NR' in texts and 'Description' in ' '.join(texts):
                in_data = True
                print(f"  [header found]: {texts}")
            else:
                print(f"  [pre-header]:   {texts[:6]}{'...' if len(texts)>6 else ''}")
            continue

        # Skip repeated page headers
        if (texts[0] == 'Optional Equipment' or
                any(t.startswith('Model:') for t in texts) or
                any(re.match(r'^\d{2}\.\d{2}\.\d{4}', t) for t in texts)):
            print(f"  [skip header]:  {texts[:4]}")
            continue

        if texts[0] == '*':
            continue

        if CODE_RE.match(texts[0]):
            if current:
                codes.append(current)
            current = {'code': texts[0], 'description': ' '.join(texts[1:])}
            print(f"  [code]:         {texts[0]!r} -> {current['description'][:50]}")
        elif current:
            current['description'] = (current['description'] + ' ' + ' '.join(texts)).strip()
            print(f"  [continuation]: {texts[:4]}")
        else:
            print(f"  [no-match]:     {texts[:4]}")

    if current:
        codes.append(current)
    return codes

with pdfplumber.open(pdf_path) as pdf:
    all_codes = []
    print(f"PDF: {pdf_path}  ({len(pdf.pages)} pages)")

    for i, page in enumerate(pdf.pages):
        words = page.extract_words(keep_blank_chars=False, x_tolerance=3, y_tolerance=3)
        text = ' '.join(w['text'] for w in words)

        if 'Optional Equipment' not in text:
            continue

        print(f"\n{'='*60}")
        print(f"Page {i+1}: Optional Equipment page")
        rows = group_into_rows(words, page.height)
        codes = parse_pr_codes_page(rows)
        all_codes.extend(codes)
        print(f"  -> {len(codes)} codes extracted from this page")

    print(f"\n{'='*60}")
    print(f"TOTAL: {len(all_codes)} PR codes")
    for c in all_codes:
        print(f"  {c['code']:6s}  {c['description'][:70]}")
