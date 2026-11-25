// Built-in Break Pool and tempo-fit math for RUFF (v0.7 PR2): pure data + functions (no DOM, no Web Audio),
// so they run unchanged in Node tests and the browser.
//
// Built-in break IDs use the stable `brk-builtin-*` prefix so they remain clearly distinguishable from
// future user-imported samples (`smp-<sha256>`).

import { BREAK_LANES } from './instruments.js';
import { barsSeconds, defaultSlices, fitModeOf } from './samples.js';
import { clamp, num } from './util.js';

export const BUILTIN_BREAK_PREFIX = 'brk-builtin-';
/** playback speed ratio bounds for breaks across HarbuMatic's 50–200 BPM range */
export const BREAK_RATIO_RANGE = Object.freeze([0.25, 4]);

const freeze = o => Object.freeze(o);
const SLICES_16 = freeze(defaultSlices(16));

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
