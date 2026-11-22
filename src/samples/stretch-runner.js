// Runs time-stretch renders off the audio path: in a module Worker when the browser has one (the scheduler and the
// UI never wait for it), otherwise on the main thread in small time slices (≈6 ms) so the 25 ms scheduler tick
// keeps running. Same maths either way (src/samples/stretch.js).
//
//   const runner = createStretchRunner();
//   const channels = await runner.run([left, right], sampleRate, factor, anchors);

import { stretchGen } from './stretch.js';

const SLICE_MS = 6;
const tickWait = () => new Promise(r => setTimeout(r, 0));

/** main-thread fallback: drive the generator in short slices */
export async function runSliced(channels, sampleRate, factor, anchors, { sliceMs = SLICE_MS, now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) } = {}) {
  const g = stretchGen(channels, sampleRate, factor, { anchors, yieldEvery: 8 });
  let r, t0 = now();
  for (;;) {
    r = g.next();
    if (r.done) return r.value;
    if (now() - t0 > sliceMs) { await tickWait(); t0 = now(); }
  }
}

export function createStretchRunner({ useWorker = true } = {}) {
  let worker = null, failed = !useWorker, seq = 0;
  const waiting = new Map();
  function getWorker() {
    if (failed || typeof Worker !== 'function') return null;
    if (worker) return worker;
    try {
      worker = new Worker(new URL('./stretch-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = e => { const w = waiting.get(e.data.id); if (!w) return; waiting.delete(e.data.id); if (e.data.error) w.rej(new Error(e.data.error)); else w.res(e.data.channels); };
      worker.onerror = e => { // module workers unsupported, blocked, or crashed: finish everything on the main thread
        failed = true; try { worker.terminate(); } catch (er) { /* */ } worker = null;
        for (const [id, w] of waiting) { waiting.delete(id); runSliced(w.input, w.sampleRate, w.factor, w.anchors).then(w.res, w.rej); }
        if (e && e.preventDefault) e.preventDefault();
      };
    } catch (e) { failed = true; worker = null; }
    return worker;
  }
  return {
    get mode() { return failed ? 'main' : worker ? 'worker' : 'idle'; },
    /** channels: Float32Array[] (copied; the caller's arrays are never transferred) */
    run(channels, sampleRate, factor, anchors = []) {
      const w = getWorker();
      if (!w) return runSliced(channels, sampleRate, factor, anchors); // read-only on the main thread: no copy
      const input = channels.map(c => c.slice()); // transferred to the worker
      return new Promise((res, rej) => {
        const id = ++seq;
        waiting.set(id, { res, rej, input: channels, sampleRate, factor, anchors }); // the caller's arrays, for a main-thread retry
        w.postMessage({ id, channels: input, sampleRate, factor, anchors }, input.map(c => c.buffer));
      });
    },
    dispose() { if (worker) worker.terminate(); worker = null; waiting.clear(); },
  };
}
