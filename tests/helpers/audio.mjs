// Test helpers: WAV bytes generator and a small fake Web Audio context (Node has no Web Audio).
// The fake records what the code under test asks for (start/stop times, playback rate, gain automation,
// connections) and fires `onended` when the virtual clock passes a source's stop time.

/** a PCM WAV file as an ArrayBuffer: 16-bit int (default) or 32-bit float; a sine at `freq` (or a ramp when freq = 0) */
export function makeWav({ seconds = 1, rate = 44100, channels = 1, freq = 440, float = false } = {}) {
  const frames = Math.round(seconds * rate), bps = float ? 4 : 2, data = frames * channels * bps;
  const buf = new ArrayBuffer(44 + data), v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + data, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, float ? 3 : 1, true); v.setUint16(22, channels, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * bps, true); v.setUint16(32, channels * bps, true); v.setUint16(34, bps * 8, true);
  str(36, 'data'); v.setUint32(40, data, true);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
    const x = freq ? Math.sin(2 * Math.PI * freq * i / rate) * .5 : i / frames; const o = 44 + (i * channels + c) * bps;
    if (float) v.setFloat32(o, x, true); else v.setInt16(o, Math.round(x * 32767), true);
  }
  return buf;
}

export class FakeBuffer {
  constructor(channels, length, sampleRate) { this.numberOfChannels = channels; this.length = length; this.sampleRate = sampleRate; this.data = Array.from({ length: channels }, () => new Float32Array(length)); }
  get duration() { return this.length / this.sampleRate; }
  getChannelData(c) { return this.data[c]; }
}

/** decode a PCM WAV (16-bit int or 32-bit float) like decodeAudioData would; rejects anything else */
export function decodeWav(ab) {
  const v = new DataView(ab), tag = o => String.fromCharCode(...new Uint8Array(ab, o, 4));
  if (ab.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return Promise.reject(Object.assign(new Error('Unable to decode audio data'), { name: 'EncodingError' }));
  const fmt = v.getUint16(20, true), ch = v.getUint16(22, true), rate = v.getUint32(24, true), bits = v.getUint16(34, true), size = v.getUint32(40, true);
  const bps = bits / 8, frames = Math.floor(Math.min(size, ab.byteLength - 44) / (ch * bps));
  if (!frames || !(fmt === 1 && bits === 16) && !(fmt === 3 && bits === 32)) return Promise.reject(Object.assign(new Error('Unable to decode audio data'), { name: 'EncodingError' }));
  const b = new FakeBuffer(ch, frames, rate);
  for (let i = 0; i < frames; i++) for (let c = 0; c < ch; c++) { const o = 44 + (i * ch + c) * bps; b.data[c][i] = fmt === 3 ? v.getFloat32(o, true) : v.getInt16(o, true) / 32768; }
  return Promise.resolve(b);
}

function param(value = 0) {
  const p = { value, events: [] };
  for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime', 'cancelScheduledValues']) p[m] = (...a) => { p.events.push([m, ...a]); return p; };
  return p;
}

export function createFakeContext({ sampleRate = 48000 } = {}) {
  const ctx = { currentTime: 0, sampleRate, state: 'running', sources: [], live: new Set() };
  const node = kind => {
    const n = { kind, out: [], connect(d) { n.out.push(d); return d; }, disconnect() { n.out = []; n.disconnected = true; }, start() {}, stop() {} };
    return new Proxy(n, { get: (o, k) => (k in o ? o[k] : typeof k === 'string' && !['then', 'onended'].includes(k) ? (o[k] = param()) : undefined) });
  };
  ctx.destination = node('destination');
  ctx.createBuffer = (c, l, r) => new FakeBuffer(c, l, r);
  ctx.createGain = () => { const g = node('gain'); g.gain = param(1); return g; };
  ctx.createBufferSource = () => {
    const s = node('source');
    Object.assign(s, { buffer: null, loop: false, loopStart: 0, loopEnd: 0, playbackRate: param(1), startArgs: null, stopAt: null, ended: false, onended: null });
    s.start = (t = 0, offset = 0, dur) => { if (s.startArgs) throw new Error('InvalidStateError: start called twice'); s.startArgs = [t, offset, dur]; ctx.live.add(s); };
    s.stop = (t = 0) => { if (!s.startArgs) throw new Error('InvalidStateError: stop before start'); s.stopAt = t; };
    ctx.sources.push(s);
    return s;
  };
  for (const k of ['BiquadFilter', 'WaveShaper', 'StereoPanner', 'DynamicsCompressor', 'Analyser', 'Convolver', 'Delay', 'Oscillator', 'ConstantSource']) ctx[`create${k}`] = () => node(k);
  ctx.decodeAudioData = ab => decodeWav(ab);
  ctx.resume = () => Promise.resolve();
  /** move the clock; sources whose stop time has passed end (onended fires once) */
  ctx.advance = t => {
    ctx.currentTime = t;
    for (const s of [...ctx.live]) if (s.stopAt != null && s.stopAt <= t) { ctx.live.delete(s); s.ended = true; if (s.onended) s.onended(); }
  };
  return ctx;
}

/** install a fake window.AudioContext for createEngine().init(); returns the context it will create */
export async function withFakeWindow(fn) {
  const had = 'window' in globalThis, old = globalThis.window;
  let made = null;
  globalThis.window = { AudioContext: function () { made = createFakeContext(); return made; } };
  try { return await fn(() => made); } finally { if (had) globalThis.window = old; else delete globalThis.window; }
}
