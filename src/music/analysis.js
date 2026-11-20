// Musical metrics used by automated tests (and handy for tuning generators).
// They judge structure, not just "is it in the scale".

import { tonesAt } from './harmony.js';
import { strength } from './rhythm.js';
import { DRUM_IDS } from '../core/constants.js';
import { mod } from '../core/util.js';

export const inScaleRatio = (notes, scale) => (notes.length ? notes.filter(n => scale.inScale(n.p)).length / notes.length : 1);

/** share of notes on strong positions (or long notes) that are chord tones */
export function chordToneRatio(notes, ctx, len, { strongOnly = true } = {}) {
  const sel = notes.filter(n => !strongOnly || strength(n.s) >= .7 || n.l >= 3);
  if (!sel.length) return 1;
  return sel.filter(n => tonesAt(ctx.key, ctx.scaleName, ctx.harmony, n.s, len, true).all.some(set => set.includes(mod(n.p, 12)))).length / sel.length;
}

/** average Jaccard similarity of onset sets between consecutive units (repetition measure) */
export function unitSimilarity(notes, len, unit = 16) {
  const units = len / unit;
  if (units < 2) unit = len / 2;
  const sets = [];
  for (let u = 0; u < len / unit; u++) sets.push(new Set(notes.filter(n => n.s >= u * unit && n.s < (u + 1) * unit).map(n => n.s - u * unit)));
  let sum = 0, c = 0;
  for (let i = 1; i < sets.length; i++) {
    const a = sets[0], b = sets[i];
    const inter = [...a].filter(x => b.has(x)).length, uni = new Set([...a, ...b]).size;
    sum += uni ? inter / uni : 1; c++;
  }
  return c ? sum / c : 1;
}

/** proportion of melodic intervals that are steps or small skips (≤ 4 semitones) */
export function smoothness(notes) {
  const top = topLine(notes);
  if (top.length < 2) return 1;
  let ok = 0;
  for (let i = 1; i < top.length; i++) if (Math.abs(top[i].p - top[i - 1].p) <= 5) ok++;
  return ok / (top.length - 1);
}
/** highest note per onset, time ordered */
export function topLine(notes) {
  const by = new Map();
  notes.forEach(n => { const b = by.get(n.s); if (!b || n.p > b.p) by.set(n.s, n); });
  return [...by.values()].sort((a, b) => a.s - b.s);
}

export const onsetDensity = (notes, len) => new Set(notes.map(n => n.s)).size / len;

export function drumHits(steps, id) { return steps[id].map((c, i) => (c ? i : -1)).filter(i => i >= 0); }
export function drumDensity(steps, len) { return DRUM_IDS.reduce((a, id) => a + steps[id].filter(Boolean).length, 0) / len; }

/** share of bass onsets that either coincide with a kick or sit on an off-beat between kicks */
export function bassKickRelation(bassNotes, kickAt) {
  if (!bassNotes.length) return 1;
  return bassNotes.filter(n => kickAt(n.s) || mod(n.s, 2) === 0 || strength(n.s) >= .45).length / bassNotes.length;
}

/** does the last melodic note land on a chord tone of its chord? */
export function endsResolved(notes, ctx, len) {
  const top = topLine(notes);
  if (!top.length) return true;
  const last = top[top.length - 1];
  return tonesAt(ctx.key, ctx.scaleName, ctx.harmony, last.s, len, true).all.some(set => set.includes(mod(last.p, 12)));
}
