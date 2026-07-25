// CCITT Group 4 (ITU-T T.6) bilevel codec - the diagram storage format.
//
// Diagrams are pure black/white line art. Stored as raw T.6 bitstream in
// section.diagram_blob (no TIFF container); width/height ride in
// section.diagram_w/diagram_h because T.6 has no header - width is required to
// decode and height bounds the row count. ~44% smaller than the lossy RGB WebP
// it replaces, with zero pixel loss.
//
// Convention: white = 0, black = 1. Each coding line starts white. MSB-first bit
// packing (TIFF FillOrder 1). The imaginary line above row 0 is all white.
//
// Shared the same way appl.js/schema.js are: self.CCITT for the worker
// (importScripts) and the viewer (<script src>), module.exports for node tests.

(function (root) {
  'use strict';

  // ── T.4 run-length code tables (reused by T.6 horizontal mode) ──────────────
  // Terminating codes index by run length 0..63; makeup codes key by run length.
  // Stored as binary strings; parsed to {bits,len} once at load. Transcription is
  // easier to eyeball as strings than as pre-computed integers.

  const WHITE_TERM = [
    '00110101','000111','0111','1000','1011','1100','1110','1111',
    '10011','10100','00111','01000','001000','000011','110100','110101',
    '101010','101011','0100111','0001100','0001000','0010111','0000011','0000100',
    '0101000','0101011','0010011','0100100','0011000','00000010','00000011','00011010',
    '00011011','00010010','00010011','00010100','00010101','00010110','00010111','00101000',
    '00101001','00101010','00101011','00101100','00101101','00000100','00000101','00001010',
    '00001011','01010010','01010011','01010100','01010101','00100100','00100101','01011000',
    '01011001','01011010','01011011','01001010','01001011','00110010','00110011','00110100'];

  const WHITE_MAKEUP = {
    64:'11011',128:'10010',192:'010111',256:'0110111',320:'00110110',384:'00110111',
    448:'01100100',512:'01100101',576:'01101000',640:'01100111',704:'011001100',768:'011001101',
    832:'011010010',896:'011010011',960:'011010100',1024:'011010101',1088:'011010110',1152:'011010111',
    1216:'011011000',1280:'011011001',1344:'011011010',1408:'011011011',1472:'010011000',1536:'010011001',
    1600:'010011010',1664:'011000',1728:'010011011'};

  const BLACK_TERM = [
    '0000110111','010','11','10','011','0011','0010','00011',
    '000101','000100','0000100','0000101','0000111','00000100','00000111','000011000',
    '0000010111','0000011000','0000001000','00001100111','00001101000','00001101100','00000110111','00000101000',
    '00000010111','00000011000','000011001010','000011001011','000011001100','000011001101','000001101000','000001101001',
    '000001101010','000001101011','000011010010','000011010011','000011010100','000011010101','000011010110','000011010111',
    '000001101100','000001101101','000011011010','000011011011','000001010100','000001010101','000001010110','000001010111',
    '000001100100','000001100101','000001010010','000001010011','000000100100','000000110111','000000111000','000000100111',
    '000000101000','000001011000','000001011001','000000101011','000000101100','000001011010','000001100110','000001100111'];

  const BLACK_MAKEUP = {
    64:'0000001111',128:'000011001000',192:'000011001001',256:'000001011011',320:'000000110011',384:'000000110100',
    448:'000000110101',512:'0000001101100',576:'0000001101101',640:'0000001001010',704:'0000001001011',768:'0000001001100',
    832:'0000001001101',896:'0000001110010',960:'0000001110011',1024:'0000001110100',1088:'0000001110101',1152:'0000001110110',
    1216:'0000001110111',1280:'0000001010010',1344:'0000001010011',1408:'0000001010100',1472:'0000001010101',1536:'0000001011010',
    1600:'0000001011011',1664:'0000001100100',1728:'0000001100101'};

  // Extended makeup 1792..2560 - shared by both colours.
  const SHARED_MAKEUP = {
    1792:'00000001000',1856:'00000001100',1920:'00000001101',1984:'000000010010',2048:'000000010011',
    2112:'000000010100',2176:'000000010101',2240:'000000010110',2304:'000000010111',2368:'000000011100',
    2432:'000000011101',2496:'000000011110',2560:'000000011111'};

  // 2D mode codes (T.6).
  const MODE = {
    P:  '0001',    // pass
    H:  '001',     // horizontal
    V0: '1', VR1:'011', VR2:'000011', VR3:'0000011', VL1:'010', VL2:'000010', VL3:'0000010',
  };
  const EOFB = '000000000001000000000001';

  // ── Parsed forward tables (run length → {bits,len}) for encoding ────────────
  const bin = s => ({ bits: parseInt(s, 2), len: s.length });

  function buildEmitTables(term, makeup) {
    const t = term.map(bin);
    const m = {};
    for (const k of Object.keys(makeup))      m[+k] = bin(makeup[k]);
    for (const k of Object.keys(SHARED_MAKEUP)) m[+k] = bin(SHARED_MAKEUP[k]);
    // Sorted makeup lengths, descending, for greedy longest-run emission.
    const keys = Object.keys(m).map(Number).sort((a, b) => b - a);
    return { term: t, makeup: m, makeupKeys: keys };
  }
  const EMIT = [
    buildEmitTables(WHITE_TERM, WHITE_MAKEUP),  // [0] white
    buildEmitTables(BLACK_TERM, BLACK_MAKEUP),  // [1] black
  ];

  // ── Reverse tables (code → value), keyed by bit-length, for decoding ────────
  // Run tables map code → run length; makeup values are >= 64, terminating < 64.
  function buildDecodeTable(term, makeup) {
    const byLen = {};
    const add = (str, val) => {
      const L = str.length, c = parseInt(str, 2);
      (byLen[L] || (byLen[L] = new Map())).set(c, val);
    };
    term.forEach((s, run) => add(s, run));
    for (const k of Object.keys(makeup))      add(makeup[k], +k);
    for (const k of Object.keys(SHARED_MAKEUP)) add(SHARED_MAKEUP[k], +k);
    return byLen;
  }
  const DECODE_RUN = [
    buildDecodeTable(WHITE_TERM, WHITE_MAKEUP),
    buildDecodeTable(BLACK_TERM, BLACK_MAKEUP),
  ];
  const DECODE_MODE = (() => {
    const byLen = {};
    for (const [name, str] of Object.entries(MODE)) {
      const L = str.length, c = parseInt(str, 2);
      (byLen[L] || (byLen[L] = new Map())).set(c, name);
    }
    return byLen;
  })();

  // ── Bit I/O (MSB-first) ─────────────────────────────────────────────────────
  class BitWriter {
    constructor() { this.bytes = []; this.cur = 0; this.nbits = 0; }
    write(bits, len) {
      for (let i = len - 1; i >= 0; i--) {
        this.cur = (this.cur << 1) | ((bits >> i) & 1);
        if (++this.nbits === 8) { this.bytes.push(this.cur); this.cur = 0; this.nbits = 0; }
      }
    }
    writeCode(c) { this.write(c.bits, c.len); }
    finish() {
      if (this.nbits > 0) { this.bytes.push(this.cur << (8 - this.nbits)); this.cur = 0; this.nbits = 0; }
      return new Uint8Array(this.bytes);
    }
  }
  class BitReader {
    constructor(bytes) { this.b = bytes; this.pos = 0; this.len = bytes.length * 8; }
    readBit() {
      if (this.pos >= this.len) return -1;
      const bit = (this.b[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
      this.pos++; return bit;
    }
  }

  // ── Changing-element helpers ────────────────────────────────────────────────
  // A "changes" array is the sorted list of columns where colour flips, with the
  // line starting white; changes[i] begins black when i is even, white when odd.
  // Two width sentinels are appended so b1/b2 lookups never run off the end.

  function rowToChanges(row, width) {
    const ch = [];
    let prev = 0;
    for (let x = 0; x < width; x++) {
      const v = row[x] ? 1 : 0;
      if (v !== prev) { ch.push(x); prev = v; }
    }
    ch.push(width, width);
    return ch;
  }

  // First changing element in `changes` strictly right of a0 whose colour is the
  // opposite of `color`. Returns its index. Colour of changes[i] is black iff i even.
  function findB1(changes, a0, color) {
    let i = 0;
    while (changes[i] <= a0) i++;
    // changes[i] colour must be !color; if it equals color, step to the next.
    if (((i & 1) === 0 ? 1 : 0) === color) i++;
    return i;
  }

  // Emit a run of `len` pixels of `color` as makeup(s) + terminating code.
  function emitRun(bw, len, color) {
    const E = EMIT[color];
    while (len >= 64) {
      let m = 0;
      for (const k of E.makeupKeys) { if (k <= len) { m = k; break; } }
      bw.writeCode(E.makeup[m]);
      len -= m;
    }
    bw.writeCode(E.term[len]);
  }

  // ── Encode ──────────────────────────────────────────────────────────────────
  // pixels: Uint8Array length width*height, 0=white 1=black (any nonzero = black).
  function encode(pixels, width, height) {
    const bw = new BitWriter();
    let ref = [width, width];   // imaginary white line above row 0
    for (let y = 0; y < height; y++) {
      const cur = rowToChanges(pixels.subarray(y * width, y * width + width), width);
      let a0 = -1, color = 0, ci = 0;
      while (a0 < width) {
        // a1: first coding change strictly right of a0.
        while (cur[ci] <= a0) ci++;
        const a1 = cur[ci];
        const b1i = findB1(ref, a0, color);
        const b1 = ref[b1i], b2 = ref[b1i + 1];

        if (b2 < a1) {
          bw.writeCode(EMIT_MODE.P); a0 = b2;                // pass
        } else {
          const d = a1 - b1;
          if (d >= -3 && d <= 3) {
            bw.writeCode(VERT[d + 3]); a0 = a1; color ^= 1;  // vertical
          } else {
            const a2 = cur[ci + 1];                          // horizontal
            bw.writeCode(EMIT_MODE.H);
            emitRun(bw, a1 - (a0 < 0 ? 0 : a0), color);
            emitRun(bw, a2 - a1, color ^ 1);
            a0 = a2;
          }
        }
      }
      ref = cur;
    }
    // EOFB terminates the image.
    for (const bitc of EOFB) bw.write(bitc === '1' ? 1 : 0, 1);
    return bw.finish();
  }
  const EMIT_MODE = { P: bin(MODE.P), H: bin(MODE.H) };
  // VERT indexed by (a1-b1)+3 → VL3,VL2,VL1,V0,VR1,VR2,VR3
  const VERT = [bin(MODE.VL3), bin(MODE.VL2), bin(MODE.VL1), bin(MODE.V0),
                bin(MODE.VR1), bin(MODE.VR2), bin(MODE.VR3)];

  // ── Decode ──────────────────────────────────────────────────────────────────
  function readCode(br, table) {
    let acc = 0;
    for (let L = 1; L <= 14; L++) {
      const bit = br.readBit();
      if (bit < 0) return null;
      acc = (acc << 1) | bit;
      const m = table[L];
      if (m && m.has(acc)) return m.get(acc);
    }
    return null;
  }
  // A full run is makeup codes (>=64) accumulated until a terminating code (<64).
  function readRun(br, color) {
    let total = 0;
    for (;;) {
      const v = readCode(br, DECODE_RUN[color]);
      if (v === null) return null;
      total += v;
      if (v < 64) return total;
    }
  }

  // Returns { width, height, pixels } where pixels is Uint8Array w*h of 0/1.
  function decode(bytes, width, height) {
    const br = new BitReader(bytes);
    const pixels = new Uint8Array(width * height);
    let ref = [width, width];
    for (let y = 0; y < height; y++) {
      const cur = [];
      let a0 = -1, color = 0;
      while (a0 < width) {
        const mode = readCode(br, DECODE_MODE);
        if (mode === null) { a0 = width; break; }  // ran out (EOFB / padding)
        const b1i = findB1(ref, a0, color);
        const b1 = ref[b1i], b2 = ref[b1i + 1];
        if (mode === 'P') {
          a0 = b2;                                 // colour unchanged, no transition
        } else if (mode === 'H') {
          const start = a0 < 0 ? 0 : a0;
          const r1 = readRun(br, color);
          const r2 = readRun(br, color ^ 1);
          if (r1 === null || r2 === null) { a0 = width; break; }
          const a1 = start + r1, a2 = a1 + r2;
          if (a1 < width) cur.push(Math.min(a1, width));
          if (a2 < width) cur.push(Math.min(a2, width));
          a0 = a2;
        } else {
          const delta = { V0: 0, VR1: 1, VR2: 2, VR3: 3, VL1: -1, VL2: -2, VL3: -3 }[mode];
          const a1 = b1 + delta;
          if (a1 < width) cur.push(Math.min(Math.max(a1, 0), width));
          a0 = a1; color ^= 1;
        }
      }
      // Expand this row's changes into pixels, then hand them up as the next ref.
      let x = 0, c = 0, base = y * width;
      for (const t of cur) {
        const end = Math.min(t, width);
        if (c) pixels.fill(1, base + x, base + end);
        x = end; c ^= 1;
      }
      if (c && x < width) pixels.fill(1, base + x, base + width);  // final run
      // white tail is already zero-initialised
      cur.push(width, width);
      ref = cur;
    }
    return { width, height, pixels };
  }

  // Convenience: decoded pixels → RGBA (black ink on white) for canvas display.
  function toRGBA(pixels, width, height) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < pixels.length; i++) {
      const v = pixels[i] ? 0 : 255;
      const j = i * 4;
      rgba[j] = rgba[j + 1] = rgba[j + 2] = v; rgba[j + 3] = 255;
    }
    return rgba;
  }

  // ── Self-test (round-trips a few patterns; returns true/throws) ─────────────
  function selftest() {
    const cases = [];
    // deterministic patterns
    const mk = (w, h, fn) => { const p = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) p[y * w + x] = fn(x, y) ? 1 : 0; return { w, h, p }; };
    cases.push(mk(17, 9, () => 0));                                   // all white
    cases.push(mk(17, 9, () => 1));                                   // all black
    cases.push(mk(23, 11, (x) => x % 2));                            // vertical stripes
    cases.push(mk(23, 11, (x, y) => y % 2));                         // horizontal stripes
    cases.push(mk(31, 17, (x, y) => (x + y) % 3 === 0));             // diagonal-ish
    cases.push(mk(64, 40, (x, y) => ((x >> 3) + (y >> 3)) % 2));     // checker blocks
    // pseudo-random
    let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (const [w, h] of [[40, 30], [100, 60], [200, 150]]) cases.push(mk(w, h, () => rnd() < 0.5));
    for (const { w, h, p } of cases) {
      const enc = encode(p, w, h);
      const { pixels } = decode(enc, w, h);
      for (let i = 0; i < p.length; i++) {
        if (pixels[i] !== p[i]) throw new Error(`ccitt selftest mismatch ${w}x${h} at ${i}: got ${pixels[i]} want ${p[i]}`);
      }
    }
    return true;
  }

  const CCITT = { encode, decode, toRGBA, selftest };
  if (typeof module !== 'undefined' && module.exports) module.exports = CCITT;
  else root.CCITT = CCITT;
})(typeof self !== 'undefined' ? self : this);
