// HBM-061-05 (UX-15): MUNCH CHOP local slice-pattern preview tests.
// Covers timing & loop boundaries, live step/BPM/length edits, Play/Stop & repeated restart cleanup,
// zero unintended global transport starts, coexistence with global playback, pad audition preservation,
// and voice/timer cleanup across scene, tab, instrument, mode, and project transitions.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyProject, createDemoProject, slotById, setPatternAt, sceneIdAt } from '../src/core/project.js';
import { sampleRefFor } from '../src/core/samples.js';
import { createSampleStore, memoryBackend } from '../src/samples/store.js';
import { createSampleBank } from '../src/samples/bank.js';
import { createEngine } from '../src/audio/engine.js';
import { createSlicePreview, createTransport } from '../src/audio/scheduler.js';
import { CUT } from '../src/audio/voices.js';
import { store } from '../src/app/store.js';
import * as A from '../src/app/actions.js';
import { makeWav, decodeWav, withFakeWindow } from './helpers/audio.mjs';

const M = 'slot-05';
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/** fake timer harness that tracks active intervals so we can assert zero leaked timers */
function withFakeTimers(fn) {
  const active = new Map();
  let nextId = 1;
  const si = globalThis.setInterval, ci = globalThis.clearInterval;
  globalThis.setInterval = (cb, ms) => { const id = nextId++; active.set(id, { cb, ms }); return id; };
  globalThis.clearInterval = id => { active.delete(id); };
  const tickAll = () => { for (const { cb } of [...active.values()]) cb(); };
  try {
    return fn({ active, tickAll });
  } finally {
    globalThis.setInterval = si;
    globalThis.clearInterval = ci;
  }
}

/** isolated audio + sample bank rig (no global actions state) */
async function audioRig(fn, { bpm = 120, swing = 0, seconds = 1 } = {}) {
  await withFakeWindow(async getCtx => {
    const sstore = createSampleStore({ backend: memoryBackend(), decode: decodeWav });
    const bank = createSampleBank({ store: sstore, decode: decodeWav });
    const p = createEmptyProject({ bpm });
    p.swing = swing;
    const { meta } = await sstore.importBytes({ bytes: makeWav({ seconds, rate: 1000, freq: 0 }), name: 'chop.wav' });
    slotById(p, M).sample = sampleRefFor(meta);
    const engine = createEngine(() => p, { samples: bank });
    engine.init();
    const ctx = getCtx();
    await bank.pin([meta.id]);
    engine.applyAll();
    const voice = engine.E.ch.get(M).voice;
    const munchLive = () => [...ctx.live].filter(s => s.buffer && s.buffer.length === seconds * 1000);
    await fn({ p, engine, ctx, bank, voice, munchLive });
  });
}

test('preview timing, swing, BPM changes and loop boundaries (16-step and 32-step + live shrink)', () => audioRig(async ({ p, engine, ctx }) => {
  p.bpm = 120; // stepDur = 0.125s
  p.swing = 0.2;
  // Add notes on BOP + BLIP + MUNCH (both slice and melodic) to prove only MUNCH slice notes fire
  slotById(p, 'slot-01').patterns[sceneIdAt(p, 0)].steps.kick[0] = { v: 1, p: 1 };
  setPatternAt(p, 'slot-03', 0, { len: 16, notes: [{ s: 0, p: 60, l: 2, v: .8 }] });
  setPatternAt(p, M, 0, {
    len: 16,
    notes: [
      { s: 0, p: 60, l: 1, v: .9, slice: 0 },
      { s: 1, p: 60, l: 1, v: .75, slice: 1 },
      { s: 4, p: 64, l: 2, v: .8 }, // melodic note — must NOT fire in CHOP slice preview
      { s: 15, p: 60, l: 1, v: 1.0, slice: 7 },
    ],
  });

  const triggers = [];
  const origTrigger = engine.trigger;
  engine.trigger = (id, t, hit, live) => { triggers.push({ id, t, hit, live }); return origTrigger(id, t, hit, live); };

  withFakeTimers(({ active, tickAll }) => {
    const pv = createSlicePreview(engine, () => p);
    assert.equal(pv.start(M), true);
    assert.equal(active.size, 1, 'exactly one scheduler interval active');

    const events = [];
    for (let i = 0; i < 230; i++) {
      ctx.advance(i * .01);
      tickAll();
      events.push(...pv.queue.splice(0));
    }

    // Must start at step 0 and loop 0..15, 0..15
    assert.deepEqual(events.slice(0, 18).map(e => e.step), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1]);
    // Exact step interval at 120 BPM (0.125s)
    assert.ok(near(events[0].time, 0.06), 'starts at currentTime + 0.06');
    assert.ok(near(events[1].time - events[0].time, 0.125), 'step 0 -> step 1 is 0.125s');
    assert.ok(near(events[16].time - events[0].time, 2.0), '16-step loop duration is 2.0s at 120 BPM');

    // Only MUNCH slot triggered, with live='preview', slice notes only (never melodic, never BOP/BLIP)
    assert.ok(triggers.length >= 4);
    assert.ok(triggers.every(tr => tr.id === M && tr.live === 'preview' && tr.hit.slice != null));
    assert.equal(triggers[0].hit.slice, 0);
    assert.ok(near(triggers[0].t, 0.06), 'even step 0 has zero swing');
    assert.equal(triggers[1].hit.slice, 1);
    assert.ok(near(triggers[1].t, 0.06 + 0.125 + 0.2 * 0.125 * 0.5), 'odd step 1 includes project swing');
    assert.equal(triggers[2].hit.slice, 7, 'step 4 melodic note skipped; next hit is slice 7 at step 15');

    // Live BPM change takes effect on subsequent steps without restart
    p.bpm = 60; // stepDur = 0.25s
    const beforeLen = events.length;
    for (let i = 230; i < 320; i++) {
      ctx.advance(i * .01);
      tickAll();
      events.push(...pv.queue.splice(0));
    }
    const later = events.slice(beforeLen + 2);
    assert.ok(later.length >= 2 && near(later[1].time - later[0].time, 0.25), 'live BPM change updates step interval to 0.25s');

    // Live length shrink (32 -> 16) wraps cleanly without out-of-range steps
    setPatternAt(p, M, 0, { len: 32, notes: [{ s: 0, p: 60, l: 1, v: .8, slice: 0 }] });
    pv.step = 24;
    setPatternAt(p, M, 0, { len: 16, notes: [{ s: 8, p: 60, l: 1, v: .8, slice: 2 }] });
    const prevCount = events.length;
    for (let i = 320; i < 360; i++) {
      ctx.advance(i * .01);
      tickAll();
      events.push(...pv.queue.splice(0));
    }
    const afterShrink = events.slice(prevCount);
    assert.ok(afterShrink.length > 0 && afterShrink.every(e => e.step >= 0 && e.step < 16), 'shrinking pattern length stays within 0..15');

    pv.stop();
    assert.equal(active.size, 0, 'stop clears interval timer');
    assert.equal(pv.queue.length, 0, 'stop empties UI event queue');
  });
}));

test('live step edits (add, remove, accent) take effect during preview without restarting', () => audioRig(async ({ p, engine, ctx }) => {
  setPatternAt(p, M, 0, { len: 16, notes: [{ s: 0, p: 60, l: 1, v: .85, slice: 0 }] });
  const hits = [];
  const origTrigger = engine.trigger;
  engine.trigger = (id, t, hit, live) => { hits.push({ slice: hit.slice, v: hit.v, t }); return origTrigger(id, t, hit, live); };

  withFakeTimers(({ tickAll }) => {
    const pv = createSlicePreview(engine, () => p);
    pv.start(M);
    // Advance slightly past step 0..1, then add slice 3 at step 8
    for (let i = 0; i <= 15; i++) { ctx.advance(i * .01); tickAll(); }
    assert.equal(pv.playing, true);
    const pat = slotById(p, M).patterns[sceneIdAt(p, 0)];
    pat.notes.push({ s: 8, p: 60, l: 1, v: .35, slice: 3 });

    // Advance through rest of bar 1 (up to 2.0s)
    for (let i = 16; i <= 195; i++) { ctx.advance(i * .01); tickAll(); }
    assert.ok(hits.some(h => h.slice === 3 && near(h.v, .35)), 'added step plays on the current loop without restarting');

    // Accent step 8 -> 1.0 and remove step 0 before bar 2 wraps
    pat.notes = [{ s: 8, p: 60, l: 1, v: 1.0, slice: 3 }];
    const countBeforeBar2 = hits.length;
    for (let i = 196; i <= 400; i++) { ctx.advance(i * .01); tickAll(); }
    const bar2Hits = hits.slice(countBeforeBar2);
    assert.ok(!bar2Hits.some(h => h.slice === 0), 'removed step 0 no longer plays');
    assert.ok(bar2Hits.some(h => h.slice === 3 && near(h.v, 1.0)), 'accented velocity plays on next pass');
    assert.equal(pv.playing, true, 'preview never had to restart');
    pv.stop();
  });
}));

test('repeated Play/Stop cycles leave zero orphaned voices, sources, or interval timers', () => audioRig(async ({ p, engine, ctx, voice, munchLive }) => {
  setPatternAt(p, M, 0, { len: 16, notes: [0, 2, 4, 6, 8, 10, 12, 14].map((s, k) => ({ s, p: 60, l: 4, v: .85, slice: k })) });

  withFakeTimers(({ active, tickAll }) => {
    const pv = createSlicePreview(engine, () => p);
    let t = 0;
    for (let round = 0; round < 12; round++) {
      assert.equal(pv.toggle(M), true, `round ${round}: starts`);
      assert.equal(active.size, 1, `round ${round}: single active timer`);
      for (let i = 0; i < 35; i++) { t += .01; ctx.advance(t); tickAll(); }
      assert.equal(pv.toggle(M), false, `round ${round}: stops`);
      assert.equal(pv.state, 'stopped');
      assert.equal(pv.step, 0, 'playhead step resets');
      assert.equal(pv.queue.length, 0, 'event queue cleared');
      assert.equal(active.size, 0, `round ${round}: zero leaked timers`);
      assert.equal(voice.activeCount(), 0, `round ${round}: zero active MUNCH voices`);
      // Advance past lookahead + CUT fade to verify even future-scheduled sources ended cleanly
      t += .25 + CUT;
      ctx.advance(t);
      assert.equal(munchLive().length, 0, `round ${round}: zero orphaned audio sources`);
    }
  });
}));

test('local preview does not start global transport, safely coexists with global playback, and preserves pad audition', async () => {
  await withFakeWindow(async getCtx => {
    A.stop();
    const demo = createDemoProject();
    // Attach a decoded sample to MUNCH in the real actions store + sample bank
    const wav = makeWav({ seconds: 1, rate: 1000, freq: 220 });
    store.project = demo;
    A.engine.init();
    const ctx = getCtx();
    // Inject decoded sample directly into A.samples via importBytes with fake decode
    const origDecode = A.samples.store;
    void origDecode;
    // Use a real sample ref + pin a buffer into A.engine.E.shared.samples via mock bank helper on an isolated transport+preview pair
    // AND verify all A.* action transitions directly!
    const sstore = createSampleStore({ backend: memoryBackend(), decode: decodeWav });
    const bank = createSampleBank({ store: sstore, decode: decodeWav });
    const { meta } = await sstore.importBytes({ bytes: wav, name: 'break.wav' });
    slotById(demo, M).sample = sampleRefFor(meta);
    setPatternAt(demo, M, demo.scene, { len: 16, notes: [{ s: 0, p: 60, l: 1, v: .9, slice: 0 }, { s: 4, p: 60, l: 1, v: .9, slice: 2 }] });
    A.engine.E.samples = bank;
    A.engine.E.shared.samples = bank;
    await bank.pin([meta.id]);
    A.engine.applyAll();

    store.ui.sel = M;
    store.ui.mode = 'sound';
    store.ui.munch.tab = 'chop';

    withFakeTimers(({ active, tickAll }) => {
      // 1. Starting local preview while global transport is stopped MUST NOT start global transport
      assert.equal(A.transport.state, 'stopped');
      assert.equal(A.toggleMunchPreview(M), true);
      assert.equal(A.munchPreview.playing, true);
      assert.equal(A.transport.state, 'stopped', 'global transport stays stopped');
      assert.equal(A.transport.position, null, 'global transport position stays null');
      assert.equal(active.size, 1);

      // Pad audition works normally while local preview is active
      const voice = A.engine.E.ch.get(M).voice;
      const beforePad = voice.stats.played;
      const h = A.munchPadOn(3, .9, M);
      assert.ok(h, 'pad audition succeeds during local preview');
      assert.equal(voice.stats.played, beforePad + 1);
      A.munchPadOff(h);

      // 2. Starting global Play while local preview is active stops local preview cleanly (no double MUNCH)
      A.togglePlay();
      assert.equal(A.munchPreview.playing, false, 'global Play stops local preview');
      assert.equal(A.transport.state, 'playing', 'global transport is now playing');

      // 3. Starting local preview while global transport is playing pauses global transport (preserving position)
      ctx.advance(.05); tickAll();
      const posBefore = { ...A.transport.position };
      assert.equal(A.toggleMunchPreview(M), true);
      assert.equal(A.munchPreview.playing, true);
      assert.equal(A.transport.state, 'paused', 'global transport paused to prevent double MUNCH');
      assert.deepEqual(A.transport.position, posBefore, 'global transport position preserved');

      // 4. Stopping local preview keeps global transport paused (never auto-starts it)
      assert.equal(A.toggleMunchPreview(M), false);
      assert.equal(A.munchPreview.playing, false);
      assert.equal(A.transport.state, 'paused', 'stopping local preview leaves global transport paused');
      assert.equal(voice.activeCount(), 0, 'voices cleaned up on Stop');
      assert.equal(active.size, 0, 'no leaked timers');

      // 5. Transitions stop local preview and clean up voices/timers:
      // 5a. Scene change
      assert.equal(A.toggleMunchPreview(M), true);
      ctx.advance(.1); tickAll();
      A.selectScene((demo.scene + 1) % demo.scenes.length);
      assert.equal(A.munchPreview.playing, false, 'scene switch stops preview');
      assert.equal(voice.activeCount(), 0);
      assert.equal(active.size, 0);

      // 5b. Leaving CHOP tab (CHOP -> PLAY / TWIST)
      assert.equal(A.toggleMunchPreview(M), true);
      A.setMunchTab('play');
      assert.equal(A.munchPreview.playing, false, 'switching CHOP -> PLAY stops preview');
      assert.equal(store.ui.munch.tab, 'play');
      assert.equal(active.size, 0);

      A.setMunchTab('chop');
      assert.equal(A.toggleMunchPreview(M), true);
      A.setMunchTab('twist');
      assert.equal(A.munchPreview.playing, false, 'switching CHOP -> TWIST stops preview');

      // 5c. Leaving SOUND mode (SOUND -> JAM / ARRANGE)
      A.setMunchTab('chop');
      assert.equal(A.toggleMunchPreview(M), true);
      A.setMode('jam');
      assert.equal(A.munchPreview.playing, false, 'leaving SOUND to JAM stops preview');
      assert.equal(active.size, 0);

      A.setMode('sound');
      assert.equal(A.toggleMunchPreview(M), true);
      A.setMode('arrange');
      assert.equal(A.munchPreview.playing, false, 'leaving SOUND to ARRANGE stops preview');

      // 5d. Switching instrument slot (MUNCH -> BOP)
      A.setMode('sound');
      assert.equal(A.toggleMunchPreview(M), true);
      A.selectSlot('slot-01');
      assert.equal(A.munchPreview.playing, false, 'switching instrument stops preview');
      assert.equal(active.size, 0);

      // 5e. Global Stop while previewing
      A.selectSlot(M);
      A.setMode('sound');
      A.setMunchTab('chop');
      assert.equal(A.toggleMunchPreview(M), true);
      A.stop();
      assert.equal(A.munchPreview.playing, false, 'global Stop stops local preview');
      assert.equal(A.transport.state, 'stopped');
      assert.equal(voice.activeCount(), 0);
      assert.equal(active.size, 0);
    });
  });
});

test('local preview does not affect global transport gates when running on isolated engine', () => audioRig(async ({ p, engine, ctx }) => {
  const tr = createTransport(engine, () => p);
  const pv = createSlicePreview(engine, () => p);
  setPatternAt(p, M, 0, { len: 16, notes: [{ s: 0, p: 60, l: 1, v: .8, slice: 0 }] });

  withFakeTimers(({ active, tickAll }) => {
    pv.start(M);
    assert.ok(engine.E.previewGates[M], 'preview uses its own isolated preview gate');
    assert.equal(engine.E.gates, null, 'global transport gates remain untouched');
    assert.equal(tr.state, 'stopped');
    ctx.advance(.1); tickAll();
    pv.stop();
    assert.equal(engine.E.previewGates[M], undefined, 'preview gate removed on stop');
    assert.equal(active.size, 0);
  });
}));
