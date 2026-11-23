// Solo and mute across all five playable slots (BOP, GOO, BLIP, FUZZ, MUNCH).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyProject, createSlot, anySolo, slotAudible, playableSlots, slotIdFor, nextSlotId, validateProject } from '../src/core/project.js';
import { createEngine } from '../src/audio/engine.js';

const sceneIds = p => p.scenes.map(s => s.id);
const withMunch = (opts = {}) => {
  const p = createEmptyProject();
  const m = p.slots.find(s => s.type === 'munch'); Object.assign(m, opts);
  return { p, m };
};
const audible = p => p.slots.filter(s => playableSlots(p).includes(s)).map(s => slotAudible(p, s));

test('soloing MUNCH silences BOP, GOO, BLIP and FUZZ', () => {
  const { p, m } = withMunch({ solo: true });
  assert.equal(anySolo(p), true);
  assert.deepEqual(audible(p), [false, false, false, false, true]);
  assert.equal(slotAudible(p, m), true);
});

test('muting MUNCH silences only MUNCH, and solo wins over mute', () => {
  const { p, m } = withMunch({ mute: true });
  assert.deepEqual(audible(p), [true, true, true, true, false]);
  m.solo = true;
  assert.deepEqual(audible(p), [false, false, false, false, true]);
});

test('existing solo behaviour works across all five playable slots', () => {
  const p = createEmptyProject();
  assert.equal(anySolo(p), false);
  assert.deepEqual(audible(p), [true, true, true, true, true]);
  p.slots[2].solo = true;
  assert.equal(anySolo(p), true);
  assert.deepEqual(audible(p), [false, false, true, false, false]);
  p.slots[2].mute = true; // solo wins over mute, as before
  assert.deepEqual(audible(p), [false, false, true, false, false]);
  p.slots[0].solo = true;
  assert.deepEqual(audible(p), [true, false, true, false, false]);
});

test('soloing another instrument alongside MUNCH lets both sound', () => {
  const { p } = withMunch({ solo: true });
  p.slots[3].solo = true;
  assert.equal(anySolo(p), true);
  assert.deepEqual(audible(p), [false, false, false, true, true]);
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
  assert.equal(anySolo(back), true);
  assert.equal(slotIdFor(5), back.slots[4].id);
});

test('the audio engine agrees with slotAudible for all five slots', () => {
  const { p } = withMunch({ solo: true });
  const eng = createEngine(() => p);
  p.slots.slice(0, 4).forEach(s => assert.equal(eng.audible(s.id), false, s.id));
  assert.equal(eng.audible(p.slots[4].id), true, 'slot-05');
});
