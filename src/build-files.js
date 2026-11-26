/*
 * build-files.js — writes small, valid Amiga files in memory: IFF pictures (ILBM) and sounds (8SVX),
 * Workbench icons, ProTracker modules and PowerPacker (PP20) packed files.
 * Used by the tests and by the sample disk, so no real files are needed. The sample content is original.
 * Browser global: `BuildFiles`; Node: `require('./build-files.js')`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BuildFiles = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const bytes = s => Uint8Array.from(s, c => c.charCodeAt(0) & 255);
  const be16 = v => [(v >> 8) & 255, v & 255];
  const be32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  function concat(parts) {
    const len = parts.reduce((n, p) => n + p.length, 0), out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  /** An IFF FORM: `chunks` is [[id, Uint8Array|number[]], …]. */
  function iff(type, chunks) {
    const parts = [bytes(type)];
    for (const [id, data] of chunks) {
      const d = data instanceof Uint8Array ? data : Uint8Array.from(data);
      parts.push(bytes(id), Uint8Array.from(be32(d.length)), d);
      if (d.length & 1) parts.push(new Uint8Array(1));
    }
    const body = concat(parts);
    return concat([bytes('FORM'), Uint8Array.from(be32(body.length)), body]);
  }

  /** ByteRun1 (PackBits) packing of one row. */
  function packBits(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      let run = 1;
      while (i + run < src.length && run < 128 && src[i + run] === src[i]) run++;
      if (run >= 3) { out.push(257 - run, src[i]); i += run; continue; }
      let j = i;
      while (j < src.length && j - i < 128 && !(j + 2 < src.length && src[j] === src[j + 1] && src[j] === src[j + 2])) j++;
      out.push(j - i - 1);
      for (let k = i; k < j; k++) out.push(src[k]);
      i = j;
    }
    return out;
  }

  /** Chunky pixel indexes → interleaved bitplane rows (one row of each plane per line). */
  function toPlanar(pixels, w, h, planes) {
    const rowBytes = ((w + 15) >> 4) * 2, rows = [];
    for (let y = 0; y < h; y++) {
      for (let p = 0; p < planes; p++) {
        const row = new Uint8Array(rowBytes);
        for (let x = 0; x < w; x++) if ((pixels[y * w + x] >> p) & 1) row[x >> 3] |= 0x80 >> (x & 7);
        rows.push(row);
      }
    }
    return rows;
  }

  /** opts: { width, height, planes, palette: [[r,g,b]…], pixels (indexes), compress, camg, aspect: [x, y] } */
  function ilbm(o) {
    const rows = toPlanar(o.pixels, o.width, o.height, o.planes);
    const compress = o.compress !== false;
    const body = compress ? Uint8Array.from(rows.flatMap(r => packBits(r))) : concat(rows);
    const asp = o.aspect || [10, 11];
    const bmhd = [...be16(o.width), ...be16(o.height), 0, 0, 0, 0, o.planes, 0, compress ? 1 : 0, 0, 0, 0, asp[0], asp[1], ...be16(o.width), ...be16(o.height)];
    const chunks = [['BMHD', bmhd], ['CMAP', o.palette.flat()]];
    if (o.camg !== undefined) chunks.push(['CAMG', be32(o.camg)]);
    chunks.push(['BODY', body]);
    return iff('ILBM', chunks);
  }

  const FIB = [-34, -21, -13, -8, -5, -3, -2, -1, 0, 1, 2, 3, 5, 8, 13, 21];
  /** Fibonacci-delta packing (lossy, as on the Amiga): picks the nearest step each time. */
  function fibPack(samples) {
    const out = [0, samples[0] & 255];
    let x = samples[0], nib = [];
    for (let i = 0; i < (samples.length & ~1); i++) {
      let best = 0;
      for (let k = 1; k < 16; k++) if (Math.abs(x + FIB[k] - samples[i]) < Math.abs(x + FIB[best] - samples[i])) best = k;
      x = Math.max(-128, Math.min(127, x + FIB[best]));
      nib.push(best);
      if (nib.length === 2) { out.push((nib[0] << 4) | nib[1]); nib = []; }
    }
    return Uint8Array.from(out);
  }

  /** opts: { samples: Int8Array, rate, name, loopStart, loopLength, fibonacci } */
  function svx(o) {
    const s = o.samples, loopLen = o.loopLength || 0;
    const oneShot = loopLen ? o.loopStart : s.length;
    const vhdr = [...be32(oneShot), ...be32(loopLen), ...be32(0), ...be16(o.rate), 1, o.fibonacci ? 1 : 0, ...be32(0x10000)];
    const body = o.fibonacci ? fibPack(s) : new Uint8Array(s.buffer, s.byteOffset, s.length);
    const chunks = [['VHDR', vhdr]];
    if (o.name) chunks.push(['NAME', bytes(o.name)]);
    chunks.push(['BODY', body]);
    return iff('8SVX', chunks);
  }

  /** opts: { type, width, height, depth, image: indexes, selected: indexes?, defaultTool, toolTypes, revision, stack } */
  function icon(o) {
    const rowBytes = ((o.width + 15) >> 4) * 2;
    const image = px => {
      const data = new Uint8Array(rowBytes * o.height * o.depth);
      for (let d = 0; d < o.depth; d++) for (let y = 0; y < o.height; y++) for (let x = 0; x < o.width; x++) {
        if ((px[y * o.width + x] >> d) & 1) data[(d * o.height + y) * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
      const hdr = [0, 0, 0, 0, ...be16(o.width), ...be16(o.height), ...be16(o.depth), ...be32(1), (1 << o.depth) - 1, 0, ...be32(0)];
      return concat([Uint8Array.from(hdr), data]);
    };
    const str = s => concat([Uint8Array.from(be32(s.length + 1)), bytes(s), new Uint8Array(1)]);
    const head = new Uint8Array(78);
    const put = (off, arr) => head.set(arr, off);
    put(0, be16(0xE310)); put(2, be16(1));
    put(12, be16(o.width)); put(14, be16(o.height + 1));
    put(16, be16(o.selected ? 6 : 5)); put(18, be16(3)); put(20, be16(1));
    put(22, be32(1)); put(26, be32(o.selected ? 1 : 0));
    put(44, be32(o.revision || 0));
    head[48] = o.type;
    put(50, be32(o.defaultTool ? 1 : 0)); put(54, be32(o.toolTypes && o.toolTypes.length ? 1 : 0));
    put(58, be32(0x80000000)); put(62, be32(0x80000000));
    put(74, be32(o.stack || 4096));
    const parts = [head, image(o.image)];
    if (o.selected) parts.push(image(o.selected));
    if (o.defaultTool) parts.push(str(o.defaultTool));
    if (o.toolTypes && o.toolTypes.length) {
      parts.push(Uint8Array.from(be32((o.toolTypes.length + 1) * 4)));
      for (const t of o.toolTypes) parts.push(str(t));
    }
    return concat(parts);
  }

  /** ProTracker periods by note name, 'C-1' to 'B-3'. */
  const NOTE = {};
  const OCTAVES = [
    [856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453],
    [428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226],
    [214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113],
  ];
  ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'].forEach((n, i) => OCTAVES.forEach((row, o) => { NOTE[n + (o + 1)] = row[i]; }));

  /**
   * opts: { title, channels (4), samples: [{ name, data: Int8Array, volume, loopStart, loopLength, finetune }],
   *         patterns: [ [row][channel] = { note: 'C-2' | period, sample, effect, param } | null ], order: [..] }
   */
  function mod(o) {
    const ch = o.channels || 4;
    const head = new Uint8Array(1084);
    head.set(bytes(o.title.slice(0, 20)), 0);
    o.samples.slice(0, 31).forEach((s, i) => {
      const b = 20 + i * 30;
      head.set(bytes(s.name.slice(0, 22)), b);
      head.set(be16(s.data.length >> 1), b + 22);
      head[b + 24] = (s.finetune || 0) & 15; head[b + 25] = s.volume === undefined ? 64 : s.volume;
      head.set(be16((s.loopStart || 0) >> 1), b + 26);
      head.set(be16(s.loopLength ? s.loopLength >> 1 : 1), b + 28);
    });
    head[950] = o.order.length; head[951] = 0;
    o.order.forEach((p, i) => { head[952 + i] = p; });
    head.set(bytes(ch === 4 ? 'M.K.' : ch + 'CHN'), 1080);
    const pats = new Uint8Array(o.patterns.length * 64 * ch * 4);
    o.patterns.forEach((pat, pi) => {
      for (let r = 0; r < 64; r++) for (let c = 0; c < ch; c++) {
        const cell = pat[r] && pat[r][c];
        if (!cell) continue;
        const per = typeof cell.note === 'string' ? NOTE[cell.note] : cell.note || 0;
        const k = ((pi * 64 + r) * ch + c) * 4, s = cell.sample || 0;
        pats[k] = (s & 0xF0) | ((per >> 8) & 15); pats[k + 1] = per & 255;
        pats[k + 2] = ((s & 15) << 4) | ((cell.effect || 0) & 15); pats[k + 3] = cell.param || 0;
      }
    });
    return concat([head, pats, ...o.samples.map(s => new Uint8Array(s.data.buffer, s.data.byteOffset, s.data.length & ~1))]);
  }

  /**
   * PowerPacker (PP20) packing. Not as tight as the real PowerPacker, but the output follows the same
   * format, so it unpacks with the same code. `eff` are the four offset sizes in bits.
   */
  function powerPack(data, eff) {
    eff = eff || [9, 10, 11, 11];
    const n = data.length, bits = [];
    const put = (v, k) => { for (let i = k - 1; i >= 0; i--) bits.push((v >> i) & 1); };
    const maxO = (1 << Math.max(eff[0], eff[1], eff[2], eff[3], 7)) - 1;
    const emitLits = lits => {
      put(0, 1);
      let r = lits.length - 1;
      while (r >= 3) { put(3, 2); r -= 3; }
      put(r, 2);
      for (const v of lits) put(v, 8);
    };
    let pos = n, lits = [];
    while (pos > 0) {
      // Longest match: byte at q (going down from pos-1) equals the byte at q+1+o, already written.
      let bestL = 0, bestO = 0;
      for (let o = 0; o <= Math.min(maxO, n - 1 - pos); o++) {
        let L = 0;
        while (L < 200 && pos - 1 - L >= 0 && data[pos - 1 - L] === data[pos - L + o]) L++;
        let use = 0;
        if (L >= 5 && (o < 128 || o < (1 << eff[3]))) use = L;
        else for (let t = Math.min(L, 4); t >= 2; t--) if (o < (1 << eff[t - 2])) { use = t; break; }
        if (use > bestL) { bestL = use; bestO = o; }
      }
      if (bestL < 2) { lits.push(data[pos - 1]); pos--; continue; }
      if (lits.length) { emitLits(lits); lits = []; } else put(1, 1);
      if (bestL >= 5) {
        put(3, 2);
        if (bestO < 128) { put(0, 1); put(bestO, 7); } else { put(1, 1); put(bestO, eff[3]); }
        let rem = bestL - 5;
        while (rem >= 7) { put(7, 3); rem -= 7; }
        put(rem, 3);
      } else {
        put(bestL - 2, 2); put(bestO, eff[bestL - 2]);
      }
      pos -= bestL;
    }
    if (lits.length) emitLits(lits);
    const skip = (8 - bits.length % 8) % 8;
    const all = new Array(skip).fill(0).concat(bits);
    const src = new Uint8Array(all.length / 8);
    for (let i = 0; i < all.length; i++) if (all[i]) src[src.length - 1 - (i >> 3)] |= 1 << (i & 7);
    return concat([bytes('PP20'), Uint8Array.from(eff), src, Uint8Array.from([(n >> 16) & 255, (n >> 8) & 255, n & 255, skip])]);
  }

  // ---------- sample content (all original) ----------

  /** A 320 × 256, 32-colour sunset over a chequered plain. */
  function samplePicture() {
    const w = 320, h = 256, horizon = 170;
    const pal = [];
    const sky = [[16, 8, 48], [255, 120, 60]];
    for (let i = 0; i < 16; i++) { const t = i / 15; pal.push(sky[0].map((v, k) => Math.round(v + (sky[1][k] - v) * t))); }
    for (let i = 0; i < 4; i++) pal.push([255, 200 + i * 15, 80 + i * 40]);           // 16–19 sun
    for (let i = 0; i < 4; i++) pal.push([40 + i * 12, 20 + i * 8, 70 + i * 14]);      // 20–23 hills
    for (let i = 0; i < 4; i++) pal.push([30 + i * 50, 10 + i * 20, 90 + i * 40]);    // 24–27 ground dark
    for (let i = 0; i < 4; i++) pal.push([255, 90 + i * 40, 200 + i * 15]);           // 28–31 ground light
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let c;
      if (y < horizon) {
        const t = y / horizon;
        c = Math.min(15, Math.floor(t * 16 + ((x + y) & 1) * 0.5));
        const dx = x - 200, dy = y - 120;
        if (dx * dx + dy * dy < 50 * 50 && !(y > 115 && (y % 8) < (y - 112) / 8)) c = 16 + Math.min(3, Math.floor((y - 70) / 14));
        const hill = horizon - 22 - 14 * Math.sin(x / 37) - 9 * Math.sin(x / 13 + 1);
        if (y > hill) c = 20 + Math.min(3, Math.floor((y - hill) / 8));
      } else {
        const d = y - horizon + 4, z = 1200 / d, u = Math.floor(((x - 160) * z) / 600 + 100), v = Math.floor(z / 4);
        const shade = Math.min(3, Math.floor(d / 22));
        c = ((u + v) & 1) ? 28 + shade : 24 + shade;
      }
      px[y * w + x] = c;
    }
    return ilbm({ width: w, height: h, planes: 5, palette: pal, pixels: px, camg: 0x0000 });
  }

  /** Draws simple shapes into an index array. */
  function canvas(w, h) {
    const px = new Uint8Array(w * h);
    return {
      px,
      rect(x0, y0, x1, y1, c) { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (x >= 0 && y >= 0 && x < w && y < h) px[y * w + x] = c; },
      frame(x0, y0, x1, y1, c) { this.rect(x0, y0, x1, y0, c); this.rect(x0, y1, x1, y1, c); this.rect(x0, y0, x0, y1, c); this.rect(x1, y0, x1, y1, c); },
    };
  }

  /** A 2.0-style disk icon (grey, black, white, blue) with a separate "selected" image. */
  function sampleDiskIcon() {
    const w = 44, h = 22, draw = sel => {
      const c = canvas(w, h);
      c.rect(4, 1, 39, 20, sel ? 1 : 3); c.frame(4, 1, 39, 20, 1);
      c.rect(12, 1, 31, 7, 2); c.rect(25, 2, 28, 6, 1);           // shutter
      c.rect(9, 11, 34, 19, 2); c.frame(9, 11, 34, 19, 1);         // label
      for (let y = 13; y <= 17; y += 2) c.rect(12, y, 31, y, sel ? 3 : 1);
      return c.px;
    };
    return icon({ type: 1, width: w, height: h, depth: 2, image: draw(false), selected: draw(true), revision: 1 });
  }

  /** A 1.3-style project icon (blue, white, black, orange): a page with writing. */
  function sampleProjectIcon(tool, toolTypes) {
    const w = 32, h = 20, c = canvas(w, h);
    c.rect(4, 0, 25, 19, 1); c.frame(4, 0, 25, 19, 2);
    c.rect(20, 0, 25, 4, 0); c.rect(20, 0, 20, 4, 2); c.rect(20, 4, 25, 4, 2);   // folded corner
    for (let y = 6; y <= 16; y += 3) c.rect(7, y, y === 16 ? 15 : 22, y, 3);
    return icon({ type: 4, width: w, height: h, depth: 2, image: c.px, defaultTool: tool, toolTypes });
  }

  /** A falling "zap" (plain samples) and a thump (Fibonacci-delta packed). */
  function sampleZap() {
    const rate = 11025, n = Math.round(rate * 0.45), s = new Int8Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n, f = 1800 * Math.pow(200 / 1800, t);
      phase += f / rate;
      s[i] = Math.round((phase % 1 < 0.5 ? 1 : -1) * 100 * (1 - t));
    }
    return svx({ samples: s, rate, name: 'Zap' });
  }
  function sampleThump() {
    const rate = 8363, n = Math.round(rate * 0.6), s = new Int8Array(n);
    let phase = 0, seed = 7;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      phase += (120 * (1 - t) + 40) / rate;
      seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF;
      const noise = ((seed >> 16) & 255) - 128;
      s[i] = Math.max(-127, Math.min(127, Math.round((Math.sin(phase * 2 * Math.PI) * 110 + noise * 0.15) * Math.pow(1 - t, 2))));
    }
    return svx({ samples: s, rate, name: 'Thump', fibonacci: true });
  }

  /** A short original four-channel tune: Am – F – C – G, drums, bass, chords, then a melody. */
  function sampleTune() {
    const wave = (n, f) => Int8Array.from({ length: n }, (_, i) => f(i / n));
    let seed = 99;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF; return ((seed >> 16) & 255) - 128; };
    const samples = [
      { name: 'Kick', data: wave(1600, t => Math.round(Math.sin(2 * Math.PI * 30 * Math.pow(t, 0.4)) * 120 * (1 - t))), volume: 64 },
      { name: 'Hat', data: wave(500, t => Math.round(rnd() * 0.6 * Math.pow(1 - t, 3))), volume: 40 },
      { name: 'Bass', data: wave(32, t => (t < 0.5 ? 90 : -90)), volume: 48, loopStart: 0, loopLength: 32 },
      { name: 'Chord', data: wave(32, t => Math.round(100 - 200 * t)), volume: 30, loopStart: 0, loopLength: 32 },
      { name: 'Lead', data: wave(32, t => Math.round((t < 0.5 ? 4 * t - 1 : 3 - 4 * t) * 100)), volume: 50, loopStart: 0, loopLength: 32 },
      { name: 'Made with Amiga Disk', data: new Int8Array(0), volume: 0 },
      { name: 'Viewer (original tune)', data: new Int8Array(0), volume: 0 },
    ];
    const chords = [['A-1', 0x37], ['F-1', 0x47], ['C-2', 0x47], ['G-1', 0x47]];
    const melody = [
      ['E-3', 'C-3', 'A-2', 'C-3', 'E-3', null, 'D-3', 'C-3'],
      ['C-3', 'A-2', 'F-2', 'A-2', 'C-3', null, 'D-3', 'E-3'],
      ['G-3', 'E-3', 'C-3', 'E-3', 'G-3', null, 'E-3', 'D-3'],
      ['D-3', 'B-2', 'G-2', 'B-2', 'D-3', null, 'C-3', 'B-2'],
    ];
    const pattern = withMelody => {
      const rows = [];
      for (let r = 0; r < 64; r++) rows.push([null, null, null, null]);
      for (let bar = 0; bar < 4; bar++) {
        const b = bar * 16, [root, arp] = chords[bar];
        for (const r of [0, 8]) rows[b + r][0] = { note: 'C-2', sample: 1 };
        for (const r of [4, 12]) rows[b + r][0] = { note: 'C-3', sample: 2 };
        for (const r of [2, 6, 10, 14]) rows[b + r][0] = { note: 'C-3', sample: 2, effect: 0xC, param: 18 };
        for (const r of [0, 3, 6, 8, 11, 14]) rows[b + r][1] = { note: root, sample: 3, effect: 0xC, param: r % 8 ? 32 : 48 };
        if (withMelody) {
          melody[bar].forEach((n, i) => { if (n) rows[b + i * 2][3] = { note: n, sample: 5, effect: 0xC, param: 44 }; });
          rows[b][2] = { note: root.replace('1', '2'), sample: 4, effect: 0, param: arp };
          for (let r = 1; r < 16; r++) rows[b + r][2] = { effect: r < 12 ? 0 : 0xA, param: r < 12 ? arp : 0x02 };
        } else {
          rows[b][2] = { note: root.replace('1', '2'), sample: 4, effect: 0, param: arp };
          for (let r = 1; r < 16; r++) rows[b + r][2] = { effect: 0, param: arp };
        }
      }
      rows[0][3] = rows[0][3] || { effect: 0xF, param: 6 };
      return rows;
    };
    return mod({ title: 'Sunset Chequers', samples, patterns: [pattern(false), pattern(true)], order: [0, 1, 1] });
  }

  const SAMPLE_GUIDE = [
    '@database "Sample.guide"',
    '@author "Amiga Disk Viewer"',
    '@node Main "Sample disk guide"',
    '@{b}Welcome to the sample disk.@{ub}',
    '',
    'AmigaGuide was the Amiga\'s hypertext help format. Click a link:',
    '',
    '  @{" Pictures " link Pictures}   the IFF picture on this disk',
    '  @{" Sounds and music " link Sounds}',
    '  @{" Packed files " link Packed}',
    '@endnode',
    '@node Pictures "Pictures"',
    'Pics/Sunset is an IFF ILBM picture: 320 x 256 pixels, 32 colours,',
    'stored as five bitplanes and packed with ByteRun1.',
    '',
    'Back to the @{" main page " link Main}.',
    '@endnode',
    '@node Sounds "Sounds and music"',
    'Sounds/Zap and Sounds/Thump are IFF 8SVX sounds. Thump is packed with',
    'Fibonacci-delta compression. Music/Sunset.mod is a ProTracker module.',
    '',
    'Back to the @{" main page " link Main}.',
    '@endnode',
    '@node Packed "Packed files"',
    'docs/Packed.txt was packed with PowerPacker. The preview unpacks it first.',
    '',
    'Back to the @{" main page " link Main}.',
    '@endnode',
    '',
  ].join('\n');

  function samplePackedText() {
    let t = 'This text was packed with PowerPacker, which squeezes files by finding repeated runs of bytes.\n\n';
    for (let i = 1; i <= 40; i++) t += 'Line ' + i + ': packed files unpack to exactly what went in.\n';
    return powerPack(bytes(t));
  }

  return {
    iff, ilbm, svx, icon, mod, powerPack, packBits, fibPack, NOTE,
    samplePicture, sampleDiskIcon, sampleProjectIcon, sampleZap, sampleThump, sampleTune, samplePackedText, SAMPLE_GUIDE,
  };
});
