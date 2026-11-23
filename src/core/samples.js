// Sample references and slice maths for MUNCH: pure data + functions (no DOM, no Web Audio, no IndexedDB),
// so they run unchanged in Node.
//
// A sampler slot (registry capability `samples`) holds   slot.sample = null | SampleRef
//   SampleRef = { id, name, duration, sampleRate, channels, slices }
//     id          'smp-' + hex SHA-256 of the original file bytes (content address: the same file always gets the
//                 same id, so a missing sample comes back by importing the same file again)
//     name        original filename (shown in warnings when the asset is missing on this device)
//     duration    seconds, sampleRate, channels: metadata copied from the asset, used before it is decoded
//     slices      slice boundaries: strictly increasing positions in [0, 1] of the whole (untrimmed) sample.
//                 Slice k plays from slices[k] to slices[k + 1]; n + 1 boundaries make n contiguous slices.
//                 Default: 9 boundaries = 8 equal slices. Trim (start/end params) applies to melodic notes only.
// The audio bytes themselves never go into the project: they live in the sample store (src/samples/store.js).
//
// Note events (src/core/project.js) gain an optional `slice` field on sampler slots:
//   { s, p, l, v, … }            melodic: plays the trimmed sample, transposed by p − params.root semitones
//   { s, p, l, v, slice: k, … }  slice k: transposed by p − SLICE_REF_PITCH (so p = 60 plays the slice as recorded)

import { isObj, num } from './util.js';

export const SAMPLE_ID_RE = /^smp-[0-9a-f]{16,64}$/;
export const DEFAULT_SLICE_COUNT = 8;
/** most slices a sample may carry (room for transient detection later); slice indexes are 0 … MAX_SLICES − 1 */
export const MAX_SLICES = 16;
/** pitch at which a slice note plays the slice untransposed */
export const SLICE_REF_PITCH = 60;
/** smallest slice, as a fraction of the sample (also guards against zero-length regions) */
export const MIN_SLICE = 1e-3;
export const PLAY_MODES = Object.freeze(['oneshot', 'gate', 'loop']);

export const isSampleId = v => typeof v === 'string' && SAMPLE_ID_RE.test(v);

/** n equal slices as n + 1 boundaries (rounded so they are stable through JSON) */
export function defaultSlices(n = DEFAULT_SLICE_COUNT) {
  n = Math.max(1, Math.min(MAX_SLICES, Math.round(n)));
  return Array.from({ length: n + 1 }, (_, i) => Math.round((i / n) * 1e6) / 1e6);
}

/**
 * Repair a boundary list: numbers only, clamped to [0, 1], sorted, every slice at least MIN_SLICE long, at most
 * MAX_SLICES slices. Anything that cannot form one slice falls back to the default eight. Idempotent.
 */
export function cleanSlices(list) {
  if (!Array.isArray(list)) return defaultSlices();
  const xs = list.filter(x => typeof x === 'number' && Number.isFinite(x)).map(x => Math.min(1, Math.max(0, x))).sort((a, b) => a - b);
  const out = [];
  for (const x of xs) if (!out.length || x - out[out.length - 1] >= MIN_SLICE - 1e-12) out.push(x);
  if (out.length < 2) return defaultSlices();
  return out.slice(0, MAX_SLICES + 1);
}

/** move one boundary, keeping its neighbours MIN_SLICE away; returns a new list (the input is not mutated) */
export function moveSliceBoundary(slices, i, pos) {
  const b = cleanSlices(slices).slice();
  if (!Number.isInteger(i) || i < 0 || i >= b.length) return b;
  const lo = i > 0 ? b[i - 1] + MIN_SLICE : 0, hi = i < b.length - 1 ? b[i + 1] - MIN_SLICE : 1;
  b[i] = Math.round(Math.min(hi, Math.max(lo, num(pos, b[i]))) * 1e6) / 1e6;
  return b;
}

export const sliceCount = slices => Math.max(0, (Array.isArray(slices) ? slices.length : 0) - 1);

/** [start, end] of slice k as fractions of the sample, or null when the slice does not exist */
export function sliceRegion(slices, k) {
  if (!Number.isInteger(k) || k < 0 || k >= sliceCount(slices)) return null;
  return [slices[k], slices[k + 1]];
}

/** the trimmed region a melodic note plays, as fractions; always at least MIN_SLICE long */
export function trimRegion(params) {
  let a = num(params.start, 0, 0, 1), b = num(params.end, 1, 0, 1);
  if (b - a < MIN_SLICE) { if (a + MIN_SLICE <= 1) b = a + MIN_SLICE; else { a = 1 - MIN_SLICE; b = 1; } }
  return [a, b];
}

/**
 * Seconds to play inside the buffer that is actually used: the forward buffer, or its reversed copy when
 * `reverse` is on (the region is mirrored, so a reversed slice still covers exactly the same audio).
 */
export function bufferRegion([a, b], duration, reverse = false) {
  const [x, y] = reverse ? [1 - b, 1 - a] : [a, b];
  return { offset: x * duration, length: (y - x) * duration };
}

/** semitones → playback rate (equal temperament): +12 = ×2, −12 = ×0.5 */
export const rateForSemitones = st => Math.pow(2, st / 12);
/** semitone offset a note plays at: melodic notes relative to the root, slice notes relative to SLICE_REF_PITCH */
export function noteSemitones(note, params) {
  const tune = num(params.tune, 0);
  return note.slice != null ? note.p - SLICE_REF_PITCH + tune : note.p - num(params.root, SLICE_REF_PITCH) + tune;
}

/**
 * Unknown keys a later HarbuMatic may add (e.g. to a sample reference or MUNCH params) are kept instead of being
 * dropped, so a song survives a round trip through this build. Only primitive values are kept (finite numbers,
 * booleans, strings up to 200 characters), at most 32 keys.
 */
export function extraKeys(src, known) {
  const out = {};
  if (!isObj(src)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(src)) {
    if (known.includes(k) || n >= 32 || k === '__proto__' || k.length > 40) continue;
    if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 200)) { out[k] = v; n++; }
  }
  return out;
}
const REF_KEYS = ['id', 'name', 'duration', 'sampleRate', 'channels', 'slices'];

/** repair a stored sample reference; null when there is nothing a sample store could resolve */
export function cleanSampleRef(ref) {
  if (!isObj(ref) || !isSampleId(ref.id)) return null;
  return {
    ...extraKeys(ref, REF_KEYS),
    id: ref.id,
    name: typeof ref.name === 'string' && ref.name.trim() ? ref.name.trim().slice(0, 80) : 'Sample',
    duration: num(ref.duration, 0, 0, 3600),
    sampleRate: Math.round(num(ref.sampleRate, 0, 0, 384000)),
    channels: Math.round(num(ref.channels, 0, 0, 32)),
    slices: cleanSlices(ref.slices),
  };
}

/** a fresh reference for an asset's metadata (default eight slices) */
export function sampleRefFor(meta, slices = defaultSlices()) {
  return cleanSampleRef({ id: meta.id, name: meta.name, duration: meta.duration, sampleRate: meta.sampleRate, channels: meta.channels, slices });
}

/** every sample id a project references (in slot order, without duplicates) */
export function sampleRefsOf(project) {
  const out = [];
  for (const s of (project && project.slots) || []) if (s.sample && isSampleId(s.sample.id) && !out.includes(s.sample.id)) out.push(s.sample.id);
  return out;
}

/* ---------------------------------------------------------
   Slice editing (v0.6 Phase 4) — structural edits + deterministic note remapping
   ---------------------------------------------------------
   Notes refer to slices by index. Structural edits (insert, split, delete, reset) change indexes, so every such edit
   is paired with remapSliceIndexes(): an old slice maps to the new slice that contains its *start* position (its
   attack). Moving a boundary is not structural: indexes keep their identity, only the region changes.
   See docs/MUNCH-PHASE4.md §3.1. */

const r6 = x => Math.round(x * 1e6) / 1e6;

/**
 * Add a boundary at `pos` (fraction of the whole sample). Returns { slices, at } with the index of the new boundary,
 * or { slices: unchanged, error } when it cannot be added: 'max' (already MAX_SLICES slices), 'close' (closer than
 * MIN_SLICE to a boundary) or 'range' (not a number in [0, 1]).
 */
export function insertSliceBoundary(slices, pos) {
  const b = cleanSlices(slices);
  if (typeof pos !== 'number' || !Number.isFinite(pos) || pos < 0 || pos > 1) return { slices: b, error: 'range' };
  if (sliceCount(b) >= MAX_SLICES) return { slices: b, error: 'max' };
  const x = r6(pos);
  if (b.some(y => Math.abs(y - x) < MIN_SLICE - 1e-12)) return { slices: b, error: 'close' };
  const out = [...b, x].sort((p, q) => p - q);
  return { slices: out, at: out.indexOf(x) };
}

/** split slice k in the middle (same result shape as insertSliceBoundary; 'none' when slice k does not exist) */
export function splitSlice(slices, k) {
  const b = cleanSlices(slices), reg = sliceRegion(b, k);
  if (!reg) return { slices: b, error: 'none' };
  return insertSliceBoundary(b, (reg[0] + reg[1]) / 2);
}

/**
 * Remove boundary i, merging the slices on both sides. Only inner boundaries can be removed (the outer ones frame the
 * sliced area; move them instead). Returns { slices } or { slices: unchanged, error: 'edge' | 'none' }.
 */
export function removeSliceBoundary(slices, i) {
  const b = cleanSlices(slices);
  if (!Number.isInteger(i) || i < 0 || i >= b.length) return { slices: b, error: 'none' };
  if (i === 0 || i === b.length - 1) return { slices: b, error: 'edge' };
  return { slices: b.filter((_, j) => j !== i) };
}

/** index of the slice that contains position x (positions before the first / after the last slice clamp to it) */
export function sliceAt(slices, x) {
  const n = sliceCount(slices);
  if (!n) return -1;
  for (let k = n - 1; k >= 0; k--) if (x >= slices[k] - 1e-9) return k;
  return 0;
}

/**
 * Old slice index → new slice index after a structural edit: the new slice that contains the old slice's start.
 * Indexes the old list did not have (notes that played nothing) keep their distance past the end, so they stay silent
 * instead of turning into an unrelated slice.
 */
export function remapSliceIndexes(oldSlices, newSlices) {
  const a = cleanSlices(oldSlices), b = cleanSlices(newSlices), na = sliceCount(a), nb = sliceCount(b);
  return Array.from({ length: MAX_SLICES }, (_, k) => (k < na ? sliceAt(b, a[k]) : Math.min(MAX_SLICES - 1, k - na + nb)));
}

/** apply an index map to the slice notes of one pattern (in place); returns how many notes changed slice */
export function remapPatternSlices(pattern, map) {
  let changed = 0;
  if (!pattern || !Array.isArray(pattern.notes)) return 0;
  for (const n of pattern.notes) {
    if (!Number.isInteger(n.slice)) continue;
    const to = map[n.slice];
    if (Number.isInteger(to) && to !== n.slice) { n.slice = to; changed++; }
  }
  return changed;
}

/**
 * Remap every slice note of one slot after its boundaries changed from oldSlices to newSlices: all scenes and all
 * snapshots that hold this slot (same type). Mutates the project; returns the number of notes that changed slice.
 */
export function remapSlotSlices(project, slotId, oldSlices, newSlices) {
  const slot = project.slots.find(s => s.id === slotId);
  if (!slot) return 0;
  const map = remapSliceIndexes(oldSlices, newSlices);
  let changed = 0;
  for (const p of Object.values(slot.patterns || {})) changed += remapPatternSlices(p, map);
  for (const snap of project.snaps || []) {
    const e = snap && snap.slots && snap.slots[slotId];
    if (e && e.type === slot.type) changed += remapPatternSlices(e.pattern, map);
  }
  return changed;
}

/* ---------------------------------------------------------
   Fit to Beat: fit the active (trimmed) region to whole bars at the project tempo. Two modes (fitMode):
     stretch (default)  the duration changes, the pitch does not: the sample is time-stretched (src/samples/stretch.js)
     tape               classic sampler: playback speed changes duration and pitch together
   Timing is identical in both modes: the region lasts exactly `bars` bars at the current BPM. The time ratio
     ratio = source / target × (1 + fitFine)      (source = trimmed seconds, target = bars × 4 × 60 / bpm)
   is computed at trigger time, so a BPM change re-fits at once. Pitch of a note:
     tape     2^((transpose + tune) / 12) × ratio
     stretch  2^((transpose + tune) / 12)          (the stretched copy is played at the musical pitch only)
   Root, transposition, tune and fit stay separate values. See docs/MUNCH-STABILIZATION.md.
   --------------------------------------------------------- */
export const FIT_CHOICES = Object.freeze(['off', 'half', '1', '2', '4']);
export const FIT_MODES = Object.freeze(['stretch', 'tape']);
export const FIT_BARS = Object.freeze({ half: .5, 1: 1, 2: 2, 4: 4 });
/** time ratios a fit may use: ±1 octave keeps tape usable and stretch artefacts acceptable */
export const FIT_RANGE = Object.freeze([.5, 2]);
export const FIT_FINE_RANGE = Object.freeze([-.12, .12]);
export const BEATS_PER_BAR = 4; // 4/4: the only meter HarbuMatic has

/** seconds of `bars` bars of 4/4 at `bpm` */
export const barsSeconds = (bars, bpm) => bars * BEATS_PER_BAR * 60 / bpm;
export const fitModeOf = params => (params && params.fitMode === 'tape' ? 'tape' : 'stretch');

/**
 * Everything about a fit choice for a sample of `duration` seconds at `bpm`:
 *   { on, mode, bars, source, target, ratio, rate, ok, clamped, semitones, pitchRate, stretch }
 * ratio      = source / target × (1 + fitFine)   (what an exact fit needs)
 * rate       = ratio clamped to FIT_RANGE        (the time ratio playback uses); 1 when off
 * ok         = the exact fit is inside FIT_RANGE
 * pitchRate  = the playback-rate share that changes pitch: rate (tape) or 1 (stretch)
 * semitones  = the pitch change the fit causes (0 in stretch mode)
 * stretch    = the time-stretch factor of the buffer (1 / rate in stretch mode, 1 for tape)
 */
export function fitInfo(params, duration, bpm, choice = params && params.fit) {
  const bars = FIT_BARS[choice], mode = fitModeOf(params);
  const [a, b] = trimRegion(params || {});
  const source = Math.max(0, num(duration, 0)) * (b - a);
  if (!bars || !(source > 0) || !(bpm > 0)) return { on: false, mode, bars: 0, source, target: 0, ratio: 1, rate: 1, ok: true, clamped: false, semitones: 0, pitchRate: 1, stretch: 1 };
  const target = barsSeconds(bars, bpm), fine = num(params.fitFine, 0, FIT_FINE_RANGE[0], FIT_FINE_RANGE[1]);
  const ratio = source / target * (1 + fine);
  const rate = Math.min(FIT_RANGE[1], Math.max(FIT_RANGE[0], ratio));
  const ok = ratio >= FIT_RANGE[0] - 1e-9 && ratio <= FIT_RANGE[1] + 1e-9;
  const tape = mode === 'tape';
  return { on: true, mode, bars, source, target, ratio, rate, ok, clamped: !ok, semitones: tape ? 12 * Math.log2(rate) : 0, pitchRate: tape ? rate : 1, stretch: tape ? 1 : 1 / rate };
}
/** the fit's time ratio (1 when Fit is off) — how much faster the sample runs through time, in either mode */
export const fitRate = (params, duration, bpm) => fitInfo(params, duration, bpm).rate;
/** what a voice needs: { tapeRate, stretch } — exactly one of them differs from 1 when Fit is on */
export function fitPlayback(params, duration, bpm) {
  const f = fitInfo(params, duration, bpm);
  return { tapeRate: f.pitchRate, stretch: f.stretch };
}
/**
 * full playback rate of a note against the buffer it plays: pitch (transpose + tune) × the fit's pitch share
 * (stretch mode plays a pre-stretched buffer, so its playback rate carries only the musical pitch)
 */
export const notePlaybackRate = (note, params, duration, bpm) => rateForSemitones(noteSemitones(note, params)) * fitInfo(params, duration, bpm).pitchRate;
/** the fit choices that are usable (inside FIT_RANGE) for this sample at this tempo */
export const fitChoicesOk = (params, duration, bpm) => Object.fromEntries(FIT_CHOICES.map(c => [c, c === 'off' || fitInfo({ ...params, fit: c }, duration, bpm).ok]));

/**
 * Where slice k starts, counted from the first slice, in sequencer steps (16ths) at the current tempo and tape speed: its "home step".
 * Used by MAGIC CHOP and the beat ruler. stepSec = 60 / bpm / 4.
 */
export function sliceHomeSteps(slices, duration, rate, bpm) {
  const stepSec = 60 / bpm / 4, b = cleanSlices(slices);
  return b.slice(0, -1).map(x => ((x - b[0]) * duration / rate) / stepSec);
}
