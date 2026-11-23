// Static musical definitions and release identity. Pure data, safe to import anywhere.

// Release identity. APP_VERSION is the single source of the app version: the UI, the service-worker cache
// name and package.json (checked by tests/identity.test.mjs) all follow it. Bump it here for a release.
export const APP_VERSION = '0.5.1';
export const VERSION_LABEL = `v${APP_VERSION}`;
// Exact creator credit "Created by .::H∆RBUGΛП::." (U+2206 INCREMENT, U+039B GREEK CAPITAL LAMDA,
// U+041F CYRILLIC CAPITAL PE). Escaped so no editor or encoding step can swap the look-alike characters.
export const APP_CREDIT = 'Created by .::H\u2206RBUG\u039B\u041F::.';
// Instrument types (names, colours, default parameters, engines) live in src/core/instruments.js and
// instrument instances in project.slots (src/core/project.js). What remains here is musical data keyed by
// *role* — the musical job an instrument does, which src/music reasons about.
export const MELODIC = ['bass', 'synth', 'fuzz'];

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
/** Fixed scene count of the legacy v5 schema and the built-in demo jam. */
export const NSCENES = 6;
/** Technical limit for dynamic scenes per song: keeps localStorage, undo history, .hbn exports and tablet UI fast and bounded. */
export const MAX_SCENES = 64;
/** Short badge label for any zero-based scene index: 0→A … 25→Z, 26→AA … 63→BL. */
export function sceneLabel(index) {
  let n = Math.max(0, Math.floor(Number(index) || 0));
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}
export const LENGTHS = [16, 32, 64];
export const MAX_REPS = 8;

/** pitch ranges each melodic role naturally lives in (MIDI) */
export const RANGE = { bass: [28, 52], synth: [55, 86], fuzz: [62, 92] };

export const DEFAULT_MACROS = () => ({ brightness: .5, movement: .5, space: .5, character: .5 });
export const DEFAULT_FX = () => ({ fb: .4, dtone: .5, rev: .9, master: .85 });
export const DEFAULT_LAB = () => ({ chaos: .35, density: .55, mood: 'bouncy', targets: { pitch: true, rhythm: true, velocity: true, length: false, sound: false } });
