#!/usr/bin/env python
"""Unpack pre-ingested catalogs into docs/catalogs/ for the app to ship.

Source is catalogs.zip (gitignored, exported from OPFS via catalog-browser.html),
whose entries are `<catalogId>/catalog.sqlite`. Each becomes a flat, committed
`docs/catalogs/<catalogId>.sqlite` — one distinct object per catalog so a re-ingest
is a well-scoped diff — plus a manifest the app reads to list and lazily install them.

The manifest carries each catalog's vin_range rows so a VIN can pick a bundled
catalog before the (multi-MB) DB is downloaded; everything else is read after the
catalog is installed into OPFS.

    uv run python tools/build-catalogs.py            # from catalogs.zip
    uv run python tools/build-catalogs.py --from-dir docs/catalogs   # re-read existing .sqlite
"""
import argparse, glob, json, os, sqlite3, tempfile, zipfile

OUTDIR = os.path.join('docs', 'catalogs')


def meta(db_bytes_or_path, is_path):
    """(title, model, vin_range rows) from a catalog DB."""
    if is_path:
        con = sqlite3.connect(db_bytes_or_path)
    else:
        tf = tempfile.NamedTemporaryFile(suffix='.sqlite', delete=False)
        tf.write(db_bytes_or_path); tf.close()
        con = sqlite3.connect(tf.name)
    try:
        title, model = con.execute('SELECT title, model FROM catalog LIMIT 1').fetchone()
        vr = [dict(model_year=my, vin_from=vf, vin_to=vt, remark=rm)
              for (my, vf, vt, rm) in
              con.execute('SELECT model_year, vin_from, vin_to, remark FROM vin_range')]
    finally:
        con.close()
        if not is_path:
            os.unlink(tf.name)
    return title or '', model or '', vr


def from_zip(path):
    zf = zipfile.ZipFile(path)
    for name in zf.namelist():
        if name.endswith('/catalog.sqlite'):
            cid = name.split('/catalog.sqlite')[0]
            data = zf.read(name)
            with open(os.path.join(OUTDIR, cid + '.sqlite'), 'wb') as f:
                f.write(data)
            yield cid, data, False


def from_dir(path):
    for p in sorted(glob.glob(os.path.join(path, '*.sqlite'))):
        yield os.path.splitext(os.path.basename(p))[0], p, True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--zip', default='catalogs.zip')
    ap.add_argument('--from-dir', help='re-read .sqlite already in docs/catalogs instead of the zip')
    args = ap.parse_args()
    os.makedirs(OUTDIR, exist_ok=True)

    src = from_dir(args.from_dir) if args.from_dir else from_zip(args.zip)
    manifest = []
    for cid, blob, is_path in src:
        title, model, vr = meta(blob, is_path)
        size = os.path.getsize(os.path.join(OUTDIR, cid + '.sqlite'))
        manifest.append(dict(id=cid, file=cid + '.sqlite', title=title, model=model,
                             bytes=size, vinRanges=vr))
    manifest.sort(key=lambda m: m['id'])
    with open(os.path.join(OUTDIR, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False); f.write('\n')

    total = sum(m['bytes'] for m in manifest)
    print(f'{len(manifest)} catalogs, {total/1e6:.1f} MB → {OUTDIR}')
    for m in manifest:
        print(f"  {m['id']:34} {m['title']} - {m['model']}  ({len(m['vinRanges'])} vin ranges)")


if __name__ == '__main__':
    main()
