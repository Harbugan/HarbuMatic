// HarbuMatic v0.7 PR1: RUFF Instrument Foundation tests.
// Covers registry definition, 6-slot default, A/B/C break pattern foundation, non-playing safety
// (engine/scheduler/solo/maxLen), UI selection + 5-visible strip paging, scene ops + Undo/Redo,
// persistence + .hbn round-trip, and 5-instrument project regression safety.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getInstrumentType, hasInstrumentType, isPlayableType, isSelectableType, listInstrumentTypes,
  DEFAULT_SLOT_TYPES, BREAK_LANES, createPatternFor, patternKindIsEmpty,
} from '../src/core/instruments.js';
import {
  createEmptyProject, createDemoProject, importProject, validateProject,
  slotById, playableSlots, selectableSlots, patternAt, setPatternAt,
  anySolo, maxLen, sceneHasContent, slotAudible,
} from '../src/core/project.js';
import { createLibrary, memoryStorage } from '../src/core/persistence.js';
import { exportPackage, parsePackage, restorePackage } from '../src/core/package.js';
import { createSampleStore, memoryBackend } from '../src/samples/store.js';
import { createTransport } from '../src/audio/scheduler.js';
import { store, visibleSlots, isBreakSlot, isPlaceholderSlot, MAX_VISIBLE_CARDS } from '../src/app/store.js';
import * as A from '../src/app/actions.js';

const cloneJson = obj => JSON.parse(JSON.stringify(obj));

test('RUFF registry definition is registered, immutable, selectable and playable', () => {
  assert.equal(hasInstrumentType('ruff'), true);
  const r = getInstrumentType('ruff');
  assert.equal(r.type, 'ruff');
  assert.equal(r.name, 'RUFF');
  assert.equal(r.status, 'ready');
  assert.equal(r.engine, 'ruff');
  assert.equal(r.pattern, 'break');
  assert.equal(r.defaultLength, 16);
  assert.equal(r.capabilities.breaks, true);
  assert.equal(r.capabilities.generate, false);
  assert.equal(isPlayableType('ruff'), true, 'RUFF is playable with the ruff voice factory');
  assert.equal(isSelectableType('ruff'), true);
  assert.equal(listInstrumentTypes().some(t => t.type === 'ruff'), true);
  assert.equal(listInstrumentTypes({ includePlanned: true }).some(t => t.type === 'ruff'), true);
  assert.deepEqual(BREAK_LANES, ['a', 'b', 'c']);
  assert.deepEqual(DEFAULT_SLOT_TYPES, ['bop', 'goo', 'blip', 'fuzz', 'munch', 'ruff']);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.defaultParams));
});

test('new songs establish six playable slots with independent per-scene A/B/C break patterns', () => {
  for (const p of [createEmptyProject(), createDemoProject()]) {
    assert.deepEqual(p.slots.map(s => `${s.id}:${s.type}`), [
      'slot-01:bop', 'slot-02:goo', 'slot-03:blip', 'slot-04:fuzz', 'slot-05:munch', 'slot-06:ruff',
    ]);
    assert.equal(playableSlots(p).length, 6);
    assert.equal(selectableSlots(p).length, 6);
    const ruff = slotById(p, 'slot-06');
    assert.deepEqual(ruff.breaks, { a: null, b: null, c: null });
    for (const sc of p.scenes) {
      const pt = ruff.patterns[sc.id];
      assert.equal(pt.len, 16);
      assert.deepEqual(Object.keys(pt.lanes), ['a', 'b', 'c']);
      assert.equal(pt.lanes.a.length, 16);
      assert.equal(patternKindIsEmpty('break', pt), true);
    }
  }
});

test('A/B/C break pattern validation cleans cells, locks and source references cleanly', () => {
  const p = createEmptyProject();
  const ruff = slotById(p, 'slot-06');
  ruff.breaks = { a: 'amen-orig-01', b: '  think-orig-02  ', c: '' };
  const pat = createPatternFor('ruff');
  pat.lanes.a[0] = { slice: 0, v: .9, p: 1 };
  pat.lanes.b[4] = { slice: 3, v: .75, p: .8, rev: true, locked: true, o: .12 };
  pat.lanes.c[8] = { slice: 99, v: 5, p: -1 }; // out-of-range slice dropped, v/p clamped
  pat.locked.a = true;
  pat.locked['4'] = true;
  pat.locked.bogus = true;
  setPatternAt(p, 'slot-06', 0, pat);

  const v = validateProject(cloneJson(p));
  const vr = slotById(v, 'slot-06');
  assert.deepEqual(vr.breaks, { a: 'amen-orig-01', b: 'think-orig-02', c: null });
  const vp = patternAt(v, 'slot-06', 0);
  assert.equal(patternKindIsEmpty('break', vp), false);
  assert.deepEqual(vp.lanes.a[0], { v: .9, p: 1, slice: 0 });
  assert.deepEqual(vp.lanes.b[4], { v: .75, p: .8, slice: 3, o: .12, rev: true, locked: true });
  assert.deepEqual(vp.lanes.c[8], { v: 1, p: .05 });
  assert.deepEqual(vp.locked, { a: true, 4: true });
});

test('empty RUFF never fires spurious triggers, while soloing RUFF silences other slots', () => {
  const p = createEmptyProject();
  const ruff = slotById(p, 'slot-06');
  assert.equal(sceneHasContent(p, 0), false, 'unassigned empty RUFF does not mark scene as having content');
  assert.equal(maxLen(p, 0), 32);

  ruff.solo = true;
  assert.equal(anySolo(p), true, 'solo on playable RUFF activates solo');
  assert.equal(slotAudible(p, slotById(p, 'slot-01')), false);
  assert.equal(slotAudible(p, ruff), true);

  // Scheduler dispatch skips RUFF when no breaks are assigned
  const calls = [];
  const ctx = { currentTime: 0 };
  const engine = {
    ctx, init: () => ctx, openGates() {}, closeGates() {}, stepDur: () => 60 / p.bpm / 4,
    audible: id => slotAudible(p, slotById(p, id)),
    trigger: (id, t, hit) => calls.push({ id, t, hit }),
  };
  let tick;
  const si = globalThis.setInterval, ci = globalThis.clearInterval;
  globalThis.setInterval = fn => { tick = fn; return 1; }; globalThis.clearInterval = () => {};
  try {
    const tr = createTransport(engine, () => p, {});
    tr.play();
    for (let i = 0; i < 32; i++) { ctx.currentTime += .05; tick(); }
    tr.stop();
  } finally { globalThis.setInterval = si; globalThis.clearInterval = ci; }
  assert.equal(calls.some(c => c.id === 'slot-06'), false, 'unassigned RUFF triggers nothing');
});

test('RUFF selection, 5-visible strip paging, volume/mute/solo and guarded actions stay valid', () => {
  store.project = createEmptyProject();
  store.ui.sel = 'slot-01';
  store.ui.stripOffset = 0;
  A.history.clear();

  assert.equal(visibleSlots().length, 6);
  assert.equal(MAX_VISIBLE_CARDS, 5);

  // Paging the 5-visible strip window
  A.shiftStrip(1);
  assert.equal(store.ui.stripOffset, 1);
  A.shiftStrip(1);
  assert.equal(store.ui.stripOffset, 1, 'clamped to slots.length - 5');
  A.shiftStrip(-5);
  assert.equal(store.ui.stripOffset, 0, 'clamped to 0');

  // Selecting RUFF auto-shifts strip window to bring slot-06 into view
  A.selectSlot('slot-06');
  assert.equal(store.ui.sel, 'slot-06');
  assert.equal(store.ui.stripOffset, 1);
  assert.equal(isBreakSlot(), true);
  assert.equal(isPlaceholderSlot(), false);

  // Volume, mute and solo persist cleanly
  A.setParam('slot-06', 'vol', .65);
  assert.equal(slotById(store.project, 'slot-06').params.vol, .65);
  A.toggleMute('slot-06');
  assert.equal(slotById(store.project, 'slot-06').mute, true);
  A.toggleSolo('slot-06');
  assert.equal(slotById(store.project, 'slot-06').solo, true, 'toggleSolo works for playable RUFF');

  // Pattern-level toolbar guards do not crash on RUFF
  assert.doesNotThrow(() => A.setLength(32));
  assert.equal(patternAt(store.project, 'slot-06', 0).len, 16);
  assert.doesNotThrow(() => A.doubleLength());
  assert.equal(patternAt(store.project, 'slot-06', 0).len, 16);
  assert.equal(A.runTransform('generate', 'slot-06'), null);

  // Selecting BOP brings strip window back to 0
  A.selectSlot('slot-01');
  assert.equal(store.ui.sel, 'slot-01');
  assert.equal(store.ui.stripOffset, 0);
});

test('scene creation, duplication, deletion and Undo/Redo preserve RUFF scene-local patterns', () => {
  store.project = createEmptyProject();
  store.ui.sel = 'slot-06';
  A.history.clear();

  const p0 = patternAt(store.project, 'slot-06', 0);
  p0.lanes.a[0] = { slice: 2, v: .9, p: 1 };

  // New Scene creates an empty independent RUFF pattern
  A.createScene({ name: 'Jungle B' });
  assert.equal(store.project.scenes.length, 2);
  assert.equal(patternKindIsEmpty('break', patternAt(store.project, 'slot-06', 1)), true);
  assert.equal(patternAt(store.project, 'slot-06', 0).lanes.a[0].slice, 2);

  // Duplicate Scene deep-copies RUFF pattern independently
  const dup = A.duplicateScene(0);
  const dupIdx = dup.index;
  assert.equal(store.project.scenes.length, 3);
  const dupPat = patternAt(store.project, 'slot-06', dupIdx);
  assert.equal(dupPat.lanes.a[0].slice, 2);
  dupPat.lanes.a[0].slice = 7;
  assert.equal(patternAt(store.project, 'slot-06', 0).lanes.a[0].slice, 2, 'source scene untouched');

  // Delete Scene + Undo/Redo
  A.deleteScene(dupIdx);
  assert.equal(store.project.scenes.length, 2);
  A.undo();
  assert.equal(store.project.scenes.length, 3);
  assert.equal(patternAt(store.project, 'slot-06', dupIdx).lanes.a[0].slice, 7);
  A.redo();
  assert.equal(store.project.scenes.length, 2);
});

test('save/reopen and .hbn package round-trip preserve all six slots including RUFF', async () => {
  const p = createEmptyProject({ name: 'Ruff Jungle Test' });
  const ruff = slotById(p, 'slot-06');
  ruff.params.vol = .62;
  ruff.mute = true;
  ruff.breaks.a = 'builtin-jungle-01';
  ruff.patterns['scene-01'].lanes.a[2] = { slice: 1, v: .85, p: 1, rev: true };
  ruff.patterns['scene-01'].locked['2'] = true;

  // Library save/reopen
  const st = memoryStorage();
  const lib = createLibrary(st);
  assert.equal(lib.save(p), true);
  const reopened = createLibrary(st).load(p.id);
  assert.deepEqual(reopened, p);

  // Portable .hbn export/import round-trip
  const sampleStore = createSampleStore({ backend: memoryBackend() });
  const pkg = await exportPackage(p, { sampleStore });
  const parsed = await parsePackage(pkg.bytes);
  const restored = await restorePackage(parsed, { sampleStore });
  assert.deepEqual(restored.project, p);
});

test('existing five-instrument projects open without silent changes or regressions', () => {
  const five = createEmptyProject({ name: 'Legacy Five' });
  five.slots = five.slots.filter(s => s.type !== 'ruff');
  five.slots[0].patterns['scene-01'].steps.kick[0] = { v: .9, p: 1 };
  const snapshot = cloneJson(five);

  const imported = importProject(cloneJson(five));
  assert.deepEqual(imported, snapshot, 'five-slot project is preserved byte-for-byte with no silent RUFF injection');
  assert.equal(imported.slots.length, 5);
  assert.equal(playableSlots(imported).length, 5);
  assert.equal(selectableSlots(imported).length, 5);
});
