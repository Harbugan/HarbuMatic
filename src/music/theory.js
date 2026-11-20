// Scale helpers, parameterised by key + scale (no global state).

import { SCALES, NOTE } from '../core/constants.js';
import { clamp, mod } from '../core/util.js';

export const pc = p => mod(p, 12);
export const noteName = p => NOTE[pc(p)] + (Math.floor(p / 12) - 1);

/** 7-note parent scale used to build chords for scales that have no clean triads */
const PARENT = { 'minor pent.': 'minor', 'major pent.': 'major', chromatic: 'minor' };

export function makeScale(key, name) {
  const intervals = SCALES[name] || SCALES.minor;
  const pcs = new Set(intervals.map(i => mod(key + i, 12)));
  const inScale = p => pcs.has(pc(p));
  const notes = (lo, hi) => { const a = []; for (let p = lo; p <= hi; p++) if (inScale(p)) a.push(p); return a; };
  const snap = p => { for (let d = 0; d < 12; d++) { if (inScale(p + d)) return p + d; if (inScale(p - d)) return p - d; } return p; };
  const snapDown = p => { for (let d = 0; d < 12; d++) if (inScale(p - d)) return p - d; return p; };
  /** move n scale steps from p (p is snapped first) */
  const step = (p, n) => {
    let q = snap(p);
    const dir = Math.sign(n);
    for (let i = 0; i < Math.abs(n); i++) { q += dir; while (!inScale(q)) q += dir; }
    return q;
  };
  /** scale-step distance between two pitches (signed) */
  const dist = (a, b) => { const lo = Math.min(a, b), hi = Math.max(a, b); let c = 0; for (let p = snap(lo) + 1; p <= hi; p++) if (inScale(p)) c++; return b >= a ? c : -c; };
  const rootNear = c => c - mod(c - key, 12);
  return {
    key, name, intervals, pcs, inScale, notes, snap, snapDown, step, dist, rootNear,
    parent: SCALES[PARENT[name] || name],
    /** pitch class of the tonic */
    tonic: mod(key, 12),
  };
}

/** lowest pitch >= lo with the given pitch class */
export const pitchAbove = (pcl, lo) => lo + mod(pcl - lo, 12);
/** pitch with given pitch class closest to target */
export function nearestWithPc(pcl, target) {
  const up = pitchAbove(pcl, target), down = up - 12;
  return up - target <= target - down ? up : down;
}
/** closest pitch to `target` whose pitch class is in `pcls`, inside [lo, hi] */
export function nearestOf(pcls, target, lo = 0, hi = 127) {
  let best = null, bd = 1e9;
  for (const c of pcls) {
    for (const p of [nearestWithPc(c, target), nearestWithPc(c, target) + 12, nearestWithPc(c, target) - 12]) {
      if (p < lo || p > hi) continue;
      const d = Math.abs(p - target);
      if (d < bd) { bd = d; best = p; }
    }
  }
  return best == null ? clamp(target, lo, hi) : best;
}
