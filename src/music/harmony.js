// Lightweight harmonic model. A scene's harmony is a short chord progression expressed
// as scale degrees, spread evenly over `span` steps and looping:
//     { degrees: [0, 5, 2, 6], span: 32 }   → in A minor: Am | F | C | G, 8 steps each
// Degrees are relative to the key/scale, so changing key keeps the progression valid.
// Patterns shorter/longer than the span still line up: chordsHeard() lists every chord a
// step will sound against across loop repetitions.

import { makeScale } from './theory.js';
import { NOTE } from '../core/constants.js';
import { mod, lcm } from '../core/util.js';

export function chordPcs(key, scaleName, degree, seventh = false) {
  const par = makeScale(key, scaleName).parent;
  const iv = k => par[(degree + k) % par.length];
  const ivs = [iv(0), iv(2), iv(4)];
  if (seventh) ivs.push(iv(6));
  return ivs.map(i => mod(key + i, 12));
}

export function chordQuality(key, scaleName, degree) {
  const [r, t, f] = chordPcs(key, scaleName, degree);
  const third = mod(t - r, 12), fifth = mod(f - r, 12);
  if (fifth === 6) return 'dim';
  if (fifth === 8) return 'aug';
  return third === 3 ? 'min' : 'maj';
}

export function chordName(key, scaleName, degree) {
  const root = chordPcs(key, scaleName, degree)[0], q = chordQuality(key, scaleName, degree);
  return NOTE[root] + (q === 'min' ? 'm' : q === 'dim' ? '°' : q === 'aug' ? '+' : '');
}

export const harmonyLabel = (key, scaleName, h) => (h ? h.degrees.map(d => chordName(key, scaleName, d)).join(' · ') : '—');

/** degrees usable as chord roots in this scale (root must be in scale; no diminished unless allowed) */
export function usableDegrees(key, scaleName, allowDim = false) {
  const sc = makeScale(key, scaleName);
  return [0, 1, 2, 3, 4, 5, 6].filter(d => {
    const root = chordPcs(key, scaleName, d)[0];
    if (!sc.inScale(root)) return false;
    return allowDim || chordQuality(key, scaleName, d) !== 'dim';
  });
}

const PROGS4 = {
  dreamy: [[0, 5, 2, 6], [0, 3, 5, 4], [0, 4, 5, 3], [0, 5, 3, 4], [0, 2, 3, 0], [0, 3, 0, 5]],
  bouncy: [[0, 3, 4, 0], [0, 4, 5, 3], [0, 0, 3, 4], [0, 5, 3, 4], [0, 3, 0, 4], [0, 6, 3, 4]],
  dark: [[0, 5, 6, 0], [0, 0, 5, 5], [0, 6, 5, 6], [0, 3, 5, 4], [0, 1, 0, 6], [0, 0, 3, 5]],
  weird: [[0, 1, 5, 2], [0, 6, 1, 0], [0, 3, 6, 2], [0, 4, 1, 5], [0, 2, 5, 1], [0, 5, 1, 4]],
};
const PROGS2 = {
  dreamy: [[0, 5], [0, 3], [0, 2], [0, 4]],
  bouncy: [[0, 4], [0, 3], [0, 6], [0, 5]],
  dark: [[0, 5], [0, 6], [0, 1], [0, 3]],
  weird: [[0, 1], [0, 6], [0, 2], [0, 4]],
};

/** choose a progression that fits the scale and mood; chaos adds tasteful substitutions */
export function chooseHarmony(rng, { key, scale, mood = 'bouncy', chaos = .3, span = 32 }) {
  const allowDim = mood === 'weird' && chaos > .5;
  const ok = new Set(usableDegrees(key, scale, allowDim));
  const fits = prog => prog.every(d => ok.has(d));
  const two = span <= 16 || (mood === 'dreamy' && span === 32 && rng.chance(.35));
  let pool = (two ? PROGS2 : PROGS4)[mood] || PROGS4.bouncy;
  let cands = pool.filter(fits);
  if (!cands.length) cands = Object.values(two ? PROGS2 : PROGS4).flat().filter(fits);
  let degrees;
  if (cands.length) degrees = [...rng.pick(cands)];
  else { // exotic scale: build from whatever degrees are usable
    const u = [...ok].filter(d => d !== 0);
    degrees = two ? [0, u.length ? rng.pick(u) : 0] : [0, ...[0, 1, 2].map(() => (u.length ? rng.pick(u) : 0))];
  }
  // controlled chaos: occasionally swap one non-tonic chord for another usable one
  if (degrees.length > 2 && rng.chance(chaos * .45)) {
    const i = rng.int(1, degrees.length - 1), alts = [...ok].filter(d => d !== degrees[i]);
    if (alts.length) degrees[i] = rng.pick(alts);
  }
  return { degrees, span };
}

export function chordAt(h, step) {
  const per = h.span / h.degrees.length;
  return h.degrees[Math.floor(mod(step, h.span) / per) % h.degrees.length];
}
/** steps per chord */
export const chordLen = h => h.span / h.degrees.length;
export const isChordStart = (h, step) => mod(step, chordLen(h)) === 0;

/** every chord degree a step of a `len`-step loop will be heard against */
export function chordsHeard(h, step, len) {
  const reps = lcm(len, h.span) / len, out = [];
  for (let k = 0; k < reps; k++) { const d = chordAt(h, step + k * len); if (!out.includes(d)) out.push(d); }
  return out;
}

/** pitch classes that fit a step: intersection of all heard chords, falling back to the first */
export function tonesAt(key, scale, h, step, len, seventh = false) {
  const heard = chordsHeard(h, step, len);
  const sets = heard.map(d => chordPcs(key, scale, d, seventh));
  let common = sets[0].filter(x => sets.every(s => s.includes(x)));
  if (!common.length) common = sets[0];
  return { tones: common, root: sets[0][0], degree: heard[0], all: sets };
}

/**
 * Guess a progression from existing material (bass first, then any melodic notes).
 * Returns null when there is nothing to listen to.
 */
export function inferHarmony(key, scale, patterns, span, nChords) {
  const sc = makeScale(key, scale);
  const src = ['bass', 'synth', 'fuzz'].map(t => patterns[t]).find(p => p && p.notes && p.notes.length);
  if (!src) return null;
  const per = span / nChords, degrees = [];
  const candidates = usableDegrees(key, scale, true);
  // where (within one harmonic cycle) does each note sound?
  const positions = n => {
    if (src.len >= span) return [mod(n.s, span)];
    const out = [];
    for (let a = n.s; a < span; a += src.len) out.push(a);
    return out;
  };
  for (let c = 0; c < nChords; c++) {
    const weight = new Map();
    src.notes.forEach(n => {
      if (!positions(n).some(a => a >= c * per && a < (c + 1) * per)) return;
      const w = n.l * (mod(n.s, 4) === 0 ? 1.6 : 1) * (1 + (100 - n.p) / 60);
      weight.set(mod(n.p, 12), (weight.get(mod(n.p, 12)) || 0) + w);
    });
    if (!weight.size) { degrees.push(degrees.length ? degrees[degrees.length - 1] : 0); continue; }
    const top = [...weight.entries()].sort((a, b) => b[1] - a[1])[0][0];
    let best = 0, bestScore = -1;
    candidates.forEach(d => {
      const tones = chordPcs(key, scale, d), idx = tones.indexOf(top);
      if (idx < 0) return;
      let score = [3, 1, 2][idx];
      weight.forEach((w, pcl) => { if (tones.includes(pcl)) score += w * .01; });
      if (score > bestScore) { bestScore = score; best = d; }
    });
    if (bestScore < 0 && sc.inScale(top)) best = 0;
    degrees.push(best);
  }
  return { degrees, span };
}
