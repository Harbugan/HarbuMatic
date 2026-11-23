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
// - Stretch fit mode: time-stretched copies (pitch kept) are rendered off the audio path by the stretch runner
//   (Worker, or time-sliced main thread) and kept per sample (at most STRETCH_KEEP, counted in the memory budget).
//   stretched() never renders: it returns the closest copy (or null = play the original with tape timing) and queues
//   the exact render, so the scheduler is never blocked and the timing is always right.

import { createSampleStore, SampleError } from './store.js';
import { computePeaks } from './peaks.js';
import { anchorsFromSlices } from './stretch.js';
import { createStretchRunner } from './stretch-runner.js';

export const DEFAULT_BUDGET = 96 * 1024 * 1024;
export const STRETCH_KEEP = 2;
/** renders are made for factors on a 0.001 grid (≤ 0.2 % off; the residual is played as rate, so timing stays exact) */
export const quantizeStretch = f => Math.max(.001, Math.round(f * 1000) / 1000);
const sliceKey = slices => (Array.isArray(slices) ? slices.join(',') : '');
const bytesOf = b => (b ? b.length * b.numberOfChannels * 4 : 0);
const stretchBytes = e => (e.stretch || []).reduce((a, r) => a + bytesOf(r.buffer) + bytesOf(r.reversed), 0);

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
export function createSampleBank({ store = createSampleStore(), budgetBytes = DEFAULT_BUDGET, decode = null, runner = null, stretchDelayMs = 60 } = {}) {
  const stretcher = runner || createStretchRunner();
  const stretchJobs = new Map(); // id → { timer, want: { factor, slices }, running: Promise | null }
  let ctx = null, decoder = decode;
  const entries = new Map();   // id → { status, error, buffer, reversed, promise, used }
  const pinned = new Set();
  const listeners = new Set();
  let clock = 0;
  const waitCtx = [];
  const entry = id => { if (!entries.has(id)) entries.set(id, { status: 'idle', error: null, buffer: null, reversed: null, peaks: null, promise: null, used: 0, stretch: [] }); return entries.get(id); };
  const notify = id => listeners.forEach(fn => { try { fn(id, bank.state(id)); } catch (e) { /* listener error */ } });

  function evict() {
    let total = bank.usage();
    if (total <= budgetBytes) return;
    const order = [...entries.entries()].filter(([id, e]) => e.status === 'ready' && !pinned.has(id) && !(store.isUnsaved && store.isUnsaved(id))) // unsaved samples exist only here.sort((a, b) => a[1].used - b[1].used);
    for (const [id, e] of order) {
      if (total <= budgetBytes) break;
      total -= bytesOf(e.buffer) + bytesOf(e.reversed) + stretchBytes(e);
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

  async function runStretch(id) {
    const job = stretchJobs.get(id); if (!job) return;
    job.timer = 0;
    if (job.running) { job.timer = setTimeout(() => runStretch(id), stretchDelayMs); return; } // one render per sample at a time
    const e = entries.get(id), want = job.want;
    if (!e || e.status !== 'ready' || !want) { stretchJobs.delete(id); return; }
    const src = e.buffer, chans = Array.from({ length: src.numberOfChannels }, (_, c) => src.getChannelData(c));
    job.want = null;
    job.running = (async () => {
      try {
        const out = await stretcher.run(chans, src.sampleRate, want.factor, anchorsFromSlices(want.slices, src.length));
        if (entries.get(id) !== e || e.buffer !== src || !ctx) return; // sample changed or evicted meanwhile
        const buf = ctx.createBuffer(out.length, out[0].length, src.sampleRate);
        out.forEach((d, c) => buf.getChannelData(c).set(d));
        const r = { factor: want.factor, key: want.key, buffer: buf, reversed: null, used: ++clock };
        if (want.reverse) r.reversed = reverseOf(buf);
        e.stretch = [...e.stretch.filter(x => !(x.key === r.key && Math.abs(x.factor - r.factor) < 1e-9)), r]
          .sort((a, b) => b.used - a.used).slice(0, STRETCH_KEEP);
        evict(); notify(id);
      } catch (err) { /* render failed: playback keeps using the original with tape timing */ }
    })();
    await job.running;
    job.running = null;
    if (job.want && !job.timer) job.timer = setTimeout(() => runStretch(id), 0);
    else if (!job.want && !job.timer) stretchJobs.delete(id);
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
          Object.assign(e, { status: 'ready', buffer: buf, reversed: null, peaks: null, error: null, used: ++clock, stretch: [] });
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
      Object.assign(e, { status: 'ready', buffer: r.buffer, reversed: null, peaks: null, error: null, used: ++clock, promise: null, stretch: [] });
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
    usage() { let t = 0; for (const e of entries.values()) t += bytesOf(e.buffer) + bytesOf(e.reversed) + stretchBytes(e); return t; },
    /**
     * The time-stretched copy closest to `factor` (output/input duration, pitch kept), or null when only the original
     * is available. Returns { buffer, stretch } — stretch is the factor the copy was rendered for, so the caller plays
     * it at rate stretch / factor for an exact duration. Queues the exact render when it is missing. Never renders.
     */
    stretched(id, reverse, factor, slices) {
      const e = entries.get(id); if (!e || e.status !== 'ready' || !(factor > 0)) return null;
      const key = sliceKey(slices), want = quantizeStretch(factor);
      let best = null, bestErr = Math.abs(Math.log(factor)) + 1e-12; // the original (factor 1) is the fallback
      for (const r of e.stretch) {
        const err = Math.abs(Math.log(factor / r.factor));
        if (err < bestErr - 1e-9 || (best && err <= bestErr + 1e-9 && r.key === key && best.key !== key)) { best = r; bestErr = err; }
      }
      if (!best || best.key !== key || Math.abs(best.factor - want) > 1e-9) bank.requestStretch(id, factor, slices);
      if (!best) return null;
      best.used = ++clock;
      if (!reverse) return { buffer: best.buffer, stretch: best.factor };
      if (!best.reversed) { best.reversed = reverseOf(best.buffer); evict(); } // normally built right after the render
      return best.reversed ? { buffer: best.reversed, stretch: best.factor } : null;
    },
    /** queue a stretched render (debounced per sample; the latest request wins); `reverse` also prepares its reversed copy */
    requestStretch(id, factor, slices, reverse = false) {
      if (!(factor > 0) || Math.abs(factor - 1) < 1e-6) return;
      const e = entries.get(id); if (!e || e.status !== 'ready') return;
      const key = sliceKey(slices), want = quantizeStretch(factor);
      const have = e.stretch.find(r => r.key === key && Math.abs(r.factor - want) < 1e-9);
      if (have) { if (reverse && !have.reversed) { have.reversed = reverseOf(have.buffer); evict(); } return; }
      const job = stretchJobs.get(id) || { timer: 0, want: null, running: null };
      job.want = { factor: want, key, slices: Array.isArray(slices) ? slices.slice() : [], reverse: !!reverse || !!(job.want && job.want.reverse && job.want.key === key) };
      stretchJobs.set(id, job);
      clearTimeout(job.timer);
      job.timer = setTimeout(() => runStretch(id), stretchDelayMs);
    },
    /** 'none' | 'pending' (render queued or running) | 'ready' — for the UI */
    stretchState(id, factor, slices) {
      const e = entries.get(id), job = stretchJobs.get(id);
      if (e && e.stretch.some(r => r.key === sliceKey(slices) && Math.abs(r.factor - quantizeStretch(factor)) < 1e-9)) return 'ready';
      return job && (job.timer || job.running) ? 'pending' : 'none';
    },
    /** resolves when no stretch render is queued or running (tests, the UI before playing) */
    async stretchIdle() {
      for (let guard = 0; guard < 50; guard++) {
        const busy = [...stretchJobs.values()].filter(j => j.timer || j.running);
        if (!busy.length) return;
        await Promise.all(busy.map(j => j.running || new Promise(r => setTimeout(r, stretchDelayMs + 5))));
      }
    },
    get stretchMode() { return stretcher.mode; },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  return bank;
}
