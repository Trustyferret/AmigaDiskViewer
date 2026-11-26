'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M68K = require('../src/m68k.js');
const ADF = require('../src/adf.js');

const dis = arr => M68K.disassemble(Uint8Array.from(arr), 0, arr.length).map(l => l.text);

test('standard 1.x boot code disassembles as expected', () => {
  const b = new Uint8Array(1024);
  b.set([0x44, 0x4F, 0x53, 0], 0);
  b.set(ADF.STD_BOOT_13, 12);
  const lines = M68K.disassemble(b, 12, 1024);
  assert.deepEqual(lines.slice(0, 10).map(l => l.text), [
    'lea $0026(pc),a1',
    'jsr -96(a6)',
    'tst.l d0',
    'beq.s $0022',
    'movea.l d0,a0',
    'movea.l 22(a0),a0',
    'moveq #0,d0',
    'rts',
    'moveq #-1,d0',
    'bra.s $0020',
  ]);
  assert.equal(lines[0].comment, '"dos.library"');
  assert.match(lines[1].comment, /FindResident/);
  assert.equal(lines[10].text, "dc.b 'dos.library',0");
  assert.match(lines[lines.length - 1].comment, /zero bytes to the end/);
});

test('a selection of common instructions', () => {
  assert.deepEqual(dis([0x4E, 0x71]), ['nop']);
  assert.deepEqual(dis([0x70, 0x2A]), ['moveq #42,d0']);
  assert.deepEqual(dis([0x22, 0x3C, 0x12, 0x34, 0x56, 0x78]), ['move.l #$12345678,d1']);
  assert.deepEqual(dis([0x48, 0xE7, 0xFF, 0xFE]), ['movem.l d0-d7/a0-a6,-(a7)']);
  assert.deepEqual(dis([0x4C, 0xDF, 0x7F, 0xFF]), ['movem.l (a7)+,d0-d7/a0-a6']);
  assert.deepEqual(dis([0x51, 0xC8, 0xFF, 0xFE]), ['dbra d0,$0000']);
  assert.deepEqual(dis([0x33, 0xFC, 0x7F, 0xFF, 0x00, 0xDF, 0xF0, 0x9A]), ['move.w #$7FFF,$00DFF09A']);
  assert.deepEqual(dis([0x08, 0x39, 0x00, 0x06, 0x00, 0xBF, 0xE0, 0x01]), ['btst #6,$00BFE001']);
  assert.deepEqual(dis([0xE3, 0x88]), ['lsl.l #1,d0']);
  assert.deepEqual(dis([0xD2, 0x80]), ['add.l d0,d1']);
  assert.deepEqual(dis([0xB0, 0x81]), ['cmp.l d1,d0']);
  assert.deepEqual(dis([0x4E, 0xF9, 0x00, 0x07, 0x00, 0x00]), ['jmp $00070000']);
  assert.deepEqual(dis([0x61, 0x00, 0x00, 0x10]), ['bsr.w $0012']);
  assert.deepEqual(dis([0x2C, 0x78, 0x00, 0x04]), ['movea.l $0004.w,a6']);
  assert.deepEqual(dis([0x4E, 0xAE, 0xFE, 0x38]), ['jsr -456(a6)']);
});

test('trackloader hints: I/O request fields and the ExecBase pointer', () => {
  const lines = M68K.disassemble(Uint8Array.from([0x33, 0x7C, 0x00, 0x02, 0x00, 0x1C, 0x2C, 0x79, 0x00, 0x00, 0x00, 0x04]), 0, 12);
  assert.equal(lines[0].text, 'move.w #$0002,28(a1)');
  assert.match(lines[0].comment, /io_Command/);
  assert.equal(lines[1].text, 'movea.l $00000004,a6');
  assert.match(lines[1].comment, /ExecBase/);
});

test('unknown words become dc.w and do not stop the listing', () => {
  const lines = M68K.disassemble(Uint8Array.from([0xF0, 0x00, 0x4E, 0x75]), 0, 4);
  assert.equal(lines[0].text, 'dc.w $F000');
  assert.equal(lines[1].text, 'rts');
});

test('an instruction cut off by the end of the buffer is shown as data', () => {
  const lines = M68K.disassemble(Uint8Array.from([0x22, 0x3C, 0x12, 0x34]), 0, 4);
  assert.equal(lines[0].text, 'dc.w $223C');
});

test('register lists', () => {
  assert.equal(M68K.regList(0x0003, false), 'd0-d1');
  assert.equal(M68K.regList(0x8101, false), 'd0/a0/a7');
});

test('every 16-bit opcode decodes without throwing', () => {
  const buf = new Uint8Array(12);
  for (let op = 0; op < 0x10000; op++) {
    buf[0] = op >> 8; buf[1] = op & 255;
    const lines = M68K.disassemble(buf, 0, 12);
    assert.ok(lines.length > 0);
  }
});
