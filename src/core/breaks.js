// Built-in Break Pool and tempo-fit math for RUFF (v0.7 PR2): pure data + functions (no DOM, no Web Audio),
// so they run unchanged in Node tests and the browser.
//
// Built-in break IDs use the stable `brk-builtin-*` prefix so they remain clearly distinguishable from
// future user-imported samples (`smp-<sha256>`).

import { BREAK_LANES } from './instruments.js';
import {
  barsSeconds, defaultSlices, cleanSlices, fitModeOf, sliceCount, sliceAt,
  isSampleId, remapSliceIndexes, MAX_SLICES,
} from './samples.js';
import { clamp, isObj, num } from './util.js';

export const BUILTIN_BREAK_PREFIX = 'brk-builtin-';
/** playback speed ratio bounds for breaks across HarbuMatic's 50–200 BPM range */
export const BREAK_RATIO_RANGE = Object.freeze([0.25, 4]);
/** Approved 16-step RUFF sequencer spans 2 bars (32 transport 16th-steps) at 8th-note step resolution */
export const BREAK_PATTERN_STEPS = 16;
export const BREAK_BARS_DEFAULT = 2;
export const BREAK_STEP_SPAN = 2;
export const BREAK_LOOP_STEPS = BREAK_PATTERN_STEPS * BREAK_STEP_SPAN;
export const IMPORTED_BREAK_BARS = Object.freeze([1, 2, 4]);
export const BREAK_BPM_RANGE = Object.freeze([50, 200]);

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
export const isImportedBreakId = id => isSampleId(id);
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

/** Exact BPM for a loop of `duration` seconds spanning `bars` bars (clamped to valid range). */
export function bpmForBars(duration, bars) {
  const d = num(duration, 0);
  const b = IMPORTED_BREAK_BARS.includes(bars) ? bars : BREAK_BARS_DEFAULT;
  if (!(d > 0)) return 120;
  return clamp(Math.round(((b * 4 * 60) / d) * 10) / 10, BREAK_BPM_RANGE[0], BREAK_BPM_RANGE[1]);
}

/** Format bar.beat position string for normalized fraction `pos` in a `bars`-bar break. */
export function breakPosBeatLabel(pos, bars = BREAK_BARS_DEFAULT) {
  const b = IMPORTED_BREAK_BARS.includes(bars) ? bars : BREAK_BARS_DEFAULT;
  const totalEighths = b * 8;
  const idx = clamp(Math.round(clamp(num(pos, 0), 0, 1) * totalEighths), 0, totalEighths - 1);
  const bar = Math.floor(idx / 8) + 1;
  const beat = Math.floor((idx % 8) / 2) + 1;
  const off = idx % 2 === 1 ? '+' : '';
  return `${bar}.${beat}${off}`;
}

function cleanSliceFeature(f, pos, bars) {
  const src = isObj(f) ? f : {};
  return {
    pos: Math.round(clamp(num(src.pos, pos), 0, 1) * 1e6) / 1e6,
    energy: Math.round(num(src.energy, 0.5, 0, 1) * 1000) / 1000,
    transient: Math.round(num(src.transient, 0.5, 0, 1) * 1000) / 1000,
    lowEnergy: Math.round(num(src.lowEnergy, 0.5, 0, 1) * 1000) / 1000,
    highEnergy: Math.round(num(src.highEnergy, 0.5, 0, 1) * 1000) / 1000,
    beatPos: typeof src.beatPos === 'string' && src.beatPos.trim() ? src.beatPos.trim().slice(0, 12) : breakPosBeatLabel(pos, bars),
  };
}

function cleanAnalysisSummary(a, fallbackBpm, fallbackBars) {
  if (!isObj(a)) return null;
  const conf = ['high', 'medium', 'low'].includes(a.confidence) ? a.confidence : 'medium';
  const estBars = IMPORTED_BREAK_BARS.includes(a.estimatedBars) ? a.estimatedBars : fallbackBars;
  const estBpm = Math.round(num(a.estimatedBpm, fallbackBpm, BREAK_BPM_RANGE[0], BREAK_BPM_RANGE[1]) * 10) / 10;
  let ambiguity = null;
  if (isObj(a.ambiguity) && a.ambiguity.kind === 'half-double' && Array.isArray(a.ambiguity.alternatives)) {
    const alts = a.ambiguity.alternatives
      .filter(x => isObj(x) && IMPORTED_BREAK_BARS.includes(x.bars))
      .slice(0, 2)
      .map(x => ({
        bars: x.bars,
        bpm: Math.round(num(x.bpm, estBpm, BREAK_BPM_RANGE[0], BREAK_BPM_RANGE[1]) * 10) / 10,
        factor: x.factor === 2 ? 2 : 0.5,
      }));
    if (alts.length) ambiguity = { kind: 'half-double', alternatives: alts };
  }
  return {
    estimatedBpm: estBpm,
    estimatedBars: estBars,
    confidence: conf,
    fallback: !!a.fallback,
    transientCount: Math.max(0, Math.round(num(a.transientCount, 0, 0, 512))),
    ambiguity,
    note: typeof a.note === 'string' ? a.note.trim().slice(0, 160) : '',
  };
}

/** Validate/repair metadata for one user-imported WAV break (pure, idempotent). */
export function cleanImportedBreakMeta(raw) {
  if (!isObj(raw) || !isImportedBreakId(raw.id)) return null;
  const duration = num(raw.duration, 0, 0, 3600);
  const bars = IMPORTED_BREAK_BARS.includes(raw.bars) ? raw.bars : BREAK_BARS_DEFAULT;
  const defaultBpm = duration > 0 ? bpmForBars(duration, bars) : 120;
  const bpm = Math.round(num(raw.bpm, defaultBpm, BREAK_BPM_RANGE[0], BREAK_BPM_RANGE[1]) * 10) / 10;
  const slices = cleanSlices(Array.isArray(raw.slices) ? raw.slices : defaultSlices(bars === 1 ? 8 : MAX_SLICES));
  const count = Math.max(1, sliceCount(slices));
  const rawMeta = Array.isArray(raw.sliceMeta) ? raw.sliceMeta : [];
  const sliceMeta = Array.from({ length: count }, (_, k) => cleanSliceFeature(rawMeta[k], slices[k], bars));
  const out = {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : 'Imported Break',
    duration,
    sampleRate: Math.round(num(raw.sampleRate, 44100, 0, 384000)),
    channels: Math.round(num(raw.channels, 2, 0, 32)),
    bpm,
    bars,
    slices,
    sliceMeta,
  };
  const analysis = cleanAnalysisSummary(raw.analysis, bpm, bars);
  if (analysis) out.analysis = analysis;
  return out;
}

/** Validate/repair a `{ [smpId]: ImportedBreakMeta }` map (optionally keeping only IDs assigned in `assignedBreaks`). */
export function cleanBreakMetaMap(raw, assignedBreaks = null) {
  const out = {};
  if (!isObj(raw)) return out;
  const allow = assignedBreaks
    ? new Set(Object.values(assignedBreaks).filter(id => isImportedBreakId(id)))
    : null;
  for (const [k, v] of Object.entries(raw)) {
    if (!isImportedBreakId(k)) continue;
    if (allow && !allow.has(k)) continue;
    const clean = cleanImportedBreakMeta(isObj(v) ? { ...v, id: k } : null);
    if (clean) out[k] = clean;
  }
  return out;
}

/** Resolve a break descriptor from built-ins first, then an optional imported breakMeta map. */
export function resolveBreakDesc(breakId, breakMeta = null) {
  if (!breakId || typeof breakId !== 'string') return null;
  const builtin = getBuiltinBreak(breakId);
  if (builtin) return builtin;
  if (isObj(breakMeta) && isObj(breakMeta[breakId])) return breakMeta[breakId];
  return null;
}

/** Bar length (1, 2 or 4) of a break source. */
export function breakBarsOf(breakId, breakMeta = null) {
  const desc = resolveBreakDesc(breakId, breakMeta);
  return desc && IMPORTED_BREAK_BARS.includes(desc.bars) ? desc.bars : BREAK_BARS_DEFAULT;
}

/** Native/corrected BPM of a break source. */
export function breakBpmOf(breakId, breakMeta = null) {
  const desc = resolveBreakDesc(breakId, breakMeta);
  return desc && Number.isFinite(desc.bpm) && desc.bpm > 0 ? desc.bpm : 120;
}

/** Transport 16th-steps spanned by one full unedited cycle of this break (16 for 1 bar, 32 for 2 bars, 64 for 4 bars). */
export function breakSourceLoopSteps(breakId, breakMeta = null) {
  return breakBarsOf(breakId, breakMeta) * 16;
}

/**
 * Tempo-fit math for a break loop of `duration` seconds spanning `bars` bars at project `bpm`.
 *   stretch (default): output/input stretch factor = target / source; playbackRate stays 1 (pitch preserved)
 *   tape:              stretch = 1; playbackRate = source / target (tempo & pitch move together)
 * When `sourceBpm` is provided (user-verified/corrected BPM on an imported break), the timing ratio follows
 * `bpm / sourceBpm` directly so manual BPM corrections update playback timing non-destructively.
 */
export function breakFitPlayback(params, duration, bars, bpm, sourceBpm = null) {
  const mode = fitModeOf(params);
  const source = Math.max(0, num(duration, 0));
  const b = Math.max(0.5, num(bars, 2));
  const target = bpm > 0 ? barsSeconds(b, bpm) : 0;
  const srcBpm = num(sourceBpm, 0);
  if (!(source > 0) || !(target > 0)) {
    return { mode, bars: b, source, target, ratio: 1, rate: 1, pitchRate: 1, stretch: 1 };
  }
  const ratio = srcBpm > 0 ? (bpm / srcBpm) : (source / target);
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

/* ---------- Break-aware slicing & 2-bar / 16-step mapping (v0.7 PR3–PR35) ---------- */

/** Slice boundary list for a break source (built-in or user-imported). */
export function breakSlicesOf(breakId, breakMeta = null) {
  const desc = resolveBreakDesc(breakId, breakMeta);
  return (desc && Array.isArray(desc.slices) && desc.slices.length >= 2) ? desc.slices : SLICES_16;
}

/** Number of addressable slices in a break source. */
export function breakSliceCount(breakId, breakMeta = null) {
  return Math.max(1, sliceCount(breakSlicesOf(breakId, breakMeta)));
}

/** Keep a slice index strictly valid [0, count - 1] for the given break source. */
export function clampBreakSlice(breakId, sliceIndex, fallback = 0, breakMeta = null) {
  const count = breakSliceCount(breakId, breakMeta);
  const raw = Number.isFinite(sliceIndex) ? Math.trunc(sliceIndex) : Math.trunc(num(fallback, 0));
  return clamp(raw, 0, count - 1);
}

/**
 * Explicit mapping between 16-step RUFF pattern and transport 16th-steps for a break source.
 * Built-in breaks are 2 bars (32 transport 16th-steps) → stepSpan = 2 (each pattern step = 1 eighth-note),
 * so steps 0–7 span Bar 1 and steps 8–15 span Bar 2 with zero half-break truncation.
 */
export function breakStepTiming(breakId, len = BREAK_PATTERN_STEPS, breakMeta = null) {
  const bars = breakBarsOf(breakId, breakMeta);
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

/** Automatically suggest a slice index for pattern `step` based on the break's rhythmic position and bar length. */
export function suggestedSliceForStep(breakId, step, len = BREAK_PATTERN_STEPS, breakMeta = null) {
  const count = breakSliceCount(breakId, breakMeta);
  const patLen = Math.max(1, Math.round(num(len, BREAK_PATTERN_STEPS)));
  const s = ((Math.trunc(num(step, 0)) % patLen) + patLen) % patLen;
  if (isBuiltinBreakId(breakId) || !isImportedBreakId(breakId)) {
    return clamp(Math.floor((s * count) / patLen), 0, count - 1);
  }
  const desc = resolveBreakDesc(breakId, breakMeta);
  const slices = breakSlicesOf(breakId, breakMeta);
  const bars = desc && IMPORTED_BREAK_BARS.includes(desc.bars) ? desc.bars : BREAK_BARS_DEFAULT;
  // Sequencer step `s` (0..15) is an 8th-note inside the 2-bar (16 eighth-note) RUFF grid:
  //   1-bar source: repeats every 8 steps → fraction ((s % 8) / 8)
  //   2-bar source: 1:1 over 16 steps    → fraction (s / 16)
  //   4-bar source: covers Bars 1–2      → fraction (s / 32)
  const frac = bars === 1 ? ((s % 8) / 8) : bars === 4 ? (s / 32) : (s / patLen);
  return clamp(sliceAt(slices, frac), 0, count - 1);
}

/** Human-readable identity for a slice on a given break source (number, code, label, role, rhythmic pos). */
export function breakSliceInfo(breakId, sliceIndex, breakMeta = null) {
  const count = breakSliceCount(breakId, breakMeta);
  const index = clampBreakSlice(breakId, sliceIndex, 0, breakMeta);
  const desc = resolveBreakDesc(breakId, breakMeta);
  const meta = desc && Array.isArray(desc.sliceMeta) ? desc.sliceMeta[index] : null;
  if (isBuiltinBreakId(breakId)) {
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
  const slices = breakSlicesOf(breakId, breakMeta);
  const bars = breakBarsOf(breakId, breakMeta);
  const frac = slices[index] ?? (index / count);
  const pos = (meta && typeof meta.beatPos === 'string' && meta.beatPos) ? meta.beatPos : breakPosBeatLabel(frac, bars);
  return {
    index,
    number: index + 1,
    code: `S${index + 1}`,
    label: `Hit ${index + 1} · ${pos}`,
    role: 'imported',
    pos,
    energy: meta && Number.isFinite(meta.energy) ? meta.energy : 0.5,
    transient: meta && Number.isFinite(meta.transient) ? meta.transient : 0.5,
    lowEnergy: meta && Number.isFinite(meta.lowEnergy) ? meta.lowEnergy : 0.5,
    highEnergy: meta && Number.isFinite(meta.highEnergy) ? meta.highEnergy : 0.5,
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
export function originalGrooveRow(breakId, len = BREAK_PATTERN_STEPS, breakMeta = null) {
  const n = Math.max(1, Math.round(num(len, BREAK_PATTERN_STEPS)));
  if (!isImportedBreakId(breakId)) {
    return Array.from({ length: n }, (_, i) => ({
      slice: suggestedSliceForStep(breakId, i, n, breakMeta),
      v: 1,
      p: 1,
    }));
  }
  const desc = resolveBreakDesc(breakId, breakMeta);
  const slices = breakSlicesOf(breakId, breakMeta);
  const count = Math.max(1, sliceCount(slices));
  const bars = desc && IMPORTED_BREAK_BARS.includes(desc.bars) ? desc.bars : BREAK_BARS_DEFAULT;
  const row = Array(n).fill(null);
  if (bars === 1) {
    // Place each 1-bar slice at its 8th-note onset in Bar 1 and repeat cleanly in Bar 2
    const barSteps = Math.max(1, Math.floor(n / 2));
    for (let k = 0; k < count; k++) {
      const s = clamp(Math.round(slices[k] * barSteps), 0, barSteps - 1);
      if (!row[s]) row[s] = { slice: k, v: 1, p: 1 };
    }
    if (!row[0]) row[0] = { slice: 0, v: 1, p: 1 };
    for (let i = 0; i < barSteps && i + barSteps < n; i++) {
      row[i + barSteps] = row[i] ? { ...row[i] } : null;
    }
    return row;
  }
  if (bars === 4) {
    // Map Bars 1–2 slice onsets ([0, 0.5)) onto the 2-bar / 16-step grid without stutter-retriggering;
    // all Bars 3–4 slices stay addressable in the inspector and CHOP IT!.
    for (let k = 0; k < count; k++) {
      if (slices[k] >= 0.5 - 1e-6) break;
      const s = clamp(Math.round(slices[k] * n * 2), 0, n - 1);
      if (!row[s]) row[s] = { slice: k, v: 1, p: 1 };
    }
    if (!row[0]) row[0] = { slice: 0, v: 1, p: 1 };
    return row;
  }
  // 2-bar imported break: map each slice onset across the 16 eighth-note steps
  for (let k = 0; k < count; k++) {
    const s = clamp(Math.round(slices[k] * n), 0, n - 1);
    if (!row[s]) row[s] = { slice: k, v: 1, p: 1 };
  }
  if (!row[0]) row[0] = { slice: 0, v: 1, p: 1 };
  return row;
}

/**
 * Pure, non-mutating view of a lane's 16 steps for UI rendering.
 * Unedited assigned lanes return virtual original-groove cells (`virtual: true`) so the groove
 * is immediately visible without touching project data. Edited lanes return their actual cells
 * with slice indices resolved/clamped safely for the currently assigned break source.
 */
export function effectiveBreakRow(pattern, lane, breakId, breakMeta = null) {
  const len = (pattern && pattern.len) || BREAK_PATTERN_STEPS;
  if (isBreakLaneEdited(pattern, lane)) {
    const row = (pattern.lanes && pattern.lanes[lane]) || [];
    return Array.from({ length: len }, (_, i) => {
      const c = row[i];
      if (!c) return null;
      const slice = clampBreakSlice(breakId, c.slice != null ? c.slice : suggestedSliceForStep(breakId, i, len, breakMeta), 0, breakMeta);
      return { ...c, slice, virtual: false };
    });
  }
  if (!breakId) return Array(len).fill(null);
  return originalGrooveRow(breakId, len, breakMeta).map(c => (c ? { ...c, virtual: true } : null));
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

/**
 * Remap every edited slice cell referencing `breakId` across all scenes and snapshots of a RUFF slot
 * after structural slice boundary edits (insert/delete/reset). Preserves locks and untouched lanes.
 */
export function remapBreakSlotSlices(project, slotId, breakId, oldSlices, newSlices) {
  const slot = project && Array.isArray(project.slots) ? project.slots.find(s => s.id === slotId) : null;
  if (!slot || !slot.breaks || !breakId) return 0;
  const lanes = BREAK_LANES.filter(l => slot.breaks[l] === breakId);
  if (!lanes.length) return 0;
  const map = remapSliceIndexes(oldSlices, newSlices);
  let changed = 0;
  const applyPattern = p => {
    if (!p || !p.lanes) return;
    for (const l of lanes) {
      const row = p.lanes[l];
      if (!Array.isArray(row)) continue;
      for (const c of row) {
        if (!c || !Number.isInteger(c.slice)) continue;
        const to = map[c.slice];
        if (Number.isInteger(to) && to !== c.slice) { c.slice = to; changed++; }
      }
    }
  };
  for (const p of Object.values(slot.patterns || {})) applyPattern(p);
  for (const snap of project.snaps || []) {
    const e = snap && snap.slots && snap.slots[slotId];
    if (e && e.type === slot.type) applyPattern(e.pattern);
  }
  return changed;
}

/* ---------- Break-pattern lock & silence helpers (v0.7 PR34) ---------- */

/** Persistent key inside `pattern.locked` for an individual per-lane step cell (populated or empty). */
export const breakCellLockKey = (lane, step) => `${lane}:${step}`;

/** True when an entire RUFF lane (A/B/C) is locked. */
export function isBreakLaneLocked(pattern, lane) {
  return !!(pattern && BREAK_LANES.includes(lane) && pattern.locked && pattern.locked[lane]);
}

/** True when a full step column across A/B/C is locked. */
export function isBreakStepColumnLocked(pattern, step) {
  return !!(pattern && Number.isInteger(step) && step >= 0 && pattern.locked && pattern.locked[String(step)]);
}

/** True when a specific (lane, step) cell is directly locked (via `pattern.locked['a:4']` or legacy `cell.locked`). */
export function isBreakCellDirectlyLocked(pattern, lane, step) {
  if (!pattern || !BREAK_LANES.includes(lane) || !Number.isInteger(step) || step < 0) return false;
  if (pattern.locked && pattern.locked[breakCellLockKey(lane, step)]) return true;
  const cell = pattern.lanes && pattern.lanes[lane] && pattern.lanes[lane][step];
  return !!(cell && cell.locked);
}

/** True when (lane, step) is protected by a lane lock, column lock, or direct cell lock (including locked empty cells). */
export function isBreakCellLocked(pattern, lane, step) {
  return isBreakLaneLocked(pattern, lane)
    || isBreakStepColumnLocked(pattern, step)
    || isBreakCellDirectlyLocked(pattern, lane, step);
}

/** True when a lane was explicitly edited to complete silence (edited flag set, zero populated steps). */
export function isBreakLaneExplicitlySilent(pattern, lane) {
  if (!pattern || !BREAK_LANES.includes(lane)) return false;
  if (!isBreakLaneEdited(pattern, lane)) return false;
  const row = pattern.lanes && pattern.lanes[lane];
  return !Array.isArray(row) || !row.some(Boolean);
}

