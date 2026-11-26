#!/usr/bin/env node
/*
 * scan.js — read every .adf/.adz under a folder (read-only) and report what the parser makes of them.
 * Used to check the viewer against a real collection. It never writes to the images.
 *
 *   node tools/scan.js "E:\Games\ROMs\Commodore Amiga"
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ADF = require('../src/adf.js');
const M68K = require('../src/m68k.js');

const dir = process.argv[2];
if (!dir) { console.error('Usage: node tools/scan.js <folder>'); process.exit(2); }

function* walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(adf|adz)$/i.test(e.name)) yield p;
  }
}

const tally = {};
const count = (group, key) => { tally[group] = tally[group] || {}; tally[group][key] = (tally[group][key] || 0) + 1; };
const crashes = [], examples = {};
const example = (key, file) => { (examples[key] = examples[key] || []).length < 3 && examples[key].push(path.basename(file)); };
let total = 0, files = 0, extracted = 0, incomplete = 0;
const started = Date.now();

for (const file of walk(dir)) {
  total++;
  try {
    let bytes = fs.readFileSync(file);
    if (bytes[0] === 0x1F && bytes[1] === 0x8B) bytes = zlib.gunzipSync(bytes);
    bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
    const an = ADF.analyse(bytes);
    if (an.error) { count('Unreadable', an.error.slice(0, 60)); example('err:' + an.error.slice(0, 60), file); continue; }
    count('Disk size', an.geo.kind + ' ' + an.geo.cylinders + ' cyl');
    count('Boot type', an.boot.isDos ? an.boot.typeText + ' ' + an.boot.fs.name : 'NDOS');
    count('Boot checksum', an.boot.checksumOk ? 'valid' : 'wrong');
    count('Boot code', an.boot.recognised);
    count('File system readable', an.isDosFs ? 'yes' : 'no');
    M68K.disassemble(bytes.subarray(0, 1024), 12, 1024);
    for (let n = 0; n < an.geo.blocks; n++) ADF.describeBlock(an, bytes, n);
    const worst = an.problems.some(p => p.level === 'error') ? 'has errors' : an.problems.some(p => p.level === 'warning') ? 'has warnings' : an.problems.length ? 'info only' : 'clean';
    if (an.isDosFs) { count('DOS disks', worst); if (worst === 'has errors') example('errors', file); }
    for (const e of an.entries) {
      if (e.kind !== 'file' || !e.dataBlocks) continue;
      files++;
      const r = ADF.readFile(an, bytes, e);
      if (r.complete) extracted++; else incomplete++;
    }
  } catch (err) {
    crashes.push(file + ': ' + (err && err.stack || err));
  }
}

console.log('Scanned ' + total + ' images in ' + ((Date.now() - started) / 1000).toFixed(1) + ' s\n');
for (const [group, m] of Object.entries(tally)) {
  console.log(group);
  for (const [k, v] of Object.entries(m).sort((a, b) => b[1] - a[1])) console.log('  ' + String(v).padStart(5) + '  ' + k);
}
console.log('\nFiles found on DOS disks: ' + files + ' (' + extracted + ' read back completely, ' + incomplete + ' incomplete)');
for (const [k, v] of Object.entries(examples)) console.log('Example (' + k + '): ' + v.join(' | '));
console.log('\nCrashes: ' + crashes.length);
crashes.slice(0, 20).forEach(c => console.log('  ' + c));
process.exit(crashes.length ? 1 : 0);
