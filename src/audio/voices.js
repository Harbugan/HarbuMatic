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

import { sliceRegion, trimRegion, bufferRegion, rateForSemitones, noteSemitones, fitRate } from '../core/samples.js';

export const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
export const cutHz = v => 50 * Math.pow(2, v * 8.4); // 0..1 → 50 Hz .. ~17 kHz

function crushCurve(amt) {
  const n = 4096, c = new Float32Array(n), steps = Math.pow(2, 16 - amt * 13);
  for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.round(x * steps) / steps; }
  return c;
}

const MAX_POLY = 18;

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
  }
  return {
    input: channel.bus,
    apply(p, now) { b.osc.type = p.wave; b.f1.Q.setTargetAtTime(.7 + p.res * 21, now, .02); },
    trigger,
    silence(now) {
      [b.amp.gain, b.osc.frequency, b.f1.frequency, b.f2.frequency].forEach(prm => prm.cancelScheduledValues(now));
      b.amp.gain.setTargetAtTime(0, now, .01);
    },
    dispose() { try { b.osc.stop(); b.amp.disconnect(); } catch (e) { /* gone */ } },
  };
}

/* ---------- BLIP: poly subtractive synth ---------- */
function createBlipVoice({ ctx, shared, channel, params }) {
  const lfo = ctx.createOscillator(), lfoG = ctx.createGain(); lfoG.gain.value = 0;
  lfo.connect(lfoG); lfo.start();
  function trigger(t, hit, dest) {
    const midi = hit.p, dur = hit.dur, vel = hit.v;
    if (shared.voices.count > MAX_POLY) return;
    const p = params(), f = mtof(midi);
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g1 = ctx.createGain(), g2 = ctx.createGain();
    const fl = ctx.createBiquadFilter(), amp = ctx.createGain();
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
    const stopAt = end + R * 1.6 + .05; o1.start(t); o2.start(t); o1.stop(stopAt); o2.stop(stopAt);
    shared.voices.count++; o1.onended = () => { shared.voices.count--; try { lfoG.disconnect(fl.detune); } catch (e) { /* gone */ } amp.disconnect(); };
  }
  return {
    input: channel.bus,
    apply(p, now) { lfo.frequency.setTargetAtTime(p.lfoRate, now, .05); lfoG.gain.setTargetAtTime(p.lfoDepth * 2400, now, .05); },
    trigger, silence() {},
    dispose() { try { lfo.stop(); lfoG.disconnect(); } catch (e) { /* gone */ } },
  };
}

/* ---------- FUZZ: airy texture voice ---------- */
function createFuzzVoice({ ctx, shared, channel, params }) {
  const crush = ctx.createWaveShaper(); crush.connect(channel.bus);
  function trigger(t, hit, dest) {
    const midi = hit.p, dur = hit.dur, vel = hit.v;
    if (shared.voices.count > MAX_POLY) return;
    const p = params(), f = mtof(midi);
    const o = ctx.createOscillator(), o2 = ctx.createOscillator(), n = ctx.createBufferSource(), nf = ctx.createBiquadFilter(), ng = ctx.createGain(), g2 = ctx.createGain();
    const lp = ctx.createBiquadFilter(), amp = ctx.createGain(), trem = ctx.createOscillator(), tremG = ctx.createGain();
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
    [o, o2, trem].forEach(x => { x.start(t); x.stop(stopAt); }); n.start(t, Math.random()); n.stop(stopAt);
    shared.voices.count++; o.onended = () => { shared.voices.count--; amp.disconnect(); };
  }
  return {
    input: crush,
    apply(p) { crush.curve = p.crush > .02 ? crushCurve(p.crush) : null; },
    trigger, silence() {},
    dispose() { try { crush.disconnect(); } catch (e) { /* gone */ } },
  };
}

/* ---------- MUNCH: sample playback ---------- */
// One AudioBufferSourceNode + one gain envelope per hit. A note plays a region of the decoded sample (the trimmed
// region for melodic notes, slice k for slice notes, or an explicit region for editor auditions), mirrored inside the
// reversed copy when `reverse` is on.
// Playback rate = pitch (transpose + tune, see noteSemitones) × tape fit (fitRate: the trimmed region fitted to bars at
// the current BPM, computed at trigger time). No time-stretch in v0.6: speed and pitch move together.
//   oneshot  plays the whole region, whatever the note length
//   gate     stops at the note end (with the release) or at the region end, whichever comes first
//   loop     loops the region while the note is held, then releases
//   choke    (param) a slice note cuts any slice that is still sounding — one chop at a time
// The envelope always reaches 0 at the region end, so a slice never runs into its neighbour. Every source is
// stopped at a known time and disconnected in `onended`; the pool is bounded (oldest voice is stolen).
// trigger() returns a handle; release(handle, at) ends a held gate/loop note early (keyboard key up).
export const MUNCH_POLY = 8;
const EDGE = .004; // fade at a region boundary (s): no click, no bleed into the next slice

function createMunchVoice({ ctx, shared, channel, params, sample, tempo }) {
  const active = new Set(); // { src, env, end, slice }
  const stats = { played: 0, missed: 0, stolen: 0, choked: 0 };
  function fadeOut(v, at) {
    try { v.env.gain.cancelScheduledValues(at); v.env.gain.setTargetAtTime(0, at, .004); v.src.stop(at + .03); } catch (e) { /* already gone */ }
  }
  function trigger(t, hit, dest) {
    const ref = sample && sample(), bank = shared.samples, p = params();
    if (!ref || !bank) return null;
    const rev = !!p.reverse, buf = bank.buffer(ref.id, rev);
    if (!buf) { stats.missed++; return null; } // missing, not decoded yet or failed: silent, the UI reports why
    const region = Array.isArray(hit.region) ? hit.region : hit.slice != null ? sliceRegion(ref.slices, hit.slice) : trimRegion(p);
    if (!region || !(region[1] > region[0])) return null; // a slice the current sample does not have
    const { offset, length } = bufferRegion(region, buf.duration, rev);
    const rate = rateForSemitones(noteSemitones(hit, p)) * fitRate(p, buf.duration, tempo ? tempo() : 120), natural = length / rate;
    if (!(natural > 0)) return null;
    const atk = Math.max(.001, p.attack), rel = Math.max(.005, p.release), noteOff = t + Math.max(.01, hit.dur || 0);
    let relAt, end;
    if (p.mode === 'loop') { relAt = noteOff; end = noteOff + rel; }
    else if (p.mode === 'gate' && noteOff + rel < t + natural) { relAt = noteOff; end = noteOff + rel; }
    else { end = t + natural; relAt = Math.max(t, end - EDGE); }
    if (p.choke && hit.slice != null) for (const old of [...active]) if (old.slice) { active.delete(old); fadeOut(old, Math.max(t, ctx.currentTime)); stats.choked++; }
    while (active.size >= MUNCH_POLY) { const old = active.values().next().value; active.delete(old); fadeOut(old, Math.max(t, ctx.currentTime)); stats.stolen++; }
    const vel = Math.max(0, Math.min(1, hit.v ?? .8));
    const src = ctx.createBufferSource(), env = ctx.createGain();
    src.buffer = buf; src.playbackRate.value = rate;
    if (p.mode === 'loop') { src.loop = true; src.loopStart = offset; src.loopEnd = offset + length; }
    const peakAt = Math.min(t + atk, relAt);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vel, peakAt);
    env.gain.setValueAtTime(vel, Math.max(peakAt, relAt));
    env.gain.linearRampToValueAtTime(0, end);
    src.connect(env); env.connect(dest);
    const v = { src, env, end, slice: hit.slice != null, mode: p.mode, vel };
    src.onended = () => { active.delete(v); try { src.disconnect(); env.disconnect(); } catch (e) { /* gone */ } };
    src.start(t, offset);
    src.stop(end + .002);
    active.add(v); stats.played++;
    return v;
  }
  /** end a held note (gate/loop) at `at` with the release time; one-shots play on */
  function release(v, at = ctx.currentTime) {
    if (!v || !active.has(v) || v.mode === 'oneshot') return false;
    const rel = Math.max(.005, params().release), end = Math.min(v.end, Math.max(at, ctx.currentTime) + rel);
    try { v.env.gain.cancelScheduledValues(at); v.env.gain.setValueAtTime(v.vel, at); v.env.gain.linearRampToValueAtTime(0, end); v.src.stop(end + .002); v.end = end; } catch (e) { /* gone */ }
    return true;
  }
  return {
    input: channel.bus,
    apply(p) { const ref = sample && sample(); if (p.reverse && ref && shared.samples) shared.samples.prepare(ref.id, true); }, // build the reversed copy now, never in a scheduler callback
    trigger, release,
    silence(now) { for (const v of active) fadeOut(v, now); active.clear(); },
    dispose() { for (const v of active) fadeOut(v, ctx.currentTime); active.clear(); },
    /** for tests and the dev panel */
    activeCount: () => active.size, stats,
  };
}

/** registry `engine` id → voice factory */
export const VOICE_FACTORIES = Object.freeze({ bop: createBopVoice, goo: createGooVoice, blip: createBlipVoice, fuzz: createFuzzVoice, munch: createMunchVoice });
export const hasVoiceFactory = id => Object.prototype.hasOwnProperty.call(VOICE_FACTORIES, id);
