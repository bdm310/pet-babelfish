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
  'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.js'
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
  if (data.type !== 'ingest') return;
  try {
    await ingest(data.buffer, data.catalogId);
  } catch (err) {
    post('error', { message: String(err) });
  }
};

function post(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

async function ingest(buffer, catalogId) {
  post('status', { message: 'Loading PDF…' });
  const pdf = await pdfjsLib.getDocument({ data: buffer, ...PDFJS_OPTS, canvasFactory: CANVAS_FACTORY }).promise;

  post('status', { message: 'Initialising database…' });
  const SQL = await initSqlJs({ locateFile: () => SQLJS_WASM });
  const db  = new SQL.Database();
  createSchema(db);

  post('status', { message: 'Opening storage…' });
  const opfsRoot  = await navigator.storage.getDirectory();
  const catalogDir = await opfsRoot.getDirectoryHandle(catalogId, { create: true });
  const imagesDir  = await catalogDir.getDirectoryHandle('images', { create: true });

  post('status', { message: 'Parsing table of contents…' });
  const outline = await pdf.getOutline();
  const { model, sections } = await parseOutline(outline, pdf);

  if (!sections.length) throw new Error('No sections found in TOC — is this a PET catalog?');

  db.run(
    'INSERT OR REPLACE INTO catalog (id, model, page_count, ingested_at) VALUES (?,?,?,?)',
    [catalogId, model, pdf.numPages, new Date().toISOString()]
  );

  const mgCache   = new Map(); // `catalogId\0number` → rowid
  let   partCount = 0;

  const partStmt = db.prepare(
    `INSERT INTO part
       (section_id, catalog_id, position, part_number, description,
        quantity, remarks, applicability, raw_columns)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );

  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    post('progress', {
      pct:   Math.round((i / sections.length) * 100),
      label: `${sec.sectionNum}${sec.sectionTitle ? ' — ' + sec.sectionTitle : ''}`,
    });

    const mgId = ensureMainGroup(db, mgCache, catalogId, sec.mainGroupNum, sec.mainGroupTitle);

    let imgPath = null;
    try {
      imgPath = await renderDiagram(pdf, sec.diagramPage, sec.sectionNum, imagesDir, catalogId);
    } catch (e) {
      post('status', { message: `Diagram render skipped for ${sec.sectionNum}: ${e.message}` });
    }

    const firstPartsPage = sec.diagramPage + 1;
    // Hard boundary: stop before the next section's diagram page (or end of document)
    const nextDiagramPage = sections[i + 1]?.diagramPage ?? (pdf.numPages + 1);

    const secId = insertSection(
      db, mgId, catalogId, sec.sectionNum, sec.sectionTitle,
      firstPartsPage, sec.diagramPage, imgPath
    );

    // Collect parts across all continuation pages for this section.
    // extractParts returns { parts:[], titleRow:null } for non-parts-list pages
    // (diagram pages have no column header), so the loop naturally stops at the
    // next diagram page without special detection.
    for (let p = firstPartsPage; p < nextDiagramPage; p++) {
      let result = { parts: [], titleRow: null };
      try {
        result = await extractParts(pdf, p);
      } catch (e) {
        post('status', { message: `Parts extraction skipped p${p} (${sec.sectionNum}): ${e.message}` });
      }
      if (!result.parts.length) break;

      // On the first parts page, persist the diagram title block to the section row.
      if (p === firstPartsPage && result.titleRow) {
        const tr = result.titleRow;
        db.run(
          'UPDATE section SET title=?, title_remark=?, title_model=? WHERE id=?',
          [tr.description || sec.sectionTitle, tr.remark || null, tr.model || null, secId]
        );
      }

      for (const part of result.parts) {
        partStmt.run([
          secId, catalogId, part.pos, part.partNumber, part.description,
          part.qty, part.remark, part.applicability, JSON.stringify(part.rawColumns),
        ]);
        partCount++;
      }
    }
  }

  partStmt.free();

  post('status', { message: 'Building search index…' });
  db.run("INSERT INTO part_fts(part_fts) VALUES ('rebuild')");

  post('status', { message: 'Saving database…' });
  await writeOpfsFile(catalogDir, 'catalog.sqlite', db.export());
  db.close();
  pdf.destroy();

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
        // "101-000: Crankcase" or "101-000 Crankcase"
        const secMatch = l3.title.match(/^(\d{3}-\d{3})[:\s]*(.*)/);
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

// ── Parts extraction ──────────────────────────────────────────────────────────

async function extractParts(pdf, pageNum) {
  if (pageNum < 1 || pageNum > pdf.numPages) return { parts: [], titleRow: null };

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
    if (/^\d{1,3}$/.test(texts[0]) && row.items.length >= 5) {
      seenPart = true;
      flush();
      const cols = assignColumns(row.items, colOrigins);
      current = {
        pos:          joinCol(cols['Pos']),
        partNumber:   joinCol(cols['Part Number']),
        description:  joinCol(cols['Description']),
        qty:          joinCol(cols['Qty']),
        remark:       joinCol(cols['Remark']),
        applicability: '',
        rawColumns:   cols,
      };
      continue;
    }

    // Sub-part inclusion lines: "- 999 571 074 30  Threaded stud  1  PR:447"
    // These are components included inside a parent part, marked with a leading
    // dash instead of a position number. Skip them — they're not separately
    // orderable and would otherwise bleed into the applicability of the parent.
    if (texts[0] === '-' && row.items.length >= 4) continue;

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

  return { parts, titleRow };
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

// ── Diagram rendering ─────────────────────────────────────────────────────────

async function renderDiagram(pdf, pageNum, sectionNum, imagesDir, catalogId) {
  const page   = await pdf.getPage(pageNum);
  const vp     = page.getViewport({ scale: DIAGRAM_SCALE });
  const canvas = new OffscreenCanvas(Math.round(vp.width), Math.round(vp.height));
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  page.cleanup();

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const name = `${sectionNum}.png`;
  await writeOpfsFile(imagesDir, name, await blob.arrayBuffer());
  return `${catalogId}/images/${name}`;
}

// ── OPFS helper ───────────────────────────────────────────────────────────────

async function writeOpfsFile(dirHandle, name, data) {
  const fh = await dirHandle.getFileHandle(name, { create: true });
  const w  = await fh.createWritable();
  await w.write(data);
  await w.close();
}

// ── SQLite helpers ────────────────────────────────────────────────────────────

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
