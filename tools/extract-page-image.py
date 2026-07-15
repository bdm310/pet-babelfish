#!/usr/bin/env python3
"""
Extract a specific image XObject from a PDF page and save it as PNG.
Also renders the page to PNG for comparison.

Usage:
    uv run --with pypdf --with pillow python tools/extract-page-image.py <pdf> <page> [image-name]

image-name defaults to auto-detecting the largest painted image on the page.
"""
import sys
import io
import struct

args = sys.argv[1:]
if len(args) < 2:
    print(__doc__)
    sys.exit(1)

pdf_path = args[0]
page_num_str = args[1]
page_idx = int(page_num_str) - 1
target_image = args[2] if len(args) > 2 else None

try:
    import pypdf
except ImportError:
    print("pypdf not installed. Run with: uv run --with pypdf --with pillow ...")
    sys.exit(1)

try:
    from PIL import Image
except ImportError:
    print("Pillow not installed. Run with: uv run --with pypdf --with pillow ...")
    sys.exit(1)

reader = pypdf.PdfReader(pdf_path)
page = reader.pages[page_idx]

# Scan content stream for Do operations to find painted images
from pypdf.generic import ContentStream

print(f"Page {page_num_str}: scanning content stream for painted images...")
try:
    content = ContentStream(page.get_object()["/Contents"].get_object(), reader)
    ctm = [1, 0, 0, 1, 0, 0]  # current transform matrix [a,b,c,d,e,f]
    stack = []
    painted = []

    def mat_mul(m, n):
        return [
            m[0]*n[0] + m[2]*n[1],
            m[1]*n[0] + m[3]*n[1],
            m[0]*n[2] + m[2]*n[3],
            m[1]*n[2] + m[3]*n[3],
            m[0]*n[4] + m[2]*n[5] + m[4],
            m[1]*n[4] + m[3]*n[5] + m[5],
        ]

    for operands, operator in content.operations:
        op = operator.decode() if isinstance(operator, bytes) else str(operator)
        if op == 'q':
            stack.append(ctm[:])
        elif op == 'Q':
            if stack:
                ctm = stack.pop()
        elif op == 'cm':
            n = [float(str(x)) for x in operands]
            ctm = mat_mul(ctm, n)
        elif op == 'Do':
            name = str(operands[0]) if operands else ''
            # corners of unit square under current CTM
            a, b, c, d, e, f = ctm
            xs = [e, e+a, e+c, e+a+c]
            ys = [f, f+b, f+d, f+b+d]
            x0, x1 = min(xs), max(xs)
            y0, y1 = min(ys), max(ys)
            area = (x1-x0) * (y1-y0)
            painted.append((name, x0, y0, x1, y1, area))
            print(f"  Do {name}: rect=({x0:.1f},{y0:.1f},{x1:.1f},{y1:.1f}) area={area:.0f}")

    if not painted:
        print("No painted XObjects found.")
        sys.exit(1)

    # Pick largest by area (that's the diagram) unless overridden
    if target_image:
        candidates = [(n, *rest) for n, *rest in painted if n.lstrip('/') == target_image.lstrip('/')]
        if not candidates:
            print(f"Image {target_image} not found in painted list.")
            sys.exit(1)
        best = candidates[0]
    else:
        best = max(painted, key=lambda x: x[5])

    name, x0, y0, x1, y1, area = best
    print(f"\nExtracting: {name}  ({x0:.1f},{y0:.1f}) to ({x1:.1f},{y1:.1f})  area={area:.0f}")
except Exception as e:
    print(f"Content stream parse error: {e}")
    import traceback; traceback.print_exc()
    sys.exit(1)

# Get the image XObject resource
resources = page.get("/Resources", {})
if hasattr(resources, 'get_object'):
    resources = resources.get_object()
xobjects = resources.get("/XObject", {})

img_name = name.lstrip('/')
if '/' + img_name not in xobjects and img_name not in xobjects:
    # Try without slash
    key = '/' + img_name if '/' + img_name in xobjects else img_name
else:
    key = '/' + img_name if '/' + img_name in xobjects else img_name

img_obj = None
for k in ['/' + img_name, img_name]:
    if k in xobjects:
        obj = xobjects[k]
        img_obj = obj.get_object() if hasattr(obj, 'get_object') else obj
        break

if img_obj is None:
    print(f"XObject {name} not found in resources.")
    sys.exit(1)

# Report properties
w = img_obj.get("/Width", "?")
h = img_obj.get("/Height", "?")
cs = img_obj.get("/ColorSpace", "?")
bpc = img_obj.get("/BitsPerComponent", "?")
filters = img_obj.get("/Filter", None)
if isinstance(filters, pypdf.generic.ArrayObject):
    filters = list(filters)
print(f"  Size: {w} x {h} px")
print(f"  ColorSpace: {cs}")
print(f"  BitsPerComponent: {bpc}")
print(f"  Filter: {filters}")

# Extract the decoded image data using pypdf's image extraction
out_name = f"page{page_num_str}_{img_name}.png"
try:
    # Use pypdf's built-in image extractor
    imgs = list(page.images)
    print(f"\nPage.images found: {len(imgs)} images")
    for img in imgs:
        print(f"  name={img.name} size={img.image.size if hasattr(img, 'image') and img.image else '?'}")

    # Find matching image
    matched = None
    for img in imgs:
        if img.name.lstrip('/') == img_name.lstrip('/'):
            matched = img
            break

    if matched and hasattr(matched, 'image') and matched.image:
        pil_img = matched.image
        pil_img.save(out_name)
        print(f"\nSaved: {out_name}  ({pil_img.size[0]}x{pil_img.size[1]} px, mode={pil_img.mode})")
    else:
        print(f"\nCould not extract image via page.images API. Trying raw stream...")
        # Try raw data
        data = img_obj.get_data()
        print(f"  Raw decoded data: {len(data)} bytes")

        w_int = int(str(w))
        h_int = int(str(h))
        bpc_int = int(str(bpc)) if bpc != '?' else 8

        if bpc_int == 1:
            # 1-bpp: unpack bits
            row_bytes = (w_int + 7) // 8
            expected = row_bytes * h_int
            print(f"  Expected 1-bpp bytes: {expected}, got: {len(data)}")
            pixels = []
            for y in range(h_int):
                for x in range(w_int):
                    byte_idx = y * row_bytes + (x >> 3)
                    if byte_idx < len(data):
                        bit = (data[byte_idx] >> (7 - (x & 7))) & 1
                        pixels.append(0 if bit else 255)  # 1=black, 0=white in CCITT
                    else:
                        pixels.append(255)
            img_out = Image.new('L', (w_int, h_int))
            img_out.putdata(pixels)
            img_out.save(out_name)
            print(f"Saved 1-bpp image: {out_name}")
        else:
            print(f"  bpc={bpc_int}, skipping raw extraction")

except Exception as e:
    print(f"Image extraction error: {e}")
    import traceback; traceback.print_exc()

print(f"\nDone. Check {out_name}")
