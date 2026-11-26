// Actions: the only place that mutates the project in response to the UI.
// Views call actions; actions save, record history and emit events; main.js re-renders.

import { store, emit, P, pat, slot, typeOf, isDrumSlot, isBreakSlot, visibleSlots, MAX_VISIBLE_CARDS, ensureSelection, isSamplerSlot } from './store.js';
import { MELODIC, MAX_SCENES, sceneLabel } from '../core/constants.js';
import { clone, clamp } from '../core/util.js';
import { createHistory } from '../core/history.js';
import { createLibrary } from '../core/persistence.js';
import {
  createEmptyProject, createDemoProject, importProject, newBlock, clampReps, ProjectError,
  playableSlots, patternAt, setPatternAt, sceneIdAt, sceneIndexOf, blockScene, typeOfSlot,
  nextSceneId, nextSceneName, duplicateSceneName,
} from '../core/project.js';
import {
  exportPackage, parsePackage, restorePackage, isZipBytes, PackageError,
  PACKAGE_EXTENSION, PACKAGE_MIME, PACKAGE_LIMITS,
} from '../core/package.js';
import { createPatternFor, isPlayableType, isSelectableType, BREAK_LANES } from '../core/instruments.js';
import {
  sampleRefFor, sampleRefsOf, defaultSlices, moveSliceBoundary, SLICE_REF_PITCH, insertSliceBoundary, splitSlice,
  removeSliceBoundary, remapSlotSlices, sliceAt, sliceCount, fitInfo, fitRate, fitPlayback, FIT_BARS, FIT_MODES, MAX_SLICES, MIN_SLICE,
} from '../core/samples.js';
import {
  getBuiltinBreak, breakRefsOf, breakFitPlayback, laneVolKey, laneMuteKey, isBuiltinBreakId,
  isImportedBreakId, resolveBreakDesc, cleanImportedBreakMeta, cleanBreakMetaMap, bpmForBars,
  breakBarsOf, breakSlicesOf, breakPosBeatLabel, remapBreakSlotSlices, IMPORTED_BREAK_BARS, BREAK_BPM_RANGE,
  hasAssignedBreak, isBreakLaneEdited, originalGrooveRow, effectiveBreakRow, suggestedSliceForStep,
  clampBreakSlice, BREAK_PATTERN_STEPS, breakCellLockKey, isBreakLaneLocked,
  isBreakCellDirectlyLocked, isBreakCellLocked,
} from '../core/breaks.js';
import { isWavBytes, analyzeBreakBuffer, extractSliceFeatures } from '../samples/break-analysis.js';
import { magicChop as magicChopPattern, MAGIC_LABEL } from '../music/magicchop.js';
import {
  chopBreakPattern, RUFF_CHOP_MODES, RUFF_CHOP_PROFILES, RUFF_PROFILE_META,
} from '../music/ruffchop.js';
import { createSampleStore, indexedDbBackend, SampleError } from '../samples/store.js';
import { createSampleBank } from '../samples/bank.js';
import { createRecorder, canRecord, recordSupport } from '../samples/recorder.js';
import { createRng, randomSeed } from '../core/rng.js';
import { buildContext } from '../music/context.js';
import { transformPattern } from '../music/transform.js';
import { chooseHarmony } from '../music/harmony.js';
import { applyMacros as applyMacroParams } from '../music/macros.js';
import { createEngine } from '../audio/engine.js';
import { createTransport, createSlicePreview } from '../audio/scheduler.js';
import { isLoopBoundary } from '../audio/position.js';
import { computeStepPlacement, recordDrumEvent, recordNoteOnEvent, finalizeNoteLength } from '../audio/recording.js';

export const history = createHistory();
export const library = createLibrary(safeStorage());
// MUNCH samples: durable assets in IndexedDB (opened on first use), decoded buffers in the bank
export const samples = createSampleBank({ store: createSampleStore({ backend: indexedDbBackend() }) });
export const engine = createEngine(() => store.project, { samples });
export const transport = createTransport(engine, () => store.project, {
  onState: st => { handleTransportStateForRec(st); emit('transport'); },
  beforeStep: (pos, boundary) => autoEvolveHook(pos, boundary),
});
export const munchPreview = createSlicePreview(engine, () => store.project, {
  onState: () => emit('munchpreview'),
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

/** Keep UI scene references (ARRANGE library selection, block selection, MUNCH pending magic) valid after scene mutations or undo/redo. */
function reconcileUiScenes(prev, next) {
  const maxSc = Math.max(0, next.scenes.length - 1);
  if (store.ui.libSel != null) {
    const prevLibId = prev ? sceneIdAt(prev, store.ui.libSel) : null;
    const mapped = prevLibId ? sceneIndexOf(next, prevLibId) : -1;
    store.ui.libSel = mapped >= 0 ? mapped : clamp(store.ui.libSel, 0, maxSc);
  }
  if (store.ui.arrSel && !next.arrangement.some(b => b.id === store.ui.arrSel)) store.ui.arrSel = null;
  const magic = store.ui.munch && store.ui.munch.magic;
  if (magic) {
    const prevMagicId = prev ? sceneIdAt(prev, magic.scene) : null;
    const mapped = prevMagicId ? sceneIndexOf(next, prevMagicId) : -1;
    if (mapped >= 0) magic.scene = mapped;
    else store.ui.munch.magic = null;
  }
}

/** Keep active/paused transport position and queued scene valid after scene delete, reorder or undo/redo. */
function reconcileTransport(prev, next) {
  const prevPos = transport.pos;
  if (!prevPos) {
    if (transport.pending != null) transport.reconcile(null, null);
    return;
  }
  const maxSc = Math.max(0, next.scenes.length - 1);
  const prevSceneId = prev ? sceneIdAt(prev, prevPos.scene) : null;
  const prevPendingId = prev && transport.pending != null ? sceneIdAt(prev, transport.pending) : null;
  const prevBlockId = prev && prevPos.song && prev.arrangement[prevPos.block] ? prev.arrangement[prevPos.block].id : null;

  if (prevPos.song) {
    if (next.arrangement.length === 0) {
      transport.stop();
      return;
    }
    if (!next.songMode) {
      const mapped = prevSceneId ? sceneIndexOf(next, prevSceneId) : -1;
      const nextPos = mapped >= 0
        ? { ...prevPos, song: false, block: 0, rep: 0, scene: mapped }
        : { song: false, block: 0, rep: 0, scene: clamp(next.scene, 0, maxSc), step: 0, fresh: true };
      transport.reconcile(nextPos, null);
      return;
    }
    const newBlockIdx = prevBlockId ? next.arrangement.findIndex(b => b.id === prevBlockId) : -1;
    if (newBlockIdx >= 0) {
      const newSceneIdx = blockScene(next, next.arrangement[newBlockIdx]);
      const sameScene = sceneIdAt(next, newSceneIdx) === prevSceneId;
      const nextPos = sameScene
        ? { ...prevPos, song: true, block: newBlockIdx, scene: newSceneIdx }
        : { song: true, block: newBlockIdx, rep: 0, scene: newSceneIdx, step: 0, fresh: true };
      transport.reconcile(nextPos, null);
      return;
    }
    const fallbackBlock = clamp(prevPos.block, 0, next.arrangement.length - 1);
    const fallbackScene = blockScene(next, next.arrangement[fallbackBlock]);
    transport.reconcile({ song: true, block: fallbackBlock, rep: 0, scene: fallbackScene, step: 0, fresh: true }, null);
    return;
  }

  const mappedScene = prevSceneId ? sceneIndexOf(next, prevSceneId) : -1;
  const nextPos = mappedScene >= 0
    ? { ...prevPos, song: false, scene: mappedScene }
    : { song: false, block: 0, rep: 0, scene: clamp(next.scene, 0, maxSc), step: 0, fresh: true };
  let nextPending = null;
  if (prevPendingId) {
    const mappedPending = sceneIndexOf(next, prevPendingId);
    if (mappedPending >= 0 && mappedPending !== nextPos.scene) nextPending = mappedPending;
  }
  transport.reconcile(nextPos, nextPending);
}

function restoreSnapshot(json) {
  finalizeRecording();
  stopBreakAudition();
  const prev = store.project;
  const keepId = prev.id;
  store.project = JSON.parse(json);
  store.project.id = keepId;
  store.project.scene = clamp(store.project.scene, 0, Math.max(0, store.project.scenes.length - 1));
  ensureSelection();
  reconcileUiScenes(prev, store.project);
  reconcileTransport(prev, store.project);
  if (munchPreview.playing) {
    const s = munchPreview.slotId ? slot(munchPreview.slotId) : null;
    if (!s || !s.sample || store.project.scene !== munchPreview.scene) stopMunchPreview();
  }
  if (store.project && Array.isArray(store.project.slots)) {
    for (const s of store.project.slots) {
      if (s.breakMeta) {
        for (const [id, m] of Object.entries(s.breakMeta)) {
          if (isImportedBreakId(id) && m) localBreakPool.set(id, clone(m));
        }
      }
    }
  }
  engine.applyAll(); syncSamples(); prepareStretch();
  save(); emit('project');
}
export function undo() { finalizeRecording(); const s = history.undo(JSON.stringify(store.project)); if (s) { restoreSnapshot(s); emit('toast', 'Undo'); } emit('history'); }
export function redo() { finalizeRecording(); const s = history.redo(JSON.stringify(store.project)); if (s) { restoreSnapshot(s); emit('toast', 'Redo'); } emit('history'); }

/** something in the current pattern changed (editor gesture already checkpointed) */
export function patternEdited() { save(); emit('pattern'); }

/* ---------- project lifecycle ---------- */
function adopt(project, msg, { saved = false } = {}) {
  finalizeRecording();
  stopMunchPreview();
  stopBreakAudition();
  transport.stop();
  if (!saved) flushSave();
  store.project = project;
  ensureSelection();
  history.clear();
  Object.assign(store.ui, { scrollX: 0, zoom: 1, arrSel: null, libSel: null });
  if (!saved) save(true);
  engine.applyAll(); syncSamples();
  emit('project'); emit('history');
  if (saved) emit('library');
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
  syncSamples();
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
function uniqueProjectId(lib = library) {
  const used = new Set(lib.list().map(x => x.id));
  if (store.project && store.project.id) used.add(store.project.id);
  let id = createEmptyProject().id;
  while (used.has(id)) id = createEmptyProject().id;
  return id;
}
function referencedSampleIds(lib = library) {
  const ids = new Set(sampleRefsOf(store.project));
  for (const item of lib.list()) {
    const p = store.project && item.id === store.project.id ? store.project : lib.load(item.id);
    if (p) sampleRefsOf(p).forEach(id => ids.add(id));
  }
  return ids;
}
function downloadBlob(bytes, filename, type = PACKAGE_MIME) {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return;
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export async function exportProject({ sampleStore = samples.store, download = downloadBlob, limits = PACKAGE_LIMITS } = {}) {
  try {
    const pkg = await exportPackage(store.project, { sampleStore, limits });
    const safe = store.project.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'song';
    const filename = `harbumatic-${safe}${PACKAGE_EXTENSION}`;
    download(pkg.bytes, filename, PACKAGE_MIME);
    const n = pkg.sampleCount;
    emit('toast', n
      ? `Exported “${store.project.name}” (${PACKAGE_EXTENSION}) with ${n} sample${n === 1 ? '' : 's'}`
      : `Exported “${store.project.name}” (${PACKAGE_EXTENSION})`);
    return { ok: true, filename, bytes: pkg.bytes, manifest: pkg.manifest, sampleCount: n };
  } catch (e) {
    emit('toast', e instanceof PackageError ? e.message : 'Could not export portable project (.hbn).');
    return { ok: false, error: e };
  }
}
export async function importFile(file, { sampleStore = samples.store, decode, lib = library, limits = PACKAGE_LIMITS } = {}) {
  if (!file) return null;
  const lim = { ...PACKAGE_LIMITS, ...limits };
  try {
    const name = String(file.name || '').toLowerCase();
    const isHbnName = name.endsWith(PACKAGE_EXTENSION);
    const isJsonName = name.endsWith('.json');
    if (typeof file.size === 'number') {
      if (isJsonName && file.size > lim.maxProjectBytes) throw new PackageError('too-large', 'That project file is too large.');
      if (!isJsonName && file.size > lim.maxArchiveBytes) {
        throw new PackageError('too-large', `That .hbn file is too large (${Math.ceil(file.size / 1048576)} MB; max ${Math.round(lim.maxArchiveBytes / 1048576)} MB).`);
      }
    }

    let rawJsonText = null;
    let packageBytes = null;
    if (isJsonName) {
      rawJsonText = typeof file.text === 'function' ? await file.text() : new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    } else {
      const u8 = new Uint8Array(await file.arrayBuffer());
      if (isHbnName || isZipBytes(u8)) packageBytes = u8;
      else rawJsonText = new TextDecoder('utf-8', { fatal: true }).decode(u8);
    }

    if (packageBytes) {
      const parsed = await parsePackage(packageBytes, { limits: lim });
      let dec = decode;
      if (parsed.samples.length > 0 && dec === undefined && sampleStore === samples.store) {
        if (canSound()) engine.init();
        dec = samples.attached ? samples.decode : undefined;
      }
      const restored = await restorePackage(parsed, { sampleStore, decode: dec, referenced: referencedSampleIds(lib) });
      [...restored.restored, ...restored.reused].forEach(id => warnedMissing.delete(id));

      const p = restored.project;
      flushSave();
      const prevCurrent = lib.currentId();
      p.id = uniqueProjectId(lib); // never overwrite an existing library entry
      p.modified = new Date().toISOString();
      const savedOk = lib.save(p) && !!lib.load(p.id);
      if (!savedOk) {
        try { lib.remove(p.id); } catch (e) { /* best effort */ }
        if (prevCurrent) lib.setCurrent(prevCurrent);
        await restored.cleanup();
        throw new PackageError('storage-error', 'Could not save the imported song to this browser’s storage.');
      }
      if (parsed.samples.length > 0) {
        askPersist();
        refreshLocalBreakPool({ sampleStore });
      }
      const n = parsed.samples.length;
      adopt(p, n ? `Imported “${p.name}” with ${n} sample${n === 1 ? '' : 's'}` : `Imported “${p.name}”`, { saved: true });
      return p;
    }

    const p = importProject(JSON.parse(rawJsonText));
    flushSave();
    const prevCurrent = lib.currentId();
    p.id = uniqueProjectId(lib); // never overwrite an existing library entry
    p.modified = new Date().toISOString();
    const savedOk = lib.save(p) && !!lib.load(p.id);
    if (!savedOk) {
      try { lib.remove(p.id); } catch (e) { /* best effort */ }
      if (prevCurrent) lib.setCurrent(prevCurrent);
      throw new PackageError('storage-error', 'Could not save the imported song to this browser’s storage.');
    }
    adopt(p, `Imported “${p.name}”`, { saved: true });
    return p;
  } catch (e) {
    emit('toast', e instanceof PackageError || e instanceof ProjectError ? e.message : 'That file is not a HarbuMatic project');
    return null;
  }
}

/* ---------- selection / modes ---------- */
export function shiftStrip(delta) {
  const vis = visibleSlots();
  const maxOff = Math.max(0, vis.length - MAX_VISIBLE_CARDS);
  const next = clamp((store.ui.stripOffset || 0) + delta, 0, maxOff);
  if (next === store.ui.stripOffset) return;
  store.ui.stripOffset = next;
  emit('strip');
}
export function selectSlot(id) {
  if (store.ui.sel === id || !slot(id) || !isSelectableType(slot(id).type)) return; // planned-hidden instruments cannot be selected
  finalizeHeldRecNotes();
  stopMunchPreview();
  stopBreakAudition();
  const u = store.ui, wasSampler = isSamplerSlot(), nav = u.munchNav;
  u.sel = id; u.scrollX = 0; u.zoom = 1;
  const tools = typeOf(id).ui.tools;
  if (tools.length && !tools.includes(u.tool)) u.tool = tools[0]; // e.g. Slide exists only where slides do
  const vis = visibleSlots(), idx = vis.findIndex(s => s.id === id);
  if (idx >= 0) {
    const maxOff = Math.max(0, vis.length - MAX_VISIBLE_CARDS);
    let off = clamp(u.stripOffset || 0, 0, maxOff);
    if (idx < off) off = idx;
    else if (idx >= off + MAX_VISIBLE_CARDS) off = idx - MAX_VISIBLE_CARDS + 1;
    u.stripOffset = off;
  }
  // MUNCH lives in its SOUND workspace: selecting it opens SOUND, unless the player left that workspace on purpose.
  // When MUNCH opened SOUND by itself, selecting another instrument returns to the mode it came from. The other
  // instruments never change the mode.
  let layout = false;
  if (isSamplerSlot(id)) {
    if (!nav.away && u.mode !== 'sound') { nav.autoFrom = u.mode; u.mode = 'sound'; u.expanded = false; u.drawer = false; layout = true; }
  } else if (wasSampler && nav.autoFrom && u.mode === 'sound') { u.mode = nav.autoFrom; nav.autoFrom = null; u.drawer = false; layout = true; }
  else nav.autoFrom = null;
  emit('selection');
  if (layout) emit('layout');
}
/** the player chose a mode with the mode buttons (or Deep edit): this is explicit navigation */
function navigated(m) {
  const nav = store.ui.munchNav;
  nav.autoFrom = null;
  if (isSamplerSlot()) nav.away = m !== 'sound';
}
export function selectScene(i) {
  const p = store.project;
  if (!Number.isInteger(i) || i < 0 || i >= p.scenes.length) return;
  if (p.scene === i) { transport.queueScene(i); emit('scene'); return; }
  if (recSession) finalizeRecording();
  stopMunchPreview();
  p.scene = i; save();
  transport.queueScene(i);
  emit('scene');
}
export function setMode(m) { if (m !== 'sound') stopMunchPreview(); navigated(m); store.ui.mode = m; if (m !== 'jam') store.ui.expanded = false; store.ui.drawer = false; emit('layout'); }
export function setExpanded(on) { stopMunchPreview(); navigated('jam'); store.ui.expanded = on; store.ui.drawer = false; if (store.ui.mode !== 'jam') store.ui.mode = 'jam'; emit('layout'); }
export function setDrawer(on) { store.ui.drawer = on; emit('drawer'); }
export function setTool(k) { store.ui.tool = k; emit('tool'); }

/* ---------- transport ---------- */
export function togglePlay() {
  stopMunchPreview();
  stopBreakAudition();
  engine.init(); engine.applyAll();
  // a sample or break still decoding (e.g. right after opening a song) gets a moment, so the first beat is not silent
  const ids = playingSampleIds();
  if (transport.state !== 'playing' && ids.length && samples.isLoading(ids)) { samples.whenSettled(ids, 2000).then(() => { if (transport.state !== 'playing') transport.toggle(); }); return; }
  transport.toggle();
}
export function stop() { finalizeRecording(); stopMunchPreview(); stopBreakAudition(); transport.stop(); }
const drumSlots = () => store.project.slots.filter(s => typeOfSlot(s).role === 'drums');
export function setBpm(v) {
  const b = clamp(Math.round(v), 50, 200); if (b === store.project.bpm) return;
  checkpoint('bpm'); store.project.bpm = b;
  const playable = playableSlots(store.project);
  if (playable[0]) engine.applyParams(playable[0].id); // re-times the echo
  playable.forEach(s => { if (isBreakSlot(s.id)) engine.applyParams(s.id); }); // live Tape rate update for RUFF
  prepareStretch(); // Stretch: a new tempo needs a new stretched copy (until then the closest one plays at exact timing)
  save(); emit('tempo');
}
// the drum Movement shaper *is* the swing amount, so keep them in step
export function setSwing(v) { checkpoint('swing'); store.project.swing = clamp(v, 0, .5); drumSlots().forEach(s => { s.macros.movement = clamp(v * 2, 0, 1); }); save(); emit('tempo'); }
export function setSongMode(on) { store.project.songMode = on; save(); emit('arrangement'); emit('transport'); }

/* ---------- live pattern recording ---------- */
// One recording session targets one scene at a time (never song-wide) and produces at most one
// Undo/Redo history entry (created lazily on the first actual pattern mutation; empty sessions
// create no history entry). Pause suspends the session and Resume continues the same session.
let recSession = null; // { sceneId, checkpointed, recordedCount, held: Map<token, { slotId, sceneId, note, downTime, stepDur }> }
let nextRecToken = 1;

export const recState = () => store.ui.rec.mode;
export const isRecording = () => store.ui.rec.mode === 'recording';
export const isRecArmed = () => store.ui.rec.mode === 'armed';
export const isRecPaused = () => store.ui.rec.mode === 'paused';
export const recQuantize = () => !!store.ui.rec.quantize;

export function setRecQuantize(on) {
  const v = !!on;
  if (store.ui.rec.quantize === v) return;
  store.ui.rec.quantize = v;
  emit('rec');
}
export function toggleRecQuantize() {
  setRecQuantize(!store.ui.rec.quantize);
  return store.ui.rec.quantize;
}

function beginRecSession(sceneIdx) {
  const p = store.project;
  if (!p) return false;
  const sc = clamp(Number.isInteger(sceneIdx) ? sceneIdx : p.scene, 0, Math.max(0, p.scenes.length - 1));
  const sceneId = sceneIdAt(p, sc);
  if (!sceneId) return false;
  recSession = { sceneId, checkpointed: false, recordedCount: 0, held: new Map() };
  store.ui.rec.mode = 'recording';
  if (p.scene !== sc) { p.scene = sc; emit('scene'); }
  emit('rec');
  return true;
}

export function finalizeHeldRecNotes(audioTime = null) {
  if (!recSession || !recSession.held.size) return;
  const now = typeof audioTime === 'number' && Number.isFinite(audioTime)
    ? audioTime
    : (engine.ctx ? engine.ctx.currentTime : null);
  let anyChanged = false;
  const slotsTouched = new Set();
  for (const [, entry] of recSession.held) {
    const t = now != null ? now : entry.downTime;
    const elapsedSteps = entry.stepDur > 0 ? Math.max(0, t - entry.downTime) / entry.stepDur : 1;
    const s = slot(entry.slotId), p = s && s.patterns[entry.sceneId];
    if (p && finalizeNoteLength(p, entry.note, elapsedSteps)) {
      anyChanged = true;
      slotsTouched.add(entry.slotId);
    }
  }
  recSession.held.clear();
  if (anyChanged) {
    for (const sid of slotsTouched) emit('pattern', { slot: sid, liveRec: true });
  }
}

export function finalizeRecording({ keepArmed = false } = {}) {
  const hadSession = !!recSession;
  let dirty = false, hadCp = false;
  if (recSession) {
    finalizeHeldRecNotes();
    dirty = recSession.recordedCount > 0;
    hadCp = recSession.checkpointed;
    recSession = null;
  }
  const next = keepArmed ? 'armed' : 'off';
  const changed = store.ui.rec.mode !== next;
  store.ui.rec.mode = next;
  if (hadCp) history.seal();
  if (dirty) save();
  if (changed || hadSession) emit('rec');
}

function suspendRecSession() {
  if (!recSession) { store.ui.rec.mode = 'off'; emit('rec'); return; }
  finalizeHeldRecNotes();
  store.ui.rec.mode = 'paused';
  emit('rec');
}

function resumeRecSession(sceneIdx) {
  const p = store.project;
  if (!recSession || !p) { store.ui.rec.mode = 'off'; emit('rec'); return; }
  const sc = clamp(Number.isInteger(sceneIdx) ? sceneIdx : p.scene, 0, Math.max(0, p.scenes.length - 1));
  if (sceneIdAt(p, sc) !== recSession.sceneId) {
    finalizeRecording();
    return;
  }
  store.ui.rec.mode = 'recording';
  emit('rec');
}

function handleTransportStateForRec(st) {
  if (!store.project) return;
  const mode = store.ui.rec.mode;
  if (st === 'playing') {
    const mt = transport.musicalTimeAt();
    const sc = mt ? mt.scene : (transport.position ? transport.position.scene : store.project.scene);
    if (mode === 'armed') beginRecSession(sc);
    else if (mode === 'paused') resumeRecSession(sc);
  } else if (st === 'paused') {
    if (mode === 'recording') suspendRecSession();
  } else if (st === 'stopped') {
    if (mode !== 'off' || recSession) finalizeRecording();
  }
}

export function onAudibleSceneChange(sceneIdx) {
  if (!recSession || !store.project) return;
  const mode = store.ui.rec.mode;
  if (mode !== 'recording' && mode !== 'paused') return;
  if (sceneIdAt(store.project, sceneIdx) !== recSession.sceneId) finalizeRecording();
}

export function toggleRecord() {
  const mode = store.ui.rec.mode;
  if (mode === 'recording' || mode === 'paused') {
    finalizeRecording();
    return store.ui.rec.mode;
  }
  if (mode === 'armed') {
    store.ui.rec.mode = 'off';
    emit('rec');
    return store.ui.rec.mode;
  }
  // mode === 'off'
  if (transport.state === 'playing') {
    stopMunchPreview();
    const mt = transport.musicalTimeAt();
    const sc = mt ? mt.scene : (transport.position ? transport.position.scene : store.project.scene);
    beginRecSession(sc);
  } else {
    store.ui.rec.mode = 'armed';
    emit('rec');
  }
  return store.ui.rec.mode;
}

function captureTarget(slotId, audioTime) {
  if (store.ui.rec.mode !== 'recording' || !recSession || !transport.playing) return null;
  const mt = transport.musicalTimeAt(audioTime);
  if (!mt) return null;
  const sceneId = sceneIdAt(store.project, mt.scene);
  if (!sceneId || sceneId !== recSession.sceneId) {
    finalizeRecording();
    return null;
  }
  const s = slot(slotId), pattern = s && s.patterns[sceneId];
  if (!s || !pattern) return null;
  return { mt, sceneId, slot: s, pattern };
}

function checkpointBeforeFirstRecMutation() {
  if (!recSession || recSession.checkpointed) return;
  history.seal();
  checkpoint();
  recSession.checkpointed = true;
}

/** Play a live drum hit immediately and record it when live pattern recording is active. */
export function liveDrumHit(slotId = store.ui.sel, drumId, velocity = .85, audioTime) {
  const v = clamp(Number(velocity) || .85, .05, 1);
  hear(() => engine.audition(slotId, drumId, v));
  emit('livehit', { slotId, hits: [{ d: drumId, v }] });
  const target = captureTarget(slotId, audioTime);
  if (!target || typeOfSlot(target.slot).pattern !== 'drum') return { recorded: false };
  const { mt, sceneId, pattern } = target;
  if (pattern.locked && pattern.locked[drumId]) return { recorded: false, locked: true };
  const pl = computeStepPlacement(mt, pattern.len, { quantize: store.ui.rec.quantize, swing: store.project.swing });
  checkpointBeforeFirstRecMutation();
  const res = recordDrumEvent(pattern, { drumId, step: pl.step, velocity: v, offset: pl.offset });
  if (res.changed) {
    recSession.recordedCount++;
    if (pl.snappedForward) transport.suppressOnce(slotId, sceneId, pl.step, `d:${drumId}`, mt.time + mt.stepDur * .75);
    emit('pattern', { slot: slotId, liveRec: true });
    return { recorded: true, step: pl.step, offset: pl.offset, cell: res.cell };
  }
  return { recorded: false };
}

/** Play a live melodic or sampler-slice note immediately and record note-on when recording is active. */
export function liveNoteOn(slotId = store.ui.sel, pitch, velocity = .8, { slice = null, audioTime } = {}) {
  const v = clamp(Number(velocity) || .8, .05, 1);
  const p = Math.round(clamp(Number(pitch) || 60, 0, 127));
  const extra = slice != null ? { slice } : null;
  const audioHandle = hear(() => engine.noteOn(slotId, p, v, extra));
  emit('livehit', { slotId, hits: [slice != null ? { p, v, slice } : { p, v }] });
  let recToken = null;
  const target = captureTarget(slotId, audioTime);
  if (target && typeOfSlot(target.slot).pattern !== 'drum') {
    const { mt, sceneId, pattern } = target;
    const pl = computeStepPlacement(mt, pattern.len, { quantize: store.ui.rec.quantize, swing: store.project.swing });
    const locked = pattern.notes.some(n => n.locked && n.s === pl.step && (slice != null ? n.slice === slice : (n.slice == null && n.p === p)));
    if (!locked) {
      checkpointBeforeFirstRecMutation();
      const res = recordNoteOnEvent(pattern, { pitch: p, step: pl.step, velocity: v, offset: pl.offset, slice });
      if (res.changed && res.note) {
        recSession.recordedCount++;
        if (pl.snappedForward) {
          const sk = slice != null ? `s:${slice}` : `n:${res.note.p}`;
          transport.suppressOnce(slotId, sceneId, pl.step, sk, mt.time + mt.stepDur * .75);
        }
        recToken = nextRecToken++;
        recSession.held.set(recToken, { slotId, sceneId, note: res.note, downTime: mt.time, stepDur: mt.stepDur });
        if (isSamplerSlot(slotId) && store.ui.munch.magic) store.ui.munch.magic = null;
        emit('pattern', { slot: slotId, liveRec: true });
      }
    }
  }
  if (!audioHandle && !recToken) return null;
  return { audioHandle, recToken, slotId };
}

/** Release a live melodic/slice note immediately and finalize its recorded duration if active. */
export function liveNoteOff(handle, audioTime) {
  if (!handle) return false;
  const released = handle.audioHandle ? !!hear(() => engine.noteOff(handle.audioHandle)) : false;
  if (handle.recToken && recSession && recSession.held.has(handle.recToken)) {
    const entry = recSession.held.get(handle.recToken);
    recSession.held.delete(handle.recToken);
    const now = typeof audioTime === 'number' && Number.isFinite(audioTime)
      ? audioTime
      : (engine.ctx ? engine.ctx.currentTime : entry.downTime);
    const elapsedSteps = entry.stepDur > 0 ? Math.max(0, now - entry.downTime) / entry.stepDur : 1;
    const s = slot(entry.slotId), p = s && s.patterns[entry.sceneId];
    if (p && finalizeNoteLength(p, entry.note, elapsedSteps)) {
      emit('pattern', { slot: entry.slotId, liveRec: true });
    }
  }
  return released;
}

/* ---------- sound ---------- */
export function setParam(t, k, v, coalesce = true) {
  if (coalesce) checkpoint(`p:${t}:${k}`);
  P(t)[k] = v; engine.applyParams(t); if (isSamplerSlot(t) || isBreakSlot(t)) prepareStretch(); save(); emit('params', t);
}
export function toggleParam(t, k) { checkpoint(); P(t)[k] = !P(t)[k]; engine.init(); engine.applyParams(t); if (isSamplerSlot(t) || isBreakSlot(t)) prepareStretch(); save(); emit('params', t); }
export function applyPreset(t, vals) { checkpoint(); Object.assign(P(t), vals); engine.applyParams(t); save(); emit('params', t); }
export function setMacro(t, k, v) {
  checkpoint(`m:${t}:${k}`);
  slot(t).macros[k] = v; applyMacroParams(store.project, t, k); engine.applyParams(t); save(); emit('params', t);
  if (typeOf(t).role === 'drums' && k === 'movement') emit('tempo');
}
export function setFx(k, v) { checkpoint(`fx:${k}`); store.project.fx[k] = v; engine.applyGlobalFx(); save(); }
const applyMix = () => playableSlots(store.project).forEach(s => engine.applyParams(s.id));
export function toggleMute(t) { checkpoint(); const tr = slot(t); tr.mute = !tr.mute; applyMix(); save(); emit('mix'); }
export function toggleSolo(t) {
  const tr = slot(t);
  if (!tr || !isPlayableType(tr.type)) return;
  checkpoint(); tr.solo = !tr.solo; applyMix(); save(); emit('mix');
}

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
  const pt = patternAt(store.project, t, sc);
  if (!pt || !boundary(pos, pt.len)) return;
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
  if (isBreakSlot()) return;
  const p = pat(); if (p.len === len) return;
  checkpoint(); const old = p.len; p.len = len;
  if (isDrumSlot()) Object.keys(p.steps).forEach(id => { const r = p.steps[id]; p.steps[id] = Array.from({ length: len }, (_, i) => (i < old ? r[i] : null)); });
  else p.notes = p.notes.filter(n => n.s < len).map(n => ({ ...n, l: Math.min(n.l, len - n.s) }));
  store.ui.zoom = 1; store.ui.scrollX = 0; save(); emit('pattern');
}
export function doubleLength() {
  if (isBreakSlot()) return;
  const p = pat(); if (p.len >= 64) return;
  checkpoint(); const old = p.len; p.len = old * 2;
  if (isDrumSlot()) Object.keys(p.steps).forEach(id => { p.steps[id] = [...p.steps[id], ...p.steps[id].map(c => (c ? { ...c } : null))]; });
  else p.notes = [...p.notes, ...p.notes.map(n => ({ ...n, s: n.s + old }))];
  save(); emit('pattern'); emit('toast', `Pattern doubled → ${p.len / 16} bars`);
}
export function clearPattern() {
  checkpoint(); const p = pat();
  const drums = isDrumSlot(), brk = isBreakSlot();
  if (drums) Object.keys(p.steps).forEach(id => { if (!p.locked[id]) p.steps[id] = Array(p.len).fill(null); });
  else if (brk) {
    const sl = slot();
    if (!p.edited) p.edited = {};
    BREAK_LANES.forEach(id => {
      if (isBreakLaneLocked(p, id)) return;
      const breakId = (sl && sl.breaks && sl.breaks[id]) || null;
      const wasEdited = isBreakLaneEdited(p, id);
      if (!breakId && !wasEdited) return;
      const eff = effectiveBreakRow(p, id, breakId, sl && sl.breakMeta);
      p.edited[id] = true;
      p.lanes[id] = Array.from({ length: p.len }, (_, i) => {
        if (!isBreakCellLocked(p, id, i)) return null;
        if (wasEdited) return p.lanes[id][i] ? clone(p.lanes[id][i]) : null;
        const c = eff[i];
        return c ? { slice: c.slice, v: c.v ?? 1, p: c.p ?? 1 } : null;
      });
    });
  } else p.notes = p.notes.filter(n => n.locked);
  save(); emit('pattern'); emit('toast', `${typeOf().name} cleared${drums ? '' : ' (locked notes kept)'}`);
}

/* ---------- scenes + arrangement ---------- */
const validSceneIndex = (p, i) => Number.isInteger(i) && i >= 0 && i < p.scenes.length;

/** Create an independent empty scene (never auto-added to Song Arrangement). */
export function createScene({ name, select = true } = {}) {
  const p = store.project;
  if (p.scenes.length >= MAX_SCENES) { emit('toast', `A song can hold up to ${MAX_SCENES} scenes`); return null; }
  checkpoint();
  const id = nextSceneId(p);
  const cleanName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 24) : nextSceneName(p);
  const sc = { id, name: cleanName, harmony: null };
  p.scenes.push(sc);
  p.slots.forEach(s => { s.patterns[id] = createPatternFor(s.type); });
  const idx = p.scenes.length - 1;
  if (select) {
    if (recSession) finalizeRecording();
    stopMunchPreview();
    p.scene = idx;
    store.ui.libSel = idx;
    transport.queueScene(idx);
  }
  save(); emit('scene'); emit('arrangement');
  emit('toast', `New scene ${sceneLabel(idx)} · ${sc.name}`);
  return { id, index: idx, scene: sc };
}

/** Duplicate a scene with an independent deep copy of all instrument patterns and scene harmony (never auto-added to Song Arrangement). */
export function duplicateScene(i = store.project.scene, { name, select = true } = {}) {
  const p = store.project;
  if (!validSceneIndex(p, i)) return null;
  if (p.scenes.length >= MAX_SCENES) { emit('toast', `A song can hold up to ${MAX_SCENES} scenes`); return null; }
  checkpoint();
  const src = p.scenes[i];
  const id = nextSceneId(p);
  const cleanName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 24) : duplicateSceneName(p, src.name);
  const sc = { id, name: cleanName, harmony: src.harmony == null ? null : clone(src.harmony) };
  p.scenes.push(sc);
  p.slots.forEach(s => {
    const srcPat = s.patterns[src.id];
    s.patterns[id] = srcPat ? clone(srcPat) : createPatternFor(s.type);
  });
  const idx = p.scenes.length - 1;
  if (select) {
    if (recSession) finalizeRecording();
    stopMunchPreview();
    p.scene = idx;
    store.ui.libSel = idx;
    transport.queueScene(idx);
  }
  save(); emit('scene'); emit('arrangement');
  emit('toast', `Duplicated ${sceneLabel(i)} → ${sceneLabel(idx)} · ${sc.name}`);
  return { id, index: idx, scene: sc };
}

export function renameScene(i, name) {
  const p = store.project;
  if (!validSceneIndex(p, i)) return;
  const clean = String(name ?? '').trim().slice(0, 24);
  if (!clean || clean === p.scenes[i].name) return;
  checkpoint();
  p.scenes[i].name = clean;
  save(); emit('arrangement'); emit('scene');
}

export function copyScene(a, b) {
  const p = store.project;
  if (!validSceneIndex(p, a) || !validSceneIndex(p, b) || a === b) return;
  checkpoint();
  p.slots.forEach(s => { setPatternAt(p, s.id, b, clone(patternAt(p, s.id, a))); });
  p.scenes[b].harmony = p.scenes[a].harmony == null ? null : clone(p.scenes[a].harmony);
  save(); emit('pattern'); emit('arrangement'); emit('lab');
  emit('toast', `Scene ${sceneLabel(a)} copied to ${sceneLabel(b)}`);
}

export function clearScene(i) {
  const p = store.project;
  if (!validSceneIndex(p, i)) return;
  checkpoint();
  p.slots.forEach(s => { setPatternAt(p, s.id, i, createPatternFor(s.type)); });
  p.scenes[i].harmony = null;
  save(); emit('pattern'); emit('arrangement'); emit('lab');
  emit('toast', `Scene ${sceneLabel(i)} cleared`);
}

/** Delete a scene and any arrangement blocks pointing to it. Never deletes the final remaining scene. */
export function deleteScene(i) {
  const p = store.project;
  if (!validSceneIndex(p, i)) return false;
  if (p.scenes.length <= 1) { emit('toast', 'A song needs at least one scene'); return false; }
  if (recSession) finalizeRecording();
  stopMunchPreview();
  const prev = { scenes: p.scenes.slice(), arrangement: p.arrangement.slice(), songMode: p.songMode, scene: p.scene };
  const removed = p.scenes[i], removedId = removed.id;
  const prevSelId = sceneIdAt(p, p.scene);
  checkpoint();
  p.scenes.splice(i, 1);
  p.slots.forEach(s => { delete s.patterns[removedId]; });
  const beforeArr = p.arrangement.length;
  p.arrangement = p.arrangement.filter(b => b.sceneId !== removedId);
  if (!p.arrangement.length) p.songMode = false;
  p.scene = prevSelId === removedId ? Math.min(i, p.scenes.length - 1) : Math.max(0, sceneIndexOf(p, prevSelId));
  reconcileUiScenes(prev, p);
  reconcileTransport(prev, p);
  save(); emit('scene'); emit('arrangement'); emit('pattern');
  const removedBlocks = beforeArr - p.arrangement.length;
  emit('toast', removedBlocks
    ? `Deleted “${removed.name}” (removed ${removedBlocks} song block${removedBlocks === 1 ? '' : 's'})`
    : `Deleted “${removed.name}”`);
  return true;
}

/** Reorder a scene without breaking arrangement references, patterns or live playback. */
export function moveScene(from, to) {
  const p = store.project;
  if (!validSceneIndex(p, from)) return false;
  to = clamp(to, 0, p.scenes.length - 1);
  if (from === to) return false;
  if (recSession) finalizeRecording();
  stopMunchPreview();
  const prev = { scenes: p.scenes.slice(), arrangement: p.arrangement.slice(), songMode: p.songMode, scene: p.scene };
  const prevSelId = sceneIdAt(p, p.scene);
  checkpoint();
  const [sc] = p.scenes.splice(from, 1);
  p.scenes.splice(to, 0, sc);
  p.scene = Math.max(0, sceneIndexOf(p, prevSelId));
  reconcileUiScenes(prev, p);
  reconcileTransport(prev, p);
  save(); emit('scene'); emit('arrangement');
  return true;
}

export function addToSong(sc, at = null) {
  const sid = sceneIdAt(store.project, sc);
  if (!sid) return;
  checkpoint();
  const b = newBlock(sid), arr = store.project.arrangement;
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
export function setBlockScene(id, sc) { const i = blockIndex(id), sid = sceneIdAt(store.project, sc); if (i < 0 || !sid) return; checkpoint(); store.project.arrangement[i].sceneId = sid; save(); emit('arrangement'); }
export function clearSong() { checkpoint(); store.project.arrangement = []; store.ui.arrSel = null; if (transport.pos && transport.pos.song) transport.stop(); save(); emit('arrangement'); }
export function playFromBlock(id) {
  const i = blockIndex(id); if (i < 0) return;
  finalizeRecording();
  stopMunchPreview();
  engine.init(); engine.applyAll();
  store.project.songMode = true; save();
  transport.playFromBlock(i); emit('arrangement');
}
export function previewScene(i) {
  const p = store.project;
  if (!validSceneIndex(p, i)) return;
  if (recSession) finalizeRecording();
  stopMunchPreview();
  engine.init(); engine.applyAll();
  if (p.songMode) { p.songMode = false; emit('arrangement'); }
  p.scene = i; save();
  if (transport.state === 'playing') transport.queueScene(i);
  else { transport.stop(); transport.play(); }
  emit('scene');
}
export const toastMsg = m => emit('toast', m);
export const emitTool = () => emit('tool');

/* ---------- MUNCH samples (v0.6 Phase 3) ---------- */
// The project stores only a reference (slot.sample) and non-destructive edits (params, slices); the audio lives in
// the sample store. Only playable sampler slots load samples, so a normal session (MUNCH preview off) never opens
// IndexedDB.
const warnedMissing = new Set();
/** sample & built-in break ids used by playable slots of the current song */
export function playingSampleIds() {
  const slots = playableSlots(store.project);
  const out = sampleRefsOf({ slots });
  for (const id of breakRefsOf({ slots })) if (!out.includes(id)) out.push(id);
  return out;
}
/** pin + load the current song's samples and assigned built-in/imported breaks; warn once per missing asset */
export function syncSamples() {
  const ids = playingSampleIds();
  if (!ids.length && !samples.pinnedIds().length) return Promise.resolve();
  return samples.pin(ids).then(() => {
    for (const s of playableSlots(store.project)) {
      if (s.sample) {
        const st = samples.state(s.sample.id);
        if ((st.status === 'missing' || st.status === 'error') && !warnedMissing.has(s.sample.id)) {
          warnedMissing.add(s.sample.id);
          emit('toast', st.status === 'missing'
            ? `MUNCH sample “${s.sample.name}” is missing on this device. The song keeps its reference: import the same file again to bring it back.`
            : `MUNCH sample “${s.sample.name}” could not be loaded (${st.error}). The song keeps its reference.`);
        }
      }
      if (s.breaks) {
        for (const l of BREAK_LANES) {
          const bid = s.breaks[l];
          if (!bid) continue;
          const st = samples.state(bid);
          if ((st.status === 'missing' || st.status === 'error') && !warnedMissing.has(bid)) {
            warnedMissing.add(bid);
            const desc = resolveBreakDesc(bid, s.breakMeta);
            const label = desc ? desc.name : bid;
            emit('toast', st.status === 'missing' && isImportedBreakId(bid)
              ? `RUFF break “${label}” is missing on this device. Its reference and slices are kept: re-import the same WAV to restore it.`
              : `RUFF break “${label}” could not be loaded (${st.error || 'missing'}).`);
          }
        }
      }
    }
    emit('samples');
    emit('ruff');
  });
}
samples.on(() => { prepareStretch(); emit('samples'); emit('ruff'); });
/**
 * Stretch fit mode: queue the time-stretched copy every playable sampler or break slot needs at the current tempo,
 * so it is usually ready before the next beat/note. Cheap and idempotent (the bank skips copies it has).
 */
export function prepareStretch() {
  if (!store.project) return;
  for (const s of playableSlots(store.project)) {
    if (s.sample && isSamplerSlot(s.id)) {
      const fp = fitPlayback(s.params, s.sample.duration, store.project.bpm);
      if (fp.stretch !== 1) samples.requestStretch(s.sample.id, fp.stretch, s.sample.slices, !!s.params.reverse);
    } else if (s.breaks && isBreakSlot(s.id)) {
      for (const l of BREAK_LANES) {
        const id = s.breaks[l];
        if (!id) continue;
        const buf = samples.buffer(id);
        const desc = resolveBreakDesc(id, s.breakMeta);
        const dur = buf ? buf.duration : (desc ? desc.duration : 0);
        const bars = desc ? desc.bars : 2;
        const sourceBpm = (desc && isImportedBreakId(id) && desc.bpm > 0) ? desc.bpm : null;
        const fp = breakFitPlayback(s.params, dur, bars, store.project.bpm, sourceBpm);
        if (fp.stretch !== 1) samples.requestStretch(id, fp.stretch, desc ? desc.slices : undefined, false);
      }
    }
  }
}
/** state of a slot's sample for the UI: { ref, status, error } (status 'none' when no sample is loaded) */
export function sampleState(slotId) {
  const s = slot(slotId), ref = s && s.sample;
  return ref ? { ref, ...samples.state(ref.id) } : { ref: null, status: 'none', error: null };
}
/** put a stored sample into a slot (new reference, default eight slices; params keep their edits) */
export function assignSample(slotId, meta) {
  const s = slot(slotId); if (!s) return;
  stopMunchPreview();
  checkpoint();
  s.sample = sampleRefFor(meta);
  warnedMissing.delete(meta.id);
  save(); engine.applyParams(slotId); syncSamples(); emit('samples'); emit('pattern');
}
const sampleErrorText = e => (e instanceof SampleError ? e.message : `That sample could not be imported. [${(e && e.name) || 'Error'}]`);
let persistAsked = false;
/** ask the browser to keep HarbuMatic's storage (fewer evictions on iPad); best effort, never prompts on Safari */
function askPersist() {
  if (persistAsked) return; persistAsked = true;
  try { const st = navigator.storage; if (st && st.persist) st.persisted().then(p => p || st.persist()).catch(() => {}); } catch (e) { /* not available */ }
}
/** import an audio File (or { name, type, arrayBuffer() }) into the store and assign it; returns the metadata or null */
export async function importSampleFile(file, slotId = store.ui.sel) {
  engine.init();
  const had = !!(slot(slotId) && slot(slotId).sample);
  let bytes;
  try { bytes = await file.arrayBuffer(); } catch (e) { emit('toast', `That file could not be read. [${(e && e.name) || 'Error'}]`); emit('munch', { kind: 'oops' }); return null; }
  try {
    const { meta, duplicate, stored, error } = await samples.importBytes({ bytes, name: file.name || 'Sample', type: file.type || '' });
    assignSample(slotId, meta);
    if (!had) store.ui.munch.tab = 'play'; // a first sound: play it straight away
    Object.assign(store.ui.munch, { sel: 0, marker: 0, cursor: 0, zoom: 1, view: 0, bank: 0, magic: null });
    if (!stored) {
      console.warn('[HarbuMatic] sample storage', samples.store.lastError());
      emit('toast', `MUNCH ate “${meta.name}”, but it could not be saved on this device: it plays now and will be missing after a reload. ${error ? error.message : ''}`);
    } else {
      askPersist();
      emit('toast', duplicate ? `“${meta.name}” was already stored: using it` : `MUNCH ate “${meta.name}” (${meta.duration.toFixed(2)} s)`);
    }
    emit('munch', { kind: 'yum' }); emit('samples');
    return meta;
  } catch (e) { emit('toast', sampleErrorText(e)); emit('munch', { kind: 'oops' }); emit('samples'); return null; }
}
/** samples of the current song that play from memory only (not saved on this device) */
export const unsavedSamples = () => playingSampleIds().filter(id => samples.store.isUnsaved(id));
/** try again to save the unsaved samples (quietly reports the outcome) */
export async function retrySaveSamples() {
  const r = await samples.store.retryUnsaved();
  emit('samples');
  emit('toast', r.failed.length ? `Still could not save ${r.failed.length === 1 ? 'the sample' : `${r.failed.length} samples`}. ${r.error ? r.error.message : ''}` : 'Saved on this device');
  return r;
}
/**
 * Repair sample storage (after the user confirmed): rescue what can be read, delete only HarbuMatic's sample
 * database, recreate it and write everything back. Songs are not touched (they live in localStorage).
 */
export async function repairSampleStorage() {
  let r;
  try { r = await samples.store.repair(); }
  catch (e) { emit('toast', `Repair failed. ${sampleErrorText(e)}`); return null; }
  syncSamples(); emit('samples');
  emit('toast', r.failed.length ? `Storage was reset, but ${r.failed.length} sample(s) still cannot be saved. ${r.error ? r.error.message : ''}`
    : `Sample storage repaired: ${r.kept} sample${r.kept === 1 ? '' : 's'} kept${r.lost ? `, ${r.lost} could not be read and are lost` : ''}.`);
  return r;
}
export const recorder = createRecorder({
  maxSeconds: samples.store.limits.maxSeconds,
  session: engine.E.session, // shared with the engine: 'playback' normally, capture only while the mic is open
  onState: s => {
    // switching the iPad audio session can suspend the AudioContext: wake it once the microphone is closed
    if (s === 'idle' && engine.ctx && engine.ctx.state !== 'running') engine.ctx.resume().catch(() => {});
    emit('recorder');
  },
  onAutoStop: (rec, reason) => {
    if (!rec) { emit('toast', reason === 'ended' ? 'The microphone was taken away by the system. Nothing was recorded.' : 'Nothing was recorded'); react('oops'); return; }
    emit('toast', reason === 'limit' ? `Recording stopped at ${samples.store.limits.maxSeconds} s (the limit) and was kept` : 'The microphone was taken away by the system: the recording so far was kept');
    importRecording(rec, recordSlot);
  },
});
export const recordingSupported = () => canRecord();
export const recordingSupport = () => recordSupport();
let recordSlot = null;
/** RECORD: call straight from the tap (iPad needs the audio-session switch and getUserMedia inside the gesture) */
export async function recordStart(slotId = store.ui.sel) {
  engine.init();
  recordSlot = slotId;
  finalizeRecording();
  stopMunchPreview();
  transport.state === 'playing' && transport.pause(); // a quiet room: nothing from HarbuMatic leaks into the mic
  try { await recorder.start(); emit('munch', { kind: 'listen' }); return true; }
  catch (e) { emit('toast', sampleErrorText(e)); emit('munch', { kind: 'oops' }); return false; }
}
function importRecording(rec, slotId) {
  return importSampleFile({ name: rec.name, type: rec.type, arrayBuffer: async () => rec.bytes }, slotId || store.ui.sel);
}
export async function recordStop(slotId = recordSlot || store.ui.sel) {
  let rec = null;
  try { rec = await recorder.stop(); } catch (e) { emit('toast', sampleErrorText(e)); emit('munch', { kind: 'oops' }); return null; }
  if (!rec) { emit('toast', 'Nothing was recorded'); emit('munch', { kind: 'oops' }); return null; }
  return importRecording(rec, slotId);
}
export function recordCancel() { recorder.cancel(); }
/* ---------- MUNCH workspace (v0.6 Phase 4) ---------- */
// Character reactions: the workspace listens to 'munch' events ({ kind }) — yum, oops, listen, chomp, snip, magic, note.
const react = kind => emit('munch', { kind });
/** auditions need Web Audio; Node tests and pages without audio skip them silently */
const canSound = () => typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext);
const hear = fn => { if (canSound()) { try { return fn(); } catch (e) { /* audio not available */ } } return null; };
const M = () => store.ui.munch;
const sampleOf = id => { const s = slot(id); return s && s.sample; };

let previewReq = 0;
/** stop local CHOP slice preview cleanly, silencing scheduled MUNCH preview voices without touching global transport */
export function stopMunchPreview() {
  previewReq++;
  if (munchPreview.playing) munchPreview.stop();
}
/** switch MUNCH tab (play | chop | twist); leaving CHOP stops local preview */
export function setMunchTab(tab) {
  if (M().tab === tab) return;
  if (tab !== 'chop') stopMunchPreview();
  M().tab = tab;
  emit('munchtab');
}
/**
 * Toggle local CHOP slice-pattern preview for a MUNCH slot.
 * Loops only that slot's slice pattern from step 1 at the project BPM without starting global transport.
 * If global transport is already playing, pauses it (preserving song/scene position) to prevent double MUNCH.
 */
export function toggleMunchPreview(slotId = store.ui.sel) {
  if (munchPreview.playing && munchPreview.slotId === slotId) {
    stopMunchPreview();
    return false;
  }
  const s = slot(slotId);
  if (!s || !isSamplerSlot(slotId) || !s.sample) return false;
  finalizeRecording();
  if (transport.state === 'playing') transport.pause();
  engine.init(); engine.applyAll();
  const req = ++previewReq;
  const id = s.sample.id;
  if (samples.isLoading([id])) {
    samples.whenSettled([id], 2000).then(() => {
      if (req !== previewReq) return;
      if (store.ui.mode === 'sound' && store.ui.sel === slotId && M().tab === 'chop') munchPreview.start(slotId);
    });
    return true;
  }
  return munchPreview.start(slotId);
}

/** change a slot's slice boundaries structurally and remap every slice note (all scenes + snapshots), one history step */
function restructure(slotId, next, { select, marker = null, msg } = {}) {
  const s = slot(slotId), old = s.sample.slices;
  checkpoint();
  s.sample.slices = next;
  const moved = remapSlotSlices(store.project, slotId, old, next);
  const n = sliceCount(next), u = M();
  u.sel = Math.max(0, Math.min(n - 1, select ?? u.sel)); u.marker = marker; u.bank = u.sel >= 8 ? 1 : 0;
  u.magic = null;
  prepareStretch(); // stretched copies are anchored on the slice boundaries
  save(); emit('samples'); emit('pattern');
  react('snip');
  if (msg) emit('toast', msg);
  return { moved, count: n };
}
const LIMIT_MSG = { max: `MUNCH can hold up to ${MAX_SLICES} slices`, close: 'Too close to another marker: move the cursor a little', range: 'Put the cursor inside the sound first', none: 'Pick a slice first', edge: 'Slice 1 starts the sound: there is no marker before it to delete (drag its handle to trim instead)' };

/** CHOP HERE: a new boundary at a position (fraction of the whole sample); selects the slice that starts there */
export function chopAt(pos, slotId = store.ui.sel) {
  const ref = sampleOf(slotId); if (!ref) return null;
  const r = insertSliceBoundary(ref.slices, pos);
  if (r.error) { emit('toast', LIMIT_MSG[r.error]); react('oops'); return null; }
  return restructure(slotId, r.slices, { select: Math.min(r.at, sliceCount(r.slices) - 1), marker: r.at });
}
/** split a slice in the middle (default: the selected one) */
export function splitSliceAt(k = M().sel, slotId = store.ui.sel) {
  const ref = sampleOf(slotId); if (!ref) return null;
  const r = splitSlice(ref.slices, k);
  if (r.error) { emit('toast', LIMIT_MSG[r.error]); react('oops'); return null; }
  return restructure(slotId, r.slices, { select: k, marker: r.at });
}
/** delete an inner boundary (default: the selected marker), merging its two slices */
export function deleteBoundary(i = M().marker, slotId = store.ui.sel) {
  const ref = sampleOf(slotId); if (!ref || i == null) { emit('toast', 'Tap a marker first'); return null; }
  const r = removeSliceBoundary(ref.slices, i);
  if (r.error) { emit('toast', LIMIT_MSG[r.error]); react('oops'); return null; }
  return restructure(slotId, r.slices, { select: i - 1, marker: i - 1 });
}
/** back to n equal slices; every slice note moves to the slice that now holds its attack */
export function resetSlices(n = 8, slotId = store.ui.sel) {
  const ref = sampleOf(slotId); if (!ref) return null;
  return restructure(slotId, defaultSlices(n), { select: 0, marker: 0, msg: `${n} equal slices` });
}
/** drag a boundary (not structural: slice indexes keep their identity); continuous drags coalesce into one undo step */
export function moveSlice(i, pos, slotId = store.ui.sel) {
  const s = slot(slotId); if (!s || !s.sample) return;
  checkpoint(`slice:${i}`);
  s.sample.slices = moveSliceBoundary(s.sample.slices, i, pos);
  if (M().magic) M().magic = null;
  prepareStretch();
  save(); emit('samples');
}
/** nudge a boundary by about 10 ms of audio (a visible alternative to precise dragging) */
export function nudgeBoundary(dir, i = M().marker, slotId = store.ui.sel) {
  const ref = sampleOf(slotId); if (!ref || i == null) { emit('toast', 'Tap a marker first'); return; }
  const step = Math.max(MIN_SLICE, ref.duration > 0 ? .01 / ref.duration : .005);
  moveSlice(i, ref.slices[i] + dir * step, slotId); sealHistory();
}
/** select slice k (pads, sequencer rows, waveform); its start marker becomes the one ◀ ▶ and Delete act on */
export function selectSlice(k) {
  const ref = sampleOf(store.ui.sel), n = ref ? sliceCount(ref.slices) : 0; if (!n) return;
  const u = M(); u.sel = Math.max(0, Math.min(n - 1, k)); u.marker = u.sel; u.bank = u.sel >= 8 ? 1 : 0; emit('munchsel');
}
/** tap a marker handle: that marker, and the slice that starts there */
export function selectMarker(i) {
  const u = M(), ref = sampleOf(store.ui.sel), n = ref ? sliceCount(ref.slices) : 0;
  u.marker = i; if (n && i < n) { u.sel = i; u.bank = u.sel >= 8 ? 1 : 0; }
  emit('munchsel');
}
export function setCursor(pos) { const u = M(); u.cursor = clamp(pos, 0, 1); const ref = sampleOf(store.ui.sel); if (ref) { u.sel = sliceAt(ref.slices, u.cursor); u.marker = u.sel; } u.bank = u.sel >= 8 ? 1 : 0; emit('munchsel'); }
export function auditionSlice(k, slotId = store.ui.sel, v = .9) { react('chomp'); return hear(() => engine.audition(slotId, SLICE_REF_PITCH, v, { slice: k })); }
/** play a region of the sample as recorded (root pitch, with tune and fit), e.g. from the cursor to the slice end */
export function auditionRegion(a, b, slotId = store.ui.sel) {
  if (!(b > a)) return null;
  react('chomp');
  return hear(() => engine.audition(slotId, P(slotId).root, .9, { region: [a, b] }));
}
/** hear the whole (trimmed) sample at its root */
export function auditionSample(slotId = store.ui.sel) { react('chomp'); return hear(() => engine.audition(slotId, P(slotId).root, .9)); }
/** keyboard: press and release (velocity 0–1). Returns a handle for munchNoteOff. */
export function munchNoteOn(pitch, v = .8, slotId = store.ui.sel) { react('note'); return liveNoteOn(slotId, pitch, v); }
export function munchNoteOff(handle) { return liveNoteOff(handle); }
/** slice pad: press and release like a key (Gate stops on release, Loop loops while held, One-shot plays the slice) */
export function munchPadOn(k, v = .9, slotId = store.ui.sel) { react('chomp'); return liveNoteOn(slotId, SLICE_REF_PITCH, v, { slice: k }); }
export const munchPadOff = munchNoteOff;

/** add or remove a one-step slice trigger in the current scene's pattern (CHOP sequencer, Draw tool) */
export function toggleSliceStep(k, step, slotId = store.ui.sel) {
  const p = pat(slotId); if (!p || step >= p.len) return;
  const i = p.notes.findIndex(n => n.s === step && n.slice === k);
  if (i >= 0 && p.notes[i].locked) { emit('toast', 'That step is locked: unlock it with the Lock tool'); return; }
  checkpoint();
  if (i >= 0) p.notes.splice(i, 1); else { p.notes.push({ s: step, p: SLICE_REF_PITCH, l: 1, v: .85, slice: k }); auditionSlice(k, slotId, .85); }
  if (M().magic) M().magic = null;
  save(); emit('pattern');
}
/** Accent tool: soft → normal → accent (same velocities as JAM's Velocity tool); keeps timing and length */
export function cycleSliceVel(k, step, slotId = store.ui.sel) {
  const n = pat(slotId).notes.find(x => x.s === step && x.slice === k); if (!n) return;
  checkpoint(); n.v = n.v < .5 ? .75 : n.v < .9 ? 1 : .35; save(); emit('pattern'); auditionSlice(k, slotId, n.v);
}
/** Lock tool: a locked hit survives MAGIC CHOP and keeps its step for itself */
export function toggleSliceLock(k, step, slotId = store.ui.sel) {
  const n = pat(slotId).notes.find(x => x.s === step && x.slice === k); if (!n) return;
  checkpoint(); if (n.locked) delete n.locked; else n.locked = true; save(); emit('pattern');
}

/** Fit to Beat: choose bars (or 'off'); refused with a message when the fit would leave the usable speed range */
export function setFit(choice, slotId = store.ui.sel) {
  const s = slot(slotId); if (!s) return false;
  if (choice !== 'off') {
    if (!s.sample) { emit('toast', 'Feed MUNCH a sound first'); return false; }
    const f = fitInfo({ ...s.params, fit: choice }, s.sample.duration, store.project.bpm);
    if (!f.ok) {
      const bars = FIT_BARS[choice] === .5 ? 'half a bar' : `${FIT_BARS[choice]} bar${FIT_BARS[choice] > 1 ? 's' : ''}`;
      emit('toast', `${bars} would need ×${f.ratio.toFixed(2)} speed: too ${f.ratio < 1 ? 'slow' : 'fast'} to sound good. Try ${f.ratio < 1 ? 'fewer' : 'more'} bars or trim the sound.`);
      react('oops'); return false;
    }
  }
  checkpoint(); s.params.fit = choice; engine.applyParams(slotId); prepareStretch(); save(); emit('params', slotId); emit('samples');
  return true;
}
/** Fit mode: 'stretch' (pitch stays when the tempo changes, the default) or 'tape' (pitch follows the speed) */
export function setFitMode(mode, slotId = store.ui.sel) {
  const s = slot(slotId); if (!s || !FIT_MODES.includes(mode) || s.params.fitMode === mode) return false;
  checkpoint(); s.params.fitMode = mode; engine.applyParams(slotId); prepareStretch(); save(); emit('params', slotId); emit('samples');
  return true;
}
/** is the stretched copy for the current tempo ready? 'off' (not needed) | 'pending' | 'ready' */
export function stretchStatus(slotId = store.ui.sel) {
  const s = slot(slotId); if (!s || !s.sample) return 'off';
  const fp = fitPlayback(s.params, s.sample.duration, store.project.bpm);
  if (fp.stretch === 1) return 'off';
  return samples.stretchState(s.sample.id, fp.stretch, s.sample.slices) === 'ready' ? 'ready' : 'pending';
}
/** current tape-fit state of a slot (for the UI) */
export function fitState(slotId = store.ui.sel) {
  const s = slot(slotId); if (!s || !s.sample) return null;
  return fitInfo(s.params, s.sample.duration, store.project.bpm);
}

/** MAGIC CHOP: replace the unlocked slice notes of the current scene with a groove; one undo step; plays it at once */
export function magicChop(style = M().style, { seed = randomSeed(), play = true } = {}, slotId = store.ui.sel) {
  const s = slot(slotId); if (!s || !s.sample) { emit('toast', 'Feed MUNCH a sound first'); react('oops'); return null; }
  const u = M(), sc = store.project.scene, p = patternAt(store.project, slotId, sc), now = JSON.stringify(p);
  const pending = u.magic && u.magic.slot === slotId && u.magic.scene === sc && u.magic.after === now ? u.magic : null;
  const r = magicChopPattern({ pattern: p, slices: s.sample.slices, duration: s.sample.duration, rate: fitRate(s.params, s.sample.duration, store.project.bpm), bpm: store.project.bpm, style, seed });
  checkpoint();
  setPatternAt(store.project, slotId, sc, r.pattern);
  u.style = style;
  u.magic = { slot: slotId, scene: sc, before: pending ? pending.before : now, after: JSON.stringify(r.pattern), style, seed };
  save(); emit('pattern'); react('magic');
  emit('toast', `MAGIC CHOP · ${MAGIC_LABEL[style]}`);
  if (play && transport.state !== 'playing') togglePlay();
  return r;
}
/** keep the MAGIC CHOP result (it is already in the pattern: this only closes the choice) */
export function magicKeep() { if (!M().magic) return; M().magic = null; emit('pattern'); emit('toast', 'Kept! Every step is yours to edit'); }
/** back to the pattern from before the first MAGIC CHOP (itself undoable) */
export function magicUndo() {
  const u = M(), m = u.magic; if (!m) return false;
  const p = patternAt(store.project, m.slot, m.scene);
  u.magic = null;
  if (!p || JSON.stringify(p) !== m.after) { emit('toast', 'The groove was edited since: use Undo at the top'); emit('pattern'); return false; }
  checkpoint(); setPatternAt(store.project, m.slot, m.scene, JSON.parse(m.before)); save(); emit('pattern'); emit('toast', 'Back to your pattern');
  return true;
}

/* ---------- RUFF Break Pool & Imported WAV Breaks (v0.7 PR2, PR35) ---------- */
let ruffAudReq = 0;
const localBreakPool = new Map(); // id → clean ImportedBreakMeta (cached from samples.store meta.ruff)
let localPoolLoaded = false;

/** Clean a filename into a compact break display label (strip .wav extension). */
function cleanBreakDisplayName(name) {
  const raw = String(name || '').trim().replace(/\.wav$/i, '').trim();
  return (raw || 'Imported Break').slice(0, 64);
}

/** Resolve metadata for any break ID (built-in, current slot's breakMeta, or local Break Pool). */
export function getBreakDesc(breakId, slotId = store.ui.sel) {
  if (!breakId) return null;
  const s = slot(slotId);
  return resolveBreakDesc(breakId, s && s.breakMeta) || localBreakPool.get(breakId) || null;
}

/**
 * Load locally persisted imported RUFF breaks from the existing sampleStore (meta.ruff).
 * Safe in Node tests and offline Safari/iPad; never opens a parallel storage database.
 */
export async function refreshLocalBreakPool({ sampleStore = samples.store } = {}) {
  try {
    const items = await sampleStore.list();
    for (const rec of items) {
      if (!rec || !rec.id || !rec.ruff) continue;
      const clean = cleanImportedBreakMeta({ ...rec.ruff, id: rec.id, name: rec.ruff.name || cleanBreakDisplayName(rec.name) });
      if (clean) localBreakPool.set(clean.id, clean);
    }
    localPoolLoaded = true;
    emit('ruff');
  } catch (e) {
    /* storage unavailable or not ready — keep whatever is in memory */
  }
  return [...localBreakPool.values()];
}

/** Ensure the local Break Pool has been read from sampleStore at least once (fire-and-forget safe for UI render). */
export function ensureLocalBreakPool() {
  if (!localPoolLoaded) {
    localPoolLoaded = true;
    refreshLocalBreakPool();
  }
}

/**
 * All imported WAV breaks available in the RUFF Break Pool for `slotId`:
 * merges the project's assigned `slot.breakMeta` (including missing-on-device references, never silently dropped)
 * with locally stored breaks from `samples.store`.
 */
export function listImportedBreaks(slotId = store.ui.sel) {
  const s = slot(slotId);
  const byId = new Map();
  if (s && s.breakMeta) {
    for (const [id, m] of Object.entries(s.breakMeta)) {
      if (isImportedBreakId(id) && m) byId.set(id, m);
    }
  }
  if (s && s.breaks) {
    for (const l of BREAK_LANES) {
      const id = s.breaks[l];
      if (isImportedBreakId(id) && !byId.has(id)) {
        const cached = localBreakPool.get(id);
        byId.set(id, cached || cleanImportedBreakMeta({ id, name: 'Imported Break', duration: 0, bars: 2, bpm: 120 }));
      }
    }
  }
  for (const [id, m] of localBreakPool) {
    if (!byId.has(id)) byId.set(id, m);
  }
  return [...byId.values()].map(meta => {
    const st = samples.state(meta.id);
    return {
      ...meta,
      status: st.status,
      error: st.error,
      unsaved: !!(samples.store.isUnsaved && samples.store.isUnsaved(meta.id)),
      assignedLanes: s && s.breaks ? BREAK_LANES.filter(l => s.breaks[l] === meta.id) : [],
    };
  });
}

/** Imported break IDs used by `slotId` (or in local pool) that are only in memory (failed durable storage). */
export function unsavedBreakIds(slotId = store.ui.sel) {
  const ids = new Set();
  const s = slot(slotId);
  if (s && s.breaks) {
    for (const l of BREAK_LANES) {
      const id = s.breaks[l];
      if (isImportedBreakId(id) && samples.store.isUnsaved(id)) ids.add(id);
    }
  }
  for (const id of localBreakPool.keys()) {
    if (samples.store.isUnsaved(id)) ids.add(id);
  }
  return [...ids];
}

/** Keep `slot.breakMeta` clean: store entries for assigned imported breaks and omit when empty. */
function syncSlotBreakMeta(s) {
  if (!s || !s.breaks) return;
  const cleaned = cleanBreakMetaMap(s.breakMeta, s.breaks);
  if (Object.keys(cleaned).length) s.breakMeta = cleaned;
  else delete s.breakMeta;
}

/** Stop any active RUFF break audition cleanly without affecting transport playback. */
export function stopBreakAudition(slotId = null) {
  ruffAudReq++;
  const cur = store.ui.ruff && store.ui.ruff.audition;
  const target = slotId || (cur && cur.slotId) || null;
  if (target && engine.ctx && engine.stopAudition) engine.stopAudition(target);
  if (cur && (!slotId || cur.slotId === slotId)) {
    store.ui.ruff.audition = null;
    emit('ruff');
  }
}

/**
 * Import a user WAV drum break into RUFF:
 * - Validates WAV container + safe size/duration limits via the existing sample store & bank (zero parallel storage).
 * - Deduplicates repeated imports by SHA-256 while preserving original bytes untouched.
 * - Runs deterministic local analysis (BPM, 1/2/4 bars, ambiguity, transients, objective slice features).
 * - Makes the break available in the local Break Pool and assigns it to `lane` (or first empty lane A/B/C)
 *   without overwriting other lanes.
 * - Clearly discloses durable storage failures and never claims offline persistence when storage fails.
 */
export async function importBreakFile(file, {
  lane = null,
  slotId = store.ui.sel,
  bank = samples,
  autoAssign = true,
} = {}) {
  const s = slot(slotId);
  if (!s || !isBreakSlot(slotId)) return { ok: false, error: new SampleError('unsupported', 'Select RUFF first to import a drum break.') };
  if (!file) return { ok: false, error: new SampleError('empty', 'No file selected.') };
  if (canSound() && bank === samples) engine.init();

  let bytes;
  try {
    bytes = file instanceof ArrayBuffer ? file.slice(0) : ArrayBuffer.isView(file)
      ? file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)
      : await file.arrayBuffer();
  } catch (e) {
    const err = new SampleError('corrupt', `That file could not be read. [${(e && e.name) || 'Error'}]`, e);
    emit('toast', err.message);
    return { ok: false, error: err };
  }

  if (!bytes || !bytes.byteLength) {
    const err = new SampleError('empty', 'That WAV file is empty.');
    emit('toast', err.message);
    return { ok: false, error: err };
  }
  if (!isWavBytes(bytes)) {
    const err = new SampleError('unsupported', `“${file.name || 'File'}” is not a valid WAV (.wav) file. RUFF break import supports uncompressed WAV loops.`);
    emit('toast', err.message);
    return { ok: false, error: err };
  }

  try {
    const res = await bank.importBytes({
      bytes,
      name: file.name || 'Break.wav',
      type: file.type || 'audio/wav',
    });
    const { meta, buffer, duplicate, stored, error } = res;
    const displayName = cleanBreakDisplayName(meta.name || file.name);

    // Reuse previously saved RUFF metadata on duplicate re-import so prior edits survive; otherwise analyze locally
    let breakMeta = null;
    if (meta.ruff) {
      breakMeta = cleanImportedBreakMeta({
        ...meta.ruff,
        id: meta.id,
        name: meta.ruff.name || displayName,
        duration: buffer.duration,
        sampleRate: buffer.sampleRate,
        channels: buffer.numberOfChannels,
      });
    }
    if (!breakMeta) {
      const analyzed = analyzeBreakBuffer(buffer);
      breakMeta = cleanImportedBreakMeta({
        id: meta.id,
        name: displayName,
        duration: buffer.duration,
        sampleRate: buffer.sampleRate,
        channels: buffer.numberOfChannels,
        bpm: analyzed.bpm,
        bars: analyzed.bars,
        slices: analyzed.slices,
        sliceMeta: analyzed.sliceMeta,
        analysis: analyzed.analysis,
      });
    }

    // Persist RUFF metadata into the existing sample store meta record (never modifies original bytes)
    let metaStored = stored;
    let metaError = error;
    if (bank.store && typeof bank.store.updateMeta === 'function') {
      const upd = await bank.store.updateMeta(meta.id, { ruff: clone(breakMeta) });
      if (stored && !upd.stored && upd.error) {
        metaStored = false;
        metaError = upd.error;
      }
    }

    localBreakPool.set(breakMeta.id, clone(breakMeta));
    warnedMissing.delete(breakMeta.id);

    // Decide lane assignment without overwriting other lanes
    let targetLane = null;
    if (lane && BREAK_LANES.includes(lane)) {
      targetLane = lane;
    } else if (autoAssign) {
      const curBreaks = s.breaks || { a: null, b: null, c: null };
      const alreadyOn = BREAK_LANES.find(l => curBreaks[l] === breakMeta.id);
      if (alreadyOn) targetLane = alreadyOn;
      else targetLane = BREAK_LANES.find(l => !curBreaks[l]) || null;
    }

    let assignedLane = null;
    if (targetLane) {
      const alreadySame = s.breaks && s.breaks[targetLane] === breakMeta.id;
      if (!alreadySame) {
        assignBreak(targetLane, breakMeta.id, slotId, { meta: breakMeta });
      } else {
        if (!s.breakMeta) s.breakMeta = {};
        s.breakMeta[breakMeta.id] = clone(breakMeta);
        save();
        if (canSound() && engine.ctx) engine.applyParams(slotId);
        prepareStretch();
      }
      assignedLane = targetLane;
    }

    // Focus Break Editor on the imported break immediately
    store.ui.ruff.editBreakId = breakMeta.id;
    store.ui.ruff.editSlice = 0;
    store.ui.ruff.editMarker = 0;
    store.ui.ruff.editCursor = 0;

    if (!stored || !metaStored) {
      console.warn('[HarbuMatic] RUFF break storage failure', bank.store && bank.store.lastError && bank.store.lastError());
      emit('toast', `Imported “${breakMeta.name}” (${breakMeta.bpm} BPM, ${breakMeta.bars}B), but it could NOT be saved offline on this device. ${metaError ? metaError.message : ''}`);
    } else {
      askPersist();
      const where = assignedLane ? ` → Break ${assignedLane.toUpperCase()}` : ' · ready in Break Pool';
      const dupTag = duplicate ? ' (reused stored WAV)' : '';
      emit('toast', `Imported “${breakMeta.name}” · ${breakMeta.bpm} BPM · ${breakMeta.bars}B${where}${dupTag}`);
    }

    emit('samples');
    emit('ruff');
    return { ok: true, id: breakMeta.id, meta: breakMeta, duplicate, stored: stored && metaStored, error: metaError, assignedLane };
  } catch (e) {
    const msg = sampleErrorText(e);
    emit('toast', msg);
    emit('ruff');
    return { ok: false, error: e };
  }
}

/** Assign (or clear with null) a break source on RUFF lane 'a' | 'b' | 'c'. Preserves existing patterns and other lanes untouched. */
export function assignBreak(lane, breakId, slotId = store.ui.sel, { meta = null } = {}) {
  if (!BREAK_LANES.includes(lane)) return false;
  const s = slot(slotId);
  if (!s || !isBreakSlot(slotId)) return false;
  const next = typeof breakId === 'string' && breakId.trim() ? breakId.trim().slice(0, 80) : null;
  if (next && isBuiltinBreakId(next) && !getBuiltinBreak(next)) return false;
  if (!s.breaks) s.breaks = { a: null, b: null, c: null };
  if (s.breaks[lane] === next) return false;
  const curAud = store.ui.ruff && store.ui.ruff.audition;
  if (curAud && curAud.slotId === slotId && curAud.lane === lane) stopBreakAudition(slotId);
  checkpoint();
  s.breaks[lane] = next;
  if (next && isImportedBreakId(next)) {
    const resolved = meta || (s.breakMeta && s.breakMeta[next]) || localBreakPool.get(next) || null;
    if (resolved) {
      if (!s.breakMeta) s.breakMeta = {};
      s.breakMeta[next] = cleanImportedBreakMeta({ ...resolved, id: next });
      localBreakPool.set(next, clone(s.breakMeta[next]));
    }
    store.ui.ruff.editBreakId = next;
  }
  syncSlotBreakMeta(s);
  if (next) warnedMissing.delete(next);
  save();
  if (canSound() && engine.ctx) engine.applyParams(slotId);
  syncSamples();
  prepareStretch();
  emit('ruff');
  emit('pattern');
  return true;
}

export function setBreakLaneVol(lane, value, slotId = store.ui.sel) {
  if (!BREAK_LANES.includes(lane)) return;
  setParam(slotId, laneVolKey(lane), clamp(value, 0, 1));
}

export function toggleBreakLaneMute(lane, slotId = store.ui.sel) {
  if (!BREAK_LANES.includes(lane)) return;
  const key = laneMuteKey(lane);
  checkpoint();
  setParam(slotId, key, !P(slotId)[key], false);
}

/** Audition a RUFF lane's assigned break independently (toggles off if already auditioning that lane). */
export function auditionBreak(lane, slotId = store.ui.sel) {
  if (!BREAK_LANES.includes(lane)) return false;
  const s = slot(slotId);
  const breakId = s && s.breaks && s.breaks[lane];
  if (!s || !isBreakSlot(slotId) || !breakId) return false;
  const cur = store.ui.ruff && store.ui.ruff.audition;
  if (cur && cur.slotId === slotId && cur.lane === lane) {
    stopBreakAudition(slotId);
    return false;
  }
  stopBreakAudition();
  const req = ++ruffAudReq;
  store.ui.ruff.audition = { slotId, lane, breakId };
  emit('ruff');
  if (!canSound()) return true;

  engine.init();
  engine.applyParams(slotId);
  const fire = () => {
    if (req !== ruffAudReq) return;
    const desc = getBreakDesc(breakId, slotId);
    const bMeta = desc && isImportedBreakId(breakId) ? { [breakId]: desc } : null;
    const handle = hear(() => engine.audition(slotId, null, .95, {
      lane,
      breakId,
      breakMeta: bMeta,
      onEnded: () => {
        if (req !== ruffAudReq) return;
        if (store.ui.ruff.audition && store.ui.ruff.audition.slotId === slotId && store.ui.ruff.audition.lane === lane) {
          store.ui.ruff.audition = null;
          emit('ruff');
        }
      },
    }));
    if (!handle && req === ruffAudReq) {
      store.ui.ruff.audition = null;
      emit('ruff');
    }
  };
  if (samples.buffer(breakId)) {
    prepareStretch();
    fire();
  } else {
    samples.load(breakId).then(buf => {
      if (req !== ruffAudReq) return;
      if (!buf) {
        store.ui.ruff.audition = null;
        emit('ruff');
        return;
      }
      prepareStretch();
      fire();
    });
  }
  return true;
}

/** Audition an imported break (whole loop or single slice) directly from the Break Editor, even before lane assignment. */
export function auditionImportedBreak(breakId, { slice = null, slotId = store.ui.sel } = {}) {
  const s = slot(slotId);
  if (!s || !isBreakSlot(slotId) || !isImportedBreakId(breakId)) return false;
  const desc = getBreakDesc(breakId, slotId);
  if (!desc) return false;
  const cur = store.ui.ruff && store.ui.ruff.audition;
  if (slice == null && cur && cur.slotId === slotId && cur.breakId === breakId && cur.lane === 'edit') {
    stopBreakAudition(slotId);
    return false;
  }
  stopBreakAudition();
  const req = ++ruffAudReq;
  const bMeta = { [breakId]: desc };
  const clampedSlice = slice != null ? clampBreakSlice(breakId, slice, 0, bMeta) : null;
  if (clampedSlice == null) {
    store.ui.ruff.audition = { slotId, lane: 'edit', breakId };
    emit('ruff');
  }
  if (!canSound()) return true;

  engine.init();
  engine.applyParams(slotId);
  const fire = () => {
    if (req !== ruffAudReq) return;
    const handle = hear(() => engine.audition(slotId, null, .95, {
      lane: 'a',
      breakId,
      breakMeta: bMeta,
      ...(clampedSlice != null ? { slice: clampedSlice } : {}),
      onEnded: () => {
        if (req !== ruffAudReq) return;
        if (store.ui.ruff.audition && store.ui.ruff.audition.slotId === slotId && store.ui.ruff.audition.breakId === breakId) {
          store.ui.ruff.audition = null;
          emit('ruff');
        }
      },
    }));
    if (!handle && req === ruffAudReq && clampedSlice == null) {
      store.ui.ruff.audition = null;
      emit('ruff');
    }
  };
  if (samples.buffer(breakId)) {
    fire();
  } else {
    samples.load(breakId).then(buf => {
      if (req !== ruffAudReq) return;
      if (!buf) {
        if (clampedSlice == null) { store.ui.ruff.audition = null; emit('ruff'); }
        return;
      }
      fire();
    });
  }
  return true;
}

/* ---------- RUFF Break Editor non-destructive editing (v0.7 PR35) ---------- */

/** Select an imported break to inspect/edit in the RUFF Break Editor (UI-only). */
export function selectRuffEditBreak(breakId) {
  const next = breakId && isImportedBreakId(breakId) ? breakId : null;
  if (store.ui.ruff.editBreakId === next) return;
  store.ui.ruff.editBreakId = next;
  store.ui.ruff.editSlice = 0;
  store.ui.ruff.editMarker = 0;
  store.ui.ruff.editCursor = 0;
  if (next && samples.state(next).status === 'idle') samples.load(next);
  emit('ruff');
}

export function selectRuffEditSlice(k, breakId = store.ui.ruff.editBreakId, slotId = store.ui.sel) {
  const desc = getBreakDesc(breakId, slotId);
  if (!desc) return;
  const n = Math.max(1, sliceCount(desc.slices));
  const idx = clamp(Math.trunc(Number(k) || 0), 0, n - 1);
  store.ui.ruff.editSlice = idx;
  store.ui.ruff.editMarker = idx;
  emit('ruffedit');
}

export function selectRuffEditMarker(i, breakId = store.ui.ruff.editBreakId, slotId = store.ui.sel) {
  const desc = getBreakDesc(breakId, slotId);
  if (!desc) return;
  const idx = clamp(Math.trunc(Number(i) || 0), 0, desc.slices.length - 1);
  store.ui.ruff.editMarker = idx;
  const n = Math.max(1, sliceCount(desc.slices));
  if (idx < n) store.ui.ruff.editSlice = idx;
  emit('ruffedit');
}

export function setRuffEditCursor(pos, breakId = store.ui.ruff.editBreakId, slotId = store.ui.sel) {
  const c = clamp(Number(pos) || 0, 0, 1);
  store.ui.ruff.editCursor = c;
  const desc = getBreakDesc(breakId, slotId);
  if (desc && Array.isArray(desc.slices)) {
    const k = sliceAt(desc.slices, c);
    store.ui.ruff.editSlice = k;
    store.ui.ruff.editMarker = k;
  }
  emit('ruffedit');
}

/** Commit an updated `ImportedBreakMeta` non-destructively to project (if assigned, Undoable) + local Break Pool. */
function commitImportedBreakMeta(breakId, nextMeta, { slotId = store.ui.sel, coalesce = null, structural = false, oldSlices = null, quiet = false } = {}) {
  const clean = cleanImportedBreakMeta({ ...nextMeta, id: breakId });
  if (!clean) return null;
  const s = slot(slotId);
  const assigned = !!(s && s.breaks && BREAK_LANES.some(l => s.breaks[l] === breakId));

  if (assigned) {
    checkpoint(coalesce);
    if (!s.breakMeta) s.breakMeta = {};
    s.breakMeta[breakId] = clean;
    if (structural && Array.isArray(oldSlices)) {
      remapBreakSlotSlices(store.project, slotId, breakId, oldSlices, clean.slices);
    }
    save();
    if (canSound() && engine.ctx) engine.applyParams(slotId);
    prepareStretch();
  }

  localBreakPool.set(breakId, clone(clean));
  if (samples.store && typeof samples.store.updateMeta === 'function') {
    samples.store.updateMeta(breakId, { ruff: clone(clean) }).catch(() => {});
  }

  if (quiet) emit('ruffedit');
  else {
    emit('ruff');
    if (assigned) emit('pattern');
  }
  return clean;
}

/** Update an imported break's interpreted BPM non-destructively (updates timing & Stretch/Tape without modifying audio). */
export function setImportedBreakBpm(breakId, bpm, slotId = store.ui.sel) {
  const cur = getBreakDesc(breakId, slotId);
  if (!cur || !isImportedBreakId(breakId)) return null;
  const nextBpm = clamp(Math.round((Number(bpm) || cur.bpm) * 10) / 10, BREAK_BPM_RANGE[0], BREAK_BPM_RANGE[1]);
  if (Math.abs(nextBpm - cur.bpm) < 0.05) return cur;
  const next = { ...clone(cur), bpm: nextBpm };
  if (next.analysis) next.analysis = { ...next.analysis, note: `BPM set to ${nextBpm} · ${next.bars}B` };
  return commitImportedBreakMeta(breakId, next, { slotId, coalesce: `ruffbpm:${breakId}` });
}

/** Apply half-time (0.5) or double-time (2) correction cleanly to an imported break's BPM & bar count. */
export function scaleImportedBreakTempo(breakId, factor, slotId = store.ui.sel) {
  const cur = getBreakDesc(breakId, slotId);
  if (!cur || !isImportedBreakId(breakId)) return null;
  const f = factor >= 1.5 ? 2 : 0.5;
  const candBars = Math.round(cur.bars * f);
  const nextBars = IMPORTED_BREAK_BARS.includes(candBars) ? candBars : cur.bars;
  const nextBpm = nextBars !== cur.bars && cur.duration > 0
    ? bpmForBars(cur.duration, nextBars)
    : clamp(Math.round(cur.bpm * f * 10) / 10, BREAK_BPM_RANGE[0], BREAK_BPM_RANGE[1]);
  const buf = samples.buffer(breakId);
  const sliceMeta = buf
    ? extractSliceFeatures(buf, cur.slices, nextBars)
    : cur.sliceMeta.map((m, k) => ({ ...m, beatPos: breakPosBeatLabel(cur.slices[k] ?? 0, nextBars) }));
  const next = { ...clone(cur), bars: nextBars, bpm: nextBpm, sliceMeta };
  if (next.analysis) next.analysis = { ...next.analysis, ambiguity: null, note: `${f === 2 ? '2×' : '½×'} → ${nextBpm} BPM · ${nextBars}B` };
  const res = commitImportedBreakMeta(breakId, next, { slotId });
  if (res) emit('toast', `${res.name}: ${res.bpm} BPM · ${res.bars} ${res.bars === 1 ? 'bar' : 'bars'}`);
  return res;
}

/** Update an imported break's musical bar length (1, 2 or 4 bars) and recalculate its matching BPM non-destructively. */
export function setImportedBreakBars(breakId, bars, slotId = store.ui.sel) {
  const cur = getBreakDesc(breakId, slotId);
  if (!cur || !isImportedBreakId(breakId) || !IMPORTED_BREAK_BARS.includes(bars)) return null;
  if (cur.bars === bars) return cur;
  const nextBpm = cur.duration > 0 ? bpmForBars(cur.duration, bars) : cur.bpm;
  const buf = samples.buffer(breakId);
  const sliceMeta = buf
    ? extractSliceFeatures(buf, cur.slices, bars)
    : cur.sliceMeta.map((m, k) => ({ ...m, beatPos: breakPosBeatLabel(cur.slices[k] ?? 0, bars) }));
  const next = { ...clone(cur), bars, bpm: nextBpm, sliceMeta };
  if (next.analysis) next.analysis = { ...next.analysis, ambiguity: null, note: `Set to ${bars} ${bars === 1 ? 'bar' : 'bars'} · ${nextBpm} BPM` };
  const res = commitImportedBreakMeta(breakId, next, { slotId });
  if (res) emit('toast', `${res.name}: ${bars} ${bars === 1 ? 'bar' : 'bars'} (${res.bpm} BPM)`);
  return res;
}

/** Move one slice boundary of an imported break (continuous drag coalesced into one Undo step). */
export function moveImportedBreakSlice(breakId, markerIndex, pos, slotId = store.ui.sel) {
  const cur = getBreakDesc(breakId, slotId);
  if (!cur || !isImportedBreakId(breakId)) return null;
  const nextSlices = moveSliceBoundary(cur.slices, markerIndex, pos);
  const buf = samples.buffer(breakId);
  const sliceMeta = buf
    ? extractSliceFeatures(buf, nextSlices, cur.bars)
    : cur.sliceMeta.map((m, k) => ({ ...m, pos: nextSlices[k] ?? m.pos, beatPos: breakPosBeatLabel(nextSlices[k] ?? 0, cur.bars) }));
  return commitImportedBreakMeta(breakId, { ...clone(cur), slices: nextSlices, sliceMeta }, {
    slotId,
    coalesce: `ruffslice:${breakId}:${markerIndex}`,
    quiet: true,
  });
}

/** Nudge one slice boundary by ~10 ms (touch-friendly fine adjustment, Undoable). */
export function nudgeImportedBreakSlice(breakId, dir, markerIndex = store.ui.ruff.editMarker, slotId = store.ui.sel) {
  const cur = getBreakDesc(breakId, slotId);
  if (!cur || !isImportedBreakId(breakId) || markerIndex == null) {
    emit('toast', 'Tap a slice marker first');
    return null;
  }
  const step = Math.max(MIN_SLICE, cur.duration > 0 ? 0.01 / cur.duration : 0.005);
  const res = moveImportedBreakSlice(breakId, markerIndex, cur.slices[markerIndex] + (dir < 0 ? -step : step), slotId);
  sealHistory();
  return res;
}

/** Insert a new slice boundary at `pos` (or split the selected slice if `pos` is omitted). Remaps edited RUFF patterns. */
export function addImportedBreakSlice(breakId, pos = null, slotId = store.ui.sel) {
  const cur = getBreakDesc(breakId, slotId);
  if (!cur || !isImportedBreakId(breakId)) return null;
  const r = pos != null ? insertSliceBoundary(cur.slices, pos) : splitSlice(cur.slices, store.ui.ruff.editSlice || 0);
  if (r.error) {
    const msgs = {
      max: `RUFF supports up to ${MAX_SLICES} slices per break`,
      close: 'Too close to another marker — move the cursor slightly',
      range: 'Tap inside the waveform first',
      none: 'Select a slice first',
    };
    emit('toast', msgs[r.error] || 'Could not add slice marker');
    return null;
  }
  const buf = samples.buffer(breakId);
  const sliceMeta = extractSliceFeatures(buf, r.slices, cur.bars);
  const res = commitImportedBreakMeta(breakId, { ...clone(cur), slices: r.slices, sliceMeta }, {
    slotId,
    structural: true,
    oldSlices: cur.slices,
  });
  if (res) {
    const n = sliceCount(res.slices);
    store.ui.ruff.editMarker = r.at;
    store.ui.ruff.editSlice = clamp(r.at, 0, n - 1);
    emit('ruffedit');
  }
  return res;
}

/** Remove an inner slice boundary, merging its adjacent slices. Remaps edited RUFF patterns. */
export function removeImportedBreakSlice(breakId, markerIndex = store.ui.ruff.editMarker, slotId = store.ui.sel) {
  const cur = getBreakDesc(breakId, slotId);
  if (!cur || !isImportedBreakId(breakId) || markerIndex == null) {
    emit('toast', 'Tap an inner slice marker first');
    return null;
  }
  const r = removeSliceBoundary(cur.slices, markerIndex);
  if (r.error) {
    emit('toast', r.error === 'edge' ? 'Outer start/end markers frame the break and cannot be deleted' : 'Could not delete marker');
    return null;
  }
  const buf = samples.buffer(breakId);
  const sliceMeta = extractSliceFeatures(buf, r.slices, cur.bars);
  const res = commitImportedBreakMeta(breakId, { ...clone(cur), slices: r.slices, sliceMeta }, {
    slotId,
    structural: true,
    oldSlices: cur.slices,
  });
  if (res) {
    const idx = Math.max(0, markerIndex - 1);
    store.ui.ruff.editMarker = idx;
    store.ui.ruff.editSlice = clamp(idx, 0, Math.max(0, sliceCount(res.slices) - 1));
    emit('ruffedit');
  }
  return res;
}

/** Reset an imported break's slices to either 'auto' (re-detect transients) or 'even' (equal rhythmic grid). */
export function resetImportedBreakSlices(breakId, mode = 'even', slotId = store.ui.sel) {
  const cur = getBreakDesc(breakId, slotId);
  if (!cur || !isImportedBreakId(breakId)) return null;
  const buf = samples.buffer(breakId);
  let nextSlices;
  let sliceMeta;
  let nextAnalysis = cur.analysis ? clone(cur.analysis) : null;
  if (mode === 'auto' && buf) {
    const analyzed = analyzeBreakBuffer(buf, { preferredBars: cur.bars });
    nextSlices = analyzed.slices;
    sliceMeta = analyzed.sliceMeta;
    nextAnalysis = analyzed.analysis;
  } else {
    const count = cur.bars === 1 ? 8 : MAX_SLICES;
    nextSlices = defaultSlices(count);
    sliceMeta = extractSliceFeatures(buf, nextSlices, cur.bars);
    if (nextAnalysis) nextAnalysis = { ...nextAnalysis, fallback: false, note: `Reset to ${count} even slices` };
  }
  const res = commitImportedBreakMeta(breakId, {
    ...clone(cur),
    slices: nextSlices,
    sliceMeta,
    ...(nextAnalysis ? { analysis: nextAnalysis } : {}),
  }, {
    slotId,
    structural: true,
    oldSlices: cur.slices,
  });
  if (res) {
    store.ui.ruff.editSlice = 0;
    store.ui.ruff.editMarker = 0;
    emit('toast', mode === 'auto' ? `Auto-detected ${sliceCount(res.slices)} slices` : `Reset to ${sliceCount(res.slices)} even slices`);
  }
  return res;
}

/** UI status snapshot for one RUFF break lane */
export function breakLaneState(lane, slotId = store.ui.sel) {
  const s = slot(slotId);
  const id = (s && s.breaks && s.breaks[lane]) || null;
  const desc = id ? getBreakDesc(id, slotId) : null;
  const bankState = id ? samples.state(id) : { status: 'none', error: null };
  const aud = store.ui.ruff && store.ui.ruff.audition;
  return {
    lane,
    id,
    desc,
    imported: !!(id && isImportedBreakId(id)),
    unsaved: !!(id && isImportedBreakId(id) && samples.store.isUnsaved && samples.store.isUnsaved(id)),
    status: bankState.status,
    error: bankState.error,
    auditioning: !!(aud && aud.slotId === slotId && aud.lane === lane),
  };
}

/* ---------- RUFF Unified Sequencer, Locks & CHOP IT! (v0.7 PR33–35) ---------- */
let ruffSliceAudReq = 0;

/** Select a step (and optionally lane) in the RUFF sequencer for inspection (UI-only, never mutates project). */
export function selectRuffStep(step, lane = null) {
  const s = clamp(Math.trunc(Number(step) || 0), 0, BREAK_PATTERN_STEPS - 1);
  let changed = store.ui.ruff.selStep !== s;
  store.ui.ruff.selStep = s;
  if (lane && BREAK_LANES.includes(lane) && store.ui.ruff.selLane !== lane) {
    store.ui.ruff.selLane = lane;
    changed = true;
  }
  if (changed) emit('ruffui');
}

/** Set CHOP IT! mode: 'new' (New Groove) or 'evolve' (Evolve) (UI-only, never mutates project). */
export function setRuffChopMode(mode) {
  const next = RUFF_CHOP_MODES.includes(mode) ? mode : 'new';
  if (store.ui.ruff.chopMode === next) return;
  store.ui.ruff.chopMode = next;
  emit('ruffui');
}

/** Set CHOP IT! musical profile: 'jungle' | 'darkside' | 'atmospheric' | 'rolling' (UI-only). */
export function setRuffChopProfile(profile) {
  const next = RUFF_CHOP_PROFILES.includes(profile) ? profile : 'jungle';
  if (store.ui.ruff.profile === next) return;
  store.ui.ruff.profile = next;
  emit('ruffui');
}

/** Set CHOP IT! Subtle–Wild intensity [0..1] (UI-only; pass `{ silent: true }` during continuous slider drag). */
export function setRuffChopIntensity(value, { silent = false } = {}) {
  const next = clamp(Number.isFinite(Number(value)) ? Number(value) : 0.5, 0, 1);
  if (store.ui.ruff.intensity === next) return;
  store.ui.ruff.intensity = next;
  if (!silent) emit('ruffui');
}

/** Convert an unedited break lane into its editable 16-step groove on first edit (caller must checkpoint first). */
function materializeBreakLane(pattern, lane, breakId, breakMeta = null) {
  if (!pattern.edited) pattern.edited = {};
  if (isBreakLaneEdited(pattern, lane)) {
    pattern.edited[lane] = true;
    return false;
  }
  pattern.edited[lane] = true;
  pattern.lanes[lane] = breakId ? originalGrooveRow(breakId, pattern.len, breakMeta) : Array(pattern.len).fill(null);
  return true;
}

function breakStepLocked(pattern, lane, step) {
  return isBreakCellLocked(pattern, lane, step);
}

/** Preview a single slice of a RUFF lane's assigned break immediately (synced to project BPM & Stretch/Tape). */
export function auditionBreakSlice(lane, sliceIndex, slotId = store.ui.sel) {
  if (!BREAK_LANES.includes(lane)) return false;
  const s = slot(slotId);
  const breakId = s && s.breaks && s.breaks[lane];
  if (!s || !isBreakSlot(slotId) || !breakId) return false;
  const slice = clampBreakSlice(breakId, sliceIndex, 0, s.breakMeta);
  if (store.ui.ruff && store.ui.ruff.audition) stopBreakAudition(slotId);
  emit('livehit', { slotId, hits: [{ lane, slice, v: .9 }] });
  if (!canSound()) return true;

  const req = ++ruffSliceAudReq;
  engine.init();
  engine.applyParams(slotId);
  const fire = () => {
    if (req !== ruffSliceAudReq) return;
    hear(() => engine.audition(slotId, null, .9, {
      lane,
      breakId,
      slice,
      ...(isImportedBreakId(breakId) ? {} : { dur: engine.stepDur() * 2 }),
    }));
  };
  if (samples.buffer(breakId)) {
    prepareStretch();
    fire();
  } else {
    samples.load(breakId).then(buf => {
      if (req !== ruffSliceAudReq || !buf) return;
      prepareStretch();
      fire();
    });
  }
  return true;
}

/**
 * Toggle one step on a RUFF lane.
 * - First edit on an unedited lane converts that lane into its 16-step original groove before toggling.
 * - Turning a step on suggests a break-aware slice based on rhythmic position and auditions it.
 * - Turning off the final remaining step leaves the lane edited-empty (silent, never restarting whole-loop).
 */
export function toggleBreakStep(lane, step, slotId = store.ui.sel) {
  if (!BREAK_LANES.includes(lane)) return false;
  const s = slot(slotId), p = pat(slotId);
  if (!s || !p || !isBreakSlot(slotId) || !Number.isInteger(step) || step < 0 || step >= p.len) return false;
  if (breakStepLocked(p, lane, step)) { emit('toast', 'That step is locked'); return false; }
  const breakId = (s.breaks && s.breaks[lane]) || null;
  if (!breakId && !isBreakLaneEdited(p, lane)) {
    emit('toast', `Assign a break to ${lane.toUpperCase()} in SOUND first`);
    return false;
  }
  const was4BarUnedited = !isBreakLaneEdited(p, lane) && breakBarsOf(breakId, s.breakMeta) === 4;
  checkpoint();
  materializeBreakLane(p, lane, breakId, s.breakMeta);
  if (p.lanes[lane][step]) {
    p.lanes[lane][step] = null;
  } else {
    const slice = suggestedSliceForStep(breakId, step, p.len, s.breakMeta);
    p.lanes[lane][step] = { slice, v: 1, p: 1 };
    if (breakId) auditionBreakSlice(lane, slice, slotId);
  }
  store.ui.ruff.selStep = step;
  store.ui.ruff.selLane = lane;
  save();
  emit('pattern');
  if (was4BarUnedited) emit('toast', '4-bar break sliced onto 2-bar grid (all 4-bar slices available; Orig restores 4-bar loop)');
  return true;
}

/**
 * Assign (or reassign) a specific slice to (lane, step).
 * Converts an unedited lane on first edit, adds the step if empty, keeps slice valid for the source, and auditions it.
 */
export function setBreakStepSlice(lane, step, sliceIndex, slotId = store.ui.sel) {
  if (!BREAK_LANES.includes(lane)) return false;
  const s = slot(slotId), p = pat(slotId);
  if (!s || !p || !isBreakSlot(slotId) || !Number.isInteger(step) || step < 0 || step >= p.len) return false;
  if (breakStepLocked(p, lane, step)) { emit('toast', 'That step is locked'); return false; }
  const breakId = (s.breaks && s.breaks[lane]) || null;
  if (!breakId && !isBreakLaneEdited(p, lane)) {
    emit('toast', `Assign a break to ${lane.toUpperCase()} in SOUND first`);
    return false;
  }
  const slice = clampBreakSlice(breakId, sliceIndex, 0, s.breakMeta);
  store.ui.ruff.selStep = step;
  store.ui.ruff.selLane = lane;
  const alreadyEdited = isBreakLaneEdited(p, lane);
  const existing = p.lanes[lane][step];
  if (alreadyEdited && existing && existing.slice === slice) {
    if (breakId) auditionBreakSlice(lane, slice, slotId);
    emit('ruffui');
    return false;
  }
  checkpoint();
  materializeBreakLane(p, lane, breakId, s.breakMeta);
  const cur = p.lanes[lane][step];
  p.lanes[lane][step] = cur ? { ...cur, slice } : { slice, v: 1, p: 1 };
  if (breakId) auditionBreakSlice(lane, slice, slotId);
  save();
  emit('pattern');
  return true;
}

/** Explicitly remove a hit at (lane, step), converting an unedited lane first so other steps keep the groove. */
export function eraseBreakStep(lane, step, slotId = store.ui.sel) {
  if (!BREAK_LANES.includes(lane)) return false;
  const s = slot(slotId), p = pat(slotId);
  if (!s || !p || !isBreakSlot(slotId) || !Number.isInteger(step) || step < 0 || step >= p.len) return false;
  if (breakStepLocked(p, lane, step)) { emit('toast', 'That step is locked'); return false; }
  const breakId = (s.breaks && s.breaks[lane]) || null;
  if (isBreakLaneEdited(p, lane) && !p.lanes[lane][step]) {
    selectRuffStep(step, lane);
    return false;
  }
  if (!breakId && !isBreakLaneEdited(p, lane)) return false;
  checkpoint();
  materializeBreakLane(p, lane, breakId, s.breakMeta);
  p.lanes[lane][step] = null;
  store.ui.ruff.selStep = step;
  store.ui.ruff.selLane = lane;
  save();
  emit('pattern');
  return true;
}

/**
 * Toggle lock on a single (lane, step) cell — works identically on populated hits AND empty/silent cells.
 * Uses persistent `pattern.locked["<lane>:<step>"]` without forcing unedited lanes into edited state.
 */
export function toggleBreakCellLock(lane, step, slotId = store.ui.sel) {
  if (!BREAK_LANES.includes(lane)) return false;
  const s = slot(slotId), p = pat(slotId);
  if (!s || !p || !isBreakSlot(slotId) || !Number.isInteger(step) || step < 0 || step >= p.len) return false;
  const breakId = (s.breaks && s.breaks[lane]) || null;
  if (!breakId && !isBreakLaneEdited(p, lane) && !isBreakCellDirectlyLocked(p, lane, step)) return false;
  checkpoint();
  if (!p.locked) p.locked = {};
  const key = breakCellLockKey(lane, step);
  const cell = p.lanes[lane] && p.lanes[lane][step];
  if (isBreakCellDirectlyLocked(p, lane, step)) {
    delete p.locked[key];
    if (cell && cell.locked) delete cell.locked;
  } else {
    p.locked[key] = true;
  }
  store.ui.ruff.selStep = step;
  store.ui.ruff.selLane = lane;
  save();
  emit('pattern');
  return true;
}

/** Toggle full-column lock on `step` across all A/B/C lanes (protects hits and silence). */
export function toggleBreakColumnLock(step, slotId = store.ui.sel) {
  const s = slot(slotId), p = pat(slotId);
  if (!s || !p || !isBreakSlot(slotId) || !Number.isInteger(step) || step < 0 || step >= p.len) return false;
  checkpoint();
  if (!p.locked) p.locked = {};
  const key = String(step);
  if (p.locked[key]) delete p.locked[key];
  else p.locked[key] = true;
  store.ui.ruff.selStep = step;
  save();
  emit('pattern');
  return true;
}

/** Toggle full-lane lock on A, B or C (protects the entire lane including unedited original playback). */
export function toggleBreakLaneLock(lane, slotId = store.ui.sel) {
  if (!BREAK_LANES.includes(lane)) return false;
  const s = slot(slotId), p = pat(slotId);
  if (!s || !p || !isBreakSlot(slotId)) return false;
  checkpoint();
  if (!p.locked) p.locked = {};
  if (p.locked[lane]) delete p.locked[lane];
  else p.locked[lane] = true;
  save();
  emit('pattern');
  return true;
}

/** Explicitly clear one RUFF lane in the current scene to silence (preserves locked hits & never falls back to whole-loop). */
export function clearBreakLane(lane, slotId = store.ui.sel) {
  if (!BREAK_LANES.includes(lane)) return false;
  const s = slot(slotId), p = pat(slotId);
  if (!s || !p || !isBreakSlot(slotId)) return false;
  if (isBreakLaneLocked(p, lane)) { emit('toast', `Break ${lane.toUpperCase()} is locked`); return false; }
  const breakId = (s.breaks && s.breaks[lane]) || null;
  const edited = isBreakLaneEdited(p, lane);
  const eff = effectiveBreakRow(p, lane, breakId, s.breakMeta);
  const hasUnlocked = eff.some((c, i) => c && !isBreakCellLocked(p, lane, i));
  if (edited && !hasUnlocked) return false;
  if (!edited && !breakId) return false;
  checkpoint();
  if (!p.edited) p.edited = {};
  p.edited[lane] = true;
  p.lanes[lane] = Array.from({ length: p.len }, (_, i) => {
    if (!isBreakCellLocked(p, lane, i)) return null;
    if (edited) return p.lanes[lane][i] ? clone(p.lanes[lane][i]) : null;
    const c = eff[i];
    return c ? { slice: c.slice, v: c.v ?? 1, p: c.p ?? 1 } : null;
  });
  save();
  emit('pattern');
  return true;
}

/** Restore one RUFF lane in the current scene back to its original break groove (preserving any locked steps/silence). */
export function resetBreakLane(lane, slotId = store.ui.sel) {
  if (!BREAK_LANES.includes(lane)) return false;
  const s = slot(slotId), p = pat(slotId);
  if (!s || !p || !isBreakSlot(slotId)) return false;
  if (isBreakLaneLocked(p, lane)) { emit('toast', `Break ${lane.toUpperCase()} is locked`); return false; }
  if (!isBreakLaneEdited(p, lane)) return false;
  const breakId = (s.breaks && s.breaks[lane]) || null;
  const hasStepLock = Array.from({ length: p.len }, (_, i) => isBreakCellLocked(p, lane, i)).some(Boolean);
  checkpoint();
  if (hasStepLock) {
    const orig = breakId ? originalGrooveRow(breakId, p.len, s.breakMeta) : Array(p.len).fill(null);
    if (!p.edited) p.edited = {};
    p.edited[lane] = true;
    p.lanes[lane] = Array.from({ length: p.len }, (_, i) => (
      isBreakCellLocked(p, lane, i)
        ? (p.lanes[lane][i] ? clone(p.lanes[lane][i]) : null)
        : orig[i]
    ));
  } else {
    if (p.edited) delete p.edited[lane];
    p.lanes[lane] = Array(p.len).fill(null);
  }
  save();
  emit('pattern');
  emit('toast', `Break ${lane.toUpperCase()} reset to original groove${hasStepLock ? ' (locked steps kept)' : ''}`);
  return true;
}

/**
 * CHOP IT!: apply musical jungle/DnB break generation immediately to the intended scene's RUFF pattern.
 * - One atomic Undo step per press; repeated presses evolve the current result.
 * - Never auto-starts or stops global transport.
 * - Preserves assigned breaks, all locks (hits, silence, columns, lanes) and explicitly silenced lanes.
 */
export function chopRuff({
  mode = store.ui.ruff.chopMode,
  profile = store.ui.ruff.profile,
  intensity = store.ui.ruff.intensity,
  seed = randomSeed(),
  sceneIdx = store.project ? store.project.scene : 0,
} = {}, slotId = store.ui.sel) {
  const project = store.project;
  const s = slot(slotId);
  if (!project || !s || !isBreakSlot(slotId)) return null;
  if (!hasAssignedBreak(s)) {
    emit('toast', 'Load a break in Break Pool first');
    return null;
  }
  const sc = clamp(Number.isInteger(sceneIdx) ? sceneIdx : project.scene, 0, Math.max(0, project.scenes.length - 1));
  const p = patternAt(project, slotId, sc);
  if (!p) return null;

  const cleanMode = RUFF_CHOP_MODES.includes(mode) ? mode : 'new';
  const cleanProfile = RUFF_CHOP_PROFILES.includes(profile) ? profile : 'jungle';
  const cleanIntensity = clamp(Number.isFinite(Number(intensity)) ? Number(intensity) : 0.5, 0, 1);

  const res = chopBreakPattern({
    pattern: p,
    breaks: s.breaks,
    breakMeta: s.breakMeta || null,
    mode: cleanMode,
    profile: cleanProfile,
    intensity: cleanIntensity,
    seed,
  });

  store.ui.ruff.chopMode = cleanMode;
  store.ui.ruff.profile = cleanProfile;
  store.ui.ruff.intensity = cleanIntensity;

  if (!res.changed) {
    emit('toast', 'All active lanes are locked or silenced — unlock or reset a lane to chop');
    emit('ruffui');
    return res;
  }

  checkpoint();
  setPatternAt(project, slotId, sc, res.pattern);
  save();
  emit('pattern', { slot: slotId, kind: 'chop' });
  const meta = RUFF_PROFILE_META[cleanProfile];
  emit('toast', `CHOP IT! · ${meta.label} (${cleanMode === 'evolve' ? 'Evolve' : 'New Groove'})`);
  return res;
}



