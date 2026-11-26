/*
 * preview.js — recognises and decodes the files found on Amiga disks, for the Preview tab:
 * text (including AmigaGuide), IFF pictures (ILBM/PBM, HAM, Extra Half-Brite), IFF 8SVX sounds,
 * Workbench icons (.info), ProTracker modules, and PowerPacker (PP20) packed files.
 * Files are recognised by their contents, not their names. No DOM code here.
 *
 * Like the disk parser, nothing here trusts the data: every length and offset is range-checked,
 * and decode() never throws; anything odd becomes a note on the result.
 * Browser global: `Preview`; Node: `require('./preview.js')`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Preview = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_PIXELS = 16 * 1024 * 1024;
  const MAX_UNPACKED = 16 * 1024 * 1024;

  const u8 = (b, o) => (o >= 0 && o < b.length ? b[o] : 0);
  const u16 = (b, o) => (o >= 0 && o + 2 <= b.length ? (b[o] << 8) | b[o + 1] : 0);
  const u32 = (b, o) => (o >= 0 && o + 4 <= b.length ? ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0 : 0);
  const id4 = (b, o) => (o >= 0 && o + 4 <= b.length ? String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) : '');

  /** Bytes as a Latin-1 string (the Amiga's character set). */
  function latin1(b, from, to) {
    from = Math.max(0, from || 0); to = Math.min(b.length, to === undefined ? b.length : to);
    let s = '';
    for (let i = from; i < to; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, Math.min(to, i + 8192)));
    return s;
  }
  /** A NUL-terminated string of at most `max` bytes. */
  function cstr(b, o, max) {
    let e = o;
    while (e < o + max && e < b.length && b[e]) e++;
    return latin1(b, o, e);
  }
  const none = (label, note, extra) => Object.assign({ kind: 'none', label, note: note || '' }, extra);
  const plural = (n, w) => n.toLocaleString('en-GB') + ' ' + w + (n === 1 ? '' : 's');

  // ---------- recognising ----------

  const OTHER_PACKERS = [
    ['RNC\x01', 'Rob Northen ProPack (RNC)'], ['RNC\x02', 'Rob Northen ProPack (RNC)'],
    ['IMP!', 'Imploder'], ['ATN!', 'Imploder (ATN)'], ['CrM!', 'Crunch-Mania'], ['CrM2', 'Crunch-Mania'],
    ['Crm!', 'Crunch-Mania'], ['Crm2', 'Crunch-Mania'], ['S404', 'StoneCracker 4'], ['S403', 'StoneCracker 4'],
    ['S401', 'StoneCracker 4'], ['XPKF', 'XPK'], ['TPWM', 'Turbo Packer'], ['PX20', 'PowerPacker (encrypted)'],
  ];
  function otherPacker(b) {
    const h = id4(b, 0);
    for (const [magic, name] of OTHER_PACKERS) if (h === magic) return name;
    return null;
  }

  const MOD_SIGS = { 'M.K.': 4, 'M!K!': 4, 'M&K!': 4, 'FLT4': 4, '4CHN': 4, 'N.T.': 4, '6CHN': 6, '8CHN': 8, 'FLT8': 8, 'CD81': 8, 'OKTA': 8 };
  /** Number of channels if this is a ProTracker-style module (by its signature at byte 1080), else 0. */
  function modChannels(b) {
    if (b.length < 1084) return 0;
    const sig = id4(b, 1080);
    if (MOD_SIGS[sig]) return MOD_SIGS[sig];
    let m = /^([1-9])CHN$/.exec(sig) || /^([1-3][0-9])CH$/.exec(sig);
    return m ? +m[1] : 0;
  }

  const isIcon = b => b.length >= 78 && u16(b, 0) === 0xE310 && u16(b, 2) === 1;
  const isHunk = b => b.length >= 8 && (u32(b, 0) === 0x3F3 || u32(b, 0) === 0x3E7);

  /** Length of the text with trailing NUL padding removed, or 0 if the bytes don't look like text. */
  function textLength(b) {
    let n = b.length;
    while (n > 0 && b[n - 1] === 0) n--;
    if (!n) return 0;
    let bad = 0, printable = 0;
    for (let i = 0; i < n; i++) {
      const c = b[i];
      if (c >= 32 && c < 127) printable++;
      else if (c === 10 || c === 13 || c === 9 || c === 12 || c === 0x1B || c === 0x9B || c >= 0xA0) { /* fine */ }
      else bad++;
    }
    return bad * 50 <= n && printable * 10 >= n * 7 ? n : 0;
  }

  /**
   * Quick look at the first bytes: { kind, label } or null. kind is one of
   * text, image, icon, sound, music, packed (things the preview can show) or other.
   */
  function identify(b) {
    const h = id4(b, 0);
    if (h === 'PP20') return { kind: 'packed', label: 'PowerPacker' };
    const packer = otherPacker(b);
    if (packer) return { kind: 'other', label: packer };
    if (h === 'FORM') {
      const t = id4(b, 8);
      if (t === 'ILBM' || t === 'PBM ' || t === 'ACBM' || t === 'ANIM') return { kind: 'image', label: 'IFF picture' };
      if (t === '8SVX') return { kind: 'sound', label: 'IFF sound' };
      if (t === 'FTXT') return { kind: 'text', label: 'IFF text' };
      return { kind: 'other', label: 'IFF ' + t.trim() };
    }
    if (isIcon(b)) return { kind: 'icon', label: 'Workbench icon' };
    if (modChannels(b)) return { kind: 'music', label: 'Music module' };
    if (isHunk(b)) return { kind: 'other', label: 'Amiga program' };
    if (textLength(b)) return { kind: 'text', label: 'Text' };
    return null;
  }

  /** Decode a file for the preview. Never throws. `name` is only used in wording. */
  function decode(b, name, depth) {
    try {
      return decodeAny(b, depth || 0);
    } catch (e) {
      return none('Could not be read', 'The preview stopped on unexpected data (' + e.message + ').');
    }
  }

  function decodeAny(b, depth) {
    if (!b.length) return none('Empty file', 'This file has no contents.');
    const h = id4(b, 0);
    if (h === 'PP20') return decodePowerPacker(b, depth);
    const packer = otherPacker(b);
    if (packer) return none('Packed with ' + packer, 'The preview can only unpack PowerPacker files, so what is inside this one can\'t be shown.');
    if (h === 'FORM') return decodeIff(b);
    if (isIcon(b)) return decodeIcon(b);
    if (modChannels(b)) return decodeMod(b);
    if (isHunk(b)) return none('Amiga program', u32(b, 0) === 0x3E7 ? 'An object file (part of a program, before linking).' : 'A program (it starts with an AmigaDOS hunk header). Programs have no preview.');
    const n = textLength(b);
    if (n) return decodeText(latin1(b, 0, n));
    return none('Not recognised', 'Not a picture, sound, music, icon or text file that the preview knows. On game disks this is often data in the game\'s own format.');
  }

  // ---------- text and AmigaGuide ----------

  function cleanText(s) {
    return s
      .replace(/(?:\x1B\[|\x9B)[0-9;?]*[ -/]*[@-~]/g, '')   // ANSI / Amiga console style codes
      .replace(/\x1B./g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/\f/g, '\n');
  }

  function decodeText(raw) {
    const text = cleanText(raw);
    const lines = text.split('\n').length;
    if (/^\s*@database/i.test(text)) {
      const guide = parseGuide(text);
      if (guide.nodes.length) {
        return { kind: 'text', label: 'AmigaGuide document', text, guide, details: [plural(guide.nodes.length, 'page'), plural(lines, 'line')] };
      }
    }
    return { kind: 'text', label: 'Text', text, details: [plural(lines, 'line'), plural(raw.length, 'character')] };
  }

  /** Split the arguments of an AmigaGuide command, keeping "quoted strings" together. */
  function guideArgs(s) {
    const out = [], re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2]);
    return out;
  }

  /** One line of a node: plain text, styled text and links, as segments { t, b, i, u, link }. */
  function parseGuideLine(line, style) {
    const segs = [];
    let buf = '';
    const flush = () => { if (buf) segs.push({ t: buf, b: style.b, i: style.i, u: style.u }); buf = ''; };
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '\\' && (line[i + 1] === '@' || line[i + 1] === '\\')) { buf += line[++i]; continue; }
      if (c === '@' && line[i + 1] === '{') {
        // find the closing brace, skipping over quoted text
        let j = i + 2, q = false;
        while (j < line.length && (q || line[j] !== '}')) { if (line[j] === '"') q = !q; j++; }
        const inner = line.slice(i + 2, j);
        i = j;
        const a = guideArgs(inner);
        if (/^\s*"/.test(inner)) {
          const cmd = (a[1] || '').toLowerCase();
          flush();
          const target = cmd === 'link' || cmd === 'alink' ? a[2] || '' : '';
          segs.push({ t: a[0], b: style.b, i: style.i, u: style.u, link: target && target.indexOf('/') < 0 ? target : undefined, external: !!target && target.indexOf('/') >= 0 });
          continue;
        }
        const cmd = (a[0] || '').toLowerCase();
        if (cmd === 'b' || cmd === 'ub' || cmd === 'i' || cmd === 'ui' || cmd === 'u' || cmd === 'uu' || cmd === 'plain') {
          flush();
          if (cmd === 'plain') style.b = style.i = style.u = false;
          else style[cmd.slice(-1)] = cmd.length === 1;
        }
        continue;   // colours, fonts and other settings are left out
      }
      buf += c;
    }
    flush();
    return segs;
  }

  function parseGuide(text) {
    const nodes = [];
    let cur = null, database = '';
    for (const line of text.split('\n')) {
      const m = /^@([a-z$]+:?)\s*(.*)$/i.exec(line);
      if (m && line[1] !== '{') {
        const cmd = m[1].toLowerCase();
        if (cmd === 'node') {
          const a = guideArgs(m[2]);
          cur = { name: a[0] || 'node' + nodes.length, title: a[1] || a[0] || '', lines: [], style: { b: false, i: false, u: false } };
          nodes.push(cur);
        } else if (cmd === 'endnode') cur = null;
        else if (cmd === 'database') database = guideArgs(m[2])[0] || '';
        else if (cmd === 'title' && cur) cur.title = guideArgs(m[2])[0] || cur.title;
        continue;   // other commands (@author, @wordwrap, @index, …) are settings, not text
      }
      if (cur) cur.lines.push(parseGuideLine(line, cur.style));
    }
    for (const n of nodes) delete n.style;
    return { database, nodes };
  }

  // ---------- IFF ----------

  /** The chunks between `start` and `end`: [{ id, off, len }], lengths cut to what is really there. */
  function iffChunks(b, start, end) {
    const out = [];
    let p = start;
    while (p + 8 <= end && out.length < 20000) {
      const id = id4(b, p), len = u32(b, p + 4), off = p + 8;
      out.push({ id, off, len: Math.min(len, end - off), short: len > end - off });
      p = off + len + (len & 1);
    }
    return out;
  }

  function decodeIff(b) {
    const end = Math.min(b.length, 8 + u32(b, 4));
    const type = id4(b, 8);
    const chunks = iffChunks(b, 12, end);
    const notes = [];
    if (8 + u32(b, 4) > b.length) notes.push('The file is shorter than its IFF header says.');
    if (type === 'ILBM' || type === 'PBM ' || type === 'ACBM') return decodeIlbm(b, chunks, type, notes);
    if (type === 'ANIM') {
      const form = chunks.find(c => c.id === 'FORM' && id4(b, c.off) === 'ILBM');
      if (!form) return none('IFF animation', 'No picture frame found inside it.');
      const r = decodeIlbm(b, iffChunks(b, form.off + 4, form.off + form.len), 'ILBM', notes);
      if (r.kind === 'image') { r.label = 'IFF animation (first frame)'; r.details.push('Only the first frame is shown'); }
      return r;
    }
    if (type === '8SVX') return decode8svx(b, chunks, notes);
    if (type === 'FTXT') {
      const text = chunks.filter(c => c.id === 'CHRS').map(c => latin1(b, c.off, c.off + c.len)).join('\n');
      const r = decodeText(text);
      r.label = 'IFF text (FTXT)';
      return r;
    }
    return none('IFF file (' + type.trim() + ')', 'An IFF file of a kind the preview doesn\'t show. It contains: ' + [...new Set(chunks.map(c => c.id.trim()))].slice(0, 12).join(', ') + '.');
  }

  /** ByteRun1 (PackBits) unpacking: fills `total` bytes, or as many as the data allows. */
  function byteRun1(b, off, len, total) {
    const out = new Uint8Array(total);
    let p = off, o = 0;
    const end = Math.min(b.length, off + len);
    while (o < total && p < end) {
      const n = b[p++];
      if (n < 128) {
        const cnt = Math.min(n + 1, end - p, total - o);
        out.set(b.subarray(p, p + cnt), o); o += cnt; p += n + 1;
      } else if (n > 128) {
        if (p >= end) break;
        const v = b[p++], cnt = Math.min(257 - n, total - o);
        out.fill(v, o, o + cnt); o += cnt;
      }
    }
    return { data: out, filled: o };
  }

  function greyPalette(n) {
    const pal = [];
    for (let i = 0; i < n; i++) { const v = n > 1 ? Math.round(255 * i / (n - 1)) : 0; pal.push([v, v, v]); }
    return pal;
  }

  /**
   * ILBM: bitplanes interleaved line by line. ACBM: each bitplane stored whole, one after another (ABIT chunk).
   * PBM: one byte per pixel.
   */
  function decodeIlbm(b, chunks, type, notes) {
    const label = 'IFF picture (' + type.trim() + ')';
    const bmhd = chunks.find(c => c.id === 'BMHD');
    if (!bmhd || bmhd.len < 20) return none(label, 'The picture header (BMHD) is missing.');
    const o = bmhd.off;
    const w = u16(b, o), h = u16(b, o + 2), planes = b[o + 8], masking = b[o + 9], comp = b[o + 10];
    const xa = b[o + 14], ya = b[o + 15];
    if (!w || !h || w * h > MAX_PIXELS) return none(label, 'The picture size (' + w + ' × ' + h + ') is not usable.');
    const chunky = type === 'PBM ';
    if (chunky ? planes !== 8 : !(planes >= 1 && planes <= 8) && planes !== 24) {
      return none(label, 'Pictures with ' + planes + ' bitplanes are not supported.');
    }
    if (comp > 1) return none(label, 'This picture uses compression type ' + comp + ', which the preview doesn\'t know.');

    // Colours
    const cmap = chunks.find(c => c.id === 'CMAP');
    let pal = [];
    if (cmap) for (let i = 0; i + 2 < cmap.len; i += 3) pal.push([b[cmap.off + i], b[cmap.off + i + 1], b[cmap.off + i + 2]]);
    if (pal.length && pal.every(c => c[0] < 16 && c[1] < 16 && c[2] < 16) && pal.some(c => c[0] || c[1] || c[2])) {
      pal = pal.map(c => c.map(v => v * 17));   // old 4-bit palettes
    }
    const camgC = chunks.find(c => c.id === 'CAMG' && c.len >= 4);
    const camg = camgC ? u32(b, camgC.off) : null;
    let ham = false, ehb = false;
    if (!chunky && planes <= 8) {
      if (camg !== null) { ham = !!(camg & 0x800) && (planes === 6 || planes === 8); ehb = !!(camg & 0x80) && planes === 6; }
      else if (planes === 6) { ham = pal.length > 0 && pal.length <= 16; ehb = !ham && pal.length <= 32; }
    }
    const want = ham ? (planes === 8 ? 64 : 16) : planes <= 8 ? 1 << planes : 0;
    if (!pal.length && want) { pal = greyPalette(want); notes.push('There is no colour map, so grey shades are used.'); }
    if (ehb) for (let i = pal.length; i < 64; i++) { const s = pal[i - 32] || [0, 0, 0]; pal.push([s[0] >> 1, s[1] >> 1, s[2] >> 1]); }
    while (want && pal.length < want) pal.push([0, 0, 0]);

    // Pixels
    const acbm = type === 'ACBM';
    const body = chunks.find(c => c.id === (acbm ? 'ABIT' : 'BODY'));
    if (!body) return none(label, 'The picture has no ' + (acbm ? 'ABIT' : 'BODY') + ' (pixel data).');
    const rowBytes = chunky ? w + (w & 1) : ((w + 15) >> 4) * 2;
    const stored = chunky ? 1 : planes + (masking === 1 ? 1 : 0);
    const total = rowBytes * stored * h;
    const rowAt = acbm ? (y, p) => (p * h + y) * rowBytes : (y, p) => (y * stored + p) * rowBytes;
    let raw, filled;
    if (comp === 1 && !acbm) ({ data: raw, filled } = byteRun1(b, body.off, body.len, total));
    else { raw = new Uint8Array(total); filled = Math.min(total, body.len); raw.set(b.subarray(body.off, body.off + filled)); }
    if (filled < total) notes.push('The picture data ends early; the missing part is shown black.');

    const rgba = new Uint8ClampedArray(w * h * 4);
    const val = planes > 8 ? new Uint32Array(w) : new Uint16Array(w);
    for (let y = 0; y < h; y++) {
      if (chunky) { for (let x = 0; x < w; x++) val[x] = raw[y * rowBytes + x]; }
      else {
        val.fill(0);
        for (let p = 0; p < planes; p++) {
          const ro = rowAt(y, p);
          for (let x = 0; x < w; x++) if ((raw[ro + (x >> 3)] >> (7 - (x & 7))) & 1) val[x] |= 1 << p;
        }
      }
      let r = pal[0] ? pal[0][0] : 0, g = pal[0] ? pal[0][1] : 0, bl = pal[0] ? pal[0][2] : 0;
      for (let x = 0; x < w; x++) {
        const v = val[x];
        if (planes === 24) { r = v & 255; g = (v >> 8) & 255; bl = (v >> 16) & 255; }
        else if (ham) {
          const hi = planes === 8 ? 6 : 4, ctl = v >> hi, n = v & ((1 << hi) - 1);
          const c8 = hi === 6 ? (n << 2) | (n >> 4) : n * 17;
          if (ctl === 0) { const c = pal[n]; r = c[0]; g = c[1]; bl = c[2]; }
          else if (ctl === 1) bl = c8; else if (ctl === 2) r = c8; else g = c8;
        } else { const c = pal[v] || [0, 0, 0]; r = c[0]; g = c[1]; bl = c[2]; }
        const k = (y * w + x) * 4;
        rgba[k] = r; rgba[k + 1] = g; rgba[k + 2] = bl; rgba[k + 3] = 255;
      }
    }

    // Pixel shape: from the header if it gives one, else from the screen mode.
    let aspect = xa && ya ? xa / ya : 0;
    if (!(aspect >= 0.25 && aspect <= 4)) {
      aspect = 1;
      if (camg !== null) { const hires = camg & 0x8000, lace = camg & 4; if (hires && !lace) aspect = 0.5; else if (lace && !hires) aspect = 2; }
    }
    const colours = planes === 24 ? '16.7 million colours (24-bit)' : ham ? (planes === 8 ? '262,144 colours (HAM8)' : '4,096 colours (Hold-And-Modify)') :
      ehb ? '64 colours (Extra Half-Brite)' : (1 << planes) + ' colours';
    const mode = camg === null ? '' : [(camg & 0x8000) ? 'high resolution' : (camg & 0x20) ? 'super-high resolution' : 'low resolution', (camg & 4) ? 'interlaced' : ''].filter(Boolean).join(', ');
    const details = [w + ' × ' + h + ' pixels', colours, chunky ? 'chunky pixels (PBM)' : plural(planes, 'bitplane')];
    if (mode) details.push(mode);
    details.push(comp && !acbm ? 'ByteRun1 packed' : 'not packed');
    if (masking === 1) details.push('has a mask'); else if (masking === 2) details.push('colour ' + u16(b, o + 12) + ' is transparent');
    return { kind: 'image', label, width: w, height: h, rgba, aspect, palette: planes <= 8 ? pal.slice(0, 256) : [], details, notes };
  }

  // ---------- 8SVX ----------

  const FIB = [-34, -21, -13, -8, -5, -3, -2, -1, 0, 1, 2, 3, 5, 8, 13, 21];
  function fibonacciDelta(b, off, len) {
    const n = Math.max(0, (len - 2) * 2), out = new Int8Array(n);
    let x = (u8(b, off + 1) << 24) >> 24;
    for (let i = 0; i < n; i++) {
      const d = b[off + 2 + (i >> 1)];
      x = (((x + FIB[i & 1 ? d & 15 : d >> 4]) << 24) >> 24);
      out[i] = x;
    }
    return out;
  }

  function decode8svx(b, chunks, notes) {
    const label = 'IFF sound (8SVX)';
    const vh = chunks.find(c => c.id === 'VHDR');
    if (!vh || vh.len < 20) return none(label, 'The sound header (VHDR) is missing.');
    const o = vh.off;
    const oneShot = u32(b, o), repeat = u32(b, o + 4), rate0 = u16(b, o + 12), octaves = b[o + 14], comp = b[o + 15];
    const vol = u32(b, o + 16) / 65536;
    const body = chunks.find(c => c.id === 'BODY');
    if (!body) return none(label, 'The sound has no BODY (sample data).');
    let data;
    if (comp === 0) data = new Int8Array(b.buffer.slice(b.byteOffset + body.off, b.byteOffset + body.off + body.len));
    else if (comp === 1) data = fibonacciDelta(b, body.off, body.len);
    else return none(label, 'This sound uses compression type ' + comp + ', which the preview doesn\'t know.');
    const chan = chunks.find(c => c.id === 'CHAN' && c.len >= 4);
    const stereo = chan && u32(b, chan.off) === 6;
    if (stereo) { data = data.subarray(0, data.length >> 1); notes.push('Stereo sound: only the left channel is shown and played.'); }
    const first = oneShot + repeat;
    if (octaves > 1 && first > 0 && first < data.length) data = data.subarray(0, first);
    const rate = rate0 || 8363;
    if (!rate0) notes.push('The header gives no playback rate, so 8,363 Hz is used.');
    const text = id => { const c = chunks.find(x => x.id === id); return c ? cstr(b, c.off, c.len).trim() : ''; };
    const details = [rate.toLocaleString('en-GB') + ' Hz', plural(data.length, 'sample') + ' (' + (data.length / rate).toFixed(2) + ' s)',
      comp ? 'Fibonacci-delta packed' : 'not packed'];
    if (repeat) details.push('loops the last ' + plural(repeat, 'sample'));
    if (octaves > 1) details.push(octaves + ' octaves stored (the first is shown)');
    if (vol && vol !== 1) details.push('volume ' + Math.round(vol * 100) + '%');
    return {
      kind: 'sound', label, samples: data, rate, loopStart: repeat ? oneShot : 0, loopLength: repeat,
      name: text('NAME'), author: text('AUTH'), annotation: text('ANNO'), copyright: text('(c) '), details, notes,
    };
  }

  // ---------- Workbench icons ----------

  const ICON_TYPES = { 1: 'Disk', 2: 'Drawer (folder)', 3: 'Tool (program)', 4: 'Project (document)', 5: 'Trashcan', 6: 'Device', 7: 'Kickstart disk', 8: 'AppIcon' };
  /** Workbench 1.x colours, and 2.0+ colours (MagicWB for colours 4–7). */
  const WB13 = [[0x00, 0x55, 0xAA], [0xFF, 0xFF, 0xFF], [0x00, 0x00, 0x22], [0xFF, 0x88, 0x00], [0x00, 0x00, 0x00], [0xFF, 0x00, 0xFF], [0x00, 0xFF, 0xFF], [0xFF, 0xFF, 0xFF]];
  const WB20 = [[0xAA, 0xAA, 0xAA], [0x00, 0x00, 0x00], [0xFF, 0xFF, 0xFF], [0x66, 0x88, 0xBB], [0x7B, 0x7B, 0x7B], [0xAF, 0xAF, 0xAF], [0xAA, 0x90, 0x7C], [0xFF, 0xA9, 0x97]];

  function decodeIcon(b) {
    const label = 'Workbench icon';
    const len = b.length;
    const gadgetRender = u32(b, 22), selectRender = u32(b, 26), revision = b[47], type = b[48];
    const defTool = u32(b, 50), toolTypes = u32(b, 54), drawer = u32(b, 66), toolWin = u32(b, 70), stack = u32(b, 74);
    let p = 78 + (drawer ? 56 : 0);
    const notes = [];
    const readImage = () => {
      if (p + 20 > len) throw new Error('image header past the end');
      const w = u16(b, p + 4), h = u16(b, p + 6), depth = u16(b, p + 8), hasData = u32(b, p + 10);
      p += 20;
      if (!hasData) return null;
      const rowBytes = ((w + 15) >> 4) * 2, size = rowBytes * h * depth;
      if (!w || !h || !depth || depth > 8 || p + size > len) throw new Error('image data past the end');
      const pixels = new Uint8Array(w * h);
      for (let d = 0; d < depth; d++) {
        for (let y = 0; y < h; y++) {
          const ro = p + (d * h + y) * rowBytes;
          for (let x = 0; x < w; x++) if ((b[ro + (x >> 3)] >> (7 - (x & 7))) & 1) pixels[y * w + x] |= 1 << d;
        }
      }
      p += size;
      return { width: w, height: h, depth, pixels };
    };
    const readStr = () => {
      if (p + 4 > len) throw new Error('text past the end');
      const l = u32(b, p); p += 4;
      if (l > len - p) throw new Error('text past the end');
      const s = cstr(b, p, l); p += l;
      return s;
    };
    const images = [];
    let defaultTool = '', tools = [];
    try {
      if (gadgetRender) { const im = readImage(); if (im) images.push(im); }
      if (selectRender) { const im = readImage(); if (im) images.push(im); }
      if (defTool) defaultTool = readStr();
      if (toolTypes) {
        if (p + 4 > len) throw new Error('tool types past the end');
        const count = Math.min(1000, Math.max(0, (u32(b, p) >>> 2) - 1)); p += 4;
        for (let i = 0; i < count; i++) tools.push(readStr());
      }
      if (toolWin) readStr();
      if (drawer && revision === 1) p += 6;
    } catch (e) {
      notes.push('The icon ends early or is damaged (' + e.message + '); what could be read is shown.');
    }
    if (id4(b, p) === 'FORM' && id4(b, p + 8) === 'ICON') notes.push('It also holds colour images for AmigaOS 3.5 and later, which the preview doesn\'t show.');
    if (tools.some(t => /^IM[12]=/.test(t))) notes.push('It also holds a NewIcons colour image (the IM1=/IM2= lines), which the preview doesn\'t show.');
    if (!images.length) return none(label, 'This icon has no image.' + (notes.length ? ' ' + notes.join(' ') : ''));
    const details = [ICON_TYPES[type] || 'Type ' + type, images[0].width + ' × ' + images[0].height + ' pixels', (1 << images[0].depth) + ' colours'];
    if (images.length > 1) details.push('separate "selected" image');
    return {
      kind: 'icon', label, iconType: ICON_TYPES[type] || 'Unknown (' + type + ')', images, aspect: 0.5,
      palettes: { wb13: WB13, wb20: WB20 }, suggested: revision === 1 ? 'wb20' : 'wb13',
      defaultTool, toolTypes: tools.filter(t => !/^IM[12]=/.test(t)), stack, details, notes,
    };
  }

  // ---------- ProTracker modules ----------

  function decodeMod(b) {
    const channels = modChannels(b), notes = [];
    const samples = [];
    for (let i = 0; i < 31; i++) {
      const o = 20 + i * 30, ft = b[o + 24] & 15;
      samples.push({
        name: cstr(b, o, 22).trim(), length: u16(b, o + 22) * 2, finetune: ft > 7 ? ft - 16 : ft,
        volume: Math.min(64, b[o + 25]), loopStart: u16(b, o + 26) * 2, loopLength: u16(b, o + 28) * 2,
      });
    }
    let songLength = b[950];
    if (songLength < 1 || songLength > 128) { notes.push('The song length (' + songLength + ') is out of range; 1 is used.'); songLength = 1; }
    const order = Array.from(b.subarray(952, 1080));
    let numPatterns = 0;
    for (const v of order) numPatterns = Math.max(numPatterns, v + 1);
    const patSize = 64 * channels * 4, start = 1084;
    const fits = Math.floor((b.length - start) / patSize);
    if (fits < numPatterns) { notes.push('The file is too short for all ' + numPatterns + ' patterns; the missing ones play as silence.'); }
    const patterns = new Uint8Array(numPatterns * patSize);
    patterns.set(b.subarray(start, start + Math.min(numPatterns, fits) * patSize));
    let p = start + numPatterns * patSize, missing = 0;
    for (const s of samples) {
      const avail = Math.max(0, Math.min(s.length, b.length - p));
      s.data = new Int8Array(b.buffer.slice(b.byteOffset + Math.min(p, b.length), b.byteOffset + Math.min(p, b.length) + avail));
      if (avail < s.length) missing++;
      p += s.length;
      if (s.loopStart >= s.data.length) s.loopLength = 0;
      else s.loopLength = Math.min(s.loopLength, s.data.length - s.loopStart);
    }
    if (missing) notes.push(plural(missing, 'instrument') + ' cut short: the file ends before all the sample data.');
    const used = samples.filter(s => s.length > 0).length;
    return {
      kind: 'music', label: 'ProTracker module (' + id4(b, 1080) + ')', title: cstr(b, 0, 20).trim(), channels, songLength,
      restart: b[951] < songLength ? b[951] : 0, order: order.slice(0, songLength), numPatterns, patterns, samples,
      details: [channels + ' channels', plural(songLength, 'position'), plural(numPatterns, 'pattern'), plural(used, 'instrument')], notes,
    };
  }

  // ---------- PowerPacker ----------

  /** PowerPacker PP20 unpacking. `src` is the packed data between the 8-byte header and the 4-byte trailer. Returns null if the data is damaged. */
  function ppDecrunch(src, eff, destLen, skip) {
    const dest = new Uint8Array(destLen);
    let srcPos = src.length, out = destLen, written = 0, bitBuf = 0, bitsLeft = 0;
    const bits = n => {
      while (bitsLeft < n) {
        if (srcPos <= 0) return -1;
        bitBuf |= src[--srcPos] << bitsLeft; bitsLeft += 8;
      }
      let v = 0;
      bitsLeft -= n;
      while (n--) { v = (v << 1) | (bitBuf & 1); bitBuf >>>= 1; }
      return v;
    };
    if (bits(skip) < 0) return null;
    while (written < destLen) {
      let x = bits(1);
      if (x < 0) return null;
      if (x === 0) {
        let todo = 1;
        do { x = bits(2); if (x < 0) return null; todo += x; } while (x === 3);
        while (todo--) {
          x = bits(8);
          if (x < 0 || out <= 0) return null;
          dest[--out] = x; written++;
        }
        if (written === destLen) break;
      }
      x = bits(2);
      if (x < 0) return null;
      let offbits = eff[x], todo = x + 2, offset;
      if (x === 3) {
        x = bits(1); if (x < 0) return null;
        if (x === 0) offbits = 7;
        offset = bits(offbits); if (offset < 0) return null;
        do { x = bits(3); if (x < 0) return null; todo += x; } while (x === 7);
      } else {
        offset = bits(offbits); if (offset < 0) return null;
      }
      if (out + offset >= destLen) return null;
      while (todo--) {
        if (out <= 0) return null;
        x = dest[out + offset]; dest[--out] = x; written++;
      }
    }
    return dest;
  }

  /** Unpack a PP20 file: { data } or { error }. */
  function unpackPowerPacker(b) {
    if (b.length < 12 || id4(b, 0) !== 'PP20') return { error: 'not a PowerPacker file' };
    const n = b.length, outLen = (b[n - 4] << 16) | (b[n - 3] << 8) | b[n - 2], skip = b[n - 1];
    const eff = Array.from(b.subarray(4, 8));
    if (!outLen || outLen > MAX_UNPACKED || skip > 32 || eff.some(e => e > 16)) return { error: 'the packed header is damaged' };
    const data = ppDecrunch(b.subarray(8, n - 4), eff, outLen, skip);
    return data ? { data, efficiency: eff } : { error: 'the packed data is damaged or cut short' };
  }

  function decodePowerPacker(b, depth) {
    const r = unpackPowerPacker(b);
    const info = { format: 'PowerPacker', packedSize: b.length };
    if (r.error) return none('Packed with PowerPacker', 'It could not be unpacked: ' + r.error + '.', { packed: info });
    info.unpackedSize = r.data.length; info.data = r.data; info.efficiency = r.efficiency;
    const inner = depth < 3 ? decode(r.data, '', depth + 1) : none('Packed more than three times', 'The preview stops unpacking here.');
    inner.packed = info;
    return inner;
  }

  return { identify, decode, unpackPowerPacker, parseGuide, byteRun1, textLength, ICON_TYPES };
});
