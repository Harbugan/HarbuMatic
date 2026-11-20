// v5 → v6 library adoption must be recoverable: per-project ledger, retries, no duplicates, v5 keys never touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLibrary, memoryStorage } from '../src/core/persistence.js';

const fx = f => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
// the frozen fixtures share one song id (demo and edge); give each its own so they behave like three different songs
const withId = (f, id) => JSON.stringify({ ...JSON.parse(fx(f)), id });
const DEMO = withId('v5-demo.json', 'song_demo'), EDGE = withId('v5-edge.json', 'song_edge'), FROM_V4 = withId('v5-from-v4.json', 'song_from4');
const idOf = text => JSON.parse(text).id;
const V5_INDEX = 'harbumatic.v5.index', V5_SONG = id => `harbumatic.v5.song.${id}`, V6_SONG = id => `harbumatic.v6.song.${id}`, V6_INDEX = 'harbumatic.v6.index';

const SONGS = [['demo', DEMO], ['edge', EDGE], ['from4', FROM_V4]];

/** storage with switchable failures; `failSet(key)` makes setItem throw a quota error for that key */
function faultyStorage() {
  const base = memoryStorage();
  const f = { failSet: () => false, failGet: () => false };
  const quota = () => Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError', code: 22 });
  const s = {
    getItem: k => { if (f.failGet(k)) throw new Error('read failed'); return base.getItem(k); },
    setItem: (k, v) => { if (f.failSet(k, v)) throw quota(); base.setItem(k, v); },
    removeItem: k => base.removeItem(k),
    _map: base._map, f,
  };
  return s;
}
function seedV5(store, songs = SONGS, current = idOf(songs[0][1])) {
  const projects = {};
  for (const [name, text] of songs) { store.setItem(V5_SONG(idOf(text)), text); projects[idOf(text)] = { name, modified: JSON.parse(text).modified || 'x' }; }
  store.setItem(V5_INDEX, JSON.stringify({ current, projects }));
}
const v5Snapshot = store => JSON.stringify([...store._map].filter(([k]) => k.startsWith('harbumatic.v5.')).sort());
const ids = lib => lib.list().map(p => p.id).sort();

test('clean migration copies every song once, marks the ledger complete and warns about nothing', () => {
  const store = faultyStorage(); seedV5(store);
  const before = v5Snapshot(store), lib = createLibrary(store);
  assert.equal(lib.list().length, 3);
  assert.equal(lib.currentId(), idOf(DEMO));
  assert.equal(lib.migrationStatus().complete, true);
  assert.equal(lib.migrationWarning(), null);
  assert.equal(v5Snapshot(store), before, 'v5 keys byte-identical');
  assert.equal(createLibrary(store).list().length, 3, 'a second launch adds nothing');
});

test('a corrupt song does not hide the others, is reported as corrupt and is retried on the next launch', () => {
  const store = faultyStorage(); seedV5(store);
  const edgeId = idOf(EDGE), good = EDGE;
  store.setItem(V5_SONG(edgeId), '{ this is not json');
  const before = v5Snapshot(store);
  let lib = createLibrary(store);
  assert.deepEqual(ids(lib), [idOf(DEMO), idOf(FROM_V4)].sort(), 'healthy songs are visible');
  let st = lib.migrationStatus();
  assert.equal(st.complete, false);
  assert.equal(st.corrupt, 1); assert.equal(st.storage, 0);
  assert.equal(st.failed[0].id, edgeId); assert.equal(st.failed[0].name, 'edge');
  assert.match(lib.migrationWarning(), /1 song .*could not be copied \(damaged data\)/);
  assert.equal(v5Snapshot(store), before, 'v5 keys untouched, including the broken one');

  lib = createLibrary(store); // still broken → still reported, still no duplicates
  assert.equal(lib.list().length, 2);
  assert.equal(lib.migrationStatus().corrupt, 1);

  store.setItem(V5_SONG(edgeId), good); // data is repaired (or a newer build fixes the importer) → next launch recovers it
  lib = createLibrary(store);
  assert.equal(lib.list().length, 3);
  assert.equal(lib.migrationStatus().complete, true);
  assert.equal(lib.migrationWarning(), null);
  assert.ok(lib.load(edgeId), 'recovered song opens');
});

test('missing song data and a song newer than this app count as corrupt, not as silently skipped', () => {
  const store = faultyStorage(); seedV5(store);
  store.removeItem(V5_SONG(idOf(DEMO)));
  store.setItem(V5_SONG(idOf(EDGE)), JSON.stringify({ ...JSON.parse(EDGE), v: 99 }));
  const lib = createLibrary(store);
  assert.deepEqual(ids(lib), [idOf(FROM_V4)]);
  const st = lib.migrationStatus();
  assert.equal(st.corrupt, 2); assert.equal(st.failed.length, 2);
});

test('storage quota errors are reported separately and succeed on retry once space is free', () => {
  const store = faultyStorage(); seedV5(store);
  store.f.failSet = k => k === V6_SONG(idOf(EDGE));
  const before = v5Snapshot(store);
  let lib = createLibrary(store);
  assert.deepEqual(ids(lib), [idOf(DEMO), idOf(FROM_V4)].sort());
  let st = lib.migrationStatus();
  assert.equal(st.storage, 1); assert.equal(st.corrupt, 0);
  assert.match(lib.migrationWarning(), /storage is full or unavailable/);
  assert.equal(store.getItem(V6_SONG(idOf(EDGE))), null, 'no half-written song');

  store.f.failSet = () => false; // user freed space
  lib = createLibrary(store);
  assert.equal(lib.list().length, 3);
  assert.equal(lib.migrationStatus().complete, true);
  assert.equal(v5Snapshot(store), before);
});

test('mixed failures are counted per reason in one warning', () => {
  const store = faultyStorage(); seedV5(store);
  store.setItem(V5_SONG(idOf(DEMO)), 'nope');
  store.f.failSet = k => k === V6_SONG(idOf(EDGE));
  const lib = createLibrary(store);
  const st = lib.migrationStatus();
  assert.equal(st.corrupt, 1); assert.equal(st.storage, 1);
  assert.match(lib.migrationWarning(), /2 songs .*storage is full or damaged data/);
});

test('retry never duplicates, never overwrites edits and never resurrects a deleted song', () => {
  const store = faultyStorage(); seedV5(store);
  store.f.failSet = k => k === V6_SONG(idOf(EDGE));
  let lib = createLibrary(store);
  // work in v6 while one song is still pending: edit one, delete another
  const demo = lib.load(idOf(DEMO)); demo.name = 'Edited in v6'; demo.bpm = 133; demo.modified = '2099-01-01T00:00:00.000Z'; assert.ok(lib.save(demo));
  lib.remove(idOf(FROM_V4));
  store.f.failSet = () => false;
  lib = createLibrary(store);
  assert.deepEqual(ids(lib), [idOf(DEMO), idOf(EDGE)].sort(), 'edge recovered, deleted song stays deleted, no copies');
  assert.equal(lib.load(idOf(DEMO)).name, 'Edited in v6'); assert.equal(lib.load(idOf(DEMO)).bpm, 133);
  assert.equal(lib.migrationStatus().complete, true);
});

test('a failed index write after copying songs recovers without duplicates', () => {
  const store = faultyStorage(); seedV5(store);
  store.f.failSet = k => k === V6_INDEX;
  let lib = createLibrary(store);
  assert.equal(lib.list().length, 3, 'songs stay visible in this session');
  assert.equal(lib.list().length, 3, 'and are not re-imported on every call');
  store.f.failSet = () => false;
  lib = createLibrary(store);
  assert.equal(lib.list().length, 3);
  assert.equal(lib.migrationStatus().complete, true);
});

test('an unreadable v0.5 song list is a reported failure that retries; it is not treated as "no v0.5 library"', () => {
  const store = faultyStorage(); seedV5(store);
  const goodIndex = store.getItem(V5_INDEX);
  store.setItem(V5_INDEX, '{broken');
  let lib = createLibrary(store);
  assert.equal(lib.list().length, 0);
  assert.equal(lib.migrationStatus().complete, false);
  assert.ok(lib.migrationWarning());
  store.setItem(V5_INDEX, goodIndex);
  lib = createLibrary(store);
  assert.equal(lib.list().length, 3);
  assert.equal(lib.migrationWarning(), null);
});

test('a library from the first v6 build (adopted flag, no ledger) recovers songs it hid', () => {
  const store = faultyStorage(); seedV5(store);
  // what the earlier build left behind: only one song copied, flag says "done"
  store.setItem(V6_INDEX, JSON.stringify({ current: null, projects: {}, v5Adopted: true }));
  const lib = createLibrary(store);
  assert.equal(lib.list().length, 3);
  assert.equal(lib.migrationStatus().complete, true);
});

test('two v0.5 songs that carry the same inner id both arrive (the second gets a new id)', () => {
  const store = faultyStorage();
  const a = fx('v5-demo.json'), b = fx('v5-edge.json'); // same id inside, different keys
  store.setItem(V5_SONG('k1'), a); store.setItem(V5_SONG('k2'), b);
  store.setItem(V5_INDEX, JSON.stringify({ current: 'k1', projects: { k1: { name: 'a' }, k2: { name: 'b' } } }));
  const lib = createLibrary(store);
  assert.equal(lib.list().length, 2);
  assert.deepEqual(lib.list().map(p => p.name).sort(), ['Demo jam', 'Edge case']);
  assert.equal(createLibrary(store).list().length, 2, 'stable on the next launch');
});

test('no v0.5 library at all: complete, empty, no warning', () => {
  const lib = createLibrary(memoryStorage());
  assert.equal(lib.list().length, 0);
  assert.equal(lib.migrationStatus().complete, true);
  assert.equal(lib.migrationWarning(), null);
});

test('a v6 song with the same id as a v0.5 song is kept next to it, not overwritten', () => {
  const store = faultyStorage(); seedV5(store, [['demo', DEMO]]);
  const clash = JSON.parse(DEMO); clash.name = 'Already in v6'; clash.v = 6;
  store.setItem(V6_INDEX, JSON.stringify({ current: null, projects: { [clash.id]: { name: 'Already in v6', modified: 'x' } }, v5Adopted: true, v5Migration: { complete: false, migrated: {}, failed: {} } }));
  store.setItem(V6_SONG(clash.id), JSON.stringify(clash));
  const lib = createLibrary(store);
  assert.equal(lib.list().length, 2);
  assert.equal(lib.load(clash.id).name, 'Already in v6');
});
