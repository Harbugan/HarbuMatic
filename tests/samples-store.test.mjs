// Sample store (durable assets) and sample bank (decoded buffers), against the in-memory backend and a WAV decoder
// that behaves like decodeAudioData. The IndexedDB backend itself runs in the browser test (npm run test:ui).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSampleStore, memoryBackend, SampleError, SAMPLE_LIMITS } from '../src/samples/store.js';
import { createSampleBank, decodeWith } from '../src/samples/bank.js';
import { sha256js, sha256Hex, sampleIdFor } from '../src/samples/hash.js';
import { isSampleId } from '../src/core/samples.js';
import { makeWav, decodeWav, createFakeContext } from './helpers/audio.mjs';

const nodeSha = b => createHash('sha256').update(Buffer.from(b)).digest('hex');
const code = c => e => e instanceof SampleError && e.code === c;
const newStore = (opts = {}) => { const backend = memoryBackend(opts); return { backend, store: createSampleStore({ backend, decode: decodeWav }) }; };

/* ---------- ids ---------- */
test('sample ids are SHA-256 content addresses, identical with and without Web Crypto', async () => {
  for (const b of [new ArrayBuffer(0), new Uint8Array([97, 98, 99]).buffer, makeWav({ seconds: .1 }), new Uint8Array(1000).fill(7).buffer]) {
    assert.equal(sha256js(b), nodeSha(b));
    assert.equal(await sha256Hex(b), nodeSha(b));
  }
  const id = await sampleIdFor(makeWav());
  assert.ok(isSampleId(id)); assert.equal(id, await sampleIdFor(makeWav()), 'same bytes, same id');
  assert.notEqual(id, await sampleIdFor(makeWav({ freq: 441 })));
});

/* ---------- import ---------- */
test('imports WAV in several lengths, rates, channel counts and sample formats with metadata', async () => {
  const { store } = newStore();
  const cases = [
    [{ seconds: .05, rate: 22050, channels: 1 }, 'tiny.wav'],
    [{ seconds: 1, rate: 44100, channels: 1 }, 'mono.wav'],
    [{ seconds: 2.5, rate: 48000, channels: 2 }, 'stereo.wav'],
    [{ seconds: 1.5, rate: 96000, channels: 2, float: true }, 'float.wav'],
    [{ seconds: 30, rate: 8000, channels: 1 }, 'limit.wav'],
  ];
  for (const [o, name] of cases) {
    const bytes = makeWav(o);
    const { meta, buffer, duplicate } = await store.importBytes({ bytes, name, type: 'audio/wav' });
    assert.equal(duplicate, false);
    assert.ok(Math.abs(meta.duration - Math.round(o.seconds * o.rate) / o.rate) < 1e-9, name); assert.equal(meta.sampleRate, o.rate); assert.equal(meta.channels, o.channels);
    assert.equal(meta.name, name); assert.equal(meta.size, bytes.byteLength); assert.equal(meta.type, 'audio/wav');
    assert.equal(buffer.length, Math.round(o.seconds * o.rate));
    assert.deepEqual(new Uint8Array(await store.getBytes(meta.id)), new Uint8Array(bytes), 'original bytes preserved');
  }
  assert.equal((await store.list()).length, cases.length);
});

test('identical files are stored once; the input buffer is never detached or changed', async () => {
  const { store, backend } = newStore();
  const bytes = makeWav(), keep = new Uint8Array(bytes).slice();
  const a = await store.importBytes({ bytes, name: 'a.wav' });
  const b = await store.importBytes({ bytes: makeWav(), name: 'renamed.wav' });
  assert.equal(b.duplicate, true); assert.equal(b.meta.id, a.meta.id); assert.equal(b.meta.name, 'a.wav', 'first metadata kept');
  assert.equal(backend.db.bytes.size, 1);
  assert.deepEqual(new Uint8Array(bytes), keep);
  // a reference whose bytes went missing is restored by importing the same file again
  backend.db.bytes.delete(a.meta.id);
  const c = await store.importBytes({ bytes: makeWav(), name: 'again.wav' });
  assert.equal(c.duplicate, false); assert.equal(c.meta.id, a.meta.id); assert.ok(await store.has(a.meta.id));
});

test('empty, unsupported, too large and too long files are refused with a clear reason, and nothing is stored', async () => {
  const { store, backend } = newStore();
  await assert.rejects(store.importBytes({ bytes: new ArrayBuffer(0), name: 'x' }), code('empty'));
  await assert.rejects(store.importBytes({ bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer, name: 'junk.wav' }), e => code('unsupported')(e) && /junk\.wav/.test(e.message));
  const notWav = new Uint8Array(4000).map((_, i) => (i * 37) & 255).buffer;
  await assert.rejects(store.importBytes({ bytes: notWav, name: 'noise.mp3' }), code('unsupported'));
  await assert.rejects(store.importBytes({ bytes: new ArrayBuffer(SAMPLE_LIMITS.maxBytes + 1), name: 'huge' }), code('too-large'));
  await assert.rejects(store.importBytes({ bytes: makeWav({ seconds: 31, rate: 8000 }), name: 'long.wav' }), e => code('too-long')(e) && /30 s/.test(e.message));
  assert.equal(backend.db.bytes.size + backend.db.meta.size, 0);
  const noDecoder = createSampleStore({ backend: memoryBackend() });
  await assert.rejects(noDecoder.importBytes({ bytes: makeWav(), name: 'a' }), code('not-ready'));
});

test('a full disk gives a quota error and stores nothing (asset and metadata are written together)', async () => {
  const { store, backend } = newStore({ quotaBytes: 100000 });
  await store.importBytes({ bytes: makeWav({ seconds: .5, rate: 44100 }), name: 'fits.wav' }); // ~44 kB
  await assert.rejects(store.importBytes({ bytes: makeWav({ seconds: 1, rate: 44100, freq: 220 }), name: 'big.wav' }), e => code('quota')(e) && /storage/i.test(e.message));
  assert.equal(backend.db.bytes.size, 1); assert.equal(backend.db.meta.size, 1);
});

test('missing and damaged assets are reported, never silently replaced', async () => {
  const { store, backend } = newStore();
  await assert.rejects(store.getBytes('smp-' + '0'.repeat(64)), code('missing'));
  const { meta } = await store.importBytes({ bytes: makeWav(), name: 'a.wav' });
  backend.db.bytes.set(meta.id, { id: meta.id, data: 'not bytes' });
  await assert.rejects(store.getBytes(meta.id), code('corrupt'));
});

test('samples are only deleted explicitly, and never while referenced', async () => {
  const { store } = newStore();
  const { meta } = await store.importBytes({ bytes: makeWav(), name: 'a.wav' });
  await assert.rejects(store.remove(meta.id, { referenced: new Set([meta.id]) }), code('in-use'));
  assert.ok(await store.has(meta.id));
  await store.remove(meta.id);
  assert.equal(await store.has(meta.id), false);
});

/* ---------- bank ---------- */
test('the bank decodes from the store once, even for concurrent loads, and reports explicit states', async () => {
  const { store } = newStore();
  const { meta } = await store.importBytes({ bytes: makeWav({ seconds: .5 }), name: 'a.wav' });
  let decodes = 0;
  const bank = createSampleBank({ store, decode: ab => { decodes++; return decodeWav(ab); } });
  const seen = []; bank.on((id, st) => seen.push(st.status));
  assert.equal(bank.state(meta.id).status, 'idle'); assert.equal(bank.buffer(meta.id), null, 'buffer() never decodes');
  const [a, b] = await Promise.all([bank.load(meta.id), bank.load(meta.id)]);
  assert.equal(a, b); assert.equal(decodes, 1); assert.equal(bank.state(meta.id).status, 'ready');
  assert.deepEqual(seen, ['loading', 'ready']);
  assert.equal(bank.buffer(meta.id), a);
});

test('missing and undecodable samples end in missing / error states with a message; play stays silent', async () => {
  const { store, backend } = newStore();
  const bank = createSampleBank({ store, decode: decodeWav });
  const gone = 'smp-' + '1'.repeat(64);
  assert.equal(await bank.load(gone), null);
  assert.equal(bank.state(gone).status, 'missing'); assert.match(bank.state(gone).error, /not stored on this device/);
  const bad = 'smp-' + '2'.repeat(64);
  backend.db.bytes.set(bad, { id: bad, data: new Uint8Array([9, 9, 9]).buffer });
  assert.equal(await bank.load(bad), null);
  assert.equal(bank.state(bad).status, 'error'); assert.equal(bank.buffer(bad), null);
});

test('decoded memory is bounded: least recently used unpinned samples are evicted first, pinned ones never', async () => {
  const { store } = newStore();
  const ids = [];
  for (const f of [220, 330, 440, 550]) ids.push((await store.importBytes({ bytes: makeWav({ seconds: 1, rate: 10000, freq: f }), name: `${f}.wav` })).meta.id);
  const one = 10000 * 4; // one decoded second at 10 kHz mono
  const bank = createSampleBank({ store, decode: decodeWav, budgetBytes: one * 2.5 });
  await bank.pin([ids[0]]);
  await bank.load(ids[1]); await bank.load(ids[2]);
  assert.ok(bank.usage() <= one * 2.5);
  await bank.load(ids[3]);
  assert.equal(bank.state(ids[0]).status, 'ready', 'pinned (used by the song) stays');
  assert.equal(bank.state(ids[1]).status, 'idle', 'least recently used goes');
  assert.equal(bank.state(ids[3]).status, 'ready');
  assert.ok(await bank.load(ids[1]), 'an evicted sample simply loads again');
});

test('reverse uses one reversed copy built ahead of playback', async () => {
  const { store } = newStore();
  const ctx = createFakeContext();
  const bank = createSampleBank({ store });
  bank.attach(ctx);
  const { meta } = await bank.importBytes({ bytes: makeWav({ seconds: .01, rate: 1000, freq: 0 }), name: 'ramp.wav' });
  const fwd = bank.buffer(meta.id);
  assert.equal(bank.state(meta.id).status, 'ready', 'an imported sample is ready at once (no second decode)');
  bank.prepare(meta.id, true);
  const rev = bank.buffer(meta.id, true);
  assert.equal(rev, bank.buffer(meta.id, true), 'built once');
  const f = fwd.getChannelData(0), r = rev.getChannelData(0);
  assert.equal(r[0], f[f.length - 1]); assert.equal(r[r.length - 1], f[0]);
  assert.equal(bank.usage(), 2 * f.length * 4);
});

test('loads wait for the audio context; imports before it exists are refused clearly', async () => {
  const { store } = newStore();
  const { meta } = await store.importBytes({ bytes: makeWav(), name: 'a.wav' });
  const bank = createSampleBank({ store });
  await assert.rejects(bank.importBytes({ bytes: makeWav({ freq: 300 }), name: 'b.wav' }), code('not-ready'));
  const p = bank.load(meta.id);
  assert.equal(bank.state(meta.id).status, 'loading'); assert.ok(bank.isLoading([meta.id]));
  assert.equal(await bank.whenSettled([meta.id], 20), false, 'bounded wait');
  bank.attach(createFakeContext());
  assert.ok(await p);
  assert.equal(await bank.whenSettled([meta.id], 20), true);
  assert.equal(typeof decodeWith(createFakeContext()), 'function');
});
