// Built-in Break Pool and tempo-fit math for RUFF (v0.7 PR2): pure data + functions (no DOM, no Web Audio),
// so they run unchanged in Node tests and the browser.
//
// Built-in break IDs use the stable `brk-builtin-*` prefix so they remain clearly distinguishable from
// future user-imported samples (`smp-<sha256>`).

import { BREAK_LANES } from './instruments.js';
import { barsSeconds, defaultSlices, fitModeOf, sliceCount } from './samples.js';
import { clamp, num } from './util.js';

export const BUILTIN_BREAK_PREFIX = 'brk-builtin-';
/** playback speed ratio bounds for breaks across HarbuMatic's 50–200 BPM range */
export const BREAK_RATIO_RANGE = Object.freeze([0.25, 4]);
/** Approved 16-step RUFF sequencer spans 2 bars (32 transport 16th-steps) at 8th-note step resolution */
export const BREAK_PATTERN_STEPS = 16;
export const BREAK_BARS_DEFAULT = 2;
export const BREAK_STEP_SPAN = 2;
export const BREAK_LOOP_STEPS = BREAK_PATTERN_STEPS * BREAK_STEP_SPAN;

const freeze = o => Object.freeze(o);
const SLICES_16 = freeze(defaultSlices(16));
const metaList = rows => freeze(rows.map(([label, role]) => freeze({ label, role })));

const TIGHT_META = metaList([
  ['Kick', 'kick'], ['Hat', 'hat'], ['Snare', 'snare'], ['Skip Kick', 'kick'],
  ['Ghost', 'ghost'], ['Kick', 'kick'], ['Rimshot', 'snare'], ['Open Hat', 'hat'],
  ['Kick 2', 'kick'], ['Rim', 'perc'], ['Snare 2', 'snare'], ['Kick', 'kick'],
  ['Ghost 2', 'ghost'], ['Kick', 'kick'], ['Rimshot 2', 'snare'], ['Roll', 'fill'],
]);
const FUNKY_META = metaList([
  ['Kick', 'kick'], ['Kick Tamb', 'kick'], ['Snare', 'snare'], ['Kick Open', 'kick'],
  ['Pedal Ghost', 'ghost'], ['Kick Tamb', 'kick'], ['Rimshot', 'snare'], ['Open Ghost', 'hat'],
  ['Kick Shake', 'kick'], ['Skip Kick', 'kick'], ['Snare 2', 'snare'], ['Kick Ghost', 'kick'],
  ['Open Ghost', 'hat'], ['Kick Tamb', 'kick'], ['Snare Rim', 'snare'], ['Turnaround', 'fill'],
]);
const JUNGLE_META = metaList([
  ['Kick Ride', 'kick'], ['Kick 2', 'kick'], ['Rimshot', 'snare'], ['Bell Roll', 'fill'],
  ['Ride Roll', 'ghost'], ['Double Kick', 'kick'], ['Rimshot 2', 'snare'], ['Bell Open', 'hat'],
  ['Kick Crash', 'kick'], ['Kick Ride', 'kick'], ['Rimshot', 'snare'], ['Bell Roll 2', 'fill'],
  ['Ride Roll 2', 'ghost'], ['Kick Ghost', 'kick'], ['Rim Bell', 'snare'], ['32nd Roll', 'fill'],
]);

/** Built-in original breakbeat loops (2 bars each, 44.1 kHz stereo 16-bit PCM WAV). */
export const BUILTIN_BREAKS = freeze([
  freeze({
    id: 'brk-builtin-tight',
    name: 'TIGHT',
    subtitle: 'Crisp & punchy',
    bpm: 120,
    bars: 2,
    duration: 4,
    sampleRate: 44100,
    channels: 2,
    url: './assets/breaks/tight.wav',
    slices: SLICES_16,
    sliceMeta: TIGHT_META,
  }),
  freeze({
    id: 'brk-builtin-funky',
    name: 'FUNKY',
    subtitle: 'Syncopated & loose',
    bpm: 105,
    bars: 2,
    duration: (8 * 60) / 105,
    sampleRate: 44100,
    channels: 2,
    url: './assets/breaks/funky.wav',
    slices: SLICES_16,
    sliceMeta: FUNKY_META,
  }),
  freeze({
    id: 'brk-builtin-jungle',
    name: 'RUFF JUNGLE',
    subtitle: 'Aggressive & rolling',
    bpm: 160,
    bars: 2,
    duration: 3,
    sampleRate: 44100,
    channels: 2,
    url: './assets/breaks/jungle.wav',
    slices: SLICES_16,
    sliceMeta: JUNGLE_META,
  }),
]);

const BY_ID = new Map(BUILTIN_BREAKS.map(b => [b.id, b]));
export const BUILTIN_BREAK_IDS = freeze(BUILTIN_BREAKS.map(b => b.id));

export const isBuiltinBreakId = id => typeof id === 'string' && id.startsWith(BUILTIN_BREAK_PREFIX);
export const getBuiltinBreak = id => (typeof id === 'string' ? (BY_ID.get(id) || null) : null);
export const listBuiltinBreaks = () => BUILTIN_BREAKS;

export const laneVolKey = lane => `vol${String(lane || 'a').toUpperCase()}`;
export const laneMuteKey = lane => `mute${String(lane || 'a').toUpperCase()}`;
export const laneAudibleLevel = (params, lane) => {
  if (!params) return 0.85;
  if (params[laneMuteKey(lane)]) return 0;
  return clamp(num(params[laneVolKey(lane)], 0.85), 0, 1);
};

export const hasAssignedBreak = slot => !!(slot && slot.breaks && BREAK_LANES.some(l => !!slot.breaks[l]));

/** Unique break IDs referenced across all slots (or a filtered list) in slot/lane order. */
export function breakRefsOf(project) {
  const out = [];
  for (const s of (project && project.slots) || []) {
    if (!s || !s.breaks) continue;
    for (const l of BREAK_LANES) {
      const id = s.breaks[l];
      if (typeof id === 'string' && id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/**
 * Tempo-fit math for a break loop of `duration` seconds spanning `bars` bars at project `bpm`.
 *   stretch (default): output/input stretch factor = target / source; playbackRate stays 1 (pitch preserved)
 *   tape:              stretch = 1; playbackRate = source / target (tempo & pitch move together)
 */
export function breakFitPlayback(params, duration, bars, bpm) {
  const mode = fitModeOf(params);
  const source = Math.max(0, num(duration, 0));
  const b = Math.max(0.5, num(bars, 2));
  const target = bpm > 0 ? barsSeconds(b, bpm) : 0;
  if (!(source > 0) || !(target > 0)) {
    return { mode, bars: b, source, target, ratio: 1, rate: 1, pitchRate: 1, stretch: 1 };
  }
  const ratio = source / target;
  const rate = clamp(ratio, BREAK_RATIO_RANGE[0], BREAK_RATIO_RANGE[1]);
  const tape = mode === 'tape';
  return {
    mode,
    bars: b,
    source,
    target,
    ratio,
    rate,
    pitchRate: tape ? rate : 1,
    stretch: tape ? 1 : 1 / rate,
  };
}

/* ---------- Break-aware slicing & 2-bar / 16-step mapping (v0.7 PR3) ---------- */

/** Slice boundary list for a break source (16 equal slices across 2 bars by default). */
export function breakSlicesOf(breakId) {
  const desc = getBuiltinBreak(breakId);
  return (desc && Array.isArray(desc.slices) && desc.slices.length >= 2) ? desc.slices : SLICES_16;
}

/** Number of addressable slices in a break source. */
export function breakSliceCount(breakId) {
  return Math.max(1, sliceCount(breakSlicesOf(breakId)));
}

/** Keep a slice index strictly valid [0, count - 1] for the given break source. */
export function clampBreakSlice(breakId, sliceIndex, fallback = 0) {
  const count = breakSliceCount(breakId);
  const raw = Number.isFinite(sliceIndex) ? Math.trunc(sliceIndex) : Math.trunc(num(fallback, 0));
  return clamp(raw, 0, count - 1);
}

/**
 * Explicit mapping between 16-step RUFF pattern and transport 16th-steps for a break source.
 * Built-in breaks are 2 bars (32 transport 16th-steps) → stepSpan = 2 (each pattern step = 1 eighth-note),
 * so steps 0–7 span Bar 1 and steps 8–15 span Bar 2 with zero half-break truncation.
 */
export function breakStepTiming(breakId, len = BREAK_PATTERN_STEPS) {
  const desc = getBuiltinBreak(breakId);
  const bars = desc ? desc.bars : BREAK_BARS_DEFAULT;
  const patLen = Math.max(1, Math.round(num(len, BREAK_PATTERN_STEPS)));
  const loopSteps = Math.max(patLen, Math.round(bars * 16));
  const stepSpan = Math.max(1, Math.round(loopSteps / patLen));
  return { bars, len: patLen, loopSteps, stepSpan };
}

/** Rhythmic bar.beat label for a 16-step 2-bar break grid (0 → '1.1', 1 → '1.1+', ..., 8 → '2.1', ..., 15 → '2.4+'). */
export function breakStepBeatLabel(step) {
  const i = clamp(Math.trunc(num(step, 0)), 0, BREAK_PATTERN_STEPS - 1);
  const bar = i < 8 ? 1 : 2;
  const beat = Math.floor((i % 8) / 2) + 1;
  const off = i % 2 === 1 ? '+' : '';
  return `${bar}.${beat}${off}`;
}

/** Automatically suggest a slice index for pattern `step` based on the break's rhythmic position. */
export function suggestedSliceForStep(breakId, step, len = BREAK_PATTERN_STEPS) {
  const count = breakSliceCount(breakId);
  const patLen = Math.max(1, Math.round(num(len, BREAK_PATTERN_STEPS)));
  const s = ((Math.trunc(num(step, 0)) % patLen) + patLen) % patLen;
  return clamp(Math.floor((s * count) / patLen), 0, count - 1);
}

/** Human-readable identity for a slice on a given break source (number, code, label, role, rhythmic pos). */
export function breakSliceInfo(breakId, sliceIndex) {
  const count = breakSliceCount(breakId);
  const index = clampBreakSlice(breakId, sliceIndex, 0);
  const desc = getBuiltinBreak(breakId);
  const meta = desc && Array.isArray(desc.sliceMeta) ? desc.sliceMeta[index] : null;
  const posStep = Math.floor((index * BREAK_PATTERN_STEPS) / count);
  return {
    index,
    number: index + 1,
    code: `S${index + 1}`,
    label: meta ? meta.label : `Slice ${index + 1}`,
    role: meta ? meta.role : 'perc',
    pos: breakStepBeatLabel(posStep),
  };
}

/**
 * Explicit unedited vs. edited distinction for one RUFF lane in a scene pattern.
 * - Unedited (false): plays original whole-loop break; opening the sequencer never mutates project data.
 * - Edited (true): plays the lane's 16-step slice cells; if all cells are null, the lane stays silent
 *   instead of falling back to whole-loop playback.
 * Also treats any lane that already carries non-null cells (e.g. direct programmatic fixtures) as edited.
 */
export function isBreakLaneEdited(pattern, lane) {
  if (!pattern || !BREAK_LANES.includes(lane)) return false;
  if (pattern.edited && pattern.edited[lane]) return true;
  const row = pattern.lanes && pattern.lanes[lane];
  return Array.isArray(row) && row.some(Boolean);
}

/** Build the 16-step original-groove cell array for first-edit conversion of a break lane. */
export function originalGrooveRow(breakId, len = BREAK_PATTERN_STEPS) {
  const n = Math.max(1, Math.round(num(len, BREAK_PATTERN_STEPS)));
  return Array.from({ length: n }, (_, i) => ({
    slice: suggestedSliceForStep(breakId, i, n),
    v: 1,
    p: 1,
  }));
}

/**
 * Pure, non-mutating view of a lane's 16 steps for UI rendering.
 * Unedited assigned lanes return virtual original-groove cells (`virtual: true`) so the groove
 * is immediately visible without touching project data. Edited lanes return their actual cells
 * with slice indices resolved/clamped safely for the currently assigned break source.
 */
export function effectiveBreakRow(pattern, lane, breakId) {
  const len = (pattern && pattern.len) || BREAK_PATTERN_STEPS;
  if (isBreakLaneEdited(pattern, lane)) {
    const row = (pattern.lanes && pattern.lanes[lane]) || [];
    return Array.from({ length: len }, (_, i) => {
      const c = row[i];
      if (!c) return null;
      const slice = clampBreakSlice(breakId, c.slice != null ? c.slice : suggestedSliceForStep(breakId, i, len));
      return { ...c, slice, virtual: false };
    });
  }
  if (!breakId) return Array(len).fill(null);
  return Array.from({ length: len }, (_, i) => ({
    slice: suggestedSliceForStep(breakId, i, len),
    v: 1,
    p: 1,
    virtual: true,
  }));
}

/** True when a RUFF slot has audible content in `pattern` (either an unedited assigned break or an edited hit). */
export function breakSlotHasContent(slot, pattern) {
  if (!slot || !slot.breaks || !pattern) return false;
  return BREAK_LANES.some(l => {
    if (!slot.breaks[l]) return false;
    if (isBreakLaneEdited(pattern, l)) {
      const row = pattern.lanes && pattern.lanes[l];
      return Array.isArray(row) && row.some(Boolean);
    }
    return true;
  });
}
