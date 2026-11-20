// Rhythm vocabulary: metric weights, euclidean patterns and motif onset selection.

import { clamp } from '../core/util.js';

/** how "strong" a 16th-step position is inside a bar (1 = downbeat) */
export function strength(s) {
  const b = ((s % 16) + 16) % 16;
  if (b === 0) return 1;
  if (b === 8) return .85;
  if (b % 4 === 0) return .7;
  if (b % 2 === 0) return .45;
  return .25;
}
export const isStrong = s => strength(s) >= .7;

/** Bjorklund-style euclidean rhythm, rotated */
export function euclid(k, n, rot = 0) {
  if (k <= 0) return Array(n).fill(false);
  const res = [];
  let bucket = 0;
  for (let i = 0; i < n; i++) { bucket += k; if (bucket >= n) { bucket -= n; res.push(true); } else res.push(false); }
  // rotate so the first hit lands on 0, then apply requested rotation
  const first = res.indexOf(true);
  const aligned = res.map((_, i) => res[(i + first) % n]);
  return aligned.map((_, i) => aligned[(((i - rot) % n) + n) % n]);
}

const MOOD_SYNC = { dreamy: .6, bouncy: 1.9, dark: .8, weird: 1.4 };

/**
 * Choose `k` onsets inside a unit of `unit` steps, weighted by metric strength and mood.
 * Downbeat 0 is included unless the mood wants a pickup feel.
 */
export function motifOnsets(rng, unit, { density = .5, mood = 'bouncy', chaos = .3, k } = {}) {
  const moodF = { dreamy: .55, bouncy: 1.1, dark: .7, weird: 1 }[mood] ?? 1;
  const count = k ?? clamp(Math.round(unit * (.16 + density * .42) * moodF + rng.float(-.6, .6)), 2, unit - 1);
  if (mood === 'weird' && rng.chance(.6)) {
    const e = euclid(count, unit, rng.int(0, 2));
    return e.map((on, i) => (on ? i : -1)).filter(i => i >= 0);
  }
  const chosen = new Set();
  if (!(mood === 'bouncy' && rng.chance(.25))) chosen.add(0);
  const sync = MOOD_SYNC[mood] ?? 1;
  let guard = 0;
  while (chosen.size < count && guard++ < 200) {
    const cands = [], ws = [];
    for (let s = 0; s < unit; s++) {
      if (chosen.has(s)) continue;
      const st = strength(s);
      let w = st >= .7 ? 1 : st >= .45 ? .6 : .32 * sync;
      w *= 1 + chaos * (st < .45 ? 1.2 : -.3);
      cands.push(s); ws.push(Math.max(.01, w));
    }
    if (!cands.length) break;
    chosen.add(rng.weighted(cands, ws));
  }
  return [...chosen].sort((a, b) => a - b);
}

/** note length given the gap to the next onset and the mood's articulation */
export function articulate(rng, gap, mood) {
  if (gap <= 1) return 1;
  switch (mood) {
    case 'dreamy': return gap;
    case 'bouncy': return rng.chance(.7) ? 1 : Math.min(gap, 2);
    case 'dark': return Math.min(gap, rng.int(1, 3));
    default: return rng.int(1, gap);
  }
}
