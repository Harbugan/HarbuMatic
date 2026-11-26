// Web Audio graph: shared effects, one mixer channel per instrument slot, and the voices of each slot.
// The engine knows nothing about the DOM; it reads parameters through getProject().
//
// Identity: channels are keyed by slot id (the instrument instance). The synthesis comes from the voice
// factory named by the slot's instrument type (registry `engine` → src/audio/voices.js), so the engine
// never branches on a particular instrument.
//
// Per-slot signal flow:  voices → gate → voice input (FUZZ: crusher) → bus → colour → drive → out(vol·mute) → pan → master
//                                                                                     ↘ delay send / reverb send
// Each play session gets fresh "gates". Stopping closes them, which silences notes that the
// lookahead scheduler had already queued — no stale events after Stop/Pause/project change.

import { getInstrumentType } from '../core/instruments.js';
import { playableSlots, slotById, slotAudible } from '../core/project.js';
import { VOICE_FACTORIES, cutHz } from './voices.js';
import { createAudioSession } from './session.js';

export { cutHz };

function driveCurve(k) {
  const n = 2048, c = new Float32Array(n), a = 1 + k * 18;
  for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(a * x) / Math.tanh(a); }
  return c;
}
function makeIR(ctx, sec) {
  const rate = ctx.sampleRate, len = Math.floor(rate * sec), b = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.4) * (i < rate * .012 ? i / (rate * .012) : 1); }
  return b;
}

/**
 * @param getProject  () → current project
 * @param opts.samples  sample bank (src/samples/bank.js) handed to sampler voices; decoding stays in the bank
 */
export function createEngine(getProject, { samples = null } = {}) {
  const E = { ctx: null, ch: new Map(), gates: null, previewGates: {}, shared: null, onInterrupt: null, samples, session: createAudioSession() };
  const slotParams = id => slotById(getProject(), id).params;
  const stepDur = () => 60 / getProject().bpm / 4;
  const audible = id => { const pr = getProject(), s = slotById(pr, id); return !!s && slotAudible(pr, s); };

  function init() {
    if (E.ctx) { if (E.ctx.state !== 'running') E.ctx.resume().catch(() => {}); return E.ctx; }
    const AC = window.AudioContext || window.webkitAudioContext;
    // iOS 17+: play even when the ring/silent switch is on (the recorder switches to capture while the mic is open)
    E.session.playback();
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
    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    E.shared = { noise, voices: { count: 0 }, samples: E.samples };
    if (E.samples && E.samples.attach) E.samples.attach(ctx); // the bank decodes into this context from now on
    syncSlots();
    playableSlots(getProject()).forEach(s => applyParams(s.id)); applyGlobalFx();
    ctx.onstatechange = () => { if (ctx.state !== 'running' && E.onInterrupt) E.onInterrupt(ctx.state); };
    return ctx;
  }

  /* ---------- slot channels ---------- */
  function createChannel(slot) {
    const ctx = E.ctx, G = v => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const ch = { bus: G(1), color: ctx.createBiquadFilter(), drive: ctx.createWaveShaper(), out: G(1), pan: ctx.createStereoPanner ? ctx.createStereoPanner() : G(1), sd: G(0), sr: G(0) };
    ch.color.type = 'lowpass'; ch.color.frequency.value = 20000; ch.drive.oversample = '2x';
    ch.bus.connect(ch.color); ch.color.connect(ch.drive); ch.drive.connect(ch.out); ch.out.connect(ch.pan); ch.pan.connect(E.master);
    ch.out.connect(ch.sd); ch.sd.connect(E.dIn); ch.out.connect(ch.sr); ch.sr.connect(E.revIn);
    const def = getInstrumentType(slot.type), id = slot.id;
    const voice = VOICE_FACTORIES[def.engine]({
      ctx, shared: E.shared, channel: ch,
      params: () => slotParams(id),
      tempo: () => getProject().bpm,
      sample: () => { const s = slotById(getProject(), id); return (s && s.sample) || null; },
      breaks: () => { const s = slotById(getProject(), id); return (s && s.breaks) || null; },
      breakMeta: () => { const s = slotById(getProject(), id); return (s && s.breakMeta) || null; },
    });
    return { type: slot.type, channel: ch, voice };
  }
  function disposeChannel(entry) {
    try { entry.voice.silence(E.ctx.currentTime); entry.voice.dispose(); } catch (e) { /* gone */ }
    const ch = entry.channel;
    try { ch.out.gain.setTargetAtTime(0, E.ctx.currentTime, .01); } catch (e) { /* gone */ }
    setTimeout(() => Object.values(ch).forEach(n => { try { n.disconnect(); } catch (e) { /* gone */ } }), 250);
  }
  /** make the channels match the project's playable slots (new song, undo, future slot changes) */
  function syncSlots() {
    if (!E.ctx) return;
    const want = playableSlots(getProject());
    const keep = new Set(want.map(s => s.id));
    for (const [id, entry] of E.ch) {
      const s = want.find(x => x.id === id);
      if (!keep.has(id) || !s || s.type !== entry.type) {
        closePreviewGate(id, false);
        disposeChannel(entry); E.ch.delete(id); if (E.gates) delete E.gates[id];
      }
    }
    for (const s of want) if (!E.ch.has(s.id)) E.ch.set(s.id, createChannel(s));
  }

  function openGates() {
    closeGates();
    E.gates = {};
    for (const [id, entry] of E.ch) { const g = E.ctx.createGain(); g.gain.value = 1; g.connect(entry.voice.input); E.gates[id] = g; }
  }
  /** Pause/Stop: close the session gates (queued notes go quiet) and silence every voice — also when the transport
   *  was already stopped, so Stop always ends auditions, held keys and long one-shots (BUGS.md MUNCH-3) */
  function closeGates() {
    if (!E.ctx) return;
    if (E.gates) {
      const now = E.ctx.currentTime, old = E.gates;
      Object.values(old).forEach(g => { g.gain.cancelScheduledValues(now); g.gain.setTargetAtTime(0, now, .006); });
      setTimeout(() => Object.values(old).forEach(g => { try { g.disconnect(); } catch (e) { /* gone */ } }), 250);
      E.gates = null;
    }
    silenceSustained();
  }
  /** open an isolated session gate for local single-slot preview (e.g. MUNCH CHOP), independent of global transport gates */
  function openPreviewGate(id) {
    if (!E.ctx) return null;
    closePreviewGate(id, false);
    const entry = E.ch.get(id); if (!entry) return null;
    const g = E.ctx.createGain(); g.gain.value = 1; g.connect(entry.voice.input);
    E.previewGates[id] = g;
    return g;
  }
  /** close a single slot's local preview gate and silence only that slot's voices (never touches global transport or other slots) */
  function closePreviewGate(id, silence = true) {
    if (!E.ctx) return;
    const now = E.ctx.currentTime, g = E.previewGates[id];
    if (g) {
      g.gain.cancelScheduledValues(now);
      g.gain.setTargetAtTime(0, now, .006);
      setTimeout(() => { try { g.disconnect(); } catch (e) { /* gone */ } }, 250);
      delete E.previewGates[id];
    }
    if (silence) {
      const entry = E.ch.get(id);
      if (entry) entry.voice.silence(now);
    }
  }
  /** stop sustained voices (the mono bass keeps running between notes) */
  function silenceSustained() {
    if (!E.ctx) return;
    const now = E.ctx.currentTime;
    for (const entry of E.ch.values()) entry.voice.silence(now);
  }
  /** where a voice should connect: preview gate during local preview, session gate while playing, else straight in (auditions) */
  const voiceOut = (id, live) => (
    live === 'preview' && E.previewGates[id] ? E.previewGates[id]
      : live && E.gates && E.gates[id] ? E.gates[id]
        : E.ch.get(id).voice.input
  );

  function applyParams(id) {
    if (!E.ctx) return;
    const entry = E.ch.get(id); if (!entry) return;
    const p = slotParams(id), ch = entry.channel, now = E.ctx.currentTime;
    ch.out.gain.setTargetAtTime(audible(id) ? p.vol : 0, now, .02);
    if (ch.pan.pan) ch.pan.pan.setTargetAtTime(p.pan, now, .02);
    ch.sd.gain.setTargetAtTime(p.delayOn ? p.delay : 0, now, .03);
    ch.sr.gain.setTargetAtTime(p.reverbOn ? p.reverb : 0, now, .03);
    ch.drive.curve = p.driveOn ? driveCurve(p.drive) : null;
    entry.voice.apply(p, now);
    E.delay.delayTime.setTargetAtTime(stepDur() * 3, now, .05);
  }
  function applyAll() { if (!E.ctx) return; syncSlots(); playableSlots(getProject()).forEach(s => applyParams(s.id)); applyGlobalFx(); }
  function applyGlobalFx() {
    if (!E.ctx) return;
    const t = E.ctx.currentTime, f = getProject().fx;
    E.dFb.gain.setTargetAtTime(f.fb, t, .03); E.dLP.frequency.setTargetAtTime(cutHz(.4 + f.dtone * .55), t, .03);
    E.revOut.gain.setTargetAtTime(f.rev, t, .03); E.master.gain.setTargetAtTime(f.master, t, .03);
  }

  /**
   * Play one hit on a slot at audio time t (called by the scheduler).
   * drum hit: { d, v } · note hit: { p, v, dur, slideIn, slideOut }
   */
  function trigger(id, t, hit, live = true) {
    const entry = E.ch.get(id); if (!entry) return null;
    return entry.voice.trigger(t, hit, voiceOut(id, live));
  }
  /** immediate preview (tapping a key, drawing a note, auditioning a break) — bypasses the play-session gate. */
  function audition(id, pitch, v = .8, extra = null) {
    init();
    const s = slotById(getProject(), id); if (!s || !E.ch.has(id)) return null;
    const def = getInstrumentType(s.type), t = E.ctx.currentTime + .01;
    if (def.pattern === 'drum') return trigger(id, t, { d: pitch, v }, false);
    if (def.pattern === 'break') return trigger(id, t, { audition: true, v, ...extra }, false);
    return trigger(id, t, { p: pitch, v, dur: def.ui.audition.length, slideIn: false, slideOut: false, ...extra }, false);
  }
  function stopAudition(id) {
    if (!E.ctx) return false;
    const entry = E.ch.get(id);
    return !!(entry && entry.voice.stopAudition && entry.voice.stopAudition(E.ctx.currentTime));
  }

  /**
   * Held preview note (MUNCH keyboard): starts now and sounds until noteOff (gate/loop) or to its region end
   * (one-shot). Returns a handle for noteOff, or null when nothing could play.
   */
  function noteOn(id, pitch, v = .8, extra = null) {
    init();
    const s = slotById(getProject(), id); if (!s || !E.ch.has(id)) return null;
    const voice = trigger(id, E.ctx.currentTime + .005, { p: pitch, v, dur: 60, slideIn: false, slideOut: false, ...extra }, false);
    return voice ? { id, voice } : null;
  }
  function noteOff(handle) {
    if (!handle || !E.ctx) return false;
    const entry = E.ch.get(handle.id);
    return !!(entry && entry.voice.release && entry.voice.release(handle.voice, E.ctx.currentTime));
  }

  return {
    E, init, applyParams, applyAll, applyGlobalFx, openGates, closeGates, openPreviewGate, closePreviewGate, silenceSustained, syncSlots,
    trigger, audition, stopAudition, noteOn, noteOff, audible, stepDur,
    get ctx() { return E.ctx; }, get analyser() { return E.analyser; },
    set onInterrupt(fn) { E.onInterrupt = fn; },
  };
}
