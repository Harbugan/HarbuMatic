// MUNCH Phase 4 actions in Node (no DOM, no audio): navigation into the SOUND workspace, slice editing with note
// remapping and undo/redo, Fit to Beat, MAGIC CHOP keep/undo/regenerate, CHOP ↔ JAM pattern identity, scenes,
// save/reload and duplication.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../src/app/actions.js';
import { store, pat } from '../src/app/store.js';
import { setPreviewInstruments } from '../src/core/instruments.js';
import { createDemoProject, slotById, patternAt, importProject } from '../src/core/project.js';
import { defaultSlices, sliceCount, fitInfo } from '../src/core/samples.js';

const M = 'slot-05', ID = 'smp-' + 'cd'.repeat(32);
function fresh({ duration = 2 } = {}) {
  setPreviewInstruments(true);
  store.project = createDemoProject(); store.project.scene = 0;
  slotById(store.project, M).sample = { id: ID, name: 'break.wav', duration, sampleRate: 44100, channels: 2, slices: defaultSlices(8) };
  Object.assign(store.ui, { sel: 'slot-01', mode: 'jam', expanded: false });
  Object.assign(store.ui.munchNav, { away: false, autoFrom: null });
  Object.assign(store.ui.munch, { sel: 0, marker: null, magic: null, style: 'straight' });
  A.history.clear();
}
const notesOf = (sc = store.project.scene) => patternAt(store.project, M, sc).notes;
const slicesIn = sc => notesOf(sc).filter(n => n.slice != null).map(n => `${n.s}:${n.slice}`).join();

test.after(() => setPreviewInstruments(false));

test('selecting MUNCH opens its SOUND workspace; leaving returns to where it came from', () => {
  fresh();
  A.selectSlot(M);
  assert.equal(store.ui.mode, 'sound');
  A.selectSlot('slot-02');
  assert.equal(store.ui.mode, 'jam', 'back to JAM: MUNCH had opened SOUND by itself');
  A.setMode('arrange'); A.selectSlot(M);
  assert.equal(store.ui.mode, 'sound');
  A.selectSlot('slot-03');
  assert.equal(store.ui.mode, 'arrange');
});

test('explicit navigation away from SOUND is respected until the player returns to SOUND', () => {
  fresh();
  A.selectSlot(M); A.setMode('jam');
  assert.equal(store.ui.mode, 'jam');
  A.selectSlot('slot-01'); A.selectSlot(M);
  assert.equal(store.ui.mode, 'jam', 'not forced again');
  A.setExpanded(true); A.selectSlot('slot-02'); A.selectSlot(M);
  assert.equal(store.ui.mode, 'jam', 'Deep edit counts as choosing JAM');
  A.setMode('sound'); // re-armed
  A.selectSlot('slot-01');
  assert.equal(store.ui.mode, 'sound', 'the player chose SOUND: selecting BOP keeps it');
  A.setMode('jam'); A.selectSlot(M);
  assert.equal(store.ui.mode, 'sound', 'chosen SOUND for MUNCH earlier: it opens again');
});

test('the four classic instruments never change the mode', () => {
  fresh();
  for (const m of ['jam', 'sound', 'arrange']) {
    A.setMode(m);
    for (const id of ['slot-02', 'slot-03', 'slot-04', 'slot-01']) { A.selectSlot(id); assert.equal(store.ui.mode, m, `${id} in ${m}`); }
  }
});

test('without the preview MUNCH cannot be selected and nothing moves', () => {
  fresh(); setPreviewInstruments(false);
  A.selectSlot(M);
  assert.equal(store.ui.sel, 'slot-01'); assert.equal(store.ui.mode, 'jam');
  setPreviewInstruments(true);
});

test('CHOP HERE, split and delete remap the groove in every scene; undo/redo restore boundaries and notes', () => {
  fresh(); A.selectSlot(M);
  store.project.scene = 0;
  [0, 1, 2, 3, 4, 5, 6, 7].forEach(k => A.toggleSliceStep(k, k * 2));
  store.project.scene = 1;
  A.toggleSliceStep(6, 3);
  store.project.scene = 0;
  const before = { slices: JSON.stringify(slotById(store.project, M).sample.slices), a: slicesIn(0), b: slicesIn(1) };
  const r = A.chopAt(.3);
  assert.equal(r.count, 9); assert.equal(store.ui.munch.sel, 3, 'the new slice is selected');
  assert.equal(slicesIn(0), '0:0,2:1,4:2,6:4,8:5,10:6,12:7,14:8');
  assert.equal(slicesIn(1), '3:7', 'other scenes follow');
  A.splitSliceAt(0);
  assert.equal(sliceCount(slotById(store.project, M).sample.slices), 10);
  assert.equal(slicesIn(0), '0:0,2:2,4:3,6:5,8:6,10:7,12:8,14:9');
  A.deleteBoundary(1); // merge the split back
  assert.equal(slicesIn(0), '0:0,2:1,4:2,6:4,8:5,10:6,12:7,14:8');
  A.undo(); A.undo(); A.undo();
  assert.equal(JSON.stringify(slotById(store.project, M).sample.slices), before.slices);
  assert.equal(slicesIn(0), before.a); assert.equal(slicesIn(1), before.b);
  A.redo();
  assert.equal(sliceCount(slotById(store.project, M).sample.slices), 9);
  assert.equal(slicesIn(0), '0:0,2:1,4:2,6:4,8:5,10:6,12:7,14:8');
});

test('dragging a boundary keeps slice identity and coalesces into one undo step; refusals give a message', () => {
  fresh(); A.selectSlot(M);
  A.toggleSliceStep(3, 0);
  const n0 = A.history.size;
  for (const x of [.36, .37, .38]) A.moveSlice(3, x);
  A.sealHistory();
  assert.equal(A.history.size, n0 + 1);
  assert.equal(slotById(store.project, M).sample.slices[3], .38); assert.equal(slicesIn(0).split(',')[0], '0:3');
  assert.equal(A.deleteBoundary(0), null, 'the outer marker cannot be deleted');
  assert.equal(A.chopAt(.38), null, 'on top of a marker');
  store.ui.munch.marker = 3; A.nudgeBoundary(1);
  assert.ok(slotById(store.project, M).sample.slices[3] > .38);
  for (let i = 0; i < 8; i++) A.chopAt(.02 + i * .113);
  assert.equal(sliceCount(slotById(store.project, M).sample.slices), 16);
  assert.equal(A.chopAt(.999), null, 'no 17th slice');
});

test('reset to eight equal slices moves notes to where their attack is', () => {
  fresh(); A.selectSlot(M);
  slotById(store.project, M).sample.slices = defaultSlices(16);
  A.toggleSliceStep(15, 0); A.toggleSliceStep(4, 1);
  A.resetSlices(8);
  assert.equal(slicesIn(0), '0:7,1:2');
  A.undo();
  assert.equal(slicesIn(0), '0:15,1:4');
});

test('Fit to Beat: separate from tuning, refuses unusable speeds, follows the tempo', () => {
  fresh({ duration: 2 }); A.selectSlot(M);
  slotById(store.project, M).params.tune = 3;
  store.project.bpm = 120;
  assert.equal(A.setFit('1'), true);
  assert.equal(slotById(store.project, M).params.fit, '1'); assert.equal(slotById(store.project, M).params.tune, 3);
  assert.ok(Math.abs(A.fitState().rate - 1) < 1e-9);
  A.setBpm(100);
  assert.ok(Math.abs(A.fitState().rate - 2 / 2.4) < 1e-9, 'BPM change re-fits');
  assert.equal(A.setFit('4'), false, '2 s → 4 bars would be ×0.21');
  assert.equal(slotById(store.project, M).params.fit, '1', 'refusal leaves it as it was');
  A.setFit('off');
  assert.equal(fitInfo(slotById(store.project, M).params, 2, 100).rate, 1);
  A.undo();
  assert.equal(slotById(store.project, M).params.fit, '1');
});

test('MAGIC CHOP: one undo step, regenerate keeps the original, Undo returns to it, locks survive', () => {
  fresh(); A.selectSlot(M); store.project.scene = 3; // an empty scene
  A.toggleSliceStep(2, 5); A.toggleSliceLock(2, 5);
  notesOf().push({ s: 9, p: 64, l: 2, v: .8 });
  const mine = JSON.stringify(pat(M));
  const r1 = A.magicChop('syncopated', { seed: 3, play: false });
  assert.ok(r1.info.notes > 4);
  assert.ok(notesOf().some(n => n.s === 5 && n.slice === 2 && n.locked) && !notesOf().some(n => n.s === 5 && !n.locked), 'locked step kept alone');
  assert.ok(notesOf().some(n => n.s === 9 && n.p === 64), 'melodic note kept');
  const first = JSON.stringify(pat(M));
  A.magicChop('syncopated', { seed: 99, play: false });
  assert.equal(store.ui.munch.magic.before, mine, 'regenerate remembers the pattern from before the first MAGIC CHOP');
  assert.equal(A.magicUndo(), true);
  assert.equal(JSON.stringify(pat(M)), mine);
  A.undo();
  assert.notEqual(JSON.stringify(pat(M)), mine, 'Undo of the undo brings the groove back');
  A.undo();
  assert.equal(JSON.stringify(pat(M)), first, 'history steps through each generation');
  A.magicChop('halftime', { seed: 1, play: false }); A.magicKeep();
  assert.equal(store.ui.munch.magic, null);
  A.toggleSliceStep(0, 0);
  assert.equal(A.magicUndo(), false, 'nothing pending after Keep');
});

test('CHOP and JAM edit one pattern: no second state', () => {
  fresh(); A.selectSlot(M); store.project.scene = 4;
  A.toggleSliceStep(1, 4);
  assert.equal(pat(M), patternAt(store.project, M, 4), 'the sequencer edits the same object JAM draws');
  pat(M).notes.push({ s: 6, p: 60, l: 1, v: .8, slice: 2 }); A.patternEdited(); // as the piano roll would
  assert.equal(slicesIn(4), '4:1,6:2');
  A.cycleSliceVel(2, 6);
  assert.equal(notesOf(4).find(n => n.s === 6).v, 1, 'accent keeps timing');
  A.toggleSliceStep(1, 4);
  assert.equal(slicesIn(4), '6:2');
});

test('scene switching keeps slice patterns per scene; save, reload and duplicate keep slices, fit and notes', () => {
  fresh(); A.selectSlot(M);
  store.project.scene = 0; A.toggleSliceStep(0, 0);
  A.selectScene(2); A.toggleSliceStep(5, 8);
  A.chopAt(.55); A.setFit('1');
  A.selectScene(0);
  assert.equal(slicesIn(0), '0:0'); assert.equal(slicesIn(2), '8:6', 'the chop before slice 5 renumbered it to 6');
  A.save(true);
  const back = A.library.load(store.project.id);
  assert.deepEqual(slotById(back, M), slotById(store.project, M));
  const again = importProject(JSON.parse(JSON.stringify(store.project)));
  assert.deepEqual(slotById(again, M), slotById(store.project, M), 'export/import round trip');
  const id = store.project.id; A.duplicateProject();
  assert.notEqual(store.project.id, id);
  assert.equal(slotById(store.project, M).params.fit, '1'); assert.equal(sliceCount(slotById(store.project, M).sample.slices), 9);
  assert.equal(slicesIn(2), '8:6');
});

test('a missing sample: actions that need audio refuse politely, nothing throws', () => {
  fresh(); A.selectSlot(M);
  slotById(store.project, M).sample = null;
  assert.equal(A.chopAt(.5), null); assert.equal(A.setFit('1'), false); assert.equal(A.magicChop('straight', { play: false }), null);
  assert.equal(A.fitState(), null);
  A.toggleSliceStep(0, 0);
  assert.equal(slicesIn(0).length > 0, true, 'the groove can still be edited (it plays once the sound is back)');
});
