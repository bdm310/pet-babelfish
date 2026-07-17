// ═══════════════════════════════════════════════════════════════════════════
// ingest.worker.js — PET catalog ingestion pipeline
//
// Receives: { type:'ingest', buffer:ArrayBuffer, catalogId:string }
// Posts:    { type:'status',   message:string }
//           { type:'progress', pct:number, label:string }
//           { type:'done',     catalogId:string, sectionCount:number, partCount:number }
//           { type:'error',    message:string }
// ═══════════════════════════════════════════════════════════════════════════

// pdf.min.js is the main-thread API layer and references `document` directly
// (for canvas creation, font metrics, etc.). Provide a minimal polyfill before
// loading it so those accesses resolve to OffscreenCanvas equivalents.
if (typeof document === 'undefined') {
  self.document = {
    createElement(tag) {
      if (tag === 'canvas') return new OffscreenCanvas(1, 1);
      return { style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} };
    },
    createElementNS(_ns, tag) { return self.document.createElement(tag); },
    documentElement: { style: {}, lang: 'en' },
    fonts: { ready: Promise.resolve(), add() {}, check() { return true; } },
    readyState: 'complete',
  };
}
if (typeof window === 'undefined') self.window = self;

importScripts(
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/tesseract.min.js'
);

// The applicability grammar, shared verbatim with the viewer so a part's scope
// means the same thing when written as it does when read. The schema is shared
// for the same reason: the viewer checks a DB against the definition that wrote it.
importScripts(new URL('./appl.js', self.location.href).href);
importScripts(new URL('./schema.js', self.location.href).href);

// Prevent pdf.min.js from spawning a nested worker — it should use the
// already-running pdf.worker.min.js indirectly via the fake worker path.
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const PDFJS_OPTS = {
  cMapUrl:             'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
  cMapPacked:          true,
  standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/standard_fonts/',
};

const SQLJS_WASM    = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.wasm';
const DIAGRAM_SCALE = 2.0;

// OCR parameters — tuned for Porsche PET callout digits at ~7pt
// 6pt catches diagrams whose callouts render smaller (~5.5–6.5pt) because a large,
// sprawling illustration is scaled down to fit the frame (e.g. 604-015 / p268).
const OCR_FONT_PT_CANDIDATES = [6, 7, 8, 9, 12];  // pt sizes to try in cascade order
const OCR_TARGET_PX  = 40;   // upscale digits to this height before OCR
const OCR_BIN_THRESH = 128;
const OCR_MIN_CONF   = 90;
// Tessdata served alongside the worker
const TESSDATA_URL = new URL('./tessdata', self.location.href).href;

// Canvas factory using OffscreenCanvas — passed to getDocument() so PDF.js
// never needs to call document.createElement('canvas') for internal operations.
const CANVAS_FACTORY = {
  create(w, h)   { const c = new OffscreenCanvas(w || 1, h || 1); return { canvas: c, context: c.getContext('2d') }; },
  reset(p, w, h) { p.canvas.width = w; p.canvas.height = h; },
  destroy(p)     { p.canvas.width = 0; p.canvas.height = 0; },
};

// Expected column header strings as they appear in the PDF
const COL_HEADER_SET = new Set(['Pos', 'Part Number', 'Description', 'Remark', 'Qty', 'Model']);

// ── Entry point ───────────────────────────────────────────────────────────────

self.onmessage = async ({ data }) => {
  if (data.type === 'ingest') {
    try { await ingest(data.buffer, data.catalogId); }
    catch (err) { post('error', { message: String(err) }); }
  } else if (data.type === 'reingest-sections') {
    try { await reingestSections(data.buffer, data.catalogId, data.sectionNums, data.partsOnly ?? false); }
    catch (err) { post('error', { message: String(err) }); }
  } else if (data.type === 'ocr-page') {
    try { await ocrPage(data); }
    catch (err) { post('error', { message: String(err) }); }
  }
};

function post(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

async function ingest(buffer, catalogId) {
  const t0 = performance.now();
  let t;

  post('status', { message: 'Loading PDF…' });
  t = performance.now();
  const pdf = await pdfjsLib.getDocument({ data: buffer, ...PDFJS_OPTS, canvasFactory: CANVAS_FACTORY }).promise;
  TIMING.pdfLoad = performance.now() - t;

  post('status', { message: 'Initialising database…' });
  t = performance.now();
  const SQL = await initSqlJs({ locateFile: () => SQLJS_WASM });
  const db  = new SQL.Database();
  SCHEMA.create(db);
  TIMING.dbInit = performance.now() - t;

  post('status', { message: 'Initialising OCR…' });
  t = performance.now();
  const POOL_SIZE = navigator.hardwareConcurrency || 4;
  let pool = null;
  try {
    pool = await createWorkerPool(POOL_SIZE);
    post('status', { message: `${POOL_SIZE} OCR workers ready.` });
  } catch (e) {
    post('status', { message: `OCR unavailable (${e.message}) — callouts will be skipped.` });
  }
  TIMING.tesseractInit = performance.now() - t;

  post('status', { message: 'Opening storage…' });
  t = performance.now();
  const opfsRoot  = await navigator.storage.getDirectory();
  const catalogDir = await opfsRoot.getDirectoryHandle(catalogId, { create: true });
  TIMING.opfsSetup = performance.now() - t;

  post('status', { message: 'Parsing table of contents…' });
  t = performance.now();
  const outline = await pdf.getOutline();
  const { title, sections } = await parseOutline(outline, pdf);
  TIMING.tocParse = performance.now() - t;

  if (!sections.length) throw new Error('No sections found in TOC — is this a PET catalog?');

  post('status', { message: 'Parsing model/option information…' });
  t = performance.now();
  const vp = await parseVPages(pdf, sections[0].diagramPage);

  // After parseVPages: the model code comes off the V-page headers.
  db.run(
    'INSERT OR REPLACE INTO catalog (id, title, model, page_count, ingested_at, dialect, year_pivot) VALUES (?,?,?,?,?,?,?)',
    [catalogId, title, vp.model, pdf.numPages, new Date().toISOString(), vp.dialect, vp.yearPivot]
  );

  insertVPageData(db, catalogId, vp);
  // V-pages are parsed before any section, so the code index comes straight from
  // this parse — no re-query and no second pass over the sections.
  const codeIndex = buildCodeIndex(vp);
  const dialectInfo = { dialect: vp.dialect, yearPivot: vp.yearPivot, yearEnd: vp.yearEnd };
  TIMING.vPageParse = performance.now() - t;

  const mgCache   = new Map(); // `catalogId\0number` → rowid
  let   partCount = 0;

  const partStmt = db.prepare(PART_INSERT_SQL);

  const calloutStmt = db.prepare(
    'INSERT INTO callout (section_id, number, x0, y0, x1, y1, confidence) VALUES (?,?,?,?,?,?,?)'
  );

  // ── Phase 1: parallel — render diagrams (with OCR) and extract parts ─────────
  let doneCount = 0;
  const sectionResults = new Array(sections.length);

  await Promise.all(sections.map(async (sec, i) => {
    const tWorker = pool ? await pool.acquire() : null;
    try {
      const nextDiagramPage = sections[i + 1]?.diagramPage ?? (pdf.numPages + 1);
      const firstPartsPage  = sec.diagramPage + 1;

      const tDiag = performance.now();
      const [diagramResult, partsResults] = await Promise.all([
        renderDiagram(pdf, sec.diagramPage, tWorker)
          .catch(e => {
            post('status', { message: `Diagram render skipped for ${sec.sectionNum}: ${e.message}` });
            return { imgBytes: null, callouts: [] };
          }),
        extractSectionParts(pdf, firstPartsPage, nextDiagramPage),
      ]);
      TIMING.renderDiagram += performance.now() - tDiag;

      sectionResults[i] = { sec, diagramResult, partsResults };
    } finally {
      if (tWorker) pool.release(tWorker);
      doneCount++;
      post('progress', {
        pct:   Math.round((doneCount / sections.length) * 100),
        label: `${sec.sectionNum}${sec.sectionTitle ? ' — ' + sec.sectionTitle : ''}`,
      });
    }
  }));

  // ── Phase 2: sequential — insert collected results into the database ──────────
  for (let i = 0; i < sections.length; i++) {
    const { sec, diagramResult, partsResults } = sectionResults[i];
    const { imgBytes, callouts } = diagramResult;
    const firstPartsPage = sec.diagramPage + 1;

    t = performance.now();
    const mgId  = ensureMainGroup(db, mgCache, catalogId, sec.mainGroupNum, sec.mainGroupTitle);
    const secId = insertSection(
      db, mgId, catalogId, sec.sectionNum, sec.sectionTitle,
      firstPartsPage, sec.diagramPage, imgBytes
    );
    for (const c of callouts) {
      calloutStmt.run([secId, c.number, c.x0, c.y0, c.x1, c.y1, c.confidence]);
    }
    TIMING.dbInserts += performance.now() - t;

    for (let pi = 0; pi < partsResults.length; pi++) {
      const { parts, titleRow } = partsResults[pi];
      t = performance.now();
      if (pi === 0 && titleRow) applyTitleRow(db, secId, titleRow, sec.sectionTitle, codeIndex);
      partCount += insertPartBlocks(db, partStmt, secId, catalogId, parts, dialectInfo);
      TIMING.dbInserts += performance.now() - t;
    }

    TIMING.sectionCount++;
  }

  partStmt.free();
  calloutStmt.free();

  if (pool) await pool.terminate();

  post('status', { message: 'Building search index…' });
  t = performance.now();
  db.run("INSERT INTO part_fts(part_fts) VALUES ('rebuild')");
  TIMING.ftsBuild = performance.now() - t;

  post('status', { message: 'Saving database…' });
  t = performance.now();
  await writeOpfsFile(catalogDir, 'catalog.sqlite', db.export());
  TIMING.dbSave = performance.now() - t;
  db.close();
  pdf.destroy();

  const totalMs = performance.now() - t0;

  // ── Timing summary ────────────────────────────────────────────────────────
  const T = TIMING;
  const fmt     = ms  => `${(ms/1000).toFixed(2)}s`;
  const pct     = ms  => `${((ms/totalMs)*100).toFixed(1)}%`;
  const perSec  = n   => T.sectionCount   ? `(${(n/T.sectionCount).toFixed(0)}ms/sec)` : '';
  const perPage = n   => T.partsPagesCount? `(${(n/T.partsPagesCount).toFixed(0)}ms/pg)` : '';
  const perDiag = n   => T.diagramCount   ? `(${(n/T.diagramCount).toFixed(0)}ms/diag)` : '';
  const perCall = n   => T.recognizeCount ? `(${(n/T.recognizeCount).toFixed(1)}ms/call)` : '';
  post('status', { message:
    `\n── Ingest Perf (${T.sectionCount} sections, ${T.partsPagesCount} parts pages, ${T.diagramCount} OCR diagrams) ──\n` +
    `  TOTAL              : ${fmt(totalMs)}\n` +
    `  PDF load           : ${fmt(T.pdfLoad)} [${pct(T.pdfLoad)}]\n` +
    `  DB init (sql.js)   : ${fmt(T.dbInit)} [${pct(T.dbInit)}]\n` +
    `  Tesseract init     : ${fmt(T.tesseractInit)} [${pct(T.tesseractInit)}]\n` +
    `  OPFS setup         : ${fmt(T.opfsSetup)} [${pct(T.opfsSetup)}]\n` +
    `  TOC parse          : ${fmt(T.tocParse)} [${pct(T.tocParse)}]\n` +
    `  V-page parse       : ${fmt(T.vPageParse)} [${pct(T.vPageParse)}]\n` +
    `  renderDiagram()    : ${fmt(T.renderDiagram)} [${pct(T.renderDiagram)}] ${perSec(T.renderDiagram)}\n` +
    `    page render+oplist : ${fmt(T.render)} ${perDiag(T.render)}\n` +
    `    WebP encode        : ${fmt(T.convertDiagram)} ${perDiag(T.convertDiagram)}\n` +
    `    ocrDiagram() total : ${fmt(T.totalOcr)} ${perDiag(T.totalOcr)}\n` +
    `      binarize+upscale   : ${fmt(T.binarizeUpscale)}\n` +
    `      findBlobs (BFS)    : ${fmt(T.findBlobs)}\n` +
    `      renderBlobCanvas×N : ${fmt(T.renderBlobs)}\n` +
    `      convertToBlob×N×2  : ${fmt(T.convertBlobs)} ${perCall(T.convertBlobs)}\n` +
    `      tesseract.setParams: ${fmt(T.tesseractSet)}\n` +
    `      tesseract.recognize: ${fmt(T.tesseractOcr)} ${perCall(T.tesseractOcr)} [${pct(T.tesseractOcr)}]\n` +
    `  extractParts()     : ${fmt(T.extractParts)} [${pct(T.extractParts)}] ${perPage(T.extractParts)}\n` +
    `  DB inserts         : ${fmt(T.dbInserts)} [${pct(T.dbInserts)}]\n` +
    `  FTS rebuild        : ${fmt(T.ftsBuild)} [${pct(T.ftsBuild)}]\n` +
    `  DB save (OPFS)     : ${fmt(T.dbSave)} [${pct(T.dbSave)}]\n`
  });

  post('done', { catalogId, sectionCount: sections.length, partCount });
}

// ── TOC / outline parsing ─────────────────────────────────────────────────────

async function parseOutline(outline, pdf) {
  if (!outline?.length) throw new Error('PDF has no outline/TOC');

  const sections = [];
  let title = '';

  for (const l1 of outline) {
    if (!l1.items?.length) continue;
    if (!title) title = l1.title;

    for (const l2 of l1.items) {
      // "Main group 1: Engine" or fallback "1 - Engine"
      const mgMatch = l2.title.match(/Main\s+group\s+(\d+)[:\s]+(.*)/i)
                   ?? l2.title.match(/^(\d+)\s*[-:]\s*(.*)/);
      const mainGroupNum   = mgMatch?.[1]?.trim() ?? '';
      const mainGroupTitle = mgMatch?.[2]?.trim() ?? l2.title;

      for (const l3 of l2.items ?? []) {
        // "101-000: Crankcase", "001-00: Tool" (2- or 3-digit suffix), or "101-000 Crankcase"
        const secMatch = l3.title.match(/^(\d{3}-\d{2,3})[:\s]*(.*)/);
        const sectionNum   = secMatch?.[1] ?? l3.title;
        const sectionTitle = secMatch?.[2]?.trim() ?? '';

        const diagramPage = await resolveDestPage(l3.dest, pdf);
        if (!diagramPage) continue;

        sections.push({ mainGroupNum, mainGroupTitle, sectionNum, sectionTitle, diagramPage });
      }
    }
  }

  return { title, sections };
}

async function resolveDestPage(dest, pdf) {
  try {
    let ref;
    if (typeof dest === 'string') {
      const resolved = await pdf.getDestination(dest);
      ref = resolved?.[0];
    } else if (Array.isArray(dest)) {
      ref = dest[0];
    }
    if (!ref) return null;
    return (await pdf.getPageIndex(ref)) + 1; // convert 0-based → 1-based
  } catch { return null; }
}

// ── V-pages (intro pages: model info, PR codes, VIN ranges) ──────────────────

async function parseVPages(pdf, firstDiagramPage) {
  const prCodes      = [];
  const salesTypes   = [];
  const vinRanges    = [];
  const engineCodes  = [];
  const transmCodes  = [];
  const engineNums   = [];
  const transmNums   = [];

  // Per-table state persists ACROSS pages. A reference table that spills onto a
  // second page prints its data rows there with NO repeated header, so the old
  // header-keyed dispatch left the continuation matching no parser and dropped
  // whole model years. Now the last table that owned a header stays `active` and
  // keeps consuming headerless pages; each parser carries its `inData` latch and
  // open row in this state so it resumes mid-table instead of restarting.
  const S = {
    pr:   { inData: false, current: null },
    sales:{ inData: false },
    ec:   { inData: false },
    tc:   { inData: false },
    vin:  { inData: false, current: null },
    summ: { inData: false, lastVehicle: null, lastMY: null },
    seng: { inData: false, last: null },
    stx:  { inData: false, last: null },
    eno:  { inData: false },
    tno:  { inData: false },
  };
  let model = '', dialect = 'modern', yearPivot = null, yearEnd = null;

  // yearPivot is read at call time (closures over `let`), so the SUMMARY parsers
  // see it even though the array is built before the Model-life header is scanned.
  const handlers = [
    ['Optional Equipment',        rows => parsePRCodesPage(rows, prCodes, S.pr)],
    ['Model Overview Sales Type', rows => parseSalesTypesPage(rows, salesTypes, S.sales)],
    ['Model Overview EC',         rows => parseEngineCodesPage(rows, engineCodes, S.ec)],
    ['Model Overview TC',         rows => parseTransmissionCodesPage(rows, transmCodes, S.tc)],
    ['VIN-Numbers Overview',      rows => parseVINRangesPage(rows, vinRanges, S.vin)],
    ['SUMMARY TYPES',             rows => parseSummaryTypesPage(rows, vinRanges, S.summ)],
    ['SUMMARY ENGINES',           rows => parseSummaryEnginesPage(rows, engineCodes, engineNums, S.seng, yearPivot)],
    ['SUMM.TRANSMISS',            rows => parseSummaryTransmissionsPage(rows, transmCodes, transmNums, S.stx, yearPivot)],
    ['Engine type',               rows => parseEngineNumbersPage(rows, engineNums, S.eno)],
    ['Gearbox type',              rows => parseTransmissionNumbersPage(rows, transmNums, S.tno)],
  ];
  let active = null;

  for (let pageNum = 1; pageNum < firstDiagramPage; pageNum++) {
    const page    = await pdf.getPage(pageNum);
    const vp      = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    page.cleanup();

    const items    = content.items.filter(it => it.str?.trim());
    const rowObjs  = groupIntoRows(items, vp.height);
    const rows     = rowObjs.map(r => r.items.map(it => it.str.trim()).filter(Boolean));
    const pageText = rows.map(r => r.join(' ')).join('\n');

    // Every V-page repeats "Model: 997T07 Model life 2007>>2009". The code is not
    // one token — "356 50" and "9PA 03" contain a space — so "Model life" is the
    // only reliable right edge. The life-start year is the century pivot for the
    // old dialect's two-digit years.
    if (!model) model = pageText.match(/Model:\s*(.+?)\s+Model life/)?.[1] ?? '';
    if (!yearPivot) {
      const m = pageText.match(/Model life\s+(\d{4})\s*>>\s*(\d{4})/);
      if (m) { yearPivot = parseInt(m[1], 10); yearEnd = parseInt(m[2], 10); }
    }
    // The old-dialect summary layouts are the one reliable, in-catalog dialect
    // signal (the guiding principle: detect, never branch on catalog id).
    if (/SUMMARY ENGINES|SUMM\.TRANSMISS|SUMMARY TYPES/.test(pageText)) dialect = 'old';

    const h = handlers.find(([key]) => pageText.includes(key));
    if (h) { active = h; h[1](rows); }
    else if (active) active[1](rows);   // headerless continuation of the open table
  }

  if (S.pr.current)  prCodes.push(S.pr.current);
  if (S.vin.current) vinRanges.push(S.vin.current);

  return { model, dialect, yearPivot, yearEnd, prCodes, salesTypes, vinRanges,
           engineCodes, transmCodes, engineNums, transmNums };
}

// `state.current` is the open entry and is owned by the caller, because a description
// can wrap past a page break — 567 is "Windscreen tinted, upper part darker coloured",
// and "darker coloured" lands after the repeated header on the next page. A per-page
// `current` is null there, so the tail was silently dropped. The caller flushes the
// last open entry once every page has been read.
function parsePRCodesPage(rows, prCodes, state) {
  const CODE_RE = /^\d{3}$|^[A-Z][A-Z0-9]{2,3}$/;

  for (const texts of rows) {
    if (!texts.length) continue;

    if (!state.inData) {
      const rowText = texts.join(' ');
      if (/\bNR\b/.test(rowText) && rowText.includes('Description')) { state.inData = true; }
      continue;
    }

    // Skip repeated page headers
    const rowJoined = texts.join(' ');
    if (rowJoined.startsWith('Optional Equipment') ||
        texts.some(t => t.startsWith('Model:')) ||
        texts.some(t => /^\d{2}\.\d{2}\.\d{4}/.test(t))) continue;

    // Footnote markers
    if (texts[0] === '*') continue;

    if (CODE_RE.test(texts[0])) {
      if (state.current) prCodes.push(state.current);
      state.current = { code: texts[0], description: texts.slice(1).join(' ') };
    } else if (state.current) {
      state.current.description = (state.current.description + ' ' + texts.join(' ')).trim();
    }
  }
}

function parseSalesTypesPage(rows, salesTypes, state) {
  for (const texts of rows) {
    if (!texts.length) continue;
    if (!state.inData) {
      if (texts.join(' ').includes('Sales term')) { state.inData = true; }
      continue;
    }
    // Skip a repeated page header on a continuation page.
    if (texts.some(t => t.startsWith('Model:')) || (texts.length === 1 && texts[0] === 'V-Pages')) continue;

    // Mounting time is the anchor: "MM/YY-MM/YY"
    const mountIdx = texts.findIndex(t => /^\d{2}\/\d{2}-\d{2}\/\d{2}$/.test(t));
    if (mountIdx < 1 || !/^\d{5,6}$/.test(texts[0])) continue;

    const [mountFrom, mountTo] = texts[mountIdx].split('-');
    salesTypes.push({
      salesTerm:   texts[0],
      description: texts.slice(1, mountIdx).join(' '),
      mountFrom:   mountFrom || null,
      mountTo:     mountTo   || null,
      remark:      texts.slice(mountIdx + 1).join(' ') || null,
    });
  }
}

function parseVINRangesPage(rows, vinRanges, state) {
  for (const texts of rows) {
    if (!texts.length) continue;
    if (!state.inData) {
      if (texts.join(' ').includes('Model year')) { state.inData = true; }
      continue;
    }

    // Repeated page headers on a continuation page. Without these skips the
    // "V-Pages" / "Model:" lines get appended into the open row's remark.
    if (texts.some(t => t.startsWith('Model:')) || (texts.length === 1 && texts[0] === 'V-Pages')) continue;

    if (/^\d{4}$/.test(texts[0])) {
      if (state.current) vinRanges.push(state.current);
      // VIN-to may be its own item ">99-7S783000" or merged with vin_from; find it by ">" prefix
      const vinToIdx = texts.findIndex((t, i) => i >= 3 && t.startsWith('>'));
      const vinToRaw = vinToIdx >= 0 ? texts[vinToIdx] : (texts[3] || '');
      const remarkStart = vinToIdx >= 0 ? vinToIdx + 1 : 4;
      state.current = {
        modelYear: parseInt(texts[0]),
        startDate: texts[1] || null,
        vinFrom:   texts[2] || null,
        vinTo:     vinToRaw.replace(/^>/, '') || null,
        remark:    texts.slice(remarkStart).join(' ') || null,
      };
    } else if (state.current) {
      // Skip page header/footer lines (e.g. "19.07.2018 - 1 Kat P30")
      if (texts.some(t => /^\d{2}\.\d{2}\.\d{4}/.test(t))) continue;
      const cont = texts.join(' ').trim();
      if (cont) state.current.remark = state.current.remark ? state.current.remark + ' ' + cont : cont;
    }
  }
}

// Parses older "SUMMARY TYPES" pages (e.g. Cayenne 955, 356).
//
// Cayenne row: CAYENNE [S] [TURBO] [(...markets...)]  03  3  9P3LA  00061>10000  M02.2Y  184  KW
//   tokens:    [vehicle words...]                      MY  #  pfx    from>to      engine  kw  "KW"
// 356 row:   *  356 COUPE  50  05001>05410  369/1100
//   tokens:  *  [vehicle]  MY  from>to      engine
//
// Continuation rows (356 only): just an extra from>to on its own line — inherit last vehicle+MY.
function parseSummaryTypesPage(rows, vinRanges, state) {
  // VIN/chassis range token: optional prefix letters then digits>digits, OR an
  // open-ended "150001>" (356 production tail) with nothing after the '>'.
  const VIN_RE = /^[A-Z]*\d[\w]*>(?:[A-Z]*\d[\w]*)?$/;
  // A separate VIN-prefix token in the 996-family MY column: "99WS6", "991S6".
  const PFX_RE = /^\d\d[A-Z0-9]S\d$/;

  for (const texts of rows) {
    if (!texts.length) continue;

    // Skip page header/footer lines
    if (texts.some(t => /^\d{2}\.\d{2}\.\d{4}/.test(t))) continue;
    if (texts.some(t => t.startsWith('Model:'))) continue;
    if (texts.length === 1 && texts[0] === 'V-Pages') continue;

    if (!state.inData) {
      // Header row: "VIN" or "VEHICLE IDENT.NR." column label signals start of data
      if (texts.some(t => t === 'VIN' || t === 'IDENT.NR.' || t.startsWith('IDENT'))) {
        state.inData = true;
      }
      continue;
    }

    // Skip section/page title repetitions and footnote text
    if (texts.includes('SUMMARY') && texts.includes('TYPES')) continue;
    if (texts.includes('PLEASE') || texts.join(' ').includes('NOTE THE LAST')) continue;

    // Strip leading '*' footnote marker
    const ts = (texts[0] === '*') ? texts.slice(1) : texts.slice();
    if (!ts.length) continue;

    // Find the VIN range token
    const vinIdx = ts.findIndex(t => VIN_RE.test(t));
    if (vinIdx === -1) continue;

    // Tokens before the VIN range: [...vehicleWords, MY_2digit, ?myCode, ?vinPfx]
    const pre = ts.slice(0, vinIdx);

    // Find the 2-digit MY: last token matching exactly \d{2} in pre
    let myIdx = -1;
    for (let i = pre.length - 1; i >= 0; i--) {
      if (/^\d{2}$/.test(pre[i])) { myIdx = i; break; }
    }

    let vehicle, my, vinPrefix;
    if (myIdx >= 0) {
      vehicle = pre.slice(0, myIdx).join(' ') || state.lastVehicle;
      my      = pre[myIdx];

      // The 996 family prints the MY column as two tokens — the 2-digit year plus a
      // one-char MY code (W=1998, X=1999, Y=2000, then digits) — and the VIN prefix
      // ("99XS6") is a THIRD token. The old find(/[A-Z]/) grabbed the code letter
      // "X" instead, mangling "99XS6 20061" into prefix "X". Read the prefix by its
      // shape positionally; otherwise (Cayenne/356) fall back to the first lettered
      // token as before.
      const afterMY = pre.slice(myIdx + 1);
      const shaped  = afterMY.find(t => PFX_RE.test(t));
      vinPrefix = shaped || afterMY.find(t => /[A-Z]/.test(t)) || '';

      state.lastVehicle = vehicle;
      state.lastMY      = my;
    } else {
      // Continuation row (e.g. 356 extra VIN range for same vehicle/MY)
      vehicle   = state.lastVehicle;
      my        = state.lastMY;
      vinPrefix = '';
    }

    // Parse the VIN range token, which may have an embedded prefix (e.g. "9P6LA00061>10000")
    const vinRaw  = ts[vinIdx];
    const halves  = vinRaw.split('>');
    const fromRaw = halves[0] || '';
    const toRaw   = halves[1] || '';

    // Extract prefix embedded in fromRaw: everything up to and including the last letter
    // e.g. "9P6LA00061" → prefix "9P6LA", serial "00061"
    // e.g. "05001"      → prefix "", serial "05001"
    const embM = fromRaw.match(/^(.*[A-Z])(\d+)$/);
    const embeddedPfx = embM ? embM[1] : '';

    // The effective prefix is: embedded (from the range token itself) or external (from pre tokens)
    const pfx = embeddedPfx || vinPrefix;

    // Reconstruct vinFrom (already has pfx embedded if embeddedPfx)
    const vinFrom = (embeddedPfx ? fromRaw : pfx + fromRaw) || null;

    // For vinTo: if the "to" side is purely numeric, prepend the same prefix
    const vinTo = (/^\d+$/.test(toRaw) ? pfx : '') + toRaw || null;

    // Tokens after vinIdx: engine type + power → remark suffix
    const engineStr = ts.slice(vinIdx + 1).join(' ') || null;

    const remarkParts = [vehicle, engineStr].filter(Boolean);
    const remark      = remarkParts.length ? remarkParts.join(' — ') : null;

    vinRanges.push({
      modelYear: my ? parseInt(my) : null,
      startDate: null,
      vinFrom,
      vinTo,
      remark,
    });
  }
}

function parseEngineCodesPage(rows, engineCodes, state) {
  for (const texts of rows) {
    if (!texts.length) continue;
    if (!state.inData) {
      if (texts[0] === 'EC') { state.inData = true; }
      continue;
    }
    if (texts.some(t => t.startsWith('Model:') || /^\d{2}\.\d{2}\.\d{4}/.test(t))) continue;
    const mountIdx = texts.findIndex(t => /^\d{2}\/\d{2}-\d{2}\/\d{2}$/.test(t));
    if (mountIdx < 1) continue;
    const [mountFrom, mountTo] = texts[mountIdx].split('-');
    const pre = texts.slice(1, mountIdx); // [ltr, kw, hp, cyl] reading right-to-left
    engineCodes.push({
      ec:            texts[0],
      displacementL: pre.at(-4) || null,
      powerKw:       parseInt(pre.at(-3)) || null,
      powerHp:       parseInt(pre.at(-2)) || null,
      cylinders:     parseInt(pre.at(-1)) || null,
      mountFrom, mountTo,
      remark: texts.slice(mountIdx + 1).join(' ') || null,
    });
  }
}

function parseTransmissionCodesPage(rows, transmCodes, state) {
  for (const texts of rows) {
    if (!texts.length) continue;
    if (!state.inData) {
      if (texts[0] === 'TC') { state.inData = true; }
      continue;
    }
    if (texts.some(t => t.startsWith('Model:') || /^\d{2}\.\d{2}\.\d{4}/.test(t))) continue;
    const mountIdx = texts.findIndex(t => /^\d{2}\/\d{2}-\d{2}\/\d{2}$/.test(t));
    if (mountIdx < 1) continue;
    const [mountFrom, mountTo] = texts[mountIdx].split('-');
    transmCodes.push({
      tc:       texts[0],
      typeCode: texts.slice(1, mountIdx).at(-1) || null,
      mountFrom, mountTo,
      remark: texts.slice(mountIdx + 1).join(' ') || null,
    });
  }
}

// A serial range prints as "627 00501>18000" or "A9750 1 002001>999999": the value
// after ">" is only the final segment and inherits every leading block segment from
// the start value. Taken literally, "18000" is a different series than "627 00501"
// and no range comparison against it can work. 627/628/629 are the year-coded engine
// blocks, so the end of that range is "627 18000".
function expandRangeEnd(from, to) {
  if (!to) return null;
  const f = from.trim().split(/\s+/);
  const t = to.trim().split(/\s+/);
  if (t.length >= f.length) return t.join(' ');
  return [...f.slice(0, f.length - t.length), ...t].join(' ');
}

function parseEngineNumbersPage(rows, engineNumbers, state) {
  for (const texts of rows) {
    if (!texts.length) continue;
    if (!state.inData) {
      if (texts.join(' ').includes('Engine number')) { state.inData = true; }
      continue;
    }
    if (texts.some(t => /^\d{2}\.\d{2}\.\d{4}/.test(t))) continue;
    // Year is always 20xx; engine codes like "9770" are excluded by this pattern
    const yearIdx = texts.findIndex(t => /^20\d{2}$/.test(t));
    if (yearIdx < 1) continue;
    const numberRaw = texts.slice(0, yearIdx).join(' ');
    const gtMatch   = numberRaw.match(/^(.+?)\s*>\s*(.+)$/);
    const numberFrom = (gtMatch ? gtMatch[1] : numberRaw).trim();
    engineNumbers.push({
      numberFrom,
      numberTo:    gtMatch ? expandRangeEnd(numberFrom, gtMatch[2]) : null,
      modelYear:   parseInt(texts[yearIdx]),
      vehicleType: texts.slice(yearIdx + 1, -1).join(' '),
      engineType:  texts.at(-1),
    });
  }
}

function parseTransmissionNumbersPage(rows, transmNumbers, state) {
  for (const texts of rows) {
    if (!texts.length) continue;
    if (!state.inData) {
      if (texts.join(' ').includes('Gearbox type')) { state.inData = true; }
      continue;
    }
    if (texts.some(t => /^\d{2}\.\d{2}\.\d{4}/.test(t))) continue;
    const yearIdx = texts.findIndex(t => /^20\d{2}$/.test(t));
    if (yearIdx < 1) continue;
    const numberRaw = texts.slice(0, yearIdx).join(' ');
    const gtMatch   = numberRaw.match(/^(.+?)\s*>\s*(.+)$/);
    const numberFrom = (gtMatch ? gtMatch[1] : numberRaw).trim();
    transmNumbers.push({
      numberFrom,
      numberTo:    gtMatch ? expandRangeEnd(numberFrom, gtMatch[2]) : null,
      modelYear:   parseInt(texts[yearIdx]),
      vehicleType: texts.slice(yearIdx + 1, -1).join(' '),
      gearboxType: texts.at(-1),
    });
  }
}

// ── Old-dialect V-page summaries (996 family, Cayenne, 356) ──────────────────
// These catalogs replace the modern "Model Overview EC/TC" + "Engine/Gearbox
// number" pages with one "SUMMARY ENGINES" / "SUMM.TRANSMISS." table that carries
// the code, tech data AND the serial-number range in a single row per vehicle-type
// × model year. One parser fills both the *_code and *_number_range tables.
// Without them these six catalogs ingested zero code rows, leaving every dotted
// code (M96.03, G96.50) untyped and every engine/gearbox breakpoint unenforceable.
// Their number ranges are NOT the ambiguous modern ones — 356/Cayenne serials are
// distinct per type — so deriving from them is sound.

// Expand a 2-digit model year using the Model-life pivot (pivot 1998: "05"→2005).
function pivotYear(yy, pivot) {
  const n = parseInt(yy, 10);
  if (Number.isNaN(n) || !pivot) return null;
  let full = Math.floor(pivot / 100) * 100 + n;
  if (full < pivot) full += 100;
  return full;
}

// TECH tail: "6ZYL/3,4L /220 KW" → { cylinders:6, displacementL:"3.4", powerKw:220 }.
function parseSummaryTech(tail) {
  const cyl = tail.match(/(\d+)\s*ZYL/);
  const dis = tail.match(/([\d,]+)\s*L\b/);
  const kw  = tail.match(/(\d+)\s*\/?\s*KW/);
  return {
    cylinders:     cyl ? parseInt(cyl[1], 10) : null,
    displacementL: dis ? dis[1].replace(',', '.') : null,
    powerKw:       kw  ? parseInt(kw[1], 10) : null,
  };
}

const SUMM_EC_RE  = /^[A-Z]\d{2}\.[0-9A-Z]{2,3}$/; // M96.01, M96.70S, M02.2Y
const SUMM_TC_RE  = /^[GA]\d{2}\.\d{2}$/;          // G96.00, A96.50
const SUMM_TN_RE  = /^[GA]\d{4}$/;                 // G9600, A4820 (undotted TC)
const SUMM_356_RE = /^\d{3}(?:\/\d)?$/;            // 369, 506/1, 547/1, 519
const SUMM_GT_RE  = t => t.includes('>') && /\d/.test(t) && /^[A-Z0-9]*\d*>[A-Z0-9]*\d*$/.test(t);
const undot = code => code.replace(/^[A-Z]/, '').replace('.', '');

function isVPageChrome(texts) {
  return texts[0] === 'V-Pages' ||
         texts.some(t => t.startsWith('Model:') || /^\d{2}\.\d{2}\.\d{4}/.test(t));
}

function parseSummaryEnginesPage(rows, engineCodes, engineNumbers, state, pivot) {
  const seen = state.seen || (state.seen = new Set());
  for (const texts of rows) {
    if (!texts.length || isVPageChrome(texts)) continue;
    if (!state.inData) { if (texts.includes('MY')) state.inData = true; continue; }
    if (texts.includes('SUMMARY') && texts.includes('ENGINES')) continue;

    const eIdx = texts.findIndex(t => SUMM_EC_RE.test(t));
    if (eIdx >= 0) {
      // General (996/996Turbo/996GT3/Cayenne): dotted EC + year-code + prefix block.
      const rIdx = texts.findIndex((t, i) => i > eIdx && SUMM_GT_RE(t));
      if (rIdx < 1) continue;
      const ec      = texts[eIdx];
      const my4     = pivotYear(texts[eIdx + 1], pivot);
      const prefix  = texts[rIdx - 1] || '';
      const vehicle = texts.slice(0, eIdx).join(' ');
      const tech    = parseSummaryTech(texts.slice(rIdx + 1).join(' '));
      const [fromS, toS] = texts[rIdx].split('>');
      if (!seen.has(ec)) {
        seen.add(ec);
        engineCodes.push({ ec, displacementL: tech.displacementL, powerKw: tech.powerKw,
          powerHp: null, cylinders: tech.cylinders, mountFrom: null, mountTo: null, remark: null });
      }
      const numberFrom = (prefix ? prefix + ' ' : '') + fromS;
      engineNumbers.push({ numberFrom, numberTo: toS ? expandRangeEnd(numberFrom, toS) : null,
        modelYear: my4, vehicleType: vehicle, engineType: undot(ec) });
      state.last = { vehicle, my4, type: undot(ec) };
      continue;
    }

    // 356: bare 3-digit TYPE, then MY, then a '>'- or '/'-separated range.
    let myI = -1;
    for (let i = 1; i < texts.length - 1; i++) {
      if (/^\d{2}$/.test(texts[i]) && /[>/]/.test(texts[i + 1]) && /\d/.test(texts[i + 1])) { myI = i; break; }
    }
    if (myI >= 1) {
      const type    = texts[myI - 1];
      const my4     = pivotYear(texts[myI], pivot);
      const vehicle = texts.slice(0, myI - 1).join(' ');
      const tech    = parseSummaryTech(texts.slice(myI + 2).join(' '));
      const [fromS, toS] = texts[myI + 1].split(/[>/]/);
      if (!seen.has(type)) {
        seen.add(type);
        engineCodes.push({ ec: type, displacementL: tech.displacementL, powerKw: tech.powerKw,
          powerHp: null, cylinders: tech.cylinders, mountFrom: null, mountTo: null, remark: null });
      }
      engineNumbers.push({ numberFrom: fromS || null, numberTo: toS || null,
        modelYear: my4, vehicleType: vehicle, engineType: type });
      state.last = { vehicle, my4, type };
    } else if (texts.length === 1 && SUMM_GT_RE(texts[0]) && state.last) {
      // 356 continuation: a lone range on the previous row's vehicle/MY/type.
      const [fromS, toS] = texts[0].split('>');
      engineNumbers.push({ numberFrom: fromS || null, numberTo: toS || null,
        modelYear: state.last.my4, vehicleType: state.last.vehicle, engineType: state.last.type });
    }
  }
}

function parseSummaryTransmissionsPage(rows, transmCodes, transmNumbers, state, pivot) {
  const seen = state.seen || (state.seen = new Set());
  for (const texts of rows) {
    if (!texts.length || isVPageChrome(texts)) continue;
    if (!state.inData) { if (texts.includes('MY')) state.inData = true; continue; }
    if (texts.includes('SUMM.TRANSMISS.') || (texts.includes('SUMMARY') && texts.includes('TRANSMISS'))) continue;

    const tcIdx = texts.findIndex(t => SUMM_TC_RE.test(t));
    if (tcIdx >= 0) {
      // General: dotted TC + year-code + undotted TN-prefix + variant index + range.
      const pIdx = texts.findIndex((t, i) => i > tcIdx && SUMM_TN_RE.test(t));
      const rIdx = texts.findIndex((t, i) => i > tcIdx && SUMM_GT_RE(t));
      if (pIdx < 0 || rIdx < 0) continue;
      const tc      = texts[tcIdx];
      const my4     = pivotYear(texts[tcIdx + 1], pivot);
      const tnPfx   = texts[pIdx];
      const index   = texts[rIdx - 1] || '';
      const vehicle = texts.slice(0, tcIdx).join(' ');
      const tech    = texts.slice(rIdx + 1).join(' ') || null;
      const [fromS, toS] = texts[rIdx].split('>');
      if (!seen.has(tc)) {
        seen.add(tc);
        transmCodes.push({ tc, typeCode: tech, mountFrom: null, mountTo: null, remark: null });
      }
      const numberFrom = `${tnPfx} ${index} ${fromS}`.replace(/\s+/g, ' ').trim();
      transmNumbers.push({ numberFrom, numberTo: toS ? expandRangeEnd(numberFrom, toS) : null,
        modelYear: my4, vehicleType: vehicle, gearboxType: tnPfx });
      state.lastNum = null;
      continue;
    }

    // 356: bare 3-digit TYPE, MY, then a possibly open-ended range (">10999").
    let myI = -1;
    for (let i = 1; i < texts.length - 1; i++) {
      if (/^\d{2}$/.test(texts[i]) && SUMM_GT_RE(texts[i + 1])) { myI = i; break; }
    }
    if (myI >= 1 && SUMM_356_RE.test(texts[myI - 1])) {
      const type    = texts[myI - 1];
      const my4     = pivotYear(texts[myI], pivot);
      const vehicle = texts.slice(0, myI - 1).join(' ');
      const tech    = texts.slice(myI + 2).join(' ') || null;
      const [fromS, toS] = texts[myI + 1].split('>');
      if (!seen.has(type)) {
        seen.add(type);
        transmCodes.push({ tc: type, typeCode: tech, mountFrom: null, mountTo: null, remark: null });
      }
      const num = { numberFrom: fromS || null, numberTo: toS || null,
        modelYear: my4, vehicleType: vehicle, gearboxType: type };
      transmNumbers.push(num);
      state.lastNum = num;
    } else if (state.lastNum && texts.every(t => /^[A-Z]+$/.test(t))) {
      // 356 continuation: lone body words (SPEEDSTER, CONVERTIBLE) extend the row.
      state.lastNum.vehicleType = `${state.lastNum.vehicleType} ${texts.join(' ')}`.trim();
    }
  }
}

// ── Parts extraction ──────────────────────────────────────────────────────────
//
// The PDF is BLOCK-oriented, not row-oriented. A part is a header row followed by
// continuation rows that extend each column INDEPENDENTLY — and one continuation
// row can carry several columns at once. Column origins are constant across all
// parts pages (Pos=14, Part Number=57, Description=162, Remark=346, Qty=445,
// Model=488) but are still calibrated per page from the header row.
//
//   [33]1 [57]997 555 201 05 [162]Door panel trim [346]left [405]lhd [445]1 [488]TURBO/COUPE
//                                                                         [488]PR:098,490,  <- Model wrap
//                            [162]Leather                                 [488]981          <- Description AND Model
//   [57]997 555 201 05 [138]FSA [162]black/grey                                             <- colour variant (child row)
//                            [162]D >> - MJ 2007                                           <- year footer, scopes FSA
//
// Rows are routed BY COLUMN, never by sniffing the whole row:
//   Pos / Qty   — header row only. Accumulating them would corrupt values that
//                 are currently exact.
//   Model       — extends the CURRENT row. A Model-only continuation (no part
//                 number) extends the parent block; a row that carries a part
//                 number is a new child and owns whatever Model text it carries.
//   Description — applicability-shaped text ("D - MJ 2008>>", "F >> 99-9S770 428")
//                 scopes the CURRENT row; anything else extends the current row's
//                 description (the parent, or the last variant).
//   Remark      — extends the current row's remark.
//
// A colour variant (Part Number but no Pos) becomes a CHILD of the open block: it
// stays orderable and searchable but occupies no position of its own.
//
// A year/chassis footer scopes exactly the ONE row it is printed under — never a
// run of rows, and never the whole block. 809-020 (p487) proves it: the same
// "D >> - MJ 2007" is reprinted under each of three consecutive colours, and
// colours with no footer sit BETWEEN footered ones ("M7Z GT Silver" between two
// "D >> - MJ 2008" rows). Sweeping a footer back over the preceding run would
// restrict long-running colours to the year in which a neighbour was introduced.
//
// Because a child's scope must survive on its own — the viewer resolves a child
// through COALESCE(child.applicability, parent.applicability), which REPLACES
// rather than merges — a child that carries any scope of its own is given the
// parent's scope too. Storing only the child's own footer would silently drop the
// parent's PR gate from every such row.

// Cross-reference / sub-assembly markers. Their bodies are printed back at the
// Description origin, so once one appears it closes DESCRIPTION accumulation for
// the block (applicability continuations still route normally). "comprising:"
// lists a kit's contents, "We take back:" names the core a part is exchanged
// against, "Group:" and "use if required:" point at a technical manual or an
// alternative number — none of them describe the part they sit under, so the
// marker and everything after it accumulate into the row's REMARK instead.
const ANNOT_RE = /^(?:with:|without:|also use:|use if required:|only in conj\. with:|see illustration|comprising:|we take back:|group:)/i;

// The one Description-column line printed after an advisory that still belongs
// to the PART, not the advisory: it must reach the description even once an
// annotation has closed it ("also use: … / D - MJ 2008>> / Discontinued part",
// 601-005 p245).
const FLAG_RE = /^Discontinued part$/i;

// "Valid up to:" / "Valid from:" head the F/M breakpoint rows printed beneath
// them. The direction is already carried by where each clause puts its '>>', so
// the label adds nothing — but it must NOT close the block the way a cross-
// reference does, because those clauses still have to reach the row they scope.
const SCOPE_LABEL_RE = /^(?:valid up to:|valid from:)/i;

// A labelled value rather than prose: the label sits in the Description column
// while the value it names is over in Remark ("relay location/code no.:" | "S4").
// The pair belongs in the remark — the label alone pollutes the description, and
// the bare "S4" is the only thing telling three otherwise identical relays apart.
const REMARK_LABEL_RE = /^relay location\/code no\.:/i;

// A market exclusion printed as prose, with the country named on the row below.
// It joins the market vocabulary the catalog already quotes ('"AUS"', '"GB."',
// '"J.."', '"ROK"', '"CN."') and leads year clauses with ("D" = Deutschland):
// those are international vehicle registration codes, under which Australia is
// AUS and Austria would be A — so the reading is not ambiguous. 001-005 prints
// the Australia-only fuel sticker as '"AUS"'; this is its complement.
// Only a name we can place is mapped. Anything else stays description text: a
// country silently mapped to the wrong code hides parts that do fit the car.
const NOT_FOR_RE      = /^not for:/i;
const MARKET_NAME_CODE = { AUSTRALIEN: 'AUS' };

// A cut-to-length row: "16 | shorten to: | 980 MM | 1" printed under the bulk
// stock it is cut from ("- 900 918 005 40 | Pipe | *").
const CUT_LENGTH_RE = /^shorten to:/i;

// A Pos value: plain "5", or "(5)" when the part differs from the illustration.
const POS_RE = /^(?:\d{1,3}|\(\d{1,3}\))$/;

// Part-Number sub-column: the colour/trim code ("FSA") sits at x≈132/138, right of
// the part number groups (57/78/100/121) but left of the Description origin (162).
const COLOUR_CODE_X = 130;

// A Description-column continuation that SCOPES the block instead of describing it:
// "D - MJ 2008>>", "D >> - MJ 2007", "F 99-7S780 790>>", "M >> 816 14410".
// The leading 1-3 letter market/breakpoint token is what makes this safe: real
// description text such as "Identification: >> >>" or "M 12 X 1,5" cannot match.
// One breakpoint prints glued ("F>>998S4794076", 501-001 p226) — the digit right
// after the '>>' keeps that arm as safe as the spaced one.
function isApplicabilityText(t) {
  if (/^[FM]>>\s*\d/.test(t)) return true;
  return /^[A-Z]{1,3}\s/.test(t) && (/\bMJ\b/.test(t) || t.includes('>>'));
}

// A Model-column value that is a scope rather than a variant/engine token.
function isApplicabilityModel(t) {
  return /^PR:/.test(t) || /\bMJ\b/.test(t) || t.includes('>>');
}

// A colour variant's Model text is its scope only if the whole value parses as
// scope. No code index here: extraction runs before any DB handle exists, and a
// variant never carries an engine/gearbox code — shape alone settles every value
// we see. A value that is NOT scope (the paints section prints the paint code
// there — "A 1", "9 S", 004-000 p24) is kept in the remark instead of dropped.
function variantScope(model) {
  return model && APPL.isScope(model) ? model : '';
}

// Model-column tokens are space-joined, EXCEPT a wrapped PR list: "PR:098,490,"
// followed by "981" must become the single token "PR:098,490,981". Two separate
// tokens would be read as two option slots and AND-ed, wrongly rejecting the part.
function appendModelToken(acc, tok) {
  if (!acc) return tok;
  return acc.endsWith(',') ? acc + tok : acc + ' ' + tok;
}

function appendText(acc, tok) {
  if (!tok) return acc;
  return acc ? acc + ' ' + tok : tok;
}

function makeBlock(pos, partNumber, colourCode, description, qty, remark, model) {
  return {
    pos, partNumber, colourCode,
    description, qty, remark,
    applicability: model,   // Model column of the header row — the biggest single
    applDesc:      [],      // fix: this never used to reach the DB at all.
    annotClosed:   false,
    awaitNotFor:   false,   // a "Not for:" marker is waiting for its country row
    children:      [],
  };
}

function makeChild(partNumber, colourCode, description, remark, model) {
  return {
    pos: null, partNumber, colourCode,
    description, qty: '', remark,
    applicability: model,   // a variant's own Model text is its own scope, not the
    applDesc:      [],      // parent's — the parent may carry none at all.
  };
}

// Final applicability string. Segments are joined by ' | '; PR tokens, facets and
// MJ years are parsed out of the whole string, so segment order is not load-bearing.
function blockApplicability(b) {
  return [b.applicability, ...b.applDesc].filter(Boolean).join(' | ');
}

// Which kind of breakpoint a segment states, if any. "PR:XMJ" is an option code,
// not a year — only a MJ followed by a year is one.
function segmentKind(seg) {
  if (/\bMJ\s*\d{4}/.test(seg))    return 'year';
  if (/^F(?:\s|>>)/.test(seg))     return 'chassis';
  if (/^M(?:\s|>>)/.test(seg))     return 'engineNum';
  return 'facet';
}

// A child's stored scope is its FULL effective scope: the parent's, then its own.
// The viewer picks one or the other, never both, so a child that states anything
// must state everything or it silently escapes the parent's gate. A child with no
// scope of its own is left empty and inherits the parent as before.
//
// Where both state the SAME kind of breakpoint the child's wins outright, because
// the two are an intersection and segments of one kind read as alternatives: a
// Sycamore door handle runs ">> - MJ 2008" and its Palm green variant ">> - MJ 2007",
// which is MY2007 and under — keeping both would read as "either", widening the
// variant back out to the parent's range. The parent's facets (line, option) are
// never dropped; those the child only ever adds to.
function childApplicability(child, block) {
  const own = blockApplicability(child);
  if (!own) return '';
  const ownKinds = new Set(
    [child.applicability, ...child.applDesc].filter(Boolean).map(segmentKind)
  );
  ownKinds.delete('facet');
  const inherited = blockApplicability(block)
    .split(' | ')
    .filter(s => s && !ownKinds.has(segmentKind(s)));
  return [...inherited, own].join(' | ');
}

// Old dialect prints part scope in the REMARK column, not the Model column: 2-digit
// year windows ("-02", "03-", "00-01") and parenthesised markets ("(J)", "-(CN)").
// The viewer only filters `applicability`, so recognise those tokens and fold them
// into the block's Description-scope list (applDesc) — the existing block/child
// applicability logic then carries them through, and appl.js (dialect='old',
// yearPivot set) interprets them. The raw remark string is left intact for display.
//   info: { dialect, yearPivot, yearEnd }
function remarkScopeTokens(remark, info) {
  if (!info || info.dialect !== 'old' || !remark) return [];
  const pivot = info.yearPivot, end = info.yearEnd || (pivot ? pivot + 20 : null);
  const inSpan = yy => {
    if (yy == null) return true;                       // an open range side
    if (!pivot) return false;
    let y = Math.floor(pivot / 100) * 100 + parseInt(yy, 10);
    if (y < pivot) y += 100;
    return y >= pivot && y <= end;                     // else it is a dimension, not a year
  };
  const out = [];
  for (const tok of String(remark).split(/\s+/)) {
    if (/^-?\([A-Z]{1,4}\)$/.test(tok)) { out.push(tok); continue; }
    const ym = tok.match(/^(\d{2})?-(\d{2})?$/);
    if (ym && (ym[1] || ym[2]) && inSpan(ym[1]) && inSpan(ym[2])) out.push(tok);
  }
  return out;
}

function addRemarkScope(block, info) {
  for (const tok of remarkScopeTokens(block.remark, info)) block.applDesc.push(tok);
}

async function extractParts(pdf, pageNum, carry = {}) {
  if (pageNum < 1 || pageNum > pdf.numPages)
    return { parts: [], titleRow: null, carry: { ...carry, isFirst: false } };

  const page    = await pdf.getPage(pageNum);
  const vp      = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  page.cleanup();

  const items = content.items.filter(it => it.str?.trim());
  const rows  = groupIntoRows(items, vp.height);

  let colOrigins = null;
  const parts    = [];
  // A block can span a page break: its colour variants and even its year footer
  // may be printed at the top of the next page.
  let block  = carry.block  ?? null;  // open parent block
  let curRow = carry.curRow ?? null;  // parent, or its last colour variant
  // The last block that carried a part number — the stock a "shorten to:" row is
  // cut from. It is printed once, above a run of cut lengths, and can sit on the
  // previous page.
  let bulk   = carry.bulk   ?? null;
  // The title block exists only on a section's first parts page, before any data
  // row. A carried-in block means we resume mid-data.
  let titleClosed = carry.isFirst === false || block != null;

  const titleDescLines   = [];
  const titleRemarkLines = [];
  // Model-column lines of the title block, wrap-joined before routing: a title
  // that prints "PR:098,639," then "640,981" states ONE option slot, and routing
  // the halves separately leaves the first with a dangling comma and reads the
  // second as an unrelated token.
  const titleModelToks   = [];
  const titleApplDesc    = [];
  // Whether the title's Model column gates the SECTION. Once it has started,
  // later rows are just the wrapped column (601-005 p245 continues "CABRIO",
  // "PR:482,483" under a first-line "COUPE"; 105-004 p65 continues "PR:101"
  // under "9770+"). A column that STARTS beside the third-or-later title line
  // scopes individual sub-items instead: "Tool / jack / Fire extinguishers GT2"
  // (001-000 p18) gates the fire extinguishers alone, and taking GT2 as a
  // section facet hides the toolbox and jack from every non-GT2 car; 809-000
  // p444 prints one Model label per breakpoint line the same way. Line two is
  // still the section: "Body / Sound proofing 1 | COUPE" (807-015 p438) is one
  // wrapped title whose facet is load-bearing. Display keeps the tokens either
  // way; only the facet/scope derivation drops them.
  let titleModelIsScope  = true;

  for (const row of rows) {
    const texts = row.items.map(it => it.str.trim()).filter(Boolean);
    if (!texts.length) continue;

    // Section header line — "Illustration: 101-000"
    if (texts.length === 1 && texts[0].startsWith('Illustration:')) continue;

    // Model filter line — "Model: 997T07  Model life 2007>>2009"
    if (texts.some(t => t === 'Model:' || t.startsWith('Model:'))) continue;

    // Page footer — "19.07.2018   - 2   Kat P30". Its columns land in Description
    // and Model, so it must be dropped before any accumulation.
    if (/^\d{2}\.\d{2}\.\d{4}/.test(texts[0])) continue;

    // Column header row — sets column origins for all subsequent rows on this page
    if (!colOrigins) {
      if (texts.filter(t => COL_HEADER_SET.has(t)).length >= 4)
        colOrigins = calibrateCols(row.items);
      continue; // haven't reached the header yet
    }

    const cols     = assignColumns(row.items, colOrigins);
    const pos      = colText(cols['Pos']);
    const pnItems  = cols['Part Number'];
    const pn       = colText(pnItems.filter(it => it.transform[4] <  COLOUR_CODE_X));
    const colour   = colText(pnItems.filter(it => it.transform[4] >= COLOUR_CODE_X));
    const desc     = colText(cols['Description']);
    const remark   = colText(cols['Remark']);
    const qty      = colText(cols['Qty']);
    const model    = colText(cols['Model']);
    const isAnnot  = !!desc && ANNOT_RE.test(desc);
    const fullPn   = colour ? (pn ? pn + ' ' + colour : colour) : pn;

    // ── Part header row. The Pos token must actually live in the Pos column —
    //    testing texts[0] alone let "997" (a part number) pass as a position.
    if (pos && POS_RE.test(pos)) {
      titleClosed = true;
      // A cut length owns a position and a callout, so it is a part in its own
      // right rather than a variant of the bulk row — but the number and the
      // description of the stock it comes from are printed only on that row, and
      // without them it is unorderable and reads as a bare "shorten to:".
      if (!fullPn && bulk && CUT_LENGTH_RE.test(desc)) {
        block = makeBlock(pos, bulk.partNumber, bulk.colourCode, bulk.description,
                          qty, appendText(desc, remark), model);
      } else {
        // No part number is fine: 84 rows are real positions that own a callout but
        // list no orderable number (they were dropped before, orphaning callouts).
        block = makeBlock(pos, fullPn, colour || null, desc, qty, remark, model);
        if (fullPn) bulk = block;
      }
      parts.push(block);
      curRow = block;
      continue;
    }

    // ── Dash position — a part that exists but is not shown in the diagram.
    //    A bare "-" also introduces annotations ("- primed") and grouping headings
    //    ("- Signs/notices" over the stickers that follow, "- Gear wheel sets" over
    //    a see-illustration xref). The Qty column separates them: a line item says
    //    how many are fitted, a heading never does. Testing the Model column too
    //    would keep six headings that carry only a PR code ("- Brake disc | PR:450"
    //    heading "Only / in pairs / Replace / Technical manual / Attention").
    if (pos === '-') {
      titleClosed = true;
      if (pn) {
        block  = makeBlock('-', fullPn, colour || null, desc, qty, remark, model);
        parts.push(block);
        curRow = block;
        bulk   = block;
      } else if (qty && !isAnnot) {
        block  = makeBlock('-', '', null, desc, qty, remark, model);
        parts.push(block);
        curRow = block;
      } else {
        block = null; curRow = null;   // annotation or heading — nothing may attach
      }
      continue;
    }

    // ── Any other Pos token is annotation (the A..G legend on 801-000)
    if (pos) {
      titleClosed = true;
      block = null; curRow = null;
      continue;
    }

    // ── Colour variant — a Part Number with no Pos. Becomes a child of the block.
    //    It owns its Model text: a seat-belt colour row states the PR option that
    //    selects that colour, and the parent often states nothing at all.
    if (pn && /[0-9A-Za-z]/.test(pn)) {
      titleClosed = true;
      if (block) {
        const scope = variantScope(model);
        curRow = makeChild(fullPn, colour || null, desc, remark, scope);
        // Model text that is not scope (the paint code of 004-000) survives in
        // the remark rather than vanishing.
        if (model && !scope) curRow.remark = appendText(curRow.remark, model);
        block.children.push(curRow);
      }
      continue;
    }

    // ── Diagram title block: rows before the first data row of the section ──
    if (!titleClosed) {
      if (isAnnot) { titleClosed = true; continue; } // notes/attention block — stop
      if (desc) {
        // A section-level model-year scope (20 sections) rather than title text
        if (isApplicabilityText(desc)) titleApplDesc.push(desc);
        else                           titleDescLines.push(desc);
      }
      if (remark) titleRemarkLines.push(remark);
      if (model) {
        if (!titleModelToks.length) titleModelIsScope = titleDescLines.length <= 2;
        if (titleModelToks.length && titleModelToks[titleModelToks.length - 1].endsWith(','))
          titleModelToks[titleModelToks.length - 1] += model;
        else
          titleModelToks.push(model);
      }
      continue;
    }

    // ── Continuation rows ──

    if (!block) continue;

    // The Model column is read BEFORE the Description column is even looked at,
    // because the columns are independent: a marker in Description says nothing
    // about the row's Model. 805-000 p363 prints one windscreen's "PR:440,568" on
    // an "also use:" row and its sibling's on a plain row — the same gate, and
    // skipping the row whole would keep one and drop the other. 904-000 p696
    // (PR:268), 902-005 p667 (-"CN.") and 809-020 p487 (PR:XME) are the same
    // shape: a Model continuation that happens to share a row with a marker.
    //
    // A Model-only continuation carries no part number of its own, so it can only
    // be extending the parent — including a PR list wrapped across two rows, which
    // must not be handed to whatever colour variant happens to be open.
    if (model) block.applicability = appendModelToken(block.applicability, model);

    // Cross-reference markers carry their target in the Remark column; the pair
    // is an annotation on the row it is printed under, so it lands in that row's
    // remark — and closes description accumulation, because the annotation's own
    // continuation lines print back at the Description origin.
    if (isAnnot) {
      block.annotClosed = true;
      if (curRow) curRow.remark = appendText(curRow.remark, appendText(desc, remark));
      continue;
    }

    // Heads the breakpoint rows below it and says nothing they do not; skipped
    // rather than closed so those rows still reach the row they scope.
    if (desc && SCOPE_LABEL_RE.test(desc)) continue;

    if (desc && REMARK_LABEL_RE.test(desc)) {
      if (!block.annotClosed && curRow)
        curRow.remark = appendText(curRow.remark, appendText(desc, remark));
      continue;
    }

    // The country this excludes is on the next row, so arm the block and read it
    // there. Only the parent is armed: the marker is printed against the part.
    if (desc && NOT_FOR_RE.test(desc)) { block.awaitNotFor = true; continue; }

    if (desc) {
      if (block.awaitNotFor) {
        block.awaitNotFor = false;
        const code = MARKET_NAME_CODE[desc.trim().toUpperCase()];
        if (code) { (curRow ?? block).applDesc.push(`-"${code}"`); continue; }
        // Unmapped: fall through and keep it as description text rather than
        // drop a constraint we cannot express.
      }
      if (isApplicabilityText(desc)) {
        (curRow ?? block).applDesc.push(desc);   // scopes the row it is printed under
      } else if (curRow) {
        // Once an annotation is open, Description-column text is the annotation's
        // continuation and joins the remark — except the discontinued flag, which
        // is the part's own and keeps its place in the description.
        if (!block.annotClosed || FLAG_RE.test(desc))
          curRow.description = appendText(curRow.description, desc);
        else
          curRow.remark = appendText(curRow.remark, desc);
      }
    }
    if (remark && curRow) {
      curRow.remark = appendText(curRow.remark, remark);
    }
  }

  // "PR:480" on the title row gates the WHOLE section (15 sections); the variant
  // and code tokens beside it are the section's own scope. They are split apart
  // here only because `model` is the display string the viewer prints verbatim —
  // the typed facets are derived from the same tokens downstream. A sub-title's
  // Model entry (titleModelIsScope=false) stays display-only.
  const titleScopeToks  = titleModelIsScope ? titleModelToks : [];
  const titleModelLines = titleModelToks.filter(t => !isApplicabilityModel(t));
  const titleApplModel  = titleScopeToks.filter(t =>  isApplicabilityModel(t));

  const titleRow = (titleDescLines.length || titleRemarkLines.length ||
                    titleModelToks.length || titleApplDesc.length)
    ? {
        description:   titleDescLines.join(' '),
        remark:        titleRemarkLines.join(' '),
        model:         [...new Set(titleModelLines)].join(' '),
        modelScope:    [...new Set(titleScopeToks)].join(' '),
        applicability: [...titleApplModel, ...titleApplDesc].join(' | '),
      }
    : null;

  return { parts, titleRow, carry: { block, curRow, bulk, isFirst: false } };
}

// ── Row and column utilities ──────────────────────────────────────────────────

function groupIntoRows(items, pageHeight, tolerance = 3) {
  const map = new Map();
  for (const it of items) {
    const y = Math.round(pageHeight - it.transform[5]);
    let placed = false;
    for (const ry of map.keys()) {
      if (Math.abs(ry - y) <= tolerance) { map.get(ry).push(it); placed = true; break; }
    }
    if (!placed) map.set(y, [it]);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, its]) => ({ items: its.sort((a, b) => a.transform[4] - b.transform[4]) }));
}

// Build ordered column list from the header row items, sorted left-to-right by x
function calibrateCols(headerItems) {
  return headerItems
    .filter(it => it.str.trim())
    .map(it => ({ name: it.str.trim(), x: it.transform[4] }))
    .sort((a, b) => a.x - b.x);
}

// Assign each item to the rightmost column whose x-origin is ≤ item.x (+5pt tolerance).
// Returns the ITEMS (not strings) so callers can still see x — the Part Number column
// has a sub-column (the colour/trim code) that only x can separate.
function assignColumns(items, colOrigins) {
  const cols = Object.fromEntries(colOrigins.map(c => [c.name, []]));
  for (const it of items) {
    const x = it.transform[4];
    let col = colOrigins[0].name;
    for (const c of colOrigins) {
      if (c.x <= x + 5) col = c.name;
    }
    cols[col].push(it);
  }
  return cols;
}

function colText(items) {
  return items?.map(it => it.str.trim()).filter(Boolean).join(' ') ?? '';
}

// Extract every parts page of a section, in order. A block can span a page break
// (its colour variants and year footer may continue overleaf), so the open block is
// carried from page to page.
// nextDiagramPage is the exclusive upper bound (first page of the next section).
async function extractSectionParts(pdf, firstPartsPage, nextDiagramPage) {
  const out = [];
  let carry = { block: null, curRow: null, bulk: null, isFirst: true };
  for (let p = firstPartsPage; p < nextDiagramPage; p++) {
    const t = performance.now();
    let r = { parts: [], titleRow: null, carry: { ...carry, isFirst: false } };
    try {
      r = await extractParts(pdf, p, carry);
    } catch (e) {
      post('status', { message: `Parts extraction skipped p${p}: ${e.message}` });
    }
    TIMING.extractParts += performance.now() - t;
    TIMING.partsPagesCount++;
    // Bounded by the section's page range — never break on an empty page, or a
    // notes-only page mid-run would silently drop every page after it.
    carry = r.carry;
    out.push(r);
  }
  return out;
}

// ── OCR helpers ───────────────────────────────────────────────────────────────

async function initTesseract() {
  return Tesseract.createWorker('porsche', 1, {
    langPath:   TESSDATA_URL,
    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/worker.min.js',
    corePath:   'https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core-lstm.wasm.js',
    logger:     () => {},
  });
}

async function createWorkerPool(size) {
  const workers = await Promise.all(
    Array.from({ length: size }, () => initTesseract())
  );
  const idle    = [...workers];
  const waiters = [];
  return {
    acquire() {
      if (idle.length) return Promise.resolve(idle.pop());
      return new Promise(resolve => waiters.push(resolve));
    },
    release(w) {
      if (waiters.length) waiters.shift()(w);
      else idle.push(w);
    },
    terminate() { return Promise.all(workers.map(w => w.terminate())); },
  };
}

// CTM matrix multiply (column-major 3×3, implicit third row [0,0,1])
function matMul(m, n) {
  return [
    m[0]*n[0] + m[2]*n[1],
    m[1]*n[0] + m[3]*n[1],
    m[0]*n[2] + m[2]*n[3],
    m[1]*n[2] + m[3]*n[3],
    m[0]*n[4] + m[2]*n[5] + m[4],
    m[1]*n[4] + m[3]*n[5] + m[5],
  ];
}

// Walk the operator list tracking the CTM to find where image XObjects are painted
function imageRectsFromOpList(opList) {
  const stack = [[1,0,0,1,0,0]];
  const results = [];
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i], args = opList.argsArray[i];
    if      (fn === pdfjsLib.OPS.save)      { stack.push([...stack[stack.length-1]]); }
    else if (fn === pdfjsLib.OPS.restore)   { if (stack.length > 1) stack.pop(); }
    else if (fn === pdfjsLib.OPS.transform) { stack[stack.length-1] = matMul(stack[stack.length-1], args); }
    else if (fn === pdfjsLib.OPS.paintImageXObject || fn === pdfjsLib.OPS.paintInlineImageXObject) {
      const [a,b,c,d,e,f] = stack[stack.length-1];
      const xs = [e, e+a, e+c, e+a+c], ys = [f, f+b, f+d, f+b+d];
      const x0 = Math.min(...xs), x1 = Math.max(...xs);
      const y0 = Math.min(...ys), y1 = Math.max(...ys);
      results.push({ id: args?.[0], x0, y0, x1, y1, area: (x1-x0)*(y1-y0) });
    }
  }
  return results;
}

// Grayscale hard-threshold — returns new OffscreenCanvas
function binarize(src, threshold) {
  const dst = new OffscreenCanvas(src.width, src.height);
  const ctx = dst.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const id = ctx.getImageData(0, 0, dst.width, dst.height);
  const d  = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = (0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2]) < threshold ? 0 : 255;
    d[i] = d[i+1] = d[i+2] = v; d[i+3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return dst;
}

// Bilinear upscale — returns new OffscreenCanvas
function upscale(src, factor) {
  if (factor <= 1) return src;
  const dst = new OffscreenCanvas(Math.round(src.width * factor), Math.round(src.height * factor));
  const ctx = dst.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, dst.width, dst.height);
  return dst;
}

// Connected-component labeling on dark pixels
function findBlobs(canvas) {
  const W = canvas.width, H = canvas.height;
  const px  = canvas.getContext('2d').getImageData(0, 0, W, H).data;
  const ink  = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++)
    ink[i] = (px[i*4] + px[i*4+1] + px[i*4+2]) < 384 ? 1 : 0;
  const seen = new Uint8Array(W * H);
  const blobs = [];
  for (let start = 0; start < W * H; start++) {
    if (!ink[start] || seen[start]) continue;
    const stk = [start]; seen[start] = 1;
    let x0 = start % W, y0 = (start / W)|0, x1 = x0, y1 = y0;
    while (stk.length) {
      const p = stk.pop(), py = (p / W)|0, px_ = p % W;
      if (px_ < x0) x0 = px_; if (px_ > x1) x1 = px_;
      if (py  < y0) y0 = py;  if (py  > y1) y1 = py;
      if (px_ > 0   && ink[p-1] && !seen[p-1]) { seen[p-1] = 1; stk.push(p-1); }
      if (px_ < W-1 && ink[p+1] && !seen[p+1]) { seen[p+1] = 1; stk.push(p+1); }
      if (py  > 0   && ink[p-W] && !seen[p-W]) { seen[p-W] = 1; stk.push(p-W); }
      if (py  < H-1 && ink[p+W] && !seen[p+W]) { seen[p+W] = 1; stk.push(p+W); }
    }
    blobs.push({ x0, y0, x1: x1+1, y1: y1+1, w: x1-x0+1, h: y1-y0+1, seed: start });
  }
  return { blobs, ink, W, H };
}

// Render a single blob (re-flooded from seed) onto a white padded OffscreenCanvas
function renderBlobCanvas(ink, W, H, blob, pad) {
  const gx0 = Math.max(0, blob.x0 - pad), gy0 = Math.max(0, blob.y0 - pad);
  const gx1 = Math.min(W, blob.x1 + pad), gy1 = Math.min(H, blob.y1 + pad);
  const cw = gx1 - gx0, ch = gy1 - gy0;
  const dst = new OffscreenCanvas(cw, ch);
  const ctx = dst.getContext('2d');
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, cw, ch);
  const id = ctx.getImageData(0, 0, cw, ch);
  const d  = id.data;
  const vis = new Uint8Array(W * H);
  const stk = [blob.seed]; vis[blob.seed] = 1;
  while (stk.length) {
    const p = stk.pop(), py = (p / W)|0, px_ = p % W;
    const dx = px_ - gx0, dy = py - gy0;
    if (dx >= 0 && dx < cw && dy >= 0 && dy < ch) {
      const i = (dy * cw + dx) * 4;
      d[i] = d[i+1] = d[i+2] = 0; d[i+3] = 255;
    }
    if (px_ > 0   && ink[p-1] && !vis[p-1]) { vis[p-1] = 1; stk.push(p-1); }
    if (px_ < W-1 && ink[p+1] && !vis[p+1]) { vis[p+1] = 1; stk.push(p+1); }
    if (py  > 0   && ink[p-W] && !vis[p-W]) { vis[p-W] = 1; stk.push(p-W); }
    if (py  < H-1 && ink[p+W] && !vis[p+W]) { vis[p+W] = 1; stk.push(p+W); }
  }
  ctx.putImageData(id, 0, 0);
  return dst;
}

// Pull a decoded image object from PDF.js's internal object store (callback-based).
function getObjAsync(store, name, timeoutMs = 3000) {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    try {
      store.get(name, data => { clearTimeout(t); resolve(data ?? null); });
    } catch { clearTimeout(t); resolve(null); }
  });
}

async function getNativeImageObj(page, name) {
  if (!name) return null;
  const obj = await getObjAsync(page.objs, name);
  if (obj?.width) return obj;
  return await getObjAsync(page.commonObjs, name);
}

// Convert a PDF.js image object to an OffscreenCanvas.
// Returns null if the format is unrecognised (caller falls back to rendered crop).
function imgObjToOffscreenCanvas(obj) {
  if (obj.bitmap instanceof ImageBitmap) {
    const c = new OffscreenCanvas(obj.width, obj.height);
    c.getContext('2d').drawImage(obj.bitmap, 0, 0);
    return c;
  }
  if (typeof ImageBitmap !== 'undefined' && obj instanceof ImageBitmap) {
    const c = new OffscreenCanvas(obj.width, obj.height);
    c.getContext('2d').drawImage(obj, 0, 0);
    return c;
  }
  if (obj instanceof OffscreenCanvas) return obj;

  const { width: w, height: h, data, kind } = obj;
  if (!data?.length) return null;
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(w, h);
  const d  = id.data;
  if (kind === 2) { // RGB_24BPP
    for (let i = 0; i < w * h; i++) { d[i*4]=data[i*3]; d[i*4+1]=data[i*3+1]; d[i*4+2]=data[i*3+2]; d[i*4+3]=255; }
  } else if (kind === 3) { // RGBA_32BPP
    d.set(data);
  } else if (kind === 1) { // GRAYSCALE_1BPP, bit-packed MSB-first, rows padded to byte boundary
    const rowBytes = Math.ceil(w / 8);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
        const i = (y * w + x) * 4;
        d[i]=d[i+1]=d[i+2]=v; d[i+3]=255;
      }
    }
  } else { return null; }
  ctx.putImageData(id, 0, 0);
  return c;
}

// Extract callout numbers from a rendered diagram canvas.
// Returns { callouts, strip, stats } where callouts are normalized 0–10000 in PNG pixel space.
// diagRect: if provided, canvas is already cropped to that rect (skip internal crop step).
// params: { binThresh, targetPx, minConf, debug } — fall back to module constants when omitted.
//   debug: when true, builds a strip canvas of blobs fed to Tesseract and populates stats.
async function ocrDiagram(canvas, opList, vp, tWorker, diagRect = null, params = {}) {
  const {
    binThresh = OCR_BIN_THRESH,
    targetPx  = OCR_TARGET_PX,
    minConf   = OCR_MIN_CONF,
    debug     = false,
  } = params;
  const t0 = performance.now();

  let crop, cx, cy, cw, ch, rect;
  if (diagRect) {
    rect = diagRect;
    crop = canvas;
    cx = 0; cy = 0;
    cw = canvas.width; ch = canvas.height;
  } else {
    const rects = imageRectsFromOpList(opList);
    if (!rects.length) return { callouts: [], strip: null, stats: null };
    rect = rects.reduce((a, b) => a.area >= b.area ? a : b);
    cx = Math.round(rect.x0 * DIAGRAM_SCALE);
    cy = Math.round(vp.height - rect.y1 * DIAGRAM_SCALE);
    cw = Math.round((rect.x1 - rect.x0) * DIAGRAM_SCALE);
    ch = Math.round((rect.y1 - rect.y0) * DIAGRAM_SCALE);
    if (cw <= 0 || ch <= 0) return { callouts: [], strip: null, stats: null };
    crop = new OffscreenCanvas(cw, ch);
    crop.getContext('2d').drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);
  }

  let t = performance.now();
  const pxPerPt = cw / (rect.x1 - rect.x0);
  const binned  = binarize(crop, binThresh);
  TIMING.binarizeUpscale += performance.now() - t;

  const minH = targetPx * 0.9, maxH = targetPx * 1.1;

  // Build blob canvases and run both OCR passes; return confirmed digits or null.
  // When debug is true, also builds a strip canvas showing all blobs fed to Tesseract.
  async function tryAtScale(candidates, ink, W, H) {
    let ts = performance.now();
    const PAD = Math.round(targetPx * 0.3);
    const blobItems = candidates.map(b => ({
      blob:   b,
      canvas: renderBlobCanvas(ink, W, H, b, PAD),
    }));
    TIMING.renderBlobs    += performance.now() - ts;
    TIMING.candidateCount += candidates.length;

    let strip = null, stripPositions = null;
    if (debug) {
      const SEP    = Math.round(targetPx * 1.2);
      const stripH = Math.round(targetPx * 1.8);
      let cursor = SEP;
      stripPositions = blobItems.map(it => { const sx = cursor; cursor += it.canvas.width + SEP; return sx; });
      strip = new OffscreenCanvas(cursor, stripH);
      const sctx = strip.getContext('2d');
      sctx.fillStyle = 'white'; sctx.fillRect(0, 0, cursor, stripH);
      for (let i = 0; i < blobItems.length; i++)
        sctx.drawImage(blobItems[i].canvas, stripPositions[i], Math.round((stripH - blobItems[i].canvas.height) / 2));
    }

    async function runPass(psm) {
      ts = performance.now();
      await tWorker.setParameters({
        tessedit_char_whitelist: '0123456789',
        tessedit_pageseg_mode:   psm,
        user_defined_dpi:        '300',
      });
      TIMING.tesseractSet += performance.now() - ts;
      const out = [];
      for (const it of blobItems) {
        // OffscreenCanvas lacks toBlob(); convert to PNG Blob via convertToBlob() so
        // Tesseract reads raw bytes and never touches any canvas API on its end.
        ts = performance.now();
        const blob = await it.canvas.convertToBlob({ type: 'image/png' });
        TIMING.convertBlobs += performance.now() - ts;
        ts = performance.now();
        const { data } = await tWorker.recognize(blob);
        TIMING.tesseractOcr  += performance.now() - ts;
        TIMING.recognizeCount++;
        out.push({ text: (data.text || '').replace(/\s/g, ''), conf: Math.round(data.confidence || 0) });
      }
      return out;
    }

    const pass10 = await runPass('10');
    const pass8  = await runPass('8');

    const digitResults = [];
    for (let i = 0; i < blobItems.length; i++) {
      const r10 = pass10[i], r8 = pass8[i];
      const ok10 = /^\d$/.test(r10.text) && r10.conf >= minConf;
      const ok8  = /^\d$/.test(r8.text)  && r8.conf  >= minConf;
      if (!ok10 && !ok8) continue;
      const pick = !ok10 ? r8 : !ok8 ? r10 : r10.conf >= r8.conf ? r10 : r8;
      digitResults.push({ text: pick.text, confidence: pick.conf, blob: blobItems[i].blob });
    }

    if (!digitResults.length) return null;
    const stripTiles = stripPositions ? blobItems.map((it, i) => {
      const r10 = pass10[i], r8 = pass8[i];
      const best = r10.conf >= r8.conf ? r10 : r8;
      const passed = (/^\d$/.test(r10.text) && r10.conf >= minConf) || (/^\d$/.test(r8.text) && r8.conf >= minConf);
      return { x: stripPositions[i], w: it.canvas.width, text: best.text, conf: best.conf, passed };
    }) : null;
    return { digitResults, strip, stripTiles };
  }

  // Multi-scale cascade: try each candidate font size, stop on first confirmed digit
  let scale, digitResults, strip = null, stripTiles = null;
  let fontPtUsed, totalBlobs, candidateCount;
  const cascadeLog = debug ? [] : null;  // per-step diagnostics when debug=true
  for (const fontPt of OCR_FONT_PT_CANDIDATES) {
    t = performance.now();
    const s = Math.max(1, targetPx / (fontPt * pxPerPt));
    const processed = upscale(binned, s);
    TIMING.binarizeUpscale += performance.now() - t;

    t = performance.now();
    const { blobs, ink, W, H } = findBlobs(processed);
    TIMING.findBlobs += performance.now() - t;

    const candidates = blobs.filter(b => b.h >= minH && b.h <= maxH && b.w / b.h <= 2);

    if (cascadeLog) {
      const hSorted = blobs.map(b => b.h).sort((a, b) => a - b);
      const p10 = hSorted[Math.floor(hSorted.length * 0.10)] ?? 0;
      const p50 = hSorted[Math.floor(hSorted.length * 0.50)] ?? 0;
      const p90 = hSorted[Math.floor(hSorted.length * 0.90)] ?? 0;
      cascadeLog.push({ fontPt, s: +s.toFixed(2), blobs: blobs.length, candidates: candidates.length,
                        window: [+minH.toFixed(1), +maxH.toFixed(1)],
                        blobH: { p10, p50, p90, max: hSorted[hSorted.length-1] ?? 0 } });
    }

    if (!candidates.length) continue;

    const out = await tryAtScale(candidates, ink, W, H);
    // Keep the scale that found the most digits — don't stop early, since a later
    // candidate may find more real callouts than an earlier one found false positives.
    if (out && (!digitResults || out.digitResults.length > digitResults.length)) {
      scale = s; digitResults = out.digitResults;
      fontPtUsed = fontPt; totalBlobs = blobs.length; candidateCount = candidates.length;
      if (debug) { strip = out.strip; stripTiles = out.stripTiles; }
    }
  }

  TIMING.diagramCount++;
  TIMING.totalOcr += performance.now() - t0;

  if (!digitResults) {
    const failStats = debug
      ? { fontPtUsed: null, totalBlobs: null, candidateCount: null, digitCount: 0,
          elapsed: ((performance.now() - t0) / 1000).toFixed(1),
          pxPerPt: +pxPerPt.toFixed(2), cascadeLog }
      : null;
    return { callouts: [], strip: null, stripTiles: null, stats: failStats };
  }

  digitResults.sort((a, b) => a.blob.x0 - b.blob.x0);
  // Merge digits into multi-digit numbers by edge-to-edge whitespace, not
  // center-to-center. A narrow leading "1" has a large right bearing that inflates
  // the center distance, which used to push "1X" callouts just past the threshold
  // and split them into separate digits. Whitespace between adjacent digits of one
  // number is small (well under a digit-width); between separate callouts it is a
  // full digit-width or more.
  const MAX_GAP = targetPx * 0.6, Y_TOL = targetPx * 0.1;
  const numGroups = [];
  for (const dr of digitResults) {
    const b = dr.blob, yc = (b.y0 + b.y1) / 2;
    let placed = false;
    for (const g of numGroups) {
      const last = g.digits[g.digits.length-1], lb = last.blob;
      const gap = b.x0 - g.x1;  // whitespace between this digit and the group's right edge
      if (Math.abs(yc - (lb.y0+lb.y1)/2) < Y_TOL && gap < MAX_GAP) {
        g.digits.push(dr);
        g.x1 = Math.max(g.x1, b.x1); g.y0 = Math.min(g.y0, b.y0); g.y1 = Math.max(g.y1, b.y1);
        placed = true; break;
      }
    }
    if (!placed) numGroups.push({ digits: [dr], x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 });
  }

  const pngW = canvas.width, pngH = canvas.height;
  const callouts = numGroups
    .map(g => ({
      number:     g.digits.map(d => d.text).join(''),
      confidence: Math.round(g.digits.reduce((s, d) => s + d.confidence, 0) / g.digits.length),
      x0: Math.round((g.x0 / scale + cx) / pngW * 10000),
      y0: Math.round((g.y0 / scale + cy) / pngH * 10000),
      x1: Math.round((g.x1 / scale + cx) / pngW * 10000),
      y1: Math.round((g.y1 / scale + cy) / pngH * 10000),
    }))
    .filter(c => !/^0+$/.test(c.number));

  const stats = debug
    ? { fontPtUsed, totalBlobs, candidateCount, digitCount: digitResults.length,
        elapsed: ((performance.now() - t0) / 1000).toFixed(1),
        pxPerPt: +pxPerPt.toFixed(2), cascadeLog }
    : null;
  return { callouts, strip, stripTiles, stats };
}

// ── Partial re-ingest ─────────────────────────────────────────────────────────

// sectionNums: string[] to restrict, or null to process all sections
// partsOnly: skip diagram re-render and OCR, only re-extract parts text
async function reingestSections(buffer, catalogId, sectionNums, partsOnly) {
  post('status', { message: `reingestSections: sectionNums=${JSON.stringify(sectionNums)}, partsOnly=${partsOnly}` });
  post('status', { message: 'Loading PDF…' });
  const pdf = await pdfjsLib.getDocument({ data: buffer, ...PDFJS_OPTS, canvasFactory: CANVAS_FACTORY }).promise;

  post('status', { message: 'Loading existing database…' });
  const SQL      = await initSqlJs({ locateFile: () => SQLJS_WASM });
  const opfsRoot  = await navigator.storage.getDirectory();
  let catalogDir;
  try { catalogDir = await opfsRoot.getDirectoryHandle(catalogId); }
  catch { throw new Error(`No existing catalog "${catalogId}" — run a full ingest first.`); }

  let db;
  try {
    const fh   = await catalogDir.getFileHandle('catalog.sqlite');
    const file = await fh.getFile();
    db = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
  } catch { throw new Error(`catalog.sqlite not found for "${catalogId}" — run a full ingest first.`); }

  // A schema change (a new column) means the old DB can't be updated in place — and
  // this project never migrates, it rebuilds. But re-rendering diagrams and re-OCRing
  // would be wasteful when only the interpretation layer changed, so carry the old
  // DB's diagrams and callouts across into a fresh, current-schema DB keyed by section
  // number. The parts/V-pages/facets are then re-extracted normally, no OCR.
  const oldDiagrams = new Map();   // section number → diagram_blob
  const oldCallouts = new Map();   // section number → [callout rows]
  let rebuilt = false;
  if (!SCHEMA.matches(SQL, db)) {
    post('status', { message: 'Schema changed — rebuilding (diagrams kept, no OCR)…' });
    const idToNum = new Map();
    let st = db.prepare('SELECT id, number, diagram_blob FROM section WHERE catalog_id=?');
    st.bind([catalogId]);
    while (st.step()) {
      const r = st.getAsObject();
      idToNum.set(r.id, r.number);
      if (r.diagram_blob) oldDiagrams.set(r.number, r.diagram_blob);
    }
    st.free();
    st = db.prepare('SELECT section_id, number, x0, y0, x1, y1, confidence FROM callout');
    while (st.step()) {
      const r = st.getAsObject();
      const num = idToNum.get(r.section_id);
      if (num == null) continue;
      if (!oldCallouts.has(num)) oldCallouts.set(num, []);
      oldCallouts.get(num).push(r);
    }
    st.free();
    db.close();
    db = new SQL.Database();
    SCHEMA.create(db);
    rebuilt = true;
  }

  post('status', { message: 'Parsing table of contents…' });
  const outline          = await pdf.getOutline();
  const { title, sections } = await parseOutline(outline, pdf);

  post('status', { message: 'Parsing model/option information…' });
  for (const tbl of ['pr_code','sales_type','vin_range','engine_code','transmission_code','engine_number_range','transmission_number_range'])
    db.run(`DELETE FROM ${tbl} WHERE catalog_id=?`, [catalogId]);
  const vp = await parseVPages(pdf, sections[0].diagramPage);
  if (rebuilt)
    db.run('INSERT OR REPLACE INTO catalog (id, title, model, page_count, ingested_at, dialect, year_pivot) VALUES (?,?,?,?,?,?,?)',
           [catalogId, title, vp.model, pdf.numPages, new Date().toISOString(), vp.dialect, vp.yearPivot]);
  else
    db.run('UPDATE catalog SET title=?, model=?, dialect=?, year_pivot=? WHERE id=?',
           [title, vp.model, vp.dialect, vp.yearPivot, catalogId]);
  insertVPageData(db, catalogId, vp);
  const codeIndex = buildCodeIndex(vp);
  const dialectInfo = { dialect: vp.dialect, yearPivot: vp.yearPivot, yearEnd: vp.yearEnd };

  let targets;
  if (sectionNums?.length) {
    const numSet = new Set(sectionNums);
    targets = sections.filter(s => numSet.has(s.sectionNum));
    if (!targets.length) throw new Error(`No matching sections found for: ${sectionNums.join(', ')}`);
  } else {
    targets = sections;
  }

  let pool = null;
  if (!partsOnly) {
    post('status', { message: `Found ${targets.length} section(s). Initialising OCR…` });
    const POOL_SIZE = navigator.hardwareConcurrency || 4;
    try {
      pool = await createWorkerPool(POOL_SIZE);
    } catch (e) {
      post('status', { message: `OCR unavailable (${e.message}) — callouts will be skipped.` });
    }
  } else {
    post('status', { message: `Found ${targets.length} section(s). Extracting parts…` });
  }

  const calloutStmt = db.prepare(
    'INSERT INTO callout (section_id, number, x0, y0, x1, y1, confidence) VALUES (?,?,?,?,?,?,?)'
  );
  const partStmt = db.prepare(PART_INSERT_SQL);

  const sectionIndexMap = new Map(sections.map((s, i) => [s.sectionNum, i]));
  const mgCache = new Map();   // only used when rebuilding a fresh DB
  let doneCount = 0, partCount = 0;

  for (const sec of targets) {
    const tWorker = pool ? await pool.acquire() : null;
    try {
      const idx             = sectionIndexMap.get(sec.sectionNum);
      const nextDiagramPage = sections[idx + 1]?.diagramPage ?? (pdf.numPages + 1);
      const firstPartsPage  = sec.diagramPage + 1;

      const [diagramResult, partsResults] = await Promise.all([
        partsOnly
          ? Promise.resolve({ imgBytes: null, callouts: null })
          : renderDiagram(pdf, sec.diagramPage, tWorker)
              .catch(e => {
                post('status', { message: `Diagram render skipped for ${sec.sectionNum}: ${e.message}` });
                return { imgBytes: null, callouts: [] };
              }),
        extractSectionParts(pdf, firstPartsPage, nextDiagramPage),
      ]);

      let secId = null;
      if (rebuilt) {
        // Fresh DB: create the section, carrying the old diagram and callouts over.
        const mgId = ensureMainGroup(db, mgCache, catalogId, sec.mainGroupNum, sec.mainGroupTitle);
        secId = insertSection(db, mgId, catalogId, sec.sectionNum, sec.sectionTitle,
                              firstPartsPage, sec.diagramPage, oldDiagrams.get(sec.sectionNum) || null);
        for (const c of (oldCallouts.get(sec.sectionNum) || []))
          calloutStmt.run([secId, c.number, c.x0, c.y0, c.x1, c.y1, c.confidence]);
      } else {
        const secStmt = db.prepare('SELECT id FROM section WHERE catalog_id=? AND number=?');
        secStmt.bind([catalogId, sec.sectionNum]);
        if (secStmt.step()) secId = secStmt.getAsObject().id;
        secStmt.free();
        if (secId == null) {
          post('status', { message: `Section ${sec.sectionNum} not in DB — skipping` });
          continue;
        }
      }

      if (diagramResult.imgBytes)
        db.run('UPDATE section SET diagram_blob=? WHERE id=?', [diagramResult.imgBytes, secId]);

      if (diagramResult.callouts !== null) {
        db.run('DELETE FROM callout WHERE section_id=?', [secId]);
        for (const c of diagramResult.callouts)
          calloutStmt.run([secId, c.number, c.x0, c.y0, c.x1, c.y1, c.confidence]);
      }

      db.run('DELETE FROM part WHERE section_id=?', [secId]);
      for (let pi = 0; pi < partsResults.length; pi++) {
        const { parts, titleRow } = partsResults[pi];
        if (pi === 0 && titleRow) applyTitleRow(db, secId, titleRow, sec.sectionTitle, codeIndex);
        partCount += insertPartBlocks(db, partStmt, secId, catalogId, parts, dialectInfo);
      }
    } finally {
      if (tWorker) pool.release(tWorker);
      doneCount++;
      post('progress', {
        pct:   Math.round((doneCount / targets.length) * 100),
        label: `${sec.sectionNum}${sec.sectionTitle ? ' — ' + sec.sectionTitle : ''}`,
      });
    }
  }

  calloutStmt.free();
  partStmt.free();
  if (pool) await pool.terminate();

  post('status', { message: 'Rebuilding search index…' });
  db.run("INSERT INTO part_fts(part_fts) VALUES ('rebuild')");

  post('status', { message: 'Saving database…' });
  await writeOpfsFile(catalogDir, 'catalog.sqlite', db.export());
  db.close();
  pdf.destroy();

  post('done', { catalogId, sectionCount: targets.length, partCount });
}

// ── Timing accumulator (OCR profiling) ───────────────────────────────────────

const TIMING = {
  // ── ingest phases ──────────────────────────────────────────────────────────
  pdfLoad:         0,  // pdfjsLib.getDocument
  dbInit:          0,  // initSqlJs + SCHEMA.create
  tesseractInit:   0,  // initTesseract
  opfsSetup:       0,  // navigator.storage.getDirectory + handle setup
  tocParse:        0,  // pdf.getOutline + parseOutline
  vPageParse:      0,  // parseVPages() — PR codes, sales types, VIN ranges
  renderDiagram:   0,  // renderDiagram() wall time (includes OCR and WebP encode)
  extractParts:    0,  // extractParts() across all pages of all sections
  dbInserts:       0,  // calloutStmt.run + partStmt.run + insertSection
  ftsBuild:        0,  // FTS index rebuild
  dbSave:          0,  // db.export + writeOpfsFile
  // ── OCR internals (subset of renderDiagram) ────────────────────────────────
  render:          0,  // page.getOperatorList + page.render
  convertDiagram:  0,  // canvas.convertToBlob → WebP bytes for section.diagram_blob
  binarizeUpscale: 0,  // binarize + upscale
  findBlobs:       0,  // connected-component labeling
  renderBlobs:     0,  // renderBlobCanvas × N candidates
  convertBlobs:    0,  // canvas.convertToBlob per blob (both passes)
  tesseractSet:    0,  // tWorker.setParameters (both passes)
  tesseractOcr:    0,  // tWorker.recognize (both passes)
  totalOcr:        0,  // entire ocrDiagram() call
  diagramCount:    0,
  candidateCount:  0,
  recognizeCount:  0,
  partsPagesCount: 0,
  sectionCount:    0,
};

// ── Diagram rendering ─────────────────────────────────────────────────────────

async function renderDiagram(pdf, pageNum, tWorker) {
  const page   = await pdf.getPage(pageNum);
  const vp     = page.getViewport({ scale: DIAGRAM_SCALE });
  const canvas = new OffscreenCanvas(Math.round(vp.width), Math.round(vp.height));

  // Get op list and render in parallel — op list is used for OCR image-rect detection.
  // Render must complete before native extraction; Promise.all ensures both finish first.
  let t = performance.now();
  const [opList] = await Promise.all([
    page.getOperatorList(),
    page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise,
  ]);
  TIMING.render += performance.now() - t;

  // Crop to the largest image XObject (the diagram itself, strips page header/footer)
  const rects = imageRectsFromOpList(opList);
  let saveCanvas = canvas, diagRect = null;
  if (rects.length) {
    diagRect = rects.reduce((a, b) => a.area >= b.area ? a : b);
    const cx = Math.round(diagRect.x0 * DIAGRAM_SCALE);
    const cy = Math.round(vp.height - diagRect.y1 * DIAGRAM_SCALE);
    const cw = Math.round((diagRect.x1 - diagRect.x0) * DIAGRAM_SCALE);
    const ch = Math.round((diagRect.y1 - diagRect.y0) * DIAGRAM_SCALE);
    if (cw > 0 && ch > 0) {
      saveCanvas = new OffscreenCanvas(cw, ch);
      saveCanvas.getContext('2d').drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);
    } else {
      diagRect = null;
    }
  }

  // Try to extract the diagram image at native PDF resolution for higher-quality OCR.
  // Must happen before page.cleanup() which flushes page.objs.
  // Coordinates normalize to the same 0–10000 fraction regardless of resolution,
  // so native and rendered crops produce equivalent callout positions.
  let ocrCanvas = saveCanvas;
  if (diagRect) {
    try {
      const nativeObj = await getNativeImageObj(page, diagRect.id);
      if (nativeObj) {
        const nc = imgObjToOffscreenCanvas(nativeObj);
        if (nc) ocrCanvas = nc;
      }
    } catch { /* fall through to saveCanvas */ }
  }

  page.cleanup();

  // Save native image (or 2× render fallback) binarized to WebP for display.
  // ocrCanvas is native when available — no upscaling wasted on the stored file.
  t = performance.now();
  const blob     = await binarize(ocrCanvas, OCR_BIN_THRESH).convertToBlob({ type: 'image/webp' });
  const imgBytes = new Uint8Array(await blob.arrayBuffer());
  TIMING.convertDiagram += performance.now() - t;

  let callouts = [];
  if (tWorker) {
    try {
      ({ callouts } = await ocrDiagram(ocrCanvas, opList, vp, tWorker, diagRect));
    } catch (e) {
      // OCR failure is non-fatal; parts table works without callouts
    }
  }

  return { imgBytes, callouts };
}

// ── OPFS helper ───────────────────────────────────────────────────────────────

async function writeOpfsFile(dirHandle, name, data) {
  const fh = await dirHandle.getFileHandle(name, { create: true });
  const w  = await fh.createWritable();
  await w.write(data);
  await w.close();
}

// ── SQLite helpers ────────────────────────────────────────────────────────────

function insertVPageData(db, catalogId, { prCodes, salesTypes, vinRanges, engineCodes, transmCodes, engineNums, transmNums }) {
  const run = (sql, rows, fn) => {
    const st = db.prepare(sql);
    for (const r of rows) st.run(fn(r));
    st.free();
  };
  run('INSERT INTO pr_code (catalog_id,code,description) VALUES (?,?,?)',
    prCodes, p => [catalogId, p.code, p.description]);
  run('INSERT INTO sales_type (catalog_id,sales_term,description,mount_from,mount_to,remark) VALUES (?,?,?,?,?,?)',
    salesTypes, s => [catalogId, s.salesTerm, s.description, s.mountFrom, s.mountTo, s.remark]);
  run('INSERT INTO vin_range (catalog_id,model_year,start_date,vin_from,vin_to,remark) VALUES (?,?,?,?,?,?)',
    vinRanges, v => [catalogId, v.modelYear, v.startDate, v.vinFrom, v.vinTo, v.remark]);
  run('INSERT INTO engine_code (catalog_id,ec,displacement_l,power_kw,power_hp,cylinders,mount_from,mount_to,remark) VALUES (?,?,?,?,?,?,?,?,?)',
    engineCodes, e => [catalogId, e.ec, e.displacementL, e.powerKw, e.powerHp, e.cylinders, e.mountFrom, e.mountTo, e.remark]);
  run('INSERT INTO transmission_code (catalog_id,tc,type_code,mount_from,mount_to,remark) VALUES (?,?,?,?,?,?)',
    transmCodes, t => [catalogId, t.tc, t.typeCode, t.mountFrom, t.mountTo, t.remark]);
  run('INSERT INTO engine_number_range (catalog_id,number_from,number_to,model_year,vehicle_type,engine_type) VALUES (?,?,?,?,?,?)',
    engineNums, e => [catalogId, e.numberFrom, e.numberTo, e.modelYear, e.vehicleType, e.engineType]);
  run('INSERT INTO transmission_number_range (catalog_id,number_from,number_to,model_year,vehicle_type,gearbox_type) VALUES (?,?,?,?,?,?)',
    transmNums, t => [catalogId, t.numberFrom, t.numberTo, t.modelYear, t.vehicleType, t.gearboxType]);
}


function ensureMainGroup(db, cache, catalogId, number, title) {
  const key = `${catalogId}\x00${number}`;
  if (cache.has(key)) return cache.get(key);
  db.run('INSERT INTO main_group (catalog_id, number, title) VALUES (?,?,?)',
         [catalogId, number, title]);
  const id = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
  cache.set(key, id);
  return id;
}

function insertSection(db, mgId, catalogId, num, title, partsPage, diagPage, imgBytes) {
  db.run(
    `INSERT INTO section
       (main_group_id, catalog_id, number, title, parts_page, diagram_page, diagram_blob)
     VALUES (?,?,?,?,?,?,?)`,
    [mgId, catalogId, num, title, partsPage, diagPage, imgBytes]
  );
  return db.exec('SELECT last_insert_rowid()')[0].values[0][0];
}

const PART_INSERT_SQL =
  `INSERT INTO part
     (section_id, catalog_id, parent_id, position, part_number, colour_code,
      description, quantity, remarks, applicability)
   VALUES (?,?,?,?,?,?,?,?,?,?)`;

// Write a section's blocks: each parent, then its colour variants as child rows.
// Children carry no position; they inherit the parent's applicability unless the
// PDF scoped them individually, in which case they carry the whole resolved scope.
function insertPartBlocks(db, partStmt, secId, catalogId, parts, info) {
  let n = 0;
  for (const b of parts) {
    addRemarkScope(b, info);
    partStmt.run([secId, catalogId, null, b.pos, b.partNumber, b.colourCode,
                  b.description, b.qty, b.remark, blockApplicability(b)]);
    n++;
    if (!b.children.length) continue;
    const parentId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    for (const c of b.children) {
      addRemarkScope(c, info);
      partStmt.run([secId, catalogId, parentId, null, c.partNumber, c.colourCode,
                    c.description, c.qty, c.remark, childApplicability(c, b)]);
      n++;
    }
  }
  return n;
}

// The parser's dictionaries come straight from the catalog's OWN tables (see
// APPL.buildIndex) — engine/transmission codes, option codes, the line words its
// sales_type/vin_range enumerate — plus the dialect and century pivot detected at
// V-page parse. Nothing is hardcoded per catalog and nothing is guessed by shape.
function buildCodeIndex(vp) {
  const vehicleTypes = [...(vp.engineNums ?? []), ...(vp.transmNums ?? [])]
    .map(r => r.vehicleType).filter(Boolean);
  return APPL.buildIndex({ ...vp, vehicleTypes });
}

// A section title is often an OR-list of WHOLE variants, not a token soup:
// "CARRERA 4 CARRERA 4S TARGA TARGA S" means (Carrera 4) OR (Carrera 4S) OR Targa
// OR (Targa S). Flattening it into one column per facet and AND-ing them wrongly
// demands line=CARRERA AND body=TARGA — hiding a C4 coupe. So split the title at
// each head token (a line or body word; slash-joined tokens like "TURBO/COUPE"
// stay one variant) and populate a facet column ONLY when that facet appears in
// EVERY variant — the union of its values, OR-ed. A facet that varies across the
// alternatives (body here) is dropped; the parts inside carry their own scope.
function isHeadToken(tok, opts) {
  const p = APPL.parse(tok, opts);
  return !!(p.lines.any.length || p.bodies.any.length);
}

function splitTitleVariants(scopeStr, opts) {
  const tokens = String(scopeStr || '').trim().split(/\s+/).filter(Boolean);
  const groups = [];
  let cur = [];
  for (const tok of tokens) {
    if (cur.length && isHeadToken(tok, opts)) { groups.push(cur); cur = []; }
    cur.push(tok);
  }
  if (cur.length) groups.push(cur);
  return groups.map(g => APPL.parse(g.join(' '), opts));
}

function invariantColumn(variants, facet) {
  if (!variants.length || !variants.every(v => v[facet].any.length)) return null;
  const union = [];
  for (const v of variants) for (const val of v[facet].any) if (!union.includes(val)) union.push(val);
  return union.length ? union.join(',') : null;
}

function applyTitleRow(db, secId, titleRow, fallbackTitle, index) {
  const variants = splitTitleVariants(titleRow.modelScope || '', index);
  db.run(
    `UPDATE section SET title=?, title_remark=?, title_model=?, applicability=?,
       engine_code=?, gearbox_code=?, body_line=?, body_style=?,
       drive_code=?, trim_code=? WHERE id=?`,
    [titleRow.description || fallbackTitle, titleRow.remark || null,
     titleRow.model || null, titleRow.applicability || null,
     invariantColumn(variants, 'engines'),  invariantColumn(variants, 'gearboxes'),
     invariantColumn(variants, 'lines'),    invariantColumn(variants, 'bodies'),
     invariantColumn(variants, 'drive'),    invariantColumn(variants, 'trim'), secId]
  );
}

// ── Single-page OCR for spike/debug use ──────────────────────────────────────
// Handles { type:'ocr-page', buffer, pageNum, binThresh?, targetPx?, minConf? }
// Posts { type:'ocr-result', callouts, pngBuffer, stripBuffer, stripWidth,
//         stripHeight, width, height, native, srcLabel, stats }

let _spikeOcrWorker = null;
let _spikeOcrWorkerInit = null;

function getSpikeOcrWorker() {
  if (_spikeOcrWorker) return Promise.resolve(_spikeOcrWorker);
  if (!_spikeOcrWorkerInit) {
    post('status', { message: 'Initialising Tesseract…' });
    _spikeOcrWorkerInit = initTesseract().then(w => {
      _spikeOcrWorker = w;
      post('status', { message: 'Tesseract ready.' });
      return w;
    });
  }
  return _spikeOcrWorkerInit;
}

async function ocrPage({ buffer, pageNum, binThresh = OCR_BIN_THRESH, targetPx = OCR_TARGET_PX, minConf = OCR_MIN_CONF }) {
  const pdf  = await pdfjsLib.getDocument({ data: buffer, ...PDFJS_OPTS, canvasFactory: CANVAS_FACTORY }).promise;
  const page = await pdf.getPage(pageNum);
  const vp   = page.getViewport({ scale: DIAGRAM_SCALE });
  const full = new OffscreenCanvas(Math.round(vp.width), Math.round(vp.height));

  const [opList] = await Promise.all([
    page.getOperatorList(),
    page.render({ canvasContext: full.getContext('2d'), viewport: vp }).promise,
  ]);

  const rects = imageRectsFromOpList(opList);
  if (!rects.length) {
    page.cleanup(); pdf.destroy();
    post('ocr-result', { callouts: [], pngBuffer: null, stripBuffer: null,
      width: 0, height: 0, native: false, srcLabel: 'No image XObject found', stats: null });
    return;
  }

  const diagRect = rects.reduce((a, b) => a.area >= b.area ? a : b);
  const cx = Math.round(diagRect.x0 * DIAGRAM_SCALE);
  const cy = Math.round(vp.height - diagRect.y1 * DIAGRAM_SCALE);
  const cw = Math.round((diagRect.x1 - diagRect.x0) * DIAGRAM_SCALE);
  const ch = Math.round((diagRect.y1 - diagRect.y0) * DIAGRAM_SCALE);

  let cropCanvas = full;
  if (cw > 0 && ch > 0) {
    cropCanvas = new OffscreenCanvas(cw, ch);
    cropCanvas.getContext('2d').drawImage(full, cx, cy, cw, ch, 0, 0, cw, ch);
  }

  let ocrCanvas = cropCanvas, native = false, nativeKind = null;
  try {
    const nativeObj = await getNativeImageObj(page, diagRect.id);
    if (nativeObj) {
      const nc = imgObjToOffscreenCanvas(nativeObj);
      if (nc) { ocrCanvas = nc; native = true; nativeKind = nativeObj.kind ?? 'bitmap'; }
    }
  } catch { /* fall through */ }
  page.cleanup();

  const tWorker = await getSpikeOcrWorker();
  const { callouts, strip, stripTiles, stats } = await ocrDiagram(
    ocrCanvas, null, null, tWorker, diagRect, { binThresh, targetPx, minConf, debug: true }
  );
  pdf.destroy();

  const pngBuf   = await cropCanvas.convertToBlob({ type: 'image/png' }).then(b => b.arrayBuffer());
  const stripBuf = strip ? await strip.convertToBlob({ type: 'image/png' }).then(b => b.arrayBuffer()) : null;

  const dpi      = cw / (diagRect.x1 - diagRect.x0) * 72;
  const kindLabel = native ? (['?','1bpp','RGB','RGBA'][nativeKind] ?? '?') : null;
  const srcLabel  = native
    ? `native ${ocrCanvas.width}×${ocrCanvas.height} (${kindLabel}, ${Math.round(dpi)} DPI)`
    : `render×${DIAGRAM_SCALE} ${cw}×${ch} (${Math.round(dpi)} DPI — fallback)`;

  const transfer = [pngBuf];
  if (stripBuf) transfer.push(stripBuf);
  self.postMessage({ type: 'ocr-result', callouts, pngBuffer: pngBuf, stripBuffer: stripBuf,
    stripWidth: strip?.width, stripHeight: strip?.height, stripTiles,
    width: cropCanvas.width, height: cropCanvas.height, native, srcLabel, stats }, transfer);
}
