// Project schema v5: creation, v0.4 migration and validation.
//
// A project is plain JSON (portable, framework-free):
// {
//   format: 'harbumatic-project', v: 5, id, name, created, modified,
//   bpm, swing, key, scale, scene, songMode,
//   scenes:      [{ name, harmony: null | { degrees: number[], span: number } }]   (6)
//   arrangement: [{ id, scene, reps }]            ordered scene instances = the song
//   tracks:      { drums|bass|synth|fuzz: { mute, solo, params, macros, patterns: Pattern[6] } }
//   lab:         { chaos, density, mood, targets }
//   snaps:       (null | { tracks: Pattern[4], macros: Macros[4] })[4]
//   fx:          { fb, dtone, rev, master }
// }
// Drum pattern:    { len, steps: { [drumId]: ({ v, p } | null)[] }, locked: { [drumId]: true } }
// Melodic pattern: { len, notes: [{ s, p, l, v, pr?, o?, slide?, locked? }] }

import { TRACKS, DRUMS, DRUM_IDS, NSCENES, SCENE_NAMES, SCALES, MOODS, LENGTHS, MAX_REPS, DEFAULT_PARAMS, DEFAULT_MACROS, DEFAULT_FX, DEFAULT_LAB } from './constants.js';
import { clamp, clone, uid, isObj, num } from './util.js';

export const FORMAT = 'harbumatic-project';
export const SCHEMA_VERSION = 5;

export function emptyPattern(track, len = 16) {
  if (track === 'drums') {
    const steps = {};
    DRUMS.forEach(d => { steps[d.id] = Array(len).fill(null); });
    return { len, steps, locked: {} };
  }
  return { len, notes: [] };
}

export function patternIsEmpty(track, p) {
  return track === 'drums' ? !DRUM_IDS.some(id => p.steps[id].some(Boolean)) : !p.notes.length;
}

export const newBlock = (scene, reps = 1) => ({ id: uid('blk'), scene, reps });

/** A genuinely empty song: four instruments, default sounds, no notes, no arrangement. */
export function createEmptyProject({ name = 'Untitled song', bpm = 120, key = 9, scale = 'minor', mood } = {}) {
  const now = new Date().toISOString();
  const p = {
    format: FORMAT, v: SCHEMA_VERSION, id: uid('song'), name, created: now, modified: now,
    bpm, swing: .08, key, scale, scene: 0, songMode: false,
    scenes: SCENE_NAMES.map(n => ({ name: n, harmony: null })),
    arrangement: [],
    tracks: {},
    lab: DEFAULT_LAB(),
    snaps: [null, null, null, null],
    fx: DEFAULT_FX(),
  };
  if (mood) p.lab.mood = mood;
  TRACKS.forEach(t => {
    p.tracks[t] = {
      mute: false, solo: false, params: clone(DEFAULT_PARAMS[t]), macros: DEFAULT_MACROS(),
      patterns: Array.from({ length: NSCENES }, () => emptyPattern(t, t === 'drums' ? 16 : 32)),
    };
  });
  return p;
}

const chordNotes = (list, len, v) => list.flatMap(([s, ps]) => ps.map(p => ({ s, p, l: len, v })));

/** The v0.4 demo song, rebuilt in schema v5 (A minor, i–VI–III–VII). */
export function createDemoProject() {
  const s = createEmptyProject({ name: 'Demo jam', bpm: 118, key: 9, scale: 'minor', mood: 'dreamy' });
  s.swing = .12; s.scene = 1; s.lab.chaos = .4;
  s.arrangement = [newBlock(0), newBlock(1, 2), newBlock(2)];
  const harmony = { degrees: [0, 5, 2, 6], span: 32 };
  s.scenes.forEach((sc, i) => { if (i < 3) sc.harmony = clone(harmony); });
  const T = s.tracks;
  const dA = T.drums.patterns[0];
  [0, 4, 8, 12].forEach(i => { dA.steps.kick[i] = { v: .95, p: 1 }; });
  [2, 6, 10, 14].forEach(i => { dA.steps.ohh[i] = { v: .55, p: 1 }; });
  for (let i = 1; i < 16; i += 2) dA.steps.chh[i] = { v: .35, p: .8 };
  const fA = T.fuzz.patterns[0]; fA.len = 32; fA.notes = [{ s: 0, p: 69, l: 14, v: .7 }, { s: 16, p: 76, l: 14, v: .6 }];
  const sA = T.synth.patterns[0];
  sA.notes = chordNotes([[0, [57, 60, 64]], [8, [53, 57, 60]], [16, [48, 52, 55, 60]], [24, [55, 59, 62]]], 6, .55);
  const dB = T.drums.patterns[1] = clone(dA);
  [4, 12].forEach(i => { dB.steps.clap[i] = { v: .85, p: 1 }; });
  for (let i = 0; i < 16; i++) dB.steps.chh[i] = i % 2 ? { v: .3, p: .85 } : (dB.steps.ohh[i] ? null : { v: .5, p: 1 });
  dB.steps.rim[7] = { v: .5, p: .6 }; dB.steps.rim[13] = { v: .45, p: .5 }; dB.steps.kick[14] = { v: .55, p: .5 };
  const bB = T.bass.patterns[1];
  bB.notes = [
    { s: 0, p: 33, l: 1, v: .9 }, { s: 2, p: 45, l: 1, v: 1 }, { s: 3, p: 33, l: 1, v: .7, slide: true }, { s: 4, p: 36, l: 1, v: .75 },
    { s: 6, p: 33, l: 1, v: .8 }, { s: 7, p: 40, l: 1, v: .95 }, { s: 8, p: 33, l: 2, v: .8 }, { s: 10, p: 45, l: 1, v: .7, slide: true },
    { s: 11, p: 43, l: 1, v: .75 }, { s: 12, p: 33, l: 1, v: .85 }, { s: 14, p: 36, l: 1, v: 1, slide: true }, { s: 15, p: 38, l: 1, v: .7 },
  ];
  T.synth.patterns[1] = clone(sA);
  T.synth.patterns[1].notes.push(
    { s: 2, p: 76, l: 2, v: .6 }, { s: 6, p: 74, l: 2, v: .55 }, { s: 10, p: 72, l: 2, v: .6 }, { s: 13, p: 69, l: 3, v: .55 },
    { s: 18, p: 72, l: 2, v: .6 }, { s: 22, p: 74, l: 2, v: .55 }, { s: 26, p: 76, l: 2, v: .65 }, { s: 29, p: 79, l: 3, v: .6 });
  T.fuzz.patterns[1] = clone(fA);
  T.drums.patterns[2] = clone(dB); T.bass.patterns[2] = clone(bB); T.synth.patterns[2] = clone(T.synth.patterns[1]);
  T.drums.patterns[2].steps.tom[15] = { v: .7, p: 1 }; T.drums.patterns[2].steps.cow[10] = { v: .4, p: .7 };
  return s;
}

/* ---------------------------------------------------------
   Migration
   --------------------------------------------------------- */
export class ProjectError extends Error {}

/** Detect the schema version of arbitrary parsed JSON. */
export function detectVersion(obj) {
  if (!isObj(obj)) return null;
  if (typeof obj.v === 'number') return obj.v;
  if (isObj(obj.tracks) && Array.isArray(obj.scenes)) return 4; // pre-format v0.4 exports always had v:4, be lenient
  return null;
}

/** v0.4 → v5: chain of scene indexes becomes arrangement blocks, scenes gain harmony, metadata added. */
export function migrateV4(old) {
  const p = clone(old);
  const now = new Date().toISOString();
  p.format = FORMAT; p.v = 5;
  p.id = uid('song'); p.name = typeof old.name === 'string' && old.name ? old.name : 'My v0.4 jam';
  p.created = p.created || now; p.modified = now;
  p.arrangement = (Array.isArray(old.chain) ? old.chain : []).filter(i => Number.isInteger(i)).map(i => newBlock(i, 1));
  delete p.chain;
  p.scenes = (Array.isArray(old.scenes) ? old.scenes : []).map(sc => ({ name: sc && sc.name, harmony: null }));
  return p;
}

/**
 * Turn any parsed JSON into a valid v5 project or throw ProjectError with a friendly message.
 * Never silently drops content that can be repaired.
 */
export function importProject(obj) {
  const v = detectVersion(obj);
  if (v == null) throw new ProjectError('That file is not a HarbuMatic project.');
  if (v > SCHEMA_VERSION) throw new ProjectError(`This song was made with a newer HarbuMatic (format v${v}). Please update the app.`);
  if (v < 4) throw new ProjectError(`HarbuMatic format v${v} is too old to open.`);
  const migrated = v === 4 ? migrateV4(obj) : obj;
  return validateProject(migrated);
}

/* ---------------------------------------------------------
   Validation / repair
   --------------------------------------------------------- */
function cleanDrumCell(c) {
  if (!isObj(c)) return null;
  return { v: num(c.v, .8, .05, 1), p: num(c.p, 1, .05, 1) };
}
function cleanNote(n, len) {
  if (!isObj(n)) return null;
  const s = Math.round(num(n.s, -1));
  if (s < 0 || s >= len) return null;
  const out = { s, p: Math.round(num(n.p, 60, 0, 127)), l: Math.round(num(n.l, 1, 1, len - s)), v: num(n.v, .8, .05, 1) };
  if (typeof n.pr === 'number' && n.pr < 1) out.pr = num(n.pr, 1, .05, 1);
  if (typeof n.o === 'number' && n.o) out.o = num(n.o, 0, -.4, .4);
  if (n.slide) out.slide = true;
  if (n.locked) out.locked = true;
  return out;
}
export function validatePattern(track, p, defLen = 16) {
  if (!isObj(p)) return emptyPattern(track, defLen);
  const len = LENGTHS.includes(p.len) ? p.len : defLen;
  if (track === 'drums') {
    const steps = {}, locked = {};
    DRUM_IDS.forEach(id => {
      const row = Array.isArray(p.steps && p.steps[id]) ? p.steps[id] : [];
      steps[id] = Array.from({ length: len }, (_, i) => cleanDrumCell(row[i]));
      if (p.locked && p.locked[id]) locked[id] = true;
    });
    return { len, steps, locked };
  }
  const notes = (Array.isArray(p.notes) ? p.notes : []).map(n => cleanNote(n, len)).filter(Boolean);
  return { len, notes };
}

function cleanParams(track, params) {
  const def = DEFAULT_PARAMS[track], out = clone(def);
  if (!isObj(params)) return out;
  for (const k of Object.keys(def)) {
    const dv = def[k], v = params[k];
    if (typeof dv === 'number' && typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof dv === 'boolean' && typeof v === 'boolean') out[k] = v;
    else if (typeof dv === 'string' && typeof v === 'string') out[k] = v;
  }
  return out;
}
function cleanMacros(m) {
  const out = DEFAULT_MACROS();
  if (isObj(m)) for (const k of Object.keys(out)) out[k] = num(m[k], out[k], 0, 1);
  return out;
}
function cleanHarmony(h) {
  if (!isObj(h) || !Array.isArray(h.degrees) || !h.degrees.length) return null;
  const degrees = h.degrees.map(d => Math.round(num(d, 0, 0, 6))).slice(0, 8);
  const span = LENGTHS.includes(h.span) ? h.span : 32;
  return { degrees, span };
}

export function validateProject(input) {
  if (!isObj(input)) throw new ProjectError('That file is not a HarbuMatic project.');
  const base = createEmptyProject();
  const p = {
    format: FORMAT, v: SCHEMA_VERSION,
    id: typeof input.id === 'string' && input.id ? input.id : base.id,
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 60) : 'Untitled song',
    created: typeof input.created === 'string' ? input.created : base.created,
    modified: typeof input.modified === 'string' ? input.modified : base.modified,
    bpm: Math.round(num(input.bpm, 120, 50, 200)),
    swing: num(input.swing, .08, 0, .5),
    key: Math.round(num(input.key, 9, 0, 11)),
    scale: SCALES[input.scale] ? input.scale : 'minor',
    scene: Math.round(num(input.scene, 0, 0, NSCENES - 1)),
    songMode: !!input.songMode,
    scenes: SCENE_NAMES.map((n, i) => {
      const sc = Array.isArray(input.scenes) ? input.scenes[i] : null;
      return { name: isObj(sc) && typeof sc.name === 'string' && sc.name.trim() ? sc.name.trim().slice(0, 24) : n, harmony: isObj(sc) ? cleanHarmony(sc.harmony) : null };
    }),
    arrangement: (Array.isArray(input.arrangement) ? input.arrangement : [])
      .filter(b => isObj(b) && Number.isInteger(b.scene) && b.scene >= 0 && b.scene < NSCENES)
      .map(b => ({ id: typeof b.id === 'string' ? b.id : uid('blk'), scene: b.scene, reps: Math.round(num(b.reps, 1, 1, MAX_REPS)) })),
    tracks: {},
    lab: (() => {
      const L = isObj(input.lab) ? input.lab : {}, d = DEFAULT_LAB();
      const targets = {};
      Object.keys(d.targets).forEach(k => { targets[k] = isObj(L.targets) && typeof L.targets[k] === 'boolean' ? L.targets[k] : d.targets[k]; });
      return { chaos: num(L.chaos, d.chaos, 0, 1), density: num(L.density, d.density, 0, 1), mood: MOODS.includes(L.mood) ? L.mood : d.mood, targets };
    })(),
    snaps: [0, 1, 2, 3].map(i => {
      const s = Array.isArray(input.snaps) ? input.snaps[i] : null;
      if (!isObj(s) || !Array.isArray(s.tracks)) return null;
      return { tracks: TRACKS.map((t, k) => validatePattern(t, s.tracks[k])), macros: TRACKS.map((t, k) => cleanMacros(Array.isArray(s.macros) ? s.macros[k] : null)) };
    }),
    fx: (() => { const f = isObj(input.fx) ? input.fx : {}, d = DEFAULT_FX(); return { fb: num(f.fb, d.fb, 0, .85), dtone: num(f.dtone, d.dtone, 0, 1), rev: num(f.rev, d.rev, 0, 1.2), master: num(f.master, d.master, 0, 1) }; })(),
  };
  TRACKS.forEach(t => {
    const tr = isObj(input.tracks) && isObj(input.tracks[t]) ? input.tracks[t] : {};
    p.tracks[t] = {
      mute: !!tr.mute, solo: !!tr.solo,
      params: cleanParams(t, tr.params), macros: cleanMacros(tr.macros),
      patterns: Array.from({ length: NSCENES }, (_, i) => validatePattern(t, Array.isArray(tr.patterns) ? tr.patterns[i] : null, t === 'drums' ? 16 : 32)),
    };
  });
  return p;
}

export const maxLen = (project, sc) => Math.max(...TRACKS.map(t => project.tracks[t].patterns[sc].len));
export const sceneHasContent = (project, sc) => TRACKS.some(t => !patternIsEmpty(t, project.tracks[t].patterns[sc]));
export const clampReps = r => clamp(Math.round(r), 1, MAX_REPS);
