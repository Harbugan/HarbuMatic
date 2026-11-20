// Static musical + instrument definitions. Pure data, safe to import anywhere.

// Release identity. APP_VERSION is the single source of the app version: the UI, the service-worker cache
// name and package.json (checked by tests/identity.test.mjs) all follow it. Bump it here for a release.
export const APP_VERSION = '0.5.1';
export const VERSION_LABEL = `v${APP_VERSION}`;
// Exact creator credit "Created by .::H∆RBUGΛП::." (U+2206 INCREMENT, U+039B GREEK CAPITAL LAMDA,
// U+041F CYRILLIC CAPITAL PE). Escaped so no editor or encoding step can swap the look-alike characters.
export const APP_CREDIT = 'Created by .::H\u2206RBUG\u039B\u041F::.';
export const TRACKS = ['drums', 'bass', 'synth', 'fuzz'];
export const MELODIC = ['bass', 'synth', 'fuzz'];

export const META = {
  drums: { name: 'BOP', type: 'Drum Machine', c: '#F2AFC0', d: '#E07D98', dd: '#B85475' },
  bass: { name: 'GOO', type: 'Acid Bass', c: '#A5DFCE', d: '#5FBFA3', dd: '#3A8F78' },
  synth: { name: 'BLIP', type: 'Melody Synth', c: '#C2B0ED', d: '#9A82DD', dd: '#6E56B8' },
  fuzz: { name: 'FUZZ', type: 'Texture & FX', c: '#F5D19A', d: '#E9AE57', dd: '#B9802C' },
};

export const DRUMS = [
  { id: 'kick', name: 'Kick' }, { id: 'snare', name: 'Snare' }, { id: 'clap', name: 'Clap' },
  { id: 'chh', name: 'Hat' }, { id: 'ohh', name: 'Open hat' }, { id: 'tom', name: 'Tom' },
  { id: 'rim', name: 'Rim' }, { id: 'cow', name: 'Bell' },
];
export const DRUM_IDS = DRUMS.map(d => d.id);

export const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10], 'minor pent.': [0, 3, 5, 7, 10], 'major pent.': [0, 2, 4, 7, 9],
  lydian: [0, 2, 4, 6, 7, 9, 11], chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
export const NOTE = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const MOODS = ['dreamy', 'bouncy', 'dark', 'weird'];
export const SCENE_NAMES = ['Intro', 'Groove', 'Variation', 'Break', 'Buildup', 'Drop'];
export const SCENE_LETTERS = 'ABCDEF';
export const NSCENES = 6;
export const LENGTHS = [16, 32, 64];
export const MAX_REPS = 8;

/** pitch ranges each melodic instrument naturally lives in (MIDI) */
export const RANGE = { bass: [28, 52], synth: [55, 86], fuzz: [62, 92] };

export const DEFAULT_PARAMS = {
  drums: { vol: .85, pan: 0, kit: '808', tune: 0, decay: 1, tone: .5, drive: .35, driveOn: false, delayOn: false, reverbOn: true, delay: .18, reverb: .12 },
  bass: { vol: .72, pan: 0, wave: 'sawtooth', cutoff: .3, res: .62, env: .6, decay: .35, accent: .6, glide: .06, drive: .45, driveOn: true, delayOn: true, reverbOn: false, delay: .16, reverb: .1 },
  synth: { vol: .5, pan: 0, wave1: 'sawtooth', wave2: 'square', oct2: 0, detune: 10, mix: .35, cutoff: .5, res: .15, fenv: .35, attack: .004, decay: .35, sustain: .35, release: .45, lfoRate: 2.5, lfoDepth: .1, drive: .2, driveOn: false, delayOn: true, reverbOn: true, delay: .28, reverb: .32 },
  fuzz: { vol: .5, pan: 0, tone: .45, noise: .35, crush: .25, shimmer: .35, attack: .6, release: 1.4, drive: .3, driveOn: false, delayOn: true, reverbOn: true, delay: .35, reverb: .6 },
};
export const DEFAULT_MACROS = () => ({ brightness: .5, movement: .5, space: .5, character: .5 });
export const DEFAULT_FX = () => ({ fb: .4, dtone: .5, rev: .9, master: .85 });
export const DEFAULT_LAB = () => ({ chaos: .35, density: .55, mood: 'bouncy', targets: { pitch: true, rhythm: true, velocity: true, length: false, sound: false } });
