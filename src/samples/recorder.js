// Microphone recording for MUNCH (MediaRecorder). The recording is kept in the format the browser records
// (MP4/AAC in Safari and every iPad browser, WebM/Opus in Chromium, Ogg/Opus in Firefox) and goes through the normal
// sample import.
//
//   const rec = createRecorder({ onAutoStop });  await rec.start();  …  const file = await rec.stop();   // or rec.cancel()
//
// Lifecycle (state):  idle → starting → recording → stopping → idle
//   - start() must be called from the tap itself: it switches the Audio Session to capture (WebKit refuses the
//     microphone under the 'playback' session HarbuMatic normally uses, see src/audio/session.js) and calls
//     getUserMedia synchronously.
//   - Constraints fall back progressively: first raw audio (no echo cancellation / noise suppression / AGC, best for
//     a sampler), then plain { audio: true }. Permission denial is never retried, so the user is never re-prompted.
//   - The time limit and a microphone that the system takes away (a call, another app) stop the recording and KEEP
//     it: the result goes to onAutoStop(result, reason).
//   - Microphone tracks are stopped and the session type restored whenever recording ends, is cancelled, fails or is
//     interrupted, so the browser's recording indicator always goes off.
// Errors are SampleErrors with an actionable message; the browser's own error name is kept in `diagnostics()` and in
// the message (in brackets) so a test on a device without developer tools can still tell what happened.

import { SampleError } from './store.js';
import { createAudioSession } from '../audio/session.js';

const EXT = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/aac': 'aac' };
/** WebKit records MP4/AAC natively and decodes it reliably; it may also claim WebM, which it cannot always decode */
const TYPES_WEBKIT = ['audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm'];
const TYPES_OTHER = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
export const RAW_CONSTRAINTS = Object.freeze({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
export const BASIC_CONSTRAINTS = Object.freeze({ audio: true });

const isWebKit = env => {
  const n = env.navigator || {}, ua = String(n.userAgent || '');
  return !!n.audioSession || (/AppleWebKit/.test(ua) && !/(Chrome|Chromium|Edg)\//.test(ua));
};
/** the MediaRecorder type to ask for (undefined = browser default) */
export function pickMimeType(env = globalThis) {
  const MR = env.MediaRecorder;
  if (!MR || typeof MR.isTypeSupported !== 'function') return undefined;
  return (isWebKit(env) ? TYPES_WEBKIT : TYPES_OTHER).find(t => { try { return MR.isTypeSupported(t); } catch (e) { return false; } });
}

/** can this page record? { ok, reason: 'insecure' | 'unsupported' | null } */
export function recordSupport(env = globalThis) {
  const md = env.navigator && env.navigator.mediaDevices;
  if (md && typeof md.getUserMedia === 'function' && env.MediaRecorder) return { ok: true, reason: null };
  if (env.isSecureContext === false) return { ok: false, reason: 'insecure' };
  return { ok: false, reason: 'unsupported' };
}
/** can this browser record audio at all? */
export const canRecord = (env = globalThis) => recordSupport(env).ok;

const DENIED = ['NotAllowedError', 'PermissionDeniedError'];
/** a getUserMedia rejection → SampleError with a message the player can act on */
export function micError(e) {
  const n = (e && e.name) || 'Error', tag = ` [${n}]`;
  if (DENIED.includes(n)) return new SampleError('permission', 'Microphone access is blocked for this page. Allow the microphone in the browser’s website settings (iPad Safari: aA › Website Settings › Microphone), then tap RECORD again.' + tag, e);
  if (n === 'SecurityError') return new SampleError('insecure', 'This page may not use the microphone. Open HarbuMatic directly over https (not inside another page).' + tag, e);
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError') return new SampleError('no-mic', 'No usable microphone was found.' + tag, e);
  if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return new SampleError('mic-busy', 'The microphone is busy or blocked by the system. End calls or close apps that use it, then try again.' + tag, e);
  if (n === 'InvalidStateError') return new SampleError('mic-session', 'The browser would not open the microphone in its current audio mode. Reload the page and tap RECORD again.' + tag, e);
  return new SampleError('recording', 'The microphone could not be started.' + tag, e);
}

/**
 * @param maxSeconds   recording stops by itself after this long (keeps samples within the import limit)
 * @param env          globalThis-like object (navigator, MediaRecorder, isSecureContext) — replaceable in tests
 * @param session      audio session controller (src/audio/session.js)
 * @param onAutoStop   (result | null, reason: 'limit' | 'ended') → a recording that stopped by itself
 */
export function createRecorder({ maxSeconds = 30, env = globalThis, onState = () => {}, onAutoStop = () => {}, session = null, now = () => Date.now(), log = (...a) => { if (typeof console !== 'undefined') console.warn(...a); } } = {}) {
  const ses = session || createAudioSession(() => env.navigator);
  let stream = null, rec = null, chunks = [], timer = 0, t0 = 0, state = 'idle', finish = null, mime = '';
  let diag = null;
  const set = s => { state = s; try { onState(s); } catch (e) { /* listener error */ } };
  function cleanup() {
    clearTimeout(timer); timer = 0;
    if (stream) { stream.getTracks().forEach(t => { t.onended = null; try { t.stop(); } catch (e) { /* gone */ } }); stream = null; }
    if (rec) { rec.ondataavailable = rec.onstop = rec.onerror = null; }
    rec = null; chunks = [];
    ses.release();
  }
  function fileName(base) {
    const d = new Date(now()), pad = n => String(n).padStart(2, '0');
    return `Recording ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}.${EXT[base] || 'audio'}`;
  }
  /** stop the MediaRecorder and resolve with { bytes, type, name } (null when nothing was recorded) */
  function finishRecording() {
    if (state !== 'recording' || !rec) return Promise.resolve(null);
    set('stopping');
    return new Promise((res, rej) => {
      finish = { res, rej };
      try { rec.stop(); } catch (e) { finish = null; cleanup(); set('idle'); res(null); }
    });
  }
  function auto(reason) {
    if (state !== 'recording') return;
    finishRecording().then(r => onAutoStop(r, reason), e => onAutoStop(null, reason, e));
  }
  async function acquire() {
    const md = env.navigator.mediaDevices;
    let last = null;
    for (const [label, c] of [['raw', RAW_CONSTRAINTS], ['basic', BASIC_CONSTRAINTS]]) {
      try {
        const s = await md.getUserMedia(c);
        diag.attempts.push({ constraints: label, ok: true });
        return s;
      } catch (e) {
        last = e;
        diag.attempts.push({ constraints: label, ok: false, name: (e && e.name) || 'Error', message: String((e && e.message) || e) });
        // never retry a refusal (it would prompt again or fail the same way)
        if (e && (DENIED.includes(e.name) || e.name === 'SecurityError' || e.name === 'NotFoundError')) break;
        if (state !== 'starting') break; // cancelled meanwhile
      }
    }
    throw last;
  }

  const api = {
    get state() { return state; },
    elapsed: () => (state === 'recording' ? (now() - t0) / 1000 : 0),
    /** what happened on the last start (constraints tried, errors, session type, format) — for development */
    diagnostics: () => diag && JSON.parse(JSON.stringify(diag)),
    async start() {
      if (state !== 'idle') return;
      const sup = recordSupport(env);
      diag = { at: new Date(now()).toISOString(), secure: env.isSecureContext !== false, sessionBefore: ses.type, attempts: [], mime: null, error: null };
      if (!sup.ok) {
        const e = sup.reason === 'insecure'
          ? new SampleError('insecure', 'Recording needs a secure page: open HarbuMatic over https.')
          : new SampleError('unsupported', 'Recording is not supported in this browser.');
        diag.error = { code: e.code };
        throw e;
      }
      set('starting');
      ses.capture(); // synchronous, still inside the tap: WebKit refuses capture under the 'playback' session
      diag.sessionDuring = ses.type;
      try {
        stream = await acquire();
      } catch (e) {
        const err = micError(e);
        diag.error = { code: err.code, name: e && e.name, message: String((e && e.message) || e) };
        log('[HarbuMatic] microphone', diag);
        cleanup(); set('idle');
        throw err;
      }
      if (state !== 'starting') { cleanup(); return; } // cancelled while the permission prompt was open
      const MR = env.MediaRecorder, type = pickMimeType(env);
      try { rec = type ? new MR(stream, { mimeType: type }) : new MR(stream); }
      catch (e) {
        try { rec = new MR(stream); } catch (e2) {
          diag.error = { code: 'recording', name: e2 && e2.name, message: String((e2 && e2.message) || e2) };
          cleanup(); set('idle');
          throw new SampleError('recording', `Recording could not start. [${(e2 && e2.name) || 'Error'}]`, e2);
        }
      }
      mime = rec.mimeType || type || '';
      diag.mime = mime || '(browser default)';
      chunks = [];
      const r = rec;
      r.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      r.onstop = () => {
        // Safari can deliver the last data chunk right after 'stop': collect it on the next tick
        setTimeout(() => {
          const type2 = (r.mimeType || mime || 'audio/mp4'), got = chunks.slice(), f = finish; finish = null;
          cleanup(); set('idle');
          if (!f) return;
          const blob = new Blob(got, { type: type2 });
          if (!blob.size) { f.res(null); return; }
          const base = String(type2).split(';')[0];
          blob.arrayBuffer().then(bytes => f.res({ bytes, type: base, name: fileName(base) }), e => f.rej(new SampleError('recording', 'The recording could not be read.', e)));
        }, 0);
      };
      r.onerror = ev => {
        const e = (ev && ev.error) || ev, f = finish; finish = null;
        diag.error = { code: 'recording', name: e && e.name, message: String((e && e.message) || e) };
        cleanup(); set('idle');
        if (f) f.rej(new SampleError('recording', `Recording failed. [${(e && e.name) || 'Error'}]`, e));
      };
      // the system can take the microphone away (call, Siri, another app): keep what was recorded
      stream.getTracks().forEach(t => { t.onended = () => auto('ended'); });
      try { r.start(); } catch (e) { // no timeslice: one complete file on stop (fragmented MP4 chunks trip some decoders)
        cleanup(); set('idle');
        throw new SampleError('recording', `Recording could not start. [${(e && e.name) || 'Error'}]`, e);
      }
      t0 = now(); set('recording');
      timer = setTimeout(() => auto('limit'), maxSeconds * 1000);
    },
    /** stop and return { bytes, type, name }; resolves null when nothing was recorded */
    stop: () => finishRecording(),
    /** throw the recording away (also used when the page is hidden) */
    cancel() {
      if (state === 'idle') return;
      const f = finish; finish = null;
      try { if (rec && rec.state !== 'inactive') { rec.onstop = null; rec.stop(); } } catch (e) { /* gone */ }
      cleanup(); set('idle');
      if (f) f.res(null);
    },
  };
  return api;
}
