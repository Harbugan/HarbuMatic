// MUNCH microphone recording (v0.6 stabilization, BUGS.md MUNCH-1): audio-session switching, constraint fallback,
// error mapping, lifecycle and cleanup. Runs against a fake browser environment that behaves like WebKit on iPadOS:
// with navigator.audioSession.type === 'playback', getUserMedia rejects with InvalidStateError before any prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder, pickMimeType, recordSupport, micError, RAW_CONSTRAINTS } from '../src/samples/recorder.js';
import { createAudioSession, captureAllowed } from '../src/audio/session.js';

const quiet = () => {};

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

/** a fake iPad/WebKit (or Chromium with webkit=false) environment */
function fakeEnv({ webkit = true, deny = null, rejectRawWith = null, secure = true, mrTypes = ['audio/mp4', 'audio/webm;codecs=opus'], mrThrowsOnStart = false } = {}) {
  const env = { isSecureContext: secure, calls: [], streams: [], recorders: [] };
  const session = webkit ? { type: 'auto' } : null;
  const track = () => ({ stopped: false, onended: null, stop() { this.stopped = true; } });
  const mediaDevices = {
    async getUserMedia(c) {
      env.calls.push({ constraints: c, session: session && session.type });
      if (session && !captureAllowed(session.type)) throw Object.assign(new Error('Capture is not allowed in this audio session'), { name: 'InvalidStateError' });
      if (deny) throw Object.assign(new Error(deny), { name: deny });
      if (rejectRawWith && typeof c.audio === 'object') throw Object.assign(new Error(rejectRawWith), { name: rejectRawWith });
      const t = track(), s = { tracks: [t], getTracks: () => [t] };
      env.streams.push(s);
      return s;
    },
  };
  env.navigator = { userAgent: webkit ? 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', mediaDevices };
  if (session) env.navigator.audioSession = session;
  class FakeMR {
    static isTypeSupported(t) { return mrTypes.includes(t); }
    constructor(stream, opts) { this.stream = stream; this.mimeType = (opts && opts.mimeType) || 'audio/mp4'; this.state = 'inactive'; env.recorders.push(this); }
    start(slice) { if (mrThrowsOnStart) throw Object.assign(new Error('nope'), { name: 'NotSupportedError' }); this.slice = slice; this.state = 'recording'; }
    stop() {
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      setTimeout(() => { this.onstop && this.onstop(); setTimeout(() => {}, 0); }, 1);
      // Safari sometimes delivers the data right after 'stop' — the recorder must still pick it up
      setTimeout(() => { if (this.ondataavailable) this.ondataavailable({ data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: this.mimeType }) }); }, 1);
    }
    fail(name) { this.onerror && this.onerror({ error: Object.assign(new Error(name), { name }) }); }
  }
  env.MediaRecorder = FakeMR;
  return env;
}

test('reproduces the iPad failure: under the "playback" audio session getUserMedia fails before any prompt', async () => {
  const env = fakeEnv();
  env.navigator.audioSession.type = 'playback'; // what engine.init() sets so audio plays through the silent switch
  const inert = { type: 'playback', capture() {}, release() {}, playback() {} }; // the v0.6 Phase 4 behaviour: no switch
  const rec = createRecorder({ log: quiet, env, session: inert });
  await assert.rejects(rec.start(), e => e.code === 'mic-session' && /InvalidStateError/.test(e.message));
  assert.equal(rec.state, 'idle');
  assert.ok(env.calls.every(c => c.session === 'playback'));
});

test('RECORD switches the session to play-and-record before getUserMedia and restores "playback" afterwards', async () => {
  const env = fakeEnv(), session = createAudioSession(() => env.navigator);
  session.playback();
  assert.equal(env.navigator.audioSession.type, 'playback');
  const states = [];
  const rec = createRecorder({ log: quiet, env, session, onState: s => states.push(s) });
  await rec.start();
  assert.equal(rec.state, 'recording');
  assert.equal(env.calls[0].session, 'play-and-record');
  assert.deepEqual(env.calls[0].constraints, RAW_CONSTRAINTS);
  assert.equal(env.navigator.audioSession.type, 'play-and-record');
  const out = await rec.stop();
  assert.ok(out && out.bytes.byteLength === 4, 'the late Safari data chunk is part of the file');
  assert.equal(out.type, 'audio/mp4');
  assert.match(out.name, /^Recording .*\.m4a$/);
  assert.equal(env.recorders[0].slice, undefined, 'no timeslice: one complete file');
  assert.ok(env.streams[0].tracks.every(t => t.stopped), 'microphone released');
  assert.equal(env.navigator.audioSession.type, 'playback', 'playback session restored');
  assert.deepEqual(states, ['starting', 'recording', 'stopping', 'idle']);
});

test('subsequent recordings work and each releases its microphone', async () => {
  const env = fakeEnv(), session = createAudioSession(() => env.navigator);
  session.playback();
  const rec = createRecorder({ log: quiet, env, session });
  for (let i = 0; i < 3; i++) {
    await rec.start();
    const out = await rec.stop();
    assert.ok(out && out.bytes.byteLength > 0, `recording ${i + 1}`);
    assert.equal(env.navigator.audioSession.type, 'playback');
  }
  assert.equal(env.streams.length, 3);
  assert.ok(env.streams.every(s => s.tracks.every(t => t.stopped)));
});

test('constraints fall back from raw audio to { audio: true }', async () => {
  const env = fakeEnv({ rejectRawWith: 'OverconstrainedError' });
  const rec = createRecorder({ log: quiet, env });
  await rec.start();
  assert.equal(rec.state, 'recording');
  assert.equal(env.calls.length, 2);
  assert.deepEqual(env.calls[1].constraints, { audio: true });
  const d = rec.diagnostics();
  assert.deepEqual(d.attempts.map(a => [a.constraints, a.ok]), [['raw', false], ['basic', true]]);
  rec.cancel();
  assert.ok(env.streams[0].tracks[0].stopped);
});

test('a permission refusal is never retried (no second prompt) and gives an actionable message', async () => {
  const env = fakeEnv({ deny: 'NotAllowedError' }), session = createAudioSession(() => env.navigator);
  session.playback();
  const rec = createRecorder({ log: quiet, env, session });
  await assert.rejects(rec.start(), e => e.code === 'permission' && /Website Settings/.test(e.message) && /NotAllowedError/.test(e.message));
  assert.equal(env.calls.length, 1);
  assert.equal(rec.state, 'idle');
  assert.equal(env.navigator.audioSession.type, 'playback', 'session restored after a failure');
  assert.equal(rec.diagnostics().error.name, 'NotAllowedError');
});

test('error names map to clear messages and keep the browser error name', () => {
  const m = n => micError(Object.assign(new Error('x'), { name: n }));
  assert.equal(m('NotFoundError').code, 'no-mic');
  assert.equal(m('NotReadableError').code, 'mic-busy');
  assert.equal(m('AbortError').code, 'mic-busy');
  assert.equal(m('SecurityError').code, 'insecure');
  assert.equal(m('InvalidStateError').code, 'mic-session');
  assert.equal(m('WeirdError').code, 'recording');
  assert.match(m('WeirdError').message, /\[WeirdError\]/);
});

test('busy microphone: retried once with basic constraints, then a clear message', async () => {
  const env = fakeEnv({ deny: 'NotReadableError' });
  const rec = createRecorder({ log: quiet, env });
  await assert.rejects(rec.start(), e => e.code === 'mic-busy');
  assert.equal(env.calls.length, 2);
});

test('insecure pages and missing APIs are explained, not reported as a broken microphone', async () => {
  const env = fakeEnv({ secure: false });
  delete env.navigator.mediaDevices; // browsers hide mediaDevices outside secure contexts
  assert.deepEqual(recordSupport(env), { ok: false, reason: 'insecure' });
  await assert.rejects(createRecorder({ log: quiet, env }).start(), e => e.code === 'insecure');
  const env2 = fakeEnv(); delete env2.MediaRecorder;
  assert.deepEqual(recordSupport(env2), { ok: false, reason: 'unsupported' });
});

test('format: MP4 on WebKit, WebM/Opus on Chromium', () => {
  assert.equal(pickMimeType(fakeEnv()), 'audio/mp4');
  assert.equal(pickMimeType(fakeEnv({ webkit: false })), 'audio/webm;codecs=opus');
  assert.equal(pickMimeType(fakeEnv({ mrTypes: [] })), undefined);
});

test('cancel while the permission prompt is open releases the microphone once it arrives', async () => {
  const env = fakeEnv();
  let release;
  const gum = env.navigator.mediaDevices.getUserMedia;
  env.navigator.mediaDevices.getUserMedia = c => new Promise(r => { release = () => r(gum(c)); });
  const rec = createRecorder({ log: quiet, env });
  const p = rec.start();
  assert.equal(rec.state, 'starting');
  rec.cancel();
  assert.equal(rec.state, 'idle');
  release(); await p;
  assert.equal(rec.state, 'idle');
  assert.ok(env.streams[0].tracks[0].stopped);
});

test('the time limit stops the recording and keeps it', async () => {
  const env = fakeEnv();
  let got = null;
  const rec = createRecorder({ log: quiet, env, maxSeconds: .02, onAutoStop: (r, why) => { got = { r, why }; } });
  await rec.start();
  await tick(60);
  assert.ok(got && got.r && got.r.bytes.byteLength > 0);
  assert.equal(got.why, 'limit');
  assert.equal(rec.state, 'idle');
  assert.ok(env.streams[0].tracks[0].stopped);
});

test('the system taking the microphone away (call, other app) keeps the recording so far', async () => {
  const env = fakeEnv();
  let got = null;
  const rec = createRecorder({ log: quiet, env, onAutoStop: (r, why) => { got = { r, why }; } });
  await rec.start();
  env.streams[0].tracks[0].onended();
  await tick(20);
  assert.equal(got.why, 'ended');
  assert.ok(got.r && got.r.bytes.byteLength > 0);
  assert.equal(rec.state, 'idle');
});

test('a MediaRecorder error ends the recording, releases resources and rejects stop()', async () => {
  const env = fakeEnv(), session = createAudioSession(() => env.navigator);
  session.playback();
  const rec = createRecorder({ log: quiet, env, session });
  await rec.start();
  const p = rec.stop();
  env.recorders[0].onstop = null; // the error arrives instead of a normal stop
  env.recorders[0].fail('UnknownError');
  await assert.rejects(p, e => e.code === 'recording' && /UnknownError/.test(e.message));
  assert.equal(rec.state, 'idle');
  assert.ok(env.streams[0].tracks[0].stopped);
  assert.equal(env.navigator.audioSession.type, 'playback');
});

test('MediaRecorder.start failing releases the microphone', async () => {
  const env = fakeEnv({ mrThrowsOnStart: true });
  const rec = createRecorder({ log: quiet, env });
  await assert.rejects(rec.start(), e => e.code === 'recording');
  assert.equal(rec.state, 'idle');
  assert.ok(env.streams[0].tracks[0].stopped);
});

test('browsers without the Audio Session API record unchanged', async () => {
  const env = fakeEnv({ webkit: false });
  const rec = createRecorder({ log: quiet, env });
  await rec.start();
  assert.equal(rec.state, 'recording');
  const out = await rec.stop();
  assert.ok(out);
  assert.equal(createAudioSession(() => env.navigator).supported, false);
});
