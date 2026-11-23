// MUNCH Phase 4 core: slice edits with deterministic note remapping, tape-fit maths, new params, unknown-key
// preservation and loading Phase 3 songs unchanged. Pure functions, run in Node.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultSlices, insertSliceBoundary, splitSlice, removeSliceBoundary, moveSliceBoundary, remapSliceIndexes,
  remapSlotSlices, sliceAt, sliceCount, sliceRegion, fitInfo, fitRate, notePlaybackRate, fitChoicesOk, barsSeconds,
  sliceHomeSteps, rateForSemitones, MAX_SLICES, FIT_RANGE, extraKeys,
} from '../src/core/samples.js';
import { createEmptyProject, importProject, validateProject, slotById, sceneIdAt } from '../src/core/project.js';
import { defaultParamsFor } from '../src/core/instruments.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const ID = 'smp-' + 'ab'.repeat(32);
const M = 'slot-05';

/** a song with a 2 s sample on MUNCH and slice notes in two scenes and a snapshot */
function song() {
  const p = createEmptyProject();
  const m = slotById(p, M);
  m.sample = { id: ID, name: 'break.wav', duration: 2, sampleRate: 44100, channels: 2, slices: defaultSlices(8) };
  m.patterns[sceneIdAt(p, 0)].notes = [0, 1, 2, 3, 4, 5, 6, 7].map(k => ({ s: k * 2, p: 60, l: 1, v: .8, slice: k }));
  m.patterns[sceneIdAt(p, 1)].notes = [{ s: 0, p: 64, l: 2, v: .7 }, { s: 4, p: 62, l: 1, v: .9, slice: 5, locked: true }];
  p.snaps[2] = { slots: { [M]: { type: 'munch', pattern: { len: 16, notes: [{ s: 3, p: 60, l: 1, v: .8, slice: 7 }] }, macros: { brightness: .5, movement: .5, space: .5, character: .5 } } } };
  return p;
}
const slicesOf = (p, sc = 0) => slotById(p, M).patterns[sceneIdAt(p, sc)].notes.map(n => n.slice ?? `p${n.p}`);

test('insert a boundary: new index returned, list stays sorted, limits refused', () => {
  const r = insertSliceBoundary(defaultSlices(8), .3);
  assert.equal(r.at, 3); assert.equal(sliceCount(r.slices), 9);
  assert.deepEqual(r.slices.slice(2, 5), [.25, .3, .375]);
  assert.equal(insertSliceBoundary(defaultSlices(8), .25).error, 'close', 'on an existing boundary');
  assert.equal(insertSliceBoundary(defaultSlices(8), 1.2).error, 'range');
  assert.equal(insertSliceBoundary(defaultSlices(16), .51).error, 'max');
  assert.equal(sliceCount(insertSliceBoundary(defaultSlices(15), .51).slices), 16);
});

test('split and delete boundaries', () => {
  const s = splitSlice(defaultSlices(8), 2);
  assert.equal(s.at, 3); assert.deepEqual(sliceRegion(s.slices, 2), [.25, .3125]); assert.deepEqual(sliceRegion(s.slices, 3), [.3125, .375]);
  assert.equal(splitSlice(defaultSlices(8), 9).error, 'none');
  const d = removeSliceBoundary(defaultSlices(8), 3);
  assert.equal(sliceCount(d.slices), 7); assert.deepEqual(sliceRegion(d.slices, 2), [.25, .5]);
  assert.equal(removeSliceBoundary(defaultSlices(8), 0).error, 'edge', 'outer boundaries are moved, not deleted');
  assert.equal(removeSliceBoundary(defaultSlices(8), 8).error, 'edge');
  assert.equal(removeSliceBoundary([0, 1], 1).error, 'edge');
});

test('remap rule: the new slice that contains the old slice start', () => {
  const a = defaultSlices(8);
  const ins = insertSliceBoundary(a, .3).slices; // inside slice 2
  assert.deepEqual(remapSliceIndexes(a, ins).slice(0, 8), [0, 1, 2, 4, 5, 6, 7, 8]);
  const del = removeSliceBoundary(a, 3).slices; // merge 2 + 3
  assert.deepEqual(remapSliceIndexes(a, del).slice(0, 8), [0, 1, 2, 2, 3, 4, 5, 6]);
  const before = insertSliceBoundary([.2, .6, 1], .1).slices; // before the sliced area: a new first slice
  assert.deepEqual(remapSliceIndexes([.2, .6, 1], before).slice(0, 2), [1, 2]);
  const r = remapSliceIndexes(defaultSlices(12), defaultSlices(8));
  assert.deepEqual(r.slice(0, 12), [0, 0, 1, 2, 2, 3, 4, 4, 5, 6, 6, 7], 'reset maps each slice to where its attack now is');
  assert.ok(remapSliceIndexes(a, ins).slice(0, 8).every(k => k < 9));
  assert.equal(remapSliceIndexes(a, ins)[10], 11, 'an index the old list did not have stays past the end (silent)');
  assert.equal(sliceAt(a, 0), 0); assert.equal(sliceAt(a, .999), 7); assert.equal(sliceAt(a, .5), 4);
});

test('moving a boundary keeps every slice index', () => {
  const p = song(), m = slotById(p, M), old = m.sample.slices;
  m.sample.slices = moveSliceBoundary(old, 3, .33);
  assert.equal(sliceCount(m.sample.slices), 8);
  assert.deepEqual(slicesOf(p), [0, 1, 2, 3, 4, 5, 6, 7], 'notes are untouched by a move');
});

test('remapSlotSlices rewrites every scene and snapshot of the slot, never melodic notes or other slots', () => {
  const p = song(), m = slotById(p, M), old = m.sample.slices;
  const blip = JSON.stringify(slotById(p, 'slot-03'));
  const r = insertSliceBoundary(old, .3); m.sample.slices = r.slices;
  const n = remapSlotSlices(p, M, old, r.slices);
  assert.equal(n, 5 + 1 + 1, 'five notes in A, one in B, one in the snapshot');
  assert.deepEqual(slicesOf(p, 0), [0, 1, 2, 4, 5, 6, 7, 8]);
  assert.deepEqual(slicesOf(p, 1), ['p64', 6]);
  assert.equal(slotById(p, M).patterns[sceneIdAt(p, 1)].notes[1].locked, true, 'note fields survive');
  assert.equal(p.snaps[2].slots[M].pattern.notes[0].slice, 8);
  assert.equal(JSON.stringify(slotById(p, 'slot-03')), blip);
  // every remapped note still plays the audio its attack was in
  const notes = slotById(p, M).patterns[sceneIdAt(p, 0)].notes;
  notes.forEach((nt, i) => assert.equal(r.slices[nt.slice], old[i], `slice ${i} keeps its start`));
});

test('delete then undo-by-inverse restores identity; reset is deterministic', () => {
  const p = song(), m = slotById(p, M), old = m.sample.slices;
  const d = removeSliceBoundary(old, 4).slices; remapSlotSlices(p, M, old, d); m.sample.slices = d;
  assert.deepEqual(slicesOf(p), [0, 1, 2, 3, 3, 4, 5, 6]);
  const q = song(), mq = slotById(q, M), o2 = mq.sample.slices;
  const twelve = defaultSlices(12); remapSlotSlices(q, M, o2, twelve);
  const q2 = song(); remapSlotSlices(q2, M, slotById(q2, M).sample.slices, twelve);
  assert.deepEqual(slicesOf(q), slicesOf(q2), 'same edit, same result');
});

test('tape fit: source is the trimmed region, target is bars at the project tempo', () => {
  const p = { ...defaultParamsFor('munch'), fit: '2' };
  const f = fitInfo(p, 4, 120); // 4 s sample, 2 bars @120 = 4 s
  assert.ok(f.on && near(f.ratio, 1) && near(f.rate, 1) && f.ok);
  assert.ok(near(barsSeconds(1, 120), 2) && near(barsSeconds(.5, 90), 4 / 3));
  const trimmed = fitInfo({ ...p, start: .25, end: .75 }, 4, 120); // 2 s region → 4 s
  assert.ok(near(trimmed.source, 2) && near(trimmed.rate, .5), 'the trimmed region, not the whole file');
  assert.ok(near(fitInfo({ ...p, fit: '1' }, 2.5, 120).rate, 1.25));
  assert.ok(near(fitInfo({ ...p, fit: 'half' }, 1, 120).rate, 1));
  assert.ok(near(fitInfo({ ...p, fit: '4' }, 8, 120).rate, 1));
  assert.ok(near(fitInfo({ ...p, fitFine: .1 }, 4, 120).rate, 1.1), 'fine adjustment scales the fit');
  assert.equal(fitInfo({ ...p, fit: 'off' }, 4, 120).rate, 1);
  assert.equal(fitInfo(defaultParamsFor('munch'), 4, 120).on, false, 'off by default');
});

test('tape fit follows BPM changes and reports out-of-range requests', () => {
  const p = { ...defaultParamsFor('munch'), fit: '1' };
  const slow = fitRate(p, 2, 100), fast = fitRate(p, 2, 150);
  assert.ok(near(slow, 2 / 2.4) && near(fast, 2 / 1.6), 'rate is computed from the current BPM');
  const tooFast = fitInfo({ ...p, fit: '4' }, 1, 120); // 1 s → 8 s would be ×0.125
  assert.equal(tooFast.ok, false); assert.equal(tooFast.rate, FIT_RANGE[0]); assert.ok(near(tooFast.ratio, .125));
  const tooSlow = fitInfo({ ...p, fit: 'half' }, 6, 120); // 6 s → 1 s = ×6
  assert.equal(tooSlow.ok, false); assert.equal(tooSlow.rate, FIT_RANGE[1]);
  const ok = fitChoicesOk(p, 1.9, 120);
  assert.deepEqual(ok, { off: true, half: true, 1: true, 2: false, 4: false }, '1.9 s: 2 bars would need ×0.475');
});

test('pitch stays explicit: transpose × tune × fit, root and tune untouched by fit', () => {
  const base = { ...defaultParamsFor('munch'), root: 57, tune: 2 };
  const fitted = { ...base, fit: '1', fitMode: 'tape' };
  const mel = { p: 69 }, sl = { p: 60, slice: 3 };
  // melodic: (69 − 57 + 2) st; slice: (60 − 60 + 2) st
  assert.ok(near(notePlaybackRate(mel, base, 2, 120), rateForSemitones(14)));
  assert.ok(near(notePlaybackRate(sl, base, 2, 120), rateForSemitones(2)));
  assert.ok(near(notePlaybackRate(mel, fitted, 2.5, 120), rateForSemitones(14) * 1.25), 'fit multiplies, it does not replace');
  assert.ok(near(notePlaybackRate(sl, fitted, 2.5, 120), rateForSemitones(2) * 1.25), 'slices share the same tape speed');
  assert.equal(fitted.root, 57); assert.equal(fitted.tune, 2);
  // stretch (the default): the fit changes the duration only; the pitch is transpose + tune alone
  const stretched = { ...base, fit: '1' };
  assert.ok(near(notePlaybackRate(mel, stretched, 2.5, 120), rateForSemitones(14)), 'stretch keeps the pitch');
  assert.ok(near(notePlaybackRate(sl, stretched, 2.5, 120), rateForSemitones(2)));
});

test('slice home steps follow tempo and tape speed', () => {
  const home = sliceHomeSteps(defaultSlices(8), 4, 1, 120); // 2 bars @120 = 32 steps
  assert.deepEqual(home.map(Math.round), [0, 4, 8, 12, 16, 20, 24, 28]);
  assert.deepEqual(sliceHomeSteps(defaultSlices(4), 2, 2, 120).map(Math.round), [0, 2, 4, 6]);
  assert.deepEqual(sliceHomeSteps([.5, .75, 1], 4, 1, 120).map(Math.round), [0, 8], 'counted from the first slice');
});

test('new params: fit off, Stretch, choke on by default; all validated', () => {
  const d = defaultParamsFor('munch');
  assert.equal(d.fit, 'off'); assert.equal(d.fitFine, 0); assert.equal(d.choke, true); assert.equal(d.fitMode, 'stretch');
  const p = createEmptyProject();
  Object.assign(slotById(p, M).params, { fit: 'seven', fitFine: 3, choke: 'yes', fitMode: 'elastic' });
  const v = validateProject(JSON.parse(JSON.stringify(p)));
  const m = slotById(v, M).params;
  assert.equal(m.fit, 'off'); assert.equal(m.fitFine, .12); assert.equal(m.choke, true); assert.equal(m.fitMode, 'stretch');
  Object.assign(slotById(p, M).params, { fitMode: 'tape', choke: false });
  const t = slotById(validateProject(JSON.parse(JSON.stringify(p))), M).params;
  assert.equal(t.fitMode, 'tape'); assert.equal(t.choke, false, 'a stored choke: false is kept');
});

test('a Phase 3 song loads unchanged: slices, slice notes and params, plus the new defaults', () => {
  const p = song();
  const m = slotById(p, M);
  m.params = { vol: .7, pan: .1, root: 55, tune: -3, start: .1, end: .9, reverse: true, mode: 'gate', attack: .01, release: .2, drive: .3, driveOn: false, delayOn: true, reverbOn: false, delay: .2, reverb: .2 };
  m.sample.slices = [0, .1, .3, .31, .7, 1];
  const phase3 = JSON.parse(JSON.stringify(p));
  const back = importProject(JSON.parse(JSON.stringify(phase3)));
  const b = slotById(back, M);
  assert.deepEqual(b.sample, phase3.slots[4].sample);
  assert.deepEqual(b.patterns, phase3.slots[4].patterns);
  assert.deepEqual(b.params, { ...phase3.slots[4].params, fit: 'off', fitFine: 0, choke: true, fitMode: 'stretch' });
  assert.deepEqual(back.snaps[2], phase3.snaps[2]);
  assert.deepEqual(importProject(JSON.parse(JSON.stringify(back))), back, 'idempotent');
});

test('unknown keys from a later build are kept on MUNCH params and sample refs, not on other instruments', () => {
  const p = song();
  slotById(p, M).params.stretch = 'beats'; slotById(p, M).params.grain = .4; slotById(p, M).params.bad = { x: 1 };
  slotById(p, M).sample.sliceIds = 'later'; slotById(p, M).sample.gain = .5;
  slotById(p, 'slot-03').params.future = 1;
  const v = validateProject(JSON.parse(JSON.stringify(p)));
  assert.equal(slotById(v, M).params.stretch, 'beats'); assert.equal(slotById(v, M).params.grain, .4);
  assert.equal(slotById(v, M).params.bad, undefined, 'non-primitive values are not kept');
  assert.equal(slotById(v, M).sample.sliceIds, 'later'); assert.equal(slotById(v, M).sample.gain, .5);
  assert.equal(slotById(v, 'slot-03').params.future, undefined, 'BLIP validates exactly as in v0.5');
  assert.deepEqual(Object.keys(extraKeys({ a: 1, __proto__: { z: 1 } }, [])), ['a']);
  assert.equal(Object.keys(extraKeys(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i])), [])).length, 32);
});

test('MAX_SLICES is still 16', () => assert.equal(MAX_SLICES, 16));
