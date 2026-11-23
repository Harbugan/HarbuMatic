// v4 → v6 and v5 → v6 migration against songs frozen from v0.5.1 (tests/fixtures/v5-*.json are what the
// v0.5.1 importer produced). Every pattern, note, step, parameter, macro, mute/solo flag, scene,
// arrangement block and snapshot must arrive unchanged, under stable slot and scene ids.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  importProject, migrateV5, validateProject, detectVersion, SCHEMA_VERSION, ProjectError,
  patternAt, sceneIndexOf, slotById, createDemoProject,
} from '../src/core/project.js';
import { LEGACY_TRACKS, LEGACY_TRACK_TYPES, defaultParamsFor } from '../src/core/instruments.js';
import { DEFAULT_MACROS } from '../src/core/constants.js';
import { createLibrary, memoryStorage } from '../src/core/persistence.js';

const fx = f => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const V5 = ['v5-demo.json', 'v5-edge.json', 'v5-from-v4.json'];
const slotFor = k => `slot-0${k + 1}`;

/** slot-05 is an empty, unmuted, unsoloed MUNCH slot with default parameters and an empty pattern per scene */
function assertMunchPlaceholder(p, label) {
  const m = slotById(p, 'slot-05');
  assert.ok(m, `${label}: has slot-05`);
  assert.equal(m.type, 'munch', `${label}: slot-05 is MUNCH`);
  assert.equal(p.slots.filter(s => s.type === 'munch').length, 1, `${label}: exactly one MUNCH slot`);
  assert.equal(m.mute, false); assert.equal(m.solo, false);
  assert.deepEqual(m.params, defaultParamsFor('munch'));
  assert.deepEqual(m.macros, DEFAULT_MACROS());
  assert.deepEqual(Object.keys(m.patterns), p.scenes.map(sc => sc.id));
  Object.values(m.patterns).forEach(pt => assert.deepEqual(pt, { len: 16, notes: [] }));
}

/** assert that a v6 project carries exactly the content of a (v0.5.1-validated) v5 project */
function assertSameSong(v6, v5, label) {
  for (const k of ['id', 'name', 'created', 'bpm', 'swing', 'key', 'scale', 'scene', 'songMode']) assert.deepEqual(v6[k], v5[k], `${label}: ${k}`);
  assert.deepEqual(v6.lab, v5.lab, `${label}: lab`);
  assert.deepEqual(v6.fx, v5.fx, `${label}: fx`);
  assert.equal(v6.scenes.length, v5.scenes.length);
  v5.scenes.forEach((sc, i) => {
    assert.equal(v6.scenes[i].id, `scene-0${i + 1}`);
    assert.equal(v6.scenes[i].name, sc.name, `${label}: scene ${i} name`);
    assert.deepEqual(v6.scenes[i].harmony, sc.harmony, `${label}: scene ${i} harmony`);
  });
  assert.deepEqual(v6.arrangement.map(b => [b.id, sceneIndexOf(v6, b.sceneId), b.reps]), v5.arrangement.map(b => [b.id, b.scene, b.reps]), `${label}: arrangement`);
  // the four v5 tracks become slot-01…slot-04, followed by one empty MUNCH placeholder (v0.6 Phase 2)
  assert.equal(v6.slots.length, LEGACY_TRACKS.length + 1);
  assertMunchPlaceholder(v6, label);
  LEGACY_TRACKS.forEach((t, k) => {
    const s = v6.slots[k], tr = v5.tracks[t];
    assert.equal(s.id, slotFor(k)); assert.equal(s.type, LEGACY_TRACK_TYPES[t]);
    assert.equal(s.mute, tr.mute, `${label}: ${t} mute`); assert.equal(s.solo, tr.solo, `${label}: ${t} solo`);
    assert.deepEqual(s.params, tr.params, `${label}: ${t} params`);
    assert.deepEqual(s.macros, tr.macros, `${label}: ${t} macros`);
    tr.patterns.forEach((pt, i) => assert.deepEqual(patternAt(v6, s.id, i), pt, `${label}: ${t} scene ${i} pattern`));
  });
  v5.snaps.forEach((sn, i) => {
    if (!sn) { assert.equal(v6.snaps[i], null, `${label}: empty snapshot ${i}`); return; }
    LEGACY_TRACKS.forEach((t, k) => {
      const e = v6.snaps[i].slots[slotFor(k)];
      assert.equal(e.type, LEGACY_TRACK_TYPES[t]);
      assert.deepEqual(e.pattern, sn.tracks[k], `${label}: snapshot ${i} ${t} pattern`);
      assert.deepEqual(e.macros, sn.macros[k], `${label}: snapshot ${i} ${t} macros`);
    });
  });
}

for (const f of V5) {
  test(`v5 → v6 keeps every bit of musical content: ${f}`, () => {
    const v5 = fx(f), v6 = importProject(v5);
    assert.equal(detectVersion(v5), 5);
    assert.equal(v6.v, SCHEMA_VERSION);
    assertSameSong(v6, v5, f);
    assert.equal(v6.tracks, undefined, 'no leftover v5 structure');
  });
}

test('the edge fixture really exercises mute, snapshots, repeats, locks, chance, offsets and slides', () => {
  const e = fx('v5-edge.json');
  assert.ok(e.tracks.synth.mute && e.songMode && e.snaps[0] && e.snaps[2] && !e.snaps[1]);
  assert.ok(e.arrangement.some(b => b.reps > 1));
  const notes = Object.values(e.tracks).flatMap(t => t.patterns.flatMap(p => p.notes || []));
  for (const k of ['locked', 'pr', 'o', 'slide']) assert.ok(notes.some(n => n[k] != null), k);
});

test('v4 → v6 gives the same song v0.5.1 made of it', () => {
  const v6 = importProject(fx('v4-demo.json')), ref = fx('v5-from-v4.json');
  // the v4 importer mints a new song id, block ids and a modified time; everything else must match
  const v6c = structuredClone(v6), refc = structuredClone(ref);
  [v6c, refc].forEach(p => { p.id = p.created = 'x'; p.arrangement.forEach(b => { b.id = 'b'; }); });
  assertSameSong(v6c, refc, 'v4');
});

test('migration is deterministic and idempotent', () => {
  for (const f of V5) {
    const v5 = fx(f);
    assert.deepEqual(migrateV5(v5), migrateV5(v5), 'same input → same output');
    const once = importProject(v5);
    assert.deepEqual(importProject(once), once, 're-importing a migrated song changes nothing');
    assert.deepEqual(validateProject(once), once, 'validation is idempotent');
    assert.deepEqual(importProject(JSON.parse(JSON.stringify(once))), once, 'serialise → import round-trip');
  }
});

test('migration never mutates its input', () => {
  const v5 = fx('v5-edge.json'), copy = structuredClone(v5);
  importProject(v5);
  assert.deepEqual(v5, copy);
});

test('scene references stay valid: arrangement uses scene ids, positions resolve by id', () => {
  const p = importProject(fx('v5-edge.json'));
  assert.ok(p.arrangement.every(b => typeof b.sceneId === 'string' && sceneIndexOf(p, b.sceneId) >= 0));
  assert.ok(p.arrangement.every(b => !('scene' in b)));
  // patterns are keyed by scene id, so scene identity does not depend on array position
  p.slots.forEach(s => assert.deepEqual(Object.keys(s.patterns), p.scenes.map(sc => sc.id)));
  const bop = slotById(p, 'slot-01');
  const reordered = structuredClone(p); reordered.scenes.reverse();
  const v = validateProject(reordered);
  assert.deepEqual(patternAt(v, 'slot-01', 5), bop.patterns['scene-01'], 'the pattern follows its scene, not its index');
  assert.deepEqual(v.arrangement.map(b => b.sceneId), p.arrangement.map(b => b.sceneId));
});

test('a song with more scenes than this version supports is refused, not truncated', () => {
  const p = createDemoProject();
  p.scenes.push({ id: 'scene-07', name: 'Extra', harmony: null });
  const ok7 = importProject(structuredClone(p));
  assert.equal(ok7.scenes.length, 7, 'dynamic scenes beyond six are accepted');
  while (p.scenes.length <= 64) p.scenes.push({ id: `scene-${String(p.scenes.length + 1).padStart(2, '0')}`, name: `Scene ${p.scenes.length + 1}`, harmony: null });
  assert.throws(() => importProject(p), e => e instanceof ProjectError && /up to 64/.test(e.message));
});

test('snapshots recall only into the same kind of instrument (type is remembered)', () => {
  const p = importProject(fx('v5-edge.json'));
  assert.deepEqual(Object.keys(p.snaps[0].slots), ['slot-01', 'slot-02', 'slot-03', 'slot-04']);
  assert.deepEqual(Object.values(p.snaps[0].slots).map(e => e.type), ['bop', 'goo', 'blip', 'fuzz']);
  const broken = structuredClone(p); broken.snaps[0].slots['slot-99'] = { type: 'blip', pattern: { len: 16, notes: [] } };
  assert.equal(validateProject(broken).snaps[0].slots['slot-99'], undefined, 'entries for slots that do not exist are dropped');
});

test('library: v0.5 songs are copied into the v6 library once, the v0.5 keys stay byte-for-byte untouched', () => {
  const store = memoryStorage(), edge = fx('v5-edge.json'), demo = { ...fx('v5-demo.json'), id: 'song_demo' }; // the two fixtures share an id
  const v5Keys = {
    [`harbumatic.v5.song.${edge.id}`]: JSON.stringify(edge),
    [`harbumatic.v5.song.${demo.id}`]: JSON.stringify(demo),
    'harbumatic.v5.song.broken': '{"v":5, nope',
    'harbumatic.v5.index': JSON.stringify({ current: edge.id, legacyAdopted: true, projects: { [edge.id]: { name: edge.name, modified: edge.modified }, [demo.id]: { name: demo.name, modified: demo.modified }, broken: { name: 'Broken', modified: 'x' } } }),
  };
  Object.entries(v5Keys).forEach(([k, v]) => store.setItem(k, v));
  const lib = createLibrary(store);
  assert.equal(lib.currentId(), edge.id, 'the current song stays current');
  assert.deepEqual(lib.list().map(x => x.id).sort(), [demo.id, edge.id].sort(), 'readable songs adopted, the broken one skipped');
  const p = lib.load(edge.id);
  assert.equal(p.v, SCHEMA_VERSION);
  assertSameSong(p, edge, 'library');
  assert.equal(lib.adoptLegacy(), null, 'a v0.4 autosave adopted by v0.5 is not adopted again');
  p.name = 'Edited in v0.6'; lib.save(p);
  assert.equal(JSON.parse(store.getItem(`harbumatic.v6.song.${edge.id}`)).name, 'Edited in v0.6');
  Object.entries(v5Keys).forEach(([k, v]) => assert.equal(store.getItem(k), v, `${k} untouched`));
  // adoption happens once: songs added later by an older build on the same origin are not re-imported
  store.setItem('harbumatic.v5.index', JSON.stringify({ current: 'late', projects: { late: { name: 'Late' } } }));
  assert.equal(createLibrary(store).list().length, 2);
  assert.deepEqual(createLibrary(store).load(edge.id), lib.load(edge.id));
});

test('library: a fresh browser starts an empty v6 library and still adopts a v0.4 autosave', () => {
  const store = memoryStorage();
  store.setItem('harbumatic.v4', JSON.stringify(fx('v4-demo.json')));
  const lib = createLibrary(store);
  assert.equal(lib.list().length, 0);
  const p = lib.adoptLegacy();
  assert.ok(p && p.v === SCHEMA_VERSION && lib.list().length === 1);
});
