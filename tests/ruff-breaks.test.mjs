// HarbuMatic v0.7 PR2 — RUFF: First Breaks tests.
// Verifies built-in audio assets (WAV integrity, exact loop length, seamless wrap, gain staging,
// distinctness), SampleBank built-in loading + Stretch/Tape playback, A/B/C concurrent playback,
// independent lane volume/mute, global RUFF volume/mute/solo, auditioning, Pause/Resume/Stop,
// orphan voice prevention, pattern preservation, Undo/Redo, and .hbn round-trip.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUILTIN_BREAKS, BUILTIN_BREAK_IDS, isBuiltinBreakId, getBuiltinBreak, breakFitPlayback, breakRefsOf,
} from '../src/core/breaks.js';
import { isSampleId, sampleRefsOf } from '../src/core/samples.js';
import { createEmptyProject, slotById, patternAt, sceneHasContent } from '../src/core/project.js';
import { createLibrary, memoryStorage } from '../src/core/persistence.js';
import { exportPackage, parsePackage, restorePackage } from '../src/core/package.js';
import { createSampleStore, memoryBackend } from '../src/samples/store.js';
import { createSampleBank } from '../src/samples/bank.js';
import { stretchChannels } from '../src/samples/stretch.js';
import { createEngine } from '../src/audio/engine.js';
import { createTransport } from '../src/audio/scheduler.js';
import { CUT } from '../src/audio/voices.js';
import { store } from '../src/app/store.js';
import * as A from '../src/app/actions.js';
import { decodeWav, makeWav, withFakeWindow } from './helpers/audio.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const R = 'slot-06';
const near = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;

/** synchronous test stretch runner (no Worker needed in Node) */
const syncRunner = {
  mode: 'test',
  run: (chans, rate, factor, anchors) => Promise.resolve(stretchChannels(chans, rate, factor, { anchors })),
};

async function fetchDiskBreak(url) {
  const filePath = resolve(ROOT, url.replace(/^\.\//, ''));
  const buf = await readFile(filePath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

test('built-in break WAV assets exist, decode cleanly, are seamless, non-clipping, gain-matched and distinct', async () => {
  assert.equal(BUILTIN_BREAKS.length, 3);
  const metrics = [];

  for (const brk of BUILTIN_BREAKS) {
    assert.equal(isBuiltinBreakId(brk.id), true);
    assert.equal(isSampleId(brk.id), false, 'built-in break IDs stay distinct from user smp-<sha256> IDs');
    const ab = await fetchDiskBreak(brk.url);
    const decoded = await decodeWav(ab);
    assert.equal(decoded.sampleRate, 44100, `${brk.name}: 44.1 kHz`);
    assert.equal(decoded.numberOfChannels, 2, `${brk.name}: stereo`);

    const expectedDur = (brk.bars * 4 * 60) / brk.bpm;
    assert.ok(near(decoded.duration, expectedDur, 1e-4), `${brk.name}: exact duration (${decoded.duration} vs ${expectedDur})`);

    const L = decoded.getChannelData(0), Rch = decoded.getChannelData(1);
    let peak = 0, sq = 0;
    for (let i = 0; i < L.length; i++) {
      peak = Math.max(peak, Math.abs(L[i]), Math.abs(Rch[i]));
      sq += L[i] * L[i] + Rch[i] * Rch[i];
    }
    const rms = Math.sqrt(sq / (L.length * 2));
    const rmsDb = 20 * Math.log10(rms);
    assert.ok(peak > 0.35 && peak < 0.95, `${brk.name}: healthy peak with headroom (${peak.toFixed(3)})`);
    assert.ok(rmsDb > -15 && rmsDb < -8, `${brk.name}: musical RMS loudness (${rmsDb.toFixed(1)} dBFS)`);

    const seamJump = Math.max(Math.abs(L[L.length - 1] - L[0]), Math.abs(Rch[Rch.length - 1] - Rch[0]));
    assert.ok(seamJump < 0.08, `${brk.name}: seamless loop wrap (seam Δ ${seamJump.toFixed(4)})`);

    // 16-bin energy profile to confirm genuine rhythmic distinctness across the 3 loops
    const bins = [];
    const step = Math.floor(L.length / 16);
    for (let b = 0; b < 16; b++) {
      let s = 0;
      for (let i = b * step; i < (b + 1) * step; i++) s += L[i] * L[i] + Rch[i] * Rch[i];
      bins.push(Math.sqrt(s / (step * 2)));
    }
    metrics.push({ name: brk.name, rmsDb, bins });
  }

  // Gain staging consistency across the 3 breaks
  const rmsVals = metrics.map(m => m.rmsDb);
  assert.ok(Math.max(...rmsVals) - Math.min(...rmsVals) < 2.0, 'consistent gain staging across all three breaks');

  // Pairwise rhythmic profiles are genuinely distinct (not duplicates)
  for (let i = 0; i < metrics.length; i++) {
    for (let j = i + 1; j < metrics.length; j++) {
      const a = metrics[i].bins, b = metrics[j].bins;
      const diff = Math.sqrt(a.reduce((acc, v, k) => acc + (v - b[k]) ** 2, 0) / a.length);
      assert.ok(diff > 0.02, `${metrics[i].name} vs ${metrics[j].name} are rhythmically distinct (diff ${diff.toFixed(4)})`);
    }
  }
});

test('SampleBank loads built-in breaks via fetchAsset without touching IndexedDB store', async () => {
  let storeReads = 0;
  const fakeStore = {
    getBytes: async () => { storeReads++; throw new Error('should not touch sample store'); },
    isUnsaved: () => false,
  };
  const bank = createSampleBank({ store: fakeStore, decode: decodeWav, fetchAsset: fetchDiskBreak });
  const bufs = await bank.pin(BUILTIN_BREAK_IDS);
  assert.equal(bufs.every(Boolean), true, 'all three built-in breaks decoded cleanly');
  assert.equal(storeReads, 0, 'IndexedDB store was never queried for built-in breaks');
  assert.equal(bank.state('brk-builtin-tight').status, 'ready');
});

async function ruffRig(fn, { bpm = 120, fitMode = 'stretch', realDisk = false } = {}) {
  const wavCache = new Map();
  const fetchAsset = async (url, id) => {
    if (realDisk) return fetchDiskBreak(url);
    if (!wavCache.has(id)) {
      const desc = getBuiltinBreak(id);
      const sec = (desc.bars * 4 * 60) / desc.bpm;
      wavCache.set(id, makeWav({ seconds: sec, rate: 2000, channels: 1, freq: desc.bpm }));
    }
    return wavCache.get(id).slice(0);
  };
  await withFakeWindow(async getCtx => {
    const sampleStore = createSampleStore({ backend: memoryBackend(), decode: decodeWav });
    const bank = createSampleBank({ store: sampleStore, decode: decodeWav, runner: syncRunner, stretchDelayMs: 5, fetchAsset });
    const p = createEmptyProject({ bpm });
    const ruff = slotById(p, R);
    ruff.params.fitMode = fitMode;
    const engine = createEngine(() => p, { samples: bank });
    engine.init();
    const ctx = getCtx();
    await bank.pin(BUILTIN_BREAK_IDS);
    engine.applyAll();
    const voice = engine.E.ch.get(R).voice;
    await fn({ p, ruff, engine, ctx, bank, voice });
  });
}

function runTransport(p, engine, ctx, { seconds = 2, onTick } = {}) {
  let tick;
  const si = globalThis.setInterval, ci = globalThis.clearInterval;
  globalThis.setInterval = fn => { tick = fn; return 1; };
  globalThis.clearInterval = () => {};
  const tr = createTransport(engine, () => p, {});
  const step = (dt) => {
    const until = ctx.currentTime + dt;
    while (ctx.currentTime < until) {
      ctx.advance(Math.min(until, ctx.currentTime + .02));
      if (tr.playing) tick();
      if (onTick) onTick(ctx.currentTime, tr);
    }
  };
  return {
    tr,
    step,
    cleanup() { tr.stop(); globalThis.setInterval = si; globalThis.clearInterval = ci; },
  };
}

test('A/B/C breaks play independently and simultaneously with independent lane volume/mute and global RUFF mute/solo', () => ruffRig(async ({ p, ruff, engine, ctx, voice }) => {
  ruff.breaks = { a: 'brk-builtin-tight', b: 'brk-builtin-funky', c: 'brk-builtin-jungle' };
  ruff.params.volA = 1.0;
  ruff.params.volB = 0.5;
  ruff.params.muteC = true;
  engine.applyAll();

  const run = runTransport(p, engine, ctx);
  try {
    run.tr.play();
    run.step(0.2); // mid-beat 0: all 3 lanes actively sounding
    // All 3 lanes triggered at beat 0 simultaneously
    const beat0 = ctx.sources.filter(s => s.startArgs && near(s.startArgs[0], 0.06, 0.005));
    assert.equal(beat0.length, 3, 'all 3 lanes scheduled concurrently at beat 0');
    // Check lane gain values (volA=1.0, volB=0.5, muteC=true -> 0)
    const laneGains = beat0.map(s => s.out[0].out[0].gain.value);
    assert.ok(laneGains[0] > laneGains[1] && laneGains[1] > 0, 'lane A louder than lane B');
    assert.equal(laneGains[2], 0, 'muted lane C starts at gain 0');

    // Live unmute lane C mid-bar updates gain immediately via applyParams
    ruff.params.muteC = false;
    ruff.params.volC = 0.8;
    engine.applyParams(R);
    const laneCGainEvents = beat0[2].out[0].out[0].gain.events;
    assert.ok(laneCGainEvents.some(e => e[0] === 'setTargetAtTime' && e[1] > 0), 'unmuting lane C mid-bar ramps gain up immediately');

    // Advance across beat 1: beat 1 crossfades cleanly within each lane and beat 0 disconnects
    run.step(0.45);
    assert.ok(voice.stats.crossfaded >= 3, 'beat 1 crossfaded cleanly with beat 0 per lane');
    assert.ok(voice.activeCount() <= 6, 'active voice count stays bounded');
    assert.equal(beat0.every(s => s.disconnected), true, 'beat 0 sources disconnected cleanly after crossfade');

    // Global RUFF mute silences the RUFF channel strip
    ruff.mute = true;
    engine.applyParams(R);
    assert.equal(engine.audible(R), false);
    const chOutEvents = engine.E.ch.get(R).channel.out.gain.events;
    assert.ok(chOutEvents.some(e => e[0] === 'setTargetAtTime' && e[1] === 0), 'global RUFF mute drops channel gain to 0');
  } finally {
    run.cleanup();
  }
  assert.equal(voice.activeCount(), 0, 'Stop leaves zero orphan voices');
}));

test('Stretch mode preserves pitch via WSOLA buffer while Tape mode shifts playbackRate with BPM', () => ruffRig(async ({ p, ruff, engine, ctx, bank, voice }) => {
  // Use FUNKY (105 BPM, 2 bars = 4.5714s) at project BPM = 140
  p.bpm = 140;
  ruff.breaks.a = 'brk-builtin-funky';
  const desc = getBuiltinBreak('brk-builtin-funky');
  const fpStretch = breakFitPlayback({ fitMode: 'stretch' }, desc.duration, desc.bars, 140);
  assert.equal(fpStretch.mode, 'stretch');
  assert.ok(near(fpStretch.stretch, 105 / 140, 1e-4));
  assert.equal(fpStretch.pitchRate, 1);

  // Pre-render the stretched copy (as prepareStretch does in the app)
  bank.requestStretch(desc.id, fpStretch.stretch, desc.slices, false);
  await bank.stretchIdle();

  // Trigger in Stretch mode: uses stretched buffer, playbackRate stays ~1.0 (pitch preserved)
  ruff.params.fitMode = 'stretch';
  engine.trigger(R, 1.0, { lane: 'a', breakId: desc.id, loop: true, startFrac: 0, dur: 60 / 140 }, false);
  const stretchSrc = ctx.sources[ctx.sources.length - 1];
  assert.equal(voice.stats.stretched, 1, 'Stretch mode played the WSOLA stretched buffer');
  assert.ok(near(stretchSrc.playbackRate.value, 1.0, 0.005), `Stretch playbackRate stays ~1.0 (got ${stretchSrc.playbackRate.value})`);

  // Switch to Tape mode: uses original buffer, playbackRate = 140 / 105 = 1.3333 (pitch follows tempo)
  ruff.params.fitMode = 'tape';
  engine.trigger(R, 2.0, { lane: 'a', breakId: desc.id, loop: true, startFrac: 0, dur: 60 / 140 }, false);
  const tapeSrc = ctx.sources[ctx.sources.length - 1];
  assert.ok(near(tapeSrc.playbackRate.value, 140 / 105, 0.005), `Tape playbackRate follows tempo ratio (got ${tapeSrc.playbackRate.value})`);
  assert.equal(tapeSrc.buffer, bank.buffer(desc.id), 'Tape mode uses original unstretched buffer');

  // Changing BPM mid-bar in Tape mode updates active playbackRate immediately
  p.bpm = 160;
  engine.applyParams(R);
  const rateEvents = tapeSrc.playbackRate.events;
  assert.ok(rateEvents.some(e => e[0] === 'setTargetAtTime' && near(e[1], 160 / 105, 0.01)), 'Tape live BPM change ramps playbackRate');
}));

test('Pause/Resume resumes at exact mid-bar phase and Stop silences auditions with zero orphan voices', () => ruffRig(async ({ p, ruff, engine, ctx, voice }) => {
  ruff.breaks.a = 'brk-builtin-tight'; // 120 BPM -> 0.125s per 16th step, 0.5s per beat
  const run = runTransport(p, engine, ctx);
  try {
    run.tr.play();
    // Advance past step 5 (1.5 beats -> paused around step 6)
    run.step(0.75);
    run.tr.pause();
    assert.equal(voice.activeCount(), 0, 'Pause silences all RUFF voices immediately');
    const pausedStep = run.tr.position.step;
    assert.ok(pausedStep > 0 && pausedStep % 4 !== 0, `paused mid-beat at step ${pausedStep}`);

    // Resume: immediately schedules from the exact paused phaseStep (no waiting for next beat!)
    const before = ctx.sources.length;
    run.tr.play();
    const resumed = ctx.sources.slice(before);
    assert.ok(resumed.length >= 1, 'Resume immediately triggers RUFF on the paused step');
    const expectedOffset = ((pausedStep % 32) / 32) * resumed[0].buffer.duration;
    assert.ok(near(resumed[0].startArgs[1], expectedOffset, 0.01), `resumed at exact buffer offset (${resumed[0].startArgs[1]} vs ${expectedOffset})`);

    run.tr.stop();
    assert.equal(voice.activeCount(), 0, 'Stop clears all transport voices');

    // Audition on a muted lane still plays, replaces previous audition cleanly, and stops on Stop
    ruff.params.muteA = true;
    let endedCount = 0;
    engine.audition(R, null, 0.9, { lane: 'a', breakId: 'brk-builtin-tight', onEnded: () => { endedCount++; } });
    assert.equal(voice.activeCount(), 1, 'audition active');
    const audSrc = ctx.sources[ctx.sources.length - 1];
    assert.ok(audSrc.out[0].out[0].gain.value > 0, 'audition remains audible even when lane is muted');

    // Second audition cuts the first cleanly (no overlap)
    engine.audition(R, null, 0.9, { lane: 'a', breakId: 'brk-builtin-jungle' });
    assert.equal(voice.activeCount(), 1, 'second audition replaces first cleanly');
    assert.equal(endedCount, 1, 'first audition notified onEnded when cut');
    assert.ok(audSrc.stopAt <= ctx.currentTime + CUT + 0.02, 'first audition stopped with click-free fade');

    // Global Stop cuts the running audition too
    run.tr.stop();
    assert.equal(voice.activeCount(), 0, 'Stop silences active audition with zero orphans');
  } finally {
    run.cleanup();
  }
}));

test('actions assign/clear breaks without discarding patterns, support Undo/Redo, and round-trip via library and .hbn', async () => {
  store.project = createEmptyProject({ name: 'RUFF PR2 Persistence' });
  store.ui.sel = R;
  A.history.clear();

  // Place an existing pattern step on lane A to prove source changes never discard patterns
  const pat = patternAt(store.project, R, 0);
  pat.lanes.a[3] = { slice: 2, v: 0.9, p: 1 };

  assert.equal(A.assignBreak('a', 'brk-builtin-tight', R), true);
  assert.equal(A.assignBreak('b', 'brk-builtin-funky', R), true);
  assert.equal(A.assignBreak('c', 'brk-builtin-jungle', R), true);
  A.setBreakLaneVol('b', 0.62, R);
  A.sealHistory();
  A.toggleBreakLaneMute('c', R);
  A.setFitMode('tape', R);

  const ruff = slotById(store.project, R);
  assert.deepEqual(ruff.breaks, { a: 'brk-builtin-tight', b: 'brk-builtin-funky', c: 'brk-builtin-jungle' });
  assert.equal(ruff.params.volB, 0.62);
  assert.equal(ruff.params.muteC, true);
  assert.equal(ruff.params.fitMode, 'tape');
  assert.deepEqual(patternAt(store.project, R, 0).lanes.a[3], { slice: 2, v: 0.9, p: 1 }, 'existing pattern preserved');
  assert.equal(sceneHasContent(store.project, 0), true);
  assert.deepEqual(breakRefsOf(store.project), ['brk-builtin-tight', 'brk-builtin-funky', 'brk-builtin-jungle']);
  assert.deepEqual(sampleRefsOf(store.project), [], 'built-in breaks are not treated as IndexedDB user samples in .hbn');

  // Undo reverts fitMode -> 'stretch', Redo restores 'tape'
  A.undo();
  assert.equal(slotById(store.project, R).params.fitMode, 'stretch');
  A.redo();
  assert.equal(slotById(store.project, R).params.fitMode, 'tape');

  // Clearing lane A keeps pattern intact
  A.assignBreak('a', null, R);
  assert.equal(slotById(store.project, R).breaks.a, null);
  assert.deepEqual(patternAt(store.project, R, 0).lanes.a[3], { slice: 2, v: 0.9, p: 1 }, 'clearing source preserves pattern');
  A.undo(); // restore lane A
  assert.equal(slotById(store.project, R).breaks.a, 'brk-builtin-tight');

  // Library save/reopen round-trip
  const snap = JSON.parse(JSON.stringify(store.project));
  const mem = memoryStorage();
  const lib = createLibrary(mem);
  assert.equal(lib.save(snap), true);
  const reopened = createLibrary(mem).load(snap.id);
  assert.deepEqual(reopened, snap);

  // Portable .hbn package export/import round-trip
  const sampleStore = createSampleStore({ backend: memoryBackend() });
  const pkg = await exportPackage(snap, { sampleStore });
  assert.equal(pkg.sampleCount, 0, 'built-in breaks do not bloat .hbn archive');
  const parsed = await parsePackage(pkg.bytes);
  const restored = await restorePackage(parsed, { sampleStore });
  assert.deepEqual(restored.project, snap);
});
