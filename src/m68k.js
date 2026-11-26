/*
 * m68k.js — a small Motorola 68000 disassembler, enough to read Amiga boot block code.
 * Anything it does not recognise is shown as `dc.w $xxxx`, so it never stops on odd bytes.
 * Browser global: `M68K`; Node: `require('./m68k.js')`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.M68K = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // exec.library function offsets (called as jsr -offset(a6) with A6 = ExecBase).
  const EXEC_NAMES = ['Supervisor', 'ExitIntr', 'Schedule', 'Reschedule', 'Switch', 'Dispatch', 'Exception',
    'InitCode', 'InitStruct', 'MakeLibrary', 'MakeFunctions', 'FindResident', 'InitResident', 'Alert', 'Debug',
    'Disable', 'Enable', 'Forbid', 'Permit', 'SetSR', 'SuperState', 'UserState', 'SetIntVector', 'AddIntServer',
    'RemIntServer', 'Cause', 'Allocate', 'Deallocate', 'AllocMem', 'AllocAbs', 'FreeMem', 'AvailMem', 'AllocEntry',
    'FreeEntry', 'Insert', 'AddHead', 'AddTail', 'Remove', 'RemHead', 'RemTail', 'Enqueue', 'FindName', 'AddTask',
    'RemTask', 'FindTask', 'SetTaskPri', 'SetSignal', 'SetExcept', 'Wait', 'Signal', 'AllocSignal', 'FreeSignal',
    'AllocTrap', 'FreeTrap', 'AddPort', 'RemPort', 'PutMsg', 'GetMsg', 'ReplyMsg', 'WaitPort', 'FindPort',
    'AddLibrary', 'RemLibrary', 'OldOpenLibrary', 'CloseLibrary', 'SetFunction', 'SumLibrary', 'AddDevice',
    'RemDevice', 'OpenDevice', 'CloseDevice', 'DoIO', 'SendIO', 'CheckIO', 'WaitIO', 'AbortIO', 'AddResource',
    'RemResource', 'OpenResource', 'RawIOInit', 'RawMayGetChar', 'RawPutChar', 'RawDoFmt', 'GetCC', 'TypeOfMem',
    'Procure', 'Vacate', 'OpenLibrary', 'InitSemaphore'];
  const EXEC = {};
  EXEC_NAMES.forEach((name, i) => { EXEC[30 + i * 6] = name; });
  Object.assign(EXEC, { 636: 'CacheClearU', 642: 'CacheClearE', 648: 'CacheControl', 726: 'ColdReboot' });

  // Fields of the trackdisk IOStdReq that Kickstart passes to boot code in A1.
  const IOREQ = { 20: 'io_Device', 24: 'io_Unit', 28: 'io_Command', 30: 'io_Flags', 31: 'io_Error', 32: 'io_Actual', 36: 'io_Length', 40: 'io_Data', 44: 'io_Offset' };

  const SZ = ['b', 'w', 'l'];
  const CC = ['t', 'f', 'hi', 'ls', 'cc', 'cs', 'ne', 'eq', 'vc', 'vs', 'pl', 'mi', 'ge', 'lt', 'gt', 'le'];
  const BITOPS = ['btst', 'bchg', 'bclr', 'bset'];
  const SHIFTS = ['as', 'ls', 'rox', 'ro'];

  class Bad extends Error {}
  const h = (v, d) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(d, '0');

  function regList(mask, predec) {
    if (predec) { let r = 0; for (let i = 0; i < 16; i++) if (mask & (1 << i)) r |= 1 << (15 - i); mask = r; }
    const names = [];
    for (const [base, letter] of [[0, 'd'], [8, 'a']]) {
      for (let i = 0; i < 8; i++) {
        if (!(mask & (1 << (base + i)))) continue;
        let j = i;
        while (j < 7 && (mask & (1 << (base + j + 1)))) j++;
        names.push(j > i ? letter + i + '-' + letter + j : letter + i);
        i = j;
      }
    }
    return names.join('/') || '(none)';
  }

  /**
   * Disassemble bytes[start..end). Addresses shown are offsets into `bytes`.
   * Returns [{ addr, size, bytes: 'hex', text, comment }].
   */
  function disassemble(bytes, start, end) {
    const lines = [];
    let pc = start;
    let note = '';

    const w = () => { if (pc + 2 > end) throw new Bad(); const v = (bytes[pc] << 8) | bytes[pc + 1]; pc += 2; return v; };
    const sw = () => { const v = w(); return v & 0x8000 ? v - 0x10000 : v; };
    const l = () => ((w() << 16) | w()) >>> 0;
    const stringAt = a => {
      if (a < 0 || a >= bytes.length) return null;
      let s = '';
      for (let i = a; i < bytes.length && bytes[i] >= 32 && bytes[i] < 127 && s.length < 40; i++) s += String.fromCharCode(bytes[i]);
      return s.length >= 3 ? s : null;
    };
    const target = a => { const s = stringAt(a); if (s) note = '"' + s + '"'; return h(a, 4); };

    function imm(size) {
      if (size === 'b') return '#' + h(w() & 0xFF, 2);
      if (size === 'w') return '#' + h(w(), 4);
      return '#' + h(l(), 8);
    }
    function index(base) {
      const ext = w();
      if (ext & 0x0100) throw new Bad();   // 68020 full extension word
      const d8 = ext & 0x80 ? (ext & 0xFF) - 256 : ext & 0xFF;
      return { d8, reg: (ext & 0x8000 ? 'a' : 'd') + ((ext >> 12) & 7) + (ext & 0x0800 ? '.l' : '.w'), base };
    }
    function ea(mode, reg, size) {
      switch (mode) {
        case 0: return 'd' + reg;
        case 1: return 'a' + reg;
        case 2: return '(a' + reg + ')';
        case 3: return '(a' + reg + ')+';
        case 4: return '-(a' + reg + ')';
        case 5: {
          const d = sw();
          if (reg === 6 && d < 0 && EXEC[-d]) note = 'exec ' + EXEC[-d] + ' (if A6 = ExecBase)';
          if (reg === 1 && IOREQ[d]) note = IOREQ[d] + ' (A1 = the boot I/O request)';
          return d + '(a' + reg + ')';
        }
        case 6: { const x = index('a' + reg); return x.d8 + '(' + x.base + ',' + x.reg + ')'; }
        default:
          switch (reg) {
            case 0: { const v = sw(); if (v === 4) note = 'address 4 holds the ExecBase pointer'; return h(v & 0xFFFF, 4) + '.w'; }
            case 1: { const v = l(); if (v === 4) note = 'address 4 holds the ExecBase pointer'; return h(v, 8); }
            case 2: { const at = pc; const d = sw(); return target(at + d) + '(pc)'; }
            case 3: { const at = pc; const x = index('pc'); return target(at + x.d8) + '(pc,' + x.reg + ')'; }
            case 4: if (size) return imm(size); throw new Bad();
            default: throw new Bad();
          }
      }
    }
    const branch = () => { const at = pc; const d = sw(); return h(at + d, 4); };

    function decode(op) {
      const mode = (op >> 3) & 7, reg = op & 7, top = op >> 12;
      const rx = (op >> 9) & 7, om = (op >> 6) & 7, s = (op >> 6) & 3;

      if (top === 0) {
        const special = { 0x003C: 'ori.b', 0x007C: 'ori.w', 0x023C: 'andi.b', 0x027C: 'andi.w', 0x0A3C: 'eori.b', 0x0A7C: 'eori.w' }[op];
        if (special) return special + ' ' + imm(special.endsWith('b') ? 'b' : 'w') + ',' + (special.endsWith('b') ? 'ccr' : 'sr');
        if (op & 0x0100) {
          if (mode === 1) throw new Bad();   // movep
          return BITOPS[s] + ' d' + rx + ',' + ea(mode, reg, 'b');
        }
        if ((op & 0x0F00) === 0x0800) { const bit = w() & 0xFF; return BITOPS[s] + ' #' + bit + ',' + ea(mode, reg); }
        const name = ['ori', 'andi', 'subi', 'addi', null, 'eori', 'cmpi', null][rx];
        if (!name || s === 3) throw new Bad();
        const i = imm(SZ[s]);
        return name + '.' + SZ[s] + ' ' + i + ',' + ea(mode, reg);
      }

      if (top >= 1 && top <= 3) {
        const size = { 1: 'b', 3: 'w', 2: 'l' }[top];
        const src = ea(mode, reg, size);
        const dm = (op >> 6) & 7;
        if (dm === 1 && size === 'b') throw new Bad();
        return (dm === 1 ? 'movea.' : 'move.') + size + ' ' + src + ',' + ea(dm, rx);
      }

      if (top === 4) {
        const fixed = { 0x4E70: 'reset', 0x4E71: 'nop', 0x4E73: 'rte', 0x4E75: 'rts', 0x4E76: 'trapv', 0x4E77: 'rtr', 0x4AFC: 'illegal' }[op];
        if (fixed) return fixed;
        if (op === 0x4E72) return 'stop ' + imm('w');
        if ((op & 0xFFF0) === 0x4E40) return 'trap #' + (op & 15);
        if ((op & 0xFFF8) === 0x4E50) return 'link a' + reg + ',#' + sw();
        if ((op & 0xFFF8) === 0x4E58) return 'unlk a' + reg;
        if ((op & 0xFFF8) === 0x4E60) return 'move.l a' + reg + ',usp';
        if ((op & 0xFFF8) === 0x4E68) return 'move.l usp,a' + reg;
        if ((op & 0xFFC0) === 0x4E80) return 'jsr ' + ea(mode, reg);
        if ((op & 0xFFC0) === 0x4EC0) return 'jmp ' + ea(mode, reg);
        if ((op & 0xF1C0) === 0x41C0) return 'lea ' + ea(mode, reg) + ',a' + rx;
        if ((op & 0xF1C0) === 0x4180) return 'chk.w ' + ea(mode, reg, 'w') + ',d' + rx;
        if ((op & 0xFFF8) === 0x4840) return 'swap d' + reg;
        if ((op & 0xFFC0) === 0x4840) return 'pea ' + ea(mode, reg);
        if ((op & 0xFFF8) === 0x4880) return 'ext.w d' + reg;
        if ((op & 0xFFF8) === 0x48C0) return 'ext.l d' + reg;
        if ((op & 0xFB80) === 0x4880) {
          const size = op & 0x40 ? 'l' : 'w', mask = w();
          const list = regList(mask, mode === 4);
          return (op & 0x0400) ? 'movem.' + size + ' ' + ea(mode, reg) + ',' + list : 'movem.' + size + ' ' + list + ',' + ea(mode, reg);
        }
        if ((op & 0xFFC0) === 0x40C0) return 'move.w sr,' + ea(mode, reg);
        if ((op & 0xFFC0) === 0x44C0) return 'move.w ' + ea(mode, reg, 'w') + ',ccr';
        if ((op & 0xFFC0) === 0x46C0) return 'move.w ' + ea(mode, reg, 'w') + ',sr';
        if ((op & 0xFFC0) === 0x4AC0) return 'tas ' + ea(mode, reg);
        if ((op & 0xFFC0) === 0x4800) return 'nbcd ' + ea(mode, reg);
        const one = { 0x4000: 'negx', 0x4200: 'clr', 0x4400: 'neg', 0x4600: 'not', 0x4A00: 'tst' }[op & 0xFF00];
        if (one && s !== 3) return one + '.' + SZ[s] + ' ' + ea(mode, reg);
        throw new Bad();
      }

      if (top === 5) {
        if (s === 3) {
          const cc = (op >> 8) & 15;
          if (mode === 1) return (cc === 1 ? 'dbra' : 'db' + CC[cc]) + ' d' + reg + ',' + branch();
          return 's' + CC[cc] + ' ' + ea(mode, reg);
        }
        return (op & 0x100 ? 'subq.' : 'addq.') + SZ[s] + ' #' + (rx || 8) + ',' + ea(mode, reg);
      }

      if (top === 6) {
        const cc = (op >> 8) & 15, d8 = op & 0xFF;
        const name = cc === 0 ? 'bra' : cc === 1 ? 'bsr' : 'b' + CC[cc];
        if (d8 === 0) return name + '.w ' + branch();
        if (d8 === 0xFF) throw new Bad();   // 68020 long branch
        return name + '.s ' + h(pc + (d8 & 0x80 ? d8 - 256 : d8), 4);
      }

      if (top === 7) {
        if (op & 0x100) throw new Bad();
        const v = op & 0xFF;
        return 'moveq #' + (v & 0x80 ? v - 256 : v) + ',d' + rx;
      }

      if (top === 8 || top === 9 || top === 0xB || top === 0xC || top === 0xD) {
        if (top === 8 && om === 3) return 'divu.w ' + ea(mode, reg, 'w') + ',d' + rx;
        if (top === 8 && om === 7) return 'divs.w ' + ea(mode, reg, 'w') + ',d' + rx;
        if (top === 0xC && om === 3) return 'mulu.w ' + ea(mode, reg, 'w') + ',d' + rx;
        if (top === 0xC && om === 7) return 'muls.w ' + ea(mode, reg, 'w') + ',d' + rx;
        if (top === 0xC && (op & 0xF1F8) === 0xC140) return 'exg d' + rx + ',d' + reg;
        if (top === 0xC && (op & 0xF1F8) === 0xC148) return 'exg a' + rx + ',a' + reg;
        if (top === 0xC && (op & 0xF1F8) === 0xC188) return 'exg d' + rx + ',a' + reg;
        const name = { 8: 'or', 9: 'sub', 0xB: 'cmp', 0xC: 'and', 0xD: 'add' }[top];
        if ((top === 9 || top === 0xD || top === 0xB) && (om === 3 || om === 7)) {
          const size = om === 3 ? 'w' : 'l';
          return name + 'a.' + size + ' ' + ea(mode, reg, size) + ',a' + rx;
        }
        if (om >= 4 && mode <= 1) {
          if (top === 9 || top === 0xD) {
            const size = SZ[om - 4];
            return name + 'x.' + size + ' ' + (mode ? '-(a' + reg + '),-(a' + rx + ')' : 'd' + reg + ',d' + rx);
          }
          if (top === 0xB && mode === 1) return 'cmpm.' + SZ[om - 4] + ' (a' + reg + ')+,(a' + rx + ')+';
          if (top === 0xB && mode === 0) return 'eor.' + SZ[om - 4] + ' d' + rx + ',d' + reg;
          throw new Bad();   // abcd / sbcd
        }
        if (om <= 2) return name + '.' + SZ[om] + ' ' + ea(mode, reg, SZ[om]) + ',d' + rx;
        return (top === 0xB ? 'eor' : name) + '.' + SZ[om - 4] + ' d' + rx + ',' + ea(mode, reg);
      }

      if (top === 0xE) {
        if (s === 3) {
          if (op & 0x0800) throw new Bad();
          return SHIFTS[(op >> 9) & 3] + (op & 0x100 ? 'l' : 'r') + '.w ' + ea(mode, reg);
        }
        const kind = SHIFTS[(op >> 3) & 3], dir = op & 0x100 ? 'l' : 'r';
        const count = op & 0x20 ? 'd' + rx : '#' + (rx || 8);
        return kind + dir + '.' + SZ[s] + ' ' + count + ',d' + reg;
      }

      throw new Bad();   // line A / line F
    }

    const printable = c => c >= 32 && c < 127;
    const hexBytes = (a, b) => Array.from(bytes.subarray(a, b), v => v.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    const push = (addr, text, comment) => lines.push({ addr, size: pc - addr, bytes: hexBytes(addr, pc), text, comment: comment || '' });

    while (pc < end) {
      const at = pc;
      // Text in the middle of code (e.g. "dos.library") is shown as data, not as nonsense instructions.
      let run = 0, letters = 0;
      while (at + run < end && printable(bytes[at + run])) {
        const c = bytes[at + run] | 0x20;
        if (c >= 97 && c <= 122) letters++;
        run++;
      }
      // Instruction bytes are often printable too ($20 $40 = " @"), so insist on mostly letters.
      if ((run >= 4 && letters * 10 >= run * 7) || run >= 12) {
        pc = at + run;
        let text = "dc.b '" + String.fromCharCode.apply(null, bytes.subarray(at, pc)).replace(/'/g, "''") + "'";
        while (pc < end && bytes[pc] === 0 && (pc === at + run || pc & 1)) { text += ',0'; pc++; }
        push(at, text);
        continue;
      }
      let rest = at;
      while (rest < end && bytes[rest] === 0) rest++;
      if (rest === end && end - at >= 8) { pc = end; lines.push({ addr: at, size: end - at, bytes: '', text: '', comment: (end - at) + ' zero bytes to the end' }); break; }
      if (end - at < 2) { pc = end; push(at, 'dc.b ' + h(bytes[at], 2)); break; }

      note = '';
      let text;
      try { text = decode(w()); } catch (e) {
        if (!(e instanceof Bad)) throw e;
        pc = at + 2;
        text = 'dc.w ' + h((bytes[at] << 8) | bytes[at + 1], 4);
        note = 'not recognised as an instruction';
      }
      push(at, text, note);
    }
    return lines;
  }

  return { disassemble, EXEC, regList };
});
