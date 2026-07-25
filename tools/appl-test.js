// Self-test for docs/appl.js
//   node tools/appl-test.js                                  (if node is installed)
//   uv run --with playwright python tools/appl-test.py       (uses the repo's chromium)
// Every case here is a form observed in a real catalog PDF; the page it was read
// from is cited so a failure can be checked against the source.
const APPL = (typeof require !== 'undefined' && typeof module !== 'undefined')
  ? require('../docs/appl.js')
  : (typeof self !== 'undefined' ? self.APPL : this.APPL);

let pass = 0, fail = 0;

function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`FAIL  ${name}${detail ? '\n      ' + detail : ''}`);
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(name, a === e, `expected ${e}\n      actual   ${a}`);
}

// The catalog's own V-page tables for 997 Turbo/GT2 (p2–p3).
const IDX = { codeIndex: { engines: ['9770', '9770S'], gearboxes: ['A9750', 'G9750', 'G9788'] } };

// ── The multi-MJ collapse: two alternatives, both must be admitted ────────────
{
  const p = APPL.parse('D >> - MJ 2007 | D - MJ 2008>>', IDX);
  eq('mjRanges is a list of alternatives', p.mjRanges,
     [{ from: null, to: 2007, market: 'D' }, { from: 2008, to: null, market: 'D' }]);
  ok('admits 2007', APPL.matches(p, { year: 2007 }));
  ok('admits 2008', APPL.matches(p, { year: 2008 }));
  ok('admits 2009', APPL.matches(p, { year: 2009 }));
}

// A segment with no year clause must not touch the year facet (p714 title).
{
  const p = APPL.parse('TURBO PR:480', IDX);
  eq('no MJ segment ⇒ no range', p.mjRanges, []);
  ok('year unconstrained', APPL.matches(p, { year: 1999 }));
}

// "MJ 2009>> - MJ 2009" is the single year 2009, not two years (p24, p714).
{
  const p = APPL.parse('D - MJ 2009>> - MJ 2009', IDX);
  eq('closed single-year window', p.mjRanges, [{ from: 2009, to: 2009, market: 'D' }]);
  ok('admits 2009', APPL.matches(p, { year: 2009 }));
  ok('rejects 2008', !APPL.matches(p, { year: 2008 }));
}

// ── Dangling AND operator (p26, p65, p119) ───────────────────────────────────
{
  const p = APPL.parse('9770+ PR:480', IDX);
  eq('9770+ → engine 9770', p.engines.any, ['9770']);
  eq('  and its PR survives', p.prGroups, [{ any: ['480'], not: [] }]);
  eq('  nothing stranded', p.unknown, []);
  ok('matches the Turbo', APPL.matches(p, { engine: 'M9770', prCodes: new Set(['480']) }));
}

// ── OR between codes: ONE group of two alternatives, not two AND-ed groups ────
{
  const p = APPL.parse('G9750,G9788', IDX);
  eq('either gearbox', p.gearboxes.any, ['G9750', 'G9788']);
  ok('admits G9750', APPL.matches(p, { gearbox: 'G9750' }));
  ok('admits G9788', APPL.matches(p, { gearbox: 'G9788' }));
  ok('rejects A9750', !APPL.matches(p, { gearbox: 'A9750' }));
  ok('gearbox unknown ⇒ not enforced', APPL.matches(p, {}));
}

// ── A code resolving to no V-page table stays permissive (360-002) ────────────
{
  const p = APPL.parse('Z97.00', IDX);
  eq('Z97.00 → unknown', p.unknown, ['Z97.00']);
  eq('  not an engine', p.engines.any, []);
  eq('  not a gearbox', p.gearboxes.any, []);
  ok('admits every vehicle', APPL.matches(p, { engine: '9770', gearbox: 'G9750' }));
}

// ── Negation (807-001, 601-005, 911-001) ─────────────────────────────────────
{
  const p = APPL.parse('PR:098,-422', IDX);
  eq('any/not split', p.prGroups, [{ any: ['098'], not: ['422'] }]);
  ok('admits 098', APPL.matches(p, { prCodes: new Set(['098']) }));
  ok('rejects 422', !APPL.matches(p, { prCodes: new Set(['098', '422']) }));
}
{
  const p = APPL.parse('PR:483 -"ROK"', IDX);
  eq('market negated', p.markets, { any: [], not: ['ROK'] });
  ok('rejects Korea', !APPL.matches(p, { market: 'ROK', prCodes: new Set(['483']) }));
  ok('admits USA', APPL.matches(p, { market: 'USA', prCodes: new Set(['483']) }));
}
{
  const p = APPL.parse('PR:483 "ROK"', IDX);
  eq('market required', p.markets, { any: ['ROK'], not: [] });
  ok('admits Korea', APPL.matches(p, { market: 'ROK', prCodes: new Set(['483']) }));
  ok('rejects USA', !APPL.matches(p, { market: 'USA', prCodes: new Set(['483']) }));
  ok('market unknown ⇒ not enforced', APPL.matches(p, { prCodes: new Set(['483']) }));
}
// A group that only negates must not reject a car that has no options listed.
{
  const p = APPL.parse('PR:-101', IDX);
  eq('pure negation', p.prGroups, [{ any: [], not: ['101'] }]);
  ok('admits a car without 101', APPL.matches(p, { prCodes: new Set(['480']) }));
  ok('rejects a car with 101', !APPL.matches(p, { prCodes: new Set(['101']) }));
}

// ── '/' spans facets OR alternates within one - decided by classification ─────
{
  const p = APPL.parse('TURBO/COUPE', IDX);
  eq('line side', p.lines.any, ['TURBO']);
  eq('body side', p.bodies.any, ['COUPE']);
  ok('Turbo Coupe', APPL.matches(p, { line: 'TURBO', body: 'COUPE' }));
  ok('not a Turbo Cabrio', !APPL.matches(p, { line: 'TURBO', body: 'CABRIO' }));
  ok('not a GT2 Coupe', !APPL.matches(p, { line: 'GT2', body: 'COUPE' }));
}
{
  // Same facet on both sides - an unconditional AND here would hide the part
  // from every car, since no car is both a Coupe and a Cabrio.
  const p = APPL.parse('COUPE/CABRIO', IDX);
  eq('one body group, two alternatives', p.bodies.any, ['COUPE', 'CABRIO']);
  ok('admits Coupe', APPL.matches(p, { body: 'COUPE' }));
  ok('admits Cabrio', APPL.matches(p, { body: 'CABRIO' }));
}
{
  const p = APPL.parse('TURBO/GT2', IDX);
  eq('one line group, two alternatives', p.lines.any, ['TURBO', 'GT2']);
  ok('admits Turbo', APPL.matches(p, { line: 'TURBO' }));
  ok('admits GT2', APPL.matches(p, { line: 'GT2' }));
}

// ── Space-separated tokens OR within a facet, AND across facets (501-001) ─────
{
  const p = APPL.parse('TURBO GT2 PR:480', IDX);
  eq('(TURBO or GT2)', p.lines.any, ['TURBO', 'GT2']);
  ok('Turbo w/ 480', APPL.matches(p, { line: 'TURBO', prCodes: new Set(['480']) }));
  ok('GT2 w/ 480', APPL.matches(p, { line: 'GT2', prCodes: new Set(['480']) }));
  ok('AND across facets', !APPL.matches(p, { line: 'TURBO', prCodes: new Set(['249']) }));
}
{
  const p = APPL.parse('GT2 PR:098', IDX);
  ok('pure AND', APPL.matches(p, { line: 'GT2', prCodes: new Set(['098']) }));
  ok('  line enforced', !APPL.matches(p, { line: 'TURBO', prCodes: new Set(['098']) }));
}

// ── Normalization ────────────────────────────────────────────────────────────
eq('GT-2 folds to GT2', APPL.parse('GT-2', IDX).lines.any, ['GT2']);
eq('lowercase folds', APPL.parse('Turbo/Coupe', IDX).lines.any, ['TURBO']);
eq('  body too', APPL.parse('Turbo/Coupe', IDX).bodies.any, ['COUPE']);
eq('M-prefix stripped for the consumer', APPL.normalizeEngine('M9770'), '9770');
eq('  catalog form untouched', APPL.normalizeEngine('9770'), '9770');
eq('  gearbox G kept', APPL.normalizeEngine('G9750'), 'G9750');
eq('market padding dropped', APPL.parse('"GB."', IDX).markets.any, ['GB']);
eq('  and "J.."', APPL.parse('"J.."', IDX).markets.any, ['J']);

// ── Serial breakpoints (F = chassis, M = engine) ─────────────────────────────
// The blocks below are the catalog's own: vin_range p4 and engine_number_range p5.
// Test car (CSS export): chassis 99-8S784090, engine 62807297.
const USA08   = { from: '99-8S783061', to: '99-8S786000' }; // 997 Turbo (USA, CN, CDN, MEX, BR)
const ROW08   = { from: '99-8S780061', to: '99-8S783000' }; // 997 Turbo (rest of the world)
const CABRIO08= { from: '99-8S786061', to: '99-8S788000' }; // 997 Turbo Cabrio (rest of the world)
const ENG08   = { from: '628 00501',   to: '628 18000'   }; // MY2008 997 TURBO 9770
const CAR = { chassis: '99-8S784090', chassisBlock: USA08,
              engineNum: '62807297',  engineNumBlock: ENG08 };

{
  const p = APPL.parse('PR:249,480 | M >> 627 00765 | F >> 99-8S780 473', IDX);
  eq('engine breakpoint parsed', p.engineNums,
     [{ raw: 'M >> 627 00765', from: null, to: { prefix: '', serial: 62700765 } }]);
  eq('chassis breakpoint parsed', p.chassis,
     [{ raw: 'F >> 99-8S780 473', from: null, to: { prefix: '998S', serial: 780473 } }]);
  eq('  M is not a market', p.markets, { any: [], not: [] });
  eq('  nor a year', p.mjRanges, []);
}
// The printed space is padding: the parts pages and the V-page tables must key alike.
eq('spaced serial keys like the table form', APPL.serialKey('99-8S780 473'),
   APPL.serialKey('99-8S780473'));
eq('engine serial likewise', APPL.serialKey('628 01460'), APPL.serialKey('62801460'));

// 107-005 p84 - the one breakpoint that speaks to the test car's own engine block.
{
  const up = APPL.parse('M >> 628 01460', IDX);
  ok('engine 62807297 is past the changeover', !APPL.matches(up, CAR));
  const from = APPL.parse('M 628 01461 >>', IDX);
  ok('  so it takes the later part', APPL.matches(from, CAR));
  ok('engine number unknown ⇒ not enforced', APPL.matches(up, {}));
  ok('  block unknown ⇒ not enforced', APPL.matches(up, { engineNum: '62807297' }));
}
// 813-025 p560 - both breakpoints sit in block 627 (MY2007); the car's engine is
// in 628. A flat compare would read 62807297 > 62700889 and hide the part.
{
  const p = APPL.parse('PR:249,480 | M >> 627 00765 | M >> 627 00889', IDX);
  ok('another block says nothing about this car', APPL.matches(p, {
    ...CAR, prCodes: new Set(['480']),
  }));
}
// 809-000 p443 - one breakpoint per VIN block: Turbo RoW, Cabrio RoW, GT2. The
// catalog prints none for the USA block the test car is in.
{
  const up = APPL.parse('F >> 99-8S780 473 | F >> 99-8S786 563 | F >> 99-8S794 072', IDX);
  ok('silent for a block it never mentions', APPL.matches(up, CAR));
  const from = APPL.parse('F 99-8S780 474>> | F 99-8S786 564>> | F 99-8S794 073>>', IDX);
  ok('  and its counterpart is too', APPL.matches(from, CAR));
  // Both halves of a changeover admitting one car is a false positive; picking the
  // wrong block's number instead would hide the right part, which is worse.
  ok('the Cabrio bound must not judge a Coupe',
     APPL.matches(APPL.parse('F >> 99-8S786 563', IDX), CAR));

  // Same part, a rest-of-world Turbo: now the car's own block names a breakpoint.
  const ROW = { chassis: '99-8S781500', chassisBlock: ROW08 };
  ok('RoW car past 780473 loses the early part', !APPL.matches(up, ROW));
  ok('  and gains the later one', APPL.matches(from, ROW));
  const CAB = { chassis: '99-8S786900', chassisBlock: CABRIO08 };
  ok('Cabrio past 786563 loses the early part', !APPL.matches(up, CAB));
}
// 905-000 p704 - a range that runs from a MY2008 block into a MY2009 one. The
// upper bound is in another block and must leave that side open, not reject.
{
  const p = APPL.parse('F 99-8S782 392>> 99-9S760 152', IDX);
  ok('admits a MY2008 RoW car past the lower bound',
     APPL.matches(p, { chassis: '99-8S782500', chassisBlock: ROW08 }));
  ok('  rejects one before it',
     !APPL.matches(p, { chassis: '99-8S780900', chassisBlock: ROW08 }));
}
// A breakpoint we cannot read must widen nothing away.
{
  const p = APPL.parse('F >> nonsense', IDX);
  eq('unreadable breakpoint kept raw', p.chassis.length, 1);
  ok('  and never enforced', APPL.matches(p, CAR));
}
// 501-001 p226 - the one glued breakpoint in the PDF ("F>>998S4794076", also a
// stray digit in the serial). It must read as a chassis segment, not a facet,
// and its corrupt serial sits in no block, so it stays permissive.
{
  const p = APPL.parse('GT2 | F>>998S4794076', IDX);
  eq('glued form is a chassis segment', p.chassis,
     [{ raw: 'F>>998S4794076', from: null, to: { prefix: '998S', serial: 4794076 } }]);
  eq('  not an unknown facet', p.unknown, []);
  const GT2_08 = { from: '99-8S794061', to: '99-8S796000' };
  ok('corrupt serial is outside every block ⇒ admits',
     APPL.matches(p, { line: 'GT2', chassis: '99-8S794090', chassisBlock: GT2_08 }));
  const m = APPL.parse('M>>628 01460', IDX);
  eq('glued M form likewise', m.engineNums.length, 1);
  ok('  and enforced when readable', !APPL.matches(m, CAR));
}

// ── A wrapped PR list rejoined upstream stays one slot ────────────────────────
{
  const p = APPL.parse('PR:098,639,640,981', IDX);
  eq('one group', p.prGroups, [{ any: ['098', '639', '640', '981'], not: [] }]);
  ok('any one satisfies', APPL.matches(p, { prCodes: new Set(['640']) }));
}

// ── Without a code index, codes stay permissive (WS3c: no shape-guessing) ─────
// Every catalog now ingests a real code table, so the shape fallback that could
// promote "1600" into an enforced engine is gone. Absent an index, a code lands in
// unknown and never rejects a car.
{
  const p = APPL.parse('9770 G9750 Z97.00');
  eq('engine not guessed', p.engines.any, []);
  eq('gearbox not guessed', p.gearboxes.any, []);
  eq('all three unknown', p.unknown, ['9770', 'G9750', 'Z97.00']);
  ok('admits every vehicle', APPL.matches(p, { engine: 'M9770', gearbox: 'G9750' }));
}
// With an index, a code the catalog's tables do not know is NOT guessed.
{
  const p = APPL.parse('9770 G9788 8888', IDX);
  eq('unknown code not enforced', p.unknown, ['8888']);
  eq('known engine placed', p.engines.any, ['9770']);
  eq('known gearbox placed', p.gearboxes.any, ['G9788']);
}

// ── Empty / absent input ─────────────────────────────────────────────────────
{
  const p = APPL.parse('', IDX);
  ok('empty parses', p.prGroups.length === 0 && p.mjRanges.length === 0);
  ok('empty admits all', APPL.matches(p, { line: 'TURBO', year: 2008 }));
  ok('null admits all', APPL.matches(APPL.parse(null, IDX), { year: 2008 }));
}

// ── A real part string end to end (807-003 p383, the MY2008 Turbo test car) ──
{
  const p = APPL.parse('Turbo PR:098,XTG | D - MJ 2008>>', IDX);
  ok('Carrera Red sill trim is visible', APPL.matches(p, {
    line: 'TURBO', year: 2008, prCodes: new Set(['098', 'XTG']),
  }));
  ok('  hidden from a 2007 car', !APPL.matches(p, {
    line: 'TURBO', year: 2007, prCodes: new Set(['098', 'XTG']),
  }));
  ok('  hidden from a GT2', !APPL.matches(p, {
    line: 'GT2', year: 2008, prCodes: new Set(['098', 'XTG']),
  }));
}

// ═══ New-dialect grammar (WS3–WS6) ═══════════════════════════════════════════
// An old-dialect index: bare PR codes, a line whitelist, the Model-life pivot.
const OLD = { dialect: 'old', prCodes: ['M480', 'IX51', 'IXAA', 'M030'],
              lines: ['CARRERA', 'TURBO', 'GT3', 'CAYENNE'], yearPivot: 1998 };

// ── WS4a: serial breakpoints on any lead letter (C = PDK, G = 356 gearbox) ────
{
  const p = APPL.parse('C >> 47110001', IDX);
  eq('C-lead serial → transmission block', p.transmissionNums.length, 1);
  eq('  C is not an enforced line', p.lines.any, []);
  ok('unknown gearbox serial ⇒ admits', APPL.matches(p, {}));
}
{
  const p = APPL.parse('G 11 001 >> 25 000', IDX); // 356 gearbox serial range
  eq('G-lead serial → transmission block', p.transmissionNums.length, 1);
  eq('  G is not an enforced line', p.lines.any, []);
  const blk = { from: '11001', to: '25000' };
  ok('a gearbox in the block, inside the range, is admitted',
     APPL.matches(p, { transmissionNum: '20000', transmissionBlock: blk }));
  ok('unknown ⇒ not enforced', APPL.matches(p, {}));
}

// ── WS4b: dd.mm.yyyy date windows map to model year via calendar year ─────────
{
  const p = APPL.parse('D >> - 31.07.2008', IDX);
  eq('to-date window', p.mjRanges, [{ from: null, to: 2008, market: 'D' }]);
  eq('  D is not a line', p.lines.any, []);
  ok('admits 2007', APPL.matches(p, { year: 2007 }));
  ok('admits 2008', APPL.matches(p, { year: 2008 }));
  ok('rejects 2009', !APPL.matches(p, { year: 2009 }));
}
{
  const p = APPL.parse('D 01.08.2008 >>', IDX);
  eq('from-date window', p.mjRanges, [{ from: 2008, to: null, market: 'D' }]);
  ok('rejects 2007', !APPL.matches(p, { year: 2007 }));
  ok('admits 2009', APPL.matches(p, { year: 2009 }));
}

// ── WS4c: parenthesised markets, old dialect only ────────────────────────────
{
  const p = APPL.parse('(J)', OLD);
  eq('paren market', p.markets.any, ['J']);
  ok('admits Japan', APPL.matches(p, { market: 'J' }));
  ok('rejects USA', !APPL.matches(p, { market: 'USA' }));
  ok('market unknown ⇒ not enforced', APPL.matches(p, {}));
}
{
  const p = APPL.parse('-(CN)', OLD);
  eq('negated paren market', p.markets.not, ['CN']);
  ok('rejects China', !APPL.matches(p, { market: 'CN' }));
}
{
  const p = APPL.parse('(J)', IDX); // modern: a paren token is never a market
  eq('modern paren ⇒ unknown', p.unknown, ['(J)']);
  eq('  no market enforced', p.markets.any, []);
}

// ── WS4d: two-digit year windows, expanded via the Model-life pivot ──────────
{
  eq('to-year', APPL.parse('-02', OLD).mjRanges, [{ from: null, to: 2002, market: null }]);
  eq('from-year', APPL.parse('03-', OLD).mjRanges, [{ from: 2003, to: null, market: null }]);
  eq('window across the century', APPL.parse('00-01', OLD).mjRanges,
     [{ from: 2000, to: 2001, market: null }]);
  const p = APPL.parse('-02', OLD);
  ok('admits 2001', APPL.matches(p, { year: 2001 }));
  ok('rejects 2003', !APPL.matches(p, { year: 2003 }));
}
{ // 356 pivot lands in the 1950s
  eq('356 pivot', APPL.parse('-55', { dialect: 'old', yearPivot: 1950 }).mjRanges,
     [{ from: null, to: 1955, market: null }]);
}
{ // modern dialect never reads "-02" as a year
  eq('modern -02 not a year', APPL.parse('-02', IDX).mjRanges, []);
}

// ── WS3a: bare option codes routed by the catalog's own PR index (old only) ───
{
  const p = APPL.parse('M480', OLD);
  eq('bare M-code → PR group', p.prGroups, [{ any: ['M480'], not: [] }]);
  eq('  not an enforced line', p.lines.any, []);
  ok('admits a car optioned M480', APPL.matches(p, { prCodes: new Set(['M480']) }));
  ok('rejects one without it', !APPL.matches(p, { prCodes: new Set(['M030']) }));
  ok('options unknown ⇒ not enforced', APPL.matches(p, {}));
}
{ // the 996GT3 bug: an all-letter option code was becoming an enforced line
  const p = APPL.parse('IXAA', OLD);
  eq('IXAA → PR group', p.prGroups, [{ any: ['IXAA'], not: [] }]);
  eq('  not a line', p.lines.any, []);
}
{
  const p = APPL.parse('-M480', OLD);
  eq('negated bare code', p.prGroups, [{ any: [], not: ['M480'] }]);
  ok('rejects a car with M480', !APPL.matches(p, { prCodes: new Set(['M480']) }));
}
{ // modern dialect must NOT read a bare code as PR (S is a trim, see WS6a)
  const p = APPL.parse('M030', IDX);
  eq('modern bare code ⇒ unknown, not PR', p.prGroups, []);
}

// ── WS5: LINE_SHAPE catch-all demoted - unknown words no longer enforce ───────
{
  const p = APPL.parse('AEROKIT BERUCOAT GAL SPORTS', OLD);
  eq('junk words are not enforced lines', p.lines.any, []);
  eq('all captured as permissive unknown',
     p.unknown.slice().sort(), ['AEROKIT', 'BERUCOAT', 'GAL', 'SPORTS']);
}
{ // a whitelisted line still enforces
  const p = APPL.parse('CARRERA AEROKIT', OLD);
  eq('real line kept', p.lines.any, ['CARRERA']);
  eq('junk demoted', p.unknown, ['AEROKIT']);
}
{ // no whitelist: multi-char words are lines, single strays are not
  const p = APPL.parse('TURBO D L R', IDX);
  eq('multi-char line kept', p.lines.any, ['TURBO']);
  eq('stray single letters demoted', p.unknown.slice().sort(), ['D', 'L', 'R']);
}

// ── WS6a/6b: drive + trim decomposition and spelling fold ─────────────────────
{
  const p = APPL.parse('CARRERA 4S', IDX);
  eq('line', p.lines.any, ['CARRERA']);
  eq('drive', p.drive.any, ['4']);
  eq('trim', p.trim.any, ['S']);
  ok('a C4S matches', APPL.matches(p, { line: 'CARRERA', drive: '4', trim: 'S' }));
  ok('a C2S does not (drive)', !APPL.matches(p, { line: 'CARRERA', drive: '2', trim: 'S' }));
  ok('a C4 base does not (trim)', !APPL.matches(p, { line: 'CARRERA', drive: '4', trim: 'BASE' }));
}
{
  const p = APPL.parse('TURBO S', IDX);
  eq('TURBO stays a line', p.lines.any, ['TURBO']);
  eq('S becomes trim, not a stray line', p.trim.any, ['S']);
  ok('no S in lines', !p.lines.any.includes('S'));
}
{
  eq('glued GT2RS → line', APPL.parse('GT2RS', IDX).lines.any, ['GT2']);
  eq('glued GT2RS → trim', APPL.parse('GT2RS', IDX).trim.any, ['RS']);
  eq('GT2-RS → line', APPL.parse('GT2-RS', IDX).lines.any, ['GT2']);
  eq('GT2-RS → trim', APPL.parse('GT2-RS', IDX).trim.any, ['RS']);
  eq('GT-2 RS → line', APPL.parse('GT-2 RS', IDX).lines.any, ['GT2']);
  eq('GT-2 RS → trim', APPL.parse('GT-2 RS', IDX).trim.any, ['RS']);
}
{ // hierarchy: RS 4.0 ⊇ RS
  const rs40 = APPL.parse('GT3 RS 4.0', IDX);
  eq('RS 4.0 trim', rs40.trim.any, ['RS 4.0']);
  ok('an RS 4.0 car takes an RS 4.0 part', APPL.matches(rs40, { line: 'GT3', trim: 'RS 4.0' }));
  ok('a plain RS car does NOT take an RS 4.0 part', !APPL.matches(rs40, { line: 'GT3', trim: 'RS' }));
  const rs = APPL.parse('GT3 RS', IDX);
  ok('an RS 4.0 car takes a plain RS part', APPL.matches(rs, { line: 'GT3', trim: 'RS 4.0' }));
  ok('a plain RS car takes a plain RS part', APPL.matches(rs, { line: 'GT3', trim: 'RS' }));
  ok('a base car takes neither', !APPL.matches(rs, { line: 'GT3', trim: 'BASE' }));
}
{ // C2/C4 both-ways: the digit is now an enforced drive facet, both spellings
  const p = APPL.parse('C4', IDX);
  eq('C4 → drive 4', p.drive.any, ['4']);
  ok('admits an AWD car', APPL.matches(p, { drive: '4' }));
  ok('rejects a RWD car', !APPL.matches(p, { drive: '2' }));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (typeof process !== 'undefined' && process.exit) process.exit(fail ? 1 : 0);
if (typeof self !== 'undefined') self.__APPL_TEST__ = { pass, fail };
