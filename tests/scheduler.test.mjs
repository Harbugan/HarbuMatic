// Scheduler dispatch through instrument slots, checked against dispatch logs frozen from the v0.5.1
// scheduler (tests/fixtures/dispatch-v051.json, made by tests/fixtures/make-golden-v051.mjs).
// Same songs, same seeded randomness → the v6 scheduler must play exactly the same hits at exactly the
// same times with the same durations and slide flags, honour mute/solo the same way and emit the same
// UI events (with hits keyed by slot id instead of track name).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importProject, slotById, nextSlotId, createSlot, createEmptyProject, setPatternAt } from '../src/core/project.js';
import { getInstrumentType } from '../src/core/instruments.js';
import { createTransport } from '../src/audio/scheduler.js';
import { createEngine } from '../src/audio/engine.js';
import { VOICE_FACTORIES } from '../src/audio/voices.js';
import { slotAudible } from '../src/core/project.js';

const fx = f => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const GOLD = fx('dispatch-v051.json');
const r6 = x => Math.round(x * 1e6) / 1e6;
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const roleOf = (project, id) => getInstrumentType(slotById(project, id).type).role;
const slotOfRole = (project, role) => project.slots.find(s => getInstrumentType(s.type).role === role);

/** drive a transport with a fake engine exactly like the golden generator did */
export function runScenario(project, sc) {
  const calls = [];
  const ctx = { currentTime: 0 };
  let tag = () => 0;
  const engine = {
    ctx, init: () => ctx, openGates() {}, closeGates() {}, stepDur: () => 60 / project.bpm / 4,
    audible: id => slotAudible(project, slotById(project, id)),
    trigger(id, t, hit) {
      const role = roleOf(project, id);
      if (hit.d) calls.push([tag(), 'd', role, r6(t), hit.d, hit.v]);
      else calls.push([tag(), 'n', role, r6(t), hit.p, hit.v, r6(hit.dur), !!hit.slideIn, !!hit.slideOut]);
    },
  };
  let tickFn = null; const si = globalThis.setInterval, ci = globalThis.clearInterval, mr = Math.random;
  globalThis.setInterval = fn => { tickFn = fn; return 1; }; globalThis.clearInterval = () => {};
  Math.random = mulberry(sc.seed);
  const queued = new Set(), events = [];
  try {
    const tr = createTransport(engine, () => project, {});
    tr.play();
    tag = () => events.length + tr.queue.length;
    let guard = 0;
    while (events.length + tr.queue.length < sc.steps && guard++ < 100000) {
      const n = events.length + tr.queue.length;
      if (sc.queue && sc.queue[n] != null && !queued.has(n)) { queued.add(n); tr.queueScene(sc.queue[n]); }
      ctx.currentTime += .01; tickFn();
      events.push(...tr.queue.splice(0));
    }
    tr.stop();
  } finally { Math.random = mr; globalThis.setInterval = si; globalThis.clearInterval = ci; }
  return {
    events: events.slice(0, sc.steps).map(e => ({ t: r6(e.time), step: e.step, scene: e.scene, block: e.block, song: e.song, hits: Object.fromEntries(Object.entries(e.hits).map(([id, h]) => [roleOf(project, id), h])) })),
    calls: calls.filter(c => c[0] < sc.steps),
    rawEvents: events,
  };
}

function prepare(sc) {
  const project = importProject(fx(sc.fixture));
  Object.assign(project, sc.set);
  (sc.mute || []).forEach(r => { slotOfRole(project, r).mute = true; });
  (sc.unmute || []).forEach(r => { slotOfRole(project, r).mute = false; });
  (sc.solo || []).forEach(r => { slotOfRole(project, r).solo = true; });
  return project;
}

for (const gold of GOLD) {
  test(`scheduler dispatch matches v0.5.1: ${gold.name}`, () => {
    const out = runScenario(prepare(gold.scenario), gold.scenario);
    assert.equal(out.events.length, gold.events.length);
    assert.deepEqual(out.events, gold.events, 'transport events (time, step, scene, block, hits)');
    assert.equal(out.calls.length, gold.calls.length, 'number of voices triggered');
    assert.deepEqual(out.calls, gold.calls, 'every triggered voice (time, pitch/drum, velocity, duration, slides)');
  });
}

test('event hits are keyed by slot id', () => {
  const sc = GOLD[0].scenario, project = prepare(sc);
  const { rawEvents } = runScenario(project, sc);
  const keys = new Set(rawEvents.flatMap(e => Object.keys(e.hits)));
  assert.deepEqual([...keys].sort(), ['slot-01', 'slot-02', 'slot-03', 'slot-04'].filter(k => keys.has(k)));
  assert.ok(keys.has('slot-01'));
});

test('mute and solo: muted slots are silent, solo wins over mute, hits are still counted for the UI only when audible', () => {
  const sc = { steps: 64, seed: 9 };
  const base = importProject(fx('v5-demo.json')); base.scene = 1; base.songMode = false;
  const all = runScenario(structuredClone(base), sc).calls;
  const rolesIn = calls => new Set(calls.map(c => c[2]));
  assert.deepEqual([...rolesIn(all)].sort(), ['bass', 'drums', 'fuzz', 'synth']);
  const muted = structuredClone(base); slotById(muted, 'slot-01').mute = true;
  assert.ok(!rolesIn(runScenario(muted, sc).calls).has('drums'));
  const solo = structuredClone(base); slotById(solo, 'slot-03').solo = true; slotById(solo, 'slot-03').mute = true;
  assert.deepEqual([...rolesIn(runScenario(solo, sc).calls)], ['synth']);
});

test('slots of a planned type (MUNCH) are skipped, and two slots of one type play independently', () => {
  const p = importProject(fx('v5-demo.json')); p.scene = 1; p.songMode = false;
  const baseCalls = runScenario(structuredClone(p), { steps: 32, seed: 3 }).calls;
  const withMunch = structuredClone(p);
  const munch = createSlot('munch', nextSlotId(withMunch), withMunch.scenes.map(s => s.id));
  assert.equal(munch.id, 'slot-05');
  munch.patterns[withMunch.scenes[1].id].notes.push({ s: 0, p: 60, l: 1, v: 1 });
  withMunch.slots.push(munch);
  assert.deepEqual(runScenario(withMunch, { steps: 32, seed: 3 }).calls, baseCalls, 'MUNCH placeholder changes nothing');

  const twin = createEmptyProject();
  const blip2 = createSlot('blip', nextSlotId(twin), twin.scenes.map(s => s.id));
  twin.slots.push(blip2);
  setPatternAt(twin, 'slot-03', 0, { len: 16, notes: [{ s: 0, p: 60, l: 2, v: .8 }] });
  setPatternAt(twin, blip2.id, 0, { len: 16, notes: [{ s: 4, p: 72, l: 2, v: .8 }] });
  const ids = [];
  const engine = { ctx: { currentTime: 0 }, init() { return this.ctx; }, openGates() {}, closeGates() {}, stepDur: () => .125, audible: () => true, trigger: (id, t, hit) => ids.push([id, hit.p]) };
  let tickFn; const si = globalThis.setInterval; globalThis.setInterval = fn => { tickFn = fn; return 1; };
  try { const tr = createTransport(engine, () => twin, {}); tr.play(); for (let i = 0; i < 80; i++) { engine.ctx.currentTime += .01; tickFn(); } tr.stop(); } finally { globalThis.setInterval = si; }
  assert.deepEqual(ids.slice(0, 2), [['slot-03', 60], ['slot-05', 72]]);
});

test('every ready instrument type has an audio voice factory; planned types have none', () => {
  for (const id of ['bop', 'goo', 'blip', 'fuzz']) assert.equal(typeof VOICE_FACTORIES[getInstrumentType(id).engine], 'function', id);
  assert.equal(getInstrumentType('munch').engine, null);
  assert.equal(typeof createEngine, 'function');
});
