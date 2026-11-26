/*
 * edit.js — small edits to a disk image held in memory. The original bytes are kept untouched
 * so changes can be highlighted and undone; saving always produces a new file.
 * Browser global: `ADFEdit`; Node: `require('./edit.js')`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./adf.js'));
  else root.ADFEdit = factory(root.ADF);
})(typeof self !== 'undefined' ? self : this, function (ADF) {
  'use strict';

  class EditSession {
    /** `original` is never modified; `bytes` is the working copy. */
    constructor(original) {
      this.original = new Uint8Array(original);
      this.bytes = new Uint8Array(original);
    }
    setByte(offset, value) {
      if (offset < 0 || offset >= this.bytes.length) throw new RangeError('Offset outside the disk');
      this.bytes[offset] = value & 255;
    }
    isChanged(offset) { return this.bytes[offset] !== this.original[offset]; }
    changedCount() {
      let n = 0;
      for (let i = 0; i < this.bytes.length; i++) if (this.bytes[i] !== this.original[i]) n++;
      return n;
    }
    revertAll() { this.bytes.set(this.original); }

    /** Write the correct boot block checksum (bytes 4–7). */
    fixBootChecksum() { ADF.w32(this.bytes, 4, ADF.bootChecksum(this.bytes)); }

    /** Write the correct checksum for block `n`, whose checksum lives at byte `csOff` (20 normally, 0 for bitmaps). */
    fixBlockChecksum(n, csOff) {
      const base = n * ADF.BSIZE;
      ADF.w32(this.bytes, base + csOff, ADF.blockChecksum(this.bytes.subarray(base, base + ADF.BSIZE), csOff));
    }
  }

  /** "Game (Disk 1).adz" → "Game (Disk 1)-edited.adf". Always saved uncompressed. */
  function copyName(name) {
    const base = (name || 'disk').replace(/\.(adz|gz)$/i, '').replace(/\.adf$/i, '');
    return base + '-edited.adf';
  }

  return { EditSession, copyName };
});
