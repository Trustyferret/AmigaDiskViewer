/*
 * build-adf.js — writes a small, valid AmigaDOS floppy image in memory.
 * Used by the tests and by the page's "Load sample disk" button, so no real disk images are needed.
 * Browser global: `BuildADF`; Node: `require('./build-adf.js')`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./adf.js'), require('./build-files.js'));
  else root.BuildADF = factory(root.ADF, root.BuildFiles);
})(typeof self !== 'undefined' ? self : this, function (ADF, BuildFiles) {
  'use strict';
  const B = ADF.BSIZE;

  /**
   * opts: { ffs, intl, hd, name, days, entries: [{ path: 'c', dir: true } | { path: 's/startup-sequence', data: Uint8Array|string, protect, comment }] }
   * Parent folders must be listed before their contents.
   */
  function buildDisk(opts) {
    const o = Object.assign({ ffs: false, intl: false, hd: false, name: 'Empty', days: 17500, entries: [] }, opts);
    const geo = ADF.geometry(o.hd ? 1802240 : 901120);
    const N = geo.blocks, rn = geo.root, bm = rn + 1;
    const bytes = new Uint8Array(N * B);
    const W = (n, off, v) => ADF.w32(bytes, n * B + off, v);
    const R = (n, off) => ADF.u32(bytes, n * B + off);
    const putName = (n, off, s, max) => {
      s = s.slice(0, max);
      bytes[n * B + off] = s.length;
      for (let i = 0; i < s.length; i++) bytes[n * B + off + 1 + i] = s.charCodeAt(i) & 255;
    };
    const putDate = (n, off) => { W(n, off, o.days); W(n, off + 4, 720); W(n, off + 8, 0); };

    // Boot block: DOS type, standard Kickstart 1.x install code, checksum.
    bytes.set([0x44, 0x4F, 0x53, (o.ffs ? 1 : 0) | (o.intl ? 2 : 0)], 0);
    W(0, 8, rn);
    bytes.set(ADF.STD_BOOT_13, 12);
    W(0, 4, ADF.bootChecksum(bytes));

    const used = new Uint8Array(N);
    used[0] = used[1] = used[rn] = used[bm] = 1;
    let next = rn + 2;
    const alloc = () => {
      for (let tries = 0; tries < N; tries++) {
        if (next >= N) next = 2;
        if (!used[next]) { used[next] = 1; return next++; }
        next++;
      }
      throw new Error('Disk full');
    };
    const needsChecksum = [rn];

    // Root block
    W(rn, 0, ADF.T_HEADER); W(rn, 12, 72); W(rn, 312, 0xFFFFFFFF); W(rn, 316, bm);
    putDate(rn, 420); putName(rn, 432, o.name, 30); putDate(rn, 472); putDate(rn, 484);
    W(rn, 508, ADF.ST_ROOT);

    const dirs = new Map([['', rn]]);
    const per = o.ffs ? B : B - 24;
    for (const e of o.entries) {
      const cut = e.path.lastIndexOf('/');
      const parentPath = cut < 0 ? '' : e.path.slice(0, cut), name = e.path.slice(cut + 1);
      const parent = dirs.get(parentPath);
      if (parent === undefined) throw new Error('Parent folder not listed first: ' + parentPath);
      const h = alloc();
      needsChecksum.push(h);
      W(h, 0, ADF.T_HEADER); W(h, 4, h);
      W(h, 320, e.protect || 0);
      if (e.comment) putName(h, 328, e.comment, 79);
      putDate(h, 420); putName(h, 432, name, 30);
      W(h, 500, parent);
      // Link into the parent's hash table (new entries go at the head of the chain).
      const slot = ADF.hashName(name, o.intl);
      W(h, 496, R(parent, 24 + slot * 4));
      W(parent, 24 + slot * 4, h);

      if (e.dir) { W(h, 508, ADF.ST_USERDIR); dirs.set(e.path, h); continue; }

      const data = typeof e.data === 'string' ? Uint8Array.from(e.data, c => c.charCodeAt(0) & 255) : (e.data || new Uint8Array(0));
      W(h, 508, ADF.ST_FILE >>> 0); W(h, 324, data.length);
      const count = Math.ceil(data.length / per);
      const blocks = [];
      for (let k = 0; k < count; k++) blocks.push(alloc());
      // Data block table: header holds the first 72, extension blocks the rest. Filled from the end backwards.
      let holder = h;
      for (let k = 0; k < count; k += 72) {
        if (k > 0) {
          const x = alloc();
          needsChecksum.push(x);
          W(x, 0, ADF.T_LIST); W(x, 4, x); W(x, 500, h); W(x, 508, ADF.ST_FILE >>> 0);
          W(holder, 504, x);
          holder = x;
        }
        const chunk = blocks.slice(k, k + 72);
        W(holder, 8, chunk.length);
        chunk.forEach((d, i) => W(holder, 308 - 4 * i, d));
      }
      if (count) W(h, 16, blocks[0]);
      blocks.forEach((d, k) => {
        const part = data.subarray(k * per, (k + 1) * per);
        if (o.ffs) { bytes.set(part, d * B); return; }
        W(d, 0, ADF.T_DATA); W(d, 4, h); W(d, 8, k + 1); W(d, 12, part.length); W(d, 16, blocks[k + 1] || 0);
        bytes.set(part, d * B + 24);
        needsChecksum.push(d);
      });
    }

    // Bitmap: bit set = free. Bit 0 of the first long is block 2.
    for (let n = 2; n < N; n++) {
      if (used[n]) continue;
      const idx = n - 2, off = 4 + (idx >> 5) * 4;
      W(bm, off, (R(bm, off) | (1 << (idx & 31))) >>> 0);
    }
    W(bm, 0, ADF.blockChecksum(bytes.subarray(bm * B, bm * B + B), 0));
    for (const n of needsChecksum) W(n, 20, ADF.blockChecksum(bytes.subarray(n * B, n * B + B), 20));
    return bytes;
  }

  /**
   * A small disk laid out a bit like a Workbench disk, used by "Load sample disk".
   * It holds one of each file type the Preview tab shows.
   */
  function sampleDisk() {
    let story = '';
    for (let i = 1; story.length < 40000; i++) story += 'Line ' + i + ': the quick brown fox jumps over the lazy dog.\n';
    const F = BuildFiles;
    return buildDisk({
      name: 'Sample Disk',
      entries: [
        { path: 'c', dir: true },
        { path: 's', dir: true },
        { path: 'libs', dir: true },
        { path: 'devs', dir: true },
        { path: 'docs', dir: true },
        { path: 'Pics', dir: true },
        { path: 'Sounds', dir: true },
        { path: 'Music', dir: true },
        { path: 's/Startup-Sequence', data: 'echo "Hello from the sample disk"\nLoadWB\nEndCLI >NIL:\n', protect: 0x40 },
        { path: 'c/Hello', data: Uint8Array.from([0, 0, 3, 0xF3, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 3, 0xE9, 0, 0, 0, 1, 0x4E, 0x75, 0, 0, 0, 0, 3, 0xF2]), comment: 'A pretend command' },
        { path: 'docs/Story.txt', data: story, comment: 'Big enough to need an extension block' },
        { path: 'docs/ReadMe', data: '\x9B1mThe sample disk\x9B0m\n\nThis disk was made by the Amiga Disk Viewer to show how AmigaDOS lays out files.\nClick the files in Pics, Sounds and Music to preview them.\n' },
        { path: 'docs/ReadMe.info', data: F.sampleProjectIcon('SYS:Utilities/More', ['FILETYPE=TEXT']) },
        { path: 'docs/Sample.guide', data: F.SAMPLE_GUIDE },
        { path: 'docs/Packed.txt', data: F.samplePackedText(), comment: 'Packed with PowerPacker' },
        { path: 'Pics/Sunset', data: F.samplePicture() },
        { path: 'Sounds/Zap', data: F.sampleZap() },
        { path: 'Sounds/Thump', data: F.sampleThump() },
        { path: 'Music/Sunset.mod', data: F.sampleTune() },
        { path: 'Disk.info', data: F.sampleDiskIcon() },
      ],
    });
  }

  return { buildDisk, sampleDisk };
});
