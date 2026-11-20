// Instrument Registry: the instrument *types* HarbuMatic knows about.
//
// Pure data + tiny helpers (no DOM, no Web Audio), so it runs unchanged in Node.
//
//   type      stable type ID, stored in songs (slot.type). Never rename one.
//   role      musical role used by src/music (generators, transforms, macros, ranges). It is also the
//             track key the type had in v4/v5 songs. Several types may share a role later.
//   engine    ID of the audio voice factory in src/audio/voices.js, or null when the type has no sound
//             engine yet. The registry only names it, so core stays free of Web Audio.
//   pattern   'drum'  — step grid with one row per DRUMS entry
//             'notes' — piano roll of { s, p, l, v, … } notes
//   ui        sequencer tools, audition note (pitch is at A minor; the UI transposes it to the song key;
//             soundPitch = preview note in the SOUND view when it differs), piano-roll view defaults
//   status    'ready'   — playable and shown in the UI
//             'planned' — known to the schema and kept in every song (data persists), but never scheduled,
//                         never soloed, never selected and never shown outside the dev preview (?preview=five)
//
// A slot (see src/core/project.js) holds one instance of a type. Slot identity never depends on the type.

import { DRUMS } from './constants.js';

const freeze = o => Object.freeze(o);
const deepFreeze = o => { Object.values(o).forEach(v => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };

/** channel parameters every playable instrument has (mixer strip + effect sends) */
const CHANNEL_KEYS = ['vol', 'pan', 'drive', 'driveOn', 'delayOn', 'reverbOn', 'delay', 'reverb'];

const TYPES = {
  bop: {
    type: 'bop', name: 'BOP', description: 'Drum Machine', status: 'ready',
    role: 'drums', engine: 'bop', pattern: 'drum', defaultLength: 16,
    capabilities: { generate: true, macros: true, presets: true, mono: false, slide: false, accent: false },
    visual: { color: '#F2AFC0', dark: '#E07D98', darker: '#B85475', headphones: '#86D3BD', css: 'drums', character: 'bop' },
    ui: { tools: ['draw', 'erase', 'vel', 'prob', 'lock'], audition: { drum: 'kick' } },
    defaultParams: { vol: .85, pan: 0, kit: '808', tune: 0, decay: 1, tone: .5, drive: .35, driveOn: false, delayOn: false, reverbOn: true, delay: .18, reverb: .12 },
  },
  goo: {
    type: 'goo', name: 'GOO', description: 'Acid Bass', status: 'ready',
    role: 'bass', engine: 'goo', pattern: 'notes', defaultLength: 32,
    capabilities: { generate: true, macros: true, presets: true, mono: true, slide: true, accent: true },
    visual: { color: '#A5DFCE', dark: '#5FBFA3', darker: '#3A8F78', headphones: '#B39DEB', css: 'bass', character: 'goo' },
    ui: { tools: ['draw', 'erase', 'vel', 'prob', 'slide', 'lock'], audition: { pitch: 33, length: .22 }, viewTop: 45, viewCenter: 38, noteLength: 1 },
    defaultParams: { vol: .72, pan: 0, wave: 'sawtooth', cutoff: .3, res: .62, env: .6, decay: .35, accent: .6, glide: .06, drive: .45, driveOn: true, delayOn: true, reverbOn: false, delay: .16, reverb: .1 },
  },
  blip: {
    type: 'blip', name: 'BLIP', description: 'Melody Synth', status: 'ready',
    role: 'synth', engine: 'blip', pattern: 'notes', defaultLength: 32,
    capabilities: { generate: true, macros: true, presets: true, mono: false, slide: false, accent: false },
    visual: { color: '#C2B0ED', dark: '#9A82DD', darker: '#6E56B8', headphones: '#F49AB2', css: 'synth', character: 'blip' },
    ui: { tools: ['draw', 'erase', 'vel', 'prob', 'lock'], audition: { pitch: 69, length: .22 }, viewTop: 79, viewCenter: 69, noteLength: 2 },
    defaultParams: { vol: .5, pan: 0, wave1: 'sawtooth', wave2: 'square', oct2: 0, detune: 10, mix: .35, cutoff: .5, res: .15, fenv: .35, attack: .004, decay: .35, sustain: .35, release: .45, lfoRate: 2.5, lfoDepth: .1, drive: .2, driveOn: false, delayOn: true, reverbOn: true, delay: .28, reverb: .32 },
  },
  fuzz: {
    type: 'fuzz', name: 'FUZZ', description: 'Texture & FX', status: 'ready',
    role: 'fuzz', engine: 'fuzz', pattern: 'notes', defaultLength: 32,
    capabilities: { generate: true, macros: true, presets: true, mono: false, slide: false, accent: false },
    visual: { color: '#F5D19A', dark: '#E9AE57', darker: '#B9802C', headphones: '#B9A6EA', css: 'fuzz', character: 'fuzz' },
    ui: { tools: ['draw', 'erase', 'vel', 'prob', 'lock'], audition: { pitch: 76, length: .6, soundPitch: 69 }, viewTop: 86, viewCenter: 76, noteLength: 8 },
    defaultParams: { vol: .5, pan: 0, tone: .45, noise: .35, crush: .25, shimmer: .35, attack: .6, release: 1.4, drive: .3, driveOn: false, delayOn: true, reverbOn: true, delay: .35, reverb: .6 },
  },
  // Future sampler (v0.6). Every song holds one MUNCH slot (slot-05 by default), but it has no engine, no
  // generator and no UI yet, so it is never played or shown. Its pattern kind is provisional.
  // ui.layers names the interaction layers of the planned design (PLAY: record/import + melodic keys,
  // CHOP: slice pads + MAGIC CHOP, TWIST: waveform, pitch, reverse, loop). Nothing reads them yet.
  munch: {
    type: 'munch', name: 'MUNCH', description: 'Sampler', status: 'planned',
    role: null, engine: null, pattern: 'notes', defaultLength: 16,
    capabilities: { generate: false, macros: false, presets: false, mono: false, slide: false, accent: false, samples: true },
    visual: { color: '#9FD6EE', dark: '#5DB4D9', darker: '#3586A8', headphones: '#F5D19A', css: 'munch', character: 'munch' },
    ui: { tools: ['draw', 'erase', 'vel', 'prob', 'lock'], audition: { pitch: 60, length: .4 }, viewTop: 72, viewCenter: 60, noteLength: 1, layers: ['play', 'chop', 'twist'] },
    defaultParams: { vol: .8, pan: 0, drive: .3, driveOn: false, delayOn: false, reverbOn: false, delay: .2, reverb: .2 },
  },
};
Object.values(TYPES).forEach(deepFreeze);
export const INSTRUMENT_TYPES = freeze(TYPES);

/** v4/v5 songs stored instruments under these track keys, in this order (= slot-01 … slot-04) */
export const LEGACY_TRACKS = freeze(['drums', 'bass', 'synth', 'fuzz']);
export const LEGACY_TRACK_TYPES = freeze({ drums: 'bop', bass: 'goo', synth: 'blip', fuzz: 'fuzz' });
/** instrument types of a new song, in slot order (slot-01 … slot-05) */
export const DEFAULT_SLOT_TYPES = freeze(['bop', 'goo', 'blip', 'fuzz', 'munch']);
/**
 * Instrument every song must hold, and the slot id it gets when a song lacks it. Songs from v0.4/v0.5 and
 * four-slot v6 songs gain this slot when they are opened (see ensureMunchSlot in src/core/project.js).
 */
export const MUNCH_TYPE = 'munch';
export const MUNCH_SLOT_NUMBER = 5;
/** most slots a song may hold (four classic instruments + MUNCH + headroom for later) */
export const MAX_SLOTS = 8;

export const hasInstrumentType = id => Object.prototype.hasOwnProperty.call(TYPES, id);
/** the registered definition for a type ID; throws for unknown IDs so typos fail loudly */
export function getInstrumentType(id) {
  if (!hasInstrumentType(id)) throw new Error(`Unknown instrument type: ${id}`);
  return TYPES[id];
}
/** every registered type (planned ones only on request) */
export const listInstrumentTypes = ({ includePlanned = false } = {}) =>
  Object.values(TYPES).filter(t => includePlanned || t.status === 'ready');
/** playable = ready and backed by an audio engine */
export const isPlayableType = id => hasInstrumentType(id) && TYPES[id].status === 'ready' && !!TYPES[id].engine;
export const typeForLegacyTrack = track => LEGACY_TRACK_TYPES[track] || null;

/** fresh, mutable default parameters for a type */
export const defaultParamsFor = id => JSON.parse(JSON.stringify(getInstrumentType(id).defaultParams));
export const channelKeys = () => CHANNEL_KEYS.slice();

/* ---------- patterns (by pattern kind, so any type with the same kind shares them) ---------- */
export function emptyPatternOfKind(kind, len) {
  if (kind === 'drum') {
    const steps = {};
    DRUMS.forEach(d => { steps[d.id] = Array(len).fill(null); });
    return { len, steps, locked: {} };
  }
  return { len, notes: [] };
}
/** a new empty pattern for a type (its default length unless given) */
export function createPatternFor(id, len) {
  const def = getInstrumentType(id);
  return emptyPatternOfKind(def.pattern, len || def.defaultLength);
}
export const patternKindIsEmpty = (kind, p) => (kind === 'drum' ? !DRUMS.some(d => p.steps[d.id].some(Boolean)) : !p.notes.length);
