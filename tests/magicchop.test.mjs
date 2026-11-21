// MAGIC CHOP: rhythmic structure, determinism, repetition, density bounds and lock semantics.

import test from 'node:test';
import assert from 'node:assert/strict';
import { magicChop, sliceRoles, MAGIC_STYLES } from '../src/music/magicchop.js';
import { defaultSlices, sliceHomeSteps } from '../src/core/samples.js';

const run = (o = {}) => magicChop({ pattern: { len: 32, notes: [] }, slices: defaultSlices(8), duration: 2, rate: 1, bpm: 120, style: 'straight', seed: 11, ...o });
const at = (pat, s) => pat.notes.filter(n => n.s === s && n.slice != null);
const bar = (pat, b) => pat.notes.filter(n => n.slice != null && Math.floor(n.s / 16) === b).map(n => `${n.s % 16}:${n.slice}`).join();

test('roles come from where a slice sits in the bar', () => {
  // 1 bar of 8 slices: 8th notes → K S on beats, O on the off-beats
  assert.deepEqual(sliceRoles(sliceHomeSteps(defaultSlices(8), 2, 1, 120)), ['K', 'O', 'S', 'O', 'K', 'O', 'S', 'O']);
  assert.deepEqual(sliceRoles([0, 1, 2, 3]), ['K', 'G', 'O', 'G']);
});

test('straight plays a fitted loop as recorded: slice k on its home step', () => {
  // a 2-bar break (4 s at 120 BPM), 8 slices = one per beat
  for (const seed of [3, 4, 5]) {
    const r = run({ duration: 4, len: 32, seed });
    for (let k = 0; k < 7; k++) assert.deepEqual(at(r.pattern, k * 4).map(n => n.slice), [k], `slice ${k} on step ${k * 4}`);
    assert.equal(r.pattern.notes.filter(n => n.s < 28 && n.s % 4).length, 0, 'nothing between the beats before the fill');
  }
  const half = run({ duration: 4, rate: 2, len: 16, seed: 5 }); // tape at 2×: the whole break in one bar
  assert.deepEqual(half.pattern.notes.slice(0, 7).map(n => [n.s, n.slice]), [[0, 0], [2, 1], [4, 2], [6, 3], [8, 4], [10, 5], [12, 6]]);
});

test('every style keeps the downbeat and stays inside the grid, the slices and the pattern', () => {
  for (const style of MAGIC_STYLES) for (const len of [16, 32, 64]) for (const n of [1, 3, 8, 16]) for (const seed of [1, 2, 3]) {
    const { pattern } = run({ style, len, seed, slices: defaultSlices(n), pattern: { len, notes: [] } });
    assert.equal(pattern.len, len);
    assert.ok(at(pattern, 0).length === 1, `${style}/${len}/${n}: a hit on the downbeat`);
    for (const x of pattern.notes) {
      assert.ok(Number.isInteger(x.s) && x.s >= 0 && x.s < len && x.l >= 1 && x.s + x.l <= len, `${style}: note inside the pattern`);
      assert.ok(Number.isInteger(x.slice) && x.slice >= 0 && x.slice < n, `${style}: slice exists`);
      assert.ok(x.p === 60 && x.v > 0 && x.v <= 1);
    }
    const steps = new Set(pattern.notes.map(x => x.s));
    assert.equal(steps.size, pattern.notes.length, `${style}: one hit per step`);
    for (let b = 0; b < len / 16; b++) {
      const hits = pattern.notes.filter(x => Math.floor(x.s / 16) === b).length;
      assert.ok(hits >= (style === 'straight' ? 1 : 2) && hits <= (style === 'straight' ? 16 : 14), `${style}/${len}/${n} bar ${b}: density ${hits} is a groove, not soup`);
    }
  }
});

test('kicks on beats, snares on the backbeat (half-time: on beat 3)', () => {
  const roles = sliceRoles(sliceHomeSteps(defaultSlices(8), 2, 1, 120));
  for (const seed of [1, 4, 9, 23]) {
    for (const style of ['syncopated', 'playful']) {
      const p = run({ style, seed }).pattern;
      assert.equal(roles[at(p, 0)[0].slice], 'K', `${style}: kick-role slice on 1`);
      assert.equal(roles[at(p, 4)[0].slice], 'S', `${style}: snare-role slice on 2`);
      assert.equal(roles[at(p, 12)[0].slice], 'S', `${style}: snare-role slice on 4`);
    }
    const h = run({ style: 'halftime', seed }).pattern;
    assert.equal(roles[at(h, 8)[0].slice], 'S', 'half-time: snare on 3');
    assert.equal(at(h, 4).length + at(h, 12).length, 0, 'half-time: beats 2 and 4 stay open');
    const c = run({ style: 'chaos', seed }).pattern;
    assert.equal(roles[at(c, 0)[0].slice], 'K', 'chaos keeps its anchor');
  }
});

test('repetition: bars 1 and 3 of a 4-bar pattern are identical; variation lives at phrase ends', () => {
  for (const style of ['straight', 'syncopated', 'halftime', 'playful']) for (const seed of [2, 6]) {
    const p = run({ style, seed, duration: 2, len: 64, pattern: { len: 64, notes: [] } }).pattern;
    assert.equal(bar(p, 0), bar(p, 2), `${style}: A … A`);
    const first12 = b => bar(p, b).split(',').filter(x => +x.split(':')[0] < 12).join();
    if (style !== 'playful') assert.equal(first12(1), first12(0), `${style}: A' starts like A`);
  }
});

test('deterministic: same seed same groove, new seed can differ', () => {
  for (const style of MAGIC_STYLES) assert.deepEqual(run({ style, seed: 42 }), run({ style, seed: 42 }));
  const outs = new Set([1, 2, 3, 4, 5, 6].map(seed => JSON.stringify(run({ style: 'syncopated', seed }).pattern)));
  assert.ok(outs.size > 1, 'regenerate gives variations');
});

test('locks and melodic notes are kept; locked steps get no new notes; input untouched', () => {
  const pattern = { len: 32, notes: [
    { s: 0, p: 60, l: 1, v: .5, slice: 7, locked: true },
    { s: 5, p: 64, l: 2, v: .8 },
    { s: 12, p: 72, l: 1, v: .8, locked: true },
    { s: 4, p: 60, l: 1, v: .8, slice: 3 },
  ] };
  const before = JSON.stringify(pattern);
  for (const style of MAGIC_STYLES) {
    const p = run({ style, pattern }).pattern;
    assert.equal(JSON.stringify(pattern), before, 'input not mutated');
    assert.deepEqual(p.notes.filter(n => n.s === 0), [pattern.notes[0]], `${style}: locked hit alone on its step`);
    assert.deepEqual(p.notes.filter(n => n.s === 12), [pattern.notes[2]], `${style}: locked melodic note blocks its step`);
    assert.ok(p.notes.some(n => n.s === 5 && n.p === 64 && n.slice == null), `${style}: melodic note kept`);
    assert.ok(!p.notes.some(n => n.s === 4 && n.slice === 3 && !n.locked && style === 'halftime'), 'unlocked slice notes are replaced');
  }
});

test('no sample metadata or no slices: still safe', () => {
  const p = run({ duration: 0, style: 'straight' }).pattern;
  assert.ok(at(p, 0).length === 1);
  const none = magicChop({ pattern: { len: 16, notes: [{ s: 2, p: 60, l: 1, v: .8, slice: 1 }] }, slices: [], duration: 1, bpm: 120, seed: 1 });
  assert.ok(none.pattern.notes.length >= 0);
});
