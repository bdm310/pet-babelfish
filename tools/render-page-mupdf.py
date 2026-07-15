#!/usr/bin/env python3
"""Render a PDF page and extract its painted image via PyMuPDF for ground-truth comparison.
Usage: uv run --with pymupdf python tools/render-page-mupdf.py <pdf> <page>"""
import sys
import fitz  # PyMuPDF

pdf, page_num = sys.argv[1], int(sys.argv[2])
doc = fitz.open(pdf)
page = doc[page_num - 1]

# Full-page render at 2x
pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
out1 = f"mupdf_page{page_num}_render.png"
pix.save(out1)
print(f"Rendered page -> {out1}  ({pix.width}x{pix.height})")

# Extract each image xobject
for img in page.get_images(full=True):
    xref = img[0]
    name = img[7]
    try:
        base = fitz.Pixmap(doc, xref)
        # 1-bpp images -> ensure viewable
        if base.n < 4 and base.colorspace and base.colorspace.n == 1:
            pass
        out = f"mupdf_page{page_num}_{name}_x{xref}.png"
        if base.colorspace is None or base.n > 4:
            base = fitz.Pixmap(fitz.csGRAY, base)
        base.save(out)
        print(f"  {name} xref={xref}: {base.width}x{base.height} n={base.n} -> {out}")
    except Exception as e:
        print(f"  {name} xref={xref}: ERROR {e}")
