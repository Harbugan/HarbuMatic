// v0.6 Phase 2: five instrument slots. Every song holds BOP, GOO, BLIP, FUZZ and a planned MUNCH slot.
// Older songs gain an empty MUNCH slot without any change to their four instruments; MUNCH is kept in the
// data but never scheduled, soloed, selected, timed or generated. The engine and scheduler take five
// playable instances (checked here with a second BLIP standing in for a future MUNCH engine).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createEmptyProject, createDemoProject, createSlot, importProject, validateProject, slotById, playableSlots,
  patternAt, setPatternAt, maxLen, sceneHasContent, anySolo, slotAudible, rolePatterns, nextSlotId, slotIdFor,
} from '../src/core/project.js';
import { MAX_SLOTS, isPlayableType, getInstrumentType } from '../src/core/instruments.js';
import { createLibrary, memoryStorage } from '../src/core/persistence.js';
import { createEngine } from '../src/audio/engine.js';
import { createTransport } from '../src/audio/scheduler.js';
import { advance, startPosition } from '../src/audio/position.js';
import { buildContext } from '../src/music/context.js';
import { createRng } from '../src/core/rng.js';

const fx = f => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const json = p => JSON.parse(JSON.stringify(p));
const munchSlots = p => p.slots.filter(s => s.type === 'munch');
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** drive the real transport on a virtual clock with a recording engine; returns every voice trigger and UI event */
function dispatch(project, { steps = 64, seed = 1 } = {}) {
  const calls = [], events = [], ctx = { currentTime: 0 };
  const engine = {
    ctx, init: () => ctx, openGates() {}, closeGates() {}, stepDur: () => 60 / project.bpm / 4,
    audible: id => slotAudible(project, slotById(project, id)),
    trigger: (id, t, hit) => calls.push([id, Math.round(t * 1e6), JSON.stringify(hit)]),
  };
  let tick; const si = globalThis.setInterval, ci = globalThis.clearInterval, mr = Math.random;
  globalThis.setInterval = fn => { tick = fn; return 1; }; globalThis.clearInterval = () => {}; Math.random = mulberry(seed);
  try {
    const tr = createTransport(engine, () => project, {}); tr.play();
    while (events.length < steps) { ctx.currentTime += .01; tick(); events.push(...tr.queue.splice(0)); }
    tr.stop();
  } finally { globalThis.setInterval = si; globalThis.clearInterval = ci; Math.random = mr; }
  return { calls, events: events.slice(0, steps) };
}

/** a v6 song as Phase 1 (v0.6 dev, four slots) saved it: the demo with content in every place that can hold it */
function phase1Song() {
  const p = createDemoProject();
  p.slots = p.slots.filter(s => s.type !== 'munch');
  p.slots[1].mute = true; p.slots[2].solo = true;
  p.slots[0].params.tune = 3; p.slots[3].macros.space = .9;
  p.songMode = true; p.scenes[4].name = 'Bridge';
  const snap = {}; p.slots.forEach(s => { snap[s.id] = { type: s.type, pattern: structuredClone(patternAt(p, s.id, 1)), macros: structuredClone(s.macros) }; });
  p.snaps[2] = { slots: snap };
  return json(p);
}

/* ---------- project model ---------- */
test('every new song has exactly five stable slots, and new songs agree with each other', () => {
  for (const p of [createEmptyProject(), createDemoProject()]) {
    assert.deepEqual(p.slots.map(s => `${s.id}:${s.type}`), ['slot-01:bop', 'slot-02:goo', 'slot-03:blip', 'slot-04:fuzz', 'slot-05:munch']);
    assert.deepEqual(munchSlots(p)[0].patterns, Object.fromEntries(p.scenes.map(sc => [sc.id, { len: 16, notes: [] }])));
  }
});

test('a four-slot v6 song gains one empty MUNCH slot; nothing else changes', () => {
  const old = phase1Song(), copy = structuredClone(old);
  const v = importProject(old);
  assert.deepEqual(old, copy, 'the input is not mutated');
  assert.deepEqual(v.slots.slice(0, 4), copy.slots, 'the four instruments are byte-for-byte the same (ids, params, macros, patterns, mute/solo)');
  assert.deepEqual(v.slots.map(s => s.id), ['slot-01', 'slot-02', 'slot-03', 'slot-04', 'slot-05']);
  assert.equal(slotById(v, 'slot-05').type, 'munch');
  for (const k of ['id', 'name', 'created', 'modified', 'bpm', 'swing', 'key', 'scale', 'scene', 'songMode', 'scenes', 'arrangement', 'lab', 'fx', 'snaps']) assert.deepEqual(v[k], copy[k], k);
});

test('repeated import never duplicates MUNCH and is idempotent', () => {
  const file = phase1Song(), once = importProject(structuredClone(file));
  let p = once;
  for (let i = 0; i < 3; i++) p = importProject(json(p));
  assert.deepEqual(p, once);
  assert.equal(munchSlots(p).length, 1);
  assert.deepEqual(importProject(structuredClone(file)), once, 'deterministic: same file, same result');
  for (const f of ['v5-demo.json', 'v5-edge.json', 'v5-from-v4.json', 'v4-demo.json']) {
    const a = importProject(fx(f)), b = importProject(json(a));
    assert.equal(munchSlots(a).length, 1, f); assert.deepEqual(b, a, f);
  }
});

test('an existing MUNCH placeholder (Phase 1 v6 songs) is kept as it is, wherever it sits', () => {
  const p = phase1Song();
  p.slots.splice(1, 0, { id: 'slot-07', type: 'munch', mute: true, solo: true, params: { vol: .2 }, patterns: { 'scene-02': { len: 32, notes: [{ s: 4, p: 61, l: 2, v: .7 }] } } });
  const v = importProject(p);
  assert.deepEqual(v.slots.map(s => s.id), ['slot-01', 'slot-07', 'slot-02', 'slot-03', 'slot-04'], 'order and ids kept, nothing appended');
  const m = slotById(v, 'slot-07');
  assert.equal(m.params.vol, .2); assert.equal(m.mute, true); assert.equal(m.solo, true);
  assert.deepEqual(m.patterns['scene-02'].notes, [{ s: 4, p: 61, l: 2, v: .7 }]);
});

test('MUNCH never takes over a slot id that belongs to another instrument', () => {
  const p = phase1Song();
  const extra = createSlot('blip', 'slot-05', p.scenes.map(s => s.id)); extra.params.cutoff = .8;
  p.slots.push(json(extra));
  const v = importProject(p);
  assert.deepEqual(v.slots.map(s => `${s.id}:${s.type}`), ['slot-01:bop', 'slot-02:goo', 'slot-03:blip', 'slot-04:fuzz', 'slot-05:blip', 'slot-06:munch']);
  assert.equal(slotById(v, 'slot-05').params.cutoff, .8);
  // a song that is already full keeps its instruments and opens without a MUNCH slot rather than failing
  const full = phase1Song();
  while (full.slots.length < MAX_SLOTS) full.slots.push(json(createSlot('blip', slotIdFor(full.slots.length + 1), full.scenes.map(s => s.id))));
  const vf = importProject(full);
  assert.equal(vf.slots.length, MAX_SLOTS); assert.equal(munchSlots(vf).length, 0);
});

test('save → load and export → re-import keep all five slots', () => {
  const st = memoryStorage(), lib = createLibrary(st);
  const p = importProject(phase1Song());
  setPatternAt(p, 'slot-05', 0, { len: 16, notes: [{ s: 0, p: 60, l: 1, v: .8 }] }); // placeholder data persists too
  assert.ok(lib.save(p));
  const back = createLibrary(st).load(p.id);
  assert.deepEqual(back, p);
  assert.deepEqual(importProject(JSON.parse(JSON.stringify(back))), p, 'export file (plain JSON) re-imports identically');
});

/* ---------- MUNCH stays planned ---------- */
test('MUNCH is planned: not playable, not listed, not selectable', () => {
  const m = getInstrumentType('munch');
  assert.equal(m.status, 'planned'); assert.equal(m.engine, null); assert.equal(isPlayableType('munch'), false);
  assert.deepEqual(m.ui.layers, ['play', 'chop', 'twist'], 'interaction layers of the agreed design are named for later phases');
  assert.ok(!playableSlots(createEmptyProject()).some(s => s.type === 'munch'));
});

test('MUNCH placeholders stay silent and never affect mute/solo of the others', () => {
  const base = importProject(fx('v5-edge.json')); base.scene = 1; base.songMode = false;
  const sc = { steps: 96, seed: 5 };
  const ref = dispatch(structuredClone(base), sc);
  assert.ok(ref.calls.length > 20, 'the reference really plays');
  const loud = structuredClone(base), m = slotById(loud, 'slot-05');
  Object.values(m.patterns).forEach(pt => { pt.len = 64; pt.notes = [0, 4, 8, 12].map(s => ({ s, p: 60, l: 2, v: 1 })); });
  for (const [mute, solo] of [[false, false], [false, true], [true, false], [true, true]]) {
    m.mute = mute; m.solo = solo;
    assert.equal(anySolo(loud), false, 'a planned solo is not a solo');
    assert.deepEqual(dispatch(structuredClone(loud), sc), ref, `same voices and UI events with MUNCH mute=${mute} solo=${solo}`);
  }
  // a real solo still works while MUNCH is soloed
  slotById(loud, 'slot-02').solo = true;
  assert.deepEqual(playableSlots(loud).map(s => slotAudible(loud, s)), [false, true, false, false]);
});

test('MUNCH placeholders do not change scene length, song-mode timing or "has content"', () => {
  const p = createDemoProject();
  const lens = p.scenes.map((_, i) => maxLen(p, i)), content = p.scenes.map((_, i) => sceneHasContent(p, i));
  Object.values(slotById(p, 'slot-05').patterns).forEach(pt => { pt.len = 64; pt.notes = [{ s: 60, p: 60, l: 4, v: 1 }]; });
  assert.deepEqual(p.scenes.map((_, i) => maxLen(p, i)), lens);
  assert.deepEqual(p.scenes.map((_, i) => sceneHasContent(p, i)), content, 'an empty scene with only MUNCH notes still counts as empty');
  p.songMode = true;
  const walk = proj => { let pos = startPosition(proj), out = []; for (let i = 0; i < 400; i++) { out.push(`${pos.scene}:${pos.step}:${pos.block}`); pos = advance(pos, proj, null).pos; } return out.join(); };
  const plain = createDemoProject(); plain.songMode = true;
  assert.equal(walk(p), walk(plain));
});

test('MUNCH placeholders do not reach musical generation', () => {
  const p = createDemoProject(), q = createDemoProject();
  Object.values(slotById(q, 'slot-05').patterns).forEach(pt => { pt.notes = [{ s: 0, p: 40, l: 8, v: 1 }]; });
  assert.deepEqual(Object.keys(rolePatterns(q, 1)).sort(), ['bass', 'drums', 'fuzz', 'synth']);
  const strip = c => JSON.stringify(c, (k, v) => (k === 'rng' ? undefined : v));
  assert.equal(strip(buildContext(q, 1, { rng: createRng(4) })), strip(buildContext(p, 1, { rng: createRng(4) })));
});

/* ---------- five playable instances: engine + scheduler ---------- */
// A tiny fake Web Audio graph (Node has none): every node records what it connects to.
function fakeAudio() {
  const param = () => { const p = { value: 0 }; ['setValueAtTime', 'setTargetAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'cancelScheduledValues'].forEach(m => { p[m] = () => p; }); return p; };
  const node = kind => {
    const t = { kind, out: [], connect(d) { t.out.push(d); return d; }, disconnect() { t.out = []; }, start() {}, stop() {} };
    return new Proxy(t, { get: (o, k) => (k in o ? o[k] : typeof k === 'string' ? (o[k] = param()) : undefined), set: (o, k, v) => { o[k] = v; return true; } });
  };
  class Ctx {
    constructor() { this.currentTime = 0; this.sampleRate = 8000; this.state = 'running'; this.destination = node('destination'); }
    resume() { return Promise.resolve(); }
    createBuffer(ch, len) { const d = Array.from({ length: ch }, () => new Float32Array(len)); return { getChannelData: i => d[i] }; }
  }
  for (const k of ['Gain', 'BiquadFilter', 'WaveShaper', 'StereoPanner', 'DynamicsCompressor', 'Analyser', 'Convolver', 'Delay', 'Oscillator', 'BufferSource', 'ConstantSource']) Ctx.prototype[`create${k}`] = function () { return node(k); };
  return Ctx;
}
function withFakeAudio(fn) {
  const had = 'window' in globalThis, old = globalThis.window;
  globalThis.window = { AudioContext: fakeAudio() };
  try { return fn(); } finally { if (had) globalThis.window = old; else delete globalThis.window; }
}
/** five playable instances: the four classics + a second BLIP in the place a ready MUNCH will take */
function fivePlayable() {
  const p = createEmptyProject();
  p.slots.push(createSlot('blip', nextSlotId(p), p.scenes.map(s => s.id)));
  return p;
}

test('the engine builds one channel per playable slot, none for MUNCH, and wires five channels like four', () => {
  withFakeAudio(() => {
    const four = createEmptyProject(), e4 = createEngine(() => four);
    e4.init();
    assert.deepEqual([...e4.E.ch.keys()], ['slot-01', 'slot-02', 'slot-03', 'slot-04'], 'no channel for the MUNCH placeholder');
    e4.trigger('slot-05', 0, { p: 60, v: 1, dur: .1 }); e4.audition('slot-05', 60); // silently ignored
    const five = fivePlayable(), e5 = createEngine(() => five);
    e5.init();
    assert.deepEqual([...e5.E.ch.keys()], ['slot-01', 'slot-02', 'slot-03', 'slot-04', 'slot-06']);
    const { E } = e5;
    for (const [id, { channel: ch, voice }] of E.ch) {
      assert.ok(ch.pan.out.includes(E.master), `${id}: own pan → master`);
      assert.ok(ch.out.out.includes(ch.sd) && ch.sd.out.includes(E.dIn), `${id}: delay send`);
      assert.ok(ch.out.out.includes(ch.sr) && ch.sr.out.includes(E.revIn), `${id}: reverb send`);
      assert.ok(voice.input, `${id}: voice input`);
    }
    const chans = [...E.ch.values()].map(x => x.channel);
    assert.equal(new Set(chans.map(c => c.bus)).size, 5, 'independent mixer channels');
    // volume and pan of the fifth instance are its own
    slotById(five, 'slot-06').params.pan = -.5; e5.applyParams('slot-06'); e5.applyParams('slot-03');
    e5.openGates(); assert.deepEqual(Object.keys(E.gates), ['slot-01', 'slot-02', 'slot-03', 'slot-04', 'slot-06'], 'transport gates per slot');
    e5.closeGates();
    // the fifth slot goes away (e.g. undo to a four-slot state) → its channel is released
    five.slots.pop(); e5.syncSlots();
    assert.deepEqual([...E.ch.keys()], ['slot-01', 'slot-02', 'slot-03', 'slot-04']);
  });
});

test('the scheduler dispatches all five playable instances and keys UI hits by slot id', () => {
  const p = fivePlayable();
  const ids = playableSlots(p).map(s => s.id);
  ids.forEach((id, k) => {
    if (getInstrumentType(slotById(p, id).type).pattern === 'drum') patternAt(p, id, 0).steps.kick[k] = { v: 1, p: 1 };
    else setPatternAt(p, id, 0, { len: 16, notes: [{ s: k, p: 60 + k, l: 1, v: .8 }] });
  });
  const { calls, events } = dispatch(p, { steps: 16 });
  const got = calls.map(c => c[0]);
  assert.deepEqual([...new Set(got)], ids, 'every playable instance is triggered, in slot order');
  assert.deepEqual([...new Set(events.flatMap(e => Object.keys(e.hits)))], ids);
});
