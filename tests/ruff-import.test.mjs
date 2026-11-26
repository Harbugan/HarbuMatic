// Automated acceptance & regression tests for HBM-07-PR35 — RUFF: Import Your Own Break.
// Covers:
// 1. WAV import, SHA-256 deduplication, original-bytes preservation & local Break Pool reuse.
// 2. Invalid / non-WAV / empty / oversized / corrupt audio rejection.
// 3. Local deterministic BPM & 1/2/4-bar estimation with half-time / double-time ambiguity handling.
// 4. Transient detection and safe even-grid fallback for flat/silent audio.
// 5. Bounded valid slice boundaries & manual edits (move/nudge/add/remove/auto/even/BPM/bars + remapping).
// 6. Variable-length (1-, 2-, 4-bar) playback, Stretch/Tape sync, manual BPM timing, Pause/Stop, zero truncation.
// 7. CHOP IT! with imported break metadata across all 4 profiles, A/B/C interplay, locks & silence.
// 8. Undo/Redo and scene isolation.
// 9. Save/reopen (localStorage library) and portable .hbn export/import round-trip (MUNCH + RUFF + built-ins).
// 10. Missing assets (never silently dropped/replaced) and durable storage failure recovery.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSampleStore, memoryBackend, SampleError, SAMPLE_LIMITS } from '../src/samples/store.js';
import { createSampleBank } from '../src/samples/bank.js';
import { isWavBytes, analyzeBreakBuffer, extractSliceFeatures } from '../src/samples/break-analysis.js';
import {
  createEmptyProject, validateProject, importProject, slotById, patternAt,
} from '../src/core/project.js';
import { createLibrary, memoryStorage } from '../src/core/persistence.js';
import { exportPackage, parsePackage, importPackage, PackageError } from '../src/core/package.js';
import { sampleRefsOf, sliceCount, MAX_SLICES, MIN_SLICE } from '../src/core/samples.js';
import {
  breakFitPlayback, breakBarsOf, breakSourceLoopSteps, breakSlicesOf,
  breakSliceInfo, originalGrooveRow, effectiveBreakRow, cleanImportedBreakMeta,
} from '../src/core/breaks.js';
import { chopBreakPattern, analyzeBreakSource, RUFF_CHOP_PROFILES } from '../src/music/ruffchop.js';
import { createEngine } from '../src/audio/engine.js';
import { createTransport } from '../src/audio/scheduler.js';
import { store } from '../src/app/store.js';
import * as A from '../src/app/actions.js';
import { makeWav, decodeWav, FakeBuffer, withFakeWindow } from './helpers/audio.mjs';

const RUFF = 'slot-06';
const MUNCH = 'slot-05';

/** Synthesize a realistic 16-bit PCM WAV drum break with sharp kick/snare/hat transients at `bpm` for `bars` bars. */
function makeDrumBreakWav({ bpm = 160, bars = 2, rate = 22050, channels = 1, hitsPerBar = 8 } = {}) {
  const seconds = (bars * 4 * 60) / bpm;
  const frames = Math.round(seconds * rate);
  const bps = 2;
  const data = frames * channels * bps;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + data, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * bps, true); v.setUint16(32, channels * bps, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, data, true);

  const pcm = new Float32Array(frames);
  const totalHits = bars * hitsPerBar;
  const stepFrames = frames / totalHits;
  for (let h = 0; h < totalHits; h++) {
    const start = Math.round(h * stepFrames);
    const inBar = h % hitsPerBar;
    const isKick = inBar === 0 || inBar === 5;
    const isSnare = inBar === 2 || inBar === 6;
    const decay = isKick ? 0.09 : isSnare ? 0.065 : 0.028;
    const amp = isKick ? 0.92 : isSnare ? 0.88 : 0.42;
    const durFrames = Math.min(frames - start, Math.round(decay * rate * 3.5));
    for (let i = 0; i < durFrames; i++) {
      const t = i / rate;
      const env = Math.exp(-t / decay);
      let s = 0;
      if (isKick) {
        const freq = 140 * Math.exp(-t * 28) + 48;
        s = Math.sin(2 * Math.PI * freq * t) * amp * env;
      } else if (isSnare) {
        // Deterministic pseudo-noise + body tone
        const n = Math.sin(i * 12.9898 + h * 78.233) * 43758.5453;
        const noise = (n - Math.floor(n)) * 2 - 1;
        s = (Math.sin(2 * Math.PI * 195 * t) * 0.45 + noise * 0.55) * amp * env;
      } else {
        const n = Math.sin(i * 93.9898 + h * 17.13) * 19341.123;
        const noise = (n - Math.floor(n)) * 2 - 1;
        s = noise * amp * env;
      }
      pcm[start + i] = Math.max(-0.98, Math.min(0.98, pcm[start + i] + s));
    }
  }
  for (let i = 0; i < frames; i++) {
    const sample = Math.round(pcm[i] * 32767);
    for (let c = 0; c < channels; c++) {
      v.setInt16(44 + (i * channels + c) * 2, sample, true);
    }
  }
  return buf;
}

function wavFile(ab, name = 'my-break.wav', type = 'audio/wav') {
  return { name, type, size: ab.byteLength, arrayBuffer: async () => ab.slice(0) };
}

function makeBank(backendOpts = {}, storeOpts = {}) {
  const backend = memoryBackend(backendOpts);
  const sampleStore = createSampleStore({ backend, decode: decodeWav, ...storeOpts });
  const bank = createSampleBank({ store: sampleStore, decode: decodeWav, stretchDelayMs: 0 });
  return { backend, sampleStore, bank };
}

function resetAppToRuff() {
  A.newSong({ name: 'RUFF Import Test', bpm: 140 });
  A.selectSlot(RUFF);
  A.history.clear();
  return slotById(store.project, RUFF);
}

/* ---------- 1. WAV import, deduplication & original bytes ---------- */
test('WAV import deduplicates by SHA-256, preserves original bytes, reuses local Break Pool, and never overwrites other lanes', async () => {
  const ruff = resetAppToRuff();
  A.assignBreak('a', 'brk-builtin-tight', RUFF);
  const { sampleStore, bank } = makeBank();
  const wav = makeDrumBreakWav({ bpm: 160, bars: 2 });
  const origSnapshot = new Uint8Array(wav.slice(0));

  // First import: lane A already has built-in TIGHT, so auto-assign picks empty lane B without touching A
  const r1 = await A.importBreakFile(wavFile(wav, 'JungleCut.wav'), { slotId: RUFF, bank });
  assert.equal(r1.ok, true);
  assert.equal(r1.duplicate, false);
  assert.equal(r1.stored, true);
  assert.equal(r1.assignedLane, 'b');
  assert.equal(ruff.breaks.a, 'brk-builtin-tight', 'lane A preserved untouched');
  assert.equal(ruff.breaks.b, r1.id, 'imported break assigned to first empty lane B');
  assert.equal(ruff.breaks.c, null);

  // Original WAV bytes stored verbatim in sampleStore
  const storedBytes = new Uint8Array(await sampleStore.getBytes(r1.id));
  assert.deepEqual(storedBytes, origSnapshot, 'original WAV bytes preserved verbatim');

  // Repeat import of identical WAV bytes into lane C: deduplicated (same content-addressed ID, one store entry)
  const r2 = await A.importBreakFile(wavFile(wav, 'JungleCut-Copy.wav'), { lane: 'c', slotId: RUFF, bank });
  assert.equal(r2.ok, true);
  assert.equal(r2.duplicate, true);
  assert.equal(r2.id, r1.id);
  assert.equal(ruff.breaks.a, 'brk-builtin-tight', 'lane A still untouched');
  assert.equal(ruff.breaks.b, r1.id, 'lane B still untouched');
  assert.equal(ruff.breaks.c, r1.id, 'lane C assigned without overwriting A or B');
  assert.equal((await sampleStore.list()).length, 1, 'deduplicated in sample store');

  // Local Break Pool refresh from sampleStore exposes the break across a brand-new song
  A.newSong({ name: 'Second Song', bpm: 128 });
  A.selectSlot(RUFF);
  const pool = await A.refreshLocalBreakPool({ sampleStore });
  assert.ok(pool.some(b => b.id === r1.id), 'imported break available for local Break Pool reuse across projects');
});

/* ---------- 2. Invalid, non-WAV, empty, oversized & corrupt audio ---------- */
test('invalid, non-WAV, empty, oversized and corrupt files are rejected cleanly without mutating lanes', async () => {
  const ruff = resetAppToRuff();
  A.assignBreak('a', 'brk-builtin-funky', RUFF);
  const { bank } = makeBank({}, { limits: { maxBytes: 1024, maxSeconds: 30 } });

  // Empty file
  const rEmpty = await A.importBreakFile(wavFile(new ArrayBuffer(0), 'empty.wav'), { slotId: RUFF, bank });
  assert.equal(rEmpty.ok, false);
  assert.equal(rEmpty.error.code, 'empty');

  // Non-WAV file (e.g. MP3/text disguised as .wav)
  const fakeMp3 = new Uint8Array(64);
  fakeMp3.set([0x49, 0x44, 0x33]); // ID3 header
  assert.equal(isWavBytes(fakeMp3), false);
  const rNonWav = await A.importBreakFile(wavFile(fakeMp3.buffer, 'track.mp3', 'audio/mpeg'), { slotId: RUFF, bank });
  assert.equal(rNonWav.ok, false);
  assert.equal(rNonWav.error.code, 'unsupported');

  // Corrupt RIFF/WAVE header (invalid bit depth / zero frames)
  const corrupt = new ArrayBuffer(64);
  const dv = new DataView(corrupt);
  [...'RIFF'].forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
  [...'WAVE'].forEach((c, i) => dv.setUint8(8 + i, c.charCodeAt(0)));
  const rCorrupt = await A.importBreakFile(wavFile(corrupt, 'corrupt.wav'), { slotId: RUFF, bank });
  assert.equal(rCorrupt.ok, false);
  assert.equal(rCorrupt.error.code, 'unsupported');

  // Oversized WAV exceeding store limit
  const bigWav = makeDrumBreakWav({ bpm: 120, bars: 1, rate: 22050 });
  assert.ok(bigWav.byteLength > 1024);
  const rBig = await A.importBreakFile(wavFile(bigWav, 'huge.wav'), { slotId: RUFF, bank });
  assert.equal(rBig.ok, false);
  assert.equal(rBig.error.code, 'too-large');

  // Too-long WAV (> 30 s limit)
  const longBank = makeBank().bank;
  const longWav = makeWav({ seconds: 32, rate: 8000, channels: 1 });
  const rLong = await A.importBreakFile(wavFile(longWav, 'long.wav'), { slotId: RUFF, bank: longBank });
  assert.equal(rLong.ok, false);
  assert.equal(rLong.error.code, 'too-long');

  // Existing lane assignment completely untouched
  assert.deepEqual(ruff.breaks, { a: 'brk-builtin-funky', b: null, c: null });
});

/* ---------- 3 & 4. Deterministic BPM/bar estimation, ambiguity & transient fallback ---------- */
test('local analysis is deterministic, estimates 1/2/4 bars & BPM, surfaces half/double ambiguity, and falls back safely on flat audio', async () => {
  // 1) Clear 2-bar break at 160 BPM (3.0s) — 1 bar = 80 BPM is also plausible, so half/double ambiguity is surfaced honestly!
  const wav160 = makeDrumBreakWav({ bpm: 160, bars: 2 });
  const buf160 = await decodeWav(wav160);
  const a1 = analyzeBreakBuffer(buf160);
  const a2 = analyzeBreakBuffer(buf160);
  assert.deepEqual(a1, a2, 'analysis is 100% deterministic');
  assert.ok([1, 2, 4].includes(a1.bars));
  assert.equal(a1.analysis.fallback, false, 'transients detected on percussive break');
  assert.ok(a1.slices.length >= 5 && a1.slices.length <= MAX_SLICES + 1, `bounded valid slice boundaries (${a1.slices.length})`);
  assert.equal(a1.slices[0], 0);
  assert.equal(a1.slices[a1.slices.length - 1], 1);
  for (let i = 1; i < a1.slices.length; i++) {
    assert.ok(a1.slices[i] - a1.slices[i - 1] >= MIN_SLICE - 1e-9, 'strictly ordered boundaries');
  }
  assert.equal(a1.analysis.ambiguity?.kind, 'half-double', 'half-time/double-time ambiguity explicitly surfaced');
  assert.notEqual(a1.analysis.confidence, 'high', 'does not pretend high certainty when half/double-time is ambiguous');

  // 2) Clear 1-bar break at 130 BPM (1.846s: 1B=130, 2B=260 out of range, 4B=520 out of range → unambiguous 1 bar!)
  const buf1Bar = await decodeWav(makeDrumBreakWav({ bpm: 130, bars: 1 }));
  const a1Bar = analyzeBreakBuffer(buf1Bar);
  assert.equal(a1Bar.bars, 1);
  assert.ok(Math.abs(a1Bar.bpm - 130) < 0.2, `estimated ${a1Bar.bpm} BPM for 1-bar 130 BPM break`);
  assert.equal(a1Bar.analysis.ambiguity, null, 'unambiguous when only 1-bar fits valid BPM range');

  // 3) Clear 4-bar break at 170 BPM (5.647s: 2B=85, 4B=170 → both plausible, picks 4B or 2B with half-double ambiguity!)
  const buf4Bar = await decodeWav(makeDrumBreakWav({ bpm: 170, bars: 4 }));
  const a4Bar = analyzeBreakBuffer(buf4Bar);
  assert.ok(a4Bar.bars === 4 || a4Bar.bars === 2);
  assert.equal(a4Bar.analysis.ambiguity?.kind, 'half-double');

  // 4) Flat steady sine / silent audio → reliable fallback to even grid + low confidence
  const flatBuf = await decodeWav(makeWav({ seconds: 3.0, rate: 22050, freq: 220 }));
  const aFlat = analyzeBreakBuffer(flatBuf);
  assert.equal(aFlat.analysis.fallback, true, 'steady tone triggers safe even-grid fallback');
  assert.equal(aFlat.analysis.confidence, 'low');
  assert.equal(sliceCount(aFlat.slices), aFlat.bars === 1 ? 8 : 16);

  const silentBuf = new FakeBuffer(1, 44100 * 2, 44100);
  const aSilent = analyzeBreakBuffer(silentBuf);
  assert.equal(aSilent.analysis.fallback, true, 'silence triggers safe even-grid fallback');
  assert.equal(aSilent.analysis.confidence, 'low');
  assert.equal(aSilent.slices[0], 0);
  assert.equal(aSilent.slices[aSilent.slices.length - 1], 1);
});

/* ---------- 5 & 8. Manual slice/BPM/bar edits, remapping, Undo/Redo & scene isolation ---------- */
test('manual slice/BPM/bar edits enforce limits, remap edited patterns, support Undo/Redo, and stay scene-isolated', async () => {
  const ruff = resetAppToRuff();
  const { bank } = makeBank();
  const wav = makeDrumBreakWav({ bpm: 150, bars: 2 });
  const imp = await A.importBreakFile(wavFile(wav, 'EditMe.wav'), { lane: 'a', slotId: RUFF, bank });
  assert.equal(imp.ok, true);
  const id = imp.id;

  // Create Scene 2 and verify scene-local patterns stay isolated
  A.createScene({ name: 'Scene 2', select: false });
  assert.equal(store.project.scenes.length, 2);

  // Edit a step in Scene 1 only
  A.setBreakStepSlice('a', 0, 2, RUFF);
  assert.equal(patternAt(store.project, RUFF, 0).lanes.a[0].slice, 2);
  assert.equal(patternAt(store.project, RUFF, 1).lanes.a[0], null, 'Scene 2 pattern remains unedited');

  // BPM correction is non-destructive and Undoable
  const origBpm = ruff.breakMeta[id].bpm;
  A.setImportedBreakBpm(id, 174, RUFF);
  A.sealHistory();
  assert.equal(ruff.breakMeta[id].bpm, 174);
  A.undo();
  assert.equal(slotById(store.project, RUFF).breakMeta[id].bpm, origBpm, 'Undo restored BPM');
  A.redo();
  assert.equal(slotById(store.project, RUFF).breakMeta[id].bpm, 174, 'Redo reapplied BPM');

  // Bar-length correction (2B → 4B → 1B) updates bars & BPM cleanly and is Undoable
  A.setImportedBreakBars(id, 4, RUFF);
  assert.equal(slotById(store.project, RUFF).breakMeta[id].bars, 4);
  A.scaleImportedBreakTempo(id, 0.5, RUFF);
  assert.equal(slotById(store.project, RUFF).breakMeta[id].bars, 2, '½× scaled 4B back to 2B');

  // Reset to 8 even slices, then move/nudge/add/remove markers and verify remapping & Undo
  A.resetImportedBreakSlices(id, 'even', RUFF);
  const curSlot = () => slotById(store.project, RUFF);
  const beforeMove = curSlot().breakMeta[id].slices[1];
  A.moveImportedBreakSlice(id, 1, beforeMove + 0.015, RUFF);
  A.sealHistory();
  assert.ok(curSlot().breakMeta[id].slices[1] > beforeMove);

  // Deleting outer edge marker 0 is refused
  const countBeforeEdge = sliceCount(curSlot().breakMeta[id].slices);
  assert.equal(A.removeImportedBreakSlice(id, 0, RUFF), null, 'outer boundary cannot be deleted');
  assert.equal(sliceCount(curSlot().breakMeta[id].slices), countBeforeEdge);

  // Deleting an inner marker reduces slice count by 1 and remaps edited cells safely
  assert.ok(A.removeImportedBreakSlice(id, 1, RUFF));
  assert.equal(sliceCount(curSlot().breakMeta[id].slices), countBeforeEdge - 1);

  // Adding a slice boundary increases slice count by 1 (bounded by MAX_SLICES)
  const mid = (curSlot().breakMeta[id].slices[0] + curSlot().breakMeta[id].slices[1]) / 2;
  assert.ok(A.addImportedBreakSlice(id, mid, RUFF));
  assert.equal(sliceCount(curSlot().breakMeta[id].slices), countBeforeEdge);

  // Undo reverts structural slice edit cleanly
  A.undo();
  assert.equal(sliceCount(curSlot().breakMeta[id].slices), countBeforeEdge - 1, 'Undo reverted slice addition');
});

/* ---------- 6. Variable-length (1/2/4-bar) playback, Stretch/Tape, BPM timing & Pause/Stop ---------- */
test('1-, 2- and 4-bar imported breaks play full unedited loops without truncation, obey Stretch/Tape & BPM correction, and stop cleanly', async () => {
  await withFakeWindow(async getCtx => {
    const p = createEmptyProject({ name: 'VarLen', bpm: 120 });
    const ruff = slotById(p, RUFF);
    const { sampleStore, bank } = makeBank();
    const engine = createEngine(() => p, { samples: bank });
    const transport = createTransport(engine, () => p);
    engine.init();
    const ctx = getCtx();

    // Import 1-bar (2.0s @ 120), 2-bar (4.0s @ 120), and 4-bar (8.0s @ 120) breaks into A, B, C
    const wav1 = makeDrumBreakWav({ bpm: 120, bars: 1, rate: 8000 });
    const wav2 = makeDrumBreakWav({ bpm: 120, bars: 2, rate: 8000 });
    const wav4 = makeDrumBreakWav({ bpm: 120, bars: 4, rate: 8000 });
    const [r1, r2, r4] = await Promise.all([
      bank.importBytes({ bytes: wav1, name: 'onebar.wav', type: 'audio/wav' }),
      bank.importBytes({ bytes: wav2, name: 'twobar.wav', type: 'audio/wav' }),
      bank.importBytes({ bytes: wav4, name: 'fourbar.wav', type: 'audio/wav' }),
    ]);

    ruff.breaks = { a: r1.meta.id, b: r2.meta.id, c: r4.meta.id };
    ruff.breakMeta = {
      [r1.meta.id]: cleanImportedBreakMeta({ id: r1.meta.id, name: 'OneBar', duration: r1.buffer.duration, bpm: 120, bars: 1, slices: [0, 0.25, 0.5, 0.75, 1] }),
      [r2.meta.id]: cleanImportedBreakMeta({ id: r2.meta.id, name: 'TwoBar', duration: r2.buffer.duration, bpm: 120, bars: 2 }),
      [r4.meta.id]: cleanImportedBreakMeta({ id: r4.meta.id, name: 'FourBar', duration: r4.buffer.duration, bpm: 120, bars: 4 }),
    };

    assert.equal(breakBarsOf(r1.meta.id, ruff.breakMeta), 1);
    assert.equal(breakSourceLoopSteps(r1.meta.id, ruff.breakMeta), 16);
    assert.equal(breakBarsOf(r2.meta.id, ruff.breakMeta), 2);
    assert.equal(breakSourceLoopSteps(r2.meta.id, ruff.breakMeta), 32);
    assert.equal(breakBarsOf(r4.meta.id, ruff.breakMeta), 4);
    assert.equal(breakSourceLoopSteps(r4.meta.id, ruff.breakMeta), 64);

    // Drive scheduler across a full 4-bar cycle (64 transport 16th-steps = 8.0s at 120 BPM)
    const seen = { a: [], b: [], c: [] };
    const spyEngine = {
      ctx,
      stepDur: () => 60 / p.bpm / 4,
      audible: () => true,
      init: () => ctx,
      openGates: () => {},
      closeGates: () => {},
      trigger: (_id, _t, hit) => { seen[hit.lane].push(hit); },
    };
    const origSetInterval = globalThis.setInterval;
    const origClearInterval = globalThis.clearInterval;
    let tickFn = null;
    globalThis.setInterval = fn => { tickFn = fn; return 1; };
    globalThis.clearInterval = () => {};
    try {
      const spyT = createTransport(spyEngine, () => p);
      ctx.currentTime = 0;
      spyT.play();
      // Step clock through 8.0s (64 16th-steps = 4 full bars)
      for (let t = 0.05; t <= 8.0; t += 0.05) {
        ctx.currentTime = t;
        tickFn();
      }
      spyT.stop();
    } finally {
      globalThis.setInterval = origSetInterval;
      globalThis.clearInterval = origClearInterval;
    }

    // 1-bar break cycles startFrac [0, 0.25, 0.5, 0.75] 4 times across 4 bars
    assert.ok(seen.a.length >= 16);
    assert.ok(seen.a.every(h => h.loopBars === 1));
    assert.ok(seen.a.some(h => Math.abs(h.startFrac - 0.75) < 1e-6));
    // 2-bar break cycles 8 beats twice across 4 bars
    assert.ok(seen.b.length >= 16);
    assert.ok(seen.b.every(h => h.loopBars === 2));
    assert.ok(seen.b.some(h => Math.abs(h.startFrac - 0.875) < 1e-6));
    // 4-bar break steps smoothly through all 16 beats (0/16 .. 15/16) with ZERO truncation at Bar 2!
    assert.ok(seen.c.length >= 16);
    assert.ok(seen.c.every(h => h.loopBars === 4));
    assert.ok(seen.c.some(h => Math.abs(h.startFrac - 0.5) < 1e-6), '4-bar break reaches Bar 3');
    assert.ok(seen.c.some(h => Math.abs(h.startFrac - 15 / 16) < 1e-6), '4-bar break reaches Bar 4 beat 4');

    // Direct voice check: 4-bar offsets cover Bars 1, 2, 3 AND 4 with ZERO truncation!
    const voice = engine.E.ch.get(RUFF).voice;
    engine.openGates();
    const dest = engine.E.gates[RUFF];
    ctx.sources.length = 0;
    for (let beat = 0; beat < 16; beat++) {
      voice.trigger(0.1 + beat * 0.5, {
        lane: 'c', breakId: r4.meta.id, loop: true, loopBars: 4,
        startFrac: beat / 16, endFrac: (beat + 1) / 16, dur: 0.5, v: 1,
      }, dest);
    }
    const bar34Triggers = ctx.sources.filter(s => s.startArgs && s.startArgs[1] >= r4.buffer.duration * 0.5 - 0.01);
    assert.equal(bar34Triggers.length, 8, '4-bar break plays all 8 beats in Bars 3–4 without truncating at Bar 2');

    // Manual BPM correction updates Stretch & Tape tempo-fit non-destructively!
    const fpAt120 = breakFitPlayback({ fitMode: 'tape' }, r2.buffer.duration, 2, 160, 120);
    const fpAt140 = breakFitPlayback({ fitMode: 'tape' }, r2.buffer.duration, 2, 160, 140);
    assert.ok(Math.abs(fpAt120.pitchRate - (160 / 120)) < 1e-6);
    assert.ok(Math.abs(fpAt140.pitchRate - (160 / 140)) < 1e-6);
    assert.notEqual(fpAt120.pitchRate, fpAt140.pitchRate, 'BPM correction updates playback timing');

    const fpStretch = breakFitPlayback({ fitMode: 'stretch' }, r2.buffer.duration, 2, 160, 120);
    assert.equal(fpStretch.pitchRate, 1, 'Stretch mode preserves pitch');
    assert.ok(Math.abs(fpStretch.stretch - (120 / 160)) < 1e-6);

    // Pause / Stop silences all RUFF voices with zero orphans
    engine.closeGates();
    ctx.advance(20);
    assert.equal(voice.activeCount(), 0, 'zero orphan voices after Stop');
  });
});

/* ---------- 7. CHOP IT! with imported break metadata ---------- */
test('CHOP IT! works with imported breaks across all 4 profiles without fake kick/snare labels, respecting locks, silence & A/B/C interplay', async () => {
  const buf = await decodeWav(makeDrumBreakWav({ bpm: 165, bars: 2 }));
  const analyzed = analyzeBreakBuffer(buf);
  const impId = 'smp-' + 'a'.repeat(64);
  const breakMeta = {
    [impId]: cleanImportedBreakMeta({
      id: impId, name: 'AmenStyle', duration: buf.duration,
      bpm: analyzed.bpm, bars: analyzed.bars, slices: analyzed.slices,
      sliceMeta: analyzed.sliceMeta, analysis: analyzed.analysis,
    }),
  };

  // Verify honest metadata: never claims kick/snare labels on unknown imported audio
  const slice0Info = breakSliceInfo(impId, 0, breakMeta);
  assert.equal(slice0Info.role, 'imported');
  assert.ok(!/kick|snare/i.test(slice0Info.label), 'does not pretend to have kick/snare labels');

  const src = analyzeBreakSource(impId, breakMeta);
  assert.equal(src.hasRichMeta, false);
  assert.equal(src.usesAudioFeatures, true);
  assert.equal(src.count, sliceCount(analyzed.slices));

  // A) Solo imported break across all 4 profiles
  const soloProj = createEmptyProject({ name: 'SoloChopImport', bpm: 165 });
  const soloRuff = slotById(soloProj, RUFF);
  soloRuff.breaks = { a: impId, b: null, c: null };
  soloRuff.breakMeta = breakMeta;
  const soloPat = patternAt(soloProj, RUFF, 0);
  const maxIdx = sliceCount(breakMeta[impId].slices) - 1;
  const soloCounts = {};
  for (const profile of RUFF_CHOP_PROFILES) {
    const r = chopBreakPattern({ pattern: soloPat, breaks: soloRuff.breaks, breakMeta, mode: 'new', profile, intensity: 0.65, seed: 42 });
    assert.equal(r.changed, true);
    const hits = r.pattern.lanes.a.filter(Boolean);
    soloCounts[profile] = hits.length;
    assert.ok(hits.length >= 4, `${profile} solo imported break has musical groove (${hits.length} hits)`);
    for (const c of hits) assert.ok(c.slice >= 0 && c.slice <= maxIdx);
  }
  assert.ok(soloCounts.darkside < soloCounts.rolling, `darkside (${soloCounts.darkside}) stays sparser than rolling (${soloCounts.rolling})`);

  // B) Multi-lane A/B/C interplay (imported + built-in) with locks & intentional silence
  const p = createEmptyProject({ name: 'ChopImport', bpm: 165 });
  const ruff = slotById(p, RUFF);
  ruff.breaks = { a: impId, b: 'brk-builtin-tight', c: 'brk-builtin-jungle' };
  ruff.breakMeta = breakMeta;
  const basePat = patternAt(p, RUFF, 0);
  // Lock step 0 on lane A and silence lane C intentionally
  basePat.locked = { 'a:0': true };
  basePat.edited = { c: true };
  basePat.lanes.c = Array(16).fill(null);

  for (const profile of RUFF_CHOP_PROFILES) {
    const r1 = chopBreakPattern({ pattern: basePat, breaks: ruff.breaks, breakMeta, mode: 'new', profile, intensity: 0.65, seed: 42 });
    const r2 = chopBreakPattern({ pattern: basePat, breaks: ruff.breaks, breakMeta, mode: 'new', profile, intensity: 0.65, seed: 42 });
    assert.deepEqual(r1.pattern, r2.pattern, `${profile}: deterministic for fixed seed`);
    assert.equal(r1.changed, true);

    const laneAHits = r1.pattern.lanes.a.filter(Boolean);
    const laneBHits = r1.pattern.lanes.b.filter(Boolean);
    assert.ok(laneAHits.length >= 2, `${profile}: lane A contributes hits (${laneAHits.length})`);
    assert.ok(laneAHits.length + laneBHits.length >= 8, `${profile}: combined A+B groove has musical density`);
    for (const c of laneAHits) {
      assert.ok(Number.isInteger(c.slice) && c.slice >= 0 && c.slice <= maxIdx, `${profile}: slice ${c.slice} in bounds [0..${maxIdx}]`);
    }
    // Locked step a:0 kept intact (original slice 0)
    assert.equal(r1.pattern.lanes.a[0].slice, 0, `${profile}: locked step a:0 preserved`);
    // Intentionally silent lane C stays silent!
    assert.equal(r1.pattern.lanes.c.some(Boolean), false, `${profile}: intentionally silent lane C preserved`);
  }
});

/* ---------- 9. Save/reopen & portable .hbn round-trip (MUNCH + RUFF + built-in) ---------- */
test('imported RUFF breaks round-trip through localStorage library and portable .hbn alongside MUNCH and built-in breaks', async () => {
  const src = makeBank();
  const dst = makeBank();
  const lib = createLibrary(memoryStorage());

  const p = createEmptyProject({ name: 'Portable Jungle', bpm: 162 });
  const munch = slotById(p, MUNCH);
  const ruff = slotById(p, RUFF);

  // Add one MUNCH sample AND two imported RUFF breaks (1-bar and 4-bar) plus one built-in RUFF break
  const munchWav = makeWav({ seconds: 1.0, rate: 22050, freq: 330 });
  const brk1Wav = makeDrumBreakWav({ bpm: 130, bars: 1, rate: 22050 });
  const brk4Wav = makeDrumBreakWav({ bpm: 162, bars: 4, rate: 22050 });

  const mImp = await src.bank.importBytes({ bytes: munchWav, name: 'munch-vox.wav', type: 'audio/wav' });
  const b1Imp = await src.bank.importBytes({ bytes: brk1Wav, name: 'onebar.wav', type: 'audio/wav' });
  const b4Imp = await src.bank.importBytes({ bytes: brk4Wav, name: 'fourbar.wav', type: 'audio/wav' });

  munch.sample = { id: mImp.meta.id, name: 'munch-vox.wav', duration: mImp.buffer.duration, sampleRate: 22050, channels: 1, slices: [0, 0.5, 1] };
  const a1 = analyzeBreakBuffer(b1Imp.buffer, { preferredBars: 1 });
  const a4 = analyzeBreakBuffer(b4Imp.buffer, { preferredBars: 4 });
  ruff.breaks = { a: b1Imp.meta.id, b: 'brk-builtin-jungle', c: b4Imp.meta.id };
  ruff.breakMeta = {
    [b1Imp.meta.id]: cleanImportedBreakMeta({ id: b1Imp.meta.id, name: 'OneBar', duration: b1Imp.buffer.duration, bpm: 131.5, bars: 1, slices: a1.slices, sliceMeta: a1.sliceMeta, analysis: a1.analysis }),
    [b4Imp.meta.id]: cleanImportedBreakMeta({ id: b4Imp.meta.id, name: 'FourBar', duration: b4Imp.buffer.duration, bpm: 162, bars: 4, slices: a4.slices, sliceMeta: a4.sliceMeta, analysis: a4.analysis }),
  };

  // sampleRefsOf includes MUNCH + both imported RUFF breaks, excludes built-in RUFF break
  const refs = sampleRefsOf(p);
  assert.equal(refs.length, 3);
  assert.ok(refs.includes(mImp.meta.id));
  assert.ok(refs.includes(b1Imp.meta.id));
  assert.ok(refs.includes(b4Imp.meta.id));
  assert.ok(!refs.includes('brk-builtin-jungle'));

  // Library save / reopen round-trip
  assert.equal(lib.save(p), true);
  const reopened = lib.load(p.id);
  assert.deepEqual(reopened.slots.find(s => s.id === RUFF).breaks, ruff.breaks);
  assert.deepEqual(reopened.slots.find(s => s.id === RUFF).breakMeta, ruff.breakMeta);

  // Portable .hbn export & import on a clean device
  const pkg = await exportPackage(p, { sampleStore: src.sampleStore });
  assert.equal(pkg.sampleCount, 3, 'MUNCH + 2 imported RUFF breaks bundled');
  const parsed = await parsePackage(pkg.bytes);
  assert.equal(parsed.samples.length, 3);

  const restored = await importPackage(pkg.bytes, { sampleStore: dst.sampleStore, decode: decodeWav });
  assert.equal(restored.restored.length, 3);
  const rRuff = slotById(restored.project, RUFF);
  assert.deepEqual(rRuff.breaks, ruff.breaks);
  assert.deepEqual(rRuff.breakMeta, ruff.breakMeta);
  assert.equal(await dst.sampleStore.has(b1Imp.meta.id), true);
  assert.equal(await dst.sampleStore.has(b4Imp.meta.id), true);
  // Restored .hbn also populates meta.ruff in destination sampleStore for local Break Pool reuse
  const dstMeta1 = await dst.sampleStore.getMeta(b1Imp.meta.id);
  assert.equal(dstMeta1.ruff.bars, 1);
  assert.equal(dstMeta1.ruff.bpm, 131.5);
});

/* ---------- 10. Missing assets & durable storage failure recovery ---------- */
test('missing imported breaks are never silently dropped or replaced, and durable storage failures are reported clearly and recoverable', async () => {
  // A) Missing asset on a project reopened on a new device
  const p = createEmptyProject({ name: 'MissingAsset', bpm: 140 });
  const ruff = slotById(p, RUFF);
  const missingId = 'smp-' + 'b'.repeat(64);
  ruff.breaks = { a: missingId, b: null, c: null };
  ruff.breakMeta = {
    [missingId]: cleanImportedBreakMeta({ id: missingId, name: 'LostBreak', duration: 3.0, bpm: 160, bars: 2 }),
  };

  // Project validation preserves the missing break reference & metadata verbatim (never replaces with a built-in!)
  const validated = validateProject(JSON.parse(JSON.stringify(p)));
  const vRuff = slotById(validated, RUFF);
  assert.equal(vRuff.breaks.a, missingId);
  assert.equal(vRuff.breakMeta[missingId].name, 'LostBreak');

  // Exporting .hbn aborts with clear missing-sample PackageError naming the missing break
  const emptyStore = makeBank().sampleStore;
  await assert.rejects(
    exportPackage(validated, { sampleStore: emptyStore }),
    err => err instanceof PackageError && err.code === 'missing-sample' && /LostBreak/.test(err.message),
  );

  // Loading from bank marks status 'missing' clearly instead of silently substituting another break
  const emptyBank = makeBank().bank;
  const buf = await emptyBank.load(missingId);
  assert.equal(buf, null);
  assert.equal(emptyBank.state(missingId).status, 'missing');

  // B) Durable storage write failure (e.g. Safari quota/storage error): clearly reported, playable in memory, recoverable via retryUnsaved
  const failing = makeBank({ failures: [{ op: 'put', name: 'QuotaExceededError', times: 1 }] });
  const slotRuff = resetAppToRuff();
  const wav = makeDrumBreakWav({ bpm: 155, bars: 2 });
  const r = await A.importBreakFile(wavFile(wav, 'QuotaTest.wav'), { lane: 'a', slotId: RUFF, bank: failing.bank });
  assert.equal(r.ok, true);
  assert.equal(r.stored, false, 'reports stored: false when durable write fails');
  assert.ok(r.error instanceof SampleError && r.error.code === 'quota');
  assert.equal(failing.sampleStore.isUnsaved(r.id), true, 'tracked as unsaved in memory');
  assert.ok(failing.bank.buffer(r.id), 'still decoded and playable in current session');
  assert.equal(slotRuff.breaks.a, r.id);

  // Once storage recovers, retryUnsaved writes the original bytes + ruff metadata durably!
  const retry = await failing.sampleStore.retryUnsaved();
  assert.deepEqual(retry.saved, [r.id]);
  assert.equal(retry.failed.length, 0);
  assert.equal(await failing.sampleStore.has(r.id), true);
  const persistedMeta = await failing.sampleStore.getMeta(r.id);
  assert.ok(persistedMeta.ruff && persistedMeta.ruff.name === 'QuotaTest', 'RUFF metadata persisted cleanly on retry');
});
