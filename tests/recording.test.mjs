// HBM-061-06 — Live Pattern Recording unit tests.
// Covers REC transport states, lookahead-compensated audible timing, duplicate-trigger suppression,
// Quantize On/Off (including drum timing offset `o` and swing compensation), all five instruments
// (BOP, GOO, BLIP, FUZZ, MUNCH melodic & slice pads), multi-touch, held note duration & loop wrapping,
// overdub, locked notes/rows, session-level Undo/Redo, empty recording history safety, and .hbn round-trip.

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStepPlacement, recordDrumEvent, recordNoteOnEvent, finalizeNoteLength } from '../src/audio/recording.js';
import { createEmptyProject, importProject, patternAt, sceneIdAt, slotById } from '../src/core/project.js';
import { exportPackage, parsePackage, restorePackage } from '../src/core/package.js';
import { createSampleStore, memoryBackend } from '../src/samples/store.js';
import { sampleRefFor } from '../src/core/samples.js';
import { createTransport } from '../src/audio/scheduler.js';
import { store } from '../src/app/store.js';
import * as A from '../src/app/actions.js';
import { makeWav, decodeWav, withFakeWindow } from './helpers/audio.mjs';

const near = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;

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

async function withLiveApp(fn, { bpm = 120, swing = 0, withSample = false } = {}) {
  return withFakeWindow(async getCtx => {
    A.stop();
    A.stopMunchPreview();
    A.finalizeRecording();
    A.setRecQuantize(true);
    const p = createEmptyProject({ name: 'Rec test', bpm });
    p.swing = swing;
    store.project = p;
    store.ui.sel = 'slot-01';
    A.history.clear();
    // Reset engine context to bind to the fresh fake AudioContext for this test
    A.engine.E.ctx = null;
    A.engine.E.ch.clear();
    A.engine.E.gates = null;
    A.engine.E.previewGates = {};
    A.engine.init();
    const ctx = getCtx();
    let sstore = null, meta = null;
    if (withSample) {
      sstore = createSampleStore({ backend: memoryBackend(), decode: decodeWav });
      ({ meta } = await sstore.importBytes({ bytes: makeWav({ seconds: 1, rate: 1000, freq: 220 }), name: 'munch.wav' }));
      slotById(p, 'slot-05').sample = sampleRefFor(meta);
    }
    A.engine.applyAll();
    try {
      await fn({ p, ctx, sstore, meta });
    } finally {
      A.stop();
      A.stopMunchPreview();
      A.finalizeRecording();
      A.setRecQuantize(true);
      A.flushSave();
      A.engine.E.ctx = null;
      A.engine.E.ch.clear();
      A.engine.E.gates = null;
      A.engine.E.previewGates = {};
    }
  });
}

test('computeStepPlacement: Quantize On/Off, loop wrapping and swing compensation', () => {
  // Quantize On: snaps to nearest step, zero offset
  const q1 = computeStepPlacement({ absStep: 3.3, stepDur: .125 }, 16, { quantize: true, swing: 0 });
  assert.equal(q1.step, 3); assert.equal(q1.offset, 0); assert.equal(q1.snappedForward, false);
  const q2 = computeStepPlacement({ absStep: 3.7, stepDur: .125 }, 16, { quantize: true, swing: 0 });
  assert.equal(q2.step, 4); assert.equal(q2.offset, 0); assert.equal(q2.snappedForward, true);

  // Loop boundary wrap: 15.92 -> step 0 (early by -0.08), 16.05 -> step 0 (late by +0.05)
  const earlyWrap = computeStepPlacement({ absStep: 15.92, stepDur: .125 }, 16, { quantize: false, swing: 0 });
  assert.equal(earlyWrap.step, 0);
  assert.ok(near(earlyWrap.offset, -0.08));
  assert.equal(earlyWrap.snappedForward, true);

  const lateWrap = computeStepPlacement({ absStep: 16.05, stepDur: .125 }, 16, { quantize: false, swing: 0 });
  assert.equal(lateWrap.step, 0);
  assert.ok(near(lateWrap.offset, 0.05));
  assert.equal(lateWrap.snappedForward, false);

  // Swing compensation: swing = 0.2 shifts odd step 1 to 1.10; hitting at 1.10 produces offset 0
  const onSwung = computeStepPlacement({ absStep: 1.1, stepDur: .125 }, 16, { quantize: false, swing: 0.2 });
  assert.equal(onSwung.step, 1);
  assert.equal(onSwung.offset, 0);

  // Hitting straight at 1.00 under swing = 0.2 gives offset -0.10 so t + sw + o*sd == t_1
  const straightUnderSwing = computeStepPlacement({ absStep: 1.0, stepDur: .125 }, 16, { quantize: false, swing: 0.2 });
  assert.equal(straightUnderSwing.step, 1);
  assert.ok(near(straightUnderSwing.offset, -0.1));
});

test('REC transport state machine: arm -> play, live toggle without restart, pause/resume same session, stop finalizes', () => withLiveApp(async ({ p, ctx }) => {
  withFakeTimers(({ tickAll }) => {
    // 1. Stopped -> REC arms; REC again disarms
    assert.equal(A.transport.state, 'stopped');
    assert.equal(A.recState(), 'off');
    A.toggleRecord();
    assert.equal(A.recState(), 'armed');
    assert.equal(A.transport.state, 'stopped', 'arming while stopped does not start playback');
    A.toggleRecord();
    assert.equal(A.recState(), 'off');

    // 2. Arm while stopped -> Play starts recording
    A.toggleRecord();
    assert.equal(A.recState(), 'armed');
    A.togglePlay();
    assert.equal(A.transport.state, 'playing');
    assert.equal(A.recState(), 'recording');

    // Advance to step 2 (at 120 BPM, stepDur = 0.125s; step 0 at t=0.06, step 2 at t=0.31)
    ctx.advance(0.31); tickAll();
    const posBeforeOff = { ...A.transport.position };

    // 3. REC again ends recording while playback continues uninterrupted
    A.toggleRecord();
    assert.equal(A.recState(), 'off');
    assert.equal(A.transport.state, 'playing');
    assert.deepEqual(A.transport.position, posBeforeOff, 'ending REC never restarts transport');

    // 4. REC during playback starts recording without restarting transport
    A.toggleRecord();
    assert.equal(A.recState(), 'recording');
    assert.equal(A.transport.state, 'playing');
    assert.deepEqual(A.transport.position, posBeforeOff, 'starting REC while playing never restarts transport');

    // Record a hit at step 2
    const r1 = A.liveDrumHit('slot-01', 'kick', .9, 0.31);
    assert.equal(r1.recorded, true);
    assert.equal(r1.step, 2);

    // 5. Pause suspends recording; Resume continues the SAME session
    A.togglePlay();
    assert.equal(A.transport.state, 'paused');
    assert.equal(A.recState(), 'paused');
    // Hits while paused monitor live but do NOT record
    const ignored = A.liveDrumHit('slot-01', 'snare', .9);
    assert.equal(ignored.recorded, false);

    // Resume playback -> recording resumes in the same session
    A.togglePlay();
    assert.equal(A.transport.state, 'playing');
    assert.equal(A.recState(), 'recording');
    const mt = A.transport.musicalTimeAt(ctx.currentTime + 0.06);
    assert.ok(mt, 'musicalTimeAt available after resume');
    const r2 = A.liveDrumHit('slot-01', 'snare', .85, mt.time);
    assert.equal(r2.recorded, true);

    // 6. Stop finalizes recording and stops transport
    A.stop();
    assert.equal(A.transport.state, 'stopped');
    assert.equal(A.recState(), 'off');

    // Both hits (before pause and after resume) belong to ONE Undo/Redo operation
    const pat = patternAt(store.project, 'slot-01', 0);
    assert.ok(pat.steps.kick[2], 'kick from before pause recorded');
    assert.ok(pat.steps.snare.some(Boolean), 'snare from after resume recorded');
    assert.equal(A.history.size, 1, 'entire pause/resume recording session is exactly 1 history entry');

    A.undo();
    const afterUndo = patternAt(store.project, 'slot-01', 0);
    assert.equal(afterUndo.steps.kick[2], null, 'single Undo removes pre-pause kick');
    assert.equal(afterUndo.steps.snare.some(Boolean), false, 'single Undo removes post-resume snare');

    A.redo();
    const afterRedo = patternAt(store.project, 'slot-01', 0);
    assert.ok(afterRedo.steps.kick[2], 'single Redo restores pre-pause kick');
    assert.ok(afterRedo.steps.snare.some(Boolean), 'single Redo restores post-resume snare');
  });
}));

function advanceTo(ctx, tickAll, target) {
  while (ctx.currentTime + 0.02 < target) {
    ctx.advance(ctx.currentTime + 0.02);
    tickAll();
  }
  ctx.advance(target);
  tickAll();
}

test('empty recordings and locked-only hits create zero history entries and preserve redo stack', () => withLiveApp(async ({ p, ctx }) => {
  withFakeTimers(({ tickAll }) => {
    // Seed one undoable edit then undo it so redoStack is non-empty
    A.setBpm(124);
    A.sealHistory();
    A.undo();
    assert.equal(A.history.size, 0);
    assert.equal(A.history.canRedo, true);

    // Empty recording session
    A.toggleRecord();
    A.togglePlay();
    advanceTo(ctx, tickAll, 0.2);
    A.stop();
    assert.equal(A.history.size, 0, 'empty recording creates no undo entry');
    assert.equal(A.history.canRedo, true, 'empty recording preserves redo stack');

    // Recording session where only a locked drum row and a locked melodic note are hit
    const bopPat = patternAt(store.project, 'slot-01', 0);
    bopPat.locked.kick = true;
    const blipPat = patternAt(store.project, 'slot-03', 0);
    blipPat.notes.push({ s: 0, p: 60, l: 2, v: .7, locked: true });

    A.togglePlay();
    A.toggleRecord();
    // Step 0 starts at ctx.currentTime + 0.06
    const t0 = ctx.currentTime + 0.06;
    advanceTo(ctx, tickAll, t0);
    const lkDrum = A.liveDrumHit('slot-01', 'kick', .95, t0);
    assert.equal(lkDrum.recorded, false);
    assert.equal(lkDrum.locked, true);
    const h = A.liveNoteOn('slot-03', 60, .95, { audioTime: t0 });
    A.liveNoteOff(h, t0 + 0.25);
    A.toggleRecord();
    A.stop();

    assert.equal(bopPat.steps.kick[0], null, 'locked drum row stays untouched');
    assert.equal(blipPat.notes.length, 1);
    assert.equal(blipPat.notes[0].v, .7, 'locked melodic note stays untouched');
    assert.equal(blipPat.notes[0].l, 2, 'locked melodic note length stays untouched');
    assert.equal(A.history.size, 0, 'locked-only recording creates no history entry');
    assert.equal(A.history.canRedo, true, 'locked-only recording preserves redo stack');
  });
}));

test('all five instruments (BOP, GOO, BLIP, FUZZ, MUNCH) record pitch/slice, velocity, multi-touch and duration across loops', () => withLiveApp(async ({ p, ctx }) => {
  withFakeTimers(({ tickAll }) => {
    // Pre-existing notes to verify overdub preservation
    patternAt(p, 'slot-01', 0).steps.clap[4] = { v: .8, p: 1 };
    patternAt(p, 'slot-03', 0).notes.push({ s: 0, p: 57, l: 4, v: .6 });

    A.togglePlay();
    A.toggleRecord();
    // At 120 BPM: stepDur = 0.125s, step 0 = 0.06s, step k = 0.06 + k * 0.125s
    const tStep = k => 0.06 + k * 0.125;

    // BOP: simultaneous multi-touch kick + hat at step 0
    advanceTo(ctx, tickAll, tStep(0));
    A.liveDrumHit('slot-01', 'kick', .95, tStep(0));
    A.liveDrumHit('slot-01', 'chh', .65, tStep(0));

    // GOO: held note from step 2 to step 5 (3 steps)
    advanceTo(ctx, tickAll, tStep(2));
    const gooH = A.liveNoteOn('slot-02', 36, .9, { audioTime: tStep(2) });

    // BLIP: simultaneous 3-note chord at step 4 held for 2 steps
    advanceTo(ctx, tickAll, tStep(4));
    const b1 = A.liveNoteOn('slot-03', 60, .75, { audioTime: tStep(4) });
    const b2 = A.liveNoteOn('slot-03', 64, .82, { audioTime: tStep(4) });
    const b3 = A.liveNoteOn('slot-03', 67, .88, { audioTime: tStep(4) });

    advanceTo(ctx, tickAll, tStep(5));
    A.liveNoteOff(gooH, tStep(5));
    advanceTo(ctx, tickAll, tStep(6));
    A.liveNoteOff(b1, tStep(6));
    A.liveNoteOff(b2, tStep(6));
    A.liveNoteOff(b3, tStep(6));

    // FUZZ: long hold starting at step 14 in a 16-step pattern across loop wrap -> clamps to l = 2 (len - s)
    patternAt(p, 'slot-04', 0).len = 16;
    advanceTo(ctx, tickAll, tStep(14));
    const fzH = A.liveNoteOn('slot-04', 72, .7, { audioTime: tStep(14) });
    advanceTo(ctx, tickAll, tStep(18)); // past loop boundary into bar 2
    A.liveNoteOff(fzH, tStep(18));

    // MUNCH: melodic note at step 2 (loop 2 = step 18) and slice pad 3 at step 4 (loop 2 = step 20)
    const mnH = A.liveNoteOn('slot-05', 65, .84, { audioTime: tStep(18) });
    advanceTo(ctx, tickAll, tStep(20));
    A.liveNoteOff(mnH, tStep(20));
    const mpH = A.liveNoteOn('slot-05', 60, .92, { slice: 3, audioTime: tStep(20) });
    advanceTo(ctx, tickAll, tStep(21));
    A.liveNoteOff(mpH, tStep(21));

    A.toggleRecord();
    A.stop();

    // Verify BOP (including overdubbed clap preserved)
    const bop = patternAt(p, 'slot-01', 0);
    assert.ok(bop.steps.kick[0] && near(bop.steps.kick[0].v, .95));
    assert.ok(bop.steps.chh[0] && near(bop.steps.chh[0].v, .65));
    assert.ok(bop.steps.clap[4] && near(bop.steps.clap[4].v, .8), 'pre-existing drum hit preserved (overdub)');

    // Verify GOO
    const goo = patternAt(p, 'slot-02', 0);
    assert.equal(goo.notes.length, 1);
    assert.deepEqual(goo.notes[0], { s: 2, p: 36, l: 3, v: .9 });

    // Verify BLIP (overdubbed note + 3-note chord)
    const blip = patternAt(p, 'slot-03', 0);
    assert.equal(blip.notes.length, 4, 'pre-existing note + 3-note chord');
    assert.ok(blip.notes.some(n => n.s === 0 && n.p === 57 && n.l === 4), 'existing BLIP note preserved');
    for (const [pitch, vel] of [[60, .75], [64, .82], [67, .88]]) {
      const n = blip.notes.find(x => x.s === 4 && x.p === pitch);
      assert.ok(n, `BLIP chord pitch ${pitch} recorded`);
      assert.equal(n.l, 2);
      assert.ok(near(n.v, vel));
    }

    // Verify FUZZ loop-boundary duration clamp
    const fuzz = patternAt(p, 'slot-04', 0);
    assert.equal(fuzz.notes.length, 1);
    assert.deepEqual(fuzz.notes[0], { s: 14, p: 72, l: 2, v: .7 });

    // Verify MUNCH melodic + slice
    const munch = patternAt(p, 'slot-05', 0);
    const mMel = munch.notes.find(n => n.slice == null);
    const mSlc = munch.notes.find(n => n.slice === 3);
    assert.deepEqual(mMel, { s: 2, p: 65, l: 2, v: .84 });
    assert.deepEqual(mSlc, { s: 4, p: 60, l: 1, v: .92, slice: 3 });

    // Single Undo clears all five instruments' recorded events and restores original overdub base
    assert.equal(A.history.size, 1);
    A.undo();
    assert.equal(patternAt(store.project, 'slot-01', 0).steps.kick[0], null);
    assert.ok(patternAt(store.project, 'slot-01', 0).steps.clap[4]);
    assert.equal(patternAt(store.project, 'slot-02', 0).notes.length, 0);
    assert.equal(patternAt(store.project, 'slot-03', 0).notes.length, 1);
    assert.equal(patternAt(store.project, 'slot-04', 0).notes.length, 0);
    assert.equal(patternAt(store.project, 'slot-05', 0).notes.length, 0);
  });
}));

test('Quantize Off preserves drum & melodic microtiming, replays accurately, and suppresses duplicate triggers at 50 BPM', () => withLiveApp(async ({ p, ctx }) => {
  // 50 BPM -> stepDur = 0.3s, so 0.42 * stepDur = 0.126s > LOOKAHEAD (0.12s)
  p.bpm = 50;
  A.setRecQuantize(false);
  withFakeTimers(({ tickAll }) => {
    A.togglePlay();
    A.toggleRecord();
    const sd = 60 / 50 / 4; // 0.3s
    const tStep = k => 0.06 + k * sd;

    // Hit kick 0.25 steps late on step 1 -> step 1, o = +0.25
    const kickTime = tStep(1) + 0.25 * sd;
    advanceTo(ctx, tickAll, kickTime);
    A.liveDrumHit('slot-01', 'kick', .9, kickTime);

    // Hit snare 0.42 steps EARLY before step 4 (at tStep(3) + 0.58 * sd) -> snaps forward to step 4 with o = -0.42
    const snareTime = tStep(3) + 0.58 * sd;
    advanceTo(ctx, tickAll, snareTime);
    const triggers = [];
    const origTrig = A.engine.trigger;
    A.engine.trigger = (id, t, hit, live = true) => {
      if (live) triggers.push({ id, t, hit });
      return origTrig(id, t, hit, live);
    };
    try {
      A.liveDrumHit('slot-01', 'snare', .85, snareTime);
      // Advance past step 4 on THIS loop pass -> snare must NOT double-trigger!
      advanceTo(ctx, tickAll, tStep(5));
      const dupes = triggers.filter(x => x.id === 'slot-01' && x.hit.d === 'snare');
      assert.equal(dupes.length, 0, 'snapped-forward drum hit does NOT duplicate-trigger on the same pass');

      // Advance into loop 2 past step 4 (step 20) -> both kick (with +0.25 offset) and snare (with -0.42 offset) MUST replay!
      advanceTo(ctx, tickAll, tStep(21));
      const loop2Kick = triggers.find(x => x.id === 'slot-01' && x.hit.d === 'kick' && x.t > tStep(16));
      const loop2Snare = triggers.find(x => x.id === 'slot-01' && x.hit.d === 'snare' && x.t > tStep(16));
      assert.ok(loop2Kick, 'unquantized kick replays on loop 2');
      assert.ok(near(loop2Kick.t, tStep(17) + 0.25 * sd, 1e-3), `kick replays at performed +0.25 offset (got ${loop2Kick.t})`);
      assert.ok(loop2Snare, 'unquantized snare replays on loop 2');
      assert.ok(near(loop2Snare.t, tStep(20) - 0.42 * sd, 1e-3), `snare replays at performed -0.42 offset (got ${loop2Snare.t})`);
    } finally {
      A.engine.trigger = origTrig;
    }

    A.stop();
    const bop = patternAt(p, 'slot-01', 0);
    assert.ok(near(bop.steps.kick[1].o, 0.25));
    assert.ok(near(bop.steps.snare[4].o, -0.42));
  });
}, { bpm: 50, swing: 0 }));

test('recording targets one scene only and finalizes cleanly on scene change', () => withLiveApp(async ({ p, ctx }) => {
  withFakeTimers(({ tickAll }) => {
    A.createScene({ name: 'Scene 2', select: false });
    assert.equal(store.project.scenes.length, 2);

    A.togglePlay();
    A.toggleRecord();
    ctx.advance(0.06); tickAll();
    A.liveDrumHit('slot-01', 'kick', .9, 0.06);
    assert.equal(A.recState(), 'recording');

    // Selecting Scene 2 finalizes the Scene 1 recording cleanly
    A.selectScene(1);
    assert.equal(A.recState(), 'off', 'scene change finalizes active recording');
    // Subsequent hit while recording is finalized does not record into Scene 2
    const res = A.liveDrumHit('slot-01', 'snare', .9, 0.185);
    assert.equal(res.recorded, false);
    assert.ok(patternAt(store.project, 'slot-01', 0).steps.kick[0], 'Scene 1 kept recorded kick');
    assert.equal(patternAt(store.project, 'slot-01', 1).steps.snare.some(Boolean), false, 'Scene 2 stayed clean');
  });
}));

test('recorded quantized and unquantized patterns survive JSON and .hbn package round-trip', () => withLiveApp(async ({ p, ctx, sstore }) => {
  A.setRecQuantize(false);
  withFakeTimers(({ tickAll }) => {
    A.togglePlay();
    A.toggleRecord();
    const sd = 0.125;
    const tStep = k => 0.06 + k * sd;
    ctx.advance(tStep(1) + 0.2 * sd); tickAll();
    A.liveDrumHit('slot-01', 'kick', .91, tStep(1) + 0.2 * sd);
    const h1 = A.liveNoteOn('slot-03', 64, .77, { audioTime: tStep(2) - 0.15 * sd });
    ctx.advance(tStep(4)); tickAll();
    A.liveNoteOff(h1, tStep(4));
    const h2 = A.liveNoteOn('slot-05', 60, .88, { slice: 2, audioTime: tStep(4) + 0.1 * sd });
    ctx.advance(tStep(5)); tickAll();
    A.liveNoteOff(h2, tStep(5));
    A.stop();
  });

  // JSON round-trip via importProject
  const jsonCopy = importProject(JSON.parse(JSON.stringify(store.project)));
  assert.ok(near(patternAt(jsonCopy, 'slot-01', 0).steps.kick[1].o, 0.2));
  assert.ok(near(patternAt(jsonCopy, 'slot-03', 0).notes[0].o, -0.15));
  assert.equal(patternAt(jsonCopy, 'slot-05', 0).notes[0].slice, 2);
  assert.ok(near(patternAt(jsonCopy, 'slot-05', 0).notes[0].o, 0.1));

  // Portable .hbn round-trip
  const pkg = await exportPackage(store.project, { sampleStore: sstore });
  const parsed = await parsePackage(pkg.bytes);
  const dstStore = createSampleStore({ backend: memoryBackend(), decode: decodeWav });
  const restored = await restorePackage(parsed, { sampleStore: dstStore });
  const rp = restored.project;
  assert.ok(near(patternAt(rp, 'slot-01', 0).steps.kick[1].o, 0.2), '.hbn preserves unquantized drum offset');
  assert.ok(near(patternAt(rp, 'slot-01', 0).steps.kick[1].v, 0.91), '.hbn preserves drum velocity');
  assert.ok(near(patternAt(rp, 'slot-03', 0).notes[0].o, -0.15), '.hbn preserves unquantized melodic offset');
  assert.equal(patternAt(rp, 'slot-03', 0).notes[0].l, 2, '.hbn preserves recorded note duration');
  assert.equal(patternAt(rp, 'slot-05', 0).notes[0].slice, 2, '.hbn preserves recorded MUNCH slice');
  assert.ok(near(patternAt(rp, 'slot-05', 0).notes[0].o, 0.1), '.hbn preserves MUNCH slice timing offset');
}, { withSample: true }));

test('lookahead compensation captures against audible step, not future transport.position, and voices release cleanly', () => withLiveApp(async ({ p, ctx }) => {
  // 160 BPM -> stepDur = 0.09375s; LOOKAHEAD = 0.12s means transport.position is already 2 steps ahead of audible time!
  p.bpm = 160;
  withFakeTimers(({ tickAll }) => {
    A.togglePlay();
    A.toggleRecord();
    const sd = 60 / 160 / 4; // 0.09375s
    const tStep = k => 0.06 + k * sd;
    advanceTo(ctx, tickAll, tStep(2) + 0.01);
    assert.ok(A.transport.position.step > 2, `scheduler lookahead is ahead of audible step 2 (pos=${A.transport.position.step})`);
    const hit = A.liveDrumHit('slot-01', 'kick', .9);
    assert.equal(hit.recorded, true);
    assert.equal(hit.step, 2, 'captured against audible step 2, NOT lookahead transport.position');

    // GOO, BLIP and FUZZ live noteOn/noteOff return valid release handles and clean up on release & Stop
    for (const [slotId, pitch] of [['slot-02', 36], ['slot-03', 64], ['slot-04', 72]]) {
      const h = A.liveNoteOn(slotId, pitch, .8);
      assert.ok(h && h.audioHandle, `${slotId} liveNoteOn returns audio handle`);
      assert.equal(A.liveNoteOff(h), true, `${slotId} liveNoteOff releases voice cleanly`);
    }

    // Held notes at Stop are finalized and silenced cleanly
    const heldH = A.liveNoteOn('slot-03', 67, .85);
    assert.ok(heldH && heldH.recToken);
    advanceTo(ctx, tickAll, tStep(5));
    A.stop();
    const note = patternAt(p, 'slot-03', 0).notes.find(n => n.p === 67);
    assert.ok(note && note.l >= 2, 'held note length finalized cleanly on Stop');
  });
}, { bpm: 160 }));

test('MUNCH CHOP Preview finalizes active recording and never records while previewing', () => withLiveApp(async ({ p, ctx }) => {
  withFakeTimers(({ tickAll }) => {
    A.togglePlay();
    A.toggleRecord();
    advanceTo(ctx, tickAll, 0.06);
    assert.equal(A.recState(), 'recording');

    // Starting MUNCH CHOP preview finalizes live pattern recording cleanly
    const started = A.toggleMunchPreview('slot-05');
    assert.equal(started, true);
    assert.equal(A.recState(), 'off', 'starting CHOP preview finalizes live recording');
    assert.equal(A.transport.state, 'paused', 'CHOP preview pauses global transport as before');

    // Tapping a MUNCH pad during CHOP preview auditions without recording
    const before = patternAt(p, 'slot-05', 0).notes.length;
    const h = A.munchPadOn(2, .9, 'slot-05');
    A.munchPadOff(h);
    assert.equal(patternAt(p, 'slot-05', 0).notes.length, before, 'CHOP preview pad tap does not record');
    A.stopMunchPreview();
  });
}, { withSample: true }));

