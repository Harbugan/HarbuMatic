import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createEmptyProject, createDemoProject, importProject, validateProject, ProjectError, SCHEMA_VERSION, patternIsEmpty,
  patternAt, sceneIndexOf, slotById,
} from '../src/core/project.js';
import { createLibrary, memoryStorage } from '../src/core/persistence.js';
import { createHistory } from '../src/core/history.js';
import { LEGACY_TRACKS } from '../src/core/instruments.js';

const v4 = JSON.parse(readFileSync(new URL('./fixtures/v4-demo.json', import.meta.url), 'utf8'));
const slotOf = (p, track) => p.slots[LEGACY_TRACKS.indexOf(track)];

test('new song is genuinely empty with one scene and fully playable', () => {
  const p = createEmptyProject({ name: 'Blank' });
  assert.equal(p.v, SCHEMA_VERSION);
  assert.equal(p.name, 'Blank');
  assert.deepEqual(p.arrangement, []);
  assert.equal(p.scenes.length, 1);
  assert.equal(p.scenes[0].id, 'scene-01');
  assert.deepEqual(p.slots.map(s => s.type), ['bop', 'goo', 'blip', 'fuzz', 'munch', 'ruff']);
  p.slots.forEach(s => {
    assert.deepEqual(Object.keys(s.patterns), p.scenes.map(sc => sc.id));
    Object.values(s.patterns).forEach(pt => assert.ok(patternIsEmpty(s.type, pt)));
    assert.ok(s.params.vol > 0);
  });
  assert.ok(p.bpm >= 60 && p.bpm <= 180);
});

test('v0.4 project migrates without losing content', () => {
  const p = importProject(v4);
  assert.equal(p.v, SCHEMA_VERSION);
  assert.deepEqual(p.arrangement.map(b => sceneIndexOf(p, b.sceneId)), v4.chain, 'chain → arrangement, same order');
  assert.ok(p.arrangement.every(b => b.reps === 1 && b.id));
  assert.equal(p.bpm, v4.bpm); assert.equal(p.key, v4.key); assert.equal(p.scale, v4.scale);
  LEGACY_TRACKS.forEach(t => v4.tracks[t].patterns.forEach((old, i) => {
    const neu = patternAt(p, slotOf(p, t).id, i);
    assert.equal(neu.len, old.len);
    if (t === 'drums') assert.deepEqual(neu.steps.kick.map(Boolean), old.steps.kick.map(Boolean));
    else assert.equal(neu.notes.length, old.notes.length);
  }));
  assert.deepEqual(slotOf(p, 'bass').params, { ...slotOf(p, 'bass').params, ...v4.tracks.bass.params });
  assert.equal(p.chain, undefined);
  assert.equal(p.tracks, undefined);
});

test('migration keeps slides, locks and probabilities', () => {
  const old = JSON.parse(JSON.stringify(v4));
  old.tracks.synth.patterns[1].notes[0].locked = true;
  old.tracks.drums.patterns[1].locked = { kick: true };
  const p = importProject(old);
  const at = (t, i) => patternAt(p, slotOf(p, t).id, i);
  assert.ok(at('bass', 1).notes.some(n => n.slide));
  assert.ok(at('synth', 1).notes[0].locked);
  assert.ok(at('drums', 1).locked.kick);
  assert.ok(at('drums', 1).steps.rim.some(c => c && c.p < 1));
});

test('import rejects junk and newer formats with friendly errors', () => {
  assert.throws(() => importProject(null), ProjectError);
  assert.throws(() => importProject({ hello: 1 }), /not a HarbuMatic project/);
  assert.throws(() => importProject({ v: 99, tracks: {} }), /newer HarbuMatic/);
});

test('validation repairs damaged data instead of dropping the song', () => {
  const p = createDemoProject();
  const blip = slotById(p, 'slot-03'), bop = slotById(p, 'slot-01');
  p.bpm = 9999; blip.patterns['scene-02'].notes.push({ s: 500, p: 60, l: 1, v: 1 }, { s: 2, p: 'x', l: -4, v: 7 });
  bop.patterns['scene-01'].steps.kick.length = 3; p.arrangement.push({ sceneId: 'scene-42' }, { scene: 42 });
  const fixed = validateProject(p);
  assert.equal(fixed.bpm, 200);
  assert.equal(patternAt(fixed, 'slot-01', 0).steps.kick.length, 16);
  assert.ok(patternAt(fixed, 'slot-03', 1).notes.every(n => n.s < 32 && n.l >= 1 && n.v <= 1));
  assert.ok(fixed.arrangement.every(b => sceneIndexOf(fixed, b.sceneId) >= 0));
  assert.equal(fixed.arrangement.length, 3);
  assert.equal(fixed.scenes.length, 6);
  // a damaged song with an empty scenes list repairs to one valid scene (never zero)
  const wiped = createDemoProject(); wiped.scenes = [];
  const repaired = validateProject(wiped);
  assert.equal(repaired.scenes.length, 1);
  assert.equal(repaired.scenes[0].id, 'scene-01');
  assert.ok(repaired.arrangement.every(b => b.sceneId === 'scene-01'));
});

test('exported JSON round-trips', () => {
  const p = createDemoProject();
  assert.deepEqual(importProject(JSON.parse(JSON.stringify(p))), validateProject(p));
});

test('library: saving a new song never removes the previous one', () => {
  const store = memoryStorage(), lib = createLibrary(store);
  const a = createDemoProject(); lib.save(a);
  const b = createEmptyProject({ name: 'Second' }); lib.save(b);
  assert.equal(lib.list().length, 2);
  assert.equal(lib.currentId(), b.id);
  assert.equal(lib.load(a.id).name, 'Demo jam');
  lib.remove(b.id);
  assert.equal(lib.list().length, 1);
});

test('library adopts a v0.4 autosave once and leaves the legacy key in place', () => {
  const store = memoryStorage();
  store.setItem('harbumatic.v4', JSON.stringify(v4));
  const lib = createLibrary(store);
  const p = lib.adoptLegacy();
  assert.ok(p && p.v === SCHEMA_VERSION);
  assert.equal(lib.adoptLegacy(), null, 'only once');
  assert.ok(store.getItem('harbumatic.v4'), 'legacy data untouched');
  assert.equal(lib.list().length, 1);
});

test('history: undo/redo and gesture coalescing', () => {
  let t = 0;
  const h = createHistory({ now: () => t });
  let state = 'a';
  h.checkpoint(state); state = 'b';
  h.checkpoint(state, 'knob'); state = 'c';
  t += 100; h.checkpoint(state, 'knob'); state = 'd'; // coalesced into the previous entry
  assert.equal(h.size, 2);
  state = h.undo(state); assert.equal(state, 'b');
  state = h.undo(state); assert.equal(state, 'a');
  assert.equal(h.undo(state), null);
  state = h.redo(state); assert.equal(state, 'b');
  t += 5000; h.checkpoint(state, 'knob');
  assert.equal(h.canRedo, false, 'new change clears redo');
});
