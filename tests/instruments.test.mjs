// Instrument Registry, slot identity and the four existing instruments' defaults.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  INSTRUMENT_TYPES, getInstrumentType, hasInstrumentType, listInstrumentTypes, isPlayableType, defaultParamsFor,
  createPatternFor, typeForLegacyTrack, LEGACY_TRACKS, DEFAULT_SLOT_TYPES, MAX_SLOTS,
  setPreviewInstruments, previewInstrumentsEnabled,
} from '../src/core/instruments.js';
import {
  createEmptyProject, createDemoProject, createSlot, nextSlotId, validateProject, importProject, playableSlots, slotById, typeOfSlot,
  patternAt, setPatternAt, rolePatterns, ProjectError,
} from '../src/core/project.js';
import { createRng } from '../src/core/rng.js';
import { buildContext } from '../src/music/context.js';
import { transformPattern } from '../src/music/transform.js';
import { applyMacros, MACRO_MAP } from '../src/music/macros.js';
import { DRUM_IDS } from '../src/core/constants.js';

// v0.5.1 values, copied verbatim from the old constants (META + DEFAULT_PARAMS) as a regression reference
const V051 = {
  drums: { name: 'BOP', type: 'Drum Machine', c: '#F2AFC0', d: '#E07D98', dd: '#B85475', hp: '#86D3BD', params: { vol: .85, pan: 0, kit: '808', tune: 0, decay: 1, tone: .5, drive: .35, driveOn: false, delayOn: false, reverbOn: true, delay: .18, reverb: .12 } },
  bass: { name: 'GOO', type: 'Acid Bass', c: '#A5DFCE', d: '#5FBFA3', dd: '#3A8F78', hp: '#B39DEB', params: { vol: .72, pan: 0, wave: 'sawtooth', cutoff: .3, res: .62, env: .6, decay: .35, accent: .6, glide: .06, drive: .45, driveOn: true, delayOn: true, reverbOn: false, delay: .16, reverb: .1 } },
  synth: { name: 'BLIP', type: 'Melody Synth', c: '#C2B0ED', d: '#9A82DD', dd: '#6E56B8', hp: '#F49AB2', params: { vol: .5, pan: 0, wave1: 'sawtooth', wave2: 'square', oct2: 0, detune: 10, mix: .35, cutoff: .5, res: .15, fenv: .35, attack: .004, decay: .35, sustain: .35, release: .45, lfoRate: 2.5, lfoDepth: .1, drive: .2, driveOn: false, delayOn: true, reverbOn: true, delay: .28, reverb: .32 } },
  fuzz: { name: 'FUZZ', type: 'Texture & FX', c: '#F5D19A', d: '#E9AE57', dd: '#B9802C', hp: '#B9A6EA', params: { vol: .5, pan: 0, tone: .45, noise: .35, crush: .25, shimmer: .35, attack: .6, release: 1.4, drive: .3, driveOn: false, delayOn: true, reverbOn: true, delay: .35, reverb: .6 } },
};

/* ---------- registry ---------- */
test('registry resolves every type by stable id and refuses unknown ids', () => {
  for (const id of ['bop', 'goo', 'blip', 'fuzz', 'munch']) {
    assert.ok(hasInstrumentType(id));
    const t = getInstrumentType(id);
    assert.equal(t.type, id);
    for (const k of ['name', 'description', 'status', 'pattern', 'defaultLength', 'capabilities', 'visual', 'ui', 'defaultParams']) assert.ok(k in t, `${id}.${k}`);
    assert.ok(['drum', 'notes'].includes(t.pattern));
  }
  assert.equal(hasInstrumentType('kazoo'), false);
  assert.throws(() => getInstrumentType('kazoo'), /Unknown instrument type/);
  assert.equal(hasInstrumentType('toString'), false, 'no prototype leaks');
});

test('registry is immutable', () => {
  assert.ok(Object.isFrozen(INSTRUMENT_TYPES) && Object.isFrozen(INSTRUMENT_TYPES.bop) && Object.isFrozen(INSTRUMENT_TYPES.bop.defaultParams));
  assert.throws(() => { 'use strict'; INSTRUMENT_TYPES.bop.defaultParams.vol = 0; });
  const p = defaultParamsFor('bop'); p.vol = 0;
  assert.equal(getInstrumentType('bop').defaultParams.vol, .85, 'defaultParamsFor hands out copies');
});

test('the four classic instruments keep their v0.5.1 names, colours and default parameters', () => {
  for (const track of LEGACY_TRACKS) {
    const ref = V051[track], t = getInstrumentType(typeForLegacyTrack(track));
    assert.equal(t.role, track);
    assert.equal(t.name, ref.name); assert.equal(t.description, ref.type);
    assert.deepEqual([t.visual.color, t.visual.dark, t.visual.darker, t.visual.headphones], [ref.c, ref.d, ref.dd, ref.hp]);
    assert.equal(t.visual.css, track, 'CSS hook unchanged (data-t / .cat class)');
    assert.deepEqual(defaultParamsFor(t.type), ref.params);
    assert.ok(MACRO_MAP[t.role], 'macros exist for its role');
  }
  assert.deepEqual(DEFAULT_SLOT_TYPES, ['bop', 'goo', 'blip', 'fuzz', 'munch', 'ruff']);
  assert.deepEqual(createPatternFor('bop'), { len: 16, steps: Object.fromEntries(DRUM_IDS.map(id => [id, Array(16).fill(null)])), locked: {} });
  for (const id of ['goo', 'blip', 'fuzz']) assert.deepEqual(createPatternFor(id), { len: 32, notes: [] });
  assert.deepEqual(getInstrumentType('goo').ui.tools, ['draw', 'erase', 'vel', 'prob', 'slide', 'lock']);
  assert.ok(getInstrumentType('goo').capabilities.mono && getInstrumentType('goo').capabilities.slide);
  assert.ok(!getInstrumentType('blip').capabilities.slide && !getInstrumentType('fuzz').capabilities.slide);
});

test('MUNCH is a ready instrument by default; preview toggle stays available for future types', () => {
  const m = getInstrumentType('munch');
  assert.equal(m.status, 'ready'); assert.equal(m.engine, 'munch'); assert.equal(m.capabilities.generate, false);
  assert.equal(previewInstrumentsEnabled(), false, 'preview toggle off by default');
  assert.equal(isPlayableType('munch'), true);
  assert.deepEqual(listInstrumentTypes().map(t => t.type), ['bop', 'goo', 'blip', 'fuzz', 'munch']);
  assert.ok(listInstrumentTypes({ includePlanned: true }).some(t => t.type === 'munch'));
  ['bop', 'goo', 'blip', 'fuzz', 'munch'].forEach(id => assert.ok(isPlayableType(id)));
  try {
    setPreviewInstruments(true);
    assert.equal(previewInstrumentsEnabled(), true);
  } finally { setPreviewInstruments(false); }
  assert.equal(previewInstrumentsEnabled(), false);
  assert.equal(isPlayableType('munch'), true);
});

/* ---------- slots ---------- */
test('a new song has six stable slots (five playable + RUFF placeholder) with ids slot-01…slot-06', () => {
  const p = createEmptyProject();
  assert.deepEqual(p.slots.map(s => [s.id, s.type]), [['slot-01', 'bop'], ['slot-02', 'goo'], ['slot-03', 'blip'], ['slot-04', 'fuzz'], ['slot-05', 'munch'], ['slot-06', 'ruff']]);
  assert.equal(nextSlotId(p), 'slot-07');
  assert.deepEqual(createEmptyProject().slots.map(s => s.id), p.slots.map(s => s.id), 'deterministic');
  assert.deepEqual(playableSlots(p).map(s => s.id), ['slot-01', 'slot-02', 'slot-03', 'slot-04', 'slot-05'], 'first five default slots are playable; RUFF is non-playing placeholder');
  assert.deepEqual(validateProject(structuredClone(p)), p, 'a new song is already valid: validation adds nothing');
  assert.deepEqual(createDemoProject().slots.map(s => s.type), DEFAULT_SLOT_TYPES, 'the demo song has the same six slots');
});

test('slot identity is independent of the instrument type', () => {
  const p = createEmptyProject();
  setPatternAt(p, 'slot-03', 0, { len: 16, notes: [{ s: 0, p: 60, l: 1, v: .8 }] });
  const s = slotById(p, 'slot-03');
  // a future "replace instrument" swaps type/params/patterns in place; the slot keeps its id and position
  Object.assign(s, createSlot('fuzz', s.id, p.scenes.map(x => x.id)));
  const v = validateProject(p);
  assert.deepEqual(v.slots.map(x => x.id), ['slot-01', 'slot-02', 'slot-03', 'slot-04', 'slot-05', 'slot-06']);
  assert.equal(slotById(v, 'slot-03').type, 'fuzz');
});

test('several instances of one type are valid and independent', () => {
  const p = createEmptyProject();
  p.slots.push(createSlot('blip', nextSlotId(p), p.scenes.map(x => x.id)));
  setPatternAt(p, 'slot-07', 0, { len: 16, notes: [{ s: 3, p: 72, l: 2, v: .5 }] });
  slotById(p, 'slot-07').params.cutoff = .9;
  const v = importProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(v.slots.map(s => s.type), ['bop', 'goo', 'blip', 'fuzz', 'munch', 'ruff', 'blip']);
  assert.equal(patternAt(v, 'slot-07', 0).notes[0].p, 72);
  assert.equal(patternAt(v, 'slot-03', 0).notes.length, 0);
  assert.equal(slotById(v, 'slot-07').params.cutoff, .9);
  assert.equal(slotById(v, 'slot-03').params.cutoff, .5);
});

test('a MUNCH slot survives validation untouched and is playable', () => {
  const p = createEmptyProject();
  const m = slotById(p, 'slot-05');
  m.patterns['scene-01'].notes.push({ s: 2, p: 60, l: 1, v: .9 });
  m.params.vol = .3;
  const v = importProject(JSON.parse(JSON.stringify(p)));
  assert.equal(slotById(v, 'slot-05').params.vol, .3, 'an existing MUNCH slot is never overwritten');
  assert.equal(v.slots.filter(s => s.type === 'munch').length, 1, 'no second MUNCH slot');
  assert.equal(slotById(v, 'slot-05').type, 'munch');
  assert.equal(patternAt(v, 'slot-05', 0).notes.length, 1, 'not silently discarded');
  assert.deepEqual(playableSlots(v).map(s => s.id), ['slot-01', 'slot-02', 'slot-03', 'slot-04', 'slot-05']);
});

test('slot validation repairs ids, refuses unknown types and too many slots', () => {
  const p = createEmptyProject();
  p.slots[1].id = 'slot-01'; p.slots[2].id = 'NOT VALID';
  const v = validateProject(p);
  assert.equal(new Set(v.slots.map(s => s.id)).size, 6, 'ids unique after repair');
  assert.equal(v.slots[0].id, 'slot-01');
  const unk = createEmptyProject(); unk.slots[0].type = 'theremin';
  assert.throws(() => validateProject(unk), e => e instanceof ProjectError && /does not know/.test(e.message));
  const many = createEmptyProject(); while (many.slots.length <= MAX_SLOTS) many.slots.push(createSlot('blip', nextSlotId(many), many.scenes.map(x => x.id)));
  assert.throws(() => validateProject(many), ProjectError);
  const none = createEmptyProject(); none.slots = [];
  assert.deepEqual(validateProject(none).slots.map(s => s.type), DEFAULT_SLOT_TYPES, 'an empty instrument list is repaired to the defaults');
});

test('rolePatterns feeds the music layer by role; macros resolve through the slot type', () => {
  const p = createEmptyProject();
  const rp = rolePatterns(p, 0);
  assert.deepEqual(Object.keys(rp).sort(), ['bass', 'drums', 'fuzz', 'synth']);
  assert.equal(rp.bass, patternAt(p, 'slot-02', 0));
  p.slots.splice(0, 1); // no drum slot: the groove helpers still get an (empty) grid
  assert.ok(rolePatterns(p, 0).drums.steps.kick);
  const q = createEmptyProject();
  slotById(q, 'slot-02').macros.brightness = 1; applyMacros(q, 'slot-02', 'brightness');
  assert.equal(slotById(q, 'slot-02').params.cutoff, .08 + .6);
  slotById(q, 'slot-01').macros.movement = .4; applyMacros(q, 'slot-01');
  assert.equal(q.swing, .2, 'drum movement still drives the swing');
  assert.equal(typeOfSlot(slotById(q, 'slot-04')).name, 'FUZZ');
});

test('Generate and friends produce exactly the v0.5.1 results through the slot/role adapter', () => {
  const gold = JSON.parse(readFileSync(new URL('./fixtures/generate-v051.json', import.meta.url), 'utf8'));
  const roleSlot = (pr, role) => pr.slots.find(s => typeOfSlot(s).role === role).id;
  for (const g of gold) {
    const { mood, seed } = g;
    const rng = createRng(seed * 31 + mood.length);
    const pr = createEmptyProject({ key: seed + 2, scale: ['minor', 'dorian', 'major'][seed - 1], mood });
    pr.scenes.push({ id: 'scene-02', name: 'Scene 2', harmony: null });
    pr.slots.forEach(s => { s.patterns['scene-02'] = createPatternFor(s.type); });
    Object.assign(pr.lab, { mood, chaos: seed / 4, density: .3 + seed / 6 });
    for (const t of LEGACY_TRACKS) {
      const id = roleSlot(pr, t);
      const ctx = buildContext(pr, 0, { rng, forLen: patternAt(pr, id, 0).len, ensureHarmony: t !== 'drums' });
      if (ctx.harmonyNew) pr.scenes[0].harmony = ctx.harmony;
      setPatternAt(pr, id, 0, transformPattern('generate', t, patternAt(pr, id, 0), ctx, rng).pattern);
    }
    for (const kind of ['mutate', 'remix', 'callresp', 'humanize']) {
      const ctx = buildContext(pr, 0, { rng, forLen: 32 });
      setPatternAt(pr, roleSlot(pr, 'synth'), 1, transformPattern(kind, 'synth', patternAt(pr, roleSlot(pr, 'synth'), 0), ctx, rng).pattern);
    }
    assert.deepEqual(pr.scenes[0].harmony, g.harmony, `${mood}/${seed} harmony`);
    for (const t of LEGACY_TRACKS) assert.deepEqual(patternAt(pr, roleSlot(pr, t), 0), g.patterns[t], `${mood}/${seed} ${t}`);
    assert.deepEqual(patternAt(pr, roleSlot(pr, 'synth'), 1), g.synth1, `${mood}/${seed} transforms`);
  }
});
