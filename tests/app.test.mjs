// Application actions on the slot model, run in Node (no DOM, no audio context): selection, mute/solo,
// snapshots, scene + arrangement edits, undo/redo and autosave. The engine stays uninitialised here,
// so these test state, not sound (sound dispatch is covered by tests/scheduler.test.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as A from '../src/app/actions.js';
import { store, pat, typeOf, visibleSlots, ensureSelection } from '../src/app/store.js';
import { importProject, patternAt, sceneIndexOf, slotById, createSlot, nextSlotId } from '../src/core/project.js';

const fx = f => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const load = f => { store.project = importProject(fx(f)); store.ui.sel = 'slot-01'; A.history.clear(); };

test('boot starts on the demo song with slot-01 (BOP) selected', () => {
  const { fresh } = A.bootProject();
  assert.equal(fresh, true);
  assert.equal(store.ui.sel, 'slot-01');
  assert.equal(typeOf().name, 'BOP');
  assert.deepEqual(visibleSlots().map(s => s.id), ['slot-01', 'slot-02', 'slot-03', 'slot-04']);
});

test('selection uses slot ids; tools a type lacks fall back to Draw', () => {
  load('v5-demo.json');
  A.selectSlot('slot-02'); A.setTool('slide');
  assert.equal(store.ui.sel, 'slot-02'); assert.equal(store.ui.tool, 'slide');
  A.selectSlot('slot-03');
  assert.equal(store.ui.tool, 'draw', 'BLIP has no slide tool');
  A.selectSlot('slot-99');
  assert.equal(store.ui.sel, 'slot-03', 'unknown slot ids are ignored');
});

test('selection moves off a slot that is not visible', () => {
  load('v5-demo.json');
  assert.equal(slotById(store.project, 'slot-05').type, 'munch', 'the migrated song holds a MUNCH slot');
  store.ui.sel = 'slot-05'; ensureSelection();
  assert.equal(store.ui.sel, 'slot-01', 'MUNCH is never selected while it is planned');
  assert.ok(!visibleSlots().some(s => s.type === 'munch'));
  A.selectSlot('slot-05');
  assert.equal(store.ui.sel, 'slot-01', 'selectSlot refuses a planned instrument');
});

test('mute / solo toggle per slot and undo', () => {
  load('v5-demo.json');
  A.toggleMute('slot-03');
  assert.equal(slotById(store.project, 'slot-03').mute, true);
  A.toggleSolo('slot-02');
  assert.equal(slotById(store.project, 'slot-02').solo, true);
  A.undo(); A.undo();
  assert.equal(slotById(store.project, 'slot-03').mute, false);
  assert.equal(slotById(store.project, 'slot-02').solo, false);
  A.redo();
  assert.equal(slotById(store.project, 'slot-03').mute, true);
});

test('snapshots save and recall every slot of the current scene, with macros', () => {
  load('v5-demo.json');
  const p = store.project; p.scene = 1;
  const before = p.slots.map(s => structuredClone(patternAt(p, s.id, 1)));
  A.snapshotSave(1);
  assert.deepEqual(Object.keys(p.snaps[1].slots), ['slot-01', 'slot-02', 'slot-03', 'slot-04', 'slot-05'], 'the MUNCH placeholder is kept in snapshots too');
  A.selectSlot('slot-03'); A.clearPattern();
  slotById(p, 'slot-02').macros.character = 1;
  assert.equal(pat('slot-03').notes.length, 0);
  A.snapshotRecall(1);
  assert.deepEqual(p.slots.map(s => patternAt(p, s.id, 1)), before);
  assert.equal(slotById(p, 'slot-02').macros.character, .5);
  A.undo();
  assert.equal(pat('slot-03').notes.length, 0, 'recall is undoable');
});

test('migrated v0.5 snapshots recall into the right instruments', () => {
  load('v5-edge.json');
  const p = store.project, v5 = fx('v5-edge.json');
  p.scene = 3;
  A.snapshotRecall(2);
  ['drums', 'bass', 'synth', 'fuzz'].forEach((t, k) => assert.deepEqual(patternAt(p, `slot-0${k + 1}`, 3), v5.snaps[2].tracks[k], t));
});

test('scene copy/clear and arrangement edits keep stable scene references', () => {
  load('v5-demo.json');
  const p = store.project;
  A.copyScene(1, 4);
  p.slots.forEach(s => assert.deepEqual(patternAt(p, s.id, 4), patternAt(p, s.id, 1)));
  assert.deepEqual(p.scenes[4].harmony, p.scenes[1].harmony);
  A.clearScene(4);
  assert.equal(patternAt(p, 'slot-01', 4).len, 16); assert.equal(patternAt(p, 'slot-02', 4).len, 32);
  A.addToSong(5);
  const b = p.arrangement[p.arrangement.length - 1];
  assert.equal(b.sceneId, 'scene-06');
  A.duplicateBlock(b.id);
  assert.equal(p.arrangement[p.arrangement.length - 1].sceneId, 'scene-06');
  assert.notEqual(p.arrangement[p.arrangement.length - 1].id, b.id);
  A.setBlockScene(b.id, 2);
  assert.equal(sceneIndexOf(p, b.sceneId), 2);
  A.setReps(b.id, 3);
  assert.equal(b.reps, 3);
});

test('pattern edits on the selected slot: length, double, clear keeps locks', () => {
  load('v5-edge.json');
  const p = store.project; p.scene = 4;
  A.selectSlot('slot-02');
  assert.equal(pat().len, 64);
  A.setLength(32);
  assert.ok(pat().notes.every(n => n.s < 32));
  A.doubleLength();
  assert.equal(pat().len, 64);
  A.clearPattern();
  assert.ok(pat().notes.length > 0 && pat().notes.every(n => n.locked));
  A.selectSlot('slot-01'); A.clearPattern();
  assert.ok(pat().steps.kick.some(Boolean), 'locked drum rows survive Clear');
  assert.ok(!pat().steps.snare.some(Boolean));
});

test('swing and the drum Movement shaper stay coupled', () => {
  load('v5-demo.json');
  A.setSwing(.3);
  assert.equal(slotById(store.project, 'slot-01').macros.movement, .6);
  A.setMacro('slot-01', 'movement', .2);
  assert.equal(store.project.swing, .1);
});

test('autosave writes v6 and the saved song re-imports identically', () => {
  load('v5-edge.json');
  A.toggleMute('slot-04');
  A.save(true);
  const back = A.library.load(store.project.id);
  assert.equal(back.v, 6);
  assert.deepEqual(back, importProject(JSON.parse(JSON.stringify(store.project))));
  assert.equal(slotById(back, 'slot-04').mute, true);
});

test('per-slot volume edits coalesce per drag, undo/redo, emit params and persist without changing selection', () => {
  load('v5-demo.json');
  const startVol = slotById(store.project, 'slot-02').params.vol;
  // continuous drag coalesces into one undo step without selecting slot-02
  A.setParam('slot-02', 'vol', 0.4);
  A.setParam('slot-02', 'vol', 0.25);
  A.sealHistory();
  assert.equal(store.ui.sel, 'slot-01');
  assert.equal(slotById(store.project, 'slot-02').params.vol, 0.25);
  // a second gesture after sealHistory is its own undo step
  A.setParam('slot-02', 'vol', 0.9);
  A.sealHistory();
  assert.equal(slotById(store.project, 'slot-02').params.vol, 0.9);
  A.undo();
  assert.equal(slotById(store.project, 'slot-02').params.vol, 0.25);
  A.undo();
  assert.equal(slotById(store.project, 'slot-02').params.vol, startVol);
  A.redo();
  assert.equal(slotById(store.project, 'slot-02').params.vol, 0.25);
  A.save(true);
  const reloaded = A.library.load(store.project.id);
  assert.equal(slotById(reloaded, 'slot-02').params.vol, 0.25);
});
