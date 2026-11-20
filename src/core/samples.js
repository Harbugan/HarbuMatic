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

/** repair a stored sample reference; null when there is nothing a sample store could resolve */
export function cleanSampleRef(ref) {
  if (!isObj(ref) || !isSampleId(ref.id)) return null;
  return {
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
