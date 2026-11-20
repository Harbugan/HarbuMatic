// Solo only involves playable slots: a planned instrument (MUNCH has no engine yet) must never silence the others.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyProject, createSlot, anySolo, slotAudible, playableSlots, slotIdFor, nextSlotId, validateProject } from '../src/core/project.js';
import { createEngine } from '../src/audio/engine.js';

const sceneIds = p => p.scenes.map(s => s.id);
// every song holds a MUNCH slot (slot-05) since v0.6 Phase 2
const withMunch = (opts = {}) => {
  const p = createEmptyProject();
  const m = p.slots.find(s => s.type === 'munch'); Object.assign(m, opts);
  return { p, m };
};
const audible = p => p.slots.filter(s => playableSlots(p).includes(s)).map(s => slotAudible(p, s));

test('a planned MUNCH slot with solo:true does not silence BOP, GOO, BLIP or FUZZ', () => {
  const { p, m } = withMunch({ solo: true });
  assert.equal(anySolo(p), false);
  assert.deepEqual(audible(p), [true, true, true, true]);
  assert.equal(slotAudible(p, m), true, 'the planned slot itself is not "soloed away" either');
});

test('mute still works while a planned slot is soloed', () => {
  const { p } = withMunch({ solo: true });
  p.slots[1].mute = true;
  assert.deepEqual(audible(p), [true, false, true, true]);
});

test('existing solo behaviour is unchanged for playable slots', () => {
  const p = createEmptyProject();
  assert.equal(anySolo(p), false);
  assert.deepEqual(audible(p), [true, true, true, true]);
  p.slots[2].solo = true;
  assert.equal(anySolo(p), true);
  assert.deepEqual(audible(p), [false, false, true, false]);
  p.slots[2].mute = true; // solo wins over mute, as before
  assert.deepEqual(audible(p), [false, false, true, false]);
  p.slots[0].solo = true;
  assert.deepEqual(audible(p), [true, false, true, false]);
});

test('a playable solo next to a soloed planned slot behaves as if only the playable one were soloed', () => {
  const { p } = withMunch({ solo: true });
  p.slots[3].solo = true;
  assert.equal(anySolo(p), true);
  assert.deepEqual(audible(p), [false, false, false, true]);
});

test('several playable instances of one type solo independently', () => {
  const p = createEmptyProject();
  const extra = createSlot('blip', nextSlotId(p), sceneIds(p));
  p.slots.push(extra);
  const blips = p.slots.filter(s => s.type === 'blip');
  assert.equal(blips.length, 2);
  blips[1].solo = true;
  assert.equal(anySolo(p), true);
  assert.equal(slotAudible(p, blips[0]), false);
  assert.equal(slotAudible(p, blips[1]), true);
  assert.equal(slotAudible(p, p.slots[0]), false);
  blips[1].solo = false; blips[0].solo = true;
  assert.equal(slotAudible(p, blips[0]), true);
  assert.equal(slotAudible(p, blips[1]), false);
  blips[1].solo = true; // both instances soloed: both sound
  assert.equal(slotAudible(p, blips[0]) && slotAudible(p, blips[1]), true);
});

test('the flags survive validation untouched (no data is rewritten)', () => {
  const { p } = withMunch({ solo: true });
  const back = validateProject(JSON.parse(JSON.stringify(p)));
  assert.equal(back.slots[4].type, 'munch'); assert.equal(back.slots[4].solo, true, 'the stored flag is preserved');
  assert.equal(anySolo(back), false);
  assert.equal(slotIdFor(5), back.slots[4].id);
});

test('the audio engine asks the same question: nothing is silenced by a planned solo', () => {
  const { p } = withMunch({ solo: true });
  const eng = createEngine(() => p);
  p.slots.slice(0, 4).forEach(s => assert.equal(eng.audible(s.id), true, s.id));
});
