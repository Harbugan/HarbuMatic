// MUNCH Phase 3, pure parts: sample references, slice maths, pitch mapping and the project schema additions.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  defaultSlices, cleanSlices, moveSliceBoundary, sliceRegion, sliceCount, trimRegion, bufferRegion, rateForSemitones,
  noteSemitones, cleanSampleRef, sampleRefFor, sampleRefsOf, isSampleId, MIN_SLICE, MAX_SLICES, SLICE_REF_PITCH,
} from '../src/core/samples.js';
import { createEmptyProject, createDemoProject, importProject, validateProject, slotById, patternAt, setPatternAt, createSlot } from '../src/core/project.js';
import { defaultParamsFor, getInstrumentType } from '../src/core/instruments.js';

const fx = f => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const ID = 'smp-' + 'ab'.repeat(32);
const ref = (extra = {}) => ({ id: ID, name: 'break.wav', duration: 2, sampleRate: 44100, channels: 2, slices: defaultSlices(), ...extra });

/* ---------- slices ---------- */
test('default slicing is eight equal slices stored as nine normalized boundaries', () => {
  const s = defaultSlices();
  assert.deepEqual(s, [0, .125, .25, .375, .5, .625, .75, .875, 1]);
  assert.equal(sliceCount(s), 8);
  assert.deepEqual(defaultSlices(3), [0, .333333, .666667, 1]);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s, 'stable through JSON');
});

test('slice boundaries are validated: positive length, inside the sample, sorted, bounded count', () => {
  assert.deepEqual(cleanSlices([.5, 0, 1, .25]), [0, .25, .5, 1], 'sorted');
  assert.deepEqual(cleanSlices([-1, .5, 2]), [0, .5, 1], 'clamped into the sample');
  assert.deepEqual(cleanSlices([0, .3, .3, .3 + MIN_SLICE / 2, 1]), [0, .3, 1], 'zero-length and too-short slices are merged away');
  assert.deepEqual(cleanSlices([.4]), defaultSlices(), 'fewer than one slice → default eight');
  assert.deepEqual(cleanSlices('junk'), defaultSlices());
  assert.deepEqual(cleanSlices([0, 'x', NaN, .5, 1]), [0, .5, 1]);
  assert.equal(sliceCount(cleanSlices(Array.from({ length: 40 }, (_, i) => i / 39))), MAX_SLICES);
  for (const l of [[0, .1, .2, 1], [.2, .9], defaultSlices(5)]) assert.deepEqual(cleanSlices(cleanSlices(l)), cleanSlices(l), 'idempotent');
  // a sub-range of the sample is fine (skip silence at the start): slices need not start at 0
  assert.deepEqual(cleanSlices([.1, .2, .9]), [.1, .2, .9]);
});

test('boundaries can be moved through the data model without crossing their neighbours', () => {
  const s = defaultSlices();
  const m = moveSliceBoundary(s, 3, .3);
  assert.equal(m[3], .3); assert.deepEqual(s, defaultSlices(), 'input untouched');
  assert.equal(moveSliceBoundary(s, 3, .9)[3], .5 - MIN_SLICE, 'stops before the next boundary');
  assert.equal(moveSliceBoundary(s, 3, 0)[3], .25 + MIN_SLICE, 'stops after the previous boundary');
  assert.equal(moveSliceBoundary(s, 0, -.5)[0], 0);
  assert.deepEqual(moveSliceBoundary(s, 99, .5), s, 'unknown boundary: unchanged');
  for (const b of [moveSliceBoundary(s, 1, .2), moveSliceBoundary(s, 8, .95)]) for (let k = 0; k < sliceCount(b); k++) assert.ok(b[k + 1] - b[k] >= MIN_SLICE - 1e-9);
});

test('slice k maps to exactly its own region and never to a neighbour', () => {
  const s = defaultSlices();
  for (let k = 0; k < 8; k++) assert.deepEqual(sliceRegion(s, k), [k / 8, (k + 1) / 8]);
  assert.equal(sliceRegion(s, 8), null); assert.equal(sliceRegion(s, -1), null); assert.equal(sliceRegion(s, 1.5), null);
  // regions tile the sample without overlap
  for (let k = 0; k < 7; k++) assert.equal(sliceRegion(s, k)[1], sliceRegion(s, k + 1)[0]);
});

test('reverse mirrors a region inside the reversed buffer, so it covers the same audio', () => {
  assert.deepEqual(bufferRegion([.25, .5], 2), { offset: .5, length: .5 });
  assert.deepEqual(bufferRegion([.25, .5], 2, true), { offset: 1, length: .5 });
  assert.deepEqual(bufferRegion([0, 1], 3, true), { offset: 0, length: 3 });
  assert.deepEqual(trimRegion({ start: .2, end: .6 }), [.2, .6]);
  assert.deepEqual(trimRegion({ start: .7, end: .3 }), [.7, .7 + MIN_SLICE], 'end before start still gives a playable region');
  assert.deepEqual(trimRegion({ start: 1, end: 1 }), [1 - MIN_SLICE, 1]);
});

/* ---------- pitch ---------- */
test('pitch maps to playback rate in equal temperament', () => {
  assert.equal(rateForSemitones(0), 1); assert.equal(rateForSemitones(12), 2); assert.equal(rateForSemitones(-12), .5); assert.equal(rateForSemitones(24), 4);
  assert.ok(Math.abs(rateForSemitones(7) - 1.4983070768766815) < 1e-12, 'a fifth');
  assert.ok(Math.abs(rateForSemitones(1) - 1.0594630943592953) < 1e-12);
});

test('melodic notes transpose against the root; slice notes against C4, never against the root', () => {
  const p = { ...defaultParamsFor('munch'), root: 57 };
  assert.equal(p.tune, 0); assert.equal(defaultParamsFor('munch').root, 60, 'default root C4 / MIDI 60');
  assert.equal(noteSemitones({ p: 57 }, p), 0, 'the root plays as recorded');
  assert.equal(noteSemitones({ p: 69 }, p), 12);
  assert.equal(noteSemitones({ p: 60, slice: 3 }, p), 0, 'slice at p=60 plays as recorded, whatever the root');
  assert.equal(noteSemitones({ p: 62, slice: 3 }, p), 2, 'p only transposes a slice; the slice stays slice 3');
  assert.equal(noteSemitones({ p: 60, slice: 0 }, { ...p, tune: -5 }), -5, 'tune applies to slices too');
  assert.equal(SLICE_REF_PITCH, 60);
});

/* ---------- references ---------- */
test('sample references are validated but never dropped while their id is valid', () => {
  assert.ok(isSampleId(ID)); assert.ok(!isSampleId('smp-XYZ')); assert.ok(!isSampleId('../../etc'));
  assert.deepEqual(cleanSampleRef(ref()), ref());
  assert.equal(cleanSampleRef({ id: 'nope' }), null);
  assert.equal(cleanSampleRef(null), null);
  const r = cleanSampleRef({ id: ID, name: '', duration: -3, slices: [.5] });
  assert.equal(r.name, 'Sample'); assert.equal(r.duration, 0); assert.deepEqual(r.slices, defaultSlices());
  assert.deepEqual(sampleRefFor({ id: ID, name: 'x.wav', duration: 1, sampleRate: 48000, channels: 1 }).slices, defaultSlices());
});

/* ---------- project schema ---------- */
test('only sampler slots carry a sample reference; new MUNCH slots start empty', () => {
  const p = createEmptyProject();
  assert.equal(slotById(p, 'slot-05').sample, null);
  for (const id of ['slot-01', 'slot-02', 'slot-03', 'slot-04']) assert.ok(!('sample' in slotById(p, id)), id);
  assert.deepEqual(validateProject(structuredClone(p)), p, 'a new song is already valid');
  const blip = createSlot('blip', 'slot-06', p.scenes.map(s => s.id));
  assert.ok(!('sample' in blip));
});

test('a MUNCH sample reference, edits and slices survive save → reopen (JSON round trip)', () => {
  const p = createDemoProject(), m = slotById(p, 'slot-05');
  m.sample = ref({ slices: moveSliceBoundary(defaultSlices(), 2, .2) });
  Object.assign(m.params, { root: 48, tune: -3, start: .1, end: .8, reverse: true, mode: 'loop', attack: .05, release: .3 });
  setPatternAt(p, 'slot-05', 0, { len: 16, notes: [{ s: 0, p: 60, l: 1, v: .9, slice: 0 }, { s: 4, p: 64, l: 2, v: .7 }, { s: 8, p: 55, l: 1, v: .8, slice: 7 }] });
  const back = importProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(slotById(back, 'slot-05'), m);
  assert.deepEqual(importProject(JSON.parse(JSON.stringify(back))), back, 'idempotent');
  assert.deepEqual(validateProject(structuredClone(back)).slots.filter(s => s.type === 'munch').length, 1, 'no duplicate MUNCH slot');
});

test('slice is explicit: kept on sampler notes, never added to other instruments', () => {
  const p = createEmptyProject();
  setPatternAt(p, 'slot-05', 0, { len: 16, notes: [{ s: 0, p: 60, l: 1, v: .8, slice: 2 }, { s: 1, p: 60, l: 1, v: .8, slice: 99 }, { s: 2, p: 60, l: 1, v: .8, slice: 1.5 }, { s: 3, p: 60, l: 1, v: .8, slice: -1 }] });
  setPatternAt(p, 'slot-03', 0, { len: 16, notes: [{ s: 0, p: 60, l: 1, v: .8, slice: 2 }] });
  const v = validateProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(patternAt(v, 'slot-05', 0).notes.map(n => n.slice), [2, undefined, undefined, undefined], 'only valid slice indexes stay; bad ones become melodic notes, never another slice');
  assert.equal(patternAt(v, 'slot-03', 0).notes[0].slice, undefined, 'BLIP notes never carry a slice');
  assert.ok(getInstrumentType('munch').capabilities.slices && !getInstrumentType('blip').capabilities.slices);
});

test('MUNCH params are clamped and its play mode is one of oneshot / gate / loop', () => {
  const p = createEmptyProject(), m = slotById(p, 'slot-05');
  Object.assign(m.params, { root: 200, tune: -99, start: -1, end: 4, mode: 'granular', release: 0, vol: 3 });
  const v = slotById(validateProject(JSON.parse(JSON.stringify(p))), 'slot-05').params;
  assert.deepEqual([v.root, v.tune, v.start, v.end, v.mode, v.release, v.vol], [96, -24, 0, 1, 'oneshot', .005, 1]);
  // other instruments keep v0.5 behaviour (no ranges): an out-of-range BLIP cutoff is stored as it is
  const q = createEmptyProject(); slotById(q, 'slot-03').params.cutoff = 3;
  assert.equal(slotById(validateProject(q), 'slot-03').params.cutoff, 3);
});

test('a missing asset never removes the reference; older songs gain an empty MUNCH slot with default params', () => {
  const v5 = importProject(fx('v5-edge.json')), m = slotById(v5, 'slot-05');
  assert.equal(m.sample, null); assert.deepEqual(m.params, defaultParamsFor('munch'));
  // a Phase 2 song (MUNCH placeholder with the old, smaller param set) gains the new params with defaults
  const phase2 = JSON.parse(JSON.stringify(createEmptyProject()));
  phase2.slots[4].params = { vol: .3, pan: 0, drive: .3, driveOn: false, delayOn: false, reverbOn: false, delay: .2, reverb: .2 };
  delete phase2.slots[4].sample;
  const up = slotById(importProject(phase2), 'slot-05');
  assert.equal(up.params.vol, .3); assert.equal(up.params.root, 60); assert.equal(up.params.mode, 'oneshot'); assert.equal(up.sample, null);
});

test('song duplication keeps sample references; sampleRefsOf lists what a song needs', () => {
  const p = createEmptyProject(); slotById(p, 'slot-05').sample = ref();
  const copy = validateProject({ ...structuredClone(p), id: 'song_copy' });
  assert.deepEqual(slotById(copy, 'slot-05').sample, ref());
  assert.deepEqual(sampleRefsOf(copy), [ID]);
  assert.deepEqual(sampleRefsOf(createEmptyProject()), []);
});
