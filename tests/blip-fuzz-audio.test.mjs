// Regression tests for PR33 P1: BLIP/FUZZ permanent audio loss after repeated
// MUNCH -> SOUND -> CHOP Scene A/B/C switching and Stop/Play cycles (WebKit/iPad).
//
// Models WebKit's pull-graph behaviour where disconnecting a downstream session gate
// before an OscillatorNode's scheduled stopAt prevents `onended` from ever firing,
// as well as complete `onended` loss.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoProject, slotById, setPatternAt } from '../src/core/project.js';
import { sampleRefFor } from '../src/core/samples.js';
import { createSampleStore, memoryBackend } from '../src/samples/store.js';
import { createSampleBank } from '../src/samples/bank.js';
import { createEngine } from '../src/audio/engine.js';
import { createTransport, createSlicePreview } from '../src/audio/scheduler.js';
import { MAX_POLY } from '../src/audio/voices.js';
import { store } from '../src/app/store.js';
import * as A from '../src/app/actions.js';
import { makeWav, decodeWav, FakeBuffer } from './helpers/audio.mjs';

const BLIP = 'slot-03';
const FUZZ = 'slot-04';
const MUNCH = 'slot-05';

function param(value = 0) {
  const p = { value, events: [] };
  for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime', 'cancelScheduledValues']) {
    p[m] = (...a) => { p.events.push([m, ...a]); return p; };
  }
  return p;
}

/**
 * Fake AudioContext that faithfully models WebKit's pull-graph `onended` semantics:
 * - Both OscillatorNode and AudioBufferSourceNode track start/stop/onended.
 * - A source only fires `onended` when `stopAt <= currentTime` AND it is still
 *   reachable from `ctx.destination` (unless `dropAllOnEnded` is enabled).
 * - Disconnecting a downstream node (like `engine.closeGates()` disconnecting old gates
 *   250ms after Stop/Pause) leaves any still-running upstream oscillators unreachable,
 *   so WebKit never pulls them and never fires `onended`.
 */
function createWebKitContext({ sampleRate = 48000, dropAllOnEnded = false } = {}) {
  const ctx = {
    currentTime: 0, sampleRate, state: 'running',
    sources: [], oscillators: [], live: new Set(),
  };
  const node = kind => {
    const n = {
      kind, out: [],
      connect(d) { n.out.push(d); return d; },
      disconnect(target) {
        if (target === undefined) { n.out = []; n.disconnected = true; }
        else { n.out = n.out.filter(x => x !== target); }
      },
      start() {}, stop() {},
    };
    return new Proxy(n, {
      get: (o, k) => (k in o ? o[k] : typeof k === 'string' && !['then', 'onended'].includes(k) ? (o[k] = param()) : undefined),
    });
  };
  ctx.destination = node('destination');
  ctx.createBuffer = (c, l, r) => new FakeBuffer(c, l, r);
  ctx.createGain = () => { const g = node('gain'); g.gain = param(1); return g; };

  const makeScheduled = (kind, list) => {
    const s = node(kind);
    Object.assign(s, {
      startArgs: null, stopAt: null, ended: false, onended: null,
      frequency: param(440), detune: param(0), playbackRate: param(1),
      buffer: null, loop: false, loopStart: 0, loopEnd: 0,
    });
    s.start = (...args) => {
      if (s.startArgs) throw new Error('InvalidStateError: start called twice');
      s.startArgs = args;
      ctx.live.add(s);
    };
    s.stop = (t = ctx.currentTime) => {
      if (!s.startArgs) throw new Error('InvalidStateError: stop before start');
      s.stopAt = t;
    };
    list.push(s);
    return s;
  };
  ctx.createBufferSource = () => makeScheduled('source', ctx.sources);
  ctx.createOscillator = () => makeScheduled('Oscillator', ctx.oscillators);
  for (const k of ['BiquadFilter', 'WaveShaper', 'StereoPanner', 'DynamicsCompressor', 'Analyser', 'Convolver', 'Delay', 'ConstantSource']) {
    ctx[`create${k}`] = () => node(k);
  }
  ctx.decodeAudioData = ab => decodeWav(ab);
  ctx.resume = () => Promise.resolve();

  function reachesDestination(startNode) {
    const seen = new Set();
    const stack = [startNode];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || seen.has(cur)) continue;
      if (cur === ctx.destination) return true;
      seen.add(cur);
      if (Array.isArray(cur.out)) {
        for (const nxt of cur.out) stack.push(nxt);
      }
    }
    return false;
  }

  ctx.advance = t => {
    ctx.currentTime = t;
    for (const s of [...ctx.live]) {
      if (s.stopAt != null && s.stopAt <= t) {
        if (dropAllOnEnded || !reachesDestination(s)) continue; // WebKit: unpulled node never fires onended
        ctx.live.delete(s);
        s.ended = true;
        if (s.onended) s.onended();
      }
    }
  };
  ctx.reachesDestination = reachesDestination;
  return ctx;
}

function withFakeTimers(fn) {
  const intervals = new Map();
  const timeouts = new Map();
  let nextId = 1;
  const origSI = globalThis.setInterval, origCI = globalThis.clearInterval;
  const origST = globalThis.setTimeout, origCT = globalThis.clearTimeout;
  let nowMs = 0;
  globalThis.setInterval = (cb, ms) => { const id = nextId++; intervals.set(id, { cb, ms }); return id; };
  globalThis.clearInterval = id => { intervals.delete(id); };
  globalThis.setTimeout = (cb, ms = 0) => { const id = nextId++; timeouts.set(id, { cb, at: nowMs + ms }); return id; };
  globalThis.clearTimeout = id => { timeouts.delete(id); };
  const tickAll = () => { for (const { cb } of [...intervals.values()]) cb(); };
  const flushTimeoutsTo = ms => {
    nowMs = Math.max(nowMs, ms);
    for (const [id, entry] of [...timeouts.entries()]) {
      if (entry.at <= nowMs) {
        timeouts.delete(id);
        entry.cb();
      }
    }
  };
  try {
    return fn({ intervals, timeouts, tickAll, flushTimeoutsTo });
  } finally {
    globalThis.setInterval = origSI; globalThis.clearInterval = origCI;
    globalThis.setTimeout = origST; globalThis.clearTimeout = origCT;
  }
}

async function withWebKitWindow(fn, opts = {}) {
  const had = 'window' in globalThis, old = globalThis.window;
  let made = null;
  globalThis.window = { AudioContext: function () { made = createWebKitContext(opts); return made; } };
  try { return await fn(() => made); } finally { if (had) globalThis.window = old; else delete globalThis.window; }
}

test('WebKit gate-disconnect on Stop/Play + repeated Scene A/B/C switching never silences BLIP/FUZZ playback or manual audition', () => withWebKitWindow(async getCtx => {
  const sstore = createSampleStore({ backend: memoryBackend(), decode: decodeWav });
  const bank = createSampleBank({ store: sstore, decode: decodeWav });
  const project = createDemoProject();
  project.songMode = false;
  project.scene = 0;
  const { meta } = await sstore.importBytes({ bytes: makeWav({ seconds: 1, rate: 1000, freq: 0 }), name: 'chop.wav' });
  slotById(project, MUNCH).sample = sampleRefFor(meta);
  setPatternAt(project, MUNCH, 0, { len: 16, notes: [{ s: 0, p: 60, l: 1, v: .9, slice: 0 }] });
  setPatternAt(project, MUNCH, 1, { len: 16, notes: [{ s: 4, p: 60, l: 1, v: .9, slice: 1 }] });
  setPatternAt(project, MUNCH, 2, { len: 16, notes: [{ s: 8, p: 60, l: 1, v: .9, slice: 2 }] });

  const engine = createEngine(() => project, { samples: bank });
  engine.init();
  const ctx = getCtx();
  await bank.pin([meta.id]);
  engine.applyAll();

  const transport = createTransport(engine, () => project);
  const preview = createSlicePreview(engine, () => project);

  withFakeTimers(({ tickAll, flushTimeoutsTo }) => {
    let t = 0;
    const stepForward = seconds => {
      const steps = Math.max(1, Math.round(seconds / 0.02));
      for (let i = 0; i < steps; i++) {
        t += 0.02;
        ctx.advance(t);
        flushTimeoutsTo(t * 1000);
        tickAll();
      }
    };

    // Baseline: manual audition reaches BLIP and FUZZ voice triggers and connects to destination
    const b0 = engine.audition(BLIP, 69, .8);
    const f0 = engine.audition(FUZZ, 76, .8);
    assert.ok(b0, 'baseline BLIP manual audition triggers a voice');
    assert.ok(f0, 'baseline FUZZ manual audition triggers a voice');
    assert.ok(ctx.reachesDestination(b0.amp), 'baseline BLIP audition reaches destination');
    assert.ok(ctx.reachesDestination(f0.amp), 'baseline FUZZ audition reaches destination');
    stepForward(5.0);

    // Repeatedly play, switch Scene A/B/C (as in MUNCH -> SOUND -> CHOP), toggle preview, stop & restart
    for (let cycle = 0; cycle < 5; cycle++) {
      transport.play();
      for (const sc of [0, 1, 2, 1, 0, 2]) {
        project.scene = sc;
        transport.queueScene(sc);
        stepForward(0.36);
      }
      // Pause global playback to run isolated MUNCH preview, then switch scenes while previewing
      transport.pause();
      assert.equal(engine.E.shared.voices.count, 0, `cycle ${cycle}: Pause silences and untracks all BLIP/FUZZ voices immediately`);
      preview.start(MUNCH);
      stepForward(0.30); // > 250ms so closeGates() disconnects old session gates!
      project.scene = (cycle + 1) % 3;
      preview.stop();
      stepForward(0.30);

      // Restart global playback, switch scenes, then hard Stop
      transport.play();
      stepForward(1.4);
      transport.stop();
      assert.equal(engine.E.shared.voices.count, 0, `cycle ${cycle}: Stop silences and untracks all BLIP/FUZZ voices immediately`);
      stepForward(0.35); // > 250ms so closeGates() disconnects old session gates!
    }

    // After repeated scene switching and Stop/Play cycles:
    // 1. Manual note audition on BLIP and FUZZ MUST still produce voices routed to destination
    const bAud = engine.audition(BLIP, 69, .8);
    const fAud = engine.audition(FUZZ, 76, .8);
    assert.ok(bAud, 'BLIP manual audition still triggers after repeated scene switches and Stop/Play');
    assert.ok(fAud, 'FUZZ manual audition still triggers after repeated scene switches and Stop/Play');
    assert.ok(ctx.reachesDestination(bAud.amp), 'BLIP manual audition reaches destination');
    assert.ok(ctx.reachesDestination(fAud.amp), 'FUZZ manual audition reaches destination');

    // 2. Restarting global playback MUST actually trigger BLIP and FUZZ voices (not null)
    const liveResults = { [BLIP]: [], [FUZZ]: [] };
    const origTrigger = engine.trigger;
    engine.trigger = (id, time, hit, live = true) => {
      const res = origTrigger(id, time, hit, live);
      if (live === true && (id === BLIP || id === FUZZ)) liveResults[id].push(res);
      return res;
    };
    project.scene = 1; // Scene B has both BLIP chords/melody and FUZZ pads
    transport.play();
    stepForward(2.2);
    assert.ok(liveResults[BLIP].length > 0 && liveResults[BLIP].every(Boolean), 'BLIP voices trigger on restarted global playback');
    assert.ok(liveResults[FUZZ].length > 0 && liveResults[FUZZ].every(Boolean), 'FUZZ voices trigger on restarted global playback');
    transport.stop();
    assert.equal(engine.E.shared.voices.count, 0, 'final Stop leaves zero leaked synth voices');
  });
}));

test('BLIP and FUZZ remain audible even if browser drops 100% of onended events (pruning + voice stealing)', () => withWebKitWindow(async getCtx => {
  const project = createDemoProject();
  const engine = createEngine(() => project);
  engine.init();
  const ctx = getCtx();
  engine.applyAll();

  // Trigger well past MAX_POLY notes while advancing time with ZERO onended events firing
  for (let i = 0; i < MAX_POLY * 3; i++) {
    ctx.advance(i * 0.5);
    const b = engine.audition(BLIP, 60 + (i % 12), .8);
    const f = engine.audition(FUZZ, 72 + (i % 12), .8);
    assert.ok(b, `BLIP audition #${i} succeeds without onended`);
    assert.ok(f, `FUZZ audition #${i} succeeds without onended`);
    assert.ok(engine.E.shared.voices.count <= MAX_POLY, `shared synth pool stays bounded <= ${MAX_POLY}`);
  }

  // Trigger a simultaneous burst exceeding MAX_POLY at the same timestamp -> steals oldest, never returns null
  ctx.advance(50);
  for (let i = 0; i < MAX_POLY + 6; i++) {
    const h = engine.audition(i % 2 === 0 ? BLIP : FUZZ, 60 + (i % 12), .8);
    assert.ok(h, `burst voice #${i} steals oldest instead of silently dropping`);
  }
  assert.equal(engine.E.shared.voices.count, MAX_POLY, 'simultaneous burst stays capped at MAX_POLY');

  // Closing gates silences and clears all tracked voices cleanly
  engine.closeGates();
  assert.equal(engine.E.shared.voices.count, 0, 'closeGates clears all BLIP/FUZZ voices');
  assert.equal(engine.E.ch.get(BLIP).voice.activeCount(), 0);
  assert.equal(engine.E.ch.get(FUZZ).voice.activeCount(), 0);

  // Held live notes (noteOn / noteOff) still release cleanly and never double-decrement
  const hb = engine.noteOn(BLIP, 64, .85);
  const hf = engine.noteOn(FUZZ, 72, .85);
  assert.ok(hb && hf);
  assert.equal(engine.E.shared.voices.count, 2);
  assert.equal(engine.noteOff(hb), true);
  assert.equal(engine.noteOff(hb), false, 'duplicate noteOff is a safe no-op');
  assert.equal(engine.noteOff(hf), true);
  engine.closeGates();
  assert.equal(engine.E.shared.voices.count, 0, 'count never underflows or leaks after release + closeGates');
}, { dropAllOnEnded: true }));

test('MUNCH CHOP Preview shutdown remains isolated and never affects BLIP/FUZZ voices or channel gains', () => withWebKitWindow(async getCtx => {
  const sstore = createSampleStore({ backend: memoryBackend(), decode: decodeWav });
  const bank = createSampleBank({ store: sstore, decode: decodeWav });
  const project = createDemoProject();
  const { meta } = await sstore.importBytes({ bytes: makeWav({ seconds: 1, rate: 1000, freq: 0 }), name: 'chop.wav' });
  slotById(project, MUNCH).sample = sampleRefFor(meta);
  setPatternAt(project, MUNCH, 0, { len: 16, notes: [{ s: 0, p: 60, l: 1, v: .9, slice: 0 }] });

  const engine = createEngine(() => project, { samples: bank });
  engine.init();
  const ctx = getCtx();
  await bank.pin([meta.id]);
  engine.applyAll();

  const preview = createSlicePreview(engine, () => project);

  withFakeTimers(({ tickAll, flushTimeoutsTo }) => {
    const bAud = engine.audition(BLIP, 69, .8);
    const fAud = engine.audition(FUZZ, 76, .8);
    assert.ok(bAud && fAud);

    // Start and stop MUNCH preview multiple times while BLIP/FUZZ voices exist
    for (let i = 0; i < 4; i++) {
      assert.equal(preview.start(MUNCH), true);
      ctx.advance(0.05 + i * 0.1);
      tickAll();
      preview.stop();
      flushTimeoutsTo((0.4 + i * 0.4) * 1000);
    }

    // MUNCH preview shutdown must not have cut BLIP/FUZZ voices or disturbed their channels
    assert.equal(bAud.released, false, 'MUNCH preview shutdown did not release BLIP voice');
    assert.equal(fAud.released, false, 'MUNCH preview shutdown did not release FUZZ voice');
    assert.ok(engine.E.ch.has(BLIP) && engine.E.ch.has(FUZZ), 'BLIP and FUZZ channels remain registered');
    assert.equal(engine.audible(BLIP), true, 'BLIP remains audible');
    assert.equal(engine.audible(FUZZ), true, 'FUZZ remains audible');
    assert.ok(engine.audition(BLIP, 64, .8), 'BLIP manual audition works after preview cycles');
    assert.ok(engine.audition(FUZZ, 72, .8), 'FUZZ manual audition works after preview cycles');
  });
}));

test('actions.selectScene repeated A/B/C switching preserves BLIP/FUZZ state, mute/solo, and audition path', () => {
  const prevProject = store.project;
  const prevSel = store.ui.sel;
  const prevMode = store.ui.mode;
  try {
    const p = createDemoProject();
    p.songMode = false;
    store.project = p;
    store.ui.sel = MUNCH;
    store.ui.mode = 'sound';
    store.ui.munch.tab = 'chop';

    for (let i = 0; i < 30; i++) {
      A.selectScene(i % 3);
    }
    A.stop();

    const blip = slotById(store.project, BLIP);
    const fuzz = slotById(store.project, FUZZ);
    assert.equal(blip.mute, false);
    assert.equal(blip.solo, false);
    assert.equal(fuzz.mute, false);
    assert.equal(fuzz.solo, false);
    assert.ok(blip.params.vol > 0);
    assert.ok(fuzz.params.vol > 0);
    assert.equal(A.engine.audible(BLIP), true);
    assert.equal(A.engine.audible(FUZZ), true);
  } finally {
    A.stop();
    A.flushSave();
    store.project = prevProject;
    store.ui.sel = prevSel;
    store.ui.mode = prevMode;
  }
});
