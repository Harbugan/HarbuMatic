// HBM-061-02: Dynamic Scene Library tests — single-scene empty projects, New Scene, Duplicate Scene
// deep-copy independence across all five instruments, Copy To, Rename, Delete (never final scene),
// >6 scenes & MAX_SCENES limit, arrangement integrity, live playback/queued scene safety,
// Undo/Redo and current-version .hbn round-trip.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../src/app/actions.js';
import { store } from '../src/app/store.js';
import { MAX_SCENES, sceneLabel } from '../src/core/constants.js';
import {
  createEmptyProject, validateProject, importProject, patternAt, setPatternAt,
  slotById, sceneIdAt, sceneIndexOf, blockScene, patternIsEmpty, slotAudible,
} from '../src/core/project.js';
import { exportPackage, parsePackage, restorePackage } from '../src/core/package.js';
import { createSampleStore, memoryBackend } from '../src/samples/store.js';
import { createTransport } from '../src/audio/scheduler.js';
import { startPosition, advance } from '../src/audio/position.js';

function freshSong(opts = {}) {
  A.transport.stop();
  store.project = createEmptyProject({ name: 'Dynamic Test', ...opts });
  store.ui.sel = 'slot-01';
  store.ui.libSel = 0;
  store.ui.arrSel = null;
  store.ui.munch.magic = null;
  A.history.clear();
  return store.project;
}

/** Drive a deterministic virtual-clock transport over a project and record all triggers. */
function captureTriggers(project, sceneIdx, steps = 32) {
  const p = structuredClone(project);
  p.scene = sceneIdx; p.songMode = false;
  const calls = [], ctx = { currentTime: 0 };
  const engine = {
    ctx, init: () => ctx, openGates() {}, closeGates() {}, stepDur: () => 60 / p.bpm / 4,
    audible: id => slotAudible(p, slotById(p, id)),
    trigger: (id, t, hit) => calls.push([id, Math.round(t * 1e6), JSON.stringify(hit)]),
  };
  let tick; const si = globalThis.setInterval, ci = globalThis.clearInterval, mr = Math.random;
  let seed = 42;
  Math.random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  globalThis.setInterval = fn => { tick = fn; return 1; };
  globalThis.clearInterval = () => {};
  try {
    const tr = createTransport(engine, () => p, {});
    tr.play();
    let seen = 0;
    while (seen < steps) { ctx.currentTime += .01; tick(); seen += tr.queue.splice(0).length; }
    tr.stop();
  } finally { globalThis.setInterval = si; globalThis.clearInterval = ci; Math.random = mr; }
  return calls;
}

test('new projects start with exactly one empty scene across all six instruments', () => {
  const p = freshSong();
  assert.equal(p.scenes.length, 1);
  assert.equal(p.scenes[0].id, 'scene-01');
  assert.equal(p.scenes[0].name, 'Scene 1');
  assert.equal(p.scenes[0].harmony, null);
  assert.equal(p.scene, 0);
  assert.deepEqual(p.arrangement, []);
  assert.equal(p.slots.length, 6);
  for (const s of p.slots) {
    assert.deepEqual(Object.keys(s.patterns), ['scene-01']);
    assert.ok(patternIsEmpty(s.type, s.patterns['scene-01']), `${s.type} starts empty`);
  }
  // validateProject preserves 1-scene songs (never pads back to 6)
  const v = validateProject(JSON.parse(JSON.stringify(p)));
  assert.equal(v.scenes.length, 1);
  assert.equal(v.scenes[0].id, 'scene-01');
});

test('sceneLabel maps arbitrary dynamic scene indices cleanly (A..Z, AA..BL)', () => {
  assert.equal(sceneLabel(0), 'A');
  assert.equal(sceneLabel(5), 'F');
  assert.equal(sceneLabel(6), 'G');
  assert.equal(sceneLabel(25), 'Z');
  assert.equal(sceneLabel(26), 'AA');
  assert.equal(sceneLabel(27), 'AB');
  assert.equal(sceneLabel(MAX_SCENES - 1), 'BL');
});

test('New Scene creates an independent empty scene and never auto-enters Song Arrangement', () => {
  const p = freshSong();
  // Put content in scene 0 and tweak a global instrument param
  patternAt(p, 'slot-01', 0).steps.kick[0] = { v: .9, p: 1 };
  slotById(p, 'slot-02').params.cutoff = .77;
  const created = A.createScene();
  assert.ok(created);
  assert.equal(p.scenes.length, 2);
  assert.equal(created.id, 'scene-02');
  assert.equal(created.index, 1);
  assert.equal(p.scene, 1);
  assert.deepEqual(p.arrangement, [], 'new scene must not auto-enter arrangement');
  // Every instrument has an independent empty pattern for the new scene
  for (const s of p.slots) {
    assert.ok(patternIsEmpty(s.type, patternAt(p, s.id, 1)), `${s.type} is empty in new scene`);
  }
  // Original scene and global params are untouched
  assert.deepEqual(patternAt(p, 'slot-01', 0).steps.kick[0], { v: .9, p: 1 });
  assert.equal(slotById(p, 'slot-02').params.cutoff, .77);
});

test('Duplicate Scene deep-copies all five instruments and harmony with complete independence and identical playback', () => {
  const p = freshSong();
  p.scenes[0].name = 'Main Groove';
  p.scenes[0].harmony = { degrees: [0, 5, 2, 6], span: 32 };
  // Populate all 5 instruments: BOP, GOO, BLIP, FUZZ, MUNCH
  const bop0 = patternAt(p, 'slot-01', 0);
  bop0.steps.kick[0] = { v: .95, p: 1 }; bop0.steps.snare[4] = { v: .8, p: .75 }; bop0.locked.kick = true;
  setPatternAt(p, 'slot-02', 0, { len: 32, notes: [{ s: 0, p: 33, l: 2, v: .9, slide: true }, { s: 2, p: 36, l: 1, v: .8, locked: true }] });
  setPatternAt(p, 'slot-03', 0, { len: 32, notes: [{ s: 0, p: 60, l: 4, v: .7, pr: .8, o: .05 }] });
  setPatternAt(p, 'slot-04', 0, { len: 16, notes: [{ s: 4, p: 72, l: 3, v: .65 }] });
  setPatternAt(p, 'slot-05', 0, { len: 16, notes: [{ s: 0, p: 60, l: 1, v: .9, slice: 2 }, { s: 8, p: 64, l: 2, v: .75 }] });
  slotById(p, 'slot-03').params.cutoff = .81;
  p.fx.rev = 1.05;

  const dup = A.duplicateScene(0);
  assert.ok(dup);
  assert.equal(p.scenes.length, 2);
  assert.equal(dup.id, 'scene-02');
  assert.equal(p.scenes[1].name, 'Main Groove copy');
  assert.deepEqual(p.arrangement, [], 'duplicated scene must not auto-enter arrangement');

  // Deep equality across all five slots + harmony
  for (const s of p.slots) {
    assert.deepEqual(patternAt(p, s.id, 1), patternAt(p, s.id, 0), `${s.id} copied identically`);
    assert.notEqual(patternAt(p, s.id, 1), patternAt(p, s.id, 0), `${s.id} is a separate object`);
  }
  assert.deepEqual(p.scenes[1].harmony, p.scenes[0].harmony);
  assert.notEqual(p.scenes[1].harmony, p.scenes[0].harmony);

  // Identical playback triggers before editing
  assert.deepEqual(captureTriggers(p, 1, 32), captureTriggers(p, 0, 32), 'duplicate sounds identical to source');

  // Mutate every instrument & harmony in the duplicate — original MUST stay untouched
  const origSnapshot = structuredClone({ harmony: p.scenes[0].harmony, pats: p.slots.map(s => patternAt(p, s.id, 0)) });
  patternAt(p, 'slot-01', 1).steps.kick[0].v = .2;
  patternAt(p, 'slot-01', 1).steps.clap[8] = { v: 1, p: 1 };
  patternAt(p, 'slot-01', 1).locked.snare = true;
  patternAt(p, 'slot-02', 1).notes[0].p = 45;
  patternAt(p, 'slot-03', 1).notes.push({ s: 12, p: 67, l: 2, v: .8 });
  patternAt(p, 'slot-04', 1).notes.length = 0;
  patternAt(p, 'slot-05', 1).notes[0].slice = 5;
  p.scenes[1].harmony.degrees[0] = 3;

  assert.deepEqual(p.scenes[0].harmony, origSnapshot.harmony, 'original harmony untouched');
  p.slots.forEach((s, k) => {
    assert.deepEqual(patternAt(p, s.id, 0), origSnapshot.pats[k], `${s.id} original pattern untouched`);
  });

  // Global instrument parameters and FX remain shared
  assert.equal(slotById(p, 'slot-03').params.cutoff, .81);
  assert.equal(p.fx.rev, 1.05);
});

test('Copy To overwrites target with an independent deep copy; Rename updates name without breaking arrangement', () => {
  const p = freshSong();
  patternAt(p, 'slot-01', 0).steps.kick[0] = { v: .9, p: 1 };
  p.scenes[0].harmony = { degrees: [0, 3, 4], span: 16 };
  A.createScene({ name: 'Target' });
  patternAt(p, 'slot-02', 1).notes.push({ s: 0, p: 40, l: 2, v: .8 });
  A.addToSong(1);

  A.copyScene(0, 1);
  assert.deepEqual(patternAt(p, 'slot-01', 1), patternAt(p, 'slot-01', 0));
  assert.deepEqual(patternAt(p, 'slot-02', 1).notes, []);
  assert.deepEqual(p.scenes[1].harmony, p.scenes[0].harmony);
  // Editing target does not change source
  patternAt(p, 'slot-01', 1).steps.kick[0].v = .3;
  assert.equal(patternAt(p, 'slot-01', 0).steps.kick[0].v, .9);

  // Rename keeps stable sceneId and arrangement reference valid
  A.renameScene(1, 'Chorus');
  assert.equal(p.scenes[1].name, 'Chorus');
  assert.equal(p.scenes[1].id, 'scene-02');
  assert.equal(p.arrangement[0].sceneId, 'scene-02');
  assert.equal(blockScene(p, p.arrangement[0]), 1);
});

test('Delete Scene removes scene, patterns and arrangement references, and refuses to delete the final scene', () => {
  const p = freshSong();
  // Never delete the final scene
  assert.equal(A.deleteScene(0), false);
  assert.equal(p.scenes.length, 1);

  A.createScene({ name: 'Verse' });
  A.createScene({ name: 'Chorus' });
  A.addToSong(0);
  A.addToSong(1);
  A.addToSong(2);
  A.addToSong(1);
  assert.equal(p.arrangement.length, 4);

  // Delete middle scene (scene-02)
  assert.equal(A.deleteScene(1), true);
  assert.deepEqual(p.scenes.map(s => s.id), ['scene-01', 'scene-03']);
  for (const s of p.slots) assert.equal(s.patterns['scene-02'], undefined, `${s.id} deleted pattern cleaned up`);
  assert.deepEqual(p.arrangement.map(b => b.sceneId), ['scene-01', 'scene-03']);
  assert.equal(blockScene(p, p.arrangement[1]), 1, 'remaining block resolves to new index of scene-03');

  // Creating another scene gets a clean non-colliding ID
  const next = A.createScene({ name: 'Bridge' });
  assert.equal(next.id, 'scene-02');
  assert.equal(new Set(p.scenes.map(s => s.id)).size, p.scenes.length);

  // Deleting down to 1 scene works, then deleting the last one is refused
  assert.equal(A.deleteScene(2), true);
  assert.equal(A.deleteScene(1), true);
  assert.equal(p.scenes.length, 1);
  assert.equal(A.deleteScene(0), false);
  assert.equal(p.scenes.length, 1);
});

test('more than six scenes work cleanly and MAX_SCENES limit is enforced', () => {
  const p = freshSong();
  for (let i = 1; i < 10; i++) {
    const r = A.createScene();
    assert.ok(r, `scene ${i + 1} created`);
  }
  assert.equal(p.scenes.length, 10);
  assert.equal(p.scenes[9].id, 'scene-10');
  // Switching and scheduling on scene 10 works
  A.selectScene(9);
  assert.equal(p.scene, 9);
  patternAt(p, 'slot-01', 9).steps.kick[0] = { v: 1, p: 1 };
  assert.ok(captureTriggers(p, 9, 16).some(c => c[0] === 'slot-01'));

  // Push to MAX_SCENES
  while (p.scenes.length < MAX_SCENES) assert.ok(A.createScene({ select: false }));
  assert.equal(p.scenes.length, MAX_SCENES);
  assert.equal(A.createScene(), null, 'createScene refused at MAX_SCENES');
  assert.equal(A.duplicateScene(0), null, 'duplicateScene refused at MAX_SCENES');
  assert.equal(p.scenes.length, MAX_SCENES);
});

test('scene reordering keeps arrangement references, patterns and selection intact', () => {
  const p = freshSong();
  patternAt(p, 'slot-01', 0).steps.kick[0] = { v: .9, p: 1 };
  A.createScene({ name: 'Second' });
  patternAt(p, 'slot-01', 1).steps.snare[4] = { v: .8, p: 1 };
  A.createScene({ name: 'Third' });
  A.addToSong(0); A.addToSong(1); A.addToSong(2);
  A.selectScene(0);
  store.ui.libSel = 1;

  assert.equal(A.moveScene(0, 2), true);
  assert.deepEqual(p.scenes.map(s => s.id), ['scene-02', 'scene-03', 'scene-01']);
  assert.equal(p.scene, 2, 'edited scene follows scene-01');
  assert.equal(store.ui.libSel, 0, 'library selection follows scene-02');
  assert.deepEqual(p.arrangement.map(b => b.sceneId), ['scene-01', 'scene-02', 'scene-03']);
  assert.deepEqual(p.arrangement.map(b => blockScene(p, b)), [2, 0, 1]);
  assert.ok(patternAt(p, 'slot-01', 2).steps.kick[0], 'pattern follows scene-01');
  assert.ok(patternAt(p, 'slot-01', 0).steps.snare[4], 'pattern follows scene-02');
});

test('active playback and queued scenes remain safe during scene switch, reorder, delete and undo', () => {
  const p = freshSong();
  A.createScene({ name: 'Two', select: false });
  A.createScene({ name: 'Three', select: false });

  // Simulate active loop playback on scene 2 (scene-03) with scene 1 (scene-02) queued
  A.transport.state = 'playing';
  A.transport.pos = { song: false, block: 0, rep: 0, scene: 2, step: 7, fresh: false };
  A.transport.pending = 1;

  // Deleting non-playing scene 0 shifts playing scene (scene-03: 2→1) and pending (scene-02: 1→0) without dropping step!
  A.deleteScene(0);
  assert.equal(A.transport.pos.scene, 1);
  assert.equal(A.transport.pos.step, 7);
  assert.equal(A.transport.pending, 0);

  // Deleting the queued scene (scene-02 at index 0) clears pending and shifts playing scene (scene-03: 1→0)
  A.deleteScene(0);
  assert.equal(A.transport.pos.scene, 0);
  assert.equal(A.transport.pos.step, 7);
  assert.equal(A.transport.pending, null);

  // Create scene B, switch playback to it, then delete the playing scene itself → safely falls back to scene 0
  A.createScene({ name: 'Temp' });
  A.transport.pos = { song: false, block: 0, rep: 0, scene: 1, step: 5, fresh: false };
  A.deleteScene(1);
  assert.equal(A.transport.pos.scene, 0);
  assert.equal(A.transport.pos.step, 0);
  assert.equal(A.transport.pos.fresh, true);

  // Create scene B, move playback to it, then UNDO creation while playing → safely reconciles back to scene 0
  A.createScene({ name: 'UndoMe' });
  A.transport.pos = { song: false, block: 0, rep: 0, scene: 1, step: 9, fresh: false };
  A.undo();
  assert.equal(store.project.scenes.length, 1);
  assert.equal(A.transport.pos.scene, 0);

  // Song mode: deleting a scene whose blocks are the only blocks stops song transport cleanly
  A.createScene({ name: 'SongOnly' });
  A.addToSong(1);
  store.project.songMode = true;
  A.transport.state = 'playing';
  A.transport.pos = { song: true, block: 0, rep: 0, scene: 1, step: 4, fresh: false };
  A.deleteScene(1);
  assert.equal(A.transport.state, 'stopped');
  assert.equal(A.transport.pos, null);

  // Position walker handles out-of-range pending gracefully
  const oneScene = createEmptyProject();
  const st = startPosition(oneScene, { scene: 5 });
  assert.equal(st.scene, 0);
  const adv = advance({ song: false, block: 0, rep: 0, scene: 0, step: 15, fresh: false }, oneScene, 4);
  assert.equal(adv.pos.scene, 0);
  assert.equal(adv.pendingUsed, true);
});

test('all dynamic scene operations support Undo and Redo completely', () => {
  const p = freshSong();
  patternAt(p, 'slot-01', 0).steps.kick[0] = { v: .9, p: 1 };

  A.createScene({ name: 'Two' });
  assert.equal(store.project.scenes.length, 2);
  A.duplicateScene(0);
  assert.equal(store.project.scenes.length, 3);
  A.renameScene(2, 'Groove B');
  assert.equal(store.project.scenes[2].name, 'Groove B');
  A.copyScene(2, 1);
  assert.ok(patternAt(store.project, 'slot-01', 1).steps.kick[0]);
  A.addToSong(2);
  A.moveScene(2, 0);
  assert.equal(store.project.scenes[0].name, 'Groove B');
  A.deleteScene(0);
  assert.equal(store.project.scenes.length, 2);
  assert.equal(store.project.arrangement.length, 0);

  // Undo delete → scene and its arrangement block return
  A.undo();
  assert.equal(store.project.scenes.length, 3);
  assert.equal(store.project.scenes[0].name, 'Groove B');
  assert.equal(store.project.arrangement.length, 1);

  // Undo move → back to index 2
  A.undo();
  assert.equal(store.project.scenes[2].name, 'Groove B');

  // Undo addToSong, copy, rename, duplicate, create → back to initial 1 scene
  A.undo(); // addToSong
  A.undo(); // copy
  assert.equal(patternAt(store.project, 'slot-01', 1).steps.kick[0], null);
  A.undo(); // rename
  assert.equal(store.project.scenes[2].name, 'Scene 1 copy');
  A.undo(); // duplicate
  assert.equal(store.project.scenes.length, 2);
  A.undo(); // create
  assert.equal(store.project.scenes.length, 1);

  // Redo all the way back
  for (let i = 0; i < 7; i++) A.redo();
  assert.equal(store.project.scenes.length, 2);
  assert.equal(store.project.arrangement.length, 0);
});

test('current-version .hbn export/import and library persistence round-trip 1-scene and >6-scene projects', async () => {
  const sampleStore = createSampleStore({ backend: memoryBackend() });

  // 1) Single-scene project round-trips as 1 scene (never inflated to 6)
  const single = freshSong({ name: 'Solo Scene' });
  patternAt(single, 'slot-01', 0).steps.kick[0] = { v: .85, p: 1 };
  const pkg1 = await exportPackage(single, { sampleStore });
  const parsed1 = await parsePackage(pkg1.bytes);
  const restored1 = await restorePackage(parsed1, { sampleStore });
  assert.equal(restored1.project.scenes.length, 1);
  assert.deepEqual(restored1.project, validateProject(single));

  // 2) 8-scene project with custom names, harmonies, MUNCH notes and arrangement round-trips identically
  const p = freshSong({ name: 'Eight Scenes' });
  patternAt(p, 'slot-01', 0).steps.kick[0] = { v: .9, p: 1 };
  p.scenes[0].harmony = { degrees: [0, 4, 5, 3], span: 32 };
  for (let i = 1; i < 8; i++) A.duplicateScene(0, { name: `Part ${i + 1}`, select: false });
  setPatternAt(p, 'slot-05', 7, { len: 16, notes: [{ s: 0, p: 60, l: 1, v: .9, slice: 3 }] });
  A.addToSong(0); A.addToSong(6); A.addToSong(7);
  A.selectScene(7);
  A.save(true);

  const fromLib = A.library.load(p.id);
  assert.equal(fromLib.scenes.length, 8);
  assert.equal(fromLib.scene, 7);
  assert.deepEqual(fromLib.arrangement.map(b => b.sceneId), ['scene-01', 'scene-07', 'scene-08']);
  assert.equal(patternAt(fromLib, 'slot-05', 7).notes[0].slice, 3);

  const pkg8 = await exportPackage(p, { sampleStore });
  const parsed8 = await parsePackage(pkg8.bytes);
  const restored8 = await restorePackage(parsed8, { sampleStore });
  assert.deepEqual(restored8.project, importProject(JSON.parse(JSON.stringify(p))));
  assert.equal(restored8.project.scenes.length, 8);
  assert.equal(sceneIndexOf(restored8.project, 'scene-08'), 7);
});
