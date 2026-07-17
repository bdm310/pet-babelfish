// Applicability grammar — the scope language of the Model column and of the
// applicability-shaped footers printed in the Description column.
// Pure, dependency-free. Exposed as self.APPL (browser <script>, worker
// importScripts) and module.exports (node test).
//
// One parser serves both sides: ingest types the section columns with it, the
// viewer decodes a part's scope with it. Two implementations would drift.
//
// The grammar, as the catalogs actually print it:
//
//   TURBO/COUPE PR:098,490,981 | D >> - MJ 2007
//   └─ facets ─┘ └─ option ──┘   └─ year/market ┘
//
//   ' | '  separates segments. A segment carrying a year clause is an ALTERNATIVE
//          to every other year segment — "D >> - MJ 2007 | D - MJ 2008>>" is a part
//          sold up to MY2007 *and again* from MY2008, not the empty intersection.
//   ','    OR — within a PR list ("PR:375,377" = either option slot value) and
//          between codes ("G9750,G9788" = either gearbox).
//   '+'    AND. It frequently DANGLES at the end of a column ("9770+") because the
//          right operand was routed to a different column; the operator survives the
//          split, its operand does not. Stripping it is safe only because every
//          facet is AND-ed at evaluation anyway.
//   '/'    joins two tokens that may or may not share a facet: "TURBO/COUPE" is a
//          model line AND a body style, but "COUPE/CABRIO" and "TURBO/GT2" are two
//          alternatives WITHIN one facet. Classifying each side independently and
//          letting the facet rule (OR within, AND across) sort it out is what makes
//          both read correctly — an unconditional AND would make "COUPE/CABRIO"
//          unsatisfiable and hide the part from every car.
//   '-'    negates: "-422" excludes an option, '-"CN."' excludes a market.
//
// Facets are kept SEPARATE and typed. A flat string cannot distinguish
// "(TURBO or GT2) and PR:480" from "GT2 and PR:098" — both are just tokens.
(function (root) {
  'use strict';

  // Body styles are stable across model lines, so a literal set generalises where
  // a per-catalog vocabulary would not. Everything else alphabetic is a model line
  // (TURBO, GT2, CARRERA, …) — enumerating those per catalog would not generalise.
  const BODY_STYLES = new Set(['COUPE', 'CABRIO', 'TARGA', 'ROADSTER', 'SPYDER']);

  // A token dominated by digits is a code (engine/gearbox/option), never a line:
  // "9770", "9770S", "A9750", "Z97.00", "450". Requiring TWO digits keeps "GT2"
  // and "GT3" on the model-line side.
  const CODE_SHAPE  = /^[A-Z]{0,2}\d{2,}[A-Z]?$/;
  const DOTTED_CODE = /^[A-Z]?\d{2,}(?:\.\d+)+$/;

  // Fallback shapes, used ONLY when the caller supplies no code index. The catalog's
  // own engine_code/transmission_code tables are authoritative; these guesses exist
  // so a caller without a DB handle still gets something sensible.
  const ENGINE_SHAPE  = /^\d{4}S?$/;
  const GEARBOX_SHAPE = /^[AG]\d{4}$/;

  // A model line may carry a trailing digit (GT2) but must start with letters.
  const LINE_SHAPE = /^[A-Z][A-Z0-9]*$/;

  // '"GB."' / '-"CN."' — a quoted market code, padded to three chars with dots.
  const QUOTED_MARKET = /^(-)?"([^"]+)"$/;

  // A year clause. The '>>' is the direction marker: it TRAILS the year that opens
  // the range and is absent from the year that closes it, so "MJ 2009>> - MJ 2009"
  // is the single model year 2009 rather than two unrelated years.
  const MJ_CLAUSE = /\bMJ\s*(\d{4})\s*(>>)?/g;

  // Segments led by these letters are serial-number breakpoints, not markets:
  // F = Fahrgestell (chassis), M = Motor (engine). Reading either as a market
  // would filter every part behind a breakpoint out of a German-market car.
  const CHASSIS_SEG = /^F\s/;
  const ENGINE_SEG  = /^M\s/;

  // A serial as the parts pages print it — "99-8S780 473", "628 01460". The space
  // is column padding, not structure: the catalog's own V-page tables write the
  // same numbers unbroken ("99-8S780061", "628 00501"), so both forms must key
  // identically. The trailing digit run is the number; whatever precedes it
  // (model year + plant, or nothing at all on an engine) is the prefix.
  function serialKey(s) {
    const clean = String(s || '').replace(/[\s-]/g, '').toUpperCase();
    const m = clean.match(/^(.*?)(\d+)$/);
    return m ? { prefix: m[1], serial: parseInt(m[2], 10) } : null;
  }

  // "F >> 99-9S760 796" (up to), "F 99-9S760 797>>" (from), and
  // "F 99-8S782 392>> 99-9S760 152" (between) are one form: the '>>' names the
  // open side, so splitting on it puts the lower bound left and the upper right.
  function parseBreakpoint(seg) {
    const body  = seg.replace(/^[FM]\s+/, '');
    const parts = body.split('>>');
    if (parts.length < 2) return null;
    const from = serialKey(parts[0]);
    const to   = serialKey(parts.slice(1).join(' '));
    return (from || to) ? { raw: seg, from, to } : null;
  }

  function emptyGroup() { return { any: [], not: [] }; }

  function addTo(group, value, negated) {
    const list = negated ? group.not : group.any;
    if (value && !list.includes(value)) list.push(value);
  }

  // Uppercase; "GT-2" and "GT2" are the same car printed two ways, and any
  // exact-match filter splits them into two populations if we do not fold them here.
  function normalizeToken(t) {
    return String(t || '').trim().toUpperCase().replace(/\bGT-(\d)\b/g, 'GT$1');
  }

  // The CSS vehicle export writes an engine code as "M9770"; the catalog never
  // prints the M. Consumers join the two vocabularies through this.
  function normalizeEngine(code) {
    const c = normalizeToken(code);
    return /^M\d{4}[A-Z]?$/.test(c) ? c.slice(1) : c;
  }

  // Market codes are padded to three characters with dots ("GB.", "J..") purely to
  // fill the column; the dots are not part of the code.
  function normalizeMarket(m) {
    return normalizeToken(m).replace(/\.+$/, '');
  }

  function makeIndex(opts) {
    const idx = (opts && opts.codeIndex) || null;
    const toSet = s => (s instanceof Set ? s : new Set(s || []));
    return idx
      ? { supplied: true,
          engines:   toSet(idx.engines),
          gearboxes: toSet(idx.gearboxes) }
      : { supplied: false, engines: new Set(), gearboxes: new Set() };
  }

  // Route one atomic token into its facet. Anything we cannot place lands in
  // `unknown`, which is never enforced — a code the catalog references but whose
  // V-page table does not exist (a front-axle differential, say) must stay
  // permissive rather than reject every vehicle.
  function classify(atom, out, negated, idx) {
    if (!atom) return;
    if (BODY_STYLES.has(atom))    return addTo(out.bodies, atom, negated);
    if (idx.engines.has(atom))    return addTo(out.engines, atom, negated);
    if (idx.gearboxes.has(atom))  return addTo(out.gearboxes, atom, negated);

    if (CODE_SHAPE.test(atom) || DOTTED_CODE.test(atom)) {
      if (!idx.supplied && ENGINE_SHAPE.test(atom))  return addTo(out.engines, atom, negated);
      if (!idx.supplied && GEARBOX_SHAPE.test(atom)) return addTo(out.gearboxes, atom, negated);
      return out.unknown.push(negated ? '-' + atom : atom);
    }
    if (LINE_SHAPE.test(atom)) return addTo(out.lines, atom, negated);
    out.unknown.push(negated ? '-' + atom : atom);
  }

  function parsePrToken(tok, out) {
    const group = emptyGroup();
    for (const raw of tok.slice(3).split(',')) {
      const code = raw.trim();
      if (!code) continue;                       // trailing comma of a wrapped list
      if (code.startsWith('-')) addTo(group, normalizeToken(code.slice(1)), true);
      else                      addTo(group, normalizeToken(code), false);
    }
    if (group.any.length || group.not.length) out.prGroups.push(group);
  }

  function parseToken(tok, out, idx) {
    const q = tok.match(QUOTED_MARKET);
    if (q) return addTo(out.markets, normalizeMarket(q[2]), !!q[1]);

    if (/^PR:/i.test(tok)) return parsePrToken(tok, out);

    let negated = false;
    let body = tok;
    if (body.startsWith('-')) { negated = true; body = body.slice(1); }

    // A '+' that survived the column split has lost its right operand; every facet
    // is AND-ed regardless, so the operator carries no information we can lose.
    body = body.replace(/\++$/, '');

    // ',' and '/' both feed the same classifier: whether the two sides end up as
    // alternatives or as an AND is decided by which facet each lands in, not by
    // which separator joined them.
    for (const atom of body.split(/[,/]/)) classify(normalizeToken(atom), out, negated, idx);
  }

  // A segment we cannot read as a range still has to survive: dropping it would
  // silently widen the part's scope, so it is kept raw and simply never enforced.
  function pushBreakpoint(list, seg) {
    list.push(parseBreakpoint(seg) || { raw: seg, from: null, to: null });
  }

  // Pull every year clause out of a segment and turn it into ONE range. A segment
  // states a single window; alternatives live in separate segments.
  function parseMjSegment(seg, market) {
    let from = null, to = null, found = false;
    MJ_CLAUSE.lastIndex = 0;
    let m;
    while ((m = MJ_CLAUSE.exec(seg))) {
      found = true;
      const year = parseInt(m[1], 10);
      if (m[2]) from = year;   // "MJ 2008>>" opens the range
      else      to   = year;   // "- MJ 2007" closes it
    }
    return found ? { from, to, market: market || null } : null;
  }

  function parse(str, opts) {
    const idx = makeIndex(opts);
    const out = {
      prGroups:  [],
      mjRanges:  [],
      lines:     emptyGroup(),
      bodies:    emptyGroup(),
      engines:   emptyGroup(),
      gearboxes: emptyGroup(),
      markets:   emptyGroup(),
      chassis:   [],
      engineNums: [],
      unknown:   [],
    };

    const s = String(str || '').trim();
    if (!s) return out;

    for (const rawSeg of s.split('|')) {
      const seg = rawSeg.trim();
      if (!seg) continue;

      if (CHASSIS_SEG.test(seg)) { pushBreakpoint(out.chassis, seg);    continue; }
      if (ENGINE_SEG.test(seg))  { pushBreakpoint(out.engineNums, seg); continue; }

      // A segment with a year clause is its own alternative. Its leading letter is
      // the market the window applies to; the rest of the segment is the clause.
      if (/\bMJ\b/.test(seg)) {
        const lead  = seg.match(/^([A-Z]{1,3})\s/);
        const range = parseMjSegment(seg, lead ? lead[1] : null);
        if (range) out.mjRanges.push(range);
        // Anything printed alongside the clause is still a facet token.
        const rest = seg.replace(/^[A-Z]{1,3}\s/, '').replace(MJ_CLAUSE, ' ')
                        .replace(/>>/g, ' ').replace(/(^|\s)-(\s|$)/g, ' ');
        for (const tok of rest.split(/\s+/)) if (tok.trim()) parseToken(tok.trim(), out, idx);
        continue;
      }

      for (const tok of seg.split(/\s+/)) if (tok.trim()) parseToken(tok.trim(), out, idx);
    }

    return out;
  }

  // Is this whole string scope, or is it some other use of the column? The paints
  // section prints a two-character paint code in the Model column ("A 1", "9 S");
  // taking its halves for a model line would gate the part behind a line no car
  // has. Demanding that EVERY token classify keeps such columns out — the caller
  // then falls back to whatever it did before, which is never worse.
  function isScope(str, opts) {
    const p = parse(str, opts);
    if (p.unknown.length) return false;
    return !!(p.prGroups.length || p.mjRanges.length || p.chassis.length ||
              p.engineNums.length ||
              p.lines.any.length     || p.lines.not.length ||
              p.bodies.any.length    || p.bodies.not.length ||
              p.engines.any.length   || p.engines.not.length ||
              p.gearboxes.any.length || p.gearboxes.not.length ||
              p.markets.any.length   || p.markets.not.length);
  }

  // ── Matching ────────────────────────────────────────────────────────────────
  // Every facet follows one rule: an empty `any` does not constrain, and a vehicle
  // field the caller did not supply is NOT enforced. Filtering on a fact we do not
  // know about the car would hide parts that belong to it.

  function facetAdmits(group, value) {
    if (!value) return true;
    const v = normalizeToken(value);
    if (group.not.includes(v)) return false;
    return group.any.length === 0 || group.any.includes(v);
  }

  function prAdmits(groups, codes) {
    if (!codes) return true;
    const have = codes instanceof Set ? codes : new Set(codes);
    if (!have.size) return true;
    for (const g of groups) {
      for (const n of g.not) if (have.has(n)) return false;
      // OR within the slot: any one of the listed codes satisfies the group.
      if (g.any.length && !g.any.some(c => have.has(c))) return false;
    }
    return true;
  }

  function yearAdmits(ranges, year) {
    if (!year || !ranges.length) return true;
    const y = parseInt(year, 10);
    return ranges.some(r => (r.from == null || y >= r.from) &&
                            (r.to   == null || y <= r.to));
  }

  // Is this serial inside the number block the catalog assigned to the car?
  // `block` is one vin_range / engine_number_range row — { from, to } as printed.
  function inBlock(key, block) {
    if (!key || !block) return false;
    const lo = serialKey(block.from);
    if (!lo || lo.prefix !== key.prefix) return false;
    const hi  = serialKey(block.to);
    const top = (hi && hi.prefix === key.prefix) ? hi.serial : lo.serial;
    return key.serial >= lo.serial && key.serial <= top;
  }

  // Serial breakpoints (chassis, engine number) are NOT a flat number line. The
  // catalog allocates a separate block per variant and market — the same MY2008
  // car is 99-8S780xxx as a rest-of-world Turbo, 99-8S786xxx as a Cabrio and
  // 99-8S794xxx as a GT2 — so a part that changed at one point in production
  // prints one breakpoint per block. Comparing a car against another block's
  // breakpoint is meaningless: 99-8S784090 is "before" the Cabrio's 786563 and
  // "after" the Turbo's 780473 while being neither.
  //
  // So only a breakpoint printed for the car's OWN block may speak, and those
  // that do are ALTERNATIVES — the same rule as mjRanges. When the car's block
  // states no breakpoint the catalog has not said anything about this car, and
  // silence must admit: inventing an answer here is what turns a false positive
  // into a false negative, which hides a part the owner actually needs.
  function serialAdmits(ranges, value, block) {
    if (!ranges.length) return true;
    const v = serialKey(value);
    if (!v) return true;
    const usable = ranges.filter(r => inBlock(r.from, block) || inBlock(r.to, block));
    if (!usable.length) return true;
    // A bound sitting in a different block cannot exclude this car, so it leaves
    // that side of the range open — "from MY2008 ... to MY2009" still admits a
    // MY2008 car whose own block only names the lower bound.
    return usable.some(r =>
      !(r.from && r.from.prefix === v.prefix && v.serial < r.from.serial) &&
      !(r.to   && r.to.prefix   === v.prefix && v.serial > r.to.serial));
  }

  // vehicle: { line, body, engine, gearbox, market, year, prCodes:Set,
  //            chassis, chassisBlock:{from,to}, engineNum, engineNumBlock:{from,to} }
  // Chassis and engine number are separate facets: F is the car, M is the engine
  // in it, and a part can be gated on either. `unknown` is captured but never
  // enforced.
  function matches(parsed, vehicle) {
    const v = vehicle || {};
    return facetAdmits(parsed.lines,     v.line)
        && facetAdmits(parsed.bodies,    v.body)
        && facetAdmits(parsed.engines,   v.engine && normalizeEngine(v.engine))
        && facetAdmits(parsed.gearboxes, v.gearbox)
        && facetAdmits(parsed.markets,   v.market)
        && prAdmits(parsed.prGroups,     v.prCodes)
        && yearAdmits(parsed.mjRanges,   v.year)
        && serialAdmits(parsed.chassis,    v.chassis,   v.chassisBlock)
        && serialAdmits(parsed.engineNums, v.engineNum, v.engineNumBlock);
  }

  const APPL = {
    parse, matches, isScope, normalizeEngine, normalizeMarket, normalizeToken,
    facetAdmits, prAdmits, yearAdmits, serialAdmits, serialKey, BODY_STYLES,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = APPL;
  else root.APPL = APPL;
})(typeof self !== 'undefined' ? self : this);
