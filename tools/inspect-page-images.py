#!/usr/bin/env python3
"""
Inspect image XObjects on a specific PDF page.
Reports dimensions, colorspace, bits-per-component, compression, and effective DPI.

Usage:
    uv run --with pypdf python tools/inspect-page-images.py <pdf> <page>
"""
import sys
import math

args = sys.argv[1:]
if len(args) < 2:
    print(__doc__)
    sys.exit(1)

pdf_path, page_num_str = args[0], args[1]
page_idx = int(page_num_str) - 1  # convert to 0-based

try:
    import pypdf
except ImportError:
    print("pypdf not installed. Run:")
    print("  uv run --with pypdf python tools/inspect-page-images.py ...")
    sys.exit(1)

reader = pypdf.PdfReader(pdf_path)
total_pages = len(reader.pages)
print(f"PDF: {pdf_path}  ({total_pages} pages)")

if page_idx < 0 or page_idx >= total_pages:
    print(f"Page {page_num_str} out of range (1..{total_pages})")
    sys.exit(1)

page = reader.pages[page_idx]
page_w = float(page.mediabox.width)
page_h = float(page.mediabox.height)
print(f"\nPage {page_num_str}: {page_w:.1f} x {page_h:.1f} pt  ({page_w/72:.2f} x {page_h/72:.2f} in)\n")

# Walk resources to find image XObjects
def walk_resources(resources, indent=0):
    if resources is None:
        return
    xobjects = resources.get("/XObject", {})
    for name, obj_ref in xobjects.items():
        try:
            obj = obj_ref.get_object() if hasattr(obj_ref, 'get_object') else obj_ref
        except Exception as e:
            print(f"  {' '*indent}XObject {name}: error resolving: {e}")
            continue

        subtype = obj.get("/Subtype", "?")
        if subtype == "/Image":
            w = obj.get("/Width", "?")
            h = obj.get("/Height", "?")
            cs = obj.get("/ColorSpace", "?")
            bpc = obj.get("/BitsPerComponent", "?")
            filters = obj.get("/Filter", None)
            if isinstance(cs, pypdf.generic.ArrayObject):
                cs = list(cs)
            if isinstance(filters, pypdf.generic.ArrayObject):
                filters = list(filters)
            # Compute effective DPI (assuming image fills page at its natural size)
            dpi_w = round(int(w) / (page_w / 72)) if w != "?" else "?"
            dpi_h = round(int(h) / (page_h / 72)) if h != "?" else "?"
            print(f"  {'  '*indent}Image XObject {name}:")
            print(f"    {'  '*indent}Size: {w} x {h} px")
            print(f"    {'  '*indent}ColorSpace: {cs}")
            print(f"    {'  '*indent}BitsPerComponent: {bpc}")
            print(f"    {'  '*indent}Filter: {filters}")
            print(f"    {'  '*indent}Effective DPI (if filling page): {dpi_w} x {dpi_h}")
            # Also check for SMask (transparency)
            smask = obj.get("/SMask", None)
            decode = obj.get("/Decode", None)
            print(f"    {'  '*indent}SMask: {smask is not None}  Decode: {decode}")
            # Check length
            try:
                raw_len = obj.get("/Length", "?")
                print(f"    {'  '*indent}Raw stream length: {raw_len}")
            except Exception:
                pass
        elif subtype == "/Form":
            inner_res = obj.get("/Resources", None)
            inner_res_obj = inner_res.get_object() if hasattr(inner_res, 'get_object') else inner_res
            bbox = obj.get("/BBox", "?")
            print(f"  {'  '*indent}Form XObject {name}: BBox={bbox}")
            walk_resources(inner_res_obj, indent + 1)

resources = page.get("/Resources", {})
if hasattr(resources, 'get_object'):
    resources = resources.get_object()

print("Image XObjects on this page:")
walk_resources(resources)

# Also dump page content stream summary
print("\nContent stream ops (first 80 with image-related ops highlighted):")
try:
    from pypdf.generic import ContentStream
    content = ContentStream(page.get_object()["/Contents"].get_object(), reader)
    count = 0
    for operands, operator in content.operations:
        op = operator.decode() if isinstance(operator, bytes) else str(operator)
        if op in ('Do', 'BI', 'EI', 'ID', 'cm', 'q', 'Q', 'gs'):
            mark = " <--" if op in ('Do', 'BI', 'ID') else ""
            print(f"  {op} {[str(o) for o in operands]}{mark}")
        count += 1
    print(f"  (total ops: {count})")
except Exception as e:
    print(f"  Could not parse content stream: {e}")
