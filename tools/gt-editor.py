#!/usr/bin/env python3
# /// script
# dependencies = ["numpy", "pillow"]
# ///
"""
Local web editor for reviewing and fixing diagram-callout ground truth.

Serves a single-page UI over the groundtruth/<catalog>/ files. For each section it
shows the diagram with three box layers - GT (editable, green), Vision (blue) and
Tesseract (orange) as reference - plus the parts-list expected set as a completeness
checklist. You can add/move/resize/delete boxes, fix numbers, one-click-accept a
reference box into GT, edit the absent list, and mark a section verified. Saves write
straight back to groundtruth.json (atomic replace).

Diagram blobs are CCITT Group-4 bitstreams (not images), so /api/diagram decodes
them to PNG server-side via ocr/ccitt_decode.py before serving.

Usage (deps auto-install from the inline script metadata above - note: no `python`):
    uv run tools/gt-editor.py              # http://localhost:8770
    uv run tools/gt-editor.py --port 9000
"""
import sys, json, sqlite3, os, io, re, shutil, threading, urllib.parse
from collections import Counter
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# A callout id is a string token: 1-3 digits + optional /sub ('2', '2/1'). '' = unnumbered.
ID_RE = re.compile(r'^\d{1,3}(?:/\d{1,3})?$')

def natkey(tok):
    # natural sort: leading int then sub-int, so '2' < '2/1' < '10'
    return tuple(int(p) for p in str(tok).split('/'))

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'ocr'))
import ccitt_decode
from PIL import Image

args = sys.argv[1:]
def opt(n, d=None):
    try: return args[args.index(n) + 1]
    except (ValueError, IndexError): return d

PORT = int(opt('--port', '8770'))
ROOT = Path(__file__).parent.parent / 'groundtruth'
HTML = Path(__file__).parent / 'gt-editor.html'

# ThreadingHTTPServer handles /api/save requests concurrently; the client fires one
# save per edit, so two quick edits used to race the read-modify-write and the shared
# temp file, corrupting groundtruth.json (a stray trailing brace). Serialise saves.
_save_lock = threading.Lock()


# ── data helpers ────────────────────────────────────────────────────────────────

def catalogs():
    return sorted(d.name for d in ROOT.iterdir()
                  if (d / 'catalog.sqlite').exists() and (d / 'groundtruth.json').exists())

def _load(cat, name, default):
    p = ROOT / cat / name
    if not p.exists():
        return default
    txt = p.read_text('utf-8')
    try:
        return json.loads(txt)
    except json.JSONDecodeError as e:
        # Never let one corrupt file brick the editor. Salvage the leading valid object
        # (recovers from a stray trailing tail); else the rolling .bak; else the default.
        try:
            obj, _ = json.JSONDecoder().raw_decode(txt.lstrip())
            sys.stderr.write(f"[gt-editor] salvaged {p} past JSON error: {e}\n")
            return obj
        except Exception:
            bak = p.with_name(p.name + '.bak')
            if bak.exists():
                try:
                    sys.stderr.write(f"[gt-editor] {p} unreadable; loaded backup {bak.name}\n")
                    return json.loads(bak.read_text('utf-8'))
                except Exception:
                    pass
            sys.stderr.write(f"[gt-editor] {p} unreadable; using default ({e})\n")
            return default

def save_gt(cat, gt):
    p = ROOT / cat / 'groundtruth.json'
    if p.exists():
        shutil.copyfile(p, p.with_name(p.name + '.bak'))   # rolling backup for recovery
    # Unique temp name per writer so concurrent saves can never share a temp file, then
    # atomic replace. (Saves are also serialised by _save_lock; this is belt-and-braces.)
    tmp = p.with_name(f'{p.name}.{os.getpid()}.{threading.get_ident()}.tmp')
    tmp.write_text(json.dumps(gt, indent=1), 'utf-8')
    os.replace(tmp, p)

def tess_callouts(cat, sid=None):
    con = sqlite3.connect(ROOT / cat / 'catalog.sqlite')
    sql = "SELECT section_id,number,x0,y0,x1,y1,confidence FROM callout"
    rows = con.execute(sql + (" WHERE section_id=?" if sid is not None else ""),
                       ((int(sid),) if sid is not None else ())).fetchall()
    con.close()
    out = {}
    for s, num, x0, y0, x1, y1, conf in rows:
        t = str(num).strip().strip('()')
        if not t.isdigit():
            continue
        out.setdefault(str(s), []).append(
            {'num': t, 'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1, 'conf': conf})
    return out

@lru_cache(maxsize=64)
def diagram_png(cat, sid):
    con = sqlite3.connect(ROOT / cat / 'catalog.sqlite')
    row = con.execute("SELECT diagram_blob, diagram_w, diagram_h FROM section WHERE id=?",
                      (int(sid),)).fetchone()
    con.close()
    if not row or not row[0]:
        return None
    pixels = ccitt_decode.decode(bytes(row[0]), row[1], row[2])   # (h,w) uint8 0=white/1=black
    img = Image.fromarray(((1 - pixels) * 255).astype('uint8'), mode='L')
    buf = io.BytesIO(); img.save(buf, format='PNG')
    return buf.getvalue()


def _iou(a, b):
    ix0, iy0 = max(a['x0'], b['x0']), max(a['y0'], b['y0'])
    ix1, iy1 = min(a['x1'], b['x1']), min(a['y1'], b['y1'])
    inter = max(0, ix1 - ix0) * max(0, iy1 - iy0)
    if not inter:
        return 0.0
    aa = (a['x1']-a['x0'])*(a['y1']-a['y0']); bb = (b['x1']-b['x0'])*(b['y1']-b['y0'])
    return inter / (aa + bb - inter)


def overlap_count(callouts):
    n = 0
    for i in range(len(callouts)):
        for j in range(i+1, len(callouts)):
            if _iou(callouts[i], callouts[j]) > 0.5:
                n += 1
    return n


def sections(cat):
    gt = _load(cat, 'groundtruth.json', {}); v = _load(cat, 'vision.json', {})
    exp = _load(cat, 'expected.json', {}); tess = tess_callouts(cat)
    flags = _load(cat, 'ocr_flags.json', {})
    out = []
    for sid, vr in v.items():
        g = gt.get(sid)
        # ids compare as strings (existing gold stores int nums, editor uses str tokens)
        gnums = [str(c['num']) for c in g['callouts']] if g else []
        e = [str(x) for x in exp.get(sid, [])]
        tc = Counter(str(c['num']) for c in tess.get(sid, []))
        gc = Counter(gnums)
        out.append({
            'sid': sid, 'number': vr['number'],
            'tier': (g.get('tier') if g else 'none'),
            'verified': bool(g.get('verified')) if g else False,
            'n_gt': len(gnums), 'n_expected': len(e),
            'n_missing': len(set(e) - set(gnums)),
            'n_tess': len(tess.get(sid, [])),
            'disputed': any(tc[n] > gc[n] for n in tc),
            'n_flags': len(flags.get(sid, [])),
            'n_overlap': overlap_count(g['callouts']) if g else 0,
        })
    out.sort(key=lambda r: r['number'])
    return out


def _strnum(boxes):
    # coerce each box's num to a string id so the front-end compares uniformly
    for b in boxes:
        b['num'] = str(b['num'])
    return boxes

def section(cat, sid):
    gt = _load(cat, 'groundtruth.json', {}); v = _load(cat, 'vision.json', {})
    exp = _load(cat, 'expected.json', {}); g = gt.get(sid); vr = v.get(sid, {})
    return {
        'sid': sid, 'number': vr.get('number'), 'w': vr.get('w'), 'h': vr.get('h'),
        'tier': (g.get('tier') if g else 'none'),
        'verified': bool(g.get('verified')) if g else False,
        'callouts': _strnum(g['callouts']) if g else [],
        'absent': [str(x) for x in (g.get('absent', []) if g else [])],
        'expected': [str(x) for x in exp.get(sid, [])],
        'vision': _strnum(vr.get('detections', [])),
        'tesseract': tess_callouts(cat, sid).get(sid, []),
        'flags': _load(cat, 'ocr_flags.json', {}).get(sid, []),
    }


def save_section(data):
    # Serialised: the whole read-modify-write must be atomic vs other concurrent saves,
    # or two edits interleave (corrupting the file / dropping the earlier edit).
    with _save_lock:
        cat = data['cat']; sid = str(data['sid'])
        gt = _load(cat, 'groundtruth.json', {}); v = _load(cat, 'vision.json', {})
        number = v.get(sid, {}).get('number')
        g = gt.get(sid, {})
        g['number'] = number
        callouts = []
        for c in data['callouts']:
            num = str(c['num']).strip()
            if num != '' and not ID_RE.match(num):
                continue                       # skip a malformed id rather than crash
            callouts.append({'num': num, 'x0': int(c['x0']), 'y0': int(c['y0']),
                             'x1': int(c['x1']), 'y1': int(c['y1']),
                             'conf': c.get('conf', 100), 'source': c.get('source', 'human')})
        g['callouts'] = callouts
        g['absent'] = sorted({str(x).strip() for x in data.get('absent', [])
                              if ID_RE.match(str(x).strip())}, key=natkey)
        g['verified'] = bool(data.get('verified'))
        if g['verified']:
            g['tier'] = 'gold'
        g.setdefault('source', 'human')
        gt[sid] = g
        save_gt(cat, gt)


# ── HTTP ────────────────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers(); self.wfile.write(b)

    def _bytes(self, b, ctype, code=200):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(b)))
        self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        cat = q.get('cat', [None])[0]
        try:
            if u.path in ('/', '/index.html'):
                return self._bytes(HTML.read_bytes(), 'text/html; charset=utf-8')
            if u.path == '/api/catalogs':
                return self._json(catalogs())
            if u.path == '/api/sections':
                return self._json(sections(cat))
            if u.path == '/api/section':
                return self._json(section(cat, q['sid'][0]))
            if u.path == '/api/diagram':
                b = diagram_png(cat, q['sid'][0])
                return self._bytes(b or b'', 'image/png', 200 if b else 404)
        except Exception as e:
            return self._json({'error': str(e)}, 500)
        self._bytes(b'not found', 'text/plain', 404)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == '/api/save':
            ln = int(self.headers.get('Content-Length', 0))
            try:
                save_section(json.loads(self.rfile.read(ln)))
                return self._json({'ok': True})
            except Exception as e:
                return self._json({'error': str(e)}, 500)
        self._bytes(b'not found', 'text/plain', 404)


if __name__ == '__main__':
    if not ROOT.exists():
        print(f"No groundtruth/ dir at {ROOT}"); sys.exit(1)
    print(f"GT editor -> http://localhost:{PORT}   (catalogs: {', '.join(catalogs()) or 'none'})")
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
