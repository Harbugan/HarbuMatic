// MUNCH voice ownership (v0.6 stabilization, BUGS.md MUNCH-3): retrigger, choke, click-free cuts, gate/loop release on
// key and pad up, and Stop/Pause/restart leaving nothing behind — also when the transport was already stopped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setPreviewInstruments } from '../src/core/instruments.js';
import { createEmptyProject, slotById, setPatternAt } from '../src/core/project.js';
import { sampleRefFor } from '../src/core/samples.js';
import { createSampleStore, memoryBackend } from '../src/samples/store.js';
import { createSampleBank } from '../src/samples/bank.js';
import { createEngine } from '../src/audio/engine.js';
import { createTransport } from '../src/audio/scheduler.js';
import { CUT, envValueAt } from '../src/audio/voices.js';
import { makeWav, decodeWav, withFakeWindow } from './helpers/audio.mjs';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const M = 'slot-05';
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
      await fn({ p, engine, ctx, bank, voice, srcs, m: slotById(p, M) });
    });
  } finally { setPreviewInstruments(false); }
}
const gainEvents = s => s.out[0].gain.events;
/** the last cut a source received: [setValueAtTime value, time] followed by a ramp to 0 */
const lastCut = s => { const ev = gainEvents(s), i = ev.map(e => e[0]).lastIndexOf('cancelScheduledValues'); return i < 0 ? null : { at: ev[i][1], hold: ev[i + 1], ramp: ev[i + 2] }; };

test('envelope value helper interpolates the piecewise-linear envelope', () => {
  const pts = [[0, 0], [.01, 1], [.5, 1], [.6, 0]];
  assert.equal(envValueAt(pts, -1), 0); assert.ok(near(envValueAt(pts, .005), .5)); assert.equal(envValueAt(pts, .3), 1);
  assert.ok(near(envValueAt(pts, .55), .5)); assert.equal(envValueAt(pts, 9), 0);
});

test('retriggering the same slice cuts the previous one at the new hit, click-free, even with choke off', () => rig(async ({ engine, srcs, voice, m }) => {
  m.params.choke = false;
  engine.trigger(M, 1, { p: 60, v: .8, dur: .5, slice: 0 }, false);
  engine.trigger(M, 1.05, { p: 60, v: .8, dur: .5, slice: 0 }, false);
  const [a, b] = srcs(), c = lastCut(a);
  assert.ok(near(c.at, 1.05)); assert.deepEqual(c.hold.slice(0, 2), ['setValueAtTime', .8], 'held at its current level, no jump');
  assert.deepEqual([c.ramp[0], c.ramp[1]], ['linearRampToValueAtTime', 0]); assert.ok(near(c.ramp[2], 1.05 + CUT));
  assert.ok(near(a.stopAt, 1.05 + CUT + .002));
  assert.ok(b.stopAt > 1.1, 'the new hit plays');
  assert.equal(voice.stats.retriggered, 1);
  engine.trigger(M, 1.06, { p: 60, v: .8, dur: .5, slice: 2 }, false);
  assert.ok(b.stopAt > 1.1, 'another slice does not cut it with choke off');
}));

test('retriggering the same key cuts it; different keys stay polyphonic; an audition cuts the previous audition', () => rig(async ({ engine, srcs, voice }) => {
  engine.trigger(M, 0, { p: 60, v: .8, dur: 1 }, false);
  engine.trigger(M, .1, { p: 55, v: .8, dur: 1 }, false); // lower: longer than 1 s
  engine.trigger(M, .2, { p: 60, v: .8, dur: 1 }, false);
  const s = srcs();
  assert.ok(near(s[0].stopAt, .2 + CUT + .002), 'same pitch retriggers');
  assert.ok(s[1].stopAt > 1, 'a different pitch keeps sounding');
  assert.equal(voice.activeCount(), 2);
  engine.trigger(M, 2, { p: 60, v: .8, dur: .3, region: [.2, .9] }, false);
  engine.trigger(M, 2.1, { p: 60, v: .8, dur: .3, region: [.5, .9] }, false);
  assert.ok(near(srcs()[3].stopAt, 2.1 + CUT + .002), 'tapping the waveform again replaces the audition');
}));

test('a cut during the release ramp continues from the ramp value instead of jumping back up', () => rig(async ({ engine, srcs, m }) => {
  m.params.mode = 'gate'; m.params.release = .2; m.params.choke = false;
  engine.trigger(M, 0, { p: 60, v: 1, dur: .1, slice: 0 }, false); // gate: release from .1 to .3, region is .125 s → oneshot end
  m.params.mode = 'loop';
  engine.trigger(M, 1, { p: 60, v: 1, dur: .2 }, false); // loop: hold until 1.2, release to 1.4
  engine.trigger(M, 1.3, { p: 60, v: 1, dur: .2 }, false); // retrigger halfway through the release
  const c = lastCut(srcs()[1]);
  assert.ok(near(c.hold[1], .5, 1e-6), `continues at the current level (${c.hold[1]})`);
}));

test('key up during the attack releases from the current level (no jump to full velocity)', () => rig(async ({ engine, ctx, srcs, m }) => {
  m.params.mode = 'gate'; m.params.attack = .1; m.params.release = .05;
  const h = engine.noteOn(M, 60, 1);
  ctx.advance(.055); // halfway into the 0.1 s attack (noteOn starts at +5 ms)
  engine.noteOff(h);
  const ev = gainEvents(srcs()[0]), hold = ev[ev.length - 2];
  assert.equal(hold[0], 'setValueAtTime'); assert.ok(near(hold[1], .5, 1e-6), `released from ${hold[1]}`);
}));

test('pads: Gate stops on release, Loop loops while held, One-shot plays the whole slice', () => rig(async ({ engine, ctx, srcs, m }) => {
  m.params.mode = 'gate'; m.params.release = .02;
  const g = engine.noteOn(M, 60, .9, { slice: 1 });
  assert.ok(near(srcs()[0].startArgs[1], .125), 'pad plays its slice');
  ctx.advance(.05); assert.equal(engine.noteOff(g), true);
  assert.ok(near(srcs()[0].stopAt, .05 + .02 + .002));
  m.params.mode = 'loop';
  const l = engine.noteOn(M, 60, .9, { slice: 1 });
  assert.ok(srcs()[1].loop && srcs()[1].stopAt > 30, 'loops while held');
  ctx.advance(1); engine.noteOff(l);
  assert.ok(near(srcs()[1].stopAt, 1 + .02 + .002));
  m.params.mode = 'oneshot';
  const o = engine.noteOn(M, 60, .9, { slice: 1 });
  assert.equal(engine.noteOff(o), false);
  assert.ok(near(srcs()[2].stopAt, 1.005 + .125 + .002));
}));

test('Stop silences auditions and held keys even when the transport is already stopped', () => rig(async ({ p, engine, ctx, voice }) => {
  const tr = createTransport(engine, () => p);
  assert.equal(tr.state, 'stopped');
  engine.audition(M, 60, .8); // "hear the whole sound"
  p.slots.find(s => s.id === M).params.mode = 'loop';
  engine.noteOn(M, 64, .8); // a held, looping key
  assert.equal(voice.activeCount(), 2);
  ctx.advance(.3);
  tr.stop();
  assert.equal(voice.activeCount(), 0);
  ctx.advance(.3 + CUT + .01);
  assert.equal(ctx.live.size, 0, 'everything ended within the cut time');
}));

test('Play/Stop/restart cycles: Stop leaves no voice running and a restart starts clean', () => rig(async ({ p, engine, ctx, voice }) => {
  setPatternAt(p, M, 0, { len: 16, notes: [0, 4, 8, 12].map((s, k) => ({ s, p: 60, l: 4, v: .8, slice: k })) });
  let tick; const si = globalThis.setInterval, ci = globalThis.clearInterval;
  globalThis.setInterval = fn => { tick = fn; return 1; }; globalThis.clearInterval = () => {};
  try {
    const tr = createTransport(engine, () => p);
    let t = 0;
    for (let round = 0; round < 10; round++) {
      tr.play();
      for (let i = 0; i < 80; i++) { t += .01; ctx.advance(t); tick(); }
      tr.stop();
      assert.equal(voice.activeCount(), 0, `round ${round}: silent after Stop`);
      t += .05; ctx.advance(t);
      assert.equal([...ctx.live].filter(s => s.buffer && s.buffer.length === 1000).length, 0, `round ${round}: no orphaned MUNCH sources`);
    }
  } finally { globalThis.setInterval = si; globalThis.clearInterval = ci; }
}));

test('a voice scheduled later is never cut by an earlier hit', () => rig(async ({ engine, srcs }) => {
  engine.trigger(M, 2, { p: 60, v: .8, dur: .1, slice: 0 }, false);
  engine.trigger(M, 1, { p: 60, v: .8, dur: .1, slice: 0 }, false);
  assert.ok(near(srcs()[0].stopAt, 2 + .125 + .002));
}));
