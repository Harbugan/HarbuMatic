// Sample bank: decoded, ready-to-play AudioBuffers in memory, on top of the durable sample store.
//
//   store (IndexedDB, original bytes)  ──load/decode──▶  bank (AudioBuffers, bounded LRU)  ──buffer()──▶  voice
//
// - Decoding happens here only, never in a scheduler callback: voices call buffer(id) synchronously and get
//   null until the sample is ready (they stay silent; the UI shows the state).
// - Reversed playback uses a reversed copy, built once by prepare(id, true) (from voice.apply / after loading).
// - Memory is bounded: decoded buffers (and reversed copies) count length × channels × 4 bytes against
//   `budgetBytes`. The least recently used unpinned sample is evicted first; samples the current song uses are
//   pinned and never evicted (they may exceed the budget; the per-sample limits keep that bounded).
// - Every id has an explicit state: idle | loading | ready | missing | error (+ a message), and listeners are told
//   about every change.

import { createSampleStore, SampleError } from './store.js';
import { computePeaks } from './peaks.js';

export const DEFAULT_BUDGET = 96 * 1024 * 1024;
const bytesOf = b => (b ? b.length * b.numberOfChannels * 4 : 0);

/** decodeAudioData with the promise form, falling back to the callback form (older Safari) */
export function decodeWith(ctx) {
  return ab => new Promise((res, rej) => {
    try { const r = ctx.decodeAudioData(ab, res, rej); if (r && typeof r.then === 'function') r.then(res, rej); } catch (e) { rej(e); }
  });
}

/**
 * @param store        createSampleStore(...) (durable assets)
 * @param budgetBytes  soft limit for decoded audio kept in memory
 * @param decode       optional decoder; by default the bank decodes with the AudioContext given to attach()
 */
export function createSampleBank({ store = createSampleStore(), budgetBytes = DEFAULT_BUDGET, decode = null } = {}) {
  let ctx = null, decoder = decode;
  const entries = new Map();   // id → { status, error, buffer, reversed, promise, used }
  const pinned = new Set();
  const listeners = new Set();
  let clock = 0;
  const waitCtx = [];
  const entry = id => { if (!entries.has(id)) entries.set(id, { status: 'idle', error: null, buffer: null, reversed: null, peaks: null, promise: null, used: 0 }); return entries.get(id); };
  const notify = id => listeners.forEach(fn => { try { fn(id, bank.state(id)); } catch (e) { /* listener error */ } });

  function evict() {
    let total = bank.usage();
    if (total <= budgetBytes) return;
    const order = [...entries.entries()].filter(([id, e]) => e.status === 'ready' && !pinned.has(id) && !(store.isUnsaved && store.isUnsaved(id))) // unsaved samples exist only here.sort((a, b) => a[1].used - b[1].used);
    for (const [id, e] of order) {
      if (total <= budgetBytes) break;
      total -= bytesOf(e.buffer) + bytesOf(e.reversed);
      entries.delete(id); notify(id); // back to idle: the next load decodes it again from the store
    }
  }
  function reverseOf(buf) {
    const make = ctx ? (c, l, r) => ctx.createBuffer(c, l, r) : null;
    if (!make) return null;
    const out = make(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let c = 0; c < buf.numberOfChannels; c++) { const src = buf.getChannelData(c), dst = out.getChannelData(c), n = src.length; for (let i = 0; i < n; i++) dst[i] = src[n - 1 - i]; }
    return out;
  }
  function decodeBytes(ab) {
    if (decoder) return decoder(ab);
    return new Promise((res, rej) => waitCtx.push(() => decoder(ab).then(res, rej))); // decoded as soon as audio starts
  }

  const bank = {
    store,
    /** the playback AudioContext (engine.init): decoding into it avoids a second resampling step */
    attach(c) { if (ctx === c) return; ctx = c; if (!decode) decoder = decodeWith(c); waitCtx.splice(0).forEach(f => f()); },
    get attached() { return !!ctx; },
    decode: ab => decodeBytes(ab),
    state(id) { const e = entries.get(id); return e ? { status: e.status, error: e.error } : { status: 'idle', error: null }; },
    /** decoded buffer (or its reversed copy) when ready, else null. Never decodes; cheap enough for scheduler time. */
    buffer(id, reverse = false) {
      const e = entries.get(id); if (!e || e.status !== 'ready') return null;
      e.used = ++clock;
      if (!reverse) return e.buffer;
      if (!e.reversed) { e.reversed = reverseOf(e.buffer); evict(); } // normally built ahead by prepare()
      return e.reversed;
    },
    /** waveform peaks of the forward buffer (computed once and cached with the buffer), or null until ready */
    peaks(id) {
      const e = entries.get(id); if (!e || e.status !== 'ready' || !e.buffer) return null;
      if (!e.peaks) e.peaks = computePeaks(e.buffer);
      return e.peaks;
    },
    /** build the reversed copy ahead of playback (no-op until the sample is ready) */
    prepare(id, reverse = false) { if (reverse) bank.buffer(id, true); },
    /** load + decode one sample from the store; resolves with the buffer, or null (state says why). Concurrent calls share one load. */
    load(id) {
      const e = entry(id);
      if (e.status === 'ready') { e.used = ++clock; return Promise.resolve(e.buffer); }
      if (e.promise) return e.promise;
      e.status = 'loading'; e.error = null; notify(id);
      e.promise = (async () => {
        try {
          const bytes = await store.getBytes(id);
          const buf = await decodeBytes(bytes);
          if (!buf || !buf.length) throw new SampleError('corrupt', 'The stored sample could not be decoded.');
          Object.assign(e, { status: 'ready', buffer: buf, reversed: null, peaks: null, error: null, used: ++clock });
          evict();
          return buf;
        } catch (err) {
          const code = err instanceof SampleError ? err.code : 'corrupt';
          Object.assign(e, { status: code === 'missing' ? 'missing' : 'error', error: err instanceof SampleError ? err.message : 'The stored sample could not be decoded.', buffer: null, reversed: null });
          return null;
        } finally { e.promise = null; if (entries.get(id) === e) notify(id); }
      })();
      return e.promise;
    },
    /** import bytes into the store and keep the decoded audio, so it is ready to play at once */
    async importBytes(file) {
      const r = await store.importBytes(file, decoder ? decodeBytes : null); // no AudioContext yet → SampleError('not-ready')
      const e = entry(r.meta.id);
      Object.assign(e, { status: 'ready', buffer: r.buffer, reversed: null, peaks: null, error: null, used: ++clock, promise: null });
      evict(); notify(r.meta.id);
      return r;
    },
    /** keep these ids decoded (the current song's samples) and start loading them */
    pin(ids) {
      pinned.clear(); ids.forEach(id => pinned.add(id));
      evict();
      return Promise.all(ids.map(id => bank.load(id)));
    },
    pinnedIds: () => [...pinned],
    /** wait (bounded) until none of these ids is loading — used before the transport starts */
    async whenSettled(ids, timeoutMs = 2000) {
      const pending = ids.map(id => entries.get(id)).filter(e => e && e.promise).map(e => e.promise);
      if (!pending.length) return true;
      let timer;
      const done = await Promise.race([Promise.all(pending).then(() => true), new Promise(r => { timer = setTimeout(() => r(false), timeoutMs); })]);
      clearTimeout(timer);
      return done;
    },
    isLoading: ids => ids.some(id => { const e = entries.get(id); return !!(e && e.promise); }),
    /** bytes of decoded audio held in memory */
    usage() { let t = 0; for (const e of entries.values()) t += bytesOf(e.buffer) + bytesOf(e.reversed); return t; },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  return bank;
}
