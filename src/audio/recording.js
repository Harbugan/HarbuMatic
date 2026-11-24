// Pure live pattern recording logic (no DOM, no Web Audio).
// Computes quantized / unquantized step placement against audible musical time,
// writes drum/melodic/slice overdub events while respecting locks, and finalizes note lengths.

import { clamp } from '../core/util.js';

export const MAX_REC_OFFSET = .45;
const OFFSET_EPS = .005;

const round3 = x => Math.round(x * 1000) / 1000;

/**
 * Map an audible musical time `{ absStep, stepDur }` onto a pattern of `len` steps.
 * Accounts for loop wrapping and project swing so Quantize Off replays at performed timing
 * and Quantize On snaps cleanly to the nearest musical step.
 */
export function computeStepPlacement(musicalTime, len, { quantize = true, swing = 0 } = {}) {
  const n = Math.max(1, len | 0);
  const sw = clamp(Number(swing) || 0, 0, .5);
  const wrapped = ((musicalTime.absStep % n) + n) % n;
  const k0 = Math.floor(wrapped);
  const gridPos = k => k + ((((k % 2) + 2) % 2) ? sw * .5 : 0);

  let bestK = k0, bestDelta = wrapped - gridPos(k0);
  for (const cand of [k0 - 1, k0 + 1]) {
    const d = wrapped - gridPos(cand);
    if (Math.abs(d) < Math.abs(bestDelta)) { bestK = cand; bestDelta = d; }
  }

  const step = ((bestK % n) + n) % n;
  let offset = 0;
  if (!quantize) {
    offset = clamp(round3(bestDelta), -MAX_REC_OFFSET, MAX_REC_OFFSET);
    if (Math.abs(offset) < OFFSET_EPS) offset = 0;
  }
  // True when the placed step sits ahead of the performed moment (so an upcoming scheduler tick
  // on this same loop pass must not immediately double-trigger what was just monitored live).
  const snappedForward = bestK > k0 || (bestK === k0 && bestDelta < -OFFSET_EPS);
  return { step, offset, snappedForward, wrapped };
}

/**
 * Overdub one drum hit into a drum pattern.
 * Respects locked drum rows and preserves all other rows and steps.
 */
export function recordDrumEvent(pattern, { drumId, step, velocity = .85, offset = 0 }) {
  if (!pattern || !pattern.steps || !Array.isArray(pattern.steps[drumId])) return { changed: false, cell: null };
  if (pattern.locked && pattern.locked[drumId]) return { changed: false, cell: null, locked: true };
  if (step < 0 || step >= pattern.len) return { changed: false, cell: null };
  const v = round3(clamp(Number(velocity) || .85, .05, 1));
  const o = clamp(round3(Number(offset) || 0), -MAX_REC_OFFSET, MAX_REC_OFFSET);
  const cell = Math.abs(o) >= OFFSET_EPS ? { v, p: 1, o } : { v, p: 1 };
  pattern.steps[drumId][step] = cell;
  return { changed: true, cell };
}

const sameTargetNote = (n, step, pitch, slice) => (
  n.s === step && (slice != null ? n.slice === slice : (n.slice == null && n.p === pitch))
);

/**
 * Overdub one melodic or sampler-slice note-on into a note pattern.
 * Respects locked notes and preserves all other notes (overdub & polyphony).
 */
export function recordNoteOnEvent(pattern, { pitch, step, velocity = .8, offset = 0, slice = null }) {
  if (!pattern || !Array.isArray(pattern.notes)) return { changed: false, note: null };
  if (step < 0 || step >= pattern.len) return { changed: false, note: null };
  const p = Math.round(clamp(Number(pitch) || 60, 0, 127));
  const v = round3(clamp(Number(velocity) || .8, .05, 1));
  const o = clamp(round3(Number(offset) || 0), -MAX_REC_OFFSET, MAX_REC_OFFSET);

  const existing = pattern.notes.find(n => sameTargetNote(n, step, p, slice));
  if (existing) {
    if (existing.locked) return { changed: false, note: null, locked: true };
    existing.v = v;
    existing.l = 1;
    if (Math.abs(o) >= OFFSET_EPS) existing.o = o;
    else delete existing.o;
    return { changed: true, note: existing, updated: true };
  }

  const note = { s: step, p, l: 1, v };
  if (Math.abs(o) >= OFFSET_EPS) note.o = o;
  if (slice != null) note.slice = slice;
  pattern.notes.push(note);
  return { changed: true, note, updated: false };
}

/**
 * Finalize a recorded note's length in integer steps on note-off.
 * Clamps safely within `[1, pattern.len - note.s]` so loop-boundary holds stay valid.
 */
export function finalizeNoteLength(pattern, note, rawDurationSteps) {
  if (!pattern || !note || note.locked || !Array.isArray(pattern.notes)) return false;
  if (!pattern.notes.includes(note)) return false;
  const maxLen = Math.max(1, pattern.len - note.s);
  const nextLen = clamp(Math.round(Number(rawDurationSteps) || 1), 1, maxLen);
  if (nextLen === note.l) return false;
  note.l = nextLen;
  return true;
}
