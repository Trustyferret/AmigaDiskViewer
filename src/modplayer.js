/*
 * modplayer.js — plays ProTracker modules decoded by preview.js. It only computes sound
 * (render() fills two Float32Arrays); the page sends them to Web Audio. No DOM code.
 *
 * Supports the usual ProTracker effects: arpeggio, slides, tone portamento, vibrato, tremolo,
 * sample offset, volume, position jump, pattern break, speed/tempo, and the E-commands
 * (fine slides, pattern loop, retrigger, note cut, note delay, pattern delay).
 * Odd data never stops it: unknown effects are ignored and every index is clamped.
 * Browser global: `ModPlayer`; Node: `require('./modplayer.js')`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ModPlayer = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Paula's clock (PAL) divided by 2: the playback rate is CLOCK / period samples a second. */
  const CLOCK = 3546895;
  /** ProTracker periods for finetune 0: three octaves, C-1 to B-3. */
  const PERIODS = [
    856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453,
    428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226,
    214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113,
  ];
  const NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
  const SINE = [0, 24, 49, 74, 97, 120, 141, 161, 180, 197, 212, 224, 235, 244, 250, 253, 255, 253, 250, 244, 235, 224, 212, 197, 180, 161, 141, 120, 97, 74, 49, 24];

  /** The table note nearest to a period (0–35). */
  function noteIndex(period) {
    let best = 0;
    for (let i = 1; i < PERIODS.length; i++) if (Math.abs(PERIODS[i] - period) < Math.abs(PERIODS[best] - period)) best = i;
    return best;
  }
  function periodFor(idx, finetune) {
    idx = Math.max(0, Math.min(PERIODS.length - 1, idx));
    return finetune ? Math.round(PERIODS[idx] * Math.pow(2, -finetune / 96)) : PERIODS[idx];
  }
  /** "C-2" style name for a period, or "---" for none. */
  function noteName(period) {
    if (!period) return '---';
    const i = noteIndex(period);
    return NAMES[i % 12] + (1 + Math.floor(i / 12));
  }

  /** One cell of a pattern: { sample, period, effect, param }. */
  function cell(mod, pattern, row, channel) {
    const o = ((pattern * 64 + row) * mod.channels + channel) * 4, p = mod.patterns;
    if (pattern >= mod.numPatterns || o + 3 >= p.length) return { sample: 0, period: 0, effect: 0, param: 0 };
    return { sample: (p[o] & 0xF0) | (p[o + 2] >> 4), period: ((p[o] & 0x0F) << 8) | p[o + 1], effect: p[o + 2] & 0x0F, param: p[o + 3] };
  }

  function create(mod, rate) {
    const chs = [];
    for (let c = 0; c < mod.channels; c++) {
      const right = c % 4 === 1 || c % 4 === 2;   // Amiga channel order: left, right, right, left
      chs.push({
        sample: null, playing: false, pos: 0, period: 0, out: 0, volume: 0, outVol: 0, finetune: 0, note: 0,
        effect: 0, param: 0, portaTarget: 0, portaSpeed: 0, vibSpeed: 0, vibDepth: 0, vibPos: 0, vibWave: 0,
        tremSpeed: 0, tremDepth: 0, tremPos: 0, tremWave: 0, offset: 0, loopRow: 0, loopCount: 0, delayed: null,
        gainL: right ? 0.3 : 0.7, gainR: right ? 0.7 : 0.3,
      });
    }
    const st = { order: 0, row: 0, tick: 0, speed: 6, tempo: 125, left: 0, jump: -1, brk: -1, loopTo: -1, delay: 0, inDelay: false, loops: 0 };
    const len = mod.songLength;

    function trigger(ch, period) {
      ch.note = noteIndex(period);
      ch.period = ch.finetune ? periodFor(ch.note, ch.finetune) : period;
      ch.pos = 0;
      ch.playing = !!(ch.sample && ch.sample.data.length);
      if (ch.vibWave < 4) ch.vibPos = 0;
      if (ch.tremWave < 4) ch.tremPos = 0;
    }

    function applyOffset(ch) {
      const s = ch.sample;
      if (!s) return;
      ch.pos = ch.offset;
      if (ch.pos >= s.data.length) {
        if (s.loopLength > 2) ch.pos = s.loopStart; else ch.playing = false;
      }
    }

    function readRow() {
      const pat = mod.order[st.order] || 0;
      for (let c = 0; c < chs.length; c++) {
        const ch = chs[c], k = cell(mod, pat, st.row, c);
        ch.effect = k.effect; ch.param = k.param;
        const x = k.param >> 4, y = k.param & 15;
        if (k.sample > 0 && k.sample <= 31) {
          ch.sample = mod.samples[k.sample - 1];
          ch.volume = ch.sample.volume;
          ch.finetune = ch.sample.finetune;
        }
        if (k.effect === 0xE && x === 5) ch.finetune = y > 7 ? y - 16 : y;
        if (k.effect === 0xE && x === 0xD && y) { ch.delayed = k.period ? k.period : null; }
        else if (k.period) {
          if (k.effect === 3 || k.effect === 5) {
            ch.portaTarget = ch.finetune ? periodFor(noteIndex(k.period), ch.finetune) : k.period;
          } else {
            trigger(ch, k.period);
            if (k.effect === 9) { if (k.param) ch.offset = k.param * 256; applyOffset(ch); }
          }
        } else if (k.effect === 9 && k.param) ch.offset = k.param * 256;
        switch (k.effect) {
          case 3: if (k.param) ch.portaSpeed = k.param; break;
          case 4: if (x) ch.vibSpeed = x; if (y) ch.vibDepth = y; break;
          case 7: if (x) ch.tremSpeed = x; if (y) ch.tremDepth = y; break;
          case 0xB: st.jump = k.param; break;
          case 0xC: ch.volume = Math.min(64, k.param); break;
          case 0xD: st.brk = Math.min(63, x * 10 + y); break;
          case 0xE:
            if (x === 1) ch.period = Math.max(113, ch.period - y);
            else if (x === 2) ch.period = Math.min(856, ch.period + y);
            else if (x === 4) ch.vibWave = y & 7;
            else if (x === 6) {
              if (!y) ch.loopRow = st.row;
              else if (!ch.loopCount) { ch.loopCount = y; st.loopTo = ch.loopRow; }
              else if (--ch.loopCount) st.loopTo = ch.loopRow;
            }
            else if (x === 7) ch.tremWave = y & 7;
            else if (x === 0xA) ch.volume = Math.min(64, ch.volume + y);
            else if (x === 0xB) ch.volume = Math.max(0, ch.volume - y);
            else if (x === 0xC && !y) ch.volume = 0;
            else if (x === 0xE && !st.inDelay) st.delay = y;
            break;
          case 0xF:
            if (k.param && k.param < 32) st.speed = k.param;
            else if (k.param >= 32) st.tempo = k.param;
            break;
        }
        ch.out = ch.period; ch.outVol = ch.volume;
      }
    }

    function volSlide(ch) {
      const x = ch.param >> 4, y = ch.param & 15;
      ch.volume = x ? Math.min(64, ch.volume + x) : Math.max(0, ch.volume - y);
    }
    function tonePorta(ch) {
      if (!ch.portaTarget || !ch.period) return;
      if (ch.period < ch.portaTarget) ch.period = Math.min(ch.portaTarget, ch.period + ch.portaSpeed);
      else ch.period = Math.max(ch.portaTarget, ch.period - ch.portaSpeed);
    }
    const wave = (kind, pos) => {
      const p = pos & 63;
      if ((kind & 3) === 1) return p < 32 ? 255 - p * 8 : -(255 - (p - 32) * 8);   // ramp
      if ((kind & 3) === 2) return p < 32 ? 255 : -255;                          // square
      return p < 32 ? SINE[p] : -SINE[p - 32];
    };

    function tickEffects() {
      for (const ch of chs) {
        const x = ch.param >> 4, y = ch.param & 15;
        let out = ch.period, vol = ch.volume;
        switch (ch.effect) {
          case 0:
            if (ch.param) { const add = [0, x, y][st.tick % 3]; out = periodFor(ch.note + add, ch.finetune); }
            break;
          case 1: ch.period = Math.max(113, ch.period - ch.param); out = ch.period; break;
          case 2: ch.period = Math.min(856, ch.period + ch.param); out = ch.period; break;
          case 3: tonePorta(ch); out = ch.period; break;
          case 5: tonePorta(ch); volSlide(ch); out = ch.period; vol = ch.volume; break;
          case 4: case 6:
            if (ch.effect === 6) { volSlide(ch); vol = ch.volume; }
            out = ch.period + ((wave(ch.vibWave, ch.vibPos) * ch.vibDepth) >> 7);
            ch.vibPos = (ch.vibPos + ch.vibSpeed) & 63;
            break;
          case 7:
            vol = Math.max(0, Math.min(64, ch.volume + ((wave(ch.tremWave, ch.tremPos) * ch.tremDepth) >> 6)));
            ch.tremPos = (ch.tremPos + ch.tremSpeed) & 63;
            break;
          case 0xA: volSlide(ch); vol = ch.volume; break;
          case 0xE:
            if (x === 9 && y && st.tick % y === 0) ch.pos = 0;
            else if (x === 0xC && st.tick === y) { ch.volume = 0; vol = 0; }
            else if (x === 0xD && st.tick === y && ch.delayed) { trigger(ch, ch.delayed); ch.delayed = null; out = ch.period; }
            break;
        }
        ch.out = out; ch.outVol = vol;
      }
    }

    function nextRow() {
      if (st.delay > 0) { st.delay--; st.inDelay = true; return; }
      st.inDelay = false;
      const was = st.order;
      if (st.loopTo >= 0) { st.row = st.loopTo; st.loopTo = -1; st.jump = st.brk = -1; return; }
      if (st.jump >= 0 || st.brk >= 0) {
        st.order = st.jump >= 0 ? st.jump : st.order + 1;
        st.row = st.brk >= 0 ? st.brk : 0;
        st.jump = st.brk = -1;
        for (const ch of chs) { ch.loopRow = 0; ch.loopCount = 0; }
      } else if (++st.row >= 64) { st.row = 0; st.order++; }
      if (st.order >= len) { st.order = mod.restart < len ? mod.restart : 0; st.loops++; }
      else if (st.order < was || (st.order === was && st.row === 0)) st.loops++;   // jumped backwards: the song repeats
    }

    function doTick() {
      if (st.tick === 0 && !st.inDelay) readRow(); else tickEffects();
      if (++st.tick >= st.speed) { st.tick = 0; nextRow(); }
    }

    function mix(L, R, from, n) {
      for (const ch of chs) {
        if (!ch.playing || !ch.out || !ch.outVol) continue;
        const s = ch.sample, d = s.data, looped = s.loopLength > 2, loopEnd = s.loopStart + s.loopLength;
        const step = CLOCK / Math.max(ch.out, 50) / rate, v = ch.outVol / 64 / 128 * 0.5;
        const gl = v * ch.gainL, gr = v * ch.gainR;
        let pos = ch.pos;
        for (let i = from; i < from + n; i++) {
          if (looped && pos >= loopEnd) pos = s.loopStart + ((pos - s.loopStart) % s.loopLength);
          else if (pos >= d.length) { ch.playing = false; break; }
          const k = pos | 0;
          const a = d[k], b = k + 1 < (looped ? loopEnd : d.length) ? d[k + 1] : (looped ? d[s.loopStart] : 0);
          const smp = a + (b - a) * (pos - k);
          L[i] += smp * gl; R[i] += smp * gr;
          pos += step;
        }
        ch.pos = pos;
      }
    }

    return {
      /** Fill `frames` samples of L and R (Float32Arrays), overwriting what is there. */
      render(L, R, frames) {
        L.fill(0, 0, frames); R.fill(0, 0, frames);
        let i = 0;
        while (i < frames) {
          if (st.left <= 0) { doTick(); st.left = Math.round(rate * 2.5 / st.tempo); }
          const n = Math.min(frames - i, st.left);
          mix(L, R, i, n);
          i += n; st.left -= n;
        }
      },
      /** Where the song is: order position, pattern number, row, and how many times it has repeated. */
      position() { return { order: st.order, pattern: mod.order[st.order] || 0, row: st.row, loops: st.loops }; },
      _tick() { doTick(); return 2.5 / st.tempo; },
    };
  }

  /** How long the song plays before it repeats, in seconds (capped at 30 minutes). */
  function duration(mod) {
    const p = create(mod, 1000);
    let t = 0;
    while (p.position().loops === 0 && t < 1800) t += p._tick();
    return t;
  }

  return { create, duration, cell, noteName, PERIODS };
});
