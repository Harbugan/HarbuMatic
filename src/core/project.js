// Project schema v6: creation, migration (v4 → v5 → v6), validation and slot/scene accessors.
//
// A project is plain JSON (portable, framework-free):
// {
//   format: 'harbumatic-project', v: 6, id, name, created, modified,
//   bpm, swing, key, scale, scene, songMode,
//   scenes:      [{ id: 'scene-01', name, harmony: null | { degrees: number[], span: number } }]
//   arrangement: [{ id, sceneId, reps }]            ordered scene instances = the song
//   slots:       [{ id: 'slot-01', type: 'bop', mute, solo, params, macros, patterns: { [sceneId]: Pattern } }]
//   lab:         { chaos, density, mood, targets }
//   snaps:       (null | { slots: { [slotId]: { type, pattern: Pattern, macros } } })[4]
//   fx:          { fb, dtone, rev, master }
// }
// Drum pattern:    { len, steps: { [drumId]: ({ v, p } | null)[] }, locked: { [drumId]: true } }
// Melodic pattern: { len, notes: [{ s, p, l, v, pr?, o?, slide?, locked? }] }
//
// Identity rules
// - A slot is one instrument instance. Its `id` is stable and never depends on `type`; replacing the
//   instrument later changes `type`/`params`/`patterns`, never `id`. Two slots may share a type.
// - Scenes have stable ids. Patterns and arrangement blocks reference scenes by id, so scenes can later
//   be added, removed or reordered without re-indexing anything. `scene` (the scene being edited) stays
//   an index into `scenes` because it is view state, not a reference.
// - Snapshots key their content by slot id and remember the type, so a recall never pours one
//   instrument's pattern into a different kind of instrument.

import { DRUM_IDS, NSCENES, MAX_SCENES, SCENE_NAMES, SCALES, MOODS, LENGTHS, MAX_REPS, DEFAULT_MACROS, DEFAULT_FX, DEFAULT_LAB } from './constants.js';
import {
  getInstrumentType, hasInstrumentType, isPlayableType, defaultParamsFor, createPatternFor, emptyPatternOfKind,
  patternKindIsEmpty, LEGACY_TRACKS, LEGACY_TRACK_TYPES, DEFAULT_SLOT_TYPES, MAX_SLOTS, MUNCH_TYPE, MUNCH_SLOT_NUMBER,
} from './instruments.js';
import { clamp, clone, uid, isObj, num } from './util.js';
import { cleanSampleRef, extraKeys, MAX_SLICES } from './samples.js';

export const FORMAT = 'harbumatic-project';
export const SCHEMA_VERSION = 6;
/** Maximum dynamic scenes per song (documented technical limit from constants.js). */
export { MAX_SCENES };

/* ---------------------------------------------------------
   Ids
   --------------------------------------------------------- */
const pad2 = n => String(n).padStart(2, '0');
export const slotIdFor = n => `slot-${pad2(n)}`;
export const sceneIdFor = n => `scene-${pad2(n)}`;
const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const validId = v => typeof v === 'string' && ID_RE.test(v);
function nextId(make, used) { let n = 1; while (used.has(make(n))) n++; return make(n); }
/** the next free slot id of a project (slot-06 for a new song; slot-05 is MUNCH) */
export const nextSlotId = project => nextId(slotIdFor, new Set(project.slots.map(s => s.id)));
export const nextSceneId = project => nextId(sceneIdFor, new Set(project.scenes.map(s => s.id)));
/** default name for a newly created empty scene */
export function nextSceneName(project) {
  const used = new Set(project.scenes.map(s => s.name));
  let n = project.scenes.length + 1;
  while (used.has(`Scene ${n}`)) n++;
  return `Scene ${n}`;
}
/** default name for a duplicated scene (fits within the 24-character scene name limit) */
export function duplicateSceneName(project, sourceName) {
  const used = new Set(project.scenes.map(s => s.name));
  const raw = String(sourceName || 'Scene').trim() || 'Scene';
  const base = raw.replace(/\s+copy(?:\s+\d+)?$/i, '').trim() || 'Scene';
  const fit = suffix => `${base.slice(0, Math.max(1, 24 - suffix.length)).trimEnd()}${suffix}`;
  let cand = fit(' copy');
  let n = 2;
  while (used.has(cand)) { cand = fit(` copy ${n}`); n++; }
  return cand;
}

/* ---------------------------------------------------------
   Accessors (the only way the rest of the app should reach slot/scene data)
   --------------------------------------------------------- */
export const slotById = (project, id) => project.slots.find(s => s.id === id) || null;
export const typeOfSlot = slot => getInstrumentType(slot.type);
/** slots whose instrument can sound (and is shown); planned types such as MUNCH are skipped */
export const playableSlots = project => project.slots.filter(s => isPlayableType(s.type));
export const sceneIdAt = (project, idx) => (project.scenes[idx] ? project.scenes[idx].id : null);
export const sceneIndexOf = (project, id) => project.scenes.findIndex(s => s.id === id);
/** scene index an arrangement block plays (0 if its reference is broken; validation prevents that) */
export const blockScene = (project, block) => Math.max(0, sceneIndexOf(project, block.sceneId));
export const patternAt = (project, slotId, sceneIdx = project.scene) => {
  const s = slotById(project, slotId), sid = sceneIdAt(project, sceneIdx);
  return s && sid ? s.patterns[sid] : undefined;
};
export function setPatternAt(project, slotId, sceneIdx, pattern) {
  const s = slotById(project, slotId), sid = sceneIdAt(project, sceneIdx);
  if (s && sid) s.patterns[sid] = pattern;
}
/** solo only counts on playable slots: a planned instrument (e.g. MUNCH) has no engine and must not silence the others */
export const anySolo = project => project.slots.some(s => s.solo && isPlayableType(s.type));
export const slotAudible = (project, slot) => (anySolo(project) ? slot.solo : !slot.mute);
/**
 * Patterns of one scene keyed by musical role ('drums', 'bass', …) for src/music, which reasons in roles.
 * The first playable slot of each role wins; a missing drum role gets an empty grid so grooves still work.
 */
export function rolePatterns(project, sceneIdx) {
  const out = {};
  for (const s of playableSlots(project)) { const r = typeOfSlot(s).role; if (r && !out[r]) out[r] = patternAt(project, s.id, sceneIdx); }
  if (!out.drums) out.drums = emptyPatternOfKind('drum', 16);
  return out;
}

/* ---------------------------------------------------------
   Creation
   --------------------------------------------------------- */
export function emptyPattern(type, len) { return createPatternFor(type, len); }
export function patternIsEmpty(type, p) { return patternKindIsEmpty(getInstrumentType(type).pattern, p); }

export const newBlock = (sceneId, reps = 1) => ({ id: uid('blk'), sceneId, reps });

/** one instrument instance with default sound and empty patterns for the given scenes */
export function createSlot(type, id, sceneIds) {
  const slot = {
    id, type, mute: false, solo: false, params: defaultParamsFor(type), macros: DEFAULT_MACROS(),
    patterns: Object.fromEntries(sceneIds.map(sid => [sid, createPatternFor(type)])),
  };
  if (getInstrumentType(type).capabilities.samples) slot.sample = null; // sampler slots reference a sample (src/core/samples.js)
  return slot;
}

function buildProject({ name = 'Untitled song', bpm = 120, key = 9, scale = 'minor', mood, sceneNames = ['Scene 1'] } = {}) {
  const now = new Date().toISOString();
  const scenes = sceneNames.map((n, i) => ({ id: sceneIdFor(i + 1), name: n, harmony: null }));
  const p = {
    format: FORMAT, v: SCHEMA_VERSION, id: uid('song'), name, created: now, modified: now,
    bpm, swing: .08, key, scale, scene: 0, songMode: false,
    scenes,
    arrangement: [],
    slots: DEFAULT_SLOT_TYPES.map((t, i) => createSlot(t, slotIdFor(i + 1), scenes.map(s => s.id))),
    lab: DEFAULT_LAB(),
    snaps: [null, null, null, null],
    fx: DEFAULT_FX(),
  };
  if (mood) p.lab.mood = mood;
  return p;
}

/** A genuinely empty song: five instrument slots, one empty scene, default sounds, no notes, no arrangement. */
export function createEmptyProject({ name = 'Untitled song', bpm = 120, key = 9, scale = 'minor', mood } = {}) {
  return buildProject({ name, bpm, key, scale, mood, sceneNames: ['Scene 1'] });
}

const chordNotes = (list, len, v) => list.flatMap(([s, ps]) => ps.map(p => ({ s, p, l: len, v })));

/** The v0.4 demo song (A minor, i–VI–III–VII); same content as in v0.5. */
export function createDemoProject() {
  const s = buildProject({ name: 'Demo jam', bpm: 118, key: 9, scale: 'minor', mood: 'dreamy', sceneNames: SCENE_NAMES });
  s.swing = .12; s.scene = 1; s.lab.chaos = .4;
  s.arrangement = [newBlock(sceneIdAt(s, 0)), newBlock(sceneIdAt(s, 1), 2), newBlock(sceneIdAt(s, 2))];
  const harmony = { degrees: [0, 5, 2, 6], span: 32 };
  s.scenes.forEach((sc, i) => { if (i < 3) sc.harmony = clone(harmony); });
  const [BOP, GOO, BLIP, FUZZ] = s.slots.map(x => x.id);
  const get = (slot, i) => patternAt(s, slot, i), put = (slot, i, p) => setPatternAt(s, slot, i, p);
  const dA = get(BOP, 0);
  [0, 4, 8, 12].forEach(i => { dA.steps.kick[i] = { v: .95, p: 1 }; });
  [2, 6, 10, 14].forEach(i => { dA.steps.ohh[i] = { v: .55, p: 1 }; });
  for (let i = 1; i < 16; i += 2) dA.steps.chh[i] = { v: .35, p: .8 };
  const fA = get(FUZZ, 0); fA.len = 32; fA.notes = [{ s: 0, p: 69, l: 14, v: .7 }, { s: 16, p: 76, l: 14, v: .6 }];
  const sA = get(BLIP, 0);
  sA.notes = chordNotes([[0, [57, 60, 64]], [8, [53, 57, 60]], [16, [48, 52, 55, 60]], [24, [55, 59, 62]]], 6, .55);
  const dB = clone(dA); put(BOP, 1, dB);
  [4, 12].forEach(i => { dB.steps.clap[i] = { v: .85, p: 1 }; });
  for (let i = 0; i < 16; i++) dB.steps.chh[i] = i % 2 ? { v: .3, p: .85 } : (dB.steps.ohh[i] ? null : { v: .5, p: 1 });
  dB.steps.rim[7] = { v: .5, p: .6 }; dB.steps.rim[13] = { v: .45, p: .5 }; dB.steps.kick[14] = { v: .55, p: .5 };
  const bB = get(GOO, 1);
  bB.notes = [
    { s: 0, p: 33, l: 1, v: .9 }, { s: 2, p: 45, l: 1, v: 1 }, { s: 3, p: 33, l: 1, v: .7, slide: true }, { s: 4, p: 36, l: 1, v: .75 },
    { s: 6, p: 33, l: 1, v: .8 }, { s: 7, p: 40, l: 1, v: .95 }, { s: 8, p: 33, l: 2, v: .8 }, { s: 10, p: 45, l: 1, v: .7, slide: true },
    { s: 11, p: 43, l: 1, v: .75 }, { s: 12, p: 33, l: 1, v: .85 }, { s: 14, p: 36, l: 1, v: 1, slide: true }, { s: 15, p: 38, l: 1, v: .7 },
  ];
  put(BLIP, 1, clone(sA));
  get(BLIP, 1).notes.push(
    { s: 2, p: 76, l: 2, v: .6 }, { s: 6, p: 74, l: 2, v: .55 }, { s: 10, p: 72, l: 2, v: .6 }, { s: 13, p: 69, l: 3, v: .55 },
    { s: 18, p: 72, l: 2, v: .6 }, { s: 22, p: 74, l: 2, v: .55 }, { s: 26, p: 76, l: 2, v: .65 }, { s: 29, p: 79, l: 3, v: .6 });
  put(FUZZ, 1, clone(fA));
  put(BOP, 2, clone(dB)); put(GOO, 2, clone(bB)); put(BLIP, 2, clone(get(BLIP, 1)));
  get(BOP, 2).steps.tom[15] = { v: .7, p: 1 }; get(BOP, 2).steps.cow[10] = { v: .4, p: .7 };
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
  p.arrangement = (Array.isArray(old.chain) ? old.chain : []).filter(i => Number.isInteger(i)).map(i => ({ id: uid('blk'), scene: i, reps: 1 }));
  delete p.chain;
  p.scenes = (Array.isArray(old.scenes) ? old.scenes : []).map(sc => ({ name: sc && sc.name, harmony: null }));
  return p;
}

/**
 * v5 → v6: the four fixed tracks become slots slot-01…slot-04 (BOP, GOO, BLIP, FUZZ in v5 track order),
 * scenes get ids scene-01…scene-06, patterns and arrangement blocks reference scenes by id and snapshots
 * key their content by slot id. Purely structural and deterministic (no random ids, no timestamps), so
 * migrating the same file twice gives the same result. Content is copied verbatim; validateProject()
 * repairs it afterwards exactly as the v5 validator did.
 */
export function migrateV5(old) {
  const src = isObj(old) ? old : {};
  const p = {};
  for (const [k, v] of Object.entries(src)) if (!['tracks', 'snaps', 'scenes', 'arrangement'].includes(k)) p[k] = clone(v);
  p.format = FORMAT; p.v = 6;
  const oldScenes = Array.isArray(src.scenes) ? src.scenes : [];
  const sceneIds = Array.from({ length: NSCENES }, (_, i) => sceneIdFor(i + 1)); // v5 always had exactly six scenes
  p.scenes = sceneIds.map((id, i) => { const sc = isObj(oldScenes[i]) ? oldScenes[i] : {}; return { id, name: sc.name, harmony: sc.harmony == null ? null : clone(sc.harmony) }; });
  p.arrangement = (Array.isArray(src.arrangement) ? src.arrangement : [])
    .filter(b => isObj(b) && Number.isInteger(b.scene) && b.scene >= 0 && b.scene < NSCENES)
    .map(b => ({ id: b.id, sceneId: sceneIds[b.scene], reps: b.reps }));
  const tracks = isObj(src.tracks) ? src.tracks : {};
  p.slots = LEGACY_TRACKS.map((t, k) => {
    const tr = isObj(tracks[t]) ? tracks[t] : {};
    const pats = Array.isArray(tr.patterns) ? tr.patterns : [];
    return {
      id: slotIdFor(k + 1), type: LEGACY_TRACK_TYPES[t], mute: tr.mute, solo: tr.solo,
      params: clone(tr.params ?? null), macros: clone(tr.macros ?? null),
      patterns: Object.fromEntries(sceneIds.map((sid, i) => [sid, clone(pats[i] ?? null)])),
    };
  });
  p.snaps = [0, 1, 2, 3].map(i => {
    const s = Array.isArray(src.snaps) ? src.snaps[i] : null;
    if (!isObj(s) || !Array.isArray(s.tracks)) return null;
    const slots = {};
    LEGACY_TRACKS.forEach((t, k) => { slots[slotIdFor(k + 1)] = { type: LEGACY_TRACK_TYPES[t], pattern: clone(s.tracks[k] ?? null), macros: clone(Array.isArray(s.macros) ? s.macros[k] ?? null : null) }; });
    return { slots };
  });
  return p;
}

/**
 * Turn any parsed JSON into a valid v6 project or throw ProjectError with a friendly message.
 * Never silently drops content that can be repaired.
 */
export function importProject(obj) {
  const v = detectVersion(obj);
  if (v == null) throw new ProjectError('That file is not a HarbuMatic project.');
  if (v > SCHEMA_VERSION) throw new ProjectError(`This song was made with a newer HarbuMatic (format v${v}). Please update the app.`);
  if (v < 4) throw new ProjectError(`HarbuMatic format v${v} is too old to open.`);
  let p = obj;
  if (v === 4) p = migrateV4(p);
  if (v <= 5) p = migrateV5(p);
  return validateProject(p);
}

/* ---------------------------------------------------------
   Validation / repair
   --------------------------------------------------------- */
function cleanDrumCell(c) {
  if (!isObj(c)) return null;
  return { v: num(c.v, .8, .05, 1), p: num(c.p, 1, .05, 1) };
}
function cleanNote(n, len, slices = false) {
  if (!isObj(n)) return null;
  const s = Math.round(num(n.s, -1));
  if (s < 0 || s >= len) return null;
  const out = { s, p: Math.round(num(n.p, 60, 0, 127)), l: Math.round(num(n.l, 1, 1, len - s)), v: num(n.v, .8, .05, 1) };
  if (typeof n.pr === 'number' && n.pr < 1) out.pr = num(n.pr, 1, .05, 1);
  if (typeof n.o === 'number' && n.o) out.o = num(n.o, 0, -.4, .4);
  if (n.slide) out.slide = true;
  if (n.locked) out.locked = true;
  if (slices && Number.isInteger(n.slice) && n.slice >= 0 && n.slice < MAX_SLICES) out.slice = n.slice; // sampler slice trigger
  return out;
}
/** repair a pattern of the given type ('bop', 'goo', …) */
export function validatePattern(type, p, defLen = 16) {
  const def = getInstrumentType(type), kind = def.pattern, slices = !!def.capabilities.slices;
  if (!isObj(p)) return emptyPatternOfKind(kind, defLen);
  const len = LENGTHS.includes(p.len) ? p.len : defLen;
  if (kind === 'drum') {
    const steps = {}, locked = {};
    DRUM_IDS.forEach(id => {
      const row = Array.isArray(p.steps && p.steps[id]) ? p.steps[id] : [];
      steps[id] = Array.from({ length: len }, (_, i) => cleanDrumCell(row[i]));
      if (p.locked && p.locked[id]) locked[id] = true;
    });
    return { len, steps, locked };
  }
  const notes = (Array.isArray(p.notes) ? p.notes : []).map(n => cleanNote(n, len, slices)).filter(Boolean);
  return { len, notes };
}

function cleanParams(type, params) {
  const t = getInstrumentType(type), def = t.defaultParams, ranges = t.paramRanges || {}, choices = t.paramChoices || {};
  if (!isObj(params)) return defaultParamsFor(type);
  const out = t.keepUnknownParams ? { ...extraKeys(params, Object.keys(def)), ...defaultParamsFor(type) } : defaultParamsFor(type);
  for (const k of Object.keys(def)) {
    const dv = def[k], v = params[k];
    if (typeof dv === 'number' && typeof v === 'number' && Number.isFinite(v)) out[k] = ranges[k] ? clamp(v, ranges[k][0], ranges[k][1]) : v;
    else if (typeof dv === 'boolean' && typeof v === 'boolean') out[k] = v;
    else if (typeof dv === 'string' && typeof v === 'string' && (!choices[k] || choices[k].includes(v))) out[k] = v;
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
/** assign ids: keep valid unique ones, give the rest the first free generated id */
function assignIds(items, make) {
  const used = new Set(), out = Array(items.length).fill(null);
  const raw = items.map(it => (isObj(it) && validId(it.id) ? it.id : null));
  raw.forEach((id, i) => { if (id && !used.has(id)) { used.add(id); out[i] = id; } });
  return out.map(id => { if (id) return id; const n = nextId(make, used); used.add(n); return n; });
}

function cleanScenes(input) {
  const raw = Array.isArray(input.scenes) ? input.scenes : [];
  if (raw.length > MAX_SCENES) throw new ProjectError(`This song has ${raw.length} scenes; this version of HarbuMatic can open up to ${MAX_SCENES}. Please update the app.`);
  const list = raw.length ? raw : [null];
  const ids = assignIds(list, sceneIdFor);
  return list.map((sc, i) => {
    const fallback = `Scene ${i + 1}`;
    return { id: ids[i], name: isObj(sc) && typeof sc.name === 'string' && sc.name.trim() ? sc.name.trim().slice(0, 24) : fallback, harmony: isObj(sc) ? cleanHarmony(sc.harmony) : null };
  });
}

function cleanSlots(input, sceneIds) {
  let raw = (Array.isArray(input.slots) ? input.slots : []).filter(isObj);
  if (raw.length > MAX_SLOTS) throw new ProjectError(`This song has ${raw.length} instruments; this version of HarbuMatic can open up to ${MAX_SLOTS}. Please update the app.`);
  const unknown = raw.find(s => !hasInstrumentType(s.type));
  if (unknown) throw new ProjectError(`This song uses an instrument this version of HarbuMatic does not know (“${String(unknown.type).slice(0, 24)}”). Please update the app.`);
  if (!raw.length) raw = DEFAULT_SLOT_TYPES.map(type => ({ type }));
  const ids = assignIds(raw, slotIdFor);
  return raw.map((s, k) => {
    const def = getInstrumentType(s.type), pats = isObj(s.patterns) ? s.patterns : {};
    const out = {
      id: ids[k], type: s.type, mute: !!s.mute, solo: !!s.solo,
      params: cleanParams(s.type, s.params), macros: cleanMacros(s.macros),
      patterns: Object.fromEntries(sceneIds.map(sid => [sid, validatePattern(s.type, pats[sid], def.defaultLength)])),
    };
    // a sampler keeps its sample reference even when the asset is missing on this device (never dropped silently)
    if (def.capabilities.samples) out.sample = cleanSampleRef(s.sample);
    return out;
  });
}

/**
 * Every song holds a MUNCH slot. A song without one (v0.4, v0.5, four-slot v6) gets an empty one appended:
 * id slot-05, or the first free id after it when slot-05 belongs to another instrument. Existing slots are
 * never touched, reordered or renumbered, and a song that already has a MUNCH slot (anywhere, any id) is
 * left alone, so this is deterministic and idempotent. A song already at MAX_SLOTS keeps its slots as they are.
 */
function ensureMunchSlot(slots, sceneIds) {
  if (slots.some(s => s.type === MUNCH_TYPE) || slots.length >= MAX_SLOTS) return slots;
  const used = new Set(slots.map(s => s.id));
  let n = MUNCH_SLOT_NUMBER; while (used.has(slotIdFor(n))) n++;
  return [...slots, createSlot(MUNCH_TYPE, slotIdFor(n), sceneIds)];
}

function cleanSnap(s, slots) {
  if (!isObj(s) || !isObj(s.slots)) return null;
  const out = {};
  for (const slot of slots) {
    const e = s.slots[slot.id];
    if (!isObj(e)) continue;
    const type = hasInstrumentType(e.type) ? e.type : slot.type;
    out[slot.id] = { type, pattern: validatePattern(type, e.pattern), macros: cleanMacros(e.macros) }; // default length 16, as in v5
  }
  return Object.keys(out).length ? { slots: out } : null;
}

export function validateProject(input) {
  if (!isObj(input)) throw new ProjectError('That file is not a HarbuMatic project.');
  if (!Array.isArray(input.slots) && isObj(input.tracks)) input = migrateV5(input); // tolerate a v5-shaped object
  const base = createEmptyProject();
  const scenes = cleanScenes(input), sceneIds = scenes.map(s => s.id);
  const sceneSet = new Set(sceneIds);
  const slots = ensureMunchSlot(cleanSlots(input, sceneIds), sceneIds);
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
    scene: Math.round(num(input.scene, 0, 0, scenes.length - 1)),
    songMode: !!input.songMode,
    scenes,
    arrangement: (Array.isArray(input.arrangement) ? input.arrangement : [])
      .filter(isObj)
      .map(b => ({ b, sid: typeof b.sceneId === 'string' ? b.sceneId : Number.isInteger(b.scene) ? sceneIds[b.scene] : null }))
      .filter(({ sid }) => sid && sceneSet.has(sid))
      .map(({ b, sid }) => ({ id: typeof b.id === 'string' ? b.id : uid('blk'), sceneId: sid, reps: Math.round(num(b.reps, 1, 1, MAX_REPS)) })),
    slots,
    lab: (() => {
      const L = isObj(input.lab) ? input.lab : {}, d = DEFAULT_LAB();
      const targets = {};
      Object.keys(d.targets).forEach(k => { targets[k] = isObj(L.targets) && typeof L.targets[k] === 'boolean' ? L.targets[k] : d.targets[k]; });
      return { chaos: num(L.chaos, d.chaos, 0, 1), density: num(L.density, d.density, 0, 1), mood: MOODS.includes(L.mood) ? L.mood : d.mood, targets };
    })(),
    snaps: [0, 1, 2, 3].map(i => cleanSnap(Array.isArray(input.snaps) ? input.snaps[i] : null, slots)),
    fx: (() => { const f = isObj(input.fx) ? input.fx : {}, d = DEFAULT_FX(); return { fb: num(f.fb, d.fb, 0, .85), dtone: num(f.dtone, d.dtone, 0, 1), rev: num(f.rev, d.rev, 0, 1.2), master: num(f.master, d.master, 0, 1) }; })(),
  };
  return p;
}

/** longest pattern among the playable instruments of a scene (song mode advances after it) */
export function maxLen(project, sc) {
  const lens = playableSlots(project).map(s => patternAt(project, s.id, sc).len);
  return lens.length ? Math.max(...lens) : 16;
}
export const sceneHasContent = (project, sc) => playableSlots(project).some(s => !patternIsEmpty(s.type, patternAt(project, s.id, sc)));
export const clampReps = r => clamp(Math.round(r), 1, MAX_REPS);
