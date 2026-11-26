/*
 * adf.js — reads Amiga floppy disk images (ADF) and works out what every block is.
 *
 * Pure functions only: nothing here touches the web page, so Node tests can load it too.
 * In the browser it becomes the global `ADF`; in Node, `require('./adf.js')`.
 *
 * All multi-byte numbers on an Amiga disk are big-endian (most significant byte first).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ADF = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BSIZE = 512;
  const HT_SIZE = 72;           // entries in a hash table / data block table
  const MAX_PROBLEMS = 300;

  // Primary block types (long at offset 0)
  const T_HEADER = 2, T_DATA = 8, T_LIST = 16, T_DIRCACHE = 33;
  // Secondary types (long at offset 508)
  const ST_ROOT = 1, ST_USERDIR = 2, ST_SOFTLINK = 3, ST_LINKDIR = 4, ST_FILE = -3, ST_LINKFILE = -4;

  // What each block is used for. The numbers index ROLES below.
  const ROLE = {
    UNKNOWN: 0, FREE: 1, BOOT: 2, ROOT: 3, BITMAP: 4, BITMAP_EXT: 5, DIR: 6, FILE: 7,
    EXT: 8, DATA: 9, DIRCACHE: 10, ORPHAN: 11, LINK: 12, EMPTY: 13, RAW: 14,
  };
  const ROLES = [
    { key: 'unknown', label: 'Unknown', about: 'Not reached from the root, and there is no bitmap to say whether it is in use.' },
    { key: 'free', label: 'Free', about: 'The bitmap says this block is free. It may still hold leftovers of deleted files.' },
    { key: 'boot', label: 'Boot block', about: 'Blocks 0 and 1: the disk type, a checksum and the code that runs when you boot from the disk.' },
    { key: 'root', label: 'Root block', about: 'The top folder of the disk: its name, dates, and a hash table pointing at the top-level files and folders.' },
    { key: 'bitmap', label: 'Bitmap', about: 'One bit per block, saying which blocks are free (1) and which are in use (0).' },
    { key: 'bitmapext', label: 'Bitmap extension', about: 'Holds more bitmap pointers on very large disks. Rare on floppies.' },
    { key: 'dir', label: 'Folder header', about: 'A folder (a "drawer" on the Amiga): its name, and a hash table of what it contains.' },
    { key: 'file', label: 'File header', about: 'A file: its name, size, protection bits, and the list of its first 72 data blocks.' },
    { key: 'ext', label: 'File extension', about: 'Lists another 72 data blocks for a file too big for its header to list alone.' },
    { key: 'data', label: 'File data', about: 'The contents of a file.' },
    { key: 'dircache', label: 'Directory cache', about: 'DCFS only: a summary of a folder\'s contents so listing it is quicker.' },
    { key: 'orphan', label: 'Used, no owner', about: 'The bitmap says this block is in use, but no file or folder points to it. Often a game\'s own data hidden on a DOS disk.' },
    { key: 'link', label: 'Link', about: 'A hard or soft link: a second name for another file or folder.' },
    { key: 'empty', label: 'Empty (all zero)', about: 'Not an AmigaDOS disk, and this block contains only zeros.' },
    { key: 'raw', label: 'Non-DOS data', about: 'Not an AmigaDOS disk: the game or demo reads these blocks with its own loader, so there is no file system to decode.' },
  ];

  // ---------- low-level helpers ----------

  function u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function i32(b, o) { return u32(b, o) | 0; }
  function u16(b, o) { return (b[o] << 8) | b[o + 1]; }
  function w32(b, o, v) { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; }
  function hex(v, digits) { return (v >>> 0).toString(16).toUpperCase().padStart(digits || 8, '0'); }

  /** Amiga strings in blocks are "BCPL" strings: a length byte, then the characters (Latin-1). */
  function bcpl(b, o, max) {
    const len = Math.min(b[o], max);
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(b[o + 1 + i]);
    return s;
  }
  function cstr(b, o, max) {
    let s = '';
    for (let i = 0; i < max && b[o + i]; i++) s += String.fromCharCode(b[o + i]);
    return s;
  }

  /** AmigaDOS dates: days since 1 Jan 1978, minutes past midnight, ticks (1/50 s) past the minute. */
  function amigaDate(days, mins, ticks) {
    const ms = Date.UTC(1978, 0, 1) + days * 86400000 + mins * 60000 + Math.floor(ticks * 20);
    return { days, mins, ticks, date: new Date(ms) };
  }
  function formatDate(d) {
    if (!d || isNaN(d.date)) return '?';
    return d.date.toISOString().replace('T', ' ').slice(0, 19);
  }

  /** Disk size → layout. DD is 11 sectors per track, HD is 22. 80 cylinders is standard; up to 84 is accepted. */
  function geometry(len) {
    for (const [kind, sectors] of [['DD', 11], ['HD', 22]]) {
      const perCyl = sectors * 2 * BSIZE;
      if (len % perCyl === 0) {
        const cylinders = len / perCyl;
        if (cylinders >= 80 && cylinders <= 84) {
          return { kind, sectors, cylinders, heads: 2, blocks: cylinders * sectors * 2, root: 80 * sectors, bytes: len };
        }
      }
    }
    return null;
  }

  /** Block number → where it sits physically: cylinder, head (side), sector. */
  function location(n, geo) {
    const track = Math.floor(n / geo.sectors);
    return { cylinder: track >> 1, head: track & 1, sector: n % geo.sectors, offset: n * BSIZE };
  }

  /** Boot block checksum: add all 256 longs (skipping the checksum itself), carrying overflow back in, then invert. */
  function bootChecksum(b) {
    let sum = 0;
    for (let i = 0; i < 1024; i += 4) {
      if (i === 4) continue;
      sum += u32(b, i);
      if (sum > 0xFFFFFFFF) sum -= 0xFFFFFFFF;   // = subtract 2^32, add the carry
    }
    return (~sum) >>> 0;
  }

  /** Normal block checksum: chosen so that all 128 longs of the block add up to 0. `blk` is one 512-byte block. */
  function blockChecksum(blk, csOff) {
    let sum = 0;
    for (let i = 0; i < BSIZE; i += 4) if (i !== csOff) sum = (sum + u32(blk, i)) >>> 0;
    return (-sum) >>> 0;
  }

  function toUpper(c, intl) {
    if (c >= 97 && c <= 122) return c - 32;
    if (intl && c >= 224 && c <= 254 && c !== 247) return c - 32;
    return c;
  }
  /** Which of the 72 hash table slots a name goes in. "International" mode also folds accented letters. */
  function hashName(name, intl) {
    let h = name.length;
    for (let i = 0; i < name.length; i++) h = (h * 13 + toUpper(name.charCodeAt(i), intl)) & 0x7FF;
    return h % HT_SIZE;
  }

  /** Protection bits, shown the way the Amiga's List command does: hsparwed. */
  function formatProtect(p) {
    let s = '';
    'hspa'.split('').forEach((ch, i) => { s += (p & (0x80 >> i)) ? ch : '-'; });
    'rwed'.split('').forEach((ch, i) => { s += (p & (0x08 >> i)) ? '-' : ch; });   // rwed are "set = NOT allowed"
    return s;
  }

  function printableRuns(b, from, to, min) {
    const out = [];
    let start = -1;
    for (let i = from; i <= to; i++) {
      const c = i < to ? b[i] : 0;
      const ok = c >= 32 && c < 127;
      if (ok && start < 0) start = i;
      if (!ok && start >= 0) {
        // Code bytes are often printable by chance ("@ h"), so keep only runs that are mostly letters and spaces.
        const text = String.fromCharCode.apply(null, b.subarray(start, i));
        const wordy = (text.match(/[A-Za-z ]/g) || []).length;
        if (text.length >= min && (text.match(/[A-Za-z]/g) || []).length >= 3 && wordy * 10 >= text.length * 6) out.push({ offset: start, text });
        start = -1;
      }
    }
    return out;
  }

  // The code a Kickstart 1.x "Install" writes (after the 12-byte header): find dos.library and return its init address.
  const STD_BOOT_13 = [
    0x43, 0xFA, 0x00, 0x18, 0x4E, 0xAE, 0xFF, 0xA0, 0x4A, 0x80, 0x67, 0x0A, 0x20, 0x40, 0x20, 0x68,
    0x00, 0x16, 0x70, 0x00, 0x4E, 0x75, 0x70, 0xFF, 0x60, 0xFA, 0x64, 0x6F, 0x73, 0x2E, 0x6C, 0x69,
    0x62, 0x72, 0x61, 0x72, 0x79, 0x00,
  ];

  function recogniseBoot(b) {
    let last = 1023;
    while (last >= 12 && b[last] === 0) last--;
    if (last < 12) return 'No boot code (all zero)';
    const code = b.subarray(12, last + 1);
    // STD_BOOT_13 ends with the 0 that terminates "dos.library"; trailing zeros were trimmed from `code`.
    if (code.length === STD_BOOT_13.length - 1 && code.every((v, i) => v === STD_BOOT_13[i])) {
      return 'Standard AmigaDOS install (Kickstart 1.x)';
    }
    const text = String.fromCharCode.apply(null, code);
    if (code.length < 120 && text.includes('dos.library') && text.includes('expansion.library')) return 'Standard AmigaDOS install (Kickstart 2.0 or later)';
    if (code.length < 120 && text.includes('dos.library')) return 'Small loader that starts AmigaDOS (close to a standard install)';
    return 'Custom boot code';
  }

  /** Decode the boot block (bytes 0–1023). */
  function parseBoot(bytes) {
    const b = bytes.subarray(0, 1024);
    const isDos = b[0] === 0x44 && b[1] === 0x4F && b[2] === 0x53;   // "DOS"
    const flags = b[3];
    const stored = u32(b, 4), expected = bootChecksum(b);
    let typeText;
    if (isDos) typeText = 'DOS\\' + flags;
    else {
      const ch = Array.from(b.subarray(0, 4));
      typeText = ch.every(c => c >= 32 && c < 127) ? String.fromCharCode.apply(null, ch) : '$' + hex(u32(b, 0));
    }
    const fs = isDos ? describeDosType(flags) : null;
    return {
      isDos, flags, typeText, fs,
      checksum: stored, expectedChecksum: expected, checksumOk: stored === expected,
      rootPointer: u32(b, 8),
      recognised: recogniseBoot(b),
      strings: printableRuns(b, 12, 1024, 4),
    };
  }

  function describeDosType(flags) {
    const ffs = (flags & 1) !== 0;
    const dircache = flags === 4 || flags === 5;
    const longNames = flags === 6 || flags === 7;
    const intl = flags >= 2;        // DOS\2..\7 all use the international name hashing
    let name = ffs ? 'FFS' : 'OFS';
    if (flags === 2 || flags === 3) name += ' International';
    if (dircache) name += ' with directory cache';
    if (longNames) name += ' with long file names (OS 3.2)';
    const full = ffs ? 'Fast File System' : 'Original (Old) File System';
    return { ffs, intl, dircache, longNames, name, full, known: flags <= 7 };
  }

  // ---------- the main analysis ----------

  /**
   * Work out the role of every block on the disk, build the file tree, and list any problems.
   * Never trusts a pointer: everything is range-checked and each block can only be claimed once,
   * so a corrupt disk with loops or cross-links cannot hang or crash it.
   */
  function analyse(bytes) {
    const res = {
      geo: geometry(bytes.length), error: null, boot: null, isDosFs: false, fs: null, rootBlock: -1, root: null,
      roles: null, owner: null, entries: [], problems: [], moreProblems: 0, bitmapFree: null, stats: null,
    };
    // Some images carry a few stray bytes on the end; read the standard part.
    if (!res.geo && bytes.length % BSIZE) res.geo = geometry(bytes.length - bytes.length % BSIZE);
    if (!res.geo) {
      const head = String.fromCharCode.apply(null, bytes.subarray(0, 8));
      res.error = head.startsWith('UAE-') ?
        'This is an "extended ADF" (raw MFM tracks, header ' + head + '). Only standard ADFs are supported.' :
        'Not a standard ADF: the size is ' + bytes.length + ' bytes, but a DD floppy is 901,120 bytes and an HD floppy 1,802,240.';
      return res;
    }
    const geo = res.geo, N = geo.blocks;
    const roles = new Uint8Array(N), owner = new Int32Array(N).fill(-1);
    res.roles = roles; res.owner = owner;
    const problems = res.problems;
    const problem = (block, level, message) => {
      if (problems.length < MAX_PROBLEMS) problems.push({ block, level, message });
      else res.moreProblems++;
    };
    if (bytes.length > geo.bytes) problem(null, 'info', 'The image has ' + (bytes.length - geo.bytes) + ' extra byte(s) after the last block. They are ignored.');
    const L = (n, o) => u32(bytes, n * BSIZE + o);
    const S = (n, o) => i32(bytes, n * BSIZE + o);
    const blk = n => bytes.subarray(n * BSIZE, (n + 1) * BSIZE);
    const csOk = (n, off) => L(n, off) === blockChecksum(blk(n), off);

    const boot = res.boot = parseBoot(bytes);
    roles[0] = roles[1] = ROLE.BOOT;
    if (!boot.checksumOk) {
      problem(0, boot.isDos ? 'warning' : 'info',
        'Boot block checksum is wrong (stored $' + hex(boot.checksum) + ', should be $' + hex(boot.expectedChecksum) + '), so the Amiga will not boot from this disk.');
    }

    const rn = geo.root;
    if (boot.isDos) {
      if (S(rn, 0) === T_HEADER && S(rn, 508) === ST_ROOT) res.isDosFs = true;
      else problem(rn, 'warning', 'The boot block starts with "DOS", but block ' + rn + ' is not a root block, so there is no file system to read. Many games do this on purpose: the disk boots like a DOS disk, then loads everything with its own trackloader.');
    }

    if (!res.isDosFs) {
      let empty = 0;
      for (let n = 2; n < N; n++) {
        const b = blk(n);
        let zero = true;
        for (let i = 0; i < BSIZE; i++) if (b[i]) { zero = false; break; }
        roles[n] = zero ? ROLE.EMPTY : ROLE.RAW;
        if (zero) empty++;
      }
      res.stats = { total: N, used: N - empty, free: empty, files: 0, dirs: 0 };
      return res;
    }

    const fs = res.fs = boot.fs;
    if (!fs.known) problem(0, 'warning', 'Unknown DOS type DOS\\' + boot.flags + '. Reading it as ' + fs.name + '.');
    if (fs.longNames) problem(0, 'warning', 'Long file name disks (DOS\\6, DOS\\7) store names differently; some names may look wrong.');
    res.rootBlock = rn;

    const entries = res.entries;
    const claim = (n, role, own, what) => {
      if (n < 2 || n >= N) { problem(null, 'error', what + ' points to block ' + n + ', which is outside the disk.'); return false; }
      if (roles[n] !== 0) { problem(n, 'error', 'Block ' + n + ' is used twice: as ' + ROLES[roles[n]].label.toLowerCase() + ' and as ' + what + '.'); return false; }
      roles[n] = role; owner[n] = own; return true;
    };
    const date = (n, o) => amigaDate(L(n, o), L(n, o + 4), L(n, o + 8));

    // Root block
    const rootEntry = {
      id: 0, kind: 'root', name: bcpl(bytes, rn * BSIZE + 432, 30), path: '', block: rn, parentId: -1,
      size: 0, protect: 0, comment: '', date: date(rn, 420), blocks: [rn], dataBlocks: [], children: [],
    };
    entries.push(rootEntry);
    claim(rn, ROLE.ROOT, 0, 'root block');
    if (!csOk(rn, 20)) problem(rn, 'error', 'Root block checksum is wrong.');
    res.root = {
      name: rootEntry.name, bitmapValid: S(rn, 312) === -1,
      altered: date(rn, 420), diskAltered: date(rn, 472), created: date(rn, 484),
    };
    if (!res.root.bitmapValid) problem(rn, 'warning', 'The bitmap is marked as not valid. AmigaDOS would rebuild it ("validate" the disk) when it is inserted.');

    // Bitmap
    const bitmapPages = [];
    for (let i = 0; i < 25; i++) {
      const p = L(rn, 316 + i * 4);
      if (!p) continue;
      if (claim(p, ROLE.BITMAP, 0, 'bitmap page ' + i)) {
        bitmapPages[i] = p;
        if (!csOk(p, 0)) problem(p, 'warning', 'Bitmap block ' + p + ' checksum is wrong.');
      }
    }
    let ext = L(rn, 416), extIndex = 25;
    while (ext && claim(ext, ROLE.BITMAP_EXT, 0, 'bitmap extension block')) {
      for (let i = 0; i < 127; i++) {
        const p = L(ext, i * 4);
        if (p && claim(p, ROLE.BITMAP, 0, 'bitmap page ' + (extIndex + i))) bitmapPages[extIndex + i] = p;
      }
      extIndex += 127;
      ext = L(ext, 508);
    }
    const BITS_PER_PAGE = 127 * 32;
    let free = null;
    if (bitmapPages.length) {
      free = new Uint8Array(N);
      for (let n = 2; n < N; n++) {
        const idx = n - 2, page = bitmapPages[Math.floor(idx / BITS_PER_PAGE)];
        if (page === undefined) continue;
        const within = idx % BITS_PER_PAGE;
        free[n] = (L(page, 4 + (within >> 5) * 4) >>> (within & 31)) & 1;
      }
    } else {
      problem(rn, 'warning', 'The root block lists no bitmap blocks, so free space cannot be shown.');
    }
    res.bitmapFree = free;

    // Walk the tree
    const per = fs.ffs ? BSIZE : BSIZE - 24;
    let fileCount = 0, dirCount = 0;
    const dirBlocks = [rn];

    function walkFile(h, e) {
      const expected = Math.ceil(e.size / per);
      const data = [], exts = [];
      let cur = h;
      while (cur) {
        if (cur !== h) {
          if (!claim(cur, ROLE.EXT, e.id, 'an extension block of "' + e.path + '"')) break;
          exts.push(cur);
          if (S(cur, 0) !== T_LIST) { problem(cur, 'error', 'Block ' + cur + ' should be an extension block of "' + e.path + '" but is not.'); break; }
          if (!csOk(cur, 20)) problem(cur, 'error', 'Extension block ' + cur + ' checksum is wrong.');
          if (L(cur, 500) !== h) problem(cur, 'warning', 'Extension block ' + cur + ' does not point back to its file header.');
        }
        const count = L(cur, 8);
        if (count > HT_SIZE) problem(cur, 'error', 'Block ' + cur + ' claims ' + count + ' data blocks; at most 72 fit.');
        for (let k = 0; k < Math.min(count, HT_SIZE); k++) {
          const d = L(cur, 308 - 4 * k);
          if (d) data.push(d); else problem(cur, 'error', 'A data block pointer of "' + e.path + '" is zero.');
        }
        cur = L(cur, 504);
      }
      const ok = [];
      for (const d of data) if (claim(d, ROLE.DATA, e.id, 'a data block of "' + e.path + '"')) ok.push(d);
      e.dataBlocks = data;
      e.blocks = [h].concat(exts, ok);
      if (data.length !== expected) {
        problem(h, 'error', '"' + e.path + '" is ' + e.size + ' bytes, so needs ' + expected + ' data blocks, but its header lists ' + data.length + '.');
      }
      if (!fs.ffs) {
        // OFS data blocks carry their own little header; check the chain is consistent.
        for (let j = 0; j < data.length; j++) {
          const d = data[j];
          if (d < 2 || d >= N) continue;
          let why = null;
          if (S(d, 0) !== T_DATA) why = 'is not an OFS data block';
          else if (L(d, 4) !== h) why = 'does not point back to its file header';
          else if (L(d, 8) !== j + 1) why = 'has sequence number ' + L(d, 8) + ' instead of ' + (j + 1);
          else if (!csOk(d, 20)) why = 'has a wrong checksum';
          else if (L(d, 16) !== (data[j + 1] || 0)) why = 'has a "next data block" pointer that does not match the header';
          if (why) { problem(d, 'error', 'Data block ' + d + ' of "' + e.path + '" ' + why + '.'); break; }
        }
      }
    }

    function walkDir(dirBlock, dirEntry) {
      for (let slot = 0; slot < HT_SIZE; slot++) {
        let p = L(dirBlock, 24 + slot * 4);
        while (p) {
          const where = '"' + (dirEntry.path || dirEntry.name + ':') + '" hash slot ' + slot;
          if (p < 2 || p >= N) { problem(dirBlock, 'error', where + ' points to block ' + p + ', outside the disk.'); break; }
          if (roles[p]) { problem(p, 'error', where + ' reaches block ' + p + ' a second time (a loop or cross-link).'); break; }
          if (S(p, 0) !== T_HEADER) { problem(p, 'error', where + ' points to block ' + p + ', which is not a header block.'); break; }
          const st = S(p, 508);
          const name = bcpl(bytes, p * BSIZE + 432, 30);
          const path = dirEntry.path ? dirEntry.path + '/' + name : name;
          const e = {
            id: entries.length, kind: 'file', name, path, block: p, parentId: dirEntry.id,
            size: 0, protect: L(p, 320), comment: bcpl(bytes, p * BSIZE + 328, 79), date: date(p, 420),
            blocks: [p], dataBlocks: [], children: [],
          };
          let role = ROLE.FILE;
          if (st === ST_USERDIR) { e.kind = 'dir'; role = ROLE.DIR; }
          else if (st === ST_FILE) { e.size = L(p, 324); }
          else if (st === ST_SOFTLINK) { e.kind = 'softlink'; e.target = cstr(bytes, p * BSIZE + 24, 288); role = ROLE.LINK; }
          else if (st === ST_LINKFILE || st === ST_LINKDIR) { e.kind = 'hardlink'; e.target = 'block ' + L(p, 468); role = ROLE.LINK; }
          else { problem(p, 'error', 'Block ' + p + ' ("' + path + '") has an unknown secondary type ' + st + '.'); }
          entries.push(e);
          dirEntry.children.push(e);
          claim(p, role, e.id, 'the header of "' + path + '"');
          if (!csOk(p, 20)) problem(p, 'error', 'Header block ' + p + ' ("' + path + '") checksum is wrong.');
          if (hashName(name, fs.intl) !== slot) problem(p, 'warning', '"' + path + '" is in hash slot ' + slot + ' but its name belongs in slot ' + hashName(name, fs.intl) + '.');
          if (L(p, 500) !== dirBlock) problem(p, 'warning', '"' + path + '" does not point back to its parent folder (block ' + dirBlock + ').');
          if (e.kind === 'dir') { dirCount++; dirBlocks.push(p); walkDir(p, e); }
          else if (e.kind === 'file' && st === ST_FILE) { fileCount++; walkFile(p, e); }
          p = L(p, 496);
        }
      }
      // Folders first, then alphabetical.
      dirEntry.children.sort((a, b) => ((b.kind === 'dir') - (a.kind === 'dir')) || a.name.localeCompare(b.name));
    }
    walkDir(rn, rootEntry);

    // Directory cache blocks (DCFS only), chained from each folder's "extension" pointer.
    if (fs.dircache) {
      for (const d of dirBlocks) {
        const own = owner[d];
        let c = L(d, 504);
        while (c && claim(c, ROLE.DIRCACHE, own, 'a directory cache block')) {
          entries[own].blocks.push(c);
          if (S(c, 0) !== T_DIRCACHE) { problem(c, 'error', 'Block ' + c + ' should be a directory cache block but is not.'); break; }
          c = L(c, 16);
        }
      }
    }

    // Compare what we found with the bitmap.
    let usedButFree = 0, firstUBF = -1, orphans = 0, firstOrphan = -1, freeCount = 0;
    for (let n = 2; n < N; n++) {
      const isFree = free ? free[n] === 1 : false;
      if (isFree) freeCount++;
      if (roles[n]) {
        if (isFree) { usedButFree++; if (firstUBF < 0) firstUBF = n; }
      } else if (!free) roles[n] = ROLE.UNKNOWN;
      else if (isFree) roles[n] = ROLE.FREE;
      else { roles[n] = ROLE.ORPHAN; orphans++; if (firstOrphan < 0) firstOrphan = n; }
    }
    if (usedButFree) problem(firstUBF, 'error', usedButFree + ' block(s) are in use but the bitmap says they are free; saving a new file could overwrite them. First: block ' + firstUBF + '.');
    if (orphans) problem(firstOrphan, 'info', orphans + ' block(s) are marked as used but no file or folder points to them. First: block ' + firstOrphan + '.');

    res.stats = { total: N, used: free ? N - freeCount : N, free: freeCount, files: fileCount, dirs: dirCount };
    return res;
  }

  /** Put a file's contents back together from its data blocks. */
  function readFile(an, bytes, e) {
    const out = new Uint8Array(e.size);
    const N = an.geo.blocks, ffs = an.fs.ffs;
    let pos = 0;
    for (const d of e.dataBlocks) {
      if (pos >= e.size || d < 2 || d >= N) break;
      const base = d * BSIZE;
      if (ffs) {
        const n = Math.min(BSIZE, e.size - pos);
        out.set(bytes.subarray(base, base + n), pos); pos += n;
      } else {
        const n = Math.min(u32(bytes, base + 12), BSIZE - 24, e.size - pos);
        out.set(bytes.subarray(base + 24, base + 24 + n), pos); pos += n;
      }
    }
    return { data: out, complete: pos === e.size };
  }

  // ---------- describing one block for the hex view ----------

  const EXPLAIN = {
    boot0: 'The boot block is the first two blocks (1,024 bytes). It starts with "DOS" and a flags byte that says which file system the disk uses. Then comes a checksum, a pointer to the root block (AmigaDOS ignores this and always uses the middle of the disk), and from byte 12 the boot code. When you boot, Kickstart loads these 1,024 bytes, checks the checksum, and runs the code with A6 holding the exec.library base and A1 an I/O request for the floppy drive.',
    boot1: 'The second half of the boot block. It holds more boot code, if there is any.',
    root: 'The root block sits in the middle of the disk (block 880 on a DD floppy) so the drive head never has far to travel. It holds the disk name and dates, a 72-slot hash table for the top-level files and folders, and pointers to the bitmap. To find a name, AmigaDOS hashes it to a slot number, then follows the chain of headers in that slot.',
    dir: 'A folder header. Like the root block it has a 72-slot hash table of its contents. It also has its own name, protection bits, comment and date, a pointer back to its parent folder, and a "hash chain" pointer to the next entry that shares its slot in the parent.',
    file: 'A file header. It holds the file name, size, protection bits, comment and date, and a table of up to 72 data block numbers, filled from the END backwards (the first data block is in the last slot). Bigger files continue in extension blocks.',
    link: 'A link: a second name for something. A soft link stores a path; a hard link points at another header block.',
    ext: 'A file extension block. It lists 72 more data block numbers for a big file (again filled from the end backwards), points back to the file header, and points on to the next extension block.',
    dataOfs: 'An OFS data block. The first 24 bytes are a small header: which file it belongs to, its sequence number, how many bytes of data it holds, and the next data block. The remaining 488 bytes are file contents. That header makes OFS slower but easier to repair.',
    dataFfs: 'An FFS data block: all 512 bytes are file contents, with no header. That is why the Fast File System is faster and holds more.',
    bitmap: 'The bitmap. After the checksum, each bit stands for one block, starting at block 2: 1 means free and 0 means in use. Within each long, the lowest bit comes first.',
    bitmapext: 'A bitmap extension block: more pointers to bitmap blocks, for disks too large for the 25 slots in the root block.',
    dircache: 'A directory cache block (DCFS). It holds a compact copy of each entry in the folder (name, size, protection, date) so the folder can be listed without reading every header.',
    free: 'This block is free according to the bitmap. Any bytes in it are leftovers, perhaps from a deleted file.',
    orphan: 'The bitmap says this block is used, but nothing in the file system points to it. Some games keep their own data like this on a normal DOS disk and read it with their own loader.',
    unknown: 'Nothing in the file system points to this block, and there is no bitmap to say whether it is in use.',
    raw: 'This disk is not an AmigaDOS disk, so these bytes have no standard structure. The program on the disk reads them with its own trackloader, usually a whole track (11 blocks) at a time.',
    empty: 'This disk is not an AmigaDOS disk, and this block is all zeros.',
  };

  /**
   * Label the fields of one block for the hex view.
   * Returns { title, explain, fields: [{off, len, name, value, group, ptr?}], checksum: {off, stored, expected, ok} | null }.
   * Groups: type, ptr, table, csum, text, date, size, code, data, flags.
   */
  function describeBlock(an, bytes, n) {
    const base = n * BSIZE;
    const L = o => u32(bytes, base + o), S = o => i32(bytes, base + o);
    const role = an.roles ? an.roles[n] : ROLE.RAW;
    const fields = [];
    const f = (off, len, name, value, group, ptr) => fields.push({ off, len, name, value: String(value), group, ptr });
    const ptr = (off, name) => { const v = L(off); f(off, 4, name, v ? 'block ' + v : '0 (none)', 'ptr', v || undefined); };
    const long = (off, name, group) => f(off, 4, name, L(off), group || 'size');
    const dateF = (off, name) => f(off, 12, name, formatDate(amigaDate(L(off), L(off + 4), L(off + 8))), 'date');
    const text = (off, max, name) => f(off, max + 1, name, '"' + bcpl(bytes, base + off, max) + '" (' + bytes[base + off] + ' chars)', 'text');
    const typeF = () => { const t = S(0); f(0, 4, 'Block type', t + ({ 2: ' (header)', 8: ' (data)', 16: ' (list / extension)', 33: ' (directory cache)' }[t] || ' (?)'), 'type'); };
    const secF = () => { const t = S(508); f(508, 4, 'Secondary type', t + ({ 1: ' (root)', 2: ' (folder)', '-3': ' (file)', 3: ' (soft link)', 4: ' (hard link to folder)', '-4': ' (hard link to file)' }[t] || ' (?)'), 'type'); };
    const table = (off, count, name, reversed) => {
      for (let i = 0; i < count; i++) {
        const o = off + i * 4, v = L(o);
        const label = reversed ? name + ' #' + (count - i) : name + '[' + i + ']';
        if (v) f(o, 4, label, 'block ' + v, 'table', v);
        else f(o, 4, label, '0', 'table');
      }
    };
    let checksum = null;
    const cs = off => { const stored = L(off), expected = blockChecksum(bytes.subarray(base, base + BSIZE), off); checksum = { off, stored, expected, ok: stored === expected }; f(off, 4, 'Checksum', '$' + hex(stored) + (stored === expected ? ' ✓' : ' ✗ should be $' + hex(expected)), 'csum'); };

    let title = ROLES[role].label, explain = '';
    const isFs = an.isDosFs;
    if (role === ROLE.BOOT && n === 0) {
      const bt = an.boot;
      f(0, 4, 'Disk type', bt.typeText + (bt.fs ? ' = ' + bt.fs.name : ' (not an AmigaDOS disk)'), 'type');
      f(4, 4, 'Boot checksum', '$' + hex(bt.checksum) + (bt.checksumOk ? ' ✓' : ' ✗ should be $' + hex(bt.expectedChecksum)), 'csum');
      checksum = { off: 4, stored: bt.checksum, expected: bt.expectedChecksum, ok: bt.checksumOk, boot: true };
      f(8, 4, 'Root block pointer', L(8), 'ptr', L(8) > 1 && an.geo && L(8) < an.geo.blocks ? L(8) : undefined);
      f(12, 500, 'Boot code', bt.recognised, 'code');
      title = 'Boot block (first half)'; explain = EXPLAIN.boot0;
    } else if (role === ROLE.BOOT) {
      f(0, 512, 'Boot code (continued)', '', 'code');
      title = 'Boot block (second half)'; explain = EXPLAIN.boot1;
    } else if (role === ROLE.ROOT) {
      typeF(); long(4, 'Header key (unused)'); long(8, 'High seq (unused)'); long(12, 'Hash table size');
      long(16, 'First data (unused)'); cs(20); table(24, HT_SIZE, 'Hash table');
      f(312, 4, 'Bitmap valid flag', S(312) === -1 ? '-1 (valid)' : S(312) + ' (not valid)', 'flags');
      for (let i = 0; i < 25; i++) { const v = L(316 + i * 4); f(316 + i * 4, 4, 'Bitmap page ' + i, v ? 'block ' + v : '0', 'ptr', v || undefined); }
      ptr(416, 'Bitmap extension');
      dateF(420, 'Root last changed'); text(432, 30, 'Disk name');
      dateF(472, 'Disk last changed'); dateF(484, 'Disk created');
      ptr(496, 'Next in hash chain (unused)'); ptr(500, 'Parent (unused)'); ptr(504, 'Directory cache / extension'); secF();
      explain = EXPLAIN.root;
    } else if (role === ROLE.DIR || role === ROLE.FILE || role === ROLE.LINK) {
      const isFile = role === ROLE.FILE;
      typeF(); ptr(4, 'Header key (this block)'); long(8, isFile ? 'Data blocks listed here' : 'High seq (unused)');
      long(12, 'Data size (unused)'); ptr(16, isFile ? 'First data block' : 'First data (unused)'); cs(20);
      if (role === ROLE.LINK && S(508) === ST_SOFTLINK) f(24, 288, 'Link target', '"' + cstr(bytes, base + 24, 288) + '"', 'text');
      else if (isFile) table(24, HT_SIZE, 'Data block', true);
      else table(24, HT_SIZE, 'Hash table');
      f(316, 4, 'Owner UID / GID', u16(bytes, base + 316) + ' / ' + u16(bytes, base + 318), 'size');
      f(320, 4, 'Protection', formatProtect(L(320)) + ' ($' + hex(L(320)) + ')', 'flags');
      if (isFile) long(324, 'File size in bytes');
      text(328, 79, 'Comment'); dateF(420, 'Last changed'); text(432, 30, 'Name');
      if (role === ROLE.LINK) ptr(468, 'Real entry (hard link target)');
      ptr(472, 'Next link'); ptr(496, 'Next in hash chain'); ptr(500, 'Parent folder');
      ptr(504, isFile ? 'First extension block' : 'Directory cache / extension'); secF();
      explain = role === ROLE.DIR ? EXPLAIN.dir : role === ROLE.FILE ? EXPLAIN.file : EXPLAIN.link;
    } else if (role === ROLE.EXT) {
      typeF(); ptr(4, 'Header key (this block)'); long(8, 'Data blocks listed here'); cs(20);
      table(24, HT_SIZE, 'Data block', true); ptr(500, 'File header'); ptr(504, 'Next extension block'); secF();
      explain = EXPLAIN.ext;
    } else if (role === ROLE.DATA && isFs && !an.fs.ffs) {
      typeF(); ptr(4, 'File header'); long(8, 'Sequence number'); long(12, 'Bytes of data here');
      ptr(16, 'Next data block'); cs(20); f(24, 488, 'File data', '', 'data');
      explain = EXPLAIN.dataOfs;
    } else if (role === ROLE.DATA) {
      f(0, 512, 'File data', '', 'data'); explain = EXPLAIN.dataFfs;
    } else if (role === ROLE.BITMAP) {
      cs(0);
      const N = an.geo.blocks;
      let freeHere = 0;
      for (let i = 0; i < 127; i++) { let v = L(4 + i * 4); while (v) { freeHere += v & 1; v >>>= 1; } }
      f(4, 508, 'Free/used bits', freeHere + ' bits set (free) for ' + (N - 2) + ' blocks', 'table');
      explain = EXPLAIN.bitmap;
    } else if (role === ROLE.BITMAP_EXT) {
      table(0, 127, 'Bitmap page'); ptr(508, 'Next extension'); explain = EXPLAIN.bitmapext;
    } else if (role === ROLE.DIRCACHE) {
      typeF(); ptr(4, 'Header key (this block)'); ptr(8, 'Parent folder'); long(12, 'Entries in this block');
      ptr(16, 'Next cache block'); cs(20); f(24, 488, 'Cached entries', '', 'data');
      explain = EXPLAIN.dircache;
    } else {
      explain = EXPLAIN[ROLES[role].key] || '';
    }
    fields.sort((a, b) => a.off - b.off);
    return { title, explain, fields, checksum, role };
  }

  return {
    BSIZE, ROLE, ROLES, T_HEADER, T_DATA, T_LIST, T_DIRCACHE, ST_ROOT, ST_USERDIR, ST_FILE, ST_SOFTLINK,
    STD_BOOT_13, EXPLAIN,
    u32, i32, w32, hex, bcpl, amigaDate, formatDate, geometry, location, bootChecksum, blockChecksum,
    hashName, formatProtect, printableRuns, parseBoot, describeDosType, recogniseBoot,
    analyse, readFile, describeBlock,
  };
});
