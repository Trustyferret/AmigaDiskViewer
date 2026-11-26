'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ADF = require('../src/adf.js');
const { EditSession, copyName } = require('../src/edit.js');
const { sampleDisk } = require('../src/build-adf.js');

test('editing never touches the original buffer', () => {
  const orig = sampleDisk();
  const before = orig[100];
  const s = new EditSession(orig);
  s.setByte(100, before ^ 0xFF);
  assert.equal(orig[100], before);
  assert.equal(s.isChanged(100), true);
  assert.equal(s.changedCount(), 1);
  s.revertAll();
  assert.equal(s.changedCount(), 0);
  assert.throws(() => s.setByte(-1, 0), RangeError);
});

test('fixing the boot checksum makes it valid again', () => {
  const s = new EditSession(sampleDisk());
  s.setByte(40, 0x99);
  assert.equal(ADF.parseBoot(s.bytes).checksumOk, false);
  s.fixBootChecksum();
  assert.equal(ADF.parseBoot(s.bytes).checksumOk, true);
});

test('fixing a block checksum makes it valid again (normal and bitmap)', () => {
  const s = new EditSession(sampleDisk());
  s.setByte(880 * 512 + 433, 0x41);      // change a letter of the disk name
  s.setByte(881 * 512 + 300, 0x00);      // change a bitmap long
  let an = ADF.analyse(s.bytes);
  assert.ok(an.problems.some(p => /Root block checksum/.test(p.message)));
  s.fixBlockChecksum(880, 20);
  s.fixBlockChecksum(881, 0);
  an = ADF.analyse(s.bytes);
  assert.ok(!an.problems.some(p => /checksum/.test(p.message)), JSON.stringify(an.problems));
  assert.equal(an.root.name[0], 'A');
});

test('save-as-copy names', () => {
  assert.equal(copyName('Game (Disk 1 of 2).adf'), 'Game (Disk 1 of 2)-edited.adf');
  assert.equal(copyName('Game.ADZ'), 'Game-edited.adf');
  assert.equal(copyName('x.adf.gz'), 'x-edited.adf');
  assert.equal(copyName(''), 'disk-edited.adf');
});
