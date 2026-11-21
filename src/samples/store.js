// Sample store: the durable home of sample assets (original file bytes + metadata), outside the project JSON.
//
//   IndexedDB database 'harbumatic-samples' (v1)
//     meta   { id, name, type, size, duration, sampleRate, channels, frames, created }   keyPath id
//     bytes  { id, data: ArrayBuffer }                                                  keyPath id
//   id = 'smp-' + SHA-256 of the original bytes (src/samples/hash.js), so importing the same file twice stores it
//   once, and a sample that is missing on this device comes back by importing the same file again.
//
// The original bytes are kept as they were imported or recorded (WAV, MP3, AAC/M4A, Ogg/WebM …); decoding happens
// only in the sample bank (src/samples/bank.js). Nothing here is ever deleted automatically: remove() is explicit.
// The storage backend is a tiny interface so the logic runs in Node tests against memoryBackend().

import { sampleIdFor } from './hash.js';

export const DB_NAME = 'harbumatic-samples';
/** limits per sample (checked on import; see docs/SAMPLES.md for how they were chosen) */
export const SAMPLE_LIMITS = Object.freeze({ maxBytes: 32 * 1024 * 1024, maxSeconds: 30 });

export class SampleError extends Error {
  /** code: empty | too-large | too-long | unsupported | quota | unavailable | missing | corrupt | in-use | not-ready | permission | no-mic | recording */
  constructor(code, message, cause) { super(message); this.name = 'SampleError'; this.code = code; this.cause = cause; }
}
const isQuota = e => !!e && (e.name === 'QuotaExceededError' || e.code === 22 || /quota/i.test(String(e.message)));

/* ---------- backends ---------- */
/** IndexedDB backend; rejects with SampleError('unavailable') when IndexedDB cannot be opened (e.g. blocked storage) */
export function indexedDbBackend(idb = globalThis.indexedDB, name = DB_NAME) {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    if (!idb) { rej(new SampleError('unavailable', 'This browser does not allow sample storage here (IndexedDB is unavailable).')); return; }
    let req;
    try { req = idb.open(name, 1); } catch (e) { rej(new SampleError('unavailable', 'Sample storage could not be opened.', e)); return; }
    req.onupgradeneeded = () => { const db = req.result; for (const s of ['meta', 'bytes']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' }); };
    req.onsuccess = () => { const db = req.result; db.onversionchange = () => { db.close(); dbp = null; }; res(db); };
    req.onerror = () => rej(new SampleError('unavailable', 'Sample storage could not be opened.', req.error));
    req.onblocked = () => rej(new SampleError('unavailable', 'Sample storage is busy in another tab. Close it and try again.'));
  }).catch(e => { dbp = null; throw e; }));
  const tx = async (stores, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      let out, t;
      try { t = db.transaction(stores, mode); } catch (e) { rej(e); return; }
      t.oncomplete = () => res(out);
      t.onabort = t.onerror = () => rej(t.error || new Error('transaction failed'));
      try { out = fn(t); } catch (e) { try { t.abort(); } catch (er) { /* */ } rej(e); }
    });
  };
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return {
    async get(store, id) { let r; await tx([store], 'readonly', t => { r = req(t.objectStore(store).get(id)); }); return (await r) ?? null; },
    async keys(store) { let r; await tx([store], 'readonly', t => { r = req(t.objectStore(store).getAllKeys()); }); return (await r) || []; },
    /** atomic: every entry lands, or none does */
    async put(entries) { await tx([...new Set(entries.map(e => e[0]))], 'readwrite', t => { entries.forEach(([s, v]) => t.objectStore(s).put(v)); }); },
    async del(id) { await tx(['meta', 'bytes'], 'readwrite', t => { t.objectStore('meta').delete(id); t.objectStore('bytes').delete(id); }); },
  };
}

/** in-memory backend for tests; quotaBytes simulates a full disk (puts that would exceed it fail like IndexedDB) */
export function memoryBackend({ quotaBytes = Infinity } = {}) {
  const db = { meta: new Map(), bytes: new Map() };
  const size = () => [...db.bytes.values()].reduce((a, v) => a + v.data.byteLength, 0);
  const copy = v => (v && v.data ? { ...v, data: v.data.slice(0) } : v && { ...v });
  return {
    db,
    async get(store, id) { return copy(db[store].get(id)) ?? null; },
    async keys(store) { return [...db[store].keys()]; },
    async put(entries) {
      const add = entries.reduce((a, [s, v]) => a + (s === 'bytes' ? v.data.byteLength : 0), 0);
      if (size() + add > quotaBytes) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; }
      entries.forEach(([s, v]) => db[s].set(v.id, copy(v)));
    },
    async del(id) { db.meta.delete(id); db.bytes.delete(id); },
  };
}

/* ---------- store ---------- */
/**
 * @param backend   indexedDbBackend() | memoryBackend()
 * @param decode    (ArrayBuffer) → Promise<AudioBuffer-like { duration, sampleRate, numberOfChannels, length }>;
 *                  receives a copy (decodeAudioData detaches its input)
 */
export function createSampleStore({ backend = indexedDbBackend(), decode, limits = SAMPLE_LIMITS, now = () => new Date().toISOString() } = {}) {
  const wrap = e => (e instanceof SampleError ? e : isQuota(e)
    ? new SampleError('quota', 'Not enough storage space on this device for this sample. Free some space or use a shorter sample.', e)
    : new SampleError('unavailable', 'The sample could not be stored.', e));
  const store = {
    limits,
    /**
     * Store a sample from raw bytes. Returns { meta, buffer, duplicate } — buffer is the decoded audio (hand it
     * to the bank so it is not decoded twice), duplicate means the same bytes were already stored.
     */
    async importBytes({ bytes, name = 'Sample', type = '' }, decodeWith = decode) {
      if (!bytes || !bytes.byteLength) throw new SampleError('empty', 'That file is empty.');
      if (bytes.byteLength > limits.maxBytes) throw new SampleError('too-large', `That file is too big (${Math.round(bytes.byteLength / 1048576)} MB). Samples can be up to ${Math.round(limits.maxBytes / 1048576)} MB.`);
      if (!decodeWith) throw new SampleError('not-ready', 'Audio is not started yet. Tap Play once, then try again.');
      const id = await sampleIdFor(bytes);
      let buffer;
      try { buffer = await decodeWith(bytes.slice(0)); } catch (e) { if (e instanceof SampleError) throw e; throw new SampleError('unsupported', `“${name}” is not an audio format this browser can read. Try WAV, MP3 or M4A.`, e); }
      if (!buffer || !(buffer.duration > 0) || !buffer.length) throw new SampleError('unsupported', `“${name}” holds no audio.`);
      if (buffer.duration > limits.maxSeconds + .05) throw new SampleError('too-long', `“${name}” is ${buffer.duration.toFixed(1)} s long. Samples can be up to ${limits.maxSeconds} s.`);
      let existing = null;
      try { existing = await backend.get('meta', id); } catch (e) { throw wrap(e); }
      if (existing && await backend.get('bytes', id).catch(() => null)) return { meta: existing, buffer, duplicate: true };
      const meta = { id, name: String(name).slice(0, 80) || 'Sample', type: String(type || ''), size: bytes.byteLength, duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, frames: buffer.length, created: now() };
      try { await backend.put([['bytes', { id, data: bytes.slice(0) }], ['meta', meta]]); } catch (e) { throw wrap(e); }
      return { meta, buffer, duplicate: false };
    },
    async getMeta(id) { try { return await backend.get('meta', id); } catch (e) { throw wrap(e); } },
    /** original bytes (a fresh copy) or throws SampleError('missing' | 'corrupt') */
    async getBytes(id) {
      let rec;
      try { rec = await backend.get('bytes', id); } catch (e) { throw wrap(e); }
      if (!rec) throw new SampleError('missing', 'This sample is not stored on this device.');
      if (!(rec.data instanceof ArrayBuffer) || !rec.data.byteLength) throw new SampleError('corrupt', 'The stored sample data is damaged.');
      return rec.data;
    },
    async has(id) { try { return !!(await backend.get('meta', id)) && !!(await backend.get('bytes', id)); } catch (e) { return false; } },
    async list() { const ids = await backend.keys('meta'); return (await Promise.all(ids.map(id => backend.get('meta', id)))).filter(Boolean); },
    /** explicit deletion only; refuses ids still referenced (pass the referenced set, e.g. from the song library) */
    async remove(id, { referenced = new Set() } = {}) {
      if (referenced.has(id)) throw new SampleError('in-use', 'This sample is still used by a song.');
      await backend.del(id);
    },
  };
  return store;
}
