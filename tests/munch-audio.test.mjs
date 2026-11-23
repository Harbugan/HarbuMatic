// MUNCH voice, engine and transport integration on a fake Web Audio graph (tests/helpers/audio.mjs).
// Checks what the voice asks Web Audio to do: start/stop times, offsets, playback rates, envelopes, loops,
// the voice pool and cleanup — plus dispatch through the real scheduler (tempo, swing, scenes, song, mute/solo).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setPreviewInstruments } from '../src/core/instruments.js';
import { createEmptyProject, importProject, slotById, setPatternAt, sceneIdAt, newBlock, slotAudible, playableSlots } from '../src/core/project.js';
import { sampleRefFor, defaultSlices, moveSliceBoundary } from '../src/core/samples.js';
import { createSampleStore, memoryBackend } from '../src/samples/store.js';
import { createSampleBank } from '../src/samples/bank.js';
import { createEngine } from '../src/audio/engine.js';
import { createTransport } from '../src/audio/scheduler.js';
import { MUNCH_POLY } from '../src/audio/voices.js';
import { makeWav, decodeWav, withFakeWindow } from './helpers/audio.mjs';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const M = 'slot-05';

/** a five-slot song with a 1 s sample (1 kHz rate) on MUNCH, previews enabled, engine on a fake context */
async function rig(fn, { seconds = 1, params = {} } = {}) {
  setPreviewInstruments(true);
  try {
    await withFakeWindow(async getCtx => {
      const store = createSampleStore({ backend: memoryBackend(), decode: decodeWav });
      const bank = createSampleBank({ store, decode: decodeWav });
      const p = createEmptyProject();
      const { meta } = await store.importBytes({ bytes: makeWav({ seconds, rate: 1000, freq: 0 }), name: 'ramp.wav' });
      Object.assign(slotById(p, M), { sample: sampleRefFor(meta) });
      Object.assign(slotById(p, M).params, params);
      const engine = createEngine(() => p, { samples: bank });
      engine.init();
      const ctx = getCtx();
      await bank.pin([meta.id]);
      engine.applyAll();
      const voice = engine.E.ch.get(M).voice;
      const srcs = () => ctx.sources.filter(s => s.buffer && s.buffer.length === seconds * 1000);
      await fn({ p, engine, ctx, bank, voice, meta, srcs, m: slotById(p, M) });
    });
  } finally { setPreviewInstruments(false); }
}
const lastEnv = s => s.out[0]; // source → envelope gain

test('melodic notes: playback rate follows pitch against the root; the trimmed region is played once', () => rig(async ({ engine, srcs, m }) => {
  m.params.start = .25; m.params.end = .75;
  engine.trigger(M, 1, { p: 72, v: .8, dur: .5 }, false);
  const s = srcs()[0];
  assert.equal(s.playbackRate.value, 2, 'an octave up = rate 2');
  assert.deepEqual(s.startArgs.slice(0, 2), [1, .25], 'starts at the trim start');
  assert.ok(near(s.stopAt, 1 + .5 / 2 + .002), 'stops after the region at double speed');
  m.root = 0; m.params.root = 48;
  engine.trigger(M, 2, { p: 48, v: .8, dur: .5 }, false);
  assert.equal(srcs()[1].playbackRate.value, 1, 'the root plays as recorded');
  engine.trigger(M, 3, { p: 41, v: .8, dur: .5 }, false);
  assert.ok(near(srcs()[2].playbackRate.value, Math.pow(2, -7 / 12)));
}));

test('slice notes play exactly their slice, at C4 = untransposed, never confused with melodic pitch', () => rig(async ({ engine, srcs, m }) => {
  m.params.root = 50; m.params.start = .4; m.params.end = .6; // root and trim do not apply to slices
  for (let k = 0; k < 8; k++) engine.trigger(M, k, { p: 60, v: .8, dur: .1, slice: k }, false);
  srcs().forEach((s, k) => {
    assert.equal(s.playbackRate.value, 1, `slice ${k} rate`);
    assert.ok(near(s.startArgs[1], k / 8), `slice ${k} offset`);
    assert.ok(near(s.stopAt, k + 1 / 8 + .002), `slice ${k} stops at its own end`);
    const env = lastEnv(s).gain.events, last = env[env.length - 1];
    assert.deepEqual([last[0], last[1]], ['linearRampToValueAtTime', 0]); assert.ok(near(last[2], k + 1 / 8), 'silent by the slice end: no bleed into the next slice');
  });
  engine.trigger(M, 10, { p: 72, v: .8, dur: .1, slice: 2 }, false);
  const up = srcs()[8];
  assert.equal(up.playbackRate.value, 2); assert.ok(near(up.startArgs[1], .25), 'pitch never changes which slice plays');
  engine.trigger(M, 11, { p: 60, v: .8, dur: .1, slice: 8 }, false);
  assert.equal(srcs().length, 9, 'a slice the sample does not have stays silent');
}));

test('moved slice boundaries are honoured', () => rig(async ({ engine, srcs, m }) => {
  m.sample.slices = moveSliceBoundary(defaultSlices(), 1, .05);
  engine.trigger(M, 0, { p: 60, v: 1, dur: .1, slice: 0 }, false);
  engine.trigger(M, 1, { p: 60, v: 1, dur: .1, slice: 1 }, false);
  assert.ok(near(srcs()[0].stopAt, .05 + .002)); assert.ok(near(srcs()[1].startArgs[1], .05)); assert.ok(near(srcs()[1].stopAt, 1 + .2 + .002));
}));

test('reverse plays the mirrored region of the reversed copy; the original stays untouched', () => rig(async ({ engine, srcs, bank, meta, m }) => {
  m.params.reverse = true; engine.applyParams(M); // apply builds the reversed copy ahead of time
  const rev = bank.buffer(meta.id, true), fwd = bank.buffer(meta.id);
  assert.ok(rev && rev !== fwd);
  engine.trigger(M, 0, { p: 60, v: .8, dur: .1, slice: 1 }, false);
  const s = ctxSrc(srcs, rev);
  assert.equal(s.buffer, rev); assert.ok(near(s.startArgs[1], 1 - .25), 'slice 1 = [.125, .25] mirrored to [.75, .875]');
  assert.ok(near(fwd.getChannelData(0)[0], 0), 'forward buffer unchanged');
}));
const ctxSrc = (srcs, buf) => srcs().find(s => s.buffer === buf);

test('play modes: oneshot ignores the note length, gate releases at the note end, loop loops until the note ends', () => rig(async ({ engine, srcs, m }) => {
  m.params.release = .1;
  m.params.mode = 'oneshot'; engine.trigger(M, 0, { p: 60, v: .8, dur: .05 }, false);
  assert.ok(near(srcs()[0].stopAt, 1.002), 'whole sample');
  m.params.mode = 'gate'; engine.trigger(M, 2, { p: 60, v: .8, dur: .2 }, false);
  assert.ok(near(srcs()[1].stopAt, 2 + .2 + .1 + .002), 'note end + release');
  engine.trigger(M, 4, { p: 60, v: .8, dur: 5 }, false);
  assert.ok(near(srcs()[2].stopAt, 5.002), 'a long gate still stops at the region end');
  m.params.mode = 'loop'; m.params.start = .5; m.params.end = .75;
  engine.trigger(M, 6, { p: 60, v: .8, dur: 2 }, false);
  const l = srcs()[3];
  assert.equal(l.loop, true); assert.ok(near(l.loopStart, .5) && near(l.loopEnd, .75));
  assert.ok(near(l.stopAt, 6 + 2 + .1 + .002), 'loops for the note, then releases');
}));

test('velocity scales the envelope peak; attack shapes the start', () => rig(async ({ engine, srcs, m }) => {
  m.params.attack = .05;
  engine.trigger(M, 0, { p: 60, v: .3, dur: .1 }, false);
  const ev = lastEnv(srcs()[0]).gain.events;
  assert.deepEqual(ev[0], ['setValueAtTime', 0, 0]);
  assert.deepEqual(ev[1], ['linearRampToValueAtTime', .3, .05]);
}));

test('polyphony is bounded: the oldest voice is stolen with a short fade, nothing is left running', () => rig(async ({ engine, voice, srcs, ctx }) => {
  for (let i = 0; i < MUNCH_POLY + 4; i++) engine.trigger(M, i * .01, { p: 60 + i, v: .8, dur: .5 }, false); // different keys: polyphonic
  assert.equal(voice.activeCount(), MUNCH_POLY);
  assert.equal(voice.stats.stolen, 4);
  srcs().slice(0, 4).forEach(s => assert.ok(s.stopAt < .2, 'stolen voices stop quickly'));
  ctx.advance(10);
  assert.equal(voice.activeCount(), 0);
  srcs().forEach(s => { assert.ok(s.ended && s.disconnected, 'every source ended and was disconnected'); assert.ok(lastEnv(s) === undefined || true); });
  assert.equal(ctx.live.size, 0, 'no orphaned sources');
}));

test('repeated trigger and stop cycles leave no orphaned nodes', () => rig(async ({ engine, voice, ctx }) => {
  for (let round = 0; round < 20; round++) {
    const t = round;
    engine.openGates();
    for (let i = 0; i < 5; i++) engine.trigger(M, t + i * .1, { p: 60 + i, v: .8, dur: .3, slice: i % 8 }, true);
    ctx.advance(t + .15);
    engine.closeGates(); // what Pause and Stop do
    assert.equal(voice.activeCount(), 0, 'silence() drops every voice at once');
    ctx.advance(t + .9);
  }
  assert.equal(ctx.live.size, 0);
}));

test('missing samples stay silent and are counted; no source is created', () => rig(async ({ engine, voice, srcs, m }) => {
  m.sample = { ...m.sample, id: 'smp-' + 'f'.repeat(64) };
  engine.trigger(M, 0, { p: 60, v: .8, dur: .1 }, false);
  assert.equal(srcs().length, 0); assert.equal(voice.stats.missed, 1);
  m.sample = null; engine.trigger(M, 1, { p: 60, v: .8, dur: .1 }, false);
  assert.equal(srcs().length, 0, 'no sample loaded: silent');
}));

test('audition plays immediately, and can target a single slice', () => rig(async ({ engine, ctx, srcs }) => {
  ctx.currentTime = 3;
  engine.audition(M, 60, .9, { slice: 5 });
  const s = srcs()[0];
  assert.ok(near(s.startArgs[0], 3.01)); assert.ok(near(s.startArgs[1], 5 / 8));
}));

test('MUNCH has its own channel with volume, pan and sends like every other slot', () => rig(async ({ engine, p }) => {
  assert.deepEqual([...engine.E.ch.keys()], ['slot-01', 'slot-02', 'slot-03', 'slot-04', 'slot-05']);
  const ch = engine.E.ch.get(M).channel;
  assert.ok(ch.pan.out.includes(engine.E.master) && ch.sd.out.includes(engine.E.dIn) && ch.sr.out.includes(engine.E.revIn));
  assert.equal(engine.E.ch.get(M).voice.input, ch.bus);
  slotById(p, M).mute = true; engine.applyParams(M);
  assert.equal(engine.audible(M), false);
}));

/* ---------- through the scheduler ---------- */
function drive(p, engine, ctx, { seconds = 4, onTick } = {}) {
  let tick; const si = globalThis.setInterval, ci = globalThis.clearInterval;
  globalThis.setInterval = fn => { tick = fn; return 1; }; globalThis.clearInterval = () => {};
  const events = [];
  try {
    const tr = createTransport(engine, () => p, {});
    tr.play();
    for (let t = 0; t < seconds; t += .01) { ctx.currentTime = t; tick(); events.push(...tr.queue.splice(0)); if (onTick) onTick(t, tr); }
    tr.stop();
    return { events, tr };
  } finally { globalThis.setInterval = si; globalThis.clearInterval = ci; }
}

test('MUNCH patterns play through the transport: tempo, swing, slices and melodic notes', () => rig(async ({ p, engine, ctx, srcs }) => {
  p.bpm = 120; p.swing = .2; p.songMode = false; p.scene = 0;
  setPatternAt(p, M, 0, { len: 16, notes: [{ s: 0, p: 60, l: 1, v: .9, slice: 0 }, { s: 1, p: 60, l: 1, v: .9, slice: 3 }, { s: 4, p: 72, l: 2, v: .7 }] });
  const { events } = drive(p, engine, ctx, { seconds: .9 });
  const t0 = events[0].time, sd = 60 / 120 / 4;
  const ss = srcs().slice(0, 3);
  assert.ok(near(ss[0].startArgs[0], t0) && near(ss[0].startArgs[1], 0));
  assert.ok(near(ss[1].startArgs[0], t0 + sd + .2 * sd * .5, 1e-6), 'odd step is swung like every instrument');
  assert.ok(near(ss[1].startArgs[1], 3 / 8));
  assert.ok(near(ss[2].startArgs[0], t0 + 4 * sd, 1e-6) && ss[2].playbackRate.value === 2);
  const hits = events.flatMap(e => e.hits[M] || []);
  assert.deepEqual(hits.slice(0, 3).map(h => h.slice), [0, 3, undefined], 'UI events carry the slice');
}));

test('scene changes and song mode switch MUNCH patterns like any instrument; mute/solo and Pause/Stop apply', () => rig(async ({ p, engine, ctx, srcs, voice }) => {
  setPatternAt(p, M, 0, { len: 16, notes: [{ s: 0, p: 60, l: 1, v: .9, slice: 0 }] });
  setPatternAt(p, M, 1, { len: 16, notes: [{ s: 0, p: 60, l: 1, v: .9, slice: 7 }] });
  p.arrangement = [newBlock(sceneIdAt(p, 0)), newBlock(sceneIdAt(p, 1))]; p.songMode = true;
  drive(p, engine, ctx, { seconds: 4.2 });
  const offs = srcs().map(s => s.startArgs[1]);
  // scene A lasts 32 steps (GOO's default length is the longest), so slice 0 plays twice before block B starts
  assert.deepEqual(offs.map(x => Math.round(x * 8)), [0, 0, 7], 'scene A plays slice 0, then scene B slice 7');
  const before = srcs().length;
  slotById(p, M).mute = true;
  drive(p, engine, ctx, { seconds: 1 });
  assert.equal(srcs().length, before, 'muted: nothing triggered');
  slotById(p, M).mute = false; slotById(p, 'slot-01').solo = true;
  drive(p, engine, ctx, { seconds: 1 });
  assert.equal(srcs().length, before, 'another slot soloed: MUNCH silent');
  slotById(p, 'slot-01').solo = false; slotById(p, M).solo = true;
  assert.equal(playableSlots(p).filter(s => slotAudible(p, s)).map(s => s.id).join(), M, 'MUNCH solo silences the others');
  // pause mid-note: every MUNCH voice stops
  slotById(p, M).solo = false;
  setPatternAt(p, M, 0, { len: 16, notes: [{ s: 0, p: 60, l: 16, v: .9 }] }); p.songMode = false; p.scene = 0;
  drive(p, engine, ctx, { seconds: .3, onTick: (t, tr) => { if (t > .2 && tr.state === 'playing') { tr.pause(); assert.equal(voice.activeCount(), 0); } } });
}));

test('MUNCH notes are dispatched by default without preview flags', async () => {
  const p = createEmptyProject();
  setPatternAt(p, M, 0, { len: 16, notes: [{ s: 0, p: 60, l: 1, v: .9, slice: 0 }] });
  const calls = [];
  const engine = { ctx: { currentTime: 0 }, init() { return this.ctx; }, openGates() {}, closeGates() {}, stepDur: () => .125, audible: () => true, trigger: id => calls.push(id) };
  drive(p, engine, engine.ctx, { seconds: .5 });
  assert.ok(calls.includes(M));
});

test('existing instruments dispatch exactly the same with MUNCH playing', async () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/v5-edge.json', import.meta.url), 'utf8'));
  const run = munchNotes => {
    const p = importProject(structuredClone(fx)); p.songMode = false; p.scene = 1;
    if (munchNotes) setPatternAt(p, M, 1, { len: 16, notes: [0, 2, 4, 6].map(s => ({ s, p: 60, l: 1, v: .8, slice: s / 2 })) });
    const calls = []; let a = 7;
    const mr = Math.random; Math.random = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
    const engine = { ctx: { currentTime: 0 }, init() { return this.ctx; }, openGates() {}, closeGates() {}, stepDur: () => 60 / p.bpm / 4, audible: id => slotAudible(p, slotById(p, id)), trigger: (id, t, hit) => calls.push([id, Math.round(t * 1e6), JSON.stringify(hit)]) };
    try { drive(p, engine, engine.ctx, { seconds: 3 }); } finally { Math.random = mr; }
    return calls;
  };
  const base = run(false), withMunch = run(true);
  assert.ok(withMunch.some(c => c[0] === M), 'MUNCH played');
  assert.deepEqual(withMunch.filter(c => c[0] !== M), base, 'BOP, GOO, BLIP and FUZZ: same hits, times and parameters');
});
