// HarbuMatic v0.7 PR3 — RUFF: Break-aware Slicing & Hybrid Sequencer tests.
// Covers: first-edit groove conversion (no mutation on inspect), two-bar/16-step mapping (Bar 1 + Bar 2,
// exact BPM sync, mid-step Pause/Resume, Stretch/Tape), explicit unedited/edited/empty-lane silence semantics,
// break-aware slice suggestion & reassignment (audible offset change + slice audition + source-change safety),
// three-lane A/B/C concurrency, Undo/Redo, scene isolation & transitions, library persistence and .hbn round-trip.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_BREAK_IDS, BREAK_PATTERN_STEPS, BREAK_STEP_SPAN, BREAK_LOOP_STEPS,
  getBuiltinBreak, breakStepTiming, breakStepBeatLabel, suggestedSliceForStep,
  clampBreakSlice, breakSliceInfo, isBreakLaneEdited, originalGrooveRow,
  effectiveBreakRow, breakFitPlayback,
} from '../src/core/breaks.js';
import { createEmptyProject, slotById, patternAt, sceneHasContent, validateProject } from '../src/core/project.js';
import { createLibrary, memoryStorage } from '../src/core/persistence.js';
import { exportPackage, parsePackage, restorePackage } from '../src/core/package.js';
import { createSampleStore, memoryBackend } from '../src/samples/store.js';
import { createSampleBank } from '../src/samples/bank.js';
import { stretchChannels } from '../src/samples/stretch.js';
import { createEngine } from '../src/audio/engine.js';
import { createTransport } from '../src/audio/scheduler.js';
import { store } from '../src/app/store.js';
import * as A from '../src/app/actions.js';
import { decodeWav, makeWav, withFakeWindow } from './helpers/audio.mjs';

const R = 'slot-06';
const near = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;

const syncRunner = {
  mode: 'test',
  run: (chans, rate, factor, anchors) => Promise.resolve(stretchChannels(chans, rate, factor, { anchors })),
};

async function ruffRig(fn, { bpm = 120, fitMode = 'stretch' } = {}) {
  const wavCache = new Map();
  const fetchAsset = async (_url, id) => {
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

function runTransport(p, engine, ctx) {
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
    }
  };
  return {
    tr,
    step,
    cleanup() { tr.stop(); globalThis.setInterval = si; globalThis.clearInterval = ci; },
  };
}

test('opening and inspecting the RUFF sequencer never mutates project data; first edit converts only the edited lane while preserving both bars', () => {
  store.project = createEmptyProject({ name: 'RUFF First Edit' });
  store.ui.sel = R;
  A.history.clear();

  A.assignBreak('a', 'brk-builtin-tight', R);
  A.assignBreak('b', 'brk-builtin-funky', R);
  A.history.clear();

  const before = JSON.stringify(store.project);
  const p = patternAt(store.project, R, 0);

  // Inspecting: switching Compact <-> Expanded, selecting steps/lanes, reading effectiveBreakRow
  A.setRuffView('compact');
  A.selectRuffStep(4, 'a');
  A.setRuffView('expanded');
  A.selectRuffStep(12, 'b');
  const previewA = effectiveBreakRow(p, 'a', 'brk-builtin-tight');
  assert.equal(previewA.length, 16);
  assert.equal(previewA.every((c, i) => c && c.slice === i && c.virtual === true), true, 'unedited preview shows full 16-slice 2-bar groove');
  assert.equal(JSON.stringify(store.project), before, 'opening and inspecting never modifies project data');
  assert.equal(isBreakLaneEdited(p, 'a'), false);
  assert.equal(isBreakLaneEdited(p, 'b'), false);
  assert.equal(A.history.canUndo, false);

  // First edit on lane A: toggle off step 10 (Bar 2, beat 2)
  assert.equal(A.toggleBreakStep('a', 10, R), true);
  assert.equal(isBreakLaneEdited(p, 'a'), true, 'lane A is now explicitly edited');
  assert.equal(p.edited.a, true);
  assert.equal(p.lanes.a[10], null, 'step 10 removed');
  for (let i = 0; i < 16; i++) {
    if (i === 10) continue;
    assert.equal(p.lanes.a[i]?.slice, i, `step ${i} preserves original 2-bar home slice ${i}`);
  }
  // Lane B stays completely unedited!
  assert.equal(isBreakLaneEdited(p, 'b'), false, 'untouched lane B remains unedited');
  assert.equal(p.lanes.b.every(c => c === null), true);
  assert.equal(p.edited.b, undefined);

  // Undo reverts BOTH the lane cells AND the edited flag back to unedited whole-loop!
  A.undo();
  const afterUndo = patternAt(store.project, R, 0);
  assert.equal(isBreakLaneEdited(afterUndo, 'a'), false, 'Undo restores unedited whole-loop semantics');
  assert.equal(afterUndo.lanes.a.every(c => c === null), true);
  assert.deepEqual(afterUndo.edited, {});

  // Redo restores the edited 16-step pattern cleanly
  A.redo();
  const afterRedo = patternAt(store.project, R, 0);
  assert.equal(isBreakLaneEdited(afterRedo, 'a'), true);
  assert.equal(afterRedo.lanes.a[10], null);
  assert.equal(afterRedo.lanes.a[15]?.slice, 15, 'Bar 2 turnaround slice preserved after Redo');
});

test('two-bar / 16-step mapping schedules all 16 slices across Bar 1 and Bar 2 with exact BPM timing, seamless looping and mid-step Pause/Resume', () => ruffRig(async ({ p, ruff, engine, ctx, voice }) => {
  // 120 BPM -> sd = 0.125s (16th note), 1 RUFF step = 2*sd = 0.25s (8th note), 16 steps = 4.0s (2 full bars)
  const sd = 60 / p.bpm / 4;
  ruff.breaks.a = 'brk-builtin-tight';
  const pat = patternAt(p, R, 0);
  pat.edited.a = true;
  pat.lanes.a = originalGrooveRow('brk-builtin-tight', 16);

  assert.deepEqual(breakStepTiming('brk-builtin-tight', 16), { bars: 2, len: 16, loopSteps: 32, stepSpan: 2 });
  assert.equal(breakStepBeatLabel(0), '1.1');
  assert.equal(breakStepBeatLabel(7), '1.4+');
  assert.equal(breakStepBeatLabel(8), '2.1');
  assert.equal(breakStepBeatLabel(15), '2.4+');

  const run = runTransport(p, engine, ctx);
  try {
    run.tr.play();
    // Run 4.1s (> 1 full 2-bar loop so step 0 wraps cleanly at 4.0s)
    run.step(4.1);

    // Filter scheduled slice sources starting within [0.06, 4.10]
    const srcs = ctx.sources.filter(s => s.startArgs && s.startArgs[0] >= 0.05 && s.startArgs[0] <= 4.10);
    // 16 steps across 2 bars + wrapped step 0 at t = 0.06 + 4.0 = 4.06 => 17 triggers
    assert.ok(srcs.length >= 17, `expected >= 17 slice triggers across 2 bars + wrap (got ${srcs.length})`);
    for (let i = 0; i < 16; i++) {
      const expectedT = 0.06 + i * 2 * sd;
      const expectedOff = (i / 16) * srcs[i].buffer.duration;
      assert.ok(near(srcs[i].startArgs[0], expectedT, 0.002), `step ${i} scheduled at exact 8th-note time (${srcs[i].startArgs[0]} vs ${expectedT})`);
      assert.ok(near(srcs[i].startArgs[1], expectedOff, 0.002), `step ${i} plays slice ${i} offset (${srcs[i].startArgs[1]} vs ${expectedOff})`);
      // Exact slice duration = 2*sd with zero unintended gap
      const dur = srcs[i].stopAt - srcs[i].startArgs[0] - 0.002;
      assert.ok(near(dur, 2 * sd, 0.005), `step ${i} duration matches 2*sd (${dur} vs ${2 * sd})`);
    }
    // Step 16 wraps seamlessly back to Bar 1 slice 0 at t = 0.06 + 4.0s
    assert.ok(near(srcs[16].startArgs[0], 0.06 + 32 * sd, 0.002), '2-bar loop wraps seamlessly at 32*sd');
    assert.ok(near(srcs[16].startArgs[1], 0, 0.002), 'wrap restarts at slice 0');

    // Mid-step Pause & Resume: stop and restart cleanly, advance to an odd transport step (midway through a RUFF slice)
    run.tr.stop();
    assert.equal(voice.activeCount(), 0);
    run.tr.play();
    run.step(0.50); // lands on odd transport step 5 (subStep = 1 of RUFF step 2)
    run.tr.pause();
    assert.equal(voice.activeCount(), 0, 'Pause silences active slices immediately');
    const pausedStep = run.tr.position.step;
    assert.equal(pausedStep % 2, 1, `paused mid-step at odd transport step ${pausedStep}`);

    const beforeResume = ctx.sources.length;
    run.tr.play();
    const resumed = ctx.sources.slice(beforeResume);
    assert.ok(resumed.length >= 1, 'Resume immediately triggers remaining half of active edited slice');
    const stepIdx = Math.floor((pausedStep % BREAK_LOOP_STEPS) / BREAK_STEP_SPAN);
    const expectedHalfOff = ((stepIdx + 0.5) / 16) * resumed[0].buffer.duration;
    assert.ok(near(resumed[0].startArgs[1], expectedHalfOff, 0.005), `mid-step resume starts halfway into slice ${stepIdx}`);
  } finally {
    run.cleanup();
  }
  assert.equal(voice.activeCount(), 0, 'Stop leaves zero orphan voices');
}));

test('explicit empty edited lane stays silent (never restarts whole-loop) and resetBreakLane restores original groove', () => ruffRig(async ({ p, ruff, engine, ctx, voice }) => {
  ruff.breaks.a = 'brk-builtin-tight';
  const pat = patternAt(p, R, 0);

  // Explicitly edited and all steps null -> MUST remain silent!
  pat.edited.a = true;
  pat.lanes.a = Array(16).fill(null);
  assert.equal(isBreakLaneEdited(pat, 'a'), true);
  assert.equal(sceneHasContent(p, 0), false, 'intentionally empty edited lane reports no scene content');

  const run = runTransport(p, engine, ctx);
  try {
    run.tr.play();
    run.step(2.0);
    assert.equal(ctx.sources.length, 0, 'intentionally empty edited lane triggers ZERO voices (no whole-loop fallback)');

    // Resetting back to unedited (removing edited flag) immediately resumes original whole-loop playback
    delete pat.edited.a;
    assert.equal(isBreakLaneEdited(pat, 'a'), false);
    assert.equal(sceneHasContent(p, 0), true);
    run.step(0.6);
    assert.ok(ctx.sources.length >= 1, 'unedited lane plays whole-loop groove');
  } finally {
    run.cleanup();
  }
  assert.equal(voice.activeCount(), 0);
}));

test('clearing an edited lane via actions (last step toggle, clearBreakLane, clearPattern) keeps silence and supports Undo/Redo', () => {
  store.project = createEmptyProject({ name: 'RUFF Empty Semantics' });
  store.ui.sel = R;
  A.assignBreak('a', 'brk-builtin-tight', R);
  A.history.clear();

  // Clear entire lane directly from unedited state -> edited + silent
  assert.equal(A.clearBreakLane('a', R), true);
  let pat = patternAt(store.project, R, 0);
  assert.equal(pat.edited.a, true);
  assert.equal(isBreakLaneEdited(pat, 'a'), true);
  assert.equal(pat.lanes.a.every(c => c === null), true);

  // Add one step, then toggle that single step off -> still edited + silent
  assert.equal(A.toggleBreakStep('a', 2, R), true);
  assert.equal(pat.lanes.a[2]?.slice, 2, 'suggested slice for step 2 is slice 2');
  assert.equal(A.toggleBreakStep('a', 2, R), true);
  assert.equal(pat.edited.a, true, 'toggling off the last remaining step keeps edited flag');
  assert.equal(pat.lanes.a.every(c => c === null), true);

  // Reset to original groove -> unedited
  assert.equal(A.resetBreakLane('a', R), true);
  assert.equal(isBreakLaneEdited(pat, 'a'), false);
  assert.equal(pat.edited.a, undefined);

  // Undo restores edited-empty silence
  A.undo();
  pat = patternAt(store.project, R, 0);
  assert.equal(isBreakLaneEdited(pat, 'a'), true);
  assert.equal(pat.lanes.a.every(c => c === null), true);

  // Global toolbar Clear on RUFF also marks assigned lanes edited-empty (silence)
  A.resetBreakLane('a', R);
  assert.equal(isBreakLaneEdited(patternAt(store.project, R, 0), 'a'), false);
  A.clearPattern();
  pat = patternAt(store.project, R, 0);
  assert.equal(pat.edited.a, true, 'clearPattern silences RUFF rather than restarting whole-loop');
  assert.equal(pat.lanes.a.every(c => c === null), true);
});

test('slice reassignment changes audible buffer region, supports single-slice audition, and preserves edits across source changes', () => ruffRig(async ({ p, ruff, engine, ctx, voice }) => {
  ruff.breaks.a = 'brk-builtin-jungle';
  const pat = patternAt(p, R, 0);
  pat.edited.a = true;
  pat.lanes.a[0] = { slice: 2, v: 1, p: 1 };  // Rimshot (2/16)
  pat.lanes.a[1] = { slice: 15, v: 1, p: 1 }; // 32nd Roll (15/16)

  assert.equal(suggestedSliceForStep('brk-builtin-jungle', 15), 15);
  assert.equal(breakSliceInfo('brk-builtin-jungle', 15).code, 'S16');
  assert.equal(breakSliceInfo('brk-builtin-jungle', 15).label, '32nd Roll');
  assert.equal(clampBreakSlice('brk-builtin-jungle', 99), 15, 'out-of-range slice clamped to valid upper bound');
  assert.equal(clampBreakSlice('brk-builtin-jungle', -3), 0, 'negative slice clamped to 0');

  const run = runTransport(p, engine, ctx);
  try {
    run.tr.play();
    run.step(0.5);
    const [s0, s1] = ctx.sources;
    assert.ok(s0 && s1, 'both reassigned steps fired');
    const dur = s0.buffer.duration;
    assert.ok(near(s0.startArgs[1], (2 / 16) * dur, 0.002), 'step 0 plays slice 2 offset');
    assert.ok(near(s1.startArgs[1], (15 / 16) * dur, 0.002), 'step 1 plays slice 15 offset');

    // Reassign step 0 from slice 2 to slice 8 (Bar 2 Kick Crash) -> audible offset changes on next loop
    pat.lanes.a[0].slice = 8;
    run.step(3.7);
    const wrapped = ctx.sources.find(s => s.startArgs && near(s.startArgs[0], 0.06 + 4.0, 0.01));
    assert.ok(wrapped, 'wrapped step 0 triggered');
    assert.ok(near(wrapped.startArgs[1], (8 / 16) * wrapped.buffer.duration, 0.002), 'reassigned step 0 plays new slice 8 offset');

    run.tr.stop();
    // Single-slice audition plays only the requested slice region (not the full 2-bar break)
    const beforeAud = ctx.sources.length;
    engine.audition(R, null, 0.9, { lane: 'a', breakId: 'brk-builtin-jungle', slice: 15 });
    const aud = ctx.sources[beforeAud];
    assert.ok(aud, 'slice audition triggered');
    assert.ok(near(aud.startArgs[1], (15 / 16) * aud.buffer.duration, 0.002), 'slice audition starts at slice 15');
    const audPlayDur = aud.stopAt - aud.startArgs[0] - 0.002;
    assert.ok(audPlayDur < 0.5, `slice audition lasts 1 slice (~0.25s at 120 BPM), not full 2-bar loop (got ${audPlayDur})`);
    run.tr.stop();
    assert.equal(voice.activeCount(), 0);
  } finally {
    run.cleanup();
  }

  // Changing break source through actions preserves all edits cleanly
  store.project = createEmptyProject({ name: 'Source Swap' });
  store.ui.sel = R;
  A.assignBreak('a', 'brk-builtin-tight', R);
  A.setBreakStepSlice('a', 3, 14, R);
  A.assignBreak('a', 'brk-builtin-funky', R);
  const afterSwap = patternAt(store.project, R, 0);
  assert.equal(afterSwap.edited.a, true);
  assert.equal(afterSwap.lanes.a[3]?.slice, 14, 'switching break source preserves slice reassignment');
  assert.equal(breakSliceInfo('brk-builtin-funky', afterSwap.lanes.a[3].slice).label, 'Snare Rim');
}));

test('three-lane A/B/C concurrency mixes unedited, edited and silent lanes simultaneously and preserves Stretch/Tape BPM sync', () => ruffRig(async ({ p, ruff, engine, ctx, bank, voice }) => {
  p.bpm = 140;
  ruff.breaks = { a: 'brk-builtin-tight', b: 'brk-builtin-funky', c: 'brk-builtin-jungle' };
  const pat = patternAt(p, R, 0);
  // Lane A: unedited (whole-loop)
  // Lane B: edited with hit on step 0 (slice 10)
  pat.edited.b = true;
  pat.lanes.b[0] = { slice: 10, v: 0.9, p: 1 };
  // Lane C: edited & intentionally empty (silent)
  pat.edited.c = true;
  pat.lanes.c = Array(16).fill(null);

  // Pre-render stretched buffer for FUNKY at 140 BPM
  const funky = getBuiltinBreak('brk-builtin-funky');
  const fpStretch = breakFitPlayback({ fitMode: 'stretch' }, funky.duration, funky.bars, 140);
  bank.requestStretch(funky.id, fpStretch.stretch, funky.slices, false);
  await bank.stretchIdle();

  const run = runTransport(p, engine, ctx);
  try {
    run.tr.play();
    run.step(0.15);
    const beat0 = ctx.sources.filter(s => s.startArgs && near(s.startArgs[0], 0.06, 0.005));
    assert.equal(beat0.length, 2, 'unedited lane A and edited lane B fire together while silent lane C triggers nothing');
    // Lane B used Stretch WSOLA buffer with playbackRate ~ 1.0 (pitch preserved)
    assert.ok(near(beat0[1].playbackRate.value, 1.0, 0.005), 'edited slice preserves pitch in Stretch mode');
    assert.ok(near(beat0[1].startArgs[1], (10 / 16) * beat0[1].buffer.duration, 0.005), 'edited lane B starts at slice 10');

    // Now add a hit on lane C at step 2 (transport step 4 = beat 2) and switch to Tape mode
    pat.lanes.c[2] = { slice: 6, v: 1, p: 1 };
    pat.lanes.b[2] = { slice: 2, v: 0.85, p: 1 };
    ruff.params.fitMode = 'tape';
    engine.applyParams(R);

    const beat2T = 0.06 + 4 * (60 / 140 / 4);
    run.step(0.5);
    const beat2 = ctx.sources.filter(s => s.startArgs && near(s.startArgs[0], beat2T, 0.005));
    assert.equal(beat2.length, 3, 'all 3 lanes A (loop) + B (slice) + C (slice) fire concurrently at beat 2');
    assert.ok(near(beat2[1].playbackRate.value, 140 / 105, 0.01), 'edited lane B follows Tape playbackRate');
    assert.ok(near(beat2[2].playbackRate.value, 140 / 160, 0.01), 'edited lane C follows Tape playbackRate');
  } finally {
    run.cleanup();
  }
  assert.equal(voice.activeCount(), 0, 'Stop cleans up all 3 concurrent lanes with zero orphan voices');
}));

test('scene isolation, scene duplication, Undo/Redo, library save/reopen and .hbn round-trip preserve complete RUFF state', async () => {
  store.project = createEmptyProject({ name: 'RUFF PR3 Full Roundtrip' });
  store.ui.sel = R;
  A.history.clear();

  A.assignBreak('a', 'brk-builtin-tight', R);
  A.assignBreak('b', 'brk-builtin-funky', R);
  A.assignBreak('c', 'brk-builtin-jungle', R);
  // Lane A: edited with reassigned slice
  A.setBreakStepSlice('a', 4, 12, R);
  // Lane B: explicitly cleared to silence
  A.clearBreakLane('b', R);
  // Lane C: unedited original groove

  // New Scene creates a fresh unedited RUFF pattern without touching Scene 1
  const created = A.createScene({ name: 'Scene Two' });
  const pNew = patternAt(store.project, R, created.index);
  assert.deepEqual(pNew.edited, {});
  assert.equal(isBreakLaneEdited(pNew, 'a'), false);
  assert.equal(isBreakLaneEdited(pNew, 'b'), false);
  assert.equal(patternAt(store.project, R, 0).lanes.a[4]?.slice, 12, 'Scene 1 intact');

  // Duplicate Scene 1 -> independent copy of lanes AND edited semantics
  const dup = A.duplicateScene(0);
  const pDup = patternAt(store.project, R, dup.index);
  assert.equal(pDup.edited.a, true);
  assert.equal(pDup.edited.b, true);
  assert.equal(pDup.edited.c, undefined);
  assert.equal(pDup.lanes.a[4]?.slice, 12);
  assert.equal(pDup.lanes.b.every(c => c === null), true);

  // Edit duplicated scene without affecting Scene 1
  A.setBreakStepSlice('a', 4, 3, R);
  assert.equal(patternAt(store.project, R, dup.index).lanes.a[4]?.slice, 3);
  assert.equal(patternAt(store.project, R, 0).lanes.a[4]?.slice, 12, 'source scene untouched');

  // Validation cleans bogus edited keys while keeping valid ones
  const raw = JSON.parse(JSON.stringify(store.project));
  raw.slots.find(s => s.id === R).patterns[raw.scenes[0].id].edited.bogus = true;
  const validated = validateProject(raw);
  assert.deepEqual(patternAt(validated, R, 0).edited, { a: true, b: true });

  // Library save/reopen round-trip
  const snap = JSON.parse(JSON.stringify(store.project));
  const mem = memoryStorage();
  const lib = createLibrary(mem);
  assert.equal(lib.save(snap), true);
  const reopened = createLibrary(mem).load(snap.id);
  assert.deepEqual(reopened, snap, 'library save/reopen preserves breaks, lanes and edited semantics');

  // Portable .hbn export/import round-trip
  const sampleStore = createSampleStore({ backend: memoryBackend() });
  const pkg = await exportPackage(snap, { sampleStore });
  const parsed = await parsePackage(pkg.bytes);
  const restored = await restorePackage(parsed, { sampleStore });
  assert.deepEqual(restored.project, snap, '.hbn export/import preserves complete current-version RUFF state');
});

test('transport scene transitions switch cleanly between edited, silent-edited and unedited RUFF scenes', () => ruffRig(async ({ p, ruff, engine, ctx, voice }) => {
  ruff.breaks.a = 'brk-builtin-tight';
  // Add Scene 2 (intentionally silent edited lane A) and Scene 3 (unedited original groove)
  p.scenes.push({ id: 'scene-02', name: 'Break Silence', harmony: null });
  p.scenes.push({ id: 'scene-03', name: 'Original Loop', harmony: null });
  p.slots.forEach(s => {
    s.patterns['scene-02'] = JSON.parse(JSON.stringify(s.patterns['scene-01']));
    s.patterns['scene-03'] = JSON.parse(JSON.stringify(s.patterns['scene-01']));
  });
  // Scene 1: edited slice 12 on step 0 only
  const p1 = patternAt(p, R, 0);
  p1.edited.a = true;
  p1.lanes.a[0] = { slice: 12, v: 1, p: 1 };
  // Scene 2: edited & intentionally empty (silent)
  const p2 = patternAt(p, R, 1);
  p2.edited.a = true;
  p2.lanes.a = Array(16).fill(null);
  // Scene 3: unedited original whole-loop
  const p3 = patternAt(p, R, 2);
  p3.edited = {};
  p3.lanes.a = Array(16).fill(null);

  const run = runTransport(p, engine, ctx);
  try {
    run.tr.play();
    run.step(0.15);
    assert.equal(ctx.sources.length, 1, 'Scene 1 fires edited slice 12');
    assert.ok(near(ctx.sources[0].startArgs[1], (12 / 16) * ctx.sources[0].buffer.duration, 0.005));

    // Queue Scene 2 (silent edited) at the next bar line (2.0s at 120 BPM)
    run.tr.queueScene(1);
    run.step(1.9); // reaches Bar 1 end -> switches to Scene 2
    const countAtScene2Start = ctx.sources.length;
    run.step(1.0); // 2 beats inside Scene 2
    assert.equal(ctx.sources.length, countAtScene2Start, 'Scene 2 (edited empty) produces silence after transition');

    // Queue Scene 3 (unedited whole-loop) at the next bar line
    run.tr.queueScene(2);
    run.step(1.5); // crosses into Scene 3
    assert.ok(ctx.sources.length > countAtScene2Start, 'Scene 3 (unedited) resumes original loop playback cleanly');
  } finally {
    run.cleanup();
  }
  assert.equal(voice.activeCount(), 0, 'Stop leaves zero orphan voices after scene transitions');
}));

