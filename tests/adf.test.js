'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ADF = require('../src/adf.js');
const { buildDisk, sampleDisk } = require('../src/build-adf.js');

const { ROLE } = ADF;
const fix = (bytes, n, off = 20) => ADF.w32(bytes, n * 512 + off, ADF.blockChecksum(bytes.subarray(n * 512, n * 512 + 512), off));
const findEntry = (an, path) => an.entries.find(e => e.path === path);
const errors = an => an.problems.filter(p => p.level === 'error');

test('geometry: DD, HD, extended cylinders, and bad sizes', () => {
  assert.equal(ADF.geometry(901120).blocks, 1760);
  assert.equal(ADF.geometry(901120).root, 880);
  assert.equal(ADF.geometry(1802240).blocks, 3520);
  assert.equal(ADF.geometry(1802240).root, 1760);
  assert.equal(ADF.geometry(82 * 11264).cylinders, 82);
  assert.equal(ADF.geometry(82 * 11264).root, 880);
  assert.equal(ADF.geometry(1000), null);
});

test('location: block number to cylinder/head/sector', () => {
  const geo = ADF.geometry(901120);
  assert.deepEqual(ADF.location(0, geo), { cylinder: 0, head: 0, sector: 0, offset: 0 });
  assert.deepEqual(ADF.location(880, geo), { cylinder: 40, head: 0, sector: 0, offset: 880 * 512 });
  assert.deepEqual(ADF.location(11 + 5, geo), { cylinder: 0, head: 1, sector: 5, offset: 16 * 512 });
});

test('boot checksum matches the well-known value for a standard OFS install', () => {
  const b = new Uint8Array(1024);
  b.set([0x44, 0x4F, 0x53, 0], 0);
  ADF.w32(b, 8, 880);
  b.set(ADF.STD_BOOT_13, 12);
  assert.equal(ADF.bootChecksum(b), 0xC0200F19);
});

test('hashName and protection bits', () => {
  assert.equal(ADF.hashName('c', false), ADF.hashName('C', false));
  assert.ok(ADF.hashName('Startup-Sequence', false) < 72);
  // é (0xE9) folds to É (0xC9) only in international mode
  assert.equal(ADF.hashName('\xE9', true), ADF.hashName('\xC9', true));
  assert.notEqual(ADF.hashName('\xE9', false), ADF.hashName('\xC9', false));
  assert.equal(ADF.formatProtect(0), '----rwed');
  assert.equal(ADF.formatProtect(0x40), '-s--rwed');
  assert.equal(ADF.formatProtect(0x05), '----r-e-');
});

test('dates count from 1 January 1978', () => {
  assert.equal(ADF.amigaDate(0, 0, 0).date.toISOString(), '1978-01-01T00:00:00.000Z');
  assert.equal(ADF.formatDate(ADF.amigaDate(1, 61, 100)), '1978-01-02 01:01:02');
});

for (const ffs of [false, true]) {
  test('sample-style disk reads back cleanly (' + (ffs ? 'FFS' : 'OFS') + ')', () => {
    let big = '';
    for (let i = 0; big.length < 60000; i++) big += 'row ' + i + '\n';
    const bytes = buildDisk({
      ffs, name: 'Test',
      entries: [
        { path: 'c', dir: true }, { path: 's', dir: true },
        { path: 's/startup-sequence', data: 'LoadWB\n' },
        { path: 'big.txt', data: big }, { path: 'empty', data: '' },
      ],
    });
    const an = ADF.analyse(bytes);
    assert.equal(an.isDosFs, true);
    assert.equal(an.fs.ffs, ffs);
    assert.equal(an.boot.checksumOk, true);
    assert.equal(an.boot.recognised, 'Standard AmigaDOS install (Kickstart 1.x)');
    assert.equal(an.root.name, 'Test');
    assert.deepEqual(an.problems, []);
    assert.equal(an.stats.files, 3);
    assert.equal(an.stats.dirs, 2);
    assert.equal(an.roles[880], ROLE.ROOT);
    assert.equal(an.roles[881], ROLE.BITMAP);

    const bigE = findEntry(an, 'big.txt');
    const per = ffs ? 512 : 488;
    assert.equal(bigE.dataBlocks.length, Math.ceil(big.length / per));
    assert.ok(bigE.blocks.some(n => an.roles[n] === ROLE.EXT), 'big file uses an extension block');
    const out = ADF.readFile(an, bytes, bigE);
    assert.equal(out.complete, true);
    assert.equal(Buffer.from(out.data).toString('latin1'), big);
    assert.equal(ADF.readFile(an, bytes, findEntry(an, 's/startup-sequence')).data.length, 7);
    assert.equal(ADF.readFile(an, bytes, findEntry(an, 'empty')).data.length, 0);

    // used + free covers the disk, and counts match the bitmap
    const free = an.roles.filter(r => r === ROLE.FREE).length;
    assert.equal(free, an.stats.free);
  });
}

test('HD disk has its root at block 1760', () => {
  const an = ADF.analyse(buildDisk({ hd: true, ffs: true, entries: [{ path: 'x', data: 'hello' }] }));
  assert.equal(an.geo.kind, 'HD');
  assert.equal(an.rootBlock, 1760);
  assert.deepEqual(an.problems, []);
});

test('the built-in sample disk is valid', () => {
  const an = ADF.analyse(sampleDisk());
  assert.deepEqual(an.problems, []);
  assert.ok(findEntry(an, 'docs/Story.txt').size > 35000);
});

test('a hash chain that loops back on itself is reported, not followed forever', () => {
  const bytes = buildDisk({ entries: [{ path: 'a', data: 'x' }] });
  const an0 = ADF.analyse(bytes);
  const h = findEntry(an0, 'a').block;
  ADF.w32(bytes, h * 512 + 496, h);   // next-in-chain points at itself
  fix(bytes, h);
  const an = ADF.analyse(bytes);
  assert.ok(errors(an).some(p => /second time/.test(p.message)));
});

test('pointers outside the disk and broken checksums are reported', () => {
  const bytes = buildDisk({ entries: [{ path: 'a', data: 'x'.repeat(2000) }] });
  const h = findEntry(ADF.analyse(bytes), 'a').block;
  ADF.w32(bytes, h * 512 + 308, 99999);   // first data block pointer
  const an = ADF.analyse(bytes);   // checksum deliberately not fixed
  assert.ok(errors(an).some(p => /outside the disk/.test(p.message)));
  assert.ok(errors(an).some(p => /checksum is wrong/.test(p.message)));
  const out = ADF.readFile(an, bytes, findEntry(an, 'a'));
  assert.equal(out.complete, false);
});

test('a block shared by two files is reported', () => {
  const bytes = buildDisk({ entries: [{ path: 'a', data: 'one' }, { path: 'b', data: 'two' }] });
  const an0 = ADF.analyse(bytes);
  const a = findEntry(an0, 'a'), b = findEntry(an0, 'b');
  ADF.w32(bytes, b.block * 512 + 308, a.dataBlocks[0]);
  fix(bytes, b.block);
  const an = ADF.analyse(bytes);
  assert.ok(errors(an).some(p => /used twice/.test(p.message)));
});

test('bitmap disagreements: in use but marked free, and used with no owner', () => {
  const bytes = buildDisk({ entries: [{ path: 'a', data: 'x' }] });
  const an0 = ADF.analyse(bytes);
  const d = findEntry(an0, 'a').dataBlocks[0];
  const setFree = (n, on) => {
    const idx = n - 2, off = 881 * 512 + 4 + (idx >> 5) * 4;
    let v = ADF.u32(bytes, off);
    v = on ? v | (1 << (idx & 31)) : v & ~(1 << (idx & 31));
    ADF.w32(bytes, off, v >>> 0);
  };
  setFree(d, true);
  setFree(1700, false);
  fix(bytes, 881, 0);
  const an = ADF.analyse(bytes);
  assert.ok(errors(an).some(p => /bitmap says they are free/.test(p.message)));
  assert.equal(an.roles[1700], ROLE.ORPHAN);
});

test('non-DOS disk: boot block decoded, the rest shown as raw or empty', () => {
  const bytes = new Uint8Array(901120);
  bytes.set([0x12, 0x34, 0x56, 0x78], 0);
  bytes.fill(0xAA, 5000, 6000);
  const an = ADF.analyse(bytes);
  assert.equal(an.boot.isDos, false);
  assert.equal(an.isDosFs, false);
  assert.equal(an.roles[5000 >> 9], ROLE.RAW);
  assert.equal(an.roles[100], ROLE.EMPTY);
  assert.equal(an.boot.typeText, '$12345678');
});

test('DOS boot block with a broken root block is reported and not walked', () => {
  const bytes = buildDisk({ entries: [] });
  bytes.fill(0, 880 * 512, 881 * 512);
  const an = ADF.analyse(bytes);
  assert.equal(an.isDosFs, false);
  assert.ok(an.problems.some(p => p.level === 'warning' && /is not a root block/.test(p.message)));
});

test('a few stray bytes after the last block are ignored with a note', () => {
  const disk = buildDisk({ entries: [{ path: 'a', data: 'x' }] });
  const longer = new Uint8Array(disk.length + 1);
  longer.set(disk);
  const an = ADF.analyse(longer);
  assert.equal(an.isDosFs, true);
  assert.deepEqual(an.problems.map(p => p.level), ['info']);
});

test('bad image sizes and extended ADFs give a clear error', () => {
  assert.match(ADF.analyse(new Uint8Array(1234)).error, /Not a standard ADF/);
  const ext = new Uint8Array(2000);
  ext.set(Buffer.from('UAE-1ADF'), 0);
  assert.match(ADF.analyse(ext).error, /extended ADF/);
});

test('describeBlock labels fields and checks checksums', () => {
  const bytes = sampleDisk();
  const an = ADF.analyse(bytes);
  const root = ADF.describeBlock(an, bytes, 880);
  assert.equal(root.title, 'Root block');
  assert.equal(root.checksum.ok, true);
  assert.ok(root.fields.some(f => f.name === 'Disk name' && f.value.includes('Sample Disk')));
  const boot = ADF.describeBlock(an, bytes, 0);
  assert.equal(boot.checksum.boot, true);
  const story = findEntry(an, 'docs/Story.txt');
  const hdr = ADF.describeBlock(an, bytes, story.block);
  assert.ok(hdr.fields.some(f => f.name === 'Data block #1' && f.ptr === story.dataBlocks[0]));
  const data = ADF.describeBlock(an, bytes, story.dataBlocks[1]);
  assert.ok(data.fields.some(f => f.name === 'Sequence number' && f.value === '2'));
  // fields never overlap and stay inside the block
  for (const n of [0, 1, 880, 881, story.block, story.dataBlocks[0]]) {
    const fs = ADF.describeBlock(an, bytes, n).fields;
    for (let i = 0; i < fs.length; i++) {
      assert.ok(fs[i].off + fs[i].len <= 512, 'field inside block ' + n + ': ' + fs[i].name);
      if (i) assert.ok(fs[i].off >= fs[i - 1].off + fs[i - 1].len, 'no overlap in block ' + n + ': ' + fs[i].name);
    }
  }
});
