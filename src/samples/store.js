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
  /** code: empty | too-large | too-long | unsupported | quota | unavailable | storage | missing | corrupt | in-use | not-ready
   *        | permission | insecure | no-mic | mic-busy | mic-session | recording */
  constructor(code, message, cause) { super(message); this.name = 'SampleError'; this.code = code; this.cause = cause; }
}
const isQuota = e => !!e && (e.name === 'QuotaExceededError' || e.code === 22 || /quota/i.test(String(e.message)));
/** errors after which a fresh connection may succeed (Safari: "Connection to Indexed Database server lost") */
const isConnection = e => !!e && (['InvalidStateError', 'UnknownError', 'TransactionInactiveError', 'NotFoundError', 'AbortError'].includes(e.name)
  || /connection|server lost|closing|closed/i.test(String(e.message)));
const errName = e => (e && (e.name !== 'Error' ? e.name : e.message)) || 'Error';

/* ---------- backends ---------- */
export const DB_VERSION = 2; // v1 → v2 only adds missing object stores; existing samples are kept
const STORES = ['meta', 'bytes'];
/**
 * IndexedDB backend. Robust against the failure modes seen in Safari:
 *  - a connection that dies (storage process restarted, tab backgrounded): dropped and reopened, the operation is
 *    retried once (puts are idempotent: content-addressed ids)
 *  - a database whose object stores are missing (damaged or created by something else): stores are added by a
 *    version upgrade, never by deleting data
 *  - an open() that never answers: times out instead of hanging the import
 * Every failure is reported with the browser's error name and the phase (open / read / write) in `lastError`.
 */
export function indexedDbBackend(idb = globalThis.indexedDB, name = DB_NAME, { openTimeoutMs = 8000 } = {}) {
  let dbp = null;
  const backend = { lastError: null, reconnects: 0 };
  const fail = (phase, e) => { backend.lastError = { phase, name: errName(e), message: String((e && e.message) || e), at: new Date().toISOString() }; return e; };
  function openVersion(version) {
    return new Promise((res, rej) => {
      if (!idb) { rej(new SampleError('unavailable', 'This browser does not allow sample storage here (IndexedDB is unavailable).')); return; }
      let req, done = false;
      const timer = setTimeout(() => { if (!done) { done = true; rej(new SampleError('unavailable', 'Sample storage did not answer. Reload the page and try again.')); } }, openTimeoutMs);
      const finish = (fn, v) => { if (done) { if (v && v.close) try { v.close(); } catch (e) { /* */ } return; } done = true; clearTimeout(timer); fn(v); };
      try { req = version ? idb.open(name, version) : idb.open(name); } catch (e) { finish(rej, new SampleError('unavailable', `Sample storage could not be opened. [${errName(e)}]`, e)); return; }
      req.onupgradeneeded = () => { const db = req.result; for (const st of STORES) if (!db.objectStoreNames.contains(st)) db.createObjectStore(st, { keyPath: 'id' }); };
      req.onsuccess = () => finish(res, req.result);
      req.onerror = () => finish(rej, new SampleError('unavailable', `Sample storage could not be opened. [${errName(req.error)}]`, req.error));
      req.onblocked = () => finish(rej, new SampleError('unavailable', 'Sample storage is busy in another tab. Close it and try again.'));
    });
  }
  const open = () => dbp || (dbp = (async () => {
    let db = await openVersion(DB_VERSION).catch(async e => {
      // VersionError: a newer build upgraded the database; open whatever version it has
      if (e.cause && e.cause.name === 'VersionError') return openVersion(0);
      throw e;
    });
    if (STORES.some(st => !db.objectStoreNames.contains(st))) { const v = db.version + 1; db.close(); db = await openVersion(v); }
    db.onversionchange = () => { try { db.close(); } catch (e) { /* */ } dbp = null; };
    db.onclose = () => { dbp = null; }; // closed by the browser (storage server lost)
    return db;
  })().catch(e => { dbp = null; fail('open', e.cause || e); throw e; }));
  const reset = async () => { const p = dbp; dbp = null; if (p) { try { (await p).close(); } catch (e) { /* */ } } };
  const run = async (stores, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      let out, t;
      try { t = db.transaction(stores, mode); } catch (e) { rej(e); return; }
      t.oncomplete = () => res(out);
      t.onabort = t.onerror = () => rej(t.error || Object.assign(new Error('transaction failed'), { name: 'AbortError' }));
      try { out = fn(t); } catch (e) { try { t.abort(); } catch (er) { /* */ } rej(e); }
    });
  };
  /** one retry on a fresh connection for connection-type failures */
  const tx = async (stores, mode, fn) => {
    const phase = mode === 'readwrite' ? 'write' : 'read';
    try { return await run(stores, mode, fn); } catch (e) {
      if (e instanceof SampleError || isQuota(e) || !isConnection(e)) throw fail(phase, e);
      fail(phase, e); backend.reconnects++;
      await reset();
      try { return await run(stores, mode, fn); } catch (e2) { throw fail(phase, e2); }
    }
  };
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return Object.assign(backend, {
    async get(store, id) { let r; await tx([store], 'readonly', t => { r = req(t.objectStore(store).get(id)); }); return (await r) ?? null; },
    async keys(store) { let r; await tx([store], 'readonly', t => { r = req(t.objectStore(store).getAllKeys()); }); return (await r) || []; },
    /** atomic: every entry lands, or none does */
    async put(entries) { await tx([...new Set(entries.map(e => e[0]))], 'readwrite', t => { entries.forEach(([s, v]) => t.objectStore(s).put(v)); }); },
    async del(id) { await tx(['meta', 'bytes'], 'readwrite', t => { t.objectStore('meta').delete(id); t.objectStore('bytes').delete(id); }); },
    /** delete HarbuMatic's sample database only (explicit repair; the caller asks the user first) */
    async destroy() {
      await reset();
      await new Promise((res, rej) => {
        let r; try { r = idb.deleteDatabase(name); } catch (e) { rej(e); return; }
        r.onsuccess = () => res(); r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new SampleError('unavailable', 'Sample storage is open in another tab. Close it and try again.'));
      });
    },
  });
}

/**
 * In-memory backend for tests. quotaBytes simulates a full disk (puts that would exceed it fail like IndexedDB);
 * failures = [{ op: 'get' | 'put' | 'keys' | 'del', name, times }] simulates broken browser storage.
 */
export function memoryBackend({ quotaBytes = Infinity, failures = [] } = {}) {
  const db = { meta: new Map(), bytes: new Map() };
  const size = () => [...db.bytes.values()].reduce((a, v) => a + v.data.byteLength, 0);
  const copy = v => (v && v.data ? { ...v, data: v.data instanceof ArrayBuffer ? v.data.slice(0) : v.data } : v && { ...v });
  const backend = { db, failures, lastError: null, destroyed: 0 };
  const maybeFail = op => {
    const f = failures.find(x => x.op === op && x.times > 0);
    if (!f) return;
    f.times--;
    const e = new Error(f.message || `${f.name} (simulated)`); e.name = f.name;
    backend.lastError = { phase: op === 'put' || op === 'del' ? 'write' : 'read', name: f.name, message: e.message };
    throw e;
  };
  return Object.assign(backend, {
    async get(store, id) { maybeFail('get'); return copy(db[store].get(id)) ?? null; },
    async keys(store) { maybeFail('keys'); return [...db[store].keys()]; },
    async put(entries) {
      maybeFail('put');
      const add = entries.reduce((a, [s, v]) => a + (s === 'bytes' ? v.data.byteLength : 0), 0);
      if (size() + add > quotaBytes) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; }
      entries.forEach(([s, v]) => db[s].set(v.id, copy(v)));
    },
    async del(id) { maybeFail('del'); db.meta.delete(id); db.bytes.delete(id); },
    async destroy() { db.meta.clear(); db.bytes.clear(); failures.length = 0; backend.destroyed++; },
  });
}

/* ---------- store ---------- */
/**
 * @param backend   indexedDbBackend() | memoryBackend()
 * @param decode    (ArrayBuffer) → Promise<AudioBuffer-like { duration, sampleRate, numberOfChannels, length }>;
 *                  receives a copy (decodeAudioData detaches its input)
 *
 * Decoding and storing are separate steps with separate errors: a file the browser cannot read is refused
 * ('unsupported'), while a sample that decodes but cannot be written is still returned (stored: false) so it plays in
 * this session; its bytes wait in memory (`unsaved`) until retryUnsaved() or repair() can write them.
 */
export function createSampleStore({ backend = indexedDbBackend(), decode, limits = SAMPLE_LIMITS, now = () => new Date().toISOString() } = {}) {
  const pending = new Map(); // id → { meta, bytes } decoded fine but not written yet
  const wrap = (e, phase = 'write') => {
    if (e instanceof SampleError) return e;
    if (isQuota(e)) return new SampleError('quota', 'Not enough storage space on this device for this sample. Free some space or use a shorter sample.', e);
    return new SampleError('storage', `The sample could not be ${phase === 'read' ? 'read from' : 'saved in'} this browser’s storage. [${errName(e)} while ${phase === 'read' ? 'reading' : 'saving'}]`, e);
  };
  const write = (meta, bytes) => backend.put([['bytes', { id: meta.id, data: bytes.slice(0) }], ['meta', meta]]);
  const store = {
    limits,
    backend,
    /** ids that play in this session but are not saved on this device */
    unsaved: () => [...pending.keys()],
    isUnsaved: id => pending.has(id),
    /** last storage failure { phase, name, message } (for diagnostics) */
    lastError: () => backend.lastError || null,
    /**
     * Store a sample from raw bytes. Returns { meta, buffer, duplicate, stored, error } — buffer is the decoded audio
     * (hand it to the bank so it is not decoded twice), duplicate means the same bytes were already stored, stored
     * false means it could not be written (error says why) and plays from memory only.
     */
    async importBytes({ bytes, name = 'Sample', type = '' }, decodeWith = decode) {
      if (!bytes || !bytes.byteLength) throw new SampleError('empty', 'That file is empty.');
      if (bytes.byteLength > limits.maxBytes) throw new SampleError('too-large', `That file is too big (${Math.round(bytes.byteLength / 1048576)} MB). Samples can be up to ${Math.round(limits.maxBytes / 1048576)} MB.`);
      if (!decodeWith) throw new SampleError('not-ready', 'Audio is not started yet. Tap Play once, then try again.');
      const id = await sampleIdFor(bytes);
      let buffer;
      try { buffer = await decodeWith(bytes.slice(0)); } catch (e) { if (e instanceof SampleError) throw e; throw new SampleError('unsupported', `“${name}” is not an audio format this browser can read. Try WAV, MP3 or M4A. [${errName(e)}]`, e); }
      if (!buffer || !(buffer.duration > 0) || !buffer.length) throw new SampleError('unsupported', `“${name}” holds no audio.`);
      if (buffer.duration > limits.maxSeconds + .05) throw new SampleError('too-long', `“${name}” is ${buffer.duration.toFixed(1)} s long. Samples can be up to ${limits.maxSeconds} s.`);
      let existing = null;
      try { existing = await backend.get('meta', id); if (existing && !(await backend.get('bytes', id))) existing = null; } catch (e) { existing = null; } // unreadable: try to write anyway
      if (existing) { pending.delete(id); return { meta: existing, buffer, duplicate: true, stored: true, error: null }; }
      const meta = { id, name: String(name).slice(0, 80) || 'Sample', type: String(type || ''), size: bytes.byteLength, duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, frames: buffer.length, created: now() };
      try { await write(meta, bytes); pending.delete(id); return { meta, buffer, duplicate: false, stored: true, error: null }; }
      catch (e) { pending.set(id, { meta, bytes: bytes.slice(0) }); return { meta, buffer, duplicate: false, stored: false, error: wrap(e) }; }
    },
    /** try to write samples that could not be saved before; returns { saved: [ids], failed: [ids], error } */
    async retryUnsaved() {
      const saved = [], failed = []; let error = null;
      for (const [id, { meta, bytes }] of [...pending]) {
        try { await write(meta, bytes); pending.delete(id); saved.push(id); } catch (e) { failed.push(id); error = wrap(e); }
      }
      return { saved, failed, error };
    },
    /**
     * Explicit repair (the UI asks the user first): read every sample that can still be read, delete only
     * HarbuMatic's sample database, recreate it and write back what was read plus the unsaved samples.
     * Returns { kept, lost, saved, failed, error }.
     */
    async repair() {
      const rescued = new Map();
      let ids = [];
      try { ids = await backend.keys('meta'); } catch (e) { ids = []; }
      for (const id of ids) {
        try { const meta = await backend.get('meta', id), b = await backend.get('bytes', id); if (meta && b && b.data instanceof ArrayBuffer && b.data.byteLength) rescued.set(id, { meta, bytes: b.data }); } catch (e) { /* unreadable: lost */ }
      }
      for (const [id, v] of pending) if (!rescued.has(id)) rescued.set(id, v);
      await backend.destroy();
      const saved = [], failed = []; let error = null;
      for (const [id, { meta, bytes }] of rescued) {
        try { await write(meta, bytes); pending.delete(id); saved.push(id); } catch (e) { failed.push(id); error = wrap(e); pending.set(id, { meta, bytes }); }
      }
      return { kept: saved.length, lost: ids.filter(id => !rescued.has(id)).length, saved, failed, error };
    },
    async getMeta(id) { if (pending.has(id)) return pending.get(id).meta; try { return await backend.get('meta', id); } catch (e) { throw wrap(e, 'read'); } },
    /** original bytes (a fresh copy) or throws SampleError('missing' | 'corrupt' | 'storage') */
    async getBytes(id) {
      if (pending.has(id)) return pending.get(id).bytes.slice(0);
      let rec;
      try { rec = await backend.get('bytes', id); } catch (e) { throw wrap(e, 'read'); }
      if (!rec) throw new SampleError('missing', 'This sample is not stored on this device.');
      if (!(rec.data instanceof ArrayBuffer) || !rec.data.byteLength) throw new SampleError('corrupt', 'The stored sample data is damaged.');
      return rec.data;
    },
    async has(id) { try { return !!(await backend.get('meta', id)) && !!(await backend.get('bytes', id)); } catch (e) { return false; } },
    async list() { const ids = await backend.keys('meta'); return (await Promise.all(ids.map(id => backend.get('meta', id)))).filter(Boolean); },
    /** explicit deletion only; refuses ids still referenced (pass the referenced set, e.g. from the song library) */
    async remove(id, { referenced = new Set() } = {}) {
      if (referenced.has(id)) throw new SampleError('in-use', 'This sample is still used by a song.');
      pending.delete(id);
      await backend.del(id);
    },
  };
  return store;
}
