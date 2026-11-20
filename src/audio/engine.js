// Web Audio graph and the four original synthesised instruments (no samples).
// The engine knows nothing about the DOM; it reads parameters through getProject().
//
// Per-track signal flow:  voices → gate → [crush (FUZZ)] → bus → colour → drive → out(vol·mute) → pan → master
//                                                                              ↘ delay send / reverb send
// Each play session gets fresh "gates". Stopping closes them, which silences notes that the
// lookahead scheduler had already queued — no stale events after Stop/Pause/project change.

import { TRACKS } from '../core/constants.js';

const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
export const cutHz = v => 50 * Math.pow(2, v * 8.4); // 0..1 → 50 Hz .. ~17 kHz

function driveCurve(k) {
  const n = 2048, c = new Float32Array(n), a = 1 + k * 18;
  for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(a * x) / Math.tanh(a); }
  return c;
}
function crushCurve(amt) {
  const n = 4096, c = new Float32Array(n), steps = Math.pow(2, 16 - amt * 13);
  for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.round(x * steps) / steps; }
  return c;
}
function makeIR(ctx, sec) {
  const rate = ctx.sampleRate, len = Math.floor(rate * sec), b = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.4) * (i < rate * .012 ? i / (rate * .012) : 1); }
  return b;
}

export function createEngine(getProject) {
  const E = { ctx: null, tr: {}, gates: null, voices: 0, ohh: null, onInterrupt: null };
  const P = t => getProject().tracks[t].params;
  const stepDur = () => 60 / getProject().bpm / 4;
  const audible = t => { const pr = getProject(); const any = TRACKS.some(x => pr.tracks[x].solo); return any ? pr.tracks[t].solo : !pr.tracks[t].mute; };

  function init() {
    if (E.ctx) { if (E.ctx.state !== 'running') E.ctx.resume().catch(() => {}); return E.ctx; }
    const AC = window.AudioContext || window.webkitAudioContext;
    // iOS 17+: play even when the ring/silent switch is on
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* not supported */ }
    const ctx = E.ctx = new AC({ latencyHint: 'interactive' });
    const G = v => { const g = ctx.createGain(); g.gain.value = v; return g; };
    E.master = G(.85);
    E.comp = ctx.createDynamicsCompressor();
    E.comp.threshold.value = -16; E.comp.ratio.value = 3.5; E.comp.attack.value = .004; E.comp.release.value = .18; E.comp.knee.value = 8;
    E.analyser = ctx.createAnalyser(); E.analyser.fftSize = 256; E.analyser.smoothingTimeConstant = .7;
    E.master.connect(E.comp); E.comp.connect(E.analyser); E.analyser.connect(ctx.destination);
    E.revIn = G(1); E.rev = ctx.createConvolver(); E.rev.buffer = makeIR(ctx, 2.8); E.revOut = G(.9);
    const revHP = ctx.createBiquadFilter(); revHP.type = 'highpass'; revHP.frequency.value = 180;
    E.revIn.connect(revHP); revHP.connect(E.rev); E.rev.connect(E.revOut); E.revOut.connect(E.master);
    E.dIn = G(1); E.delay = ctx.createDelay(2); E.dFb = G(.4); E.dLP = ctx.createBiquadFilter(); E.dLP.type = 'lowpass'; E.dLP.frequency.value = 3200; E.dOut = G(.8);
    E.dIn.connect(E.delay); E.delay.connect(E.dLP); E.dLP.connect(E.dFb); E.dFb.connect(E.delay); E.dLP.connect(E.dOut); E.dOut.connect(E.master);
    E.delay.delayTime.value = stepDur() * 3;
    E.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = E.noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    TRACKS.forEach(t => {
      const ch = { bus: G(1), color: ctx.createBiquadFilter(), drive: ctx.createWaveShaper(), out: G(1), pan: ctx.createStereoPanner ? ctx.createStereoPanner() : G(1), sd: G(0), sr: G(0) };
      ch.color.type = 'lowpass'; ch.color.frequency.value = 20000; ch.drive.oversample = '2x';
      ch.bus.connect(ch.color); ch.color.connect(ch.drive); ch.drive.connect(ch.out); ch.out.connect(ch.pan); ch.pan.connect(E.master);
      ch.out.connect(ch.sd); ch.sd.connect(E.dIn); ch.out.connect(ch.sr); ch.sr.connect(E.revIn);
      E.tr[t] = ch;
    });
    const b = E.bass = { osc: ctx.createOscillator(), f1: ctx.createBiquadFilter(), f2: ctx.createBiquadFilter(), amp: G(0) };
    b.f1.type = b.f2.type = 'lowpass'; b.f2.Q.value = .5;
    b.osc.connect(b.f1); b.f1.connect(b.f2); b.f2.connect(b.amp); b.amp.connect(E.tr.bass.bus); b.osc.start();
    E.lfo = ctx.createOscillator(); E.lfoG = G(0); E.lfo.connect(E.lfoG); E.lfo.start();
    E.crush = ctx.createWaveShaper(); E.crush.connect(E.tr.fuzz.bus);
    TRACKS.forEach(applyParams); applyGlobalFx();
    ctx.onstatechange = () => { if (ctx.state !== 'running' && E.onInterrupt) E.onInterrupt(ctx.state); };
    return ctx;
  }

  const trackInput = t => (t === 'fuzz' ? E.crush : E.tr[t].bus);
  function openGates() {
    closeGates();
    E.gates = {};
    TRACKS.forEach(t => { const g = E.ctx.createGain(); g.gain.value = 1; g.connect(trackInput(t)); E.gates[t] = g; });
  }
  function closeGates() {
    if (!E.gates || !E.ctx) return;
    const now = E.ctx.currentTime, old = E.gates;
    Object.values(old).forEach(g => { g.gain.cancelScheduledValues(now); g.gain.setTargetAtTime(0, now, .006); });
    setTimeout(() => Object.values(old).forEach(g => { try { g.disconnect(); } catch (e) { /* gone */ } }), 250);
    E.gates = null;
    silenceBass();
  }
  function silenceBass() {
    if (!E.bass) return;
    const now = E.ctx.currentTime, b = E.bass;
    [b.amp.gain, b.osc.frequency, b.f1.frequency, b.f2.frequency].forEach(prm => prm.cancelScheduledValues(now));
    b.amp.gain.setTargetAtTime(0, now, .01);
  }
  /** where a voice should connect: the session gate while playing, else straight in (auditions) */
  const voiceOut = (t, live) => (live && E.gates ? E.gates[t] : trackInput(t));

  function applyParams(t) {
    if (!E.ctx) return;
    const p = P(t), ch = E.tr[t], now = E.ctx.currentTime;
    ch.out.gain.setTargetAtTime(audible(t) ? p.vol : 0, now, .02);
    if (ch.pan.pan) ch.pan.pan.setTargetAtTime(p.pan, now, .02);
    ch.sd.gain.setTargetAtTime(p.delayOn ? p.delay : 0, now, .03);
    ch.sr.gain.setTargetAtTime(p.reverbOn ? p.reverb : 0, now, .03);
    ch.drive.curve = p.driveOn ? driveCurve(p.drive) : null;
    if (t === 'drums') ch.color.frequency.setTargetAtTime(p.kit === 'lofi' ? 5200 : 20000, now, .02);
    if (t === 'bass') { E.bass.osc.type = p.wave; E.bass.f1.Q.setTargetAtTime(.7 + p.res * 21, now, .02); }
    if (t === 'synth') { E.lfo.frequency.setTargetAtTime(p.lfoRate, now, .05); E.lfoG.gain.setTargetAtTime(p.lfoDepth * 2400, now, .05); }
    if (t === 'fuzz') E.crush.curve = p.crush > .02 ? crushCurve(p.crush) : null;
    E.delay.delayTime.setTargetAtTime(stepDur() * 3, now, .05);
  }
  function applyAll() { if (!E.ctx) return; TRACKS.forEach(applyParams); applyGlobalFx(); }
  function applyGlobalFx() {
    if (!E.ctx) return;
    const t = E.ctx.currentTime, f = getProject().fx;
    E.dFb.gain.setTargetAtTime(f.fb, t, .03); E.dLP.frequency.setTargetAtTime(cutHz(.4 + f.dtone * .55), t, .03);
    E.revOut.gain.setTargetAtTime(f.rev, t, .03); E.master.gain.setTargetAtTime(f.master, t, .03);
  }

  /* ---------- BOP: drum synthesis ---------- */
  function playDrum(id, t, vel, live = true) {
    const ctx = E.ctx, p = P('drums'), tune = Math.pow(2, p.tune / 12), dec = p.decay, tone = p.tone, kit = p.kit;
    const out = ctx.createGain(); out.gain.value = vel; out.connect(voiceOut('drums', live));
    const env = (node, peak, d, a = .001) => { const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(.0001, t + a + d); node.connect(g); g.connect(out); return g; };
    const osc = (type, f) => { const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); return o; };
    const noise = () => { const s = ctx.createBufferSource(); s.buffer = E.noise; return s; };
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
        if (id === 'chh' && E.ohh) { try { E.ohh.gain.cancelScheduledValues(t); E.ohh.gain.setTargetAtTime(0, t, .008); } catch (e) { /* ended */ } E.ohh = null; }
        const n = noise(), f = filt('highpass', 6000 + tone * 4000), f2 = filt('peaking', 9000, 1); f2.gain.value = 5; n.connect(f); f.connect(f2);
        const d = (id === 'chh' ? .05 : .32) * dec * (kit === '909' ? 1.2 : 1);
        const g = env(f2, id === 'chh' ? .42 : .36, d); run(n, d); if (id === 'ohh') E.ohh = g; break;
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

  /* ---------- GOO: 303-style mono acid ---------- */
  function playBass(t, midi, dur, vel, slideIn, slideOut) {
    const p = P('bass'), b = E.bass, f = mtof(midi), acc = vel > .9;
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

  /* ---------- BLIP: poly subtractive synth ---------- */
  function playSynth(t, midi, dur, vel, live = true) {
    if (E.voices > 18) return;
    const ctx = E.ctx, p = P('synth'), f = mtof(midi);
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g1 = ctx.createGain(), g2 = ctx.createGain();
    const fl = ctx.createBiquadFilter(), amp = ctx.createGain();
    o1.type = p.wave1; o2.type = p.wave2; o1.frequency.value = f; o2.frequency.value = f * Math.pow(2, p.oct2); o1.detune.value = -p.detune / 2; o2.detune.value = p.detune / 2;
    g1.gain.value = 1 - p.mix; g2.gain.value = p.mix;
    fl.type = 'lowpass'; fl.Q.value = .5 + p.res * 14;
    const base = cutHz(p.cutoff), peak = Math.min(base * Math.pow(2, p.fenv * 4), 18000);
    fl.frequency.setValueAtTime(peak, t); fl.frequency.setTargetAtTime(base, t + p.attack, p.decay / 2.5);
    E.lfoG.connect(fl.detune);
    const pk = .22 * (.35 + vel * .65), A = Math.max(.003, p.attack), R = Math.max(.02, p.release);
    amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(pk, t + A);
    amp.gain.setTargetAtTime(pk * p.sustain, t + A, p.decay / 3);
    const end = Math.max(t + dur, t + A); amp.gain.cancelScheduledValues(end); amp.gain.setTargetAtTime(0, end, R / 3.5);
    o1.connect(g1); o2.connect(g2); g1.connect(fl); g2.connect(fl); fl.connect(amp); amp.connect(voiceOut('synth', live));
    const stopAt = end + R * 1.6 + .05; o1.start(t); o2.start(t); o1.stop(stopAt); o2.stop(stopAt);
    E.voices++; o1.onended = () => { E.voices--; try { E.lfoG.disconnect(fl.detune); } catch (e) { /* gone */ } amp.disconnect(); };
  }

  /* ---------- FUZZ: airy texture voice ---------- */
  function playFuzz(t, midi, dur, vel, live = true) {
    if (E.voices > 18) return;
    const ctx = E.ctx, p = P('fuzz'), f = mtof(midi);
    const o = ctx.createOscillator(), o2 = ctx.createOscillator(), n = ctx.createBufferSource(), nf = ctx.createBiquadFilter(), ng = ctx.createGain(), g2 = ctx.createGain();
    const lp = ctx.createBiquadFilter(), amp = ctx.createGain(), trem = ctx.createOscillator(), tremG = ctx.createGain();
    o.type = 'sine'; o.frequency.value = f; o2.type = 'triangle'; o2.frequency.value = f * 2.003; g2.gain.value = .25 + p.shimmer * .3;
    n.buffer = E.noise; n.loop = true; nf.type = 'bandpass'; nf.frequency.value = f * 2; nf.Q.value = 4; ng.gain.value = p.noise * 2.2;
    lp.type = 'lowpass'; lp.frequency.value = 400 + p.tone * 9000; lp.Q.value = 1.5;
    trem.frequency.value = 3 + p.shimmer * 6; tremG.gain.value = p.shimmer * .5;
    const pk = .2 * (.4 + vel * .6), A = .02 + p.attack * 1.5, R = .1 + p.release;
    amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(pk, t + A);
    const end = Math.max(t + dur, t + A); amp.gain.setTargetAtTime(0, end, R / 3.5);
    const vca = ctx.createGain(); vca.gain.value = 1; trem.connect(tremG); tremG.connect(vca.gain);
    o.connect(lp); o2.connect(g2); g2.connect(lp); n.connect(nf); nf.connect(ng); ng.connect(lp); lp.connect(vca); vca.connect(amp); amp.connect(voiceOut('fuzz', live));
    const stopAt = end + R * 1.6 + .05;
    [o, o2, trem].forEach(x => { x.start(t); x.stop(stopAt); }); n.start(t, Math.random()); n.stop(stopAt);
    E.voices++; o.onended = () => { E.voices--; amp.disconnect(); };
  }

  function playNote(tr, t, n, dur, slideIn = false, slideOut = false, live = true) {
    if (tr === 'bass') playBass(t, n.p, dur, n.v, slideIn, slideOut);
    else if (tr === 'synth') playSynth(t, n.p, dur, n.v, live);
    else if (tr === 'fuzz') playFuzz(t, n.p, dur, n.v, live);
  }
  /** immediate preview (tapping a key, drawing a note) — bypasses the play-session gate */
  function audition(tr, pitch, v = .8) {
    init();
    const t = E.ctx.currentTime + .01;
    if (tr === 'drums') playDrum(pitch, t, v, false);
    else playNote(tr, t, { p: pitch, v }, tr === 'fuzz' ? .6 : .22, false, false, false);
  }

  return {
    E, init, applyParams, applyAll, applyGlobalFx, openGates, closeGates, silenceBass,
    playDrum, playNote, audition, audible, stepDur,
    get ctx() { return E.ctx; }, get analyser() { return E.analyser; },
    set onInterrupt(fn) { E.onInterrupt = fn; },
  };
}
