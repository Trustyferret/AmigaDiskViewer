'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Preview = require('../src/preview.js');
const ModPlayer = require('../src/modplayer.js');
const F = require('../src/build-files.js');
const ADF = require('../src/adf.js');
const { sampleDisk } = require('../src/build-adf.js');

const bytes = s => Uint8Array.from(s, c => c.charCodeAt(0) & 255);
function rng(seed) { return () => { seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF; return seed >> 16; }; }

test('text: Amiga style codes are removed and line endings tidied', () => {
  const r = Preview.decode(bytes('\x9B1mTitle\x9B0m\r\nsecond line\x1B[33m!\n\0\0\0'));
  assert.equal(r.kind, 'text');
  assert.equal(r.text, 'Title\nsecond line!\n');
  assert.equal(Preview.identify(bytes('hello\n')).kind, 'text');
});

test('binary data is not mistaken for text', () => {
  const b = new Uint8Array(300).map((_, i) => (i * 73) & 255);
  assert.equal(Preview.identify(b), null);
  assert.equal(Preview.decode(b).kind, 'none');
  assert.equal(Preview.decode(new Uint8Array(0)).label, 'Empty file');
});

test('AmigaGuide: pages, links and styles', () => {
  const r = Preview.decode(bytes(F.SAMPLE_GUIDE));
  assert.equal(r.label, 'AmigaGuide document');
  const g = r.guide;
  assert.deepEqual(g.nodes.map(n => n.name), ['Main', 'Pictures', 'Sounds', 'Packed']);
  const main = g.nodes[0];
  assert.equal(main.title, 'Sample disk guide');
  assert.deepEqual(main.lines[0], [{ t: 'Welcome to the sample disk.', b: true, i: false, u: false }]);
  const links = main.lines.flat().filter(s => s.link);
  assert.deepEqual(links.map(s => [s.t, s.link]), [[' Pictures ', 'Pictures'], [' Sounds and music ', 'Sounds'], [' Packed files ', 'Packed']]);
  // escapes and links to other files
  const g2 = Preview.parseGuide('@database x\n@node a\nmail \\@ home @{"other" link other.guide/main 0}\n@endnode');
  assert.equal(g2.nodes[0].lines[0][0].t, 'mail @ home ');
  assert.equal(g2.nodes[0].lines[0][1].external, true);
});

test('ByteRun1 packing round-trips', () => {
  const r = rng(5);
  for (let t = 0; t < 50; t++) {
    const row = Uint8Array.from({ length: 1 + (r() % 300) }, () => (r() % 4 ? r() % 3 : r() & 255));
    const packed = Uint8Array.from(F.packBits(row));
    const back = Preview.byteRun1(packed, 0, packed.length, row.length);
    assert.equal(back.filled, row.length);
    assert.deepEqual(back.data, row);
  }
});

test('IFF picture: size, colours and pixels', () => {
  const pal = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]];
  const px = Uint8Array.from({ length: 20 * 3 }, (_, i) => i % 4);
  for (const compress of [true, false]) {
    const r = Preview.decode(F.ilbm({ width: 20, height: 3, planes: 2, palette: pal, pixels: px, compress }));
    assert.equal(r.kind, 'image');
    assert.equal(r.width, 20); assert.equal(r.height, 3);
    for (let i = 0; i < px.length; i++) assert.deepEqual(Array.from(r.rgba.subarray(i * 4, i * 4 + 4)), [...pal[px[i]], 255], 'pixel ' + i);
    assert.ok(r.details.includes(compress ? 'ByteRun1 packed' : 'not packed'));
  }
});

test('IFF picture: ACBM stores each bitplane whole', () => {
  const w = 16, h = 2, px = Array.from({ length: w * h }, (_, i) => (i * 5) % 4);
  const abit = new Uint8Array(2 * 2 * h);   // 2 planes × h rows × 2 bytes
  for (let p = 0; p < 2; p++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if ((px[y * w + x] >> p) & 1) abit[(p * h + y) * 2 + (x >> 3)] |= 0x80 >> (x & 7);
  }
  const bmhd = [0, w, 0, h, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 10, 11, 0, w, 0, h];
  const pal = [[0, 0, 0], [10, 20, 30], [40, 50, 60], [70, 80, 90]];
  const r = Preview.decode(F.iff('ACBM', [['BMHD', bmhd], ['CMAP', pal.flat()], ['ABIT', abit]]));
  assert.equal(r.label, 'IFF picture (ACBM)');
  for (let i = 0; i < px.length; i++) assert.deepEqual(Array.from(r.rgba.subarray(i * 4, i * 4 + 3)), pal[px[i]], 'pixel ' + i);
});

test('IFF picture: HAM and Extra Half-Brite', () => {
  const pal = Array.from({ length: 16 }, (_, i) => [i * 17, 0, 0]);
  // HAM6: palette colour 3, then set blue to 15, then set green to 8
  const ham = Preview.decode(F.ilbm({ width: 3, height: 1, planes: 6, palette: pal, pixels: [3, 0x10 | 15, 0x30 | 8], camg: 0x800 }));
  assert.ok(ham.details.some(d => /Hold-And-Modify/.test(d)));
  assert.deepEqual(Array.from(ham.rgba.subarray(0, 12)), [51, 0, 0, 255, 51, 0, 255, 255, 51, 136, 255, 255]);
  const pal32 = Array.from({ length: 32 }, () => [200, 100, 50]);
  const ehb = Preview.decode(F.ilbm({ width: 2, height: 1, planes: 6, palette: pal32, pixels: [1, 33], camg: 0x80 }));
  assert.deepEqual(Array.from(ehb.rgba.subarray(0, 8)), [200, 100, 50, 255, 100, 50, 25, 255]);
});

test('IFF picture: damage is reported, not thrown', () => {
  const good = F.samplePicture();
  const cut = Preview.decode(good.subarray(0, 3000));
  assert.equal(cut.kind, 'image');
  assert.ok(cut.notes.some(n => /ends early/.test(n)));
  const noBody = F.iff('ILBM', [['BMHD', new Uint8Array(20)]]);
  assert.equal(Preview.decode(noBody).kind, 'none');
  assert.match(Preview.decode(F.iff('SMUS', [['SHDR', [0, 0, 0, 0]]])).label, /IFF file \(SMUS\)/);
});

test('8SVX sounds, plain and Fibonacci-delta packed', () => {
  const s = Int8Array.from({ length: 200 }, (_, i) => Math.round(Math.sin(i / 5) * 60));
  const plain = Preview.decode(F.svx({ samples: s, rate: 8000, name: 'Wave', loopStart: 100, loopLength: 100 }));
  assert.equal(plain.kind, 'sound');
  assert.equal(plain.rate, 8000); assert.equal(plain.name, 'Wave');
  assert.deepEqual(Array.from(plain.samples), Array.from(s));
  assert.equal(plain.loopStart, 100); assert.equal(plain.loopLength, 100);
  const fib = Preview.decode(F.svx({ samples: s, rate: 8000, fibonacci: true }));
  assert.equal(fib.samples.length, 200);
  for (let i = 0; i < 200; i++) assert.ok(Math.abs(fib.samples[i] - s[i]) <= 4, 'sample ' + i);
});

test('Workbench icons: images, type, default tool and tool types', () => {
  const r = Preview.decode(F.sampleProjectIcon('SYS:Utilities/More', ['FILETYPE=TEXT', 'DONOTWAIT']));
  assert.equal(r.kind, 'icon');
  assert.equal(r.iconType, 'Project (document)');
  assert.equal(r.images.length, 1);
  assert.equal(r.images[0].width, 32); assert.equal(r.images[0].depth, 2);
  assert.equal(r.defaultTool, 'SYS:Utilities/More');
  assert.deepEqual(r.toolTypes, ['FILETYPE=TEXT', 'DONOTWAIT']);
  assert.equal(r.suggested, 'wb13');
  const disk = Preview.decode(F.sampleDiskIcon());
  assert.equal(disk.iconType, 'Disk'); assert.equal(disk.images.length, 2); assert.equal(disk.suggested, 'wb20');
  // a cut-off icon still shows what it can
  const cut = Preview.decode(F.sampleProjectIcon('SYS:Utilities/More', ['A=1']).subarray(0, 270));
  assert.equal(cut.kind, 'icon');
  assert.ok(cut.notes.some(n => /ends early/.test(n)));
});

test('ProTracker modules: header, instruments and patterns', () => {
  const r = Preview.decode(F.sampleTune());
  assert.equal(r.kind, 'music');
  assert.equal(r.title, 'Sunset Chequers');
  assert.equal(r.channels, 4); assert.equal(r.songLength, 3); assert.equal(r.numPatterns, 2);
  assert.equal(r.samples[0].name, 'Kick'); assert.equal(r.samples[0].data.length, 1600);
  assert.equal(r.samples[2].loopLength, 32);
  const c = ModPlayer.cell(r, 0, 0, 0);
  assert.deepEqual(c, { sample: 1, period: 428, effect: 0, param: 0 });
  assert.equal(ModPlayer.noteName(428), 'C-2');
  const cut = Preview.decode(F.sampleTune().subarray(0, 2000));
  assert.equal(cut.kind, 'music');
  assert.ok(cut.notes.length >= 1);
});

test('PowerPacker: packed files unpack to exactly what went in', () => {
  const r = rng(11);
  const inputs = [
    bytes('a'), bytes('abababababababababababababab'), bytes(F.SAMPLE_GUIDE),
    Uint8Array.from({ length: 3000 }, () => r() & 255),
    Uint8Array.from({ length: 5000 }, (_, i) => (i % 97 < 60 ? 0 : r() & 3)),
  ];
  for (const data of inputs) {
    for (const eff of [[9, 10, 11, 11], [9, 10, 12, 13]]) {
      const packed = F.powerPack(data, eff);
      const u = Preview.unpackPowerPacker(packed);
      assert.ok(u.data, 'unpacks: ' + u.error);
      assert.deepEqual(u.data, data);
    }
  }
  assert.ok(F.powerPack(bytes('x'.repeat(4000))).length < 400, 'repeats pack to a tenth or less');
});

test('PowerPacker: the unpacked file is previewed, and damage is reported', () => {
  const r = Preview.decode(F.samplePackedText());
  assert.equal(r.kind, 'text');
  assert.equal(r.packed.format, 'PowerPacker');
  assert.ok(r.packed.unpackedSize > r.packed.packedSize);
  assert.match(r.text, /^This text was packed/);
  const pic = Preview.decode(F.powerPack(F.samplePicture()));
  assert.equal(pic.kind, 'image');
  const bad = F.samplePackedText();
  bad.fill(0xFF, 8, bad.length - 4);
  const d = Preview.decode(bad);
  assert.equal(d.kind, 'none'); assert.match(d.note, /could not be unpacked/);
  assert.match(Preview.decode(bytes('RNC\x01' + '\0'.repeat(30))).label, /Rob Northen/);
});

test('programs are named, not previewed', () => {
  const an = ADF.analyse(sampleDisk());
  const e = an.entries.find(x => x.path === 'c/Hello');
  const r = Preview.decode(ADF.readFile(an, sampleDisk(), e).data);
  assert.equal(r.label, 'Amiga program');
});

test('every file on the sample disk is recognised', () => {
  const disk = sampleDisk(), an = ADF.analyse(disk);
  assert.deepEqual(an.problems, []);
  const kinds = {};
  for (const e of an.entries.filter(x => x.kind === 'file')) kinds[e.path] = Preview.decode(ADF.readFile(an, disk, e).data).kind;
  assert.deepEqual(kinds, {
    's/Startup-Sequence': 'text', 'c/Hello': 'none', 'docs/Story.txt': 'text', 'docs/ReadMe': 'text', 'docs/ReadMe.info': 'icon',
    'docs/Sample.guide': 'text', 'docs/Packed.txt': 'text', 'Pics/Sunset': 'image', 'Sounds/Zap': 'sound', 'Sounds/Thump': 'sound',
    'Music/Sunset.mod': 'music', 'Disk.info': 'icon',
  });
});

test('random and damaged data never throws', () => {
  const r = rng(3);
  const seeds = [F.samplePicture(), F.sampleZap(), F.sampleDiskIcon(), F.sampleTune(), F.samplePackedText(), bytes(F.SAMPLE_GUIDE)];
  for (let t = 0; t < 400; t++) {
    const base = seeds[t % seeds.length];
    const b = base.slice(0, 1 + (r() % base.length));
    for (let k = r() % 20; k > 0; k--) b[r() % b.length] = r() & 255;
    const out = Preview.decode(b);
    assert.ok(out && typeof out.kind === 'string');
    Preview.identify(b);
  }
});

// ---------- the music player ----------

function render(mod, seconds, rate) {
  const p = ModPlayer.create(mod, rate), n = Math.round(seconds * rate);
  const L = new Float32Array(n), R = new Float32Array(n);
  p.render(L, R, n);
  return { L, R, p };
}

test('player: a looped square wave plays at the right pitch', () => {
  const sq = Int8Array.from({ length: 32 }, (_, i) => (i < 16 ? 100 : -100));
  const pat = Array.from({ length: 64 }, () => [null, null, null, null]);
  pat[0][0] = { note: 'C-2', sample: 1 };
  const mod = Preview.decode(F.mod({ title: 't', samples: [{ name: 'sq', data: sq, loopStart: 0, loopLength: 32 }], patterns: [pat], order: [0] }));
  const rate = 44100, { L } = render(mod, 1, rate);
  let crossings = 0;
  for (let i = 1; i < L.length; i++) if ((L[i - 1] < 0) !== (L[i] < 0)) crossings++;
  const hz = crossings / 2, expected = 3546895 / 428 / 32;   // about 259 Hz
  assert.ok(Math.abs(hz - expected) < 3, 'pitch ' + hz + ' Hz, expected ' + expected.toFixed(1));
});

test('player: song length, speed changes, pattern break and position jump', () => {
  const tune = Preview.decode(F.sampleTune());
  assert.ok(Math.abs(ModPlayer.duration(tune) - 3 * 64 * 6 * 0.02) < 0.05);
  const pat = () => Array.from({ length: 64 }, () => [null, null, null, null]);
  const p0 = pat(); p0[0][0] = { effect: 0xF, param: 3 }; p0[1][0] = { effect: 0xD, param: 0x10 };   // speed 3, break to row 10
  const p1 = pat(); p1[20][0] = { effect: 0xB, param: 0 };                                          // jump back to the start
  const m = Preview.decode(F.mod({ title: 'x', samples: [], patterns: [p0, p1], order: [0, 1] }));
  // 2 rows of pattern 0 at speed 3, then rows 10–20 of pattern 1 (11 rows) at speed 3
  assert.ok(Math.abs(ModPlayer.duration(m) - 13 * 3 * 0.02) < 0.01, 'duration ' + ModPlayer.duration(m));
});

test('player: the sample tune makes sound, and random patterns never throw', () => {
  const tune = Preview.decode(F.sampleTune());
  const { L, R, p } = render(tune, 3, 22050);
  let peak = 0;
  for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  assert.ok(peak > 0.05 && peak <= 1, 'peak ' + peak);
  assert.equal(p.position().order, 0);
  const r = rng(9);
  for (let t = 0; t < 30; t++) {
    const m = Preview.decode(F.sampleTune());
    for (let i = 0; i < m.patterns.length; i++) if (r() % 3 === 0) m.patterns[i] = r() & 255;
    render(m, 2, 8000);
    ModPlayer.duration(m);
  }
});
