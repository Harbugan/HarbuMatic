// Voice factories: the synthesis of each instrument type, one factory per registry `engine` id.
//
// A factory builds one voice for one instrument instance (slot), so two slots of the same type get
// independent state (mono oscillator, LFO, open-hat choke, crusher). Synthesis is unchanged from v0.5;
// only the per-type state moved from the engine into these closures.
//
//   factory({ ctx, shared, channel, params, sample }) → {
//     input             node the session gate (or an audition) feeds; usually channel.bus
//     apply(p, now)     type-specific parameter changes (the engine handles the shared channel strip)
//     trigger(t, hit, dest)   play one hit at audio time t; dest = node a new voice connects to
//                       drum hit:  { d: drumId, v }      note hit: { p, v, dur, slideIn, slideOut }
//     silence(now)      stop sustained sound (mono voices); polyphonic voices end on their own
//     dispose()         release long-running nodes when the slot goes away
//   }
//   shared = { noise: AudioBuffer, voices: { count }, samples: SampleBank | null }
//            (the synth polyphony budget is shared by all synth slots; MUNCH has its own bounded pool)
//   sample() → the slot's sample reference (src/core/samples.js), for sampler voices
//
// MUNCH (createMunchVoice) plays samples. Decoding and storage stay outside: the voice only asks the sample
// bank (src/samples/bank.js) for an already decoded AudioBuffer when a hit is due, and stays silent when the
// buffer is not ready. The scheduler dispatches its hits exactly as it does for the synths.

import { sliceRegion, trimRegion, bufferRegion, rateForSemitones, noteSemitones, fitPlayback, defaultSlices, barsSeconds } from '../core/samples.js';
import {
  resolveBreakDesc, isImportedBreakId, breakFitPlayback, breakSlicesOf, clampBreakSlice, laneAudibleLevel, laneVolKey,
} from '../core/breaks.js';

export const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
export const cutHz = v => 50 * Math.pow(2, v * 8.4); // 0..1 → 50 Hz .. ~17 kHz

function crushCurve(amt) {
  const n = 4096, c = new Float32Array(n), steps = Math.pow(2, 16 - amt * 13);
  for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.round(x * steps) / steps; }
  return c;
}

export const MAX_POLY = 18;
export const CUT = .006; // fade when a voice is cut (retrigger, choke, steal, stop)

/**
 * Shared polyphony pool for polyphonic synth voices (BLIP, FUZZ).
 * Tracks every active voice (scheduled, auditioned and held) instead of relying solely on `onended`,
 * so disconnecting a session gate on Pause/Stop (WebKit/iPad) can never leak the voice counter and
 * permanently silence BLIP/FUZZ playback or manual audition.
 */
function synthPool(shared) {
  if (!shared.voices.pool) shared.voices.pool = new Set();
  return shared.voices.pool;
}
function trackSynthVoice(shared, h) {
  if (h.tracked) return;
  const pool = synthPool(shared);
  h.tracked = true;
  pool.add(h);
  shared.voices.count = pool.size;
}
function untrackSynthVoice(shared, h) {
  if (!h.tracked) return;
  h.tracked = false;
  const pool = synthPool(shared);
  pool.delete(h);
  shared.voices.count = pool.size;
}
function claimSynthVoice(shared, now, at) {
  const pool = synthPool(shared);
  for (const old of [...pool]) {
    if (old.stopAt <= now) old.finish();
  }
  while (pool.size >= MAX_POLY) {
    const oldest = pool.values().next().value;
    if (!oldest) break;
    oldest.cut(Math.max(at, now));
  }
}

/* ---------- BOP: drum synthesis ---------- */
function createBopVoice({ ctx, shared, channel, params }) {
  let ohh = null; // open hat currently ringing (a closed hat chokes it)
  function trigger(t, hit, dest) {
    const id = hit.d, vel = hit.v;
    const p = params(), tune = Math.pow(2, p.tune / 12), dec = p.decay, tone = p.tone, kit = p.kit;
    const out = ctx.createGain(); out.gain.value = vel; out.connect(dest);
    const env = (node, peak, d, a = .001) => { const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(.0001, t + a + d); node.connect(g); g.connect(out); return g; };
    const osc = (type, f) => { const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); return o; };
    const noise = () => { const s = ctx.createBufferSource(); s.buffer = shared.noise; return s; };
    const filt = (type, f, q = .7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    const run = (src, d) => { src.start(t, src.buffer ? Math.random() * .8 : undefined); src.stop(t + d + .1); };
    switch (id) {
      case 'kick': {
        const o = osc('sine', (kit === '909' ? 210 : 160) * tune);
        o.frequency.exponentialRampToValueAtTime((kit === '909' ? 52 : 44) * tune, t + (kit === '909' ? .045 : .08));
        const d = (kit === '808' ? .75 : .38) * dec; env(o, 1.05, d); run(o, d);
        if (kit !== '808') { const n = noise(), f = filt('highpass', 2500); n.connect(f); env(f, .35, .012); run(n, .03); }
        break;
      }
      case 'snare': {
        const o = osc('triangle', 190 * tune); o.frequency.exponentialRampToValueAtTime(150 * tune, t + .06);
        env(o, .55, .1 * dec); run(o, .15 * dec);
        const n = noise(), f = filt(kit === '909' ? 'highpass' : 'bandpass', 1200 + tone * 3500, .8); n.connect(f);
        const d = (kit === '909' ? .2 : .16) * dec; env(f, .7, d); run(n, d); break;
      }
      case 'clap': {
        const n = noise(), f = filt('bandpass', 1000 + tone * 900, 1.3); n.connect(f);
        const g = ctx.createGain(); g.gain.setValueAtTime(0, t);
        [0, .011, .022].forEach(o => { g.gain.setValueAtTime(.9, t + o); g.gain.exponentialRampToValueAtTime(.08, t + o + .009); });
        g.gain.setValueAtTime(.8, t + .031); g.gain.exponentialRampToValueAtTime(.0001, t + .031 + .2 * dec);
        f.connect(g); g.connect(out); run(n, .3 * dec); break;
      }
      case 'chh': case 'ohh': {
        if (id === 'chh' && ohh) { try { ohh.gain.cancelScheduledValues(t); ohh.gain.setTargetAtTime(0, t, .008); } catch (e) { /* ended */ } ohh = null; }
        const n = noise(), f = filt('highpass', 6000 + tone * 4000), f2 = filt('peaking', 9000, 1); f2.gain.value = 5; n.connect(f); f.connect(f2);
        const d = (id === 'chh' ? .05 : .32) * dec * (kit === '909' ? 1.2 : 1);
        const g = env(f2, id === 'chh' ? .42 : .36, d); run(n, d); if (id === 'ohh') ohh = g; break;
      }
      case 'tom': { const o = osc('sine', 150 * tune); o.frequency.exponentialRampToValueAtTime(92 * tune, t + .18); env(o, .85, .38 * dec); run(o, .4 * dec); break; }
      case 'rim': { const o = osc('triangle', 1700 * tune), f = filt('bandpass', 1900, 3); o.connect(f); env(f, .9, .03); run(o, .05); break; }
      case 'cow': {
        const f = filt('bandpass', 900 * tune, 2.5);
        [540, 800].forEach(fr => { const o = osc('square', fr * tune); o.connect(f); run(o, .3 * dec); });
        env(f, .45, .22 * dec); break;
      }
    }
  }
  return {
    input: channel.bus,
    apply(p, now) { channel.color.frequency.setTargetAtTime(p.kit === 'lofi' ? 5200 : 20000, now, .02); },
    trigger, silence() {}, dispose() {},
  };
}

/* ---------- GOO: 303-style mono acid ---------- */
function createGooVoice({ ctx, channel, params }) {
  const G = v => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const b = { osc: ctx.createOscillator(), f1: ctx.createBiquadFilter(), f2: ctx.createBiquadFilter(), amp: G(0) };
  let activeToken = null;
  b.f1.type = b.f2.type = 'lowpass'; b.f2.Q.value = .5;
  // the mono voice runs continuously and feeds the channel directly; the engine silences it on stop
  b.osc.connect(b.f1); b.f1.connect(b.f2); b.f2.connect(b.amp); b.amp.connect(channel.bus); b.osc.start();
  function trigger(t, hit) {
    const midi = hit.p, dur = hit.dur, vel = hit.v, slideIn = !!hit.slideIn, slideOut = !!hit.slideOut;
    const p = params(), f = mtof(midi), acc = vel > .9;
    const level = .32 * (acc ? 1.25 : .75 + vel * .2);
    if (slideIn) b.osc.frequency.setTargetAtTime(f, t, Math.max(.008, p.glide / 3));
    else {
      b.osc.frequency.setValueAtTime(f, t);
      const base = cutHz(p.cutoff), peak = Math.min(base * Math.pow(2, p.env * 4.2 * (acc ? 1 + p.accent * .6 : 1)), 15000);
      const dcy = (.04 + p.decay * .9) * (acc ? .55 : 1);
      b.f1.frequency.cancelScheduledValues(t); b.f1.frequency.setValueAtTime(peak, t); b.f1.frequency.setTargetAtTime(base, t + .003, dcy / 3);
      b.f2.frequency.cancelScheduledValues(t); b.f2.frequency.setValueAtTime(Math.min(peak * 1.5, 18000), t); b.f2.frequency.setTargetAtTime(base * 1.5, t + .003, dcy / 3);
      b.amp.gain.cancelScheduledValues(t); b.amp.gain.setTargetAtTime(level, t, .0025); b.amp.gain.setTargetAtTime(level * .55, t + .03, .5);
    }
    if (!slideOut) b.amp.gain.setTargetAtTime(0, t + dur, .012);
    const token = { t };
    activeToken = token;
    return token;
  }
  function release(token, at = ctx.currentTime) {
    if (!token || token !== activeToken) return false;
    activeToken = null;
    const from = Math.max(at, ctx.currentTime, token.t);
    b.amp.gain.cancelScheduledValues(from);
    b.amp.gain.setTargetAtTime(0, from, .012);
    return true;
  }
  return {
    input: channel.bus,
    apply(p, now) { b.osc.type = p.wave; b.f1.Q.setTargetAtTime(.7 + p.res * 21, now, .02); },
    trigger, release,
    silence(now) {
      activeToken = null;
      [b.amp.gain, b.osc.frequency, b.f1.frequency, b.f2.frequency].forEach(prm => prm.cancelScheduledValues(now));
      b.amp.gain.setTargetAtTime(0, now, .01);
    },
    dispose() { activeToken = null; try { b.osc.stop(); b.amp.disconnect(); } catch (e) { /* gone */ } },
  };
}

/* ---------- BLIP: poly subtractive synth ---------- */
function createBlipVoice({ ctx, shared, channel, params }) {
  const lfo = ctx.createOscillator(), lfoG = ctx.createGain(); lfoG.gain.value = 0;
  const active = new Set();
  lfo.connect(lfoG); lfo.start();
  function disconnectLfo(h) {
    if (h.lfoDisconnected) return;
    h.lfoDisconnected = true;
    try { lfoG.disconnect(h.fl.detune); } catch (e) { /* gone */ }
  }
  function finish(h) {
    if (h.done) return;
    h.done = true;
    h.released = true;
    active.delete(h);
    untrackSynthVoice(shared, h);
    disconnectLfo(h);
    try { h.amp.disconnect(); } catch (e) { /* gone */ }
  }
  function cut(h, at = ctx.currentTime) {
    if (!h || h.done) return false;
    h.released = true;
    active.delete(h);
    untrackSynthVoice(shared, h);
    disconnectLfo(h);
    const cur = ctx.currentTime;
    const when = Math.max(at, cur, h.t);
    const beforeStart = at <= h.t && cur < h.t;
    const stopAt = beforeStart ? h.t + .001 : when + CUT + .02;
    h.stopAt = Math.min(h.stopAt, stopAt);
    try {
      if (beforeStart) {
        h.amp.gain.cancelScheduledValues(cur);
        h.amp.gain.setValueAtTime(0, cur);
      } else {
        h.amp.gain.cancelScheduledValues(when);
        h.amp.gain.setTargetAtTime(0, when, CUT / 3);
      }
    } catch (e) { /* gone */ }
    try { h.o1.stop(stopAt); } catch (e) { /* already stopped */ }
    try { h.o2.stop(stopAt); } catch (e) { /* already stopped */ }
    return true;
  }
  function release(h, at = ctx.currentTime) {
    if (!h || h.released || h.done) return false;
    h.released = true;
    const from = Math.max(at, ctx.currentTime, h.t);
    const stopAt = from + h.R * 1.6 + .05;
    h.stopAt = Math.min(h.stopAt, stopAt);
    try {
      h.amp.gain.cancelScheduledValues(from);
      h.amp.gain.setTargetAtTime(0, from, h.R / 3.5);
    } catch (e) { /* already stopped */ }
    try { h.o1.stop(stopAt); } catch (e) { /* already stopped */ }
    try { h.o2.stop(stopAt); } catch (e) { /* already stopped */ }
    return true;
  }
  function trigger(t, hit, dest) {
    const midi = hit.p, dur = hit.dur, vel = hit.v;
    claimSynthVoice(shared, ctx.currentTime, t);
    const p = params(), f = mtof(midi);
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g1 = ctx.createGain(), g2 = ctx.createGain();
    const fl = ctx.createBiquadFilter(), amp = ctx.createGain(); amp.gain.value = 0;
    o1.type = p.wave1; o2.type = p.wave2; o1.frequency.value = f; o2.frequency.value = f * Math.pow(2, p.oct2); o1.detune.value = -p.detune / 2; o2.detune.value = p.detune / 2;
    g1.gain.value = 1 - p.mix; g2.gain.value = p.mix;
    fl.type = 'lowpass'; fl.Q.value = .5 + p.res * 14;
    const base = cutHz(p.cutoff), peak = Math.min(base * Math.pow(2, p.fenv * 4), 18000);
    fl.frequency.setValueAtTime(peak, t); fl.frequency.setTargetAtTime(base, t + p.attack, p.decay / 2.5);
    lfoG.connect(fl.detune);
    const pk = .22 * (.35 + vel * .65), A = Math.max(.003, p.attack), R = Math.max(.02, p.release);
    amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(pk, t + A);
    amp.gain.setTargetAtTime(pk * p.sustain, t + A, p.decay / 3);
    const end = Math.max(t + dur, t + A); amp.gain.cancelScheduledValues(end); amp.gain.setTargetAtTime(0, end, R / 3.5);
    o1.connect(g1); o2.connect(g2); g1.connect(fl); g2.connect(fl); fl.connect(amp); amp.connect(dest);
    const stopAt = end + R * 1.6 + .05;
    const h = { amp, fl, o1, o2, R, t, stopAt, released: false, done: false, tracked: false, lfoDisconnected: false };
    h.finish = () => finish(h);
    h.cut = at => cut(h, at);
    o1.onended = h.finish;
    o1.start(t); o2.start(t); o1.stop(stopAt); o2.stop(stopAt);
    active.add(h);
    trackSynthVoice(shared, h);
    return h;
  }
  return {
    input: channel.bus,
    apply(p, now) { lfo.frequency.setTargetAtTime(p.lfoRate, now, .05); lfoG.gain.setTargetAtTime(p.lfoDepth * 2400, now, .05); },
    trigger, release,
    silence(now) { for (const h of [...active]) cut(h, now); active.clear(); },
    dispose() { for (const h of [...active]) cut(h, ctx.currentTime); active.clear(); try { lfo.stop(); lfoG.disconnect(); } catch (e) { /* gone */ } },
    activeCount: () => active.size,
  };
}

/* ---------- FUZZ: airy texture voice ---------- */
function createFuzzVoice({ ctx, shared, channel, params }) {
  const crush = ctx.createWaveShaper(); crush.connect(channel.bus);
  const active = new Set();
  function finish(h) {
    if (h.done) return;
    h.done = true;
    h.released = true;
    active.delete(h);
    untrackSynthVoice(shared, h);
    try { h.amp.disconnect(); } catch (e) { /* gone */ }
  }
  function cut(h, at = ctx.currentTime) {
    if (!h || h.done) return false;
    h.released = true;
    active.delete(h);
    untrackSynthVoice(shared, h);
    const cur = ctx.currentTime;
    const when = Math.max(at, cur, h.t);
    const beforeStart = at <= h.t && cur < h.t;
    const stopAt = beforeStart ? h.t + .001 : when + CUT + .02;
    h.stopAt = Math.min(h.stopAt, stopAt);
    try {
      if (beforeStart) {
        h.amp.gain.cancelScheduledValues(cur);
        h.amp.gain.setValueAtTime(0, cur);
      } else {
        h.amp.gain.cancelScheduledValues(when);
        h.amp.gain.setTargetAtTime(0, when, CUT / 3);
      }
    } catch (e) { /* gone */ }
    h.nodes.forEach(x => { try { x.stop(stopAt); } catch (e) { /* gone */ } });
    return true;
  }
  function release(h, at = ctx.currentTime) {
    if (!h || h.released || h.done) return false;
    h.released = true;
    const from = Math.max(at, ctx.currentTime, h.t);
    const stopAt = from + h.R * 1.6 + .05;
    h.stopAt = Math.min(h.stopAt, stopAt);
    try {
      h.amp.gain.cancelScheduledValues(from);
      h.amp.gain.setTargetAtTime(0, from, h.R / 3.5);
    } catch (e) { /* already stopped */ }
    h.nodes.forEach(x => { try { x.stop(stopAt); } catch (e) { /* gone */ } });
    return true;
  }
  function trigger(t, hit, dest) {
    const midi = hit.p, dur = hit.dur, vel = hit.v;
    claimSynthVoice(shared, ctx.currentTime, t);
    const p = params(), f = mtof(midi);
    const o = ctx.createOscillator(), o2 = ctx.createOscillator(), n = ctx.createBufferSource(), nf = ctx.createBiquadFilter(), ng = ctx.createGain(), g2 = ctx.createGain();
    const lp = ctx.createBiquadFilter(), amp = ctx.createGain(), trem = ctx.createOscillator(), tremG = ctx.createGain(); amp.gain.value = 0;
    o.type = 'sine'; o.frequency.value = f; o2.type = 'triangle'; o2.frequency.value = f * 2.003; g2.gain.value = .25 + p.shimmer * .3;
    n.buffer = shared.noise; n.loop = true; nf.type = 'bandpass'; nf.frequency.value = f * 2; nf.Q.value = 4; ng.gain.value = p.noise * 2.2;
    lp.type = 'lowpass'; lp.frequency.value = 400 + p.tone * 9000; lp.Q.value = 1.5;
    trem.frequency.value = 3 + p.shimmer * 6; tremG.gain.value = p.shimmer * .5;
    const pk = .2 * (.4 + vel * .6), A = .02 + p.attack * 1.5, R = .1 + p.release;
    amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(pk, t + A);
    const end = Math.max(t + dur, t + A); amp.gain.setTargetAtTime(0, end, R / 3.5);
    const vca = ctx.createGain(); vca.gain.value = 1; trem.connect(tremG); tremG.connect(vca.gain);
    o.connect(lp); o2.connect(g2); g2.connect(lp); n.connect(nf); nf.connect(ng); ng.connect(lp); lp.connect(vca); vca.connect(amp); amp.connect(dest);
    const stopAt = end + R * 1.6 + .05;
    const h = { amp, nodes: [o, o2, trem, n], R, t, stopAt, released: false, done: false, tracked: false };
    h.finish = () => finish(h);
    h.cut = at => cut(h, at);
    o.onended = h.finish;
    [o, o2, trem].forEach(x => { x.start(t); x.stop(stopAt); }); n.start(t, Math.random()); n.stop(stopAt);
    active.add(h);
    trackSynthVoice(shared, h);
    return h;
  }
  return {
    input: crush,
    apply(p) { crush.curve = p.crush > .02 ? crushCurve(p.crush) : null; },
    trigger, release,
    silence(now) { for (const h of [...active]) cut(h, now); active.clear(); },
    dispose() { for (const h of [...active]) cut(h, ctx.currentTime); active.clear(); try { crush.disconnect(); } catch (e) { /* gone */ } },
    activeCount: () => active.size,
  };
}

/* ---------- MUNCH: sample playback ---------- */
// One AudioBufferSourceNode + one gain envelope per hit. A note plays a region of the decoded sample (the trimmed
// region for melodic notes, slice k for slice notes, or an explicit region for editor auditions), mirrored inside the
// reversed copy when `reverse` is on.
//
// Playback rate and buffer (see fitPlayback in src/core/samples.js):
//   Tape     rate = pitch (transpose + tune) × fit rate: speed and pitch move together
//   Stretch  the bank's time-stretched copy of the sample (pitch kept) at rate = pitch × a tiny residual that makes the
//            duration exact; until that copy is rendered the voice falls back to tape so the timing never drifts
//
// Play modes:
//   oneshot  plays the whole region, whatever the note length
//   gate     stops at the note end / key or pad release (with the release) or at the region end, whichever is first
//   loop     loops the region while the note (key, pad) is held, then releases
// Voice ownership and retrigger (v0.6 stabilization, BUGS.md MUNCH-3):
//   every voice has a key — 's<k>' slice k, 'n<p>' melodic pitch p, 'a' editor audition. A new hit with the same key
//   cuts the previous one (a pad or key retriggers instead of piling up); different keys stay polyphonic.
//   choke (param, default on): a slice hit also cuts every other slice still sounding — one chop at a time.
// Cuts are click-free: the envelope is held at its current value and ramped to 0 over CUT seconds, at the exact time
// of the new hit. The envelope always reaches 0 at the region end, so a slice never runs into its neighbour. Every
// source is stopped at a known time and disconnected in `onended`; the pool is bounded (oldest voice is stolen).
// silence() (Pause, Stop — also while already stopped) fades out every voice, auditions and held keys included.
// trigger() returns a handle; release(handle, at) ends a held gate/loop note early (key or pad up).
export const MUNCH_POLY = 8;
const EDGE = .004; // fade at a region boundary (s): no click, no bleed into the next slice
const voiceKey = hit => (Array.isArray(hit.region) ? 'a' : hit.slice != null ? `s${hit.slice}` : `n${hit.p}`);
/** value of a piecewise-linear envelope [[t, v], …] at time `at` */
export function envValueAt(points, at) {
  if (!points.length || at <= points[0][0]) return points.length ? points[0][1] : 0;
  for (let i = 1; i < points.length; i++) {
    const [t1, v1] = points[i], [t0, v0] = points[i - 1];
    if (at <= t1) return t1 > t0 ? v0 + (v1 - v0) * (at - t0) / (t1 - t0) : v1;
  }
  return points[points.length - 1][1];
}

function createMunchVoice({ ctx, shared, channel, params, sample, tempo }) {
  const active = new Set(); // { src, env, t, end, key, slice, mode, vel, points }
  const stats = { played: 0, missed: 0, stolen: 0, choked: 0, retriggered: 0, stretched: 0, stretchFallback: 0 };
  /** ramp a voice to silence from `at` (never earlier than its own start) and stop it */
  function cut(v, at) {
    const when = Math.max(at, v.t);
    const value = envValueAt(v.points, when);
    try {
      v.env.gain.cancelScheduledValues(when);
      v.env.gain.setValueAtTime(value, when);
      v.env.gain.linearRampToValueAtTime(0, when + CUT);
      v.src.stop(when + CUT + .002);
    } catch (e) { /* already gone */ }
    v.points = [...v.points.filter(pt => pt[0] < when), [when, value], [when + CUT, 0]];
    v.end = Math.min(v.end, when + CUT);
    active.delete(v);
  }
  function trigger(t, hit, dest) {
    const ref = sample && sample(), bank = shared.samples, p = params();
    if (!ref || !bank) return null;
    const rev = !!p.reverse, base = bank.buffer(ref.id, rev);
    if (!base) { stats.missed++; return null; } // missing, not decoded yet or failed: silent, the UI reports why
    const region = Array.isArray(hit.region) ? hit.region : hit.slice != null ? sliceRegion(ref.slices, hit.slice) : trimRegion(p);
    if (!region || !(region[1] > region[0])) return null; // a slice the current sample does not have
    const fp = fitPlayback(p, base.duration, tempo ? tempo() : 120);
    let buf = base, fitRateFactor = fp.tapeRate;
    if (fp.stretch !== 1) {
      const v = bank.stretched ? bank.stretched(ref.id, rev, fp.stretch, ref.slices) : null;
      if (v) { buf = v.buffer; fitRateFactor = v.stretch / fp.stretch; stats.stretched++; } // residual: exact duration
      else { fitRateFactor = 1 / fp.stretch; stats.stretchFallback++; } // not rendered yet: tape keeps the timing
    }
    const { offset, length } = bufferRegion(region, buf.duration, rev);
    const rate = rateForSemitones(noteSemitones(hit, p)) * fitRateFactor, natural = length / rate;
    if (!(natural > 0)) return null;
    const atk = Math.max(.001, p.attack), rel = Math.max(.005, p.release), noteOff = t + Math.max(.01, hit.dur || 0);
    let relAt, end;
    if (p.mode === 'loop') { relAt = noteOff; end = noteOff + rel; }
    else if (p.mode === 'gate' && noteOff + rel < t + natural) { relAt = noteOff; end = noteOff + rel; }
    else { end = t + natural; relAt = Math.max(t, end - EDGE); }
    const key = voiceKey(hit);
    for (const old of [...active]) {
      if (old.end <= t) { active.delete(old); continue; } // already finished by then (onended still cleans it up)
      if (old.t > t) continue; // never cut a voice that starts after this one
      if (old.key === key) { cut(old, t); stats.retriggered++; }
      else if (p.choke && hit.slice != null && old.slice) { cut(old, t); stats.choked++; }
    }
    while (active.size >= MUNCH_POLY) { const old = active.values().next().value; cut(old, Math.max(t, ctx.currentTime)); stats.stolen++; }
    const vel = Math.max(0, Math.min(1, hit.v ?? .8));
    const src = ctx.createBufferSource(), env = ctx.createGain();
    src.buffer = buf; src.playbackRate.value = rate;
    if (p.mode === 'loop') { src.loop = true; src.loopStart = offset; src.loopEnd = offset + length; }
    const peakAt = Math.min(t + atk, relAt), holdAt = Math.max(peakAt, relAt);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vel, peakAt);
    env.gain.setValueAtTime(vel, holdAt);
    env.gain.linearRampToValueAtTime(0, end);
    src.connect(env); env.connect(dest);
    const v = { src, env, t, end, key, slice: hit.slice != null, mode: p.mode, vel, rate, points: [[t, 0], [peakAt, vel], [holdAt, vel], [end, 0]] };
    src.onended = () => { active.delete(v); try { src.disconnect(); env.disconnect(); } catch (e) { /* gone */ } };
    src.start(t, offset);
    src.stop(end + .002);
    active.add(v); stats.played++;
    return v;
  }
  /** end a held note (gate/loop) at `at` with the release time; one-shots play on */
  function release(v, at = ctx.currentTime) {
    if (!v || !active.has(v) || v.mode === 'oneshot') return false;
    const from = Math.max(at, ctx.currentTime, v.t), rel = Math.max(.005, params().release), end = Math.min(v.end, from + rel);
    if (end <= from) return true;
    const value = envValueAt(v.points, from);
    try { v.env.gain.cancelScheduledValues(from); v.env.gain.setValueAtTime(value, from); v.env.gain.linearRampToValueAtTime(0, end); v.src.stop(end + .002); } catch (e) { /* gone */ }
    v.points = [...v.points.filter(pt => pt[0] < from), [from, value], [end, 0]];
    v.end = end;
    return true;
  }
  return {
    input: channel.bus,
    // build the reversed copy and request the stretched copy now, never in a scheduler callback
    apply(p) { const ref = sample && sample(); if (!ref || !shared.samples) return; if (p.reverse) shared.samples.prepare(ref.id, true); },
    trigger, release,
    silence(now) { for (const v of [...active]) cut(v, now); active.clear(); },
    dispose() { for (const v of [...active]) cut(v, ctx.currentTime); active.clear(); },
    /** for tests and the dev panel */
    activeCount: () => active.size, stats,
  };
}

/* ---------- RUFF: multi-lane breakbeat playback (v0.7 PR2) ---------- */
// Reuses the shared SampleBank (decoded AudioBuffers + WSOLA Stretch cache) and follows the same
// click-free voice-ownership discipline as MUNCH:
//   - Each lane ('a' | 'b' | 'c') owns one voice key ('lane:a' …), so beats crossfade seamlessly
//     within a lane while all three lanes play concurrently without interfering.
//   - Auditions use key 'audition' so repeated taps cut cleanly without piling up or interrupting lanes.
//   - Each voice routes src → env → laneGain → dest (session gate), so per-lane volume/mute react
//     instantly mid-bar via apply() while Pause/Stop gates & silence() cut every voice click-free.
export const RUFF_POLY = 12;
const RUFF_EDGE = .002;
const RUFF_LANE_HEADROOM = .72;

function createRuffVoice({ ctx, shared, channel, params, breaks, breakMeta, tempo }) {
  const active = new Set(); // { src, env, laneGain, t, end, key, lane, breakId, audition, baseDuration, bars, sourceBpm, points, onEnded, done }
  const stats = { played: 0, missed: 0, stolen: 0, crossfaded: 0, stretched: 0, stretchFallback: 0 };

  function finishVoice(v) {
    if (v.done) return;
    v.done = true;
    active.delete(v);
    try { v.src.disconnect(); v.env.disconnect(); v.laneGain.disconnect(); } catch (e) { /* gone */ }
    if (v.onEnded) { try { v.onEnded(); } catch (e) { /* callback error */ } }
  }

  function cut(v, at, fade = CUT) {
    const when = Math.max(at, v.t);
    const value = envValueAt(v.points, when);
    try {
      v.env.gain.cancelScheduledValues(when);
      v.env.gain.setValueAtTime(value, when);
      v.env.gain.linearRampToValueAtTime(0, when + fade);
      v.src.stop(when + fade + .002);
    } catch (e) { /* already gone */ }
    v.points = [...v.points.filter(pt => pt[0] < when), [when, value], [when + fade, 0]];
    v.end = Math.min(v.end, when + fade);
    active.delete(v);
    if (v.audition && v.onEnded && !v.done) {
      v.done = true;
      try { v.onEnded(); } catch (e) { /* callback error */ }
    }
  }

  function trigger(t, hit, dest) {
    const bank = shared.samples, p = params();
    if (!bank) return null;
    const lane = hit.lane || 'a';
    const assigned = breaks && breaks();
    const breakId = hit.breakId || (assigned && assigned[lane]) || null;
    if (!breakId) return null;
    const rev = !!hit.rev;
    const base = bank.buffer(breakId, rev);
    if (!base) { stats.missed++; return null; }

    const bMeta = hit.breakMeta || (breakMeta && breakMeta()) || null;
    const desc = resolveBreakDesc(breakId, bMeta);
    const bars = hit.loopBars || (desc && desc.bars) || 2;
    const sourceBpm = (desc && isImportedBreakId(breakId) && desc.bpm > 0) ? desc.bpm : null;
    const slices = breakSlicesOf(breakId, bMeta);
    const bpm = tempo ? tempo() : 120;
    const fp = breakFitPlayback(p, base.duration, bars, bpm, sourceBpm);

    let buf = base, rate = fp.pitchRate;
    if (fp.stretch !== 1) {
      const stretched = bank.stretched ? bank.stretched(breakId, rev, fp.stretch, slices) : null;
      if (stretched) { buf = stretched.buffer; rate = stretched.stretch / fp.stretch; stats.stretched++; }
      else { rate = 1 / fp.stretch; stats.stretchFallback++; }
    }
    if (!(rate > 0) || !(buf.duration > 0)) return null;

    const isAudition = !!hit.audition;
    const isLoopSeg = !!hit.loop;
    let offset = 0, playDur = 0, loopBuffer = false;
    if (isAudition) {
      if (hit.slice != null) {
        const reg = sliceRegion(slices, clampBreakSlice(breakId, hit.slice, 0, bMeta));
        if (!reg || !(reg[1] > reg[0])) return null;
        const br = bufferRegion(reg, buf.duration, rev);
        offset = br.offset;
        const natural = br.length / rate;
        playDur = hit.dur ? Math.min(natural, Math.max(.02, hit.dur)) : natural;
      } else {
        offset = 0;
        playDur = buf.duration / rate;
      }
    } else if (isLoopSeg) {
      const startFrac = Math.max(0, Math.min(1, hit.startFrac || 0));
      // When the user manually corrected BPM on an imported break, beat phase follows the corrected bar cycle
      const cycleScale = sourceBpm && base.duration > 0 ? (barsSeconds(bars, sourceBpm) / base.duration) : 1;
      const cycleDur = cycleScale > 0 ? buf.duration * cycleScale : buf.duration;
      offset = (startFrac * cycleDur) % buf.duration;
      playDur = Math.max(.01, hit.dur || (buf.duration / rate / 8));
      loopBuffer = true;
    } else {
      const reg = hit.slice != null ? sliceRegion(slices, clampBreakSlice(breakId, hit.slice, 0, bMeta)) : [0, 1];
      if (!reg || !(reg[1] > reg[0])) return null;
      const br = bufferRegion(reg, buf.duration, rev);
      const startFrac = Math.max(0, Math.min(.95, hit.sliceStartFrac || 0));
      offset = br.offset + startFrac * br.length;
      const natural = (br.length * (1 - startFrac)) / rate;
      playDur = hit.dur ? Math.min(natural, Math.max(.02, hit.dur)) : natural;
    }
    if (!(playDur > 0)) return null;

    const key = isAudition ? 'audition' : `lane:${lane}`;
    let replaced = false;
    for (const old of [...active]) {
      if (old.end <= t) { active.delete(old); continue; }
      if (old.t > t) continue;
      if (old.key === key) {
        cut(old, t, CUT);
        replaced = true;
        stats.crossfaded++;
      }
    }
    while (active.size >= RUFF_POLY) {
      const old = active.values().next().value;
      cut(old, Math.max(t, ctx.currentTime), CUT);
      stats.stolen++;
    }

    const vel = Math.max(0, Math.min(1, hit.v ?? 1));
    const atk = replaced && isLoopSeg ? CUT : RUFF_EDGE;
    const fadeOut = isLoopSeg ? CUT : RUFF_EDGE;
    const fadeStart = isLoopSeg ? t + playDur : Math.max(t + atk, t + playDur - fadeOut);
    const end = isLoopSeg ? t + playDur + fadeOut : t + playDur;
    const peakAt = Math.min(t + atk, fadeStart);

    const src = ctx.createBufferSource();
    const env = ctx.createGain();
    const laneGain = ctx.createGain();
    src.buffer = buf;
    src.playbackRate.value = rate;
    if (loopBuffer) { src.loop = true; src.loopStart = 0; src.loopEnd = buf.duration; }

    // Auditions stay audible even if the lane is currently muted in the mix
    const rawLaneVol = isAudition ? Math.max(.25, p[laneVolKey(lane)] ?? .85) : laneAudibleLevel(p, lane);
    laneGain.gain.value = rawLaneVol * RUFF_LANE_HEADROOM;

    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vel, peakAt);
    env.gain.setValueAtTime(vel, fadeStart);
    env.gain.linearRampToValueAtTime(0, end);

    src.connect(env);
    env.connect(laneGain);
    laneGain.connect(dest);

    const v = {
      src, env, laneGain, t, end, key, lane, breakId, audition: isAudition,
      baseDuration: base.duration, bars, sourceBpm,
      points: [[t, 0], [peakAt, vel], [fadeStart, vel], [end, 0]],
      onEnded: typeof hit.onEnded === 'function' ? hit.onEnded : null,
      done: false,
    };
    src.onended = () => finishVoice(v);
    src.start(t, offset);
    src.stop(end + .002);
    active.add(v);
    stats.played++;
    return v;
  }

  function stopAudition(now = ctx.currentTime) {
    let stopped = false;
    for (const v of [...active]) {
      if (v.audition) { cut(v, now, CUT); stopped = true; }
    }
    return stopped;
  }

  return {
    input: channel.bus,
    apply(p, now) {
      const curBreaks = breaks ? breaks() : null;
      const curMeta = breakMeta ? breakMeta() : null;
      const bpm = tempo ? tempo() : 120;
      for (const v of [...active]) {
        if (!v.audition) {
          if (curBreaks && curBreaks[v.lane] !== v.breakId) {
            cut(v, now, CUT);
            continue;
          }
          const targetGain = laneAudibleLevel(p, v.lane) * RUFF_LANE_HEADROOM;
          try { v.laneGain.gain.setTargetAtTime(targetGain, now, .015); } catch (e) { /* gone */ }
        }
        if (p.fitMode === 'tape' && v.baseDuration > 0 && v.bars > 0) {
          const desc = resolveBreakDesc(v.breakId, curMeta);
          const curBars = (desc && desc.bars) || v.bars;
          const curSrcBpm = (desc && isImportedBreakId(v.breakId) && desc.bpm > 0) ? desc.bpm : v.sourceBpm;
          const fp = breakFitPlayback(p, v.baseDuration, curBars, bpm, curSrcBpm);
          try { v.src.playbackRate.setTargetAtTime(fp.pitchRate, now, .015); } catch (e) { /* gone */ }
        }
      }
    },
    trigger,
    stopAudition,
    silence(now) { for (const v of [...active]) cut(v, now, CUT); active.clear(); },
    dispose() { for (const v of [...active]) cut(v, ctx.currentTime, CUT); active.clear(); },
    activeCount: () => active.size,
    stats,
  };
}

/** registry `engine` id → voice factory */
export const VOICE_FACTORIES = Object.freeze({ bop: createBopVoice, goo: createGooVoice, blip: createBlipVoice, fuzz: createFuzzVoice, munch: createMunchVoice, ruff: createRuffVoice });
export const hasVoiceFactory = id => Object.prototype.hasOwnProperty.call(VOICE_FACTORIES, id);
