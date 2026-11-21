// Microphone recording for MUNCH (MediaRecorder). The recording is kept in the format the browser records
// (WebM/Opus in Chromium, MP4/AAC in Safari, Ogg/Opus in Firefox) and goes through the normal sample import.
//
//   const rec = createRecorder();  await rec.start();  …  const file = await rec.stop();   // or rec.cancel()
//
// Microphone tracks are always stopped when recording ends, is cancelled, fails or hits the time limit, so the
// browser's recording indicator goes off. Permission denial and missing hardware give a SampleError.

import { SampleError } from './store.js';

const TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];
const EXT = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav' };

/** can this browser record audio at all? */
export const canRecord = (env = globalThis) => !!(env.navigator && env.navigator.mediaDevices && env.navigator.mediaDevices.getUserMedia && env.MediaRecorder);

/**
 * @param maxSeconds  recording stops by itself after this long (keeps samples within the import limit)
 * @param env         globalThis-like object (navigator, MediaRecorder) — replaceable in tests
 */
export function createRecorder({ maxSeconds = 30, env = globalThis, onState = () => {} } = {}) {
  let stream = null, rec = null, chunks = [], timer = 0, t0 = 0, state = 'idle', finish = null;
  const set = s => { state = s; onState(s); };
  function cleanup() {
    clearTimeout(timer); timer = 0;
    if (stream) { stream.getTracks().forEach(t => { try { t.stop(); } catch (e) { /* gone */ } }); stream = null; }
    rec = null; chunks = [];
  }
  const api = {
    get state() { return state; },
    elapsed: () => (state === 'recording' ? (Date.now() - t0) / 1000 : 0),
    async start() {
      if (state !== 'idle') return;
      if (!canRecord(env)) throw new SampleError('unsupported', 'Recording is not supported in this browser.');
      set('starting');
      try {
        stream = await env.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      } catch (e) {
        cleanup(); set('idle');
        const n = e && e.name;
        if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') throw new SampleError('permission', 'Microphone access was denied. Allow it in the browser settings to record.', e);
        if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError') throw new SampleError('no-mic', 'No microphone was found.', e);
        throw new SampleError('recording', 'The microphone could not be started.', e);
      }
      if (state !== 'starting') { cleanup(); return; } // cancelled while the permission prompt was open
      const MR = env.MediaRecorder;
      const type = TYPES.find(t => MR.isTypeSupported && MR.isTypeSupported(t));
      try { rec = new MR(stream, type ? { mimeType: type } : undefined); } catch (e) { cleanup(); set('idle'); throw new SampleError('recording', 'Recording could not start.', e); }
      chunks = [];
      rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        const mime = (rec && rec.mimeType) || type || 'audio/webm', cb = finish; finish = null;
        const blob = new Blob(chunks, { type: mime });
        cleanup(); set('idle');
        if (cb) cb(blob, mime);
      };
      rec.onerror = () => { const cb = finish; finish = null; cleanup(); set('idle'); if (cb) cb(null); };
      rec.start(250);
      t0 = Date.now(); set('recording');
      timer = setTimeout(() => { if (state === 'recording') rec.stop(); }, maxSeconds * 1000);
    },
    /** stop and return { bytes, type, name }; resolves null when nothing was recorded */
    stop() {
      if (state !== 'recording' || !rec) return Promise.resolve(null);
      set('stopping');
      return new Promise((res, rej) => {
        finish = async (blob, mime) => {
          if (!blob || !blob.size) { res(null); return; }
          try {
            const base = String(mime).split(';')[0], d = new Date(), pad = n => String(n).padStart(2, '0');
            res({ bytes: await blob.arrayBuffer(), type: base, name: `Recording ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}.${EXT[base] || 'audio'}` });
          } catch (e) { rej(new SampleError('recording', 'The recording could not be read.', e)); }
        };
        try { rec.stop(); } catch (e) { finish = null; cleanup(); set('idle'); res(null); }
      });
    },
    /** throw the recording away (also used when the page is hidden) */
    cancel() {
      if (state === 'idle') return;
      finish = null;
      try { if (rec && rec.state !== 'inactive') { rec.onstop = null; rec.stop(); } } catch (e) { /* gone */ }
      cleanup(); set('idle');
    },
  };
  return api;
}
