// MUNCH Phase 4 audio: tape fit in the voice (and through the transport), choke, held keyboard notes, editor
// auditions of an explicit region, and waveform peaks. Fake Web Audio graph (tests/helpers/audio.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import { setPreviewInstruments } from '../src/core/instruments.js';
import { createEmptyProject, slotById, setPatternAt } from '../src/core/project.js';
import { sampleRefFor, defaultSlices } from '../src/core/samples.js';
import { createSampleStore, memoryBackend } from '../src/samples/store.js';
import { createSampleBank } from '../src/samples/bank.js';
import { computePeaks, peaksForView, PEAK_BUCKET } from '../src/samples/peaks.js';
import { createEngine } from '../src/audio/engine.js';
import { createTransport } from '../src/audio/scheduler.js';
import { makeWav, decodeWav, withFakeWindow, FakeBuffer } from './helpers/audio.mjs';
import { CUT } from '../src/audio/voices.js';

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
      await fn({ p, engine, ctx, bank, voice, meta, srcs, m: slotById(p, M) });
    });
  } finally { setPreviewInstruments(false); }
}

test('fit off: playback exactly as in Phase 3', () => rig(async ({ engine, srcs }) => {
  engine.trigger(M, 1, { p: 60, v: .8, dur: .1 }, false);
  engine.trigger(M, 2, { p: 60, v: .8, dur: .1, slice: 1 }, false);
  assert.deepEqual(srcs().map(s => s.playbackRate.value), [1, 1]);
}));

test('tape fit: the trimmed region fills the bars at the current BPM; BPM changes re-fit', () => rig(async ({ p, engine, srcs, m }) => {
  m.params.fit = 'half'; p.bpm = 120; // half a bar @120 = 1 s = the whole sample
  engine.trigger(M, 1, { p: 60, v: .8, dur: .1 }, false);
  assert.equal(srcs()[0].playbackRate.value, 1);
  p.bpm = 60; // half a bar = 2 s → half speed
  engine.trigger(M, 2, { p: 60, v: .8, dur: .1 }, false);
  assert.ok(near(srcs()[1].playbackRate.value, .5));
  assert.ok(near(srcs()[1].stopAt, 2 + 2 + .002), 'the region now lasts the half bar');
  m.params.start = .5; // only half the sample is the region: 0.5 s → 2 s = ×0.25 → clamped to ×0.5
  engine.trigger(M, 3, { p: 60, v: .8, dur: .1 }, false);
  assert.ok(near(srcs()[2].playbackRate.value, .5), 'outside the usable range playback clamps');
}));

test('fit multiplies pitch, tune and transposition; slices share the tape speed, applied once', () => rig(async ({ p, engine, srcs, m }) => {
  m.params.fit = '1'; p.bpm = 120; // 1 s → 2 s = ×0.5
  m.params.tune = 12;
  engine.trigger(M, 1, { p: 60, v: .8, dur: .1 }, false); // +12 tune × 0.5 fit = 1
  engine.trigger(M, 2, { p: 72, v: .8, dur: .1, slice: 0 }, false); // +12 transpose +12 tune × 0.5 = 2
  assert.ok(near(srcs()[0].playbackRate.value, 1));
  assert.ok(near(srcs()[1].playbackRate.value, 2));
  assert.equal(m.params.tune, 12, 'tune is not overwritten by fit');
}));

test('through the transport: fitted slices land one per beat and play at the fit rate (not squared)', () => rig(async ({ p, engine, ctx, srcs, m }) => {
  m.params.fit = '1'; m.params.fitMode = 'tape'; p.bpm = 120; m.sample.slices = defaultSlices(4); // 4 slices, 1 s → 1 bar (2 s): 0.5 s per slice
  setPatternAt(p, M, 0, { len: 16, notes: [0, 1, 2, 3].map(k => ({ s: k * 4, p: 60, l: 4, v: .8, slice: k })) });
  let tick; const si = globalThis.setInterval, ci = globalThis.clearInterval;
  globalThis.setInterval = fn => { tick = fn; return 1; }; globalThis.clearInterval = () => {};
  try {
    const tr = createTransport(engine, () => p);
    tr.play();
    for (let t = 0; t <= 1.9; t += .01) { ctx.currentTime = t; tick(); } // drive the scheduler like the browser would
    srcs().forEach(x => { x.plannedStop = x.stopAt; });
    tr.stop();
  } finally { globalThis.setInterval = si; globalThis.clearInterval = ci; }
  const s = srcs();
  assert.ok(s.length >= 4, `scheduled ${s.length}`);
  s.slice(0, 4).forEach((x, k) => {
    assert.ok(near(x.playbackRate.value, .5), `slice ${k} at ×0.5`);
    const len = x.plannedStop - .002 - x.startArgs[0];
    assert.ok(near(len, .5, 1e-6), `slice ${k} lasts exactly one beat (${len})`);
  });
}));

test('choke: a slice cuts the slice still sounding; on by default, Overlap lets slices ring', () => rig(async ({ engine, srcs, voice, m }) => {
  m.params.choke = false;
  engine.trigger(M, 1, { p: 60, v: .8, dur: .1, slice: 0 }, false);
  engine.trigger(M, 1.05, { p: 60, v: .8, dur: .1, slice: 3 }, false);
  assert.ok(near(srcs()[0].stopAt, 1 + .125 + .002), 'without choke both play to their end');
  m.params.choke = true;
  engine.trigger(M, 2, { p: 60, v: .8, dur: .1, slice: 0 }, false);
  engine.trigger(M, 2.05, { p: 60, v: .8, dur: .1, slice: 3 }, false);
  assert.ok(near(srcs()[2].stopAt, 2.05 + CUT + .002), 'the first slice is cut when the next one starts');
  assert.ok(voice.stats.choked >= 1);
  engine.trigger(M, 3, { p: 60, v: .8, dur: .1 }, false); // melodic notes never choke
  engine.trigger(M, 3.01, { p: 64, v: .8, dur: .1 }, false);
  assert.ok(near(srcs()[4].stopAt, 4.002), 'melodic notes are polyphonic');
}));

test('held keyboard notes: loop and gate release on key up, one-shots play on', () => rig(async ({ engine, ctx, srcs, m }) => {
  m.params.mode = 'loop'; m.params.release = .1;
  const h = engine.noteOn(M, 60, .9);
  const s = srcs()[0];
  assert.ok(h && s.loop && s.stopAt > 30, 'a looped key holds');
  ctx.advance(.7);
  assert.equal(engine.noteOff(h), true);
  assert.ok(near(s.stopAt, .7 + .1 + .002), 'released with the release time');
  m.params.mode = 'gate';
  const g = engine.noteOn(M, 60, .9); ctx.advance(.9); engine.noteOff(g);
  assert.ok(near(srcs()[1].stopAt, .9 + .1 + .002));
  m.params.mode = 'oneshot';
  const o = engine.noteOn(M, 60, .9);
  assert.equal(engine.noteOff(o), false, 'one-shot ignores key up');
  assert.ok(near(srcs()[2].stopAt, .9 + .005 + 1 + .002), 'plays the whole region');
  const vel = srcs()[2].out[0].gain.events.find(e => e[0] === 'linearRampToValueAtTime');
  assert.ok(near(vel[1], .9), 'velocity reaches the envelope');
  assert.equal(engine.noteOff(null), false);
}));

test('polyphony: several held keys sound together', () => rig(async ({ engine, voice, m }) => {
  m.params.mode = 'loop';
  const hs = [60, 64, 67].map(p => engine.noteOn(M, p, .8));
  assert.equal(voice.activeCount(), 3);
  hs.forEach(h => engine.noteOff(h));
}));

test('editor audition of an explicit region', () => rig(async ({ engine, srcs }) => {
  engine.audition(M, 60, .8, { region: [.5, .75] });
  const s = srcs()[0];
  assert.ok(near(s.startArgs[1], .5)); assert.ok(near(s.stopAt - s.startArgs[0], .25 + .002));
}));

test('waveform peaks: min/max per bucket over all channels, aggregated per pixel column', async () => {
  const b = new FakeBuffer(2, 640, 1000);
  for (let i = 0; i < 640; i++) { b.data[0][i] = i < 320 ? .5 : -.25; b.data[1][i] = i === 100 ? -.9 : 0; }
  const pk = computePeaks(b);
  assert.equal(pk.min.length, 640 / PEAK_BUCKET); assert.equal(pk.frames, 640);
  assert.ok(near(pk.max[0], .5, 1e-6) && near(pk.min[1], -.9, 1e-6) && near(pk.min[9], -.25, 1e-6));
  const v = peaksForView(pk, 0, 1, 2);
  assert.ok(near(v.max[0], .5, 1e-6) && near(v.min[0], -.9, 1e-6) && near(v.max[1], 0, 1e-6) && near(v.min[1], -.25, 1e-6));
  const z = peaksForView(pk, .5, 1, 5);
  assert.ok([...z.max].every(x => near(x, 0, 1e-6)), 'zoomed into the second half');
  assert.equal(peaksForView(null, 0, 1, 3).min.length, 3);
  // the bank caches peaks with the decoded buffer
  const store = createSampleStore({ backend: memoryBackend(), decode: decodeWav });
  const bank = createSampleBank({ store, decode: decodeWav });
  const { meta } = await bank.importBytes({ bytes: makeWav({ seconds: .5, rate: 8000 }), name: 'x.wav' });
  const p1 = bank.peaks(meta.id);
  assert.ok(p1 && p1.min.length === Math.ceil(4000 / PEAK_BUCKET));
  assert.equal(bank.peaks(meta.id), p1, 'computed once');
  assert.equal(bank.peaks('smp-' + '0'.repeat(64)), null, 'nothing before a sample is ready');
});
