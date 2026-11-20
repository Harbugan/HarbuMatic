// Generators: create a new, coherent musical idea for one instrument from a shared context.
// All functions are pure: (ctx, rng, len) → steps | notes.

import { DRUM_IDS, RANGE } from '../core/constants.js';
import { clamp, mod } from '../core/util.js';
import { chordAt, chordLen, chordPcs, tonesAt } from './harmony.js';
import { pitchAbove, nearestOf } from './theory.js';
import { strength, euclid, motifOnsets, articulate } from './rhythm.js';

/* =========================================================
   Drums — a groove template per mood, repeated with variation
   ========================================================= */
export function genDrums(ctx, rng, len) {
  const { mood, density: d, chaos: c } = ctx;
  const bar = {}; DRUM_IDS.forEach(id => { bar[id] = Array(16).fill(null); });
  const put = (id, i, v, p = 1) => { if (i >= 0 && i < 16) bar[id][i] = { v: clamp(v, .1, 1), p }; };

  // --- kick
  let kicks;
  if (mood === 'bouncy') kicks = [0, 4, 8, 12];
  else if (mood === 'dreamy') kicks = rng.pick([[0, 8, 10], [0, 7, 10], [0, 6, 10], [0, 10]]);
  else if (mood === 'dark') kicks = rng.pick([[0, 10], [0, 3, 10], [0, 8, 11], [0, 6, 11]]);
  else { const e = euclid(rng.pick([3, 4, 5, 5]), 16, 0); kicks = e.map((on, i) => (on ? i : -1)).filter(i => i >= 0); }
  kicks.forEach(i => put('kick', i, i === 0 ? 1 : i % 4 === 0 ? .9 : .78));
  // syncopation grows with chaos
  if (rng.chance(c * .7)) put('kick', rng.pick([3, 6, 7, 11, 14, 15].filter(i => !kicks.includes(i))), .62, c > .55 ? .75 : 1);
  if (mood !== 'bouncy' && rng.chance(d * .4)) put('kick', rng.pick([2, 5, 13, 15].filter(i => !kicks.includes(i))), .55, .8);

  // --- backbeat
  let back = [4, 12], backId = rng.chance(.55) ? 'clap' : 'snare';
  if (mood === 'dark') back = rng.chance(.7) ? [8] : [4, 12];
  if (mood === 'dreamy') backId = rng.chance(.4) ? 'rim' : 'snare';
  if (mood === 'weird') back = c > .55 ? rng.pick([[6, 14], [4, 11], [5, 12]]) : rng.pick([[4, 12], [4, 12], [6, 14]]);
  back.forEach(i => put(backId, i, mood === 'dreamy' ? .7 : .88));
  if (backId === 'clap' && mood === 'bouncy' && rng.chance(.35)) back.forEach(i => put('snare', i, .5));
  // ghost notes
  if (d > .45 && mood !== 'dreamy') [7, 9, 15].forEach(i => { if (rng.chance((d - .4) * .9) && !bar.snare[i]) put('snare', i, rng.float(.22, .34), rng.pick([.6, .75, 1])); });

  // --- hats
  const grid = d > .62 ? 1 : 2;
  if (mood === 'bouncy') {
    [2, 6, 10, 14].forEach(i => put('ohh', i, .5));
    for (let i = 0; i < 16; i += grid) if (!bar.ohh[i]) put('chh', i, i % 4 === 0 ? .5 : rng.float(.26, .4), i % 2 ? .85 : 1);
  } else if (mood === 'dreamy') {
    for (let i = 0; i < 16; i += 2) put('chh', i, i % 4 === 0 ? .4 : .28);
    if (d > .5) for (let i = 1; i < 16; i += 4) if (rng.chance(d * .5)) put('chh', i + 2, .2, .7);
    if (rng.chance(.5)) put('ohh', 14, .3);
  } else if (mood === 'dark') {
    for (let i = 0; i < 16; i += grid) put('chh', i, i % 4 === 0 ? .48 : i % 2 ? .22 : .32, i % 2 ? .8 : 1);
    if (rng.chance(.4)) put('ohh', 6, .35);
  } else {
    const e = euclid(rng.int(5, 11), 16, rng.int(0, 3));
    e.forEach((on, i) => { if (on) put('chh', i, rng.float(.25, .5), rng.chance(c * .5) ? .75 : 1); });
    if (rng.chance(.6)) put('ohh', rng.pick([3, 7, 11, 14]), .4);
  }
  // --- percussion colour (weird/chaotic)
  const percChance = (mood === 'weird' ? .55 : 0) + c * .35;
  ['rim', 'cow', 'tom'].forEach(id => {
    if (id === backId || !rng.chance(percChance * (id === 'tom' ? .4 : 1))) return;
    const e = euclid(rng.int(2, 4), 16, rng.int(1, 5));
    e.forEach((on, i) => { if (on && !bar.kick[i]) put(id, i, rng.float(.3, .6), rng.pick([1, .75, .5])); });
  });

  // --- assemble bars: repetition with small development + phrase-end fill
  const st = {}; DRUM_IDS.forEach(id => { st[id] = Array(len).fill(null); });
  const bars = len / 16;
  for (let b = 0; b < bars; b++) {
    DRUM_IDS.forEach(id => bar[id].forEach((cell, i) => { if (cell) st[id][b * 16 + i] = { ...cell }; }));
    if (b % 2 === 1 && rng.chance(.45 + c * .35)) { // answer bar: a pickup kick or a hat change
      const i = b * 16 + rng.pick([11, 13, 14, 15]);
      if (!st.kick[i]) st.kick[i] = { v: .6, p: 1 }; else st.chh[i] = { v: .3, p: 1 };
    }
  }
  const fillChance = bars > 1 ? .55 + d * .3 : d * .45;
  if (rng.chance(fillChance)) {
    const fillId = mood === 'weird' || rng.chance(.4) ? 'tom' : 'snare';
    for (let i = len - 4; i < len; i++) if (rng.chance(.4 + c * .3 + (i === len - 1 ? .3 : 0))) st[fillId][i] = { v: rng.float(.45, .85), p: bars === 1 ? .75 : 1 };
  }
  return st;
}

/* =========================================================
   Bass — rhythm cell tied to the kick, pitches follow chord roots
   ========================================================= */
const BASS_STYLE_W = {
  bouncy: { offbeat: .4, roll: .35, lock: .25, flow: 0, syncop: 0 },
  dreamy: { offbeat: .1, roll: 0, lock: .3, flow: .6, syncop: 0 },
  dark: { offbeat: 0, roll: .25, lock: .5, flow: .25, syncop: 0 },
  weird: { offbeat: 0, roll: .35, lock: .2, flow: 0, syncop: .45 },
};
export function pickBassStyle(ctx, rng) {
  const w = { ...(BASS_STYLE_W[ctx.mood] || BASS_STYLE_W.bouncy) };
  w.roll += ctx.chaos * .25; w.syncop += ctx.chaos * .2;
  const keys = Object.keys(w);
  return rng.weighted(keys, keys.map(k => w[k]));
}

export function genBass(ctx, rng, len, style = pickBassStyle(ctx, rng)) {
  const { harmony: H, scale, density: d, chaos: c } = ctx;
  const [lo, hi] = RANGE.bass;
  const cl = chordLen(H), C = style === 'flow' ? Math.min(16, cl, len) : Math.min(16, len); // groove cells span a drum bar
  // ----- rhythm cell (identity)
  let on = new Set([0]);
  if (style === 'offbeat') { [2, 6, 10, 14].forEach(i => i < C && on.add(i)); if (ctx.kickAt(0) && rng.chance(.5)) on.delete(0); if (d > .55) [3, 11].forEach(i => i < C && rng.chance(d - .4) && on.add(i)); }
  else if (style === 'lock') { for (let i = 0; i < C; i++) if (ctx.kickAt(i)) on.add(i); if (on.size < 2) on.add(C / 2); for (let i = 1; i < C; i++) if (!on.has(i) && on.has(i + 1) && rng.chance(d * .35)) on.add(i); }
  else if (style === 'roll') { for (let i = 1; i < C; i++) if (rng.chance(.35 + d * .45)) on.add(i); }
  else if (style === 'flow') { on.add(C / 2 + (rng.chance(.4) ? rng.int(0, 2) : 0)); if (rng.chance(d)) on.add(C - 2); }
  else { const e = euclid(clamp(Math.round(3 + d * 4), 3, C - 1), C, rng.int(0, 3)); e.forEach((x, i) => x && on.add(i)); }
  if (on.size === 0) on.add(0);
  const onsets = [...on].filter(i => i < C).sort((a, b) => a - b);
  const funcs = onsets.map((o, i) => (i === 0 && o === 0 ? 'root' : rng.weighted(
    ['root', 'oct', 'fifth', 'third', 'step'],
    style === 'roll' ? [.3, .35, .18, .07, .1] : style === 'flow' ? [.4, .1, .3, .15, .05] : [.38, .24, .2, ctx.mood === 'dark' ? .04 : .1, .08 + c * .1])));
  const accents = onsets.map(o => (style === 'roll' || style === 'offbeat') && o % 4 !== 0 && rng.chance(.22 + c * .18));
  // ----- realise over the loop
  const notes = [];
  const baseFor = rootPc => pitchAbove(rootPc, lo);
  for (let off = 0, rep = 0; off < len; off += C, rep++) {
    const lastCell = off + C >= len;
    onsets.forEach((o, i) => {
      const s = off + o; if (s >= len) return;
      const t = tonesAt(ctx.key, ctx.scaleName, H, s, len);
      const rootPc = t.tones.includes(t.root) ? t.root : t.tones[0];
      const base = baseFor(rootPc), chord = t.all[0];
      let f = funcs[i];
      if (rep % 2 === 1 && i > 0 && rng.chance(c * .35)) f = rng.pick(['oct', 'fifth', 'root']); // development
      if (lastCell && i === onsets.length - 1 && rng.chance(.45)) f = rng.pick(['oct', 'fifth', 'step']); // phrase end
      let p = base;
      if (f === 'oct') p = base + 12;
      else if (f === 'fifth') p = pitchAbove(chord[2], base);
      else if (f === 'third') p = pitchAbove(chord[1], base);
      else if (f === 'step') p = scale.step(base, rng.pick([1, -1, 2]));
      if (f !== 'root' && strength(s) < .45 && rng.chance(c * .25)) p = scale.step(p, rng.pick([-1, 1]));
      notes.push({ s, p: clamp(p, lo, hi), l: 1, v: accents[i] ? 1 : strength(s) >= .7 ? rng.float(.75, .88) : rng.float(.6, .8) });
    });
  }
  // every chord change: make sure the root is stated on the downbeat, maybe approach the next chord
  for (let seg = 0; seg < len; seg += cl) {
    const t0 = tonesAt(ctx.key, ctx.scaleName, H, seg, len);
    const at = notes.find(n => n.s === seg);
    if (at && t0.tones.includes(t0.root) && style !== 'offbeat') at.p = baseFor(t0.root);
    // approach note into the next chord
    const nextSeg = seg + cl;
    if (cl >= 8 && rng.chance(.3 + (ctx.mood === 'dark' ? .1 : 0) + c * .1)) {
      const nextRoot = baseFor(tonesAt(ctx.key, ctx.scaleName, H, nextSeg % len, len).root);
      const s = Math.min(nextSeg, len) - 1;
      const existing = notes.find(n => n.s === s);
      const cur = notes.filter(n => n.s < s).pop();
      const ap = cur && nextRoot > cur.p ? scale.step(nextRoot, -1) : scale.step(nextRoot, 1);
      if (existing) existing.p = clamp(ap, lo, hi); else notes.push({ s, p: clamp(ap, lo, hi), l: 1, v: .7 });
    }
  }
  notes.sort((a, b) => a.s - b.s);
  // lengths by style, then monophonic clean-up + slides
  notes.forEach((n, i) => {
    const gap = (notes[i + 1] ? notes[i + 1].s : len) - n.s;
    n.l = style === 'flow' ? gap : style === 'lock' ? Math.min(gap, 3) : style === 'roll' ? (gap > 1 && rng.chance(.25) ? 2 : 1) : Math.min(gap, rng.chance(.3) ? 2 : 1);
    n.l = clamp(n.l, 1, Math.max(1, gap));
  });
  if (style === 'roll' || style === 'syncop' || (style === 'offbeat' && rng.chance(.4))) {
    notes.forEach((n, i) => { const nx = notes[i + 1]; if (nx && nx.s === n.s + n.l && nx.p !== n.p && rng.chance(.18 + c * .22)) n.slide = true; });
  }
  return notes;
}

/* =========================================================
   Melody — motif, repetition with variation, phrase resolution
   ========================================================= */
const FORMS = { 1: ['A'], 2: ['A', 'R'], 4: ['A', 'R', 'A', 'E'], 8: ['A', 'R', 'A2', 'E', 'A', 'R', 'B', 'E'] };

function contour(rng, k, mood, chaos) {
  const deltas = [0];
  const leapW = (mood === 'weird' ? .25 : .07) + chaos * .12;
  for (let i = 1; i < k; i++) {
    const prev = deltas[i - 1];
    if (Math.abs(prev) >= 3) { deltas.push(-Math.sign(prev) * rng.int(1, 2)); continue; } // gap-fill after a leap
    deltas.push(rng.weighted([0, 1, -1, 2, -2, 3, -3, 4, -4],
      [mood === 'dark' ? .2 : .1, .26, .26, .11, .11, leapW, leapW, leapW * .5, leapW * .5]));
  }
  return deltas;
}

export function genMelody(ctx, rng, len, { register = [60, 84], center = 69, allowPads = true } = {}) {
  const { harmony: H, scale, mood, density: d, chaos: c } = ctx;
  const [lo, hi] = register;
  const notes = [];
  const pads = allowPads && ((mood === 'dreamy' && rng.chance(.55)) || (d < .3 && rng.chance(.45)));
  if (pads) notes.push(...padChords(ctx, rng, len));
  let U = mood === 'dreamy' ? 16 : 8;
  if (len < U * 2) U = Math.max(4, len / 2);
  const nUnits = len / U;
  const form = FORMS[nUnits] || Array.from({ length: nUnits }, (_, i) => FORMS[8][i % 8]);
  const motifDensity = pads ? d * .55 : d;
  const rhythm = motifOnsets(rng, U, { density: motifDensity, mood, chaos: c });
  const shape = contour(rng, rhythm.length, mood, c);
  const altRhythm = (() => { // B section: simplified/shifted relative of the motif
    const r = new Set(rhythm.filter((_, i) => i === 0 || rng.chance(.7)));
    if (rng.chance(.6)) r.add(rng.int(1, U - 1));
    return [...r].sort((a, b) => a - b);
  })();
  let prev = nearestOf(tonesAt(ctx.key, ctx.scaleName, H, 0, len).tones, center, lo, hi);
  let motifStart = null;

  const realise = (off, type) => {
    let rh = type === 'B' ? altRhythm : rhythm;
    if (off > 0 && type !== 'B' && rng.chance(c * .55)) { // chaos: vary the rhythm of a repeat a little
      const r = new Set(rh);
      if (rh.length > 2 && rng.chance(.5)) r.delete(rng.pick(rh.slice(1)));
      else r.add(rng.int(1, U - 1));
      rh = [...r].sort((a, b) => a - b);
    }
    const sh = type === 'B' ? contour(rng, rh.length, mood, c) : shape.slice(0, rh.length);
    rh.forEach((o, i) => {
      const s = off + o; if (s >= len) return;
      let delta = sh[i] ?? 0;
      if (type === 'R' && i >= Math.floor(rh.length / 2)) delta = i === rh.length - 1 ? delta : -delta || rng.pick([-1, 1]);
      if (type === 'A2' && i === rh.length - 1) delta += rng.pick([-1, 1]);
      // call, response and ending share the motif's opening note → recognisable repetition
      let p = i === 0 && type !== 'B' && motifStart != null ? motifStart : scale.step(prev, delta);
      if (p > hi) p = scale.step(p, -Math.abs(delta) * 2 - 1);
      if (p < lo) p = scale.step(p, Math.abs(delta) * 2 + 1);
      p = clamp(p, lo, hi);
      const gap = (rh[i + 1] ?? U) - o;
      let l = articulate(rng, gap, mood);
      const strong = strength(s) >= .7 || l >= 3 || i === 0;
      const t = tonesAt(ctx.key, ctx.scaleName, H, s, len);
      if (strong && rng.chance(1 - c * .6)) p = nearestOf(t.tones, p, lo, hi);
      const last = i === rh.length - 1 && (type === 'E' || type === 'R');
      if (last) {
        const tonicFits = t.tones.includes(scale.tonic);
        p = nearestOf(type === 'E' && tonicFits ? [scale.tonic] : t.tones, p, lo, hi);
        l = Math.max(l, Math.min(gap, type === 'E' ? 4 : 2));
      }
      if (!strong && !last && mood === 'weird' && c > .55 && rng.chance(c * .15)) p += rng.pick([-1, 1]); // chromatic neighbour
      const v = clamp(.5 + strength(s) * .28 + (last ? .08 : 0) + rng.float(-.05, .05), .3, .95);
      notes.push({ s, p, l: clamp(l, 1, len - s), v: pads ? v * .95 : v });
      if (motifStart == null) motifStart = p;
      prev = p;
    });
  };
  form.forEach((type, u) => realise(u * U, type));
  return notes;
}

/** sustained, voice-led chords on every chord change (dreamy pads) */
export function padChords(ctx, rng, len, { lo = 52, hi = 74, v = .4 } = {}) {
  const { harmony: H } = ctx, cl = chordLen(H), out = [];
  let prevVoicing = null;
  for (let s = 0; s < len; s += cl) {
    const t = tonesAt(ctx.key, ctx.scaleName, H, s, len, ctx.mood === 'dreamy');
    const pcs = len >= H.span ? chordPcs(ctx.key, ctx.scaleName, chordAt(H, s), ctx.mood === 'dreamy' && rng.chance(.5)) : t.tones;
    const anchor = prevVoicing ? prevVoicing.reduce((a, b) => a + b, 0) / prevVoicing.length : (lo + hi) / 2;
    const voicing = pcs.map(pcl => nearestOf([pcl], anchor, lo, hi)).sort((a, b) => a - b).filter((p, i, a) => a.indexOf(p) === i);
    voicing.forEach(p => out.push({ s, p, l: Math.max(2, Math.min(cl, len - s) - 1), v }));
    prevVoicing = voicing;
  }
  return out;
}

/* =========================================================
   Texture (FUZZ) — slow colour on chord changes
   ========================================================= */
export function genTexture(ctx, rng, len) {
  const { harmony: H, mood, density: d, chaos: c, scale } = ctx;
  const [lo, hi] = RANGE.fuzz;
  const cl = chordLen(H), notes = [];
  if (mood === 'weird') {
    const e = euclid(clamp(Math.round(2 + d * 5), 2, 8), len >= 32 ? 32 : 16, rng.int(0, 4));
    for (let s = 0; s < len; s++) if (e[s % e.length]) {
      const t = tonesAt(ctx.key, ctx.scaleName, H, s, len);
      let p = nearestOf(t.tones, rng.int(lo + 4, hi - 6), lo, hi);
      if (rng.chance(c * .5)) p = scale.step(p, rng.pick([-1, 1, 2]));
      notes.push({ s, p, l: rng.int(1, 3), v: rng.float(.45, .7) });
    }
    return notes;
  }
  let prev = null;
  for (let s = 0; s < len; s += cl) {
    if (s > 0 && !rng.chance(.45 + d * .5)) continue;
    const t = tonesAt(ctx.key, ctx.scaleName, H, s, len, mood === 'dreamy');
    const pool = mood === 'dark' ? [t.tones[0], t.tones[2] ?? t.tones[0]] : t.tones.slice(1).length ? t.tones.slice(1) : t.tones;
    const target = prev ?? (mood === 'dark' ? lo + 4 : (lo + hi) / 2 + 3);
    const p = nearestOf(pool, target + rng.int(-3, 3), lo, hi);
    if (mood === 'bouncy') {
      const half = Math.max(2, cl / 2);
      notes.push({ s, p, l: Math.max(1, half - 1), v: rng.float(.5, .7) });
      if (s + half < len && rng.chance(.5 + d * .3)) notes.push({ s: s + half, p: nearestOf(pool, p + 3, lo, hi), l: Math.max(1, half - 1), v: rng.float(.45, .6) });
    } else {
      notes.push({ s, p, l: Math.max(2, Math.min(cl, len - s) - 1), v: rng.float(.5, .78) });
    }
    prev = p;
  }
  return notes;
}

/** monophonic clean-up for GOO: no overlaps, slides only into adjacent notes */
export function monoFix(notes, len) {
  const sorted = [...notes].sort((a, b) => a.s - b.s || b.v - a.v);
  const out = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && last.s === n.s) continue;
    if (last && last.s + last.l > n.s) last.l = Math.max(1, n.s - last.s);
    out.push({ ...n, l: clamp(n.l, 1, len - n.s) });
  }
  fixSlides(out, len);
  return out;
}
export function fixSlides(notes, len) {
  const starts = new Set(notes.map(n => n.s));
  notes.forEach(n => { if (n.slide && !starts.has(mod(n.s + n.l, len))) delete n.slide; });
  return notes;
}

/** generate content for one track; returns { steps } for drums or { notes } otherwise */
export function generateTrack(track, ctx, rng, len) {
  if (track === 'drums') return { steps: genDrums(ctx, rng, len) };
  if (track === 'bass') return { notes: monoFix(genBass(ctx, rng, len), len) };
  if (track === 'synth') return { notes: genMelody(ctx, rng, len) };
  return { notes: genTexture(ctx, rng, len) };
}
