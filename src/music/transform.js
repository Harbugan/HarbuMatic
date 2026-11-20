// Transformations of existing material. Pure: they return a new pattern and never mutate input.
// Every transformation respects locks (locked melodic notes, locked drum rows).
//
//   generate  — a new coherent idea for this track (uses scene harmony + groove)
//   mutate    — changes some notes but keeps the idea recognisable (amount = chaos)
//   evolve    — one or two subtle changes (used by Auto-evolve)
//   remix     — reorders segments and re-fits them to the chords at their new position
//   rhythm    — same pitches, new groove-aware rhythm
//   callresp  — first half asks, second half answers and resolves
//   surprise  — a bolder transformation that still lands on the harmony
//   humanize  — velocity + micro-timing variation

import { DRUM_IDS, RANGE } from '../core/constants.js';
import { clamp, clone, mod } from '../core/util.js';
import { chordAt, chordLen, tonesAt } from './harmony.js';
import { nearestOf } from './theory.js';
import { strength, motifOnsets, articulate } from './rhythm.js';
import { generateTrack, genDrums, monoFix, fixSlides } from './generate.js';

export const KINDS = ['generate', 'mutate', 'evolve', 'remix', 'rhythm', 'callresp', 'surprise', 'humanize'];

const rangeFor = track => { const [lo, hi] = RANGE[track] || [36, 96]; return [lo - 4, hi + 4]; };

export function isPatternEmpty(track, p) {
  return track === 'drums' ? !DRUM_IDS.some(id => p.steps[id].some(Boolean)) : !p.notes.length;
}

/**
 * @returns {{ pattern, intensity: number, nudge: number, info: string, harmony?: object }}
 */
export function transformPattern(kind, track, pattern, ctx, rng, { targets } = {}) {
  const p = clone(pattern);
  const T = targets || ctx.targets || { pitch: true, rhythm: true, velocity: true, length: false };
  if (isPatternEmpty(track, p) && kind !== 'generate' && kind !== 'humanize') kind = 'generate';
  if (track === 'drums') return drumTransform(kind, p, ctx, rng, T);
  return melodicTransform(kind, track, p, ctx, rng, T);
}

/* =========================================================
   Melodic
   ========================================================= */
function mergeLocked(track, locked, free, len) {
  let out = free.filter(n => n.s >= 0 && n.s < len).map(n => ({ ...n, l: clamp(Math.round(n.l), 1, len - n.s) }));
  if (track === 'bass') out = out.filter(n => !locked.some(m => n.s < m.s + m.l && m.s < n.s + n.l));
  else { const ls = new Set(locked.map(n => n.s)); out = out.filter(n => !ls.has(n.s)); }
  out.forEach(n => { delete n.locked; });
  const all = [...locked, ...out].sort((a, b) => a.s - b.s || a.p - b.p);
  if (track !== 'bass') return all;
  // mono: free notes yield to locked ones
  const fixed = monoFix(all, len);
  locked.forEach(m => { const f = fixed.find(n => n.s === m.s); if (f) Object.assign(f, m); });
  return fixSlides(fixed, len);
}

function melodicTransform(kind, track, p, ctx, rng, T) {
  const locked = p.notes.filter(n => n.locked), free = p.notes.filter(n => !n.locked);
  const [lo, hi] = rangeFor(track);
  const { scale, chaos: ch } = ctx;
  let out, intensity = ch, nudge = 0, info = '';
  switch (kind) {
    case 'generate': {
      out = generateTrack(track, ctx, rng, p.len).notes;
      intensity = .5; info = 'New idea';
      break;
    }
    case 'mutate': out = mutateNotes(free, ctx, rng, ch, p.len, track, T, false); info = 'Mutated'; break;
    case 'evolve': out = mutateNotes(free, ctx, rng, ch * .4, p.len, track, T, true); intensity = ch * .35; info = 'Evolved'; break;
    case 'remix': out = remixNotes(free, ctx, rng, p.len, lo, hi); info = 'Remixed'; break;
    case 'rhythm': out = rhythmNotes(free, ctx, rng, p.len, lo, hi); info = 'New rhythm'; break;
    case 'callresp': out = callResponse(free, ctx, rng, p.len, lo, hi); intensity = .5; info = 'Call & response'; break;
    case 'surprise': {
      const r = surpriseNotes(free, track, ctx, rng, p.len, lo, hi);
      out = r.notes; info = r.info; intensity = 1; nudge = .35;
      break;
    }
    case 'humanize':
      out = free.map(n => ({ ...n, v: clamp(n.v + rng.float(-.15, .15) * (.5 + ch), .15, 1), o: clamp(rng.float(-.12, .12) * (.4 + ch), -.25, .25) }));
      intensity = .2; info = 'Humanized';
      break;
    default: out = free;
  }
  out = out.map(n => ({ ...n, p: clamp(Math.round(n.p), 12, 120) }));
  p.notes = mergeLocked(track, locked, out, p.len);
  if (T.sound && kind === 'mutate') nudge = Math.max(nudge, ch * .4);
  return { pattern: p, intensity, nudge, info };
}

function weightedIndexes(rng, weights, k) {
  const idx = weights.map((_, i) => i), picked = [];
  const w = [...weights];
  for (let j = 0; j < k && idx.length; j++) {
    const i = rng.weighted(idx, idx.map(x => w[x]));
    picked.push(i); idx.splice(idx.indexOf(i), 1);
  }
  return picked;
}

/** identity-preserving mutation: a bounded number of local changes, biased away from the first statement */
export function mutateNotes(free, ctx, rng, amt, len, track, T, gentle) {
  if (!free.length) return free;
  const [lo, hi] = rangeFor(track);
  const notes = free.map(n => ({ ...n }));
  const k = gentle ? (rng.chance(.6) ? 1 : 2) : Math.max(1, Math.round(notes.length * (.1 + amt * .42)));
  const weights = notes.map(n => (len > 16 && n.s < 16 ? .45 : 1) * (strength(n.s) >= .7 ? .55 : 1));
  const ops = ['pitch', 'rhythm', 'velocity', 'length'].filter(o => T[o]);
  if (!ops.length) ops.push('pitch');
  const occupied = s => notes.some(n => n.s === s);
  weightedIndexes(rng, weights, k).forEach(i => {
    const n = notes[i], op = gentle && rng.chance(.4) ? 'velocity' : rng.pick(ops);
    if (op === 'pitch') {
      const steps = gentle ? [-1, 1] : amt > .6 ? [-1, 1, -2, 2, -3, 3] : [-1, 1, -1, 1, -2, 2];
      n.p = clamp(ctx.scale.step(n.p, rng.pick(steps)), lo, hi);
      if (strength(n.s) >= .7 && rng.chance(1 - amt * .5)) n.p = nearestOf(tonesAt(ctx.key, ctx.scaleName, ctx.harmony, n.s, len).tones, n.p, lo, hi);
    } else if (op === 'rhythm') {
      if (strength(n.s) >= .85 && amt < .55) { n.v = clamp(n.v + rng.float(-.2, .2), .15, 1); return; }
      const ns = n.s + rng.pick(gentle ? [-1, 1] : [-1, 1, -2, 2]);
      if (ns >= 0 && ns < len && !occupied(ns)) { n.s = ns; n.l = clamp(n.l, 1, len - ns); }
    } else if (op === 'velocity') n.v = clamp(n.v + rng.float(-.3, .3) * (.5 + amt), .15, 1);
    else if (op === 'length') n.l = clamp(n.l + rng.pick([-1, 1, 2]), 1, len - n.s);
  });
  if (!gentle && T.rhythm) {
    const sorted = [...notes].sort((a, b) => a.s - b.s);
    if (rng.chance(amt * .5) && sorted.length >= 2) { // grow: a passing note inside a gap
      const gaps = sorted.map((n, i) => [n, sorted[i + 1]]).filter(([a, b]) => b && b.s - a.s >= 3);
      if (gaps.length) {
        const [a, b] = rng.pick(gaps), s = a.s + Math.floor((b.s - a.s) / 2);
        const dir = Math.sign(b.p - a.p) || rng.pick([-1, 1]);
        notes.push({ s, p: clamp(ctx.scale.step(a.p, dir), lo, hi), l: 1, v: clamp(a.v * .85, .2, 1) });
      }
    }
    if (notes.length > 3 && rng.chance(amt * .35)) { // prune a weak note
      const weak = notes.map((n, i) => [n, i]).filter(([n]) => strength(n.s) < .45);
      if (weak.length) notes.splice(rng.pick(weak)[1], 1);
    }
  }
  return notes;
}

/** move whole segments around, transposing each note to fit the chord at its new home */
export function remixNotes(notes, ctx, rng, len, lo, hi) {
  const H = ctx.harmony;
  let seg = clamp(chordLen(H), 4, len / 2);
  while (len % seg) seg /= 2;
  const n = len / seg;
  let order = [...Array(n).keys()];
  const keepFirst = rng.chance(1 - ctx.chaos * .5);
  const rest = rng.shuffle(order.slice(keepFirst ? 1 : 0));
  order = keepFirst ? [0, ...rest] : rest;
  if (order.every((v, i) => v === i) && n > 1) [order[n - 1], order[n - 2]] = [order[n - 2], order[n - 1]];
  return notes.map(x => {
    const c = Math.floor(x.s / seg), at = order.indexOf(c), s = at * seg + (x.s % seg);
    let d = chordAt(H, s) - chordAt(H, x.s);
    if (d > 3) d -= 7; if (d < -3) d += 7;
    let p = d ? ctx.scale.step(x.p, d) : x.p;
    if (p > hi) p -= 12; if (p < lo) p += 12;
    return { ...x, s, p, l: clamp(x.l, 1, len - s) };
  });
}

/** keep the pitch sequence, write a new groove-aware rhythm for it */
export function rhythmNotes(notes, ctx, rng, len, lo, hi) {
  if (!notes.length) return notes;
  const sorted = [...notes].sort((a, b) => a.s - b.s || a.p - b.p);
  const unit = len >= 32 ? 16 : len;
  const perUnit = Math.max(1, Math.round(sorted.length / (len / unit)));
  const cell = motifOnsets(rng, unit, { density: ctx.density, mood: ctx.mood, chaos: ctx.chaos, k: clamp(perUnit, 1, unit - 1) });
  const onsets = [];
  for (let u = 0; u < len; u += unit) cell.forEach(o => onsets.push(u + o));
  return sorted.map((n, i) => {
    const s = onsets[i % onsets.length], next = onsets[(i % onsets.length) + 1] ?? len;
    const m = { ...n, s, l: clamp(articulate(rng, next - s, ctx.mood), 1, len - s) };
    if (strength(s) >= .7 && rng.chance(1 - ctx.chaos * .6)) m.p = nearestOf(tonesAt(ctx.key, ctx.scaleName, ctx.harmony, s, len).tones, m.p, lo, hi);
    return m;
  });
}

/** first half = call (kept), second half = answer: same rhythm, varied pitches, resolving ending */
export function callResponse(notes, ctx, rng, len, lo, hi) {
  const half = len / 2, H = ctx.harmony;
  const call = notes.filter(n => n.s < half);
  if (!call.length) return notes;
  const resp = call.map((n, i, a) => {
    const s = n.s + half;
    let d = chordAt(H, s) - chordAt(H, n.s);
    if (d > 3) d -= 7; if (d < -3) d += 7;
    let p = d ? ctx.scale.step(n.p, d) : n.p;
    if (i > 0 && i < a.length - 1 && rng.chance(.55)) p = ctx.scale.step(p, rng.pick([-2, -1, 1, 2]));
    return { ...n, s, p: clamp(p, lo, hi) };
  });
  const last = resp.reduce((a, b) => (b.s > a.s ? b : a));
  const t = tonesAt(ctx.key, ctx.scaleName, H, last.s, len);
  last.p = nearestOf(t.tones.includes(ctx.scale.tonic) ? [ctx.scale.tonic] : t.tones, last.p, lo, hi);
  last.l = clamp(Math.max(last.l, 2), 1, len - last.s);
  return [...call, ...resp];
}

/** bolder moves that still keep the harmony */
function surpriseNotes(free, track, ctx, rng, len, lo, hi) {
  const moves = ['invert', 'octave', 'displace', 'regen', 'double'];
  const w = [1, track === 'bass' ? 1.4 : .8, 1, 1.1, .7];
  const move = rng.weighted(moves, w);
  let notes = free.map(n => ({ ...n })), info = '';
  if (move === 'invert') {
    const center = ctx.scale.snap(Math.round(notes.reduce((a, n) => a + n.p, 0) / notes.length));
    notes.forEach(n => { n.p = ctx.scale.step(center, -ctx.scale.dist(center, n.p)); });
    info = 'Surprise · flipped upside down';
  } else if (move === 'octave') {
    notes.forEach(n => { if (rng.chance(.4)) n.p += (n.p + 12 <= hi ? 12 : -12); });
    info = 'Surprise · octave jumps';
  } else if (move === 'displace') {
    const by = rng.pick([1, 2, 3, -1]);
    notes.forEach(n => { n.s = mod(n.s + by, len); n.l = clamp(n.l, 1, len - n.s); });
    info = 'Surprise · shifted the groove';
  } else if (move === 'double') {
    const half = len / 2;
    const firstHalf = notes.filter(n => n.s < half).map(n => ({ ...n, s: Math.floor(n.s / 2), l: Math.max(1, Math.round(n.l / 2)) }));
    notes = [...firstHalf, ...firstHalf.map(n => ({ ...n, s: n.s + half / 2 }))];
    notes = [...notes, ...notes.map(n => ({ ...n, s: n.s + half }))];
    info = 'Surprise · double time';
  } else {
    const boosted = { ...ctx, chaos: Math.max(ctx.chaos, .6) };
    notes = generateTrack(track, boosted, rng, len).notes;
    info = 'Surprise · a brand new twist';
  }
  notes = mutateNotes(notes, { ...ctx, chaos: Math.max(ctx.chaos, .6) }, rng, Math.max(ctx.chaos, .55), len, track, { pitch: true, rhythm: true, velocity: true, length: true }, false);
  notes.forEach(n => {
    if (n.p > hi) n.p -= 12; if (n.p < lo) n.p += 12;
    if (strength(n.s) >= .7 && rng.chance(.85)) n.p = nearestOf(tonesAt(ctx.key, ctx.scaleName, ctx.harmony, n.s, len).tones, n.p, lo, hi);
    else n.p = ctx.scale.snap(n.p);
  });
  return { notes: notes.filter(n => n.s >= 0 && n.s < len), info };
}

/* =========================================================
   Drums
   ========================================================= */
const ROW_FACTOR = { kick: .45, snare: .5, clap: .4, chh: 1.25, ohh: .8, tom: .6, rim: .8, cow: .6 };
function isCore(id, i) {
  if (id === 'kick') return i % 16 === 0;
  if (id === 'snare' || id === 'clap') return i % 16 === 4 || i % 16 === 12 || i % 16 === 8;
  return false;
}

function drumTransform(kind, p, ctx, rng, T) {
  const len = p.len, ch = ctx.chaos;
  const rows = DRUM_IDS.filter(id => !p.locked[id]);
  let intensity = ch, nudge = 0, info = '';
  if (kind === 'generate') {
    const fresh = genDrums(ctx, rng, len);
    rows.forEach(id => { p.steps[id] = fresh[id]; });
    intensity = .5; info = 'New groove';
  } else if (kind === 'mutate' || kind === 'evolve' || kind === 'surprise') {
    const amt = kind === 'evolve' ? ch * .4 : kind === 'surprise' ? Math.max(ch, .7) : ch;
    if (kind === 'surprise') {
      const fresh = genDrums({ ...ctx, chaos: Math.max(ch, .65) }, rng, len);
      rows.forEach(id => { if (!['kick', 'snare', 'clap'].includes(id) && rng.chance(.4)) p.steps[id] = fresh[id]; });
      intensity = 1; nudge = .35; info = 'Surprise groove';
    }
    if (kind === 'evolve') {
      const pool = rows.filter(id => !['kick'].includes(id));
      const changes = rng.chance(.6) ? 1 : 2;
      for (let c = 0; c < changes && pool.length; c++) {
        const id = rng.pick(pool), i = rng.int(0, len - 1);
        if (isCore(id, i)) continue;
        const cell = p.steps[id][i];
        if (cell && rng.chance(.5)) cell.v = clamp(cell.v + rng.float(-.2, .2), .15, 1);
        else p.steps[id][i] = cell ? null : { v: rng.float(.25, .55), p: rng.chance(.5) ? .75 : 1 };
      }
      intensity = ch * .35; info = 'Evolved';
    } else {
      rows.forEach(id => {
        const row = p.steps[id];
        for (let i = 0; i < len; i++) {
          const rf = ROW_FACTOR[id] ?? .7;
          if ((T.rhythm || kind === 'surprise') && rng.chance(amt * .1 * rf)) {
            if (row[i] && isCore(id, i) && !(amt > .8 && ctx.mood === 'weird')) continue;
            if (!row[i] && id === 'kick' && strength(i) >= .7 && rng.chance(.5)) continue; // new kicks prefer syncopation
            row[i] = row[i] ? null : { v: rng.float(.35, .85), p: rng.chance(amt * .5) ? rng.pick([.5, .75]) : 1 };
          } else if (row[i] && (T.velocity || kind === 'surprise') && rng.chance(amt * .5)) {
            row[i].v = clamp(row[i].v + rng.float(-.3, .3), .15, 1);
          }
        }
      });
      if (!info) info = 'Mutated';
    }
  } else if (kind === 'humanize') {
    rows.forEach(id => p.steps[id].forEach(c => { if (c) c.v = clamp(c.v + rng.float(-.15, .15), .15, 1); }));
    intensity = .2; info = 'Humanized';
  } else if (kind === 'remix') {
    const n = len / 4, perm = rng.shuffle([...Array(n).keys()]);
    rows.forEach(id => {
      if (['kick', 'snare', 'clap'].includes(id)) { // keep the backbone, only swap non-core hits
        const row = p.steps[id], moved = Array(len).fill(null);
        row.forEach((c, i) => { if (c && isCore(id, i)) moved[i] = c; });
        row.forEach((c, i) => { if (c && !isCore(id, i)) { const j = perm[Math.floor(i / 4)] * 4 + (i % 4); if (!moved[j]) moved[j] = c; } });
        p.steps[id] = moved;
      } else {
        const nr = Array(len).fill(null);
        p.steps[id].forEach((c, i) => { if (c) nr[perm[Math.floor(i / 4)] * 4 + (i % 4)] = c; });
        p.steps[id] = nr;
      }
    });
    info = 'Remixed';
  } else if (kind === 'rhythm') {
    rows.forEach(id => {
      if (['kick', 'snare', 'clap'].includes(id)) return;
      const nr = Array(len).fill(null), shift = rng.pick([0, 1, 1, 2]);
      p.steps[id].forEach((c, i) => { if (c) nr[(i + (rng.chance(.5) ? shift : 0)) % len] = c; });
      p.steps[id] = nr;
    });
    info = 'New rhythm';
  } else if (kind === 'callresp') {
    const half = len / 2;
    rows.forEach(id => {
      const row = p.steps[id];
      for (let i = 0; i < half; i++) row[i + half] = row[i] ? { ...row[i] } : null;
      if (id === 'snare' || id === 'tom') for (let i = len - 4; i < len; i++) if (rng.chance(.45 + ch * .4)) row[i] = { v: rng.float(.4, .9), p: 1 };
    });
    intensity = .5; info = 'Call & response';
  }
  return { pattern: p, intensity, nudge, info };
}
