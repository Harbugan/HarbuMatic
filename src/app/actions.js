// Actions: the only place that mutates the project in response to the UI.
// Views call actions; actions save, record history and emit events; main.js re-renders.

import { store, emit, P, pat, slot, typeOf, isDrumSlot, ensureSelection } from './store.js';
import { MELODIC, SCENE_LETTERS } from '../core/constants.js';
import { clone, clamp } from '../core/util.js';
import { createHistory } from '../core/history.js';
import { createLibrary } from '../core/persistence.js';
import {
  createEmptyProject, createDemoProject, importProject, newBlock, clampReps, ProjectError,
  playableSlots, patternAt, setPatternAt, sceneIdAt, typeOfSlot,
} from '../core/project.js';
import { createPatternFor, isPlayableType } from '../core/instruments.js';
import { createRng, randomSeed } from '../core/rng.js';
import { buildContext } from '../music/context.js';
import { transformPattern } from '../music/transform.js';
import { chooseHarmony } from '../music/harmony.js';
import { applyMacros as applyMacroParams } from '../music/macros.js';
import { createEngine } from '../audio/engine.js';
import { createTransport } from '../audio/scheduler.js';
import { isLoopBoundary } from '../audio/position.js';

export const history = createHistory();
export const library = createLibrary(safeStorage());
export const engine = createEngine(() => store.project);
export const transport = createTransport(engine, () => store.project, {
  onState: () => emit('transport'),
  beforeStep: (pos, boundary) => autoEvolveHook(pos, boundary),
});

function safeStorage() {
  try { const s = window.localStorage; s.setItem('harbumatic.probe', '1'); s.removeItem('harbumatic.probe'); return s; }
  catch (e) { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; }
}

/* ---------- history + persistence ---------- */
export function checkpoint(coalesce = null) { history.checkpoint(JSON.stringify(store.project), coalesce); emit('history'); }
export function sealHistory() { history.seal(); }

let saveTimer = 0, storageWarned = false;
export function save(now = false) {
  clearTimeout(saveTimer);
  const doSave = () => {
    store.project.modified = new Date().toISOString();
    if (!library.save(store.project) && !storageWarned) { storageWarned = true; emit('toast', 'Could not autosave — export your song to keep it safe'); }
  };
  if (now) doSave(); else saveTimer = setTimeout(doSave, 400);
}
export function flushSave() { if (saveTimer) save(true); }

function restoreSnapshot(json) {
  const keepId = store.project.id;
  store.project = JSON.parse(json);
  store.project.id = keepId;
  ensureSelection();
  if (transport.pos && store.project.arrangement.length === 0 && transport.pos.song) transport.stop();
  engine.applyAll();
  save(); emit('project');
}
export function undo() { const s = history.undo(JSON.stringify(store.project)); if (s) { restoreSnapshot(s); emit('toast', 'Undo'); } emit('history'); }
export function redo() { const s = history.redo(JSON.stringify(store.project)); if (s) { restoreSnapshot(s); emit('toast', 'Redo'); } emit('history'); }

/** something in the current pattern changed (editor gesture already checkpointed) */
export function patternEdited() { save(); emit('pattern'); }

/* ---------- project lifecycle ---------- */
function adopt(project, msg) {
  transport.stop();
  flushSave();
  store.project = project;
  ensureSelection();
  history.clear();
  Object.assign(store.ui, { scrollX: 0, zoom: 1, arrSel: null, libSel: null });
  save(true); engine.applyAll();
  emit('project'); emit('history');
  if (msg) emit('toast', msg);
}
export function bootProject() {
  let p = null;
  const id = library.currentId();
  if (id) p = library.load(id);
  if (!p) p = library.adoptLegacy();
  if (!p) { const any = library.list()[0]; if (any) p = library.load(any.id); }
  const fresh = !p;
  if (!p) p = createDemoProject();
  store.project = p;
  ensureSelection();
  if (fresh) save(true);
  return { fresh, warning: library.migrationWarning() };
}
export function newSong({ name, bpm, mood }) { adopt(createEmptyProject({ name: name || 'Untitled song', bpm: bpm || 120, mood }), `“${name || 'Untitled song'}” — a fresh canvas`); }
export function loadDemo() { adopt(createDemoProject(), 'Demo jam loaded — your other songs are in Open'); }
export function openProject(id) {
  const p = library.load(id);
  if (!p) { emit('toast', 'Could not open that song'); return; }
  adopt(p, `Opened “${p.name}”`);
}
export function deleteProject(id) {
  if (id === store.project.id) return;
  library.remove(id); emit('library');
}
export function renameProject(name) {
  name = String(name || '').trim().slice(0, 60); if (!name) return;
  checkpoint(); store.project.name = name; save(); emit('meta');
}
export function duplicateProject() {
  const copy = clone(store.project);
  copy.id = createEmptyProject().id; copy.name = `${store.project.name} (copy)`; copy.created = new Date().toISOString();
  adopt(copy, `Saved a copy: “${copy.name}”`);
}
export function exportProject() {
  const data = JSON.stringify(store.project, null, 1);
  const safe = store.project.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'song';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = `harbumatic-${safe}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  emit('toast', 'Song exported as a file');
}
export async function importFile(file) {
  try {
    const p = importProject(JSON.parse(await file.text()));
    p.id = createEmptyProject().id; // never overwrite an existing library entry
    adopt(p, `Imported “${p.name}”`);
  } catch (e) {
    emit('toast', e instanceof ProjectError ? e.message : 'That file is not a HarbuMatic project');
  }
}

/* ---------- selection / modes ---------- */
export function selectSlot(id) {
  if (store.ui.sel === id || !slot(id) || !isPlayableType(slot(id).type)) return; // planned instruments (MUNCH) cannot be selected
  const u = store.ui;
  u.sel = id; u.scrollX = 0; u.zoom = 1;
  if (!typeOf(id).ui.tools.includes(u.tool)) u.tool = 'draw'; // e.g. Slide exists only where slides do
  emit('selection');
}
export function selectScene(i) {
  const p = store.project;
  if (p.scene === i) { transport.queueScene(i); emit('scene'); return; }
  p.scene = i; save();
  transport.queueScene(i);
  emit('scene');
}
export function setMode(m) { store.ui.mode = m; if (m !== 'jam') store.ui.expanded = false; store.ui.drawer = false; emit('layout'); }
export function setExpanded(on) { store.ui.expanded = on; store.ui.drawer = false; if (store.ui.mode !== 'jam') store.ui.mode = 'jam'; emit('layout'); }
export function setDrawer(on) { store.ui.drawer = on; emit('drawer'); }
export function setTool(k) { store.ui.tool = k; emit('tool'); }

/* ---------- transport ---------- */
export function togglePlay() { engine.init(); engine.applyAll(); transport.toggle(); }
export function stop() { transport.stop(); }
const drumSlots = () => store.project.slots.filter(s => typeOfSlot(s).role === 'drums');
export function setBpm(v) {
  const b = clamp(Math.round(v), 50, 200); if (b === store.project.bpm) return;
  checkpoint('bpm'); store.project.bpm = b;
  const first = playableSlots(store.project)[0]; if (first) engine.applyParams(first.id); // re-times the echo
  save(); emit('tempo');
}
// the drum Movement shaper *is* the swing amount, so keep them in step
export function setSwing(v) { checkpoint('swing'); store.project.swing = clamp(v, 0, .5); drumSlots().forEach(s => { s.macros.movement = clamp(v * 2, 0, 1); }); save(); emit('tempo'); }
export function setSongMode(on) { store.project.songMode = on; save(); emit('arrangement'); emit('transport'); }

/* ---------- sound ---------- */
export function setParam(t, k, v, coalesce = true) {
  if (coalesce) checkpoint(`p:${t}:${k}`);
  P(t)[k] = v; engine.applyParams(t); save(); emit('params', t);
}
export function toggleParam(t, k) { checkpoint(); P(t)[k] = !P(t)[k]; engine.init(); engine.applyParams(t); save(); emit('params', t); }
export function applyPreset(t, vals) { checkpoint(); Object.assign(P(t), vals); engine.applyParams(t); save(); emit('params', t); }
export function setMacro(t, k, v) {
  checkpoint(`m:${t}:${k}`);
  slot(t).macros[k] = v; applyMacroParams(store.project, t, k); engine.applyParams(t); save(); emit('params', t);
  if (typeOf(t).role === 'drums' && k === 'movement') emit('tempo');
}
export function setFx(k, v) { checkpoint(`fx:${k}`); store.project.fx[k] = v; engine.applyGlobalFx(); save(); }
const applyMix = () => playableSlots(store.project).forEach(s => engine.applyParams(s.id));
export function toggleMute(t) { checkpoint(); const tr = slot(t); tr.mute = !tr.mute; applyMix(); save(); emit('mix'); }
export function toggleSolo(t) { checkpoint(); const tr = slot(t); tr.solo = !tr.solo; applyMix(); save(); emit('mix'); }

/* ---------- Happy Accident Lab ---------- */
export function setLab(k, v) { store.project.lab[k] = v; save(); emit('lab'); }
export function setKeyScale(key, scale) { checkpoint(); store.project.key = key; store.project.scale = scale; save(); emit('pattern'); emit('lab'); }

/** run a generative operation on the selected instrument slot of the selected scene */
export function runTransform(kind, slotId = store.ui.sel, { silent = false, sceneIdx = store.project.scene, history: rec = true } = {}) {
  const def = typeOf(slotId);
  if (!def.capabilities.generate) return null; // generators exist per musical role; a type without one is left alone
  engine.init();
  const project = store.project, p = patternAt(project, slotId, sceneIdx), role = def.role;
  if (rec) checkpoint();
  const rng = createRng(randomSeed());
  const ctx = buildContext(project, sceneIdx, { rng, forLen: p.len, ensureHarmony: MELODIC.includes(role) });
  if (ctx.harmonyNew) project.scenes[sceneIdx].harmony = ctx.harmony;
  const r = transformPattern(kind, role, p, ctx, rng);
  setPatternAt(project, slotId, sceneIdx, r.pattern);
  if (r.nudge) nudgeSound(slotId, r.nudge, rng);
  save();
  emit('pattern', { slot: slotId, kind });
  if (!silent) emit('transformed', { slot: slotId, kind, intensity: r.intensity, info: r.info });
  return r;
}
function nudgeSound(t, amt, rng) {
  const m = slot(t).macros;
  Object.keys(m).forEach(k => { m[k] = clamp(m[k] + rng.float(-amt, amt), 0, 1); });
  applyMacroParams(store.project, t); engine.applyParams(t); emit('params', t);
}
export function newChords() {
  checkpoint();
  const p = store.project, sc = p.scene, cur = p.scenes[sc].harmony;
  const span = cur ? cur.span : 32;
  let h, guard = 0;
  do { h = chooseHarmony(createRng(randomSeed()), { key: p.key, scale: p.scale, mood: p.lab.mood, chaos: p.lab.chaos, span }); }
  while (cur && h.degrees.join() === cur.degrees.join() && guard++ < 8);
  p.scenes[sc].harmony = h; save(); emit('lab');
  emit('toast', 'New chords — press Generate to play along with them');
}
export function setAutoEvolve(on) { store.ui.autoEvolve = on; emit('lab'); }
function autoEvolveHook(pos, boundary) {
  if (!store.ui.autoEvolve) return;
  const t = store.ui.sel, sc = store.project.scene;
  if (pos.scene !== sc) return;
  const len = patternAt(store.project, t, sc).len;
  if (!boundary(pos, len)) return;
  // runs inside the scheduler, before this step is scheduled → the new loop plays the evolved pattern
  runTransform('evolve', t, { silent: true });
  emit('evolved');
}

/* ---------- snapshots ---------- */
// Snapshots store every slot's pattern + macros under its slot id, together with the instrument type.
export function snapshotSave(i) {
  const p = store.project, slots = {};
  p.slots.forEach(s => { slots[s.id] = { type: s.type, pattern: clone(pat(s.id)), macros: clone(s.macros) }; });
  p.snaps[i] = { slots }; save(); emit('lab'); emit('toast', `Saved scene to snapshot ${i + 1}`);
}
export function snapshotRecall(i) {
  const p = store.project, s = p.snaps[i]; if (!s) return;
  checkpoint();
  p.slots.forEach(sl => {
    const e = s.slots[sl.id];
    if (!e || e.type !== sl.type) return; // only into the same kind of instrument
    setPatternAt(p, sl.id, p.scene, clone(e.pattern)); sl.macros = clone(e.macros); applyMacroParams(p, sl.id);
  });
  engine.applyAll(); save(); emit('project'); emit('toast', `Recalled snapshot ${i + 1}`);
}
export function snapshotClear(i) { store.project.snaps[i] = null; save(); emit('lab'); }

/* ---------- pattern-level edits used by toolbars ---------- */
export function setLength(len) {
  const p = pat(); if (p.len === len) return;
  checkpoint(); const old = p.len; p.len = len;
  if (isDrumSlot()) Object.keys(p.steps).forEach(id => { const r = p.steps[id]; p.steps[id] = Array.from({ length: len }, (_, i) => (i < old ? r[i] : null)); });
  else p.notes = p.notes.filter(n => n.s < len).map(n => ({ ...n, l: Math.min(n.l, len - n.s) }));
  store.ui.zoom = 1; store.ui.scrollX = 0; save(); emit('pattern');
}
export function doubleLength() {
  const p = pat(); if (p.len >= 64) return;
  checkpoint(); const old = p.len; p.len = old * 2;
  if (isDrumSlot()) Object.keys(p.steps).forEach(id => { p.steps[id] = [...p.steps[id], ...p.steps[id].map(c => (c ? { ...c } : null))]; });
  else p.notes = [...p.notes, ...p.notes.map(n => ({ ...n, s: n.s + old }))];
  save(); emit('pattern'); emit('toast', `Pattern doubled → ${p.len / 16} bars`);
}
export function clearPattern() {
  checkpoint(); const p = pat();
  const drums = isDrumSlot();
  if (drums) Object.keys(p.steps).forEach(id => { if (!p.locked[id]) p.steps[id] = Array(p.len).fill(null); });
  else p.notes = p.notes.filter(n => n.locked);
  save(); emit('pattern'); emit('toast', `${typeOf().name} cleared${drums ? '' : ' (locked notes kept)'}`);
}

/* ---------- scenes + arrangement ---------- */
export function renameScene(i, name) { checkpoint(); store.project.scenes[i].name = String(name).trim().slice(0, 24) || store.project.scenes[i].name; save(); emit('arrangement'); emit('scene'); }
export function copyScene(a, b) {
  checkpoint();
  const p = store.project;
  p.slots.forEach(s => { setPatternAt(p, s.id, b, clone(patternAt(p, s.id, a))); });
  p.scenes[b].harmony = clone(p.scenes[a].harmony);
  save(); emit('pattern'); emit('arrangement'); emit('toast', `Scene ${SCENE_LETTERS[a]} copied to ${SCENE_LETTERS[b]}`);
}
export function clearScene(i) {
  checkpoint();
  const p = store.project;
  p.slots.forEach(s => { setPatternAt(p, s.id, i, createPatternFor(s.type)); });
  p.scenes[i].harmony = null;
  save(); emit('pattern'); emit('arrangement'); emit('toast', `Scene ${SCENE_LETTERS[i]} cleared`);
}
export function addToSong(sc, at = null) {
  checkpoint();
  const b = newBlock(sceneIdAt(store.project, sc)), arr = store.project.arrangement;
  if (at == null) arr.push(b); else arr.splice(at, 0, b);
  store.ui.arrSel = b.id; store.ui.revealSel = true; save(); emit('arrangement');
}
const blockIndex = id => store.project.arrangement.findIndex(b => b.id === id);
export function removeBlock(id) { const i = blockIndex(id); if (i < 0) return; checkpoint(); store.project.arrangement.splice(i, 1); const arr = store.project.arrangement; store.ui.arrSel = arr[Math.min(i, arr.length - 1)]?.id ?? null; save(); emit('arrangement'); }
export function duplicateBlock(id) { const i = blockIndex(id); if (i < 0) return; checkpoint(); const src = store.project.arrangement[i], b = { ...src, id: newBlock(src.sceneId).id }; store.project.arrangement.splice(i + 1, 0, b); store.ui.arrSel = b.id; save(); emit('arrangement'); }
export function moveBlock(id, to) {
  const arr = store.project.arrangement, i = blockIndex(id);
  to = clamp(to, 0, arr.length - 1);
  if (i < 0 || i === to) return;
  checkpoint(); const [b] = arr.splice(i, 1); arr.splice(to, 0, b); save(); emit('arrangement');
}
export function setReps(id, reps) { const i = blockIndex(id); if (i < 0) return; checkpoint(`reps:${id}`); store.project.arrangement[i].reps = clampReps(reps); save(); emit('arrangement'); }
export function setBlockScene(id, sc) { const i = blockIndex(id); if (i < 0) return; checkpoint(); store.project.arrangement[i].sceneId = sceneIdAt(store.project, sc); save(); emit('arrangement'); }
export function clearSong() { checkpoint(); store.project.arrangement = []; store.ui.arrSel = null; if (transport.pos && transport.pos.song) transport.stop(); save(); emit('arrangement'); }
export function playFromBlock(id) {
  const i = blockIndex(id); if (i < 0) return;
  engine.init(); engine.applyAll();
  store.project.songMode = true; save();
  transport.playFromBlock(i); emit('arrangement');
}
export function previewScene(i) {
  engine.init(); engine.applyAll();
  const p = store.project;
  if (p.songMode) { p.songMode = false; emit('arrangement'); }
  p.scene = i; save();
  if (transport.state === 'playing') transport.queueScene(i);
  else { transport.stop(); transport.play(); }
  emit('scene');
}
export const toastMsg = m => emit('toast', m);
export const emitTool = () => emit('tool');
