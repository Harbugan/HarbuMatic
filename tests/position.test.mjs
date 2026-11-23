import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyProject, newBlock as blockOf, sceneIdAt, nextSceneId, emptyPattern } from '../src/core/project.js';

let cur = null; // newBlock by scene index for readability
const newBlock = (sc, reps) => blockOf(sceneIdAt(cur, sc), reps);
const role = (p, r) => p.slots[['drums', 'bass', 'synth', 'fuzz'].indexOf(r)];
import { startPosition, advance, isLoopBoundary } from '../src/audio/position.js';

function makeProject(n = 4) {
  const p = createEmptyProject();
  while (p.scenes.length < n) {
    const id = nextSceneId(p);
    p.scenes.push({ id, name: `Scene ${p.scenes.length + 1}`, harmony: null });
    p.slots.forEach(s => { s.patterns[id] = emptyPattern(s.type); });
  }
  return p;
}

function walk(project, steps, { pendingAt = {}, onStep } = {}) {
  let pos = startPosition(project), pending = null;
  const seen = [];
  for (let i = 0; i < steps; i++) {
    if (pendingAt[i] != null) pending = pendingAt[i];
    seen.push({ ...pos });
    if (onStep) onStep(pos, i);
    const r = advance(pos, project, pending);
    if (r.pendingUsed) pending = null;
    pos = r.pos;
  }
  return seen;
}

test('loop mode repeats the selected scene', () => {
  const p = (cur = makeProject()); p.scene = 2;
  const s = walk(p, 200);
  assert.ok(s.every(x => x.scene === 2));
});

test('queued scene switches exactly on the next bar line', () => {
  const p = (cur = makeProject());
  const s = walk(p, 64, { pendingAt: { 5: 3 } });
  const first = s.findIndex(x => x.scene === 3);
  assert.equal(first, 16);
  assert.equal(s[first].step, 0);
});

test('song mode follows the arrangement order, including repeats', () => {
  const p = (cur = makeProject());
  p.songMode = true;
  Object.values(role(p, 'synth').patterns).forEach(pt => { pt.len = 32; });
  Object.values(role(p, 'bass').patterns).forEach(pt => { pt.len = 16; });
  Object.values(role(p, 'fuzz').patterns).forEach(pt => { pt.len = 16; });
  p.arrangement = [newBlock(0), newBlock(2, 2), newBlock(1)];
  const s = walk(p, 32 * 5);
  const order = [];
  s.forEach(x => { if (x.step === 0) order.push(`${x.block}:${x.scene}:${x.rep}`); });
  assert.deepEqual(order, ['0:0:0', '1:2:0', '1:2:1', '2:1:0', '0:0:0']);
});

test('song mode uses each scene\'s longest pattern as its length', () => {
  const p = (cur = makeProject());
  p.songMode = true;
  TRACKS_LEN(p, 0, 64); TRACKS_LEN(p, 1, 16);
  p.arrangement = [newBlock(0), newBlock(1)];
  const s = walk(p, 64 + 16 + 1);
  assert.equal(s[63].scene, 0); assert.equal(s[64].scene, 1); assert.equal(s[80].scene, 0);
});
function TRACKS_LEN(p, sc, len) { p.slots.forEach(s => { s.patterns[sceneIdAt(p, sc)].len = len; }); }

test('auto-evolve loop boundary fires on every loop for every pattern length', () => {
  for (const len of [16, 32, 64]) {
    const p = (cur = makeProject());
    const hits = [];
    walk(p, 64 * 3, { onStep: (pos, i) => { if (isLoopBoundary(pos, len)) hits.push(i); } });
    const expected = []; for (let i = len; i < 64 * 3; i += len) expected.push(i);
    assert.deepEqual(hits, expected, `len ${len}`);
  }
});

test('the very first step after a start or scene change is not a loop boundary', () => {
  const p = (cur = makeProject());
  const s = walk(p, 40, { pendingAt: { 3: 1 } });
  assert.equal(isLoopBoundary(s[0], 16), false);
  assert.equal(isLoopBoundary(s[16], 16), false, 'scene changed at 16');
  assert.equal(isLoopBoundary(s[32], 16), true);
});

test('arrangement edits during playback never crash the walker', () => {
  const p = (cur = makeProject()); p.songMode = true;
  p.arrangement = [newBlock(0), newBlock(1), newBlock(2)];
  let pos = startPosition(p, { fromBlock: 2 });
  p.arrangement.splice(1, 2);
  for (let i = 0; i < 100; i++) pos = advance(pos, p).pos;
  assert.equal(pos.block, 0);
  p.arrangement = [];
  pos = advance(pos, p).pos;
  assert.equal(pos.song, false, 'falls back to loop mode when the song is empty');
});
