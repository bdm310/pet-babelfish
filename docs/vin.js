// VIN decode + Porsche PET compact-chassis reconstruction / matching.
// Pure, dependency-free. Exposed as window.VIN (browser) and module.exports (node test).
//
// A 17-char VIN gives family + model year + plant + serial. We reconstruct the
// compact chassis number the catalogs store in `vin_range.vin_from/vin_to`, then
// match it (prefix + numeric serial) against ingested ranges to pick the catalog.
(function (root) {
  'use strict';

  // ISO 3779 model-year codes, scoped to the span our catalogs cover.
  const YEAR_CODE = {
    '3': 2003, '4': 2004, '5': 2005, '6': 2006, '7': 2007, '8': 2008, '9': 2009,
    A: 2010, B: 2011, C: 2012, D: 2013, E: 2014, F: 2015, G: 2016, H: 2017,
  };

  // VIN[6:8] type prefix → catalog family. 356 predates 17-char VINs (Phase E).
  const FAMILY = { '99': '997', '98': '987', '9P': 'cayenne' };

  const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/; // ISO 3779 excludes I, O, Q

  // 17-char VIN → decoded fields + reconstructed compact chassis number.
  function decodeVin(raw) {
    const vin = String(raw || '').trim().toUpperCase();
    if (!VIN_RE.test(vin)) {
      return { ok: false, error: 'VIN must be 17 characters (letters/digits, no I, O, Q).' };
    }

    const type      = vin.slice(6, 8);
    const family    = FAMILY[type] || null;
    const yearChar  = vin[9];
    const modelYear = YEAR_CODE[yearChar] || null;

    // Reconstruct the catalog's compact chassis form (see vin_range samples):
    //   997/987  "<type>-<yr><plant><serial6>"  e.g. 99-5S750061
    //   cayenne  "<type><yr><plant2><serial5>"  e.g. 9P3LA00061
    let chassis = null, plant = null;
    if (family === '997' || family === '987') {
      plant   = vin[10];
      chassis = `${type}-${yearChar}${vin[10]}${vin.slice(11)}`;
    } else if (family === 'cayenne') {
      plant   = vin.slice(10, 12);
      chassis = `${type}${yearChar}${vin.slice(10, 12)}${vin.slice(12)}`;
    }

    return { ok: true, vin, family, type, modelYear, yearChar, plant, chassis };
  }

  // ── Market codes ──────────────────────────────────────────────────────────
  // Region codes used in vin_range remarks (Porsche PET English exports).
  const MARKET_NAMES = {
    USA: 'United States', CDN: 'Canada', MEX: 'Mexico', BR: 'Brazil',
    CN: 'China', KOR: 'South Korea', ROW: 'Rest of world',
  };

  // Parse a vin_range remark's market group, e.g.
  //   "997 Coupe (USA,CDN,MEX,BR)"      → { variant:'997 Coupe', markets:['USA',…] }
  //   "997 Cabrio S (rest of the world)" → { markets:['ROW'] }
  //   "997 Turbo"                        → { markets:[] }  (baseline)
  function parseMarket(remark) {
    const s = String(remark || '');
    const paren = s.match(/\(([^)]*)\)/);
    // Drop the parenthetical and any engine spec after a bullet/dash separator.
    const variant = s.replace(/\s*\([^)]*\)\s*/, ' ')
                     .split(/\s*[—–•�]\s*/)[0]
                     .replace(/\s+/g, ' ').trim();
    if (!paren) return { variant, markets: [], marketLabel: '' };
    const inner = paren[1].trim();
    if (/rest of the world/i.test(inner))
      return { variant, markets: ['ROW'], marketLabel: MARKET_NAMES.ROW };
    const markets = inner.split(/[,\s]+/).map(x => x.toUpperCase())
                         .filter(x => MARKET_NAMES[x]);
    return { variant, markets, marketLabel: markets.join(', ') };
  }

  // What the matched vin_range row says about the car itself, expressed in the
  // catalog's OWN facet vocabulary (`lineOptions`/`bodyOptions` come from the
  // sections' typed scope columns). A token we cannot place is dropped: gating a
  // car behind a facet value no part carries would hide the whole catalog.
  //
  // `allRemarks` is every vin_range remark in the catalog — the body style is
  // often stated only by omission (see below), which needs the whole set to read.
  function variantFacets(remark, allRemarks, lineOptions, bodyOptions) {
    const set    = opts => new Set((opts || []).map(o => String(o).toUpperCase()));
    const tokens = v => String(v || '').toUpperCase().split(/[\s/]+/).filter(Boolean);
    const lines  = set(lineOptions), bodies = set(bodyOptions);
    const pm     = parseMarket(remark);
    const toks   = tokens(pm.variant);
    const last   = (ts, vocab) => ts.filter(t => vocab.has(t)).pop() || '';

    // The family is named first and narrowed after — "997 Turbo GT2" is a GT2 —
    // so the LAST token the catalog knows as a line is the specific one.
    const line = last(toks, lines);

    // A remark naming no body means the body the catalog never names: it prints
    // "997 Turbo Cabrio" and plain "997 Turbo", never "997 Turbo Coupe". Only
    // readable when exactly one body style is left unnamed by every range, else
    // the silence carries no information and the field stays open.
    let body = last(toks, bodies);
    if (!body) {
      const named = new Set();
      for (const r of allRemarks || [])
        for (const t of tokens(parseMarket(r).variant)) if (bodies.has(t)) named.add(t);
      const unnamed = [...bodies].filter(b => !named.has(b));
      if (named.size && unnamed.length === 1) body = unnamed[0];
    }

    // A range serving several markets says the car is in ONE of them, not which,
    // so only a single-market range identifies the car. "rest of the world" is a
    // catch-all, not a code any part is gated on.
    const market = (pm.markets.length === 1 && pm.markets[0] !== 'ROW') ? pm.markets[0] : '';

    return { line, body, market };
  }

  // Split a compact chassis number into { prefix, serial } where serial is the
  // trailing run of digits. Dashes AND spaces are dropped so a stored "99-5S750061"
  // and a reconstructed "99-5S750061" key identically, and an old catalog's spaced
  // "93077 0001" keys the same as a glued "930770001" the owner might type. (Matches
  // appl.js serialKey, which strips the same set.)
  function chassisKey(s) {
    const clean = String(s || '').replace(/[\s-]/g, '').toUpperCase();
    const m = clean.match(/^(.*?)(\d+)$/);
    if (!m) return null;
    return { prefix: m[1], serial: parseInt(m[2], 10) };
  }

  // Find every vin_range row whose prefix matches and whose [from,to] serial span
  // contains the decoded chassis. Rows: { from, to, ...passthrough }.
  //
  // An empty `to` means "from this serial onward" — the open-ended form the old
  // catalogs use (911 Turbo lists only a start per type). Modern ranges always
  // carry both bounds, so this widening never touches the 17-char VIN path.
  function matchChassis(chassis, rows) {
    const key = chassisKey(chassis);
    if (!key) return [];
    const out = [];
    for (const r of rows || []) {
      const fk = chassisKey(r.from);
      if (!fk || fk.prefix !== key.prefix) continue;
      const tk = chassisKey(r.to);
      const hi = (tk && tk.prefix === key.prefix) ? tk.serial
               : (r.to == null || String(r.to).trim() === '') ? Infinity
               : fk.serial;
      if (key.serial >= fk.serial && key.serial <= hi) out.push(r);
    }
    return out;
  }

  // The full four-digit model year for an old catalog's two-digit `vin_range`
  // value, using the catalog's own century pivot (its Model-life start year).
  // "05" against a 1998 pivot is 2005, "98" is 1998; a value already four digits
  // (modern catalogs) is returned unchanged.
  function expandYear(modelYear, yearPivot) {
    const yy = parseInt(modelYear, 10);
    if (!Number.isFinite(yy) || yy >= 100) return Number.isFinite(yy) ? yy : null;
    const pivot = parseInt(yearPivot, 10);
    if (!Number.isFinite(pivot)) return yy;
    let full = Math.floor(pivot / 100) * 100 + yy;
    while (full < pivot) full += 100;
    return full;
  }

  const VIN = { decodeVin, chassisKey, matchChassis, expandYear, parseMarket,
                variantFacets, YEAR_CODE, FAMILY, MARKET_NAMES };
  if (typeof module !== 'undefined' && module.exports) module.exports = VIN;
  else root.VIN = VIN;
})(typeof self !== 'undefined' ? self : this);
