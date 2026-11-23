// Fit to Beat: Stretch (pitch kept, the default) vs Tape (pitch follows speed) — v0.6 stabilization, BUGS.md MUNCH-4.
// DSP (src/samples/stretch.js), the bank's stretched copies, the voice and the transport on a fake Web Audio graph.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stretchChannels, anchorsFromSlices } from '../src/samples/stretch.js';
import { runSliced } from '../src/samples/stretch-runner.js';
import { setPreviewInstruments } from '../src/core/instruments.js';
import { createEmptyProject, slotById, setPatternAt } from '../src/core/project.js';
import { sampleRefFor, defaultSlices, fitInfo, fitPlayback, notePlaybackRate } from '../src/core/samples.js';
import { createSampleStore, memoryBackend } from '../src/samples/store.js';
import { createSampleBank, quantizeStretch } from '../src/samples/bank.js';
import { createEngine } from '../src/audio/engine.js';
import { createTransport } from '../src/audio/scheduler.js';
import { makeWav, decodeWav, withFakeWindow } from './helpers/audio.mjs';

const SR = 48000;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const sine = (f, sec, sr = SR, amp = .5) => Float32Array.from({ length: Math.round(sr * sec) }, (_, i) => amp * Math.sin(2 * Math.PI * f * i / sr));
/** frequency from rising zero crossings */
const freqOf = (x, a, b, sr = SR) => { let z = 0, first = -1, last = -1; for (let i = a + 1; i < b; i++) if (x[i - 1] <= 0 && x[i] > 0) { z++; if (first < 0) first = i; last = i; } return (z - 1) / ((last - first) / sr); };
const rms = (x, a, b) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };

/* ---------- DSP ---------- */
test('Stretch keeps the pitch at every usable fit factor and makes the duration exact', () => {
  for (const f of [.5, .75, 1.25, 1.5, 2]) {
    const x = sine(440, 1);
    const [y] = stretchChannels([x], SR, f);
    assert.equal(y.length, Math.round(x.length * f), `length ×${f}`);
    const hz = freqOf(y, Math.round(y.length * .1), Math.round(y.length * .9));
    assert.ok(Math.abs(hz - 440) < 440 * .01, `×${f}: ${hz.toFixed(1)} Hz (want 440)`);
    for (let w = Math.round(y.length * .05); w + 960 < y.length * .95; w += 960) assert.ok(rms(y, w, w + 960) > .3, `×${f}: steady level at ${w}`);
  }
});

test('Tape is a different thing: its playback rate moves pitch with speed, Stretch\'s does not', () => {
  const p = { start: 0, end: 1, root: 60, tune: 0, fit: '1', fitFine: 0 };
  const tape = fitInfo({ ...p, fitMode: 'tape' }, 2.5, 120), str = fitInfo({ ...p, fitMode: 'stretch' }, 2.5, 120);
  assert.ok(near(tape.rate, 1.25) && near(str.rate, 1.25), 'same timing in both modes');
  assert.ok(near(tape.semitones, 12 * Math.log2(1.25))); assert.equal(str.semitones, 0);
  assert.deepEqual(fitPlayback({ ...p, fitMode: 'tape' }, 2.5, 120), { tapeRate: 1.25, stretch: 1 });
  const sp = fitPlayback({ ...p, fitMode: 'stretch' }, 2.5, 120);
  assert.equal(sp.tapeRate, 1); assert.ok(near(sp.stretch, .8));
  // BPM change: tape pitch moves, stretch pitch does not
  for (const bpm of [90, 120, 150]) {
    assert.ok(near(notePlaybackRate({ p: 60 }, { ...p, fitMode: 'stretch' }, 2.5, bpm), 1), `stretch @${bpm}`);
    assert.ok(near(notePlaybackRate({ p: 60 }, { ...p, fitMode: 'tape' }, 2.5, bpm), 2.5 / (240 / bpm)), `tape @${bpm}`);
  }
});

test('anchors: every slice starts exactly at its scaled position with its attack copied sample for sample', () => {
  const len = SR, x = new Float32Array(len), slices = defaultSlices(8);
  const anchors = anchorsFromSlices(slices, len);
  // a decaying "hit" at every slice start
  for (const a of anchors.slice(0, -1)) for (let i = 0; i < 2000 && a + i < len; i++) x[a + i] += Math.exp(-i / 300) * Math.sin(i * .3);
  for (const f of [.6, 1.5]) {
    const [y] = stretchChannels([x], SR, f, { anchors });
    for (const a of anchors.slice(0, -1)) {
      const A = Math.round(a * f);
      for (let i = 0; i < 300; i++) assert.ok(Math.abs(y[A + i] - x[a + i]) < 1e-6, `×${f}: attack at ${a} is exact (sample ${i})`);
    }
  }
});

test('a segment never reads past its end: no pre-echo of the next hit', () => {
  const len = SR, x = new Float32Array(len), b = len / 2;
  for (let i = 0; i < 4000; i++) x[b + i] = Math.exp(-i / 400) * Math.sin(i * .2); // silence, then a hit at the anchor
  const [y] = stretchChannels([x], SR, 1.8, { anchors: [b] });
  const B = Math.round(b * 1.8);
  let pre = 0; for (let i = 0; i < B; i++) pre = Math.max(pre, Math.abs(y[i]));
  assert.ok(pre < 1e-6, `silent before the hit (${pre})`);
  assert.ok(Math.abs(y[B + 10] - x[b + 10]) < 1e-6);
});

test('stereo: both channels use the same positions (the image is kept)', () => {
  const l = sine(330, .5), r = l.map(v => -v);
  const [a, b] = stretchChannels([l, r], SR, 1.3, { anchors: [6000, 12000] });
  for (let i = 0; i < a.length; i += 97) assert.ok(Math.abs(a[i] + b[i]) < 1e-6);
});

test('the time-sliced main-thread runner gives the same result as the direct call', async () => {
  const x = sine(220, .3), anchors = [3000, 9000];
  const [direct] = stretchChannels([x], SR, 1.4, { anchors });
  const [sliced] = await runSliced([x], SR, 1.4, anchors, { sliceMs: 0 });
  assert.equal(sliced.length, direct.length);
  for (let i = 0; i < direct.length; i += 31) assert.equal(sliced[i], direct[i]);
});

test('performance: the 30 s stereo worst case renders in reasonable time', () => {
  const l = sine(220, 30), r = sine(330, 30), t0 = performance.now();
  const out = stretchChannels([l, r], SR, 1 / .6, { anchors: anchorsFromSlices(defaultSlices(16), l.length) });
  const ms = performance.now() - t0;
  assert.equal(out[0].length, Math.round(l.length / .6));
  assert.ok(ms < 8000, `${ms.toFixed(0)} ms`);
});

/* ---------- bank + voice + transport ---------- */
const M = 'slot-05';
async function rig(fn, { seconds = 1, params = {} } = {}) {
  setPreviewInstruments(true);
  try {
    await withFakeWindow(async getCtx => {
      const store = createSampleStore({ backend: memoryBackend(), decode: decodeWav });
      const bank = createSampleBank({ store, decode: decodeWav, stretchDelayMs: 1 });
      const p = createEmptyProject();
      const { meta } = await store.importBytes({ bytes: makeWav({ seconds, rate: 8000, freq: 440 }), name: 'tone.wav' });
      Object.assign(slotById(p, M), { sample: sampleRefFor(meta) });
      Object.assign(slotById(p, M).params, params);
      const engine = createEngine(() => p, { samples: bank });
      engine.init();
      const ctx = getCtx();
      await bank.pin([meta.id]);
      engine.applyAll();
      const voice = engine.E.ch.get(M).voice;
      const prep = async () => { const m = slotById(p, M), fp = fitPlayback(m.params, m.sample.duration, p.bpm); if (fp.stretch !== 1) bank.requestStretch(meta.id, fp.stretch, m.sample.slices); await bank.stretchIdle(); };
      await fn({ p, engine, ctx, bank, voice, meta, prep, m: slotById(p, M), all: () => ctx.sources.filter(s => s.buffer) });
    });
  } finally { setPreviewInstruments(false); }
}

test('Stretch is the default fit mode: fitted notes play a stretched copy at the musical pitch', () => rig(async ({ p, engine, voice, prep, all, m }) => {
  assert.equal(m.params.fitMode, 'stretch');
  m.params.fit = '1'; p.bpm = 120; // 1 s → 2 s: stretch ×2
  await prep();
  engine.trigger(M, 1, { p: 60, v: .8, dur: .1 }, false);
  const s = all().at(-1);
  assert.equal(s.buffer.length, 16000, 'the stretched copy (×2) plays');
  assert.ok(near(s.playbackRate.value, 1, 1e-9), 'at the musical pitch');
  assert.ok(near(s.stopAt - .002 - 1, 2, 1e-6), 'and lasts exactly one bar');
  assert.equal(voice.stats.stretched, 1);
}));

test('a BPM change in Stretch keeps the pitch; until the new copy exists the closest one plays with exact timing', () => rig(async ({ p, engine, prep, bank, meta, all, m }) => {
  m.params.fit = '1'; p.bpm = 120;
  await prep();
  p.bpm = 126; // no new render yet
  engine.trigger(M, 1, { p: 60, v: .8, dur: .1 }, false);
  let s = all().at(-1);
  assert.equal(s.buffer.length, 16000, 'closest copy');
  assert.ok(near(s.stopAt - .002 - 1, 240 / 126, 1e-6), 'timing exact at the new tempo');
  assert.ok(Math.abs(Math.log2(s.playbackRate.value) * 12) < 1, `small residual only (${s.playbackRate.value.toFixed(4)})`);
  await bank.stretchIdle(); // the trigger queued the exact render
  engine.trigger(M, 4, { p: 60, v: .8, dur: .1 }, false);
  s = all().at(-1);
  assert.equal(s.buffer.length, Math.round(8000 * quantizeStretch(240 / 126)), 'the new copy plays');
  assert.ok(Math.abs(s.playbackRate.value - 1) < .002, 'at (essentially) the musical pitch');
  assert.ok(near(s.stopAt - .002 - 4, 240 / 126, 1e-6));
  assert.ok(bank.stretched(meta.id, false, 240 / 126, m.sample.slices).stretch > 1.9);
}));

test('Tape changes pitch with speed and never uses a stretched copy', () => rig(async ({ p, engine, voice, all, m }) => {
  m.params.fit = '1'; m.params.fitMode = 'tape'; p.bpm = 120;
  engine.trigger(M, 1, { p: 60, v: .8, dur: .1 }, false);
  const s = all().at(-1);
  assert.equal(s.buffer.length, 8000); assert.ok(near(s.playbackRate.value, .5));
  assert.ok(near(s.stopAt - .002 - 1, 2, 1e-6));
  assert.equal(voice.stats.stretched + voice.stats.stretchFallback, 0);
}));

test('transposition and tune stay independent of Stretch', () => rig(async ({ p, engine, prep, all, m }) => {
  m.params.fit = '1'; m.params.tune = 2; p.bpm = 120;
  await prep();
  engine.trigger(M, 1, { p: 72, v: .8, dur: .1 }, false);
  const s = all().at(-1);
  assert.ok(near(s.playbackRate.value, Math.pow(2, 14 / 12), 1e-9), 'octave + tune on the stretched copy');
}));

test('through the transport in Stretch: slices land one per beat, last exactly one beat, at the original pitch', () => rig(async ({ p, engine, ctx, prep, all, m }) => {
  m.params.fit = '1'; p.bpm = 120; m.sample.slices = defaultSlices(4);
  await prep();
  setPatternAt(p, M, 0, { len: 16, notes: [0, 1, 2, 3].map(k => ({ s: k * 4, p: 60, l: 4, v: .8, slice: k })) });
  let tick; const si = globalThis.setInterval, ci = globalThis.clearInterval;
  globalThis.setInterval = fn => { tick = fn; return 1; }; globalThis.clearInterval = () => {};
  try {
    const tr = createTransport(engine, () => p);
    tr.play();
    for (let t = 0; t <= 1.9; t += .01) { ctx.currentTime = t; tick(); }
    all().forEach(x => { x.plannedStop = x.stopAt; });
    tr.stop();
  } finally { globalThis.setInterval = si; globalThis.clearInterval = ci; }
  const s = all().filter(x => x.buffer.length === 16000);
  assert.ok(s.length >= 4, `scheduled ${s.length}`);
  s.slice(0, 4).forEach((x, k) => {
    assert.ok(near(x.playbackRate.value, 1, 1e-9), `slice ${k} at the original pitch`);
    assert.ok(near(x.startArgs[1], k * .5, 1e-9), `slice ${k} starts at its stretched position`);
    assert.ok(near(x.plannedStop - .002 - x.startArgs[0], .5, 1e-6), `slice ${k} lasts one beat`);
  });
}));

test('switching Stretch ⇄ Tape while voices play leaves nothing stuck', () => rig(async ({ p, engine, ctx, prep, voice, m }) => {
  m.params.fit = '1'; p.bpm = 120; m.params.mode = 'loop';
  await prep();
  const h = engine.noteOn(M, 60, .8);
  m.params.fitMode = 'tape';
  const h2 = engine.noteOn(M, 64, .8);
  ctx.advance(.5); engine.noteOff(h); engine.noteOff(h2);
  ctx.advance(2);
  assert.equal(voice.activeCount(), 0);
  assert.equal([...ctx.live].length, 0);
}));
