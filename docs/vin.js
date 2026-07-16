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

  // The `applicability` "market" column. In every catalog we ingest this is
  // effectively always `D` — a market-agnostic BASELINE (not Germany-specific),
  // so it applies to all markets. Real per-part market/production carve-outs are
  // encoded as chassis/engine serial breakpoints ("F >>" = from chassis number,
  // "M >>" = from engine number), handled in Phase E — those letters are NOT
  // markets and must not be filtered as such.
  const APPL_MARKETS = { D: { label: 'all markets', matchesAll: true } };

  // Does an applicability market letter admit the user's requested market?
  // Unknown/baseline letters admit everything (we never over-filter parts).
  function applMarketAdmits(letter, wanted) {
    if (!wanted) return true;
    const spec = APPL_MARKETS[String(letter || '').toUpperCase()];
    if (!spec || spec.matchesAll) return true;
    return (spec.markets || []).includes(String(wanted).toUpperCase());
  }

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

  // Split a compact chassis number into { prefix, serial } where serial is the
  // trailing run of digits. Dashes are dropped so a stored "99-5S750061" and a
  // reconstructed "99-5S750061" key identically.
  function chassisKey(s) {
    const clean = String(s || '').replace(/-/g, '').toUpperCase();
    const m = clean.match(/^(.*?)(\d+)$/);
    if (!m) return null;
    return { prefix: m[1], serial: parseInt(m[2], 10) };
  }

  // Find every vin_range row whose prefix matches and whose [from,to] serial span
  // contains the decoded chassis. Rows: { from, to, ...passthrough }.
  function matchChassis(chassis, rows) {
    const key = chassisKey(chassis);
    if (!key) return [];
    const out = [];
    for (const r of rows || []) {
      const fk = chassisKey(r.from);
      if (!fk || fk.prefix !== key.prefix) continue;
      const tk = chassisKey(r.to);
      const hi = (tk && tk.prefix === key.prefix) ? tk.serial : fk.serial;
      if (key.serial >= fk.serial && key.serial <= hi) out.push(r);
    }
    return out;
  }

  const VIN = { decodeVin, chassisKey, matchChassis, parseMarket, applMarketAdmits,
                YEAR_CODE, FAMILY, MARKET_NAMES, APPL_MARKETS };
  if (typeof module !== 'undefined' && module.exports) module.exports = VIN;
  else root.VIN = VIN;
})(typeof self !== 'undefined' ? self : this);
