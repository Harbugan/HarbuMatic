// HarbuMatic v0.7 PR34 — RUFF CHOP IT! & Unified Sequencer automated tests.
// Covers: four distinct profiles, deterministic seeded output, New Groove vs Evolve,
// Subtle vs Wild transformation magnitude, 1/2/3-source metadata-driven complementary roles,
// bounded simultaneous-hit density & intentional gaps, hit/column/lane/empty-cell locks,
// explicitly silent edited lanes, original groove preservation, atomic Undo/Redo,
// scene isolation, transport non-interference, save/reopen & .hbn round-trip, and 2-bar timing.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_BREAK_IDS, BREAK_PATTERN_STEPS, getBuiltinBreak,
  isBreakLaneEdited, originalGrooveRow, effectiveBreakRow, breakSliceCount,
  breakCellLockKey, isBreakCellLocked, isBreakLaneLocked, isBreakStepColumnLocked,
  isBreakCellDirectlyLocked, isBreakLaneExplicitlySilent,
} from '../src/core/breaks.js';
import { BREAK_LANES, createPatternFor } from '../src/core/instruments.js';
import { createEmptyProject, slotById, patternAt, validateProject } from '../src/core/project.js';
import { createLibrary, memoryStorage } from '../src/core/persistence.js';
import { exportPackage, parsePackage, restorePackage } from '../src/core/package.js';
import { createSampleStore, memoryBackend } from '../src/samples/store.js';
import { createSampleBank } from '../src/samples/bank.js';
import { stretchChannels } from '../src/samples/stretch.js';
import { createEngine } from '../src/audio/engine.js';
import { createTransport } from '../src/audio/scheduler.js';
import {
  RUFF_CHOP_PROFILES, analyzeBreakSource, assignBreakRoles, chopBreakPattern,
} from '../src/music/ruffchop.js';
import { store } from '../src/app/store.js';
import * as A from '../src/app/actions.js';
import { decodeWav, makeWav, withFakeWindow } from './helpers/audio.mjs';

const R = 'slot-06';
const near = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;

function countDiffs(rowA, rowB) {
  let d = 0;
  for (let s = 0; s < BREAK_PATTERN_STEPS; s++) {
    const a = rowA[s], b = rowB[s];
    if (!a && !b) continue;
    if (!a || !b || a.slice !== b.slice) d++;
  }
  return d;
}

function measureProfile(profile, breaks, seeds, { mode = 'new', intensity = 0.55 } = {}) {
  let totalHits = 0;
  let silentSteps = 0;
  let multiSteps = 0;
  let threeStacks = 0;
  let twoStepAnchors = 0;
  let nativeMatches = 0;
  let velContrastSum = 0;
  let repeatMotifs = 0;

  for (const seed of seeds) {
    const pat = createPatternFor('ruff');
    const res = chopBreakPattern({ pattern: pat, breaks, mode, profile, intensity, seed });
    const lanes = res.pattern.lanes;
    const vels = [];
    for (let s = 0; s < 16; s++) {
      let c = 0;
      for (const l of BREAK_LANES) {
        const cell = lanes[l][s];
        if (cell) {
          c++;
          totalHits++;
          vels.push(cell.v);
          if (cell.slice === s) nativeMatches++;
          if (s > 0 && lanes[l][s - 1] && lanes[l][s - 1].slice === cell.slice) repeatMotifs++;
        }
      }
      if (c === 0) silentSteps++;
      if (c >= 2) multiSteps++;
      if (c >= 3) threeStacks++;
      if ([0, 2, 5, 6, 8, 10, 13, 14].includes(s) && c > 0) twoStepAnchors++;
    }
    if (vels.length >= 2) velContrastSum += (Math.max(...vels) - Math.min(...vels));
  }

  const n = seeds.length;
  return {
    avgHits: totalHits / n,
    avgSilent: silentSteps / n,
    avgMulti: multiSteps / n,
    avgThree: threeStacks / n,
    avgTwoStepAnchors: twoStepAnchors / n,
    nativeRatio: totalHits ? nativeMatches / totalHits : 0,
    avgVelContrast: velContrastSum / n,
    avgRepeats: repeatMotifs / n,
  };
}

test('CHOP IT! is strictly deterministic with an explicit seed and varies across seeds', () => {
  const breaks = { a: 'brk-builtin-tight', b: 'brk-builtin-funky', c: 'brk-builtin-jungle' };
  const base = createPatternFor('ruff');

  for (const profile of RUFF_CHOP_PROFILES) {
    const r1 = chopBreakPattern({ pattern: base, breaks, mode: 'new', profile, intensity: 0.6, seed: 4242 });
    const r2 = chopBreakPattern({ pattern: base, breaks, mode: 'new', profile, intensity: 0.6, seed: 4242 });
    const r3 = chopBreakPattern({ pattern: base, breaks, mode: 'new', profile, intensity: 0.6, seed: 9876 });
    assert.deepEqual(r1.pattern, r2.pattern, `${profile}: same seed produces identical pattern`);
    assert.deepEqual(r1.info, r2.info, `${profile}: same seed produces identical info`);
    assert.notDeepEqual(r1.pattern.lanes, r3.pattern.lanes, `${profile}: different seeds produce distinct variations`);
  }
  // Input pattern is never mutated
  assert.deepEqual(base, createPatternFor('ruff'), 'input pattern remains untouched');
});

test('all four musical profiles produce audibly and structurally distinct break programming', () => {
  const seeds = Array.from({ length: 24 }, (_, i) => 100 + i * 37);
  const breaks3 = { a: 'brk-builtin-tight', b: 'brk-builtin-funky', c: 'brk-builtin-jungle' };
  const breaks1 = { a: 'brk-builtin-jungle', b: null, c: null };

  const m3 = Object.fromEntries(RUFF_CHOP_PROFILES.map(p => [p, measureProfile(p, breaks3, seeds, { intensity: 0.6 })]));
  const m1 = Object.fromEntries(RUFF_CHOP_PROFILES.map(p => [p, measureProfile(p, breaks1, seeds, { intensity: 0.65 })]));

  // All 4 profiles produce distinct patterns on the exact same seed
  const sameSeedOutputs = RUFF_CHOP_PROFILES.map(profile =>
    JSON.stringify(chopBreakPattern({ pattern: createPatternFor('ruff'), breaks: breaks3, mode: 'new', profile, intensity: 0.55, seed: 777 }).pattern.lanes));
  assert.equal(new Set(sameSeedOutputs).size, 4, 'all 4 profiles produce distinct outputs on the same seed');

  // Darkside has dramatically more intentional silent gaps and stronger velocity contrast than Rolling & Atmospheric
  assert.ok(m3.darkside.avgSilent >= 3.5, `Darkside preserves dramatic silent gaps (avg ${m3.darkside.avgSilent.toFixed(2)})`);
  assert.ok(m3.darkside.avgSilent > m3.rolling.avgSilent + 2.0, 'Darkside has significantly more silent gaps than Rolling');
  assert.ok(m3.darkside.avgVelContrast > m3.atmospheric.avgVelContrast, 'Darkside has sharper velocity contrast than Atmospheric');

  // Rolling / Two-Step maintains the strongest two-step anchor consistency and highest driving continuity
  assert.ok(m3.rolling.avgTwoStepAnchors >= 7.8, `Rolling locks two-step anchors (avg ${m3.rolling.avgTwoStepAnchors.toFixed(2)} / 8)`);
  assert.ok(m3.rolling.avgTwoStepAnchors > m3.darkside.avgTwoStepAnchors, 'Rolling has much stronger two-step anchors than Darkside');
  assert.ok(m1.rolling.avgHits > m1.darkside.avgHits, 'Rolling maintains fuller driving pulse than sparse Darkside');

  // Atmospheric keeps lower multi-lane collision density and higher native slice continuity than Jungle
  assert.ok(m3.atmospheric.avgMulti < m3.rolling.avgMulti, 'Atmospheric keeps cleaner interlocking space than Rolling');
  assert.equal(m3.atmospheric.avgThree, 0, 'Atmospheric avoids 3-way simultaneous hit stacks');
  assert.ok(m1.atmospheric.nativeRatio > m1.jungle.nativeRatio, 'Atmospheric preserves more native groove continuity than Jungle');

  // Old Skool Jungle exhibits chopped slice-repeat motifs more often than Atmospheric
  assert.ok(m1.jungle.avgRepeats > m1.atmospheric.avgRepeats, 'Jungle creates chopped slice-bounce motifs more than Atmospheric');
});

test('Subtle preserves recognizable groove anchors while Wild increases transformation magnitude', () => {
  const breaks = { a: 'brk-builtin-tight', b: null, c: null };
  const orig = originalGrooveRow('brk-builtin-tight', 16);
  const seeds = Array.from({ length: 20 }, (_, i) => 500 + i * 19);

  let subtleDiffs = 0, wildDiffs = 0;
  let subtleAnchorHits = 0, wildAnchorHits = 0;

  for (const seed of seeds) {
    const base = createPatternFor('ruff');
    const sub = chopBreakPattern({ pattern: base, breaks, mode: 'evolve', profile: 'jungle', intensity: 0.12, seed });
    const wld = chopBreakPattern({ pattern: base, breaks, mode: 'evolve', profile: 'jungle', intensity: 0.92, seed });
    subtleDiffs += countDiffs(orig, sub.pattern.lanes.a);
    wildDiffs += countDiffs(orig, wld.pattern.lanes.a);

    for (const s of [0, 2, 6, 8, 10, 14]) {
      if (sub.pattern.lanes.a[s] && sub.pattern.lanes.a[s].slice === s) subtleAnchorHits++;
      if (wld.pattern.lanes.a[s] && wld.pattern.lanes.a[s].slice === s) wildAnchorHits++;
    }
  }

  assert.ok(wildDiffs > subtleDiffs * 1.4, `Wild transforms substantially more than Subtle (${wildDiffs} vs ${subtleDiffs})`);
  assert.ok(subtleAnchorHits > wildAnchorHits, `Subtle preserves recognizable anchor slices better than Wild (${subtleAnchorHits} vs ${wildAnchorHits})`);
});

test('New Groove vs Evolve behave differently and repeated Evolve presses continue transforming the current pattern', () => {
  const breaks = { a: 'brk-builtin-funky', b: 'brk-builtin-jungle', c: null };
  // Build a distinctive user-edited pattern on lane A & B
  const custom = createPatternFor('ruff');
  custom.edited = { a: true, b: true };
  custom.lanes.a[0] = { slice: 11, v: 0.95, p: 1 };
  custom.lanes.a[2] = { slice: 14, v: 0.9, p: 1 };
  custom.lanes.a[8] = { slice: 11, v: 0.95, p: 1 };
  custom.lanes.a[10] = { slice: 14, v: 0.9, p: 1 };
  custom.lanes.b[4] = { slice: 15, v: 0.85, p: 1 };

  const evolved = chopBreakPattern({ pattern: custom, breaks, mode: 'evolve', profile: 'atmospheric', intensity: 0.2, seed: 303 });
  const fresh = chopBreakPattern({ pattern: custom, breaks, mode: 'new', profile: 'atmospheric', intensity: 0.2, seed: 303 });

  assert.notDeepEqual(evolved.pattern.lanes, fresh.pattern.lanes, 'New Groove and Evolve produce different results');
  const diffEvolve = countDiffs(custom.lanes.a, evolved.pattern.lanes.a);
  const diffNew = countDiffs(custom.lanes.a, fresh.pattern.lanes.a);
  assert.ok(diffEvolve < diffNew, `Subtle Evolve stays closer to the current edited pattern than New Groove (${diffEvolve} vs ${diffNew})`);

  // Repeated Evolve presses transform the previous result step by step
  const step1 = chopBreakPattern({ pattern: createPatternFor('ruff'), breaks, mode: 'evolve', profile: 'jungle', intensity: 0.45, seed: 11 });
  const step2 = chopBreakPattern({ pattern: step1.pattern, breaks, mode: 'evolve', profile: 'jungle', intensity: 0.45, seed: 22 });
  assert.notDeepEqual(step1.pattern.lanes, step2.pattern.lanes, 'repeated Evolve press advances from the current result');
});

test('role inference adapts to break metadata across 1/2/3 sources (never hardcoded to A/B/C) with bounded concurrency', () => {
  // Put JUNGLE on A, TIGHT on C, FUNKY on B: TIGHT must still be inferred as foundation, JUNGLE as chop!
  const perm = [
    { lane: 'a', breakId: 'brk-builtin-jungle', src: analyzeBreakSource('brk-builtin-jungle') },
    { lane: 'b', breakId: 'brk-builtin-funky', src: analyzeBreakSource('brk-builtin-funky') },
    { lane: 'c', breakId: 'brk-builtin-tight', src: analyzeBreakSource('brk-builtin-tight') },
  ];
  const roles3 = assignBreakRoles(perm);
  assert.equal(roles3.c, 'foundation', 'TIGHT on lane C is inferred as foundation from metadata, not hardcoded lane A');
  assert.equal(roles3.a, 'chop', 'RUFF JUNGLE on lane A is inferred as chop from fill/ghost/tempo metadata');
  assert.equal(roles3.b, 'accent', 'FUNKY on lane B is inferred as complementary accent layer');

  // 1-source, 2-source, 3-source generation all produce valid slices & bounded concurrency
  const configs = [
    { a: 'brk-builtin-tight', b: null, c: null },
    { a: 'brk-builtin-jungle', b: 'brk-builtin-tight', c: null },
    { a: 'brk-builtin-jungle', b: 'brk-builtin-funky', c: 'brk-builtin-tight' },
  ];
  for (const breaks of configs) {
    const activeCount = BREAK_LANES.filter(l => !!breaks[l]).length;
    for (const profile of RUFF_CHOP_PROFILES) {
      const res = chopBreakPattern({ pattern: createPatternFor('ruff'), breaks, mode: 'new', profile, intensity: 0.7, seed: 808 });
      assert.equal(res.changed, true);
      assert.equal(res.info.activeLanes.length, activeCount);

      let threeWaySteps = 0;
      for (const l of BREAK_LANES) {
        const row = res.pattern.lanes[l];
        assert.equal(row.length, BREAK_PATTERN_STEPS);
        if (!breaks[l]) {
          assert.equal(row.every(c => c === null), true, 'unassigned lane stays empty');
          assert.equal(res.pattern.edited[l], undefined, 'unassigned lane stays unedited');
        } else {
          assert.equal(res.pattern.edited[l], true);
          assert.ok(row.some(Boolean), `${profile} (${activeCount} src) lane ${l} contributes audible hits`);
          const maxSlice = breakSliceCount(breaks[l]) - 1;
          row.forEach(c => {
            if (!c) return;
            assert.ok(Number.isInteger(c.slice) && c.slice >= 0 && c.slice <= maxSlice, 'valid slice index');
            assert.ok(c.v >= 0.05 && c.v <= 1, 'valid velocity');
            assert.ok(c.p >= 0.05 && c.p <= 1, 'valid probability');
          });
        }
      }
      for (let s = 0; s < 16; s++) {
        const conc = BREAK_LANES.reduce((n, l) => n + (res.pattern.lanes[l][s] ? 1 : 0), 0);
        if (conc === 3) threeWaySteps++;
      }
      assert.ok(threeWaySteps <= 1, `${profile} (${activeCount} src) bounds 3-way simultaneous stacks (got ${threeWaySteps})`);
    }
  }
});

test('locks protect hits, legacy cell.locked, locked empty cells, columns and full lanes across New Groove and Evolve', () => {
  const breaks = { a: 'brk-builtin-tight', b: 'brk-builtin-funky', c: 'brk-builtin-jungle' };

  const pat = createPatternFor('ruff');
  // Lane A: edited with a locked hit at step 2 (via a:2), a legacy cell.locked hit at step 6,
  // and a LOCKED EMPTY CELL (intentional silence) at step 4 (via a:4)!
  pat.edited.a = true;
  pat.lanes.a = originalGrooveRow('brk-builtin-tight', 16);
  pat.lanes.a[2] = { slice: 14, v: 0.77, p: 1 };
  pat.lanes.a[4] = null; // intentional silence!
  pat.lanes.a[6] = { slice: 15, v: 0.88, p: 1, locked: true }; // PR33 legacy cell.locked
  pat.locked[breakCellLockKey('a', 2)] = true;
  pat.locked[breakCellLockKey('a', 4)] = true;

  // Lane B: UNEDITED original groove, with column lock on step 8 (Bar 2 downbeat)
  // AND direct cell lock on step 10 (unedited virtual slice 10)!
  pat.locked['8'] = true;
  pat.locked[breakCellLockKey('b', 10)] = true;

  // Lane C: UNEDITED original groove, with FULL LANE LOCK (must remain completely untouched & unedited!)
  pat.locked.c = true;

  // Also test column lock on an edited empty cell on Lane A at step 8:
  pat.lanes.a[8] = null;

  for (const mode of ['new', 'evolve']) {
    for (const profile of RUFF_CHOP_PROFILES) {
      for (const intensity of [0.1, 0.55, 0.95]) {
        const res = chopBreakPattern({ pattern: pat, breaks, mode, profile, intensity, seed: 1337 });
        const out = res.pattern;

        // 1. Direct hit lock on A:2 preserved
        assert.deepEqual(out.lanes.a[2], { slice: 14, v: 0.77, p: 1 }, `${mode}/${profile}/${intensity}: A:2 hit lock`);
        // 2. LOCKED EMPTY CELL on A:4 preserved as null (silence)!
        assert.equal(out.lanes.a[4], null, `${mode}/${profile}/${intensity}: A:4 locked silence never overwritten`);
        // 3. Legacy PR33 cell.locked on A:6 preserved verbatim
        assert.deepEqual(out.lanes.a[6], { slice: 15, v: 0.88, p: 1, locked: true }, `${mode}/${profile}/${intensity}: A:6 legacy cell.locked`);
        // 4. Column lock on step 8: A:8 stays silent (null), B:8 preserves original groove slice 8!
        assert.equal(out.lanes.a[8], null, `${mode}/${profile}/${intensity}: col-locked empty A:8 stays silent`);
        assert.equal(out.lanes.b[8]?.slice, 8, `${mode}/${profile}/${intensity}: col-locked unedited B:8 preserves original slice 8`);
        // 5. Cell lock on unedited B:10 preserves original slice 10!
        assert.equal(out.lanes.b[10]?.slice, 10, `${mode}/${profile}/${intensity}: cell-locked unedited B:10 preserves original slice 10`);
        // 6. Full lane lock on unedited C keeps C completely untouched and unedited!
        assert.equal(isBreakLaneEdited(out, 'c'), false, `${mode}/${profile}/${intensity}: locked unedited lane C remains unedited`);
        assert.equal(out.lanes.c.every(c => c === null), true);
        // 7. Lock map preserved verbatim
        assert.deepEqual(out.locked, pat.locked);
      }
    }
  }
});

test('explicitly silent edited lanes are never silently restored by New Groove or Evolve', () => {
  const breaks = { a: 'brk-builtin-tight', b: 'brk-builtin-funky', c: 'brk-builtin-jungle' };
  const pat = createPatternFor('ruff');
  // Lane B explicitly cleared to silence; Lane A & C unedited
  pat.edited.b = true;
  pat.lanes.b = Array(16).fill(null);
  assert.equal(isBreakLaneExplicitlySilent(pat, 'b'), true);

  for (const mode of ['new', 'evolve']) {
    const res = chopBreakPattern({ pattern: pat, breaks, mode, profile: 'jungle', intensity: 0.8, seed: 99 });
    assert.equal(res.changed, true);
    assert.equal(res.pattern.edited.b, true, `${mode}: silent lane B keeps edited flag`);
    assert.equal(res.pattern.lanes.b.every(c => c === null), true, `${mode}: deliberately cleared lane B stays silent`);
    assert.ok(res.pattern.lanes.a.some(Boolean), `${mode}: active lane A still generates`);
    assert.ok(res.pattern.lanes.c.some(Boolean), `${mode}: active lane C still generates`);
  }

  // If ALL assigned lanes are explicitly silenced, CHOP IT! reports changed: false and restores nothing
  const allSilent = createPatternFor('ruff');
  allSilent.edited = { a: true, b: true, c: true };
  const resNone = chopBreakPattern({ pattern: allSilent, breaks, mode: 'new', profile: 'rolling', intensity: 0.8, seed: 5 });
  assert.equal(resNone.changed, false);
  for (const l of BREAK_LANES) {
    assert.equal(resNone.pattern.edited[l], true);
    assert.equal(resNone.pattern.lanes[l].every(c => c === null), true);
  }
});

test('actions: atomic Undo/Redo, scene isolation, transport non-interference, lock toggling, save/reopen and .hbn round-trip', async () => {
  store.project = createEmptyProject({ name: 'RUFF CHOP IT Roundtrip' });
  store.ui.sel = R;
  A.stop();
  A.history.clear();

  A.assignBreak('a', 'brk-builtin-tight', R);
  A.assignBreak('b', 'brk-builtin-funky', R);
  A.assignBreak('c', 'brk-builtin-jungle', R);
  A.createScene({ name: 'Scene 2', select: false }); // Scene 1 = untouched control scene
  A.history.clear();

  const scene2Before = JSON.stringify(patternAt(store.project, R, 1));
  const bopBefore = JSON.stringify(patternAt(store.project, 'slot-01', 0));

  // Lock an empty cell on lane A (erase step 3 first, then lock A:3), lock column 0, lock lane C
  assert.equal(A.eraseBreakStep('a', 3, R), true);
  assert.equal(A.toggleBreakCellLock('a', 3, R), true);
  assert.equal(A.toggleBreakColumnLock(0, R), true);
  assert.equal(A.toggleBreakLaneLock('c', R), true);

  let p0 = patternAt(store.project, R, 0);
  assert.equal(isBreakCellDirectlyLocked(p0, 'a', 3), true);
  assert.equal(p0.lanes.a[3], null, 'locked empty cell stays null');
  assert.equal(isBreakStepColumnLocked(p0, 0), true);
  assert.equal(isBreakLaneLocked(p0, 'c'), true);

  // Manual edits on locked empty cell / column / lane are refused cleanly
  assert.equal(A.toggleBreakStep('a', 3, R), false, 'locked empty cell cannot be toggled on');
  assert.equal(A.setBreakStepSlice('a', 3, 5, R), false, 'locked empty cell cannot be assigned a slice');
  assert.equal(A.toggleBreakStep('b', 0, R), false, 'column-locked step cannot be edited');
  assert.equal(A.toggleBreakStep('c', 5, R), false, 'lane-locked step cannot be edited');
  assert.equal(A.clearBreakLane('c', R), false, 'lane-locked lane cannot be cleared');
  assert.equal(A.resetBreakLane('c', R), false, 'lane-locked lane cannot be reset');

  const beforeChop = JSON.stringify(p0);
  assert.equal(A.transport.state, 'stopped');

  // Press 1: CHOP IT! (New Groove, Jungle) -> applies immediately, 1 atomic Undo step, transport stays stopped!
  const res1 = A.chopRuff({ mode: 'new', profile: 'jungle', intensity: 0.65, seed: 2026 }, R);
  assert.equal(res1.changed, true);
  assert.equal(A.transport.state, 'stopped', 'CHOP IT! never auto-starts transport');
  p0 = patternAt(store.project, R, 0);
  assert.equal(p0.lanes.a[3], null, 'A:3 locked silence survived CHOP IT!');
  assert.equal(p0.lanes.a[0]?.slice, 0, 'column-locked A:0 survived CHOP IT!');
  assert.equal(p0.lanes.b[0]?.slice, 0, 'column-locked unedited B:0 preserved original slice 0');
  assert.equal(isBreakLaneEdited(p0, 'c'), false, 'lane-locked C remained unedited');
  assert.equal(JSON.stringify(patternAt(store.project, R, 1)), scene2Before, 'Scene 2 completely isolated');
  assert.equal(JSON.stringify(patternAt(store.project, 'slot-01', 0)), bopBefore, 'other instruments untouched');
  const afterChop1 = JSON.stringify(p0);

  // Press 2: CHOP IT! (Evolve, Darkside) -> creates a second atomic Undo step
  const res2 = A.chopRuff({ mode: 'evolve', profile: 'darkside', intensity: 0.7, seed: 3030 }, R);
  assert.equal(res2.changed, true);
  const afterChop2 = JSON.stringify(patternAt(store.project, R, 0));
  assert.notEqual(afterChop2, afterChop1);

  // Undo press 2 -> exact state after press 1; Undo press 1 -> exact pre-chop state
  A.undo();
  assert.equal(JSON.stringify(patternAt(store.project, R, 0)), afterChop1, 'first Undo restores press 1');
  A.undo();
  assert.equal(JSON.stringify(patternAt(store.project, R, 0)), beforeChop, 'second Undo restores pre-chop pattern');
  A.redo();
  A.redo();
  assert.equal(JSON.stringify(patternAt(store.project, R, 0)), afterChop2, 'Redo restores press 2 cleanly');

  // Duplicate Scene preserves all locks (including empty cell lock a:3) independently
  const dup = A.duplicateScene(0);
  const pDup = patternAt(store.project, R, dup.index);
  assert.deepEqual(pDup, patternAt(store.project, R, 0));
  assert.equal(isBreakCellDirectlyLocked(pDup, 'a', 3), true);
  assert.equal(pDup.lanes.a[3], null);

  // Validation strips bogus lock keys while keeping lane, column and lane:step cell locks
  const raw = JSON.parse(JSON.stringify(store.project));
  const rawPat = raw.slots.find(s => s.id === R).patterns[raw.scenes[0].id];
  rawPat.locked['d:3'] = true;
  rawPat.locked['a:99'] = true;
  rawPat.locked.bogus = true;
  const validated = validateProject(raw);
  const vPat = patternAt(validated, R, 0);
  assert.deepEqual(vPat.locked, { 0: true, 'a:3': true, c: true });

  // Library save/reopen round-trip
  const snap = JSON.parse(JSON.stringify(store.project));
  const mem = memoryStorage();
  const lib = createLibrary(mem);
  assert.equal(lib.save(snap), true);
  const reopened = createLibrary(mem).load(snap.id);
  assert.deepEqual(reopened, snap, 'library save/reopen preserves CHOP IT! pattern and empty-cell locks');

  // Portable .hbn export/import round-trip
  const sampleStore = createSampleStore({ backend: memoryBackend() });
  const pkg = await exportPackage(snap, { sampleStore });
  const parsed = await parsePackage(pkg.bytes);
  const restored = await restorePackage(parsed, { sampleStore });
  assert.deepEqual(restored.project, snap, '.hbn export/import preserves CHOP IT! pattern and all locks');
});

test('CHOP IT! generated patterns play cleanly across 2 bars / 16 steps with exact timing and zero orphan voices', async () => {
  const wavCache = new Map();
  const fetchAsset = async (_url, id) => {
    if (!wavCache.has(id)) {
      const desc = getBuiltinBreak(id);
      const sec = (desc.bars * 4 * 60) / desc.bpm;
      wavCache.set(id, makeWav({ seconds: sec, rate: 2000, channels: 1, freq: desc.bpm }));
    }
    return wavCache.get(id).slice(0);
  };
  const syncRunner = {
    mode: 'test',
    run: (chans, rate, factor, anchors) => Promise.resolve(stretchChannels(chans, rate, factor, { anchors })),
  };

  await withFakeWindow(async getCtx => {
    const sampleStore = createSampleStore({ backend: memoryBackend(), decode: decodeWav });
    const bank = createSampleBank({ store: sampleStore, decode: decodeWav, runner: syncRunner, stretchDelayMs: 5, fetchAsset });
    const p = createEmptyProject({ bpm: 160 });
    const ruff = slotById(p, R);
    ruff.breaks = { a: 'brk-builtin-tight', b: 'brk-builtin-funky', c: 'brk-builtin-jungle' };

    const res = chopBreakPattern({
      pattern: patternAt(p, R, 0),
      breaks: ruff.breaks,
      mode: 'new',
      profile: 'jungle',
      intensity: 0.7,
      seed: 160,
    });
    ruff.patterns[p.scenes[0].id] = res.pattern;

    const engine = createEngine(() => p, { samples: bank });
    engine.init();
    const ctx = getCtx();
    await bank.pin(BUILTIN_BREAK_IDS);
    engine.applyAll();
    const voice = engine.E.ch.get(R).voice;

    let tick;
    const si = globalThis.setInterval, ci = globalThis.clearInterval;
    globalThis.setInterval = fn => { tick = fn; return 1; };
    globalThis.clearInterval = () => {};
    const tr = createTransport(engine, () => p, {});
    try {
      tr.play();
      // 160 BPM -> 2 bars = 3.0s; run 3.1s so all 16 steps across Bar 1 + Bar 2 fire cleanly
      const until = ctx.currentTime + 3.1;
      while (ctx.currentTime < until) {
        ctx.advance(Math.min(until, ctx.currentTime + 0.02));
        tick();
      }
      const sd = 60 / p.bpm / 4;
      const expectedHits = BREAK_LANES.reduce((n, l) => n + res.pattern.lanes[l].filter(Boolean).length, 0);
      const firstLoopSources = ctx.sources.filter(s => s.startArgs && s.startArgs[0] >= 0.05 && s.startArgs[0] < 0.06 + 32 * sd - 0.005);
      assert.equal(firstLoopSources.length, expectedHits, `every generated hit across A/B/C fires on exact 2-bar grid (${firstLoopSources.length} vs ${expectedHits})`);
      // Check every scheduled source aligns to an 8th-note (2*sd) boundary
      for (const src of firstLoopSources) {
        const relSteps = (src.startArgs[0] - 0.06) / (2 * sd);
        assert.ok(near(relSteps, Math.round(relSteps), 0.02), `trigger aligns to 2-bar 8th-note step (rel=${relSteps})`);
      }
    } finally {
      tr.stop();
      globalThis.setInterval = si;
      globalThis.clearInterval = ci;
    }
    assert.equal(voice.activeCount(), 0, 'Stop cleans up all generated RUFF voices with zero orphans');
  });
});
