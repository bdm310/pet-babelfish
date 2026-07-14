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
const OCR_FONT_PT_CANDIDATES = [7, 9, 12];  // pt sizes to try in cascade order
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
  createSchema(db);
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
  const imagesDir  = await catalogDir.getDirectoryHandle('images', { create: true });
  TIMING.opfsSetup = performance.now() - t;

  post('status', { message: 'Parsing table of contents…' });
  t = performance.now();
  const outline = await pdf.getOutline();
  const { model, sections } = await parseOutline(outline, pdf);
  TIMING.tocParse = performance.now() - t;

  if (!sections.length) throw new Error('No sections found in TOC — is this a PET catalog?');

  db.run(
    'INSERT OR REPLACE INTO catalog (id, model, page_count, ingested_at) VALUES (?,?,?,?)',
    [catalogId, model, pdf.numPages, new Date().toISOString()]
  );

  post('status', { message: 'Parsing model/option information…' });
  t = performance.now();
  const { prCodes, salesTypes, vinRanges, engineCodes, transmCodes, engineNums, transmNums }
    = await parseVPages(pdf, sections[0].diagramPage);
  insertVPageData(db, catalogId, { prCodes, salesTypes, vinRanges, engineCodes, transmCodes, engineNums, transmNums });
  TIMING.vPageParse = performance.now() - t;

  const mgCache   = new Map(); // `catalogId\0number` → rowid
  let   partCount = 0;

  const partStmt = db.prepare(
    `INSERT INTO part
       (section_id, catalog_id, position, part_number, description,
        quantity, remarks, applicability, raw_columns)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );

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
        renderDiagram(pdf, sec.diagramPage, sec.sectionNum, imagesDir, catalogId, tWorker)
          .catch(e => {
            post('status', { message: `Diagram render skipped for ${sec.sectionNum}: ${e.message}` });
            return { imgPath: null, callouts: [] };
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
    const { imgPath, callouts } = diagramResult;
    const firstPartsPage = sec.diagramPage + 1;

    t = performance.now();
    const mgId  = ensureMainGroup(db, mgCache, catalogId, sec.mainGroupNum, sec.mainGroupTitle);
    const secId = insertSection(
      db, mgId, catalogId, sec.sectionNum, sec.sectionTitle,
      firstPartsPage, sec.diagramPage, imgPath
    );
    for (const c of callouts) {
      calloutStmt.run([secId, c.number, c.x0, c.y0, c.x1, c.y1, c.confidence]);
    }
    TIMING.dbInserts += performance.now() - t;

    for (let pi = 0; pi < partsResults.length; pi++) {
      const { parts, titleRow } = partsResults[pi];
      t = performance.now();
      if (pi === 0 && titleRow) {
        const tr = titleRow;
        db.run(
          'UPDATE section SET title=?, title_remark=?, title_model=? WHERE id=?',
          [tr.description || sec.sectionTitle, tr.remark || null, tr.model || null, secId]
        );
      }
      for (const part of parts) {
        partStmt.run([
          secId, catalogId, part.pos, part.partNumber, part.description,
          part.qty, part.remark, part.applicability, JSON.stringify(part.rawColumns),
        ]);
        partCount++;
      }
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
    `    PNG convert+save   : ${fmt(T.convertSavePng)} ${perDiag(T.convertSavePng)}\n` +
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
  let model = '';

  for (const l1 of outline) {
    if (!l1.items?.length) continue;
    if (!model) model = l1.title;

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

  return { model, sections };
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

  for (let pageNum = 1; pageNum < firstDiagramPage; pageNum++) {
    const page    = await pdf.getPage(pageNum);
    const vp      = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    page.cleanup();

    const items    = content.items.filter(it => it.str?.trim());
    const rowObjs  = groupIntoRows(items, vp.height);
    const rows     = rowObjs.map(r => r.items.map(it => it.str.trim()).filter(Boolean));
    const pageText = rows.map(r => r.join(' ')).join('\n');

    if      (pageText.includes('Optional Equipment'))        parsePRCodesPage(rows, prCodes);
    else if (pageText.includes('Model Overview Sales Type')) parseSalesTypesPage(rows, salesTypes);
    else if (pageText.includes('Model Overview EC'))         parseEngineCodesPage(rows, engineCodes);
    else if (pageText.includes('Model Overview TC'))         parseTransmissionCodesPage(rows, transmCodes);
    else if (pageText.includes('VIN-Numbers Overview'))      parseVINRangesPage(rows, vinRanges);
    else if (pageText.includes('SUMMARY TYPES'))             parseSummaryTypesPage(rows, vinRanges);
    else if (pageText.includes('Engine type'))               parseEngineNumbersPage(rows, engineNums);
    else if (pageText.includes('Gearbox type'))              parseTransmissionNumbersPage(rows, transmNums);
  }

  return { prCodes, salesTypes, vinRanges, engineCodes, transmCodes, engineNums, transmNums };
}

function parsePRCodesPage(rows, prCodes) {
  const CODE_RE = /^\d{3}$|^[A-Z][A-Z0-9]{2,3}$/;
  let inData  = false;
  let current = null;

  for (const texts of rows) {
    if (!texts.length) continue;

    if (!inData) {
      const rowText = texts.join(' ');
      if (/\bNR\b/.test(rowText) && rowText.includes('Description')) { inData = true; }
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
      if (current) prCodes.push(current);
      current = { code: texts[0], description: texts.slice(1).join(' ') };
    } else if (current) {
      current.description = (current.description + ' ' + texts.join(' ')).trim();
    }
  }

  if (current) prCodes.push(current);
}

function parseSalesTypesPage(rows, salesTypes) {
  let inData = false;

  for (const texts of rows) {
    if (!texts.length) continue;
    if (!inData) {
      if (texts.join(' ').includes('Sales term')) { inData = true; }
      continue;
    }

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

function parseVINRangesPage(rows, vinRanges) {
  let inData  = false;
  let current = null;

  for (const texts of rows) {
    if (!texts.length) continue;
    if (!inData) {
      if (texts.join(' ').includes('Model year')) { inData = true; }
      continue;
    }

    if (/^\d{4}$/.test(texts[0])) {
      if (current) vinRanges.push(current);
      // VIN-to may be its own item ">99-7S783000" or merged with vin_from; find it by ">" prefix
      const vinToIdx = texts.findIndex((t, i) => i >= 3 && t.startsWith('>'));
      const vinToRaw = vinToIdx >= 0 ? texts[vinToIdx] : (texts[3] || '');
      const remarkStart = vinToIdx >= 0 ? vinToIdx + 1 : 4;
      current = {
        modelYear: parseInt(texts[0]),
        startDate: texts[1] || null,
        vinFrom:   texts[2] || null,
        vinTo:     vinToRaw.replace(/^>/, '') || null,
        remark:    texts.slice(remarkStart).join(' ') || null,
      };
    } else if (current) {
      // Skip page header/footer lines (e.g. "19.07.2018 - 1 Kat P30")
      if (texts.some(t => /^\d{2}\.\d{2}\.\d{4}/.test(t))) continue;
      const cont = texts.join(' ').trim();
      if (cont) current.remark = current.remark ? current.remark + ' ' + cont : cont;
    }
  }

  if (current) vinRanges.push(current);
}

// Parses older "SUMMARY TYPES" pages (e.g. Cayenne 955, 356).
//
// Cayenne row: CAYENNE [S] [TURBO] [(...markets...)]  03  3  9P3LA  00061>10000  M02.2Y  184  KW
//   tokens:    [vehicle words...]                      MY  #  pfx    from>to      engine  kw  "KW"
// 356 row:   *  356 COUPE  50  05001>05410  369/1100
//   tokens:  *  [vehicle]  MY  from>to      engine
//
// Continuation rows (356 only): just an extra from>to on its own line — inherit last vehicle+MY.
function parseSummaryTypesPage(rows, vinRanges) {
  let inData      = false;
  let lastVehicle = null;
  let lastMY      = null;

  // VIN/chassis range token: optional prefix letters then digits>digits
  // Handles "00061>10000", "9P6LA00061>10000", "05001>05410", "P90501>P90959"
  const VIN_RE = /^[A-Z]*\d[\w]*>[A-Z]*\d[\w]*$/;

  for (const texts of rows) {
    if (!texts.length) continue;

    // Skip page header/footer lines
    if (texts.some(t => /^\d{2}\.\d{2}\.\d{4}/.test(t))) continue;
    if (texts.some(t => t.startsWith('Model:'))) continue;

    if (!inData) {
      // Header row: "VIN" or "VEHICLE IDENT.NR." column label signals start of data
      if (texts.some(t => t === 'VIN' || t === 'IDENT.NR.' || t.startsWith('IDENT'))) {
        inData = true;
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

    // Tokens before the VIN range: [...vehicleWords, MY_2digit, ?singleDigit, ?vinPfx]
    const pre = ts.slice(0, vinIdx);

    // Find the 2-digit MY: last token matching exactly \d{2} in pre
    let myIdx = -1;
    for (let i = pre.length - 1; i >= 0; i--) {
      if (/^\d{2}$/.test(pre[i])) { myIdx = i; break; }
    }

    let vehicle, my, vinPrefix;
    if (myIdx >= 0) {
      vehicle = pre.slice(0, myIdx).join(' ') || lastVehicle;
      my      = pre[myIdx];

      // After MY: skip single-digit internal code, find optional VIN prefix (mixed alnum)
      const afterMY = pre.slice(myIdx + 1);
      const pfxTok  = afterMY.find(t => /[A-Z]/.test(t)); // contains a letter → VIN prefix
      vinPrefix = pfxTok || '';

      lastVehicle = vehicle;
      lastMY      = my;
    } else {
      // Continuation row (e.g. 356 extra VIN range for same vehicle/MY)
      vehicle   = lastVehicle;
      my        = lastMY;
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

function parseEngineCodesPage(rows, engineCodes) {
  let inData = false;
  for (const texts of rows) {
    if (!texts.length) continue;
    if (!inData) {
      if (texts[0] === 'EC') { inData = true; }
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

function parseTransmissionCodesPage(rows, transmCodes) {
  let inData = false;
  for (const texts of rows) {
    if (!texts.length) continue;
    if (!inData) {
      if (texts[0] === 'TC') { inData = true; }
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

function parseEngineNumbersPage(rows, engineNumbers) {
  let inData = false;
  for (const texts of rows) {
    if (!texts.length) continue;
    if (!inData) {
      if (texts.join(' ').includes('Engine number')) { inData = true; }
      continue;
    }
    if (texts.some(t => /^\d{2}\.\d{2}\.\d{4}/.test(t))) continue;
    // Year is always 20xx; engine codes like "9770" are excluded by this pattern
    const yearIdx = texts.findIndex(t => /^20\d{2}$/.test(t));
    if (yearIdx < 1) continue;
    const numberRaw = texts.slice(0, yearIdx).join(' ');
    const gtMatch   = numberRaw.match(/^(.+?)\s*>\s*(.+)$/);
    engineNumbers.push({
      numberFrom:  (gtMatch ? gtMatch[1] : numberRaw).trim(),
      numberTo:    gtMatch ? gtMatch[2].trim() : null,
      modelYear:   parseInt(texts[yearIdx]),
      vehicleType: texts.slice(yearIdx + 1, -1).join(' '),
      engineType:  texts.at(-1),
    });
  }
}

function parseTransmissionNumbersPage(rows, transmNumbers) {
  let inData = false;
  for (const texts of rows) {
    if (!texts.length) continue;
    if (!inData) {
      if (texts.join(' ').includes('Gearbox type')) { inData = true; }
      continue;
    }
    if (texts.some(t => /^\d{2}\.\d{2}\.\d{4}/.test(t))) continue;
    const yearIdx = texts.findIndex(t => /^20\d{2}$/.test(t));
    if (yearIdx < 1) continue;
    const numberRaw = texts.slice(0, yearIdx).join(' ');
    const gtMatch   = numberRaw.match(/^(.+?)\s*>\s*(.+)$/);
    transmNumbers.push({
      numberFrom:  (gtMatch ? gtMatch[1] : numberRaw).trim(),
      numberTo:    gtMatch ? gtMatch[2].trim() : null,
      modelYear:   parseInt(texts[yearIdx]),
      vehicleType: texts.slice(yearIdx + 1, -1).join(' '),
      gearboxType: texts.at(-1),
    });
  }
}

// ── Parts extraction ──────────────────────────────────────────────────────────

async function extractParts(pdf, pageNum, initialLastPos = '') {
  if (pageNum < 1 || pageNum > pdf.numPages) return { parts: [], titleRow: null, lastPos: initialLastPos };

  const page    = await pdf.getPage(pageNum);
  const vp      = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  page.cleanup();

  const items = content.items.filter(it => it.str?.trim());
  const rows  = groupIntoRows(items, vp.height);

  let colOrigins  = null;
  const parts     = [];
  let current     = null;
  let seenPart    = false;
  let lastPos     = initialLastPos;
  // Rows before the first part row that have no Pos/Part Number — the diagram title block.
  // Multiple description, remark, and model lines are each collected separately so they can
  // be joined independently.
  const titleDescLines   = [];
  const titleRemarkLines = [];
  const titleModelLines  = [];

  function flush() {
    if (current?.partNumber) parts.push(current);
    current = null;
  }

  for (const row of rows) {
    const texts = row.items.map(it => it.str.trim()).filter(Boolean);
    if (!texts.length) continue;

    // Section header line — "Illustration: 101-000"
    if (texts.length === 1 && texts[0].startsWith('Illustration:')) continue;

    // Model filter line — "Model: 997T07  Model life 2007>>2009"
    if (texts.some(t => t === 'Model:' || t.startsWith('Model:'))) continue;

    // Column header row — sets column origins for all subsequent rows on this page
    if (!colOrigins && texts.filter(t => COL_HEADER_SET.has(t)).length >= 4) {
      colOrigins = calibrateCols(row.items);
      continue;
    }

    if (!colOrigins) continue; // haven't reached the header yet

    // Part row — checked FIRST because part rows often contain "PR:" codes in
    // the Model column, which would otherwise trigger the applicability heuristic.
    // Case 1: plain number "5"
    // Case 2: parenthesized "(5)" — part may differ from illustration
    if ((/^\d{1,3}$/.test(texts[0]) || /^\(\d{1,3}\)$/.test(texts[0])) && row.items.length >= 5) {
      seenPart = true;
      flush();
      const cols = assignColumns(row.items, colOrigins);
      const pos = joinCol(cols['Pos']);
      if (pos) lastPos = pos;
      current = {
        pos:          pos || lastPos,
        partNumber:   joinCol(cols['Part Number']),
        description:  joinCol(cols['Description']),
        qty:          joinCol(cols['Qty']),
        remark:       joinCol(cols['Remark']),
        applicability: '',
        rawColumns:   cols,
      };
      continue;
    }

    // Case 3: dash position — part exists but is not shown in diagram.
    // Distinguished from sub-part inclusion lines by column assignment: if the
    // dash lands in the Pos column with a valid Part Number, it's case 3.
    // Sub-part dashes appear in the Part Number zone and fall through to be skipped.
    if (texts[0] === '-') {
      if (row.items.length >= 4) {
        const cols = assignColumns(row.items, colOrigins);
        if (joinCol(cols['Pos']) === '-' && joinCol(cols['Part Number'])) {
          seenPart = true;
          flush();
          // Don't update lastPos — '-' shouldn't propagate to continuation rows
          current = {
            pos:           '-',
            partNumber:    joinCol(cols['Part Number']),
            description:   joinCol(cols['Description']),
            qty:           joinCol(cols['Qty']),
            remark:        joinCol(cols['Remark']),
            applicability: '',
            rawColumns:    cols,
          };
          continue;
        }
      }
      // Sub-part inclusion line — not separately orderable, skip
      continue;
    }

    // Applicability continuation — PR option codes or model-year ranges.
    // Only reached after part-row and sub-part checks.
    if (isApplicabilityRow(texts)) {
      if (current) {
        const token = texts.join(' ');
        current.applicability = current.applicability
          ? current.applicability + ' | ' + token
          : token;
      }
      continue;
    }

    // Diagram title block: rows before the first part that have no Pos/Part Number.
    // Multiple description, remark, and model lines each get accumulated separately.
    if (!seenPart) {
      const cols = assignColumns(row.items, colOrigins);
      const pos  = joinCol(cols['Pos']);
      const pn   = joinCol(cols['Part Number']);
      const desc = joinCol(cols['Description']);
      const rem  = joinCol(cols['Remark']);
      const mod  = joinCol(cols['Model']);
      if (!pos && !pn && (desc || rem || mod)) {
        if (desc) titleDescLines.push(desc);
        if (rem)  titleRemarkLines.push(rem);
        if (mod)  titleModelLines.push(mod);
        continue;
      }
    }

    // Group headers, notes, attention blocks — skip
  }

  flush();

  const titleRow = (titleDescLines.length || titleRemarkLines.length || titleModelLines.length)
    ? {
        description: titleDescLines.join(' '),
        remark:      titleRemarkLines.join(' '),
        model:       [...new Set(titleModelLines)].join(' '),
      }
    : null;

  return { parts, titleRow, lastPos };
}

function isApplicabilityRow(texts) {
  return texts.some(t =>
    /^PR:/.test(t) ||      // option code: PR:480
    t.includes('>>') ||    // range separator: MJ2007>>MJ2009
    /MJ\d{4}/.test(t)      // model-year token: MJ2007
  );
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

// Assign each item to the rightmost column whose x-origin is ≤ item.x (+5pt tolerance)
function assignColumns(items, colOrigins) {
  const cols = Object.fromEntries(colOrigins.map(c => [c.name, []]));
  for (const it of items) {
    const x = it.transform[4];
    let col = colOrigins[0].name;
    for (const c of colOrigins) {
      if (c.x <= x + 5) col = c.name;
    }
    cols[col].push(it.str.trim());
  }
  return cols;
}

function joinCol(arr) { return arr?.join(' ') ?? ''; }

// Fetch all parts pages for a section in parallel, then trim at the first empty page.
// nextDiagramPage is the exclusive upper bound (first page of the next section).
async function extractSectionParts(pdf, firstPartsPage, nextDiagramPage) {
  const pageNums = [];
  for (let p = firstPartsPage; p < nextDiagramPage; p++) pageNums.push(p);
  if (!pageNums.length) return [];

  const out = [];
  let carryLastPos = '';
  for (const p of pageNums) {
    const t = performance.now();
    let r = { parts: [], titleRow: null, lastPos: carryLastPos };
    try {
      r = await extractParts(pdf, p, carryLastPos);
    } catch (e) {
      post('status', { message: `Parts extraction skipped p${p}: ${e.message}` });
    }
    TIMING.extractParts += performance.now() - t;
    TIMING.partsPagesCount++;
    carryLastPos = r.lastPos;
    if (!r.parts.length) break;
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

    let strip = null;
    if (debug) {
      const SEP    = Math.round(targetPx * 1.2);
      const stripH = Math.round(targetPx * 1.8);
      let cursor = SEP;
      const positions = blobItems.map(it => { const sx = cursor; cursor += it.canvas.width + SEP; return sx; });
      strip = new OffscreenCanvas(cursor, stripH);
      const sctx = strip.getContext('2d');
      sctx.fillStyle = 'white'; sctx.fillRect(0, 0, cursor, stripH);
      for (let i = 0; i < blobItems.length; i++)
        sctx.drawImage(blobItems[i].canvas, positions[i], Math.round((stripH - blobItems[i].canvas.height) / 2));
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
    return { digitResults, strip };
  }

  // Multi-scale cascade: try each candidate font size, stop on first confirmed digit
  let scale, digitResults, strip = null;
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
      if (debug) strip = out.strip;
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
    return { callouts: [], strip: null, stats: failStats };
  }

  digitResults.sort((a, b) => a.blob.x0 - b.blob.x0);
  const X_GAP = targetPx * 0.9, Y_TOL = targetPx * 0.1;
  const numGroups = [];
  for (const dr of digitResults) {
    const b = dr.blob, yc = (b.y0 + b.y1) / 2;
    let placed = false;
    for (const g of numGroups) {
      const last = g.digits[g.digits.length-1], lb = last.blob;
      const xGap = (b.x0+b.x1)/2 - (lb.x0+lb.x1)/2;
      if (Math.abs(yc - (lb.y0+lb.y1)/2) < Y_TOL && xGap >= 0 && xGap < X_GAP) {
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
  return { callouts, strip, stats };
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
  const imagesDir = partsOnly ? null : await catalogDir.getDirectoryHandle('images', { create: true });

  let db;
  try {
    const fh   = await catalogDir.getFileHandle('catalog.sqlite');
    const file = await fh.getFile();
    db = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
  } catch { throw new Error(`catalog.sqlite not found for "${catalogId}" — run a full ingest first.`); }

  // Migrate schema: add any tables that didn't exist in previously-ingested DBs
  db.exec(`
    CREATE TABLE IF NOT EXISTS pr_code (
      id INTEGER PRIMARY KEY, catalog_id TEXT,
      code TEXT NOT NULL, description TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sales_type (
      id INTEGER PRIMARY KEY, catalog_id TEXT,
      sales_term TEXT NOT NULL, description TEXT NOT NULL,
      mount_from TEXT, mount_to TEXT, remark TEXT
    );
    CREATE TABLE IF NOT EXISTS vin_range (
      id INTEGER PRIMARY KEY, catalog_id TEXT,
      model_year INTEGER, start_date TEXT,
      vin_from TEXT, vin_to TEXT, remark TEXT
    );
    CREATE TABLE IF NOT EXISTS engine_code (
      id INTEGER PRIMARY KEY, catalog_id TEXT,
      ec TEXT NOT NULL, displacement_l TEXT,
      power_kw INTEGER, power_hp INTEGER, cylinders INTEGER,
      mount_from TEXT, mount_to TEXT, remark TEXT
    );
    CREATE TABLE IF NOT EXISTS transmission_code (
      id INTEGER PRIMARY KEY, catalog_id TEXT,
      tc TEXT NOT NULL, type_code TEXT,
      mount_from TEXT, mount_to TEXT, remark TEXT
    );
    CREATE TABLE IF NOT EXISTS engine_number_range (
      id INTEGER PRIMARY KEY, catalog_id TEXT,
      number_from TEXT, number_to TEXT,
      model_year INTEGER, vehicle_type TEXT, engine_type TEXT
    );
    CREATE TABLE IF NOT EXISTS transmission_number_range (
      id INTEGER PRIMARY KEY, catalog_id TEXT,
      number_from TEXT, number_to TEXT,
      model_year INTEGER, vehicle_type TEXT, gearbox_type TEXT
    );
  `);

  post('status', { message: 'Parsing table of contents…' });
  const outline       = await pdf.getOutline();
  const { sections }  = await parseOutline(outline, pdf);

  post('status', { message: 'Parsing model/option information…' });
  for (const tbl of ['pr_code','sales_type','vin_range','engine_code','transmission_code','engine_number_range','transmission_number_range'])
    db.run(`DELETE FROM ${tbl} WHERE catalog_id=?`, [catalogId]);
  const vp = await parseVPages(pdf, sections[0].diagramPage);
  insertVPageData(db, catalogId, vp);

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
  const partStmt = db.prepare(
    `INSERT INTO part
       (section_id, catalog_id, position, part_number, description,
        quantity, remarks, applicability, raw_columns)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );

  const sectionIndexMap = new Map(sections.map((s, i) => [s.sectionNum, i]));
  let doneCount = 0, partCount = 0;

  for (const sec of targets) {
    const tWorker = pool ? await pool.acquire() : null;
    try {
      const idx             = sectionIndexMap.get(sec.sectionNum);
      const nextDiagramPage = sections[idx + 1]?.diagramPage ?? (pdf.numPages + 1);
      const firstPartsPage  = sec.diagramPage + 1;

      const [diagramResult, partsResults] = await Promise.all([
        partsOnly
          ? Promise.resolve({ imgPath: null, callouts: null })
          : renderDiagram(pdf, sec.diagramPage, sec.sectionNum, imagesDir, catalogId, tWorker)
              .catch(e => {
                post('status', { message: `Diagram render skipped for ${sec.sectionNum}: ${e.message}` });
                return { imgPath: null, callouts: [] };
              }),
        extractSectionParts(pdf, firstPartsPage, nextDiagramPage),
      ]);

      const secStmt = db.prepare('SELECT id FROM section WHERE catalog_id=? AND number=?');
      secStmt.bind([catalogId, sec.sectionNum]);
      let secId = null;
      if (secStmt.step()) secId = secStmt.getAsObject().id;
      secStmt.free();

      if (secId == null) {
        post('status', { message: `Section ${sec.sectionNum} not in DB — skipping` });
        continue;
      }

      if (diagramResult.imgPath)
        db.run('UPDATE section SET diagram_image=? WHERE id=?', [diagramResult.imgPath, secId]);

      if (diagramResult.callouts !== null) {
        db.run('DELETE FROM callout WHERE section_id=?', [secId]);
        for (const c of diagramResult.callouts)
          calloutStmt.run([secId, c.number, c.x0, c.y0, c.x1, c.y1, c.confidence]);
      }

      db.run('DELETE FROM part WHERE section_id=?', [secId]);
      for (let pi = 0; pi < partsResults.length; pi++) {
        const { parts, titleRow } = partsResults[pi];
        if (pi === 0 && titleRow)
          db.run('UPDATE section SET title=?, title_remark=?, title_model=? WHERE id=?',
            [titleRow.description || sec.sectionTitle, titleRow.remark || null, titleRow.model || null, secId]);
        for (const part of parts) {
          partStmt.run([secId, catalogId, part.pos, part.partNumber, part.description,
            part.qty, part.remark, part.applicability, JSON.stringify(part.rawColumns)]);
          partCount++;
        }
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
  dbInit:          0,  // initSqlJs + createSchema
  tesseractInit:   0,  // initTesseract
  opfsSetup:       0,  // navigator.storage.getDirectory + handle setup
  tocParse:        0,  // pdf.getOutline + parseOutline
  vPageParse:      0,  // parseVPages() — PR codes, sales types, VIN ranges
  renderDiagram:   0,  // renderDiagram() wall time (includes OCR and PNG save)
  extractParts:    0,  // extractParts() across all pages of all sections
  dbInserts:       0,  // calloutStmt.run + partStmt.run + insertSection
  ftsBuild:        0,  // FTS index rebuild
  dbSave:          0,  // db.export + writeOpfsFile
  // ── OCR internals (subset of renderDiagram) ────────────────────────────────
  render:          0,  // page.getOperatorList + page.render
  convertSavePng:  0,  // canvas.convertToBlob + writeOpfsFile
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

async function renderDiagram(pdf, pageNum, sectionNum, imagesDir, catalogId, tWorker) {
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
  const blob = await binarize(ocrCanvas, OCR_BIN_THRESH).convertToBlob({ type: 'image/webp' });
  const name = `${sectionNum}.webp`;
  await writeOpfsFile(imagesDir, name, await blob.arrayBuffer());
  const imgPath = `${catalogId}/images/${name}`;
  TIMING.convertSavePng += performance.now() - t;

  let callouts = [];
  if (tWorker) {
    try {
      ({ callouts } = await ocrDiagram(ocrCanvas, opList, vp, tWorker, diagRect));
    } catch (e) {
      // OCR failure is non-fatal; parts table works without callouts
    }
  }

  return { imgPath, callouts };
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

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog (
      id TEXT PRIMARY KEY, model TEXT, page_count INTEGER, ingested_at TEXT
    );
    CREATE TABLE IF NOT EXISTS main_group (
      id INTEGER PRIMARY KEY, catalog_id TEXT, number TEXT, title TEXT
    );
    CREATE TABLE IF NOT EXISTS section (
      id INTEGER PRIMARY KEY, main_group_id INTEGER, catalog_id TEXT,
      number TEXT, title TEXT, parts_page INTEGER, diagram_page INTEGER, diagram_image TEXT,
      title_remark TEXT, title_model TEXT
    );
    CREATE TABLE IF NOT EXISTS part (
      id INTEGER PRIMARY KEY, section_id INTEGER, catalog_id TEXT,
      position TEXT, part_number TEXT, description TEXT,
      quantity TEXT, unit TEXT, remarks TEXT, applicability TEXT, raw_columns TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS part_fts USING fts4(
      content="part",
      part_number, description
    );
    CREATE TABLE IF NOT EXISTS callout (
      id INTEGER PRIMARY KEY, section_id INTEGER,
      number TEXT, x0 INTEGER, y0 INTEGER, x1 INTEGER, y1 INTEGER,
      confidence INTEGER
    );
    CREATE TABLE IF NOT EXISTS pr_code (
      id INTEGER PRIMARY KEY, catalog_id TEXT,
      code TEXT NOT NULL, description TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sales_type (
      id INTEGER PRIMARY KEY, catalog_id TEXT,
      sales_term TEXT NOT NULL, description TEXT NOT NULL,
      mount_from TEXT, mount_to TEXT, remark TEXT
    );
    CREATE TABLE IF NOT EXISTS vin_range (
      id INTEGER PRIMARY KEY, catalog_id TEXT,
      model_year INTEGER, start_date TEXT,
      vin_from TEXT, vin_to TEXT, remark TEXT
    );
    CREATE TABLE IF NOT EXISTS engine_code (
      id INTEGER PRIMARY KEY, catalog_id TEXT,
      ec TEXT NOT NULL, displacement_l TEXT,
      power_kw INTEGER, power_hp INTEGER, cylinders INTEGER,
      mount_from TEXT, mount_to TEXT, remark TEXT
    );
    CREATE TABLE IF NOT EXISTS transmission_code (
      id INTEGER PRIMARY KEY, catalog_id TEXT,
      tc TEXT NOT NULL, type_code TEXT,
      mount_from TEXT, mount_to TEXT, remark TEXT
    );
    CREATE TABLE IF NOT EXISTS engine_number_range (
      id INTEGER PRIMARY KEY, catalog_id TEXT,
      number_from TEXT, number_to TEXT,
      model_year INTEGER, vehicle_type TEXT, engine_type TEXT
    );
    CREATE TABLE IF NOT EXISTS transmission_number_range (
      id INTEGER PRIMARY KEY, catalog_id TEXT,
      number_from TEXT, number_to TEXT,
      model_year INTEGER, vehicle_type TEXT, gearbox_type TEXT
    );
  `);
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

function insertSection(db, mgId, catalogId, num, title, partsPage, diagPage, imgPath) {
  db.run(
    `INSERT INTO section
       (main_group_id, catalog_id, number, title, parts_page, diagram_page, diagram_image)
     VALUES (?,?,?,?,?,?,?)`,
    [mgId, catalogId, num, title, partsPage, diagPage, imgPath]
  );
  return db.exec('SELECT last_insert_rowid()')[0].values[0][0];
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
  const { callouts, strip, stats } = await ocrDiagram(
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
    stripWidth: strip?.width, stripHeight: strip?.height,
    width: cropCanvas.width, height: cropCanvas.height, native, srcLabel, stats }, transfer);
}
