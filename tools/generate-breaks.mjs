// Deterministic original breakbeat generator for HarbuMatic RUFF (v0.7 PR2).
// Produces three independently composed, acoustic-modeled, room-glued, bus-compressed
// 2-bar stereo 44.1 kHz 16-bit PCM WAV loops with sample-exact seamless wrap points:
//   assets/breaks/tight.wav   — TIGHT       (120 BPM, 2 bars = 4.000000 s, 176400 frames)
//   assets/breaks/funky.wav   — FUNKY       (105 BPM, 2 bars = 4.571429 s, 201600 frames)
//   assets/breaks/jungle.wav  — RUFF JUNGLE (160 BPM, 2 bars = 3.000000 s, 132300 frames)
//
// Zero external dependencies. Reproducible via fixed PRNG seeds.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 44100;
const TWO_PI = Math.PI * 2;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- deterministic PRNG ---------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function noiseSample(rng) { return rng() * 2 - 1; }

/* ---------- Float64 biquad filter ---------- */
function makeBiquad(type, freq, q = 0.707, gainDb = 0) {
  const f = Math.max(15, Math.min(SR * 0.46, freq));
  const w0 = TWO_PI * f / SR;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * Math.max(0.1, q));
  const A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowpass') {
    b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else if (type === 'highpass') {
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else if (type === 'bandpass') {
    b0 = alpha; b1 = 0; b2 = -alpha;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else if (type === 'peaking') {
    b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
    a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
  } else if (type === 'lowshelf') {
    const sa = 2 * Math.sqrt(A) * alpha;
    b0 = A * ((A + 1) - (A - 1) * cw + sa);
    b1 = 2 * A * ((A - 1) - (A + 1) * cw);
    b2 = A * ((A + 1) - (A - 1) * cw - sa);
    a0 = (A + 1) + (A - 1) * cw + sa;
    a1 = -2 * ((A - 1) + (A + 1) * cw);
    a2 = (A + 1) + (A - 1) * cw - sa;
  } else { // highshelf
    const sa = 2 * Math.sqrt(A) * alpha;
    b0 = A * ((A + 1) + (A - 1) * cw + sa);
    b1 = -2 * A * ((A - 1) + (A + 1) * cw);
    b2 = A * ((A + 1) + (A - 1) * cw - sa);
    a0 = (A + 1) - (A - 1) * cw + sa;
    a1 = 2 * ((A - 1) - (A + 1) * cw);
    a2 = (A + 1) - (A - 1) * cw - sa;
  }
  const c0 = b0 / a0, c1 = b1 / a0, c2 = b2 / a0, d1 = a1 / a0, d2 = a2 / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return x => {
    const y = c0 * x + c1 * x1 + c2 * x2 - d1 * y1 - d2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

function filterInPlace(buf, type, freq, q = 0.707, gainDb = 0) {
  const f = makeBiquad(type, freq, q, gainDb);
  for (let i = 0; i < buf.length; i++) buf[i] = f(buf[i]);
}

function panGains(pan) {
  const angle = (Math.max(-1, Math.min(1, pan)) + 1) * Math.PI * 0.25;
  return [Math.cos(angle), Math.sin(angle)];
}

function mixMonoIntoStereo(outL, outR, mono, startIdx, gain, pan) {
  const [gL, gR] = panGains(pan);
  const sL = gain * gL, sR = gain * gR;
  const end = Math.min(outL.length, startIdx + mono.length);
  for (let i = Math.max(0, startIdx); i < end; i++) {
    const s = mono[i - startIdx];
    outL[i] += s * sL;
    outR[i] += s * sR;
  }
}

/* ---------- Acoustic-modeled drum voices ---------- */

function synthKick(kit, vel, rng) {
  const dur = kit.kickDecay * (0.9 + vel * 0.2);
  const len = Math.ceil(dur * SR);
  const out = new Float64Array(len);
  const f0 = kit.kickBase * (1 + (rng() - 0.5) * 0.015);
  const fDrop = kit.kickDrop * (0.9 + vel * 0.25);
  const beaterLP = makeBiquad('bandpass', kit.kickBeaterHz, 1.4);
  const shellBP = makeBiquad('bandpass', kit.kickShellHz, 2.2);
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const freq = f0 + fDrop * Math.exp(-t / kit.kickPitchTau) + 190 * Math.exp(-t / 0.0024);
    phase += TWO_PI * freq / SR;
    const atk = 1 - Math.exp(-t / 0.0006);
    const bodyEnv = (1 - Math.exp(-t / 0.0012)) * Math.exp(-t / kit.kickBodyTau);
    const body = (Math.sin(phase) + kit.kickWarmth * Math.sin(phase * 2) * Math.exp(-t / 0.045)) * bodyEnv;
    const n = noiseSample(rng);
    const beater = beaterLP(n) * atk * Math.exp(-t / 0.0042) * kit.kickBeaterAmt * (0.65 + 0.55 * vel);
    const shell = shellBP(n) * atk * Math.exp(-t / 0.022) * kit.kickShellAmt;
    const raw = (body * 0.95 + beater + shell) * (0.55 + 0.55 * vel);
    out[i] = Math.tanh(raw * kit.kickDrive) / Math.tanh(kit.kickDrive);
  }
  return out;
}

function synthSnare(kit, vel, style, rng, hand = 0) {
  const isGhost = style === 'ghost';
  const isRim = style === 'rimshot';
  const isRoll = style === 'roll';
  const handShift = hand ? 1.028 : 0.978;
  const f0 = kit.snareHz * handShift * (isGhost ? 0.94 : isRim ? 1.06 : 1.0) * (1 + (rng() - 0.5) * 0.018);
  const dur = (isGhost ? 0.13 : isRoll ? 0.17 : kit.snareDecay) * (0.85 + vel * 0.25);
  const len = Math.ceil(dur * SR);
  const out = new Float64Array(len);

  const wireLow = makeBiquad('bandpass', kit.wireLowHz * (isGhost ? 0.9 : 1), 1.05);
  const wireMid = makeBiquad('bandpass', kit.wireMidHz * handShift, 1.35);
  const wireHigh = makeBiquad('highpass', kit.wireHighHz, 0.8);
  const stickBP = makeBiquad('bandpass', 3600, 1.8);
  const rimBP = makeBiquad('bandpass', kit.rimRingHz, 5.2);

  let p1 = 0, p2 = 0, p3 = 0, pRim = 0;
  const headAmt = isGhost ? 0.28 : isRoll ? 0.58 : isRim ? 0.85 : 0.78;
  const wireAmt = isGhost ? 0.82 : isRoll ? 0.88 : kit.wireAmt;
  const headTau = isGhost ? 0.026 : isRoll ? 0.036 : kit.snareHeadTau;
  const wireTau = isGhost ? 0.036 : isRoll ? 0.048 : kit.snareWireTau;

  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const atk = 1 - Math.exp(-t / 0.0005);
    const drop = 1 + 0.26 * Math.exp(-t / 0.011);
    p1 += TWO_PI * (f0 * drop) / SR;
    p2 += TWO_PI * (f0 * 1.59 * drop) / SR;
    p3 += TWO_PI * (f0 * 2.13) / SR;
    pRim += TWO_PI * (kit.rimRingHz * handShift) / SR;

    const headEnv = (1 - Math.exp(-t / 0.0008)) * Math.exp(-t / headTau);
    const head = (Math.sin(p1) + 0.38 * Math.sin(p2) * Math.exp(-t / 0.024) + 0.16 * Math.sin(p3) * Math.exp(-t / 0.015)) * headEnv * headAmt;

    const n = noiseSample(rng);
    const wireEnv = (1 - Math.exp(-t / (isGhost ? 0.0022 : 0.001))) * (0.72 * Math.exp(-t / wireTau) + 0.28 * Math.exp(-t / (wireTau * 2.1)));
    const buzz = 1 + 0.22 * Math.sin(TWO_PI * (f0 * 0.85) * t) * Math.exp(-t / 0.032);
    const wire = (wireLow(n) * 0.65 + wireMid(n) * 0.95 + wireHigh(n) * 0.42) * wireEnv * buzz * wireAmt;

    const stick = stickBP(n) * atk * Math.exp(-t / 0.0022) * (isGhost ? 0.18 : isRim ? 1.1 : 0.65);
    const rimRing = (isRim ? (Math.sin(pRim) * 0.34 + rimBP(n) * 0.55) * atk * Math.exp(-t / 0.068) : 0);

    const raw = (head + wire + stick + rimRing) * (0.22 + 0.88 * vel);
    out[i] = Math.tanh(raw * kit.snareDrive) / Math.tanh(kit.snareDrive);
  }
  return out;
}

const CYMBAL_RATIOS = [1.0, 1.493, 2.105, 2.741, 3.662, 4.943, 6.713, 9.024];

function synthHiHat(kit, vel, kind, rng) {
  // kind: 'chh' | 'hhh' | 'ohh' | 'pedal'
  const baseTau = kind === 'chh' ? kit.chhTau : kind === 'pedal' ? 0.042 : kind === 'hhh' ? 0.12 : kit.ohhTau;
  const dur = Math.max(0.06, baseTau * 5.2);
  const len = Math.ceil(dur * SR);
  const out = new Float64Array(len);

  const bp1 = makeBiquad('bandpass', kit.hatBrightHz * 0.68, 1.3);
  const bp2 = makeBiquad('bandpass', kit.hatBrightHz, 1.1);
  const hp = makeBiquad('highpass', 5800, 0.7);
  const stickBP = makeBiquad('bandpass', 4600, 2.2);
  const baseF = kit.hatBaseHz * (1 + (rng() - 0.5) * 0.03);
  const phases = CYMBAL_RATIOS.map(() => rng() * TWO_PI);

  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const n = noiseSample(rng);
    let metal = 0;
    for (let k = 0; k < CYMBAL_RATIOS.length; k++) {
      phases[k] += TWO_PI * (baseF * CYMBAL_RATIOS[k] + n * 180) / SR;
      metal += (phases[k] % TWO_PI < Math.PI ? 1 : -1) * (0.14 / Math.sqrt(k + 1));
    }
    const src = metal * 0.62 + n * 0.52;
    const shaped = bp1(src) * 0.6 + bp2(src) * 0.95 + hp(src) * 0.55;
    const atk = kind === 'pedal' ? 0.003 : 0.0008;
    const env = (1 - Math.exp(-t / atk)) * (0.7 * Math.exp(-t / baseTau) + 0.3 * Math.exp(-t / (baseTau * 2.1)));
    const click = kind === 'pedal' ? 0 : stickBP(n) * (1 - Math.exp(-t / 0.0005)) * Math.exp(-t / 0.0018) * 0.45;
    const thump = kind === 'pedal' ? Math.sin(TWO_PI * 240 * t) * Math.exp(-t / 0.012) * 0.16 : 0;
    out[i] = (shaped * env + click + thump) * (0.28 + 0.78 * vel);
  }
  return out;
}

function synthRide(kit, vel, kind, rng) {
  // kind: 'bow' | 'bell' | 'crash'
  const isBell = kind === 'bell';
  const isCrash = kind === 'crash';
  const tau = isCrash ? 0.42 : isBell ? 0.24 : 0.28;
  const dur = tau * 4.5;
  const len = Math.ceil(dur * SR);
  const out = new Float64Array(len);

  const washBP = makeBiquad('bandpass', isCrash ? 6400 : 7600, 0.85);
  const airHP = makeBiquad('highpass', isCrash ? 4200 : 5200, 0.7);
  const baseF = (isBell ? 425 : isCrash ? 310 : 355) * (1 + (rng() - 0.5) * 0.02);
  const phases = CYMBAL_RATIOS.map(() => rng() * TWO_PI);
  let pPing1 = 0, pPing2 = 0;

  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const n = noiseSample(rng);
    let metal = 0;
    for (let k = 0; k < CYMBAL_RATIOS.length; k++) {
      phases[k] += TWO_PI * (baseF * CYMBAL_RATIOS[k] + n * 240) / SR;
      metal += Math.sin(phases[k]) * (0.18 / Math.sqrt(k + 1));
    }
    pPing1 += TWO_PI * (isBell ? 2680 : 3240) / SR;
    pPing2 += TWO_PI * (isBell ? 4190 : 5110) / SR;
    const atk = 1 - Math.exp(-t / 0.0006);
    const ping = (Math.sin(pPing1) * 0.65 + Math.sin(pPing2) * 0.4) * atk * Math.exp(-t / (isBell ? 0.075 : 0.035)) * (isCrash ? 0.15 : isBell ? 0.55 : 0.34);
    const wash = (washBP(metal * 0.5 + n * 0.65) * 0.85 + airHP(n) * 0.38) * (1 - Math.exp(-t / 0.0025)) * Math.exp(-t / tau);
    out[i] = (ping + wash) * (0.28 + 0.72 * vel);
  }
  return out;
}

function synthPerc(vel, kind, rng) {
  if (kind === 'rim') {
    const len = Math.ceil(0.055 * SR);
    const out = new Float64Array(len);
    const bp = makeBiquad('bandpass', 1850, 3.8);
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      const body = (Math.sin(TWO_PI * 860 * t) * 0.55 + Math.sin(TWO_PI * 1640 * t) * 0.45) * Math.exp(-t / 0.008);
      const click = bp(noiseSample(rng)) * Math.exp(-t / 0.004) * 0.7;
      out[i] = (body + click) * vel;
    }
    return out;
  }
  if (kind === 'tamb') {
    const len = Math.ceil(0.16 * SR);
    const out = new Float64Array(len);
    const bp1 = makeBiquad('bandpass', 7200, 2.4);
    const bp2 = makeBiquad('bandpass', 11200, 2.0);
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      const n = noiseSample(rng);
      const burst = Math.exp(-t / 0.024) + 0.65 * Math.exp(-Math.max(0, t - 0.016) / 0.034) * (t >= 0.016 ? 1 : 0);
      out[i] = (bp1(n) * 0.7 + bp2(n) * 0.6) * burst * vel * 0.62;
    }
    return out;
  }
  // shaker
  const len = Math.ceil(0.075 * SR);
  const out = new Float64Array(len);
  const bp = makeBiquad('bandpass', 6200, 1.5);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.008) * Math.exp(-Math.max(0, t - 0.008) / 0.018);
    out[i] = bp(noiseSample(rng)) * env * vel * 0.48;
  }
  return out;
}

/* ---------- Stereo acoustic studio room ---------- */
function buildRoomIR(decaySec, brightHz, seed) {
  const rng = mulberry32(seed);
  const len = Math.ceil(decaySec * SR);
  const irL = new Float64Array(len);
  const irR = new Float64Array(len);
  // Early reflections (studio room walls + floor + ceiling)
  const erTimesMs = [4.3, 6.8, 9.7, 13.1, 16.4, 20.9, 25.3, 30.8, 36.2];
  erTimesMs.forEach((ms, idx) => {
    const posL = Math.round((ms + (idx % 2 ? 0.6 : 0)) * SR / 1000);
    const posR = Math.round((ms + (idx % 2 ? 0 : 0.75)) * SR / 1000);
    const amp = 0.34 * Math.pow(0.84, idx);
    const sign = idx % 2 === 0 ? 1 : -1;
    if (posL < len) irL[posL] += amp * sign;
    if (posR < len) irR[posR] += amp * -sign;
  });
  // Diffuse tail
  const hpL = makeBiquad('highpass', 180, 0.7), hpR = makeBiquad('highpass', 180, 0.7);
  const lpL = makeBiquad('lowpass', brightHz, 0.7), lpR = makeBiquad('lowpass', brightHz, 0.7);
  for (let i = Math.round(0.014 * SR); i < len; i++) {
    const t = i / SR;
    const env = Math.min(1, (t - 0.014) / 0.025) * Math.pow(1 - t / decaySec, 2.6);
    irL[i] += lpL(hpL(noiseSample(rng))) * env * 0.11;
    irR[i] += lpR(hpR(noiseSample(rng))) * env * 0.11;
  }
  return [irL, irR];
}

// Fast time-domain stereo convolution with sparse early reflections + short room tail
// Decimate-free direct convolution on ~0.35s tail would be expensive in pure JS, so we use
// a multi-tap Schroeder/FDN-style stereo studio room (12 early taps + 4 decorrelated comb/allpass tanks).
function applyStudioRoom(dryL, dryR, { wet, decay, brightHz, seed }) {
  const n = dryL.length;
  const rng = mulberry32(seed);
  const [irL, irR] = buildRoomIR(0.055, brightHz, seed + 7);
  const sendL = new Float64Array(n);
  const sendR = new Float64Array(n);
  const hpL = makeBiquad('highpass', 145, 0.7);
  const hpR = makeBiquad('highpass', 145, 0.7);
  const lpL = makeBiquad('lowpass', brightHz, 0.7);
  const lpR = makeBiquad('lowpass', brightHz, 0.7);
  for (let i = 0; i < n; i++) {
    sendL[i] = lpL(hpL(dryL[i] * 0.8 + dryR[i] * 0.2));
    sendR[i] = lpR(hpR(dryR[i] * 0.8 + dryL[i] * 0.2));
  }
  // Early reflections
  const wetL = new Float64Array(n);
  const wetR = new Float64Array(n);
  const tapsL = [], tapsR = [];
  for (let i = 0; i < irL.length; i++) {
    if (Math.abs(irL[i]) > 0.03) tapsL.push([i, irL[i]]);
    if (Math.abs(irR[i]) > 0.03) tapsR.push([i, irR[i]]);
  }
  for (let i = 0; i < n; i++) {
    let sL = 0, sR = 0;
    for (let k = 0; k < tapsL.length; k++) { const d = i - tapsL[k][0]; if (d >= 0) sL += sendL[d] * tapsL[k][1]; }
    for (let k = 0; k < tapsR.length; k++) { const d = i - tapsR[k][0]; if (d >= 0) sR += sendR[d] * tapsR[k][1]; }
    wetL[i] = sL * 0.55;
    wetR[i] = sR * 0.55;
  }
  // 4-channel Householder FDN stereo room tail (dense, metallic-free, natural decay)
  const delays = [1051, 1361, 1747, 2179];
  const bufs = delays.map(d => new Float64Array(d));
  const idxs = [0, 0, 0, 0];
  const damp = [0, 0, 0, 0];
  const dampCoef = Math.exp(-TWO_PI * (brightHz * 0.72) / SR);
  const fb = delays.map(d => Math.pow(0.001, (d / SR) / decay));
  for (let i = 0; i < n; i++) {
    const inL = sendL[i] + wetL[i] * 0.35;
    const inR = sendR[i] + wetR[i] * 0.35;
    const y = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
      const raw = bufs[c][idxs[c]];
      damp[c] = raw * (1 - dampCoef) + damp[c] * dampCoef;
      y[c] = damp[c] * fb[c];
    }
    const sum = (y[0] + y[1] + y[2] + y[3]) * 0.5;
    const next = [y[0] - sum + inL * 0.55, y[1] - sum + inR * 0.55, y[2] - sum + inL * 0.45, y[3] - sum - inR * 0.45];
    for (let c = 0; c < 4; c++) {
      bufs[c][idxs[c]] = next[c];
      idxs[c] = (idxs[c] + 1) % delays[c];
    }
    wetL[i] += (y[0] + y[2] - y[1] * 0.25) * 0.42;
    wetR[i] += (y[1] - y[3] + y[0] * 0.25) * 0.42;
  }
  const outL = new Float64Array(n);
  const outR = new Float64Array(n);
  const jit = 1 + (rng() - 0.5) * 0.001;
  for (let i = 0; i < n; i++) {
    outL[i] = dryL[i] + wetL[i] * wet * jit;
    outR[i] = dryR[i] + wetR[i] * wet * jit;
  }
  return [outL, outR];
}

/* ---------- Parallel bus compressor + vintage console saturation ---------- */
function masterBus(inL, inR, { threshDb, ratio, atkMs, relMs, parallelMix, drive, lowBoostDb, midBoostHz, midBoostDb }) {
  const n = inL.length;
  const outL = new Float64Array(n);
  const outR = new Float64Array(n);
  const atk = Math.exp(-1 / (SR * atkMs * 0.001));
  const rel = Math.exp(-1 / (SR * relMs * 0.001));
  const thresh = Math.pow(10, threshDb / 20);
  const slope = 1 - 1 / ratio;
  let env = 0;

  for (let i = 0; i < n; i++) {
    const peak = Math.max(Math.abs(inL[i]), Math.abs(inR[i]));
    env = peak > env ? atk * env + (1 - atk) * peak : rel * env + (1 - rel) * peak;
    const gr = env > thresh ? Math.pow(env / thresh, -slope) : 1;
    const makeup = Math.pow(10, (-threshDb * slope * 0.42) / 20);
    const compL = inL[i] * gr * makeup;
    const compR = inR[i] * gr * makeup;
    outL[i] = inL[i] * (1 - parallelMix) + compL * parallelMix;
    outR[i] = inR[i] * (1 - parallelMix) + compR * parallelMix;
  }

  // Musical console EQ (low punch + snare presence + smooth high rolloff + DC block)
  for (const ch of [outL, outR]) {
    filterInPlace(ch, 'highpass', 28, 0.707);
    filterInPlace(ch, 'lowshelf', 92, 0.7, lowBoostDb);
    filterInPlace(ch, 'peaking', midBoostHz, 1.1, midBoostDb);
    filterInPlace(ch, 'lowpass', 16500, 0.707);
  }

  // Warm asymmetric analog saturation
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    outL[i] = (Math.tanh((outL[i] + 0.03 * outL[i] * outL[i]) * drive) / norm);
    outR[i] = (Math.tanh((outR[i] + 0.03 * outR[i] * outR[i]) * drive) / norm);
  }
  filterInPlace(outL, 'highpass', 24, 0.707);
  filterInPlace(outR, 'highpass', 24, 0.707);
  return [outL, outR];
}

/* ---------- Pattern renderer (with hi-hat choke + 2-pass seamless loop wrap) ---------- */
function renderBreak(spec) {
  const rng = mulberry32(spec.seed);
  const loopSec = (spec.bars * 4 * 60) / spec.bpm;
  const loopFrames = Math.round(loopSec * SR);
  const stepFrames = loopFrames / (spec.bars * 16);
  const xfade = 64; // ~1.45 ms safety seam crossfade
  const totalFrames = loopFrames * 2 + xfade + Math.ceil(SR * 0.5);

  const dryL = new Float64Array(totalFrames);
  const dryR = new Float64Array(totalFrames);
  const hatL = new Float64Array(totalFrames);
  const hatR = new Float64Array(totalFrames);

  // Precompute deterministic per-event humanization once so pass 0, 1, 2 align identically at the seam
  const humanEvents = spec.events.map(ev => {
    const jitterMs = ev.step === 0 ? 0 : (ev.jitter ?? spec.humanJitterMs) * (rng() * 2 - 1);
    const offsetMs = (ev.offsetMs || 0) + jitterMs;
    const vel = Math.max(0.08, Math.min(1, ev.vel * (1 + (rng() - 0.5) * 0.06)));
    return { ...ev, offsetMs, vel };
  });

  // Schedule 3 passes (pass 0 warms up room/comp, pass 1 is extracted, pass 2 supplies tiny seam continuation)
  const hatEvents = [];
  for (let pass = 0; pass < 3; pass++) {
    const passOffset = pass * loopFrames;
    const passRng = mulberry32(spec.seed + 997); // identical synthesis seed across passes for phase-exact seam
    for (const ev of humanEvents) {
      if (pass === 2 && ev.step >= 2) continue;
      const start = Math.max(0, Math.round(passOffset + ev.step * stepFrames + ev.offsetMs * SR / 1000));
      if (start >= totalFrames) continue;

      if (ev.type === 'kick') {
        const s = synthKick(spec.kit, ev.vel, passRng);
        mixMonoIntoStereo(dryL, dryR, s, start, spec.mix.kick, 0.0);
      } else if (ev.type === 'snare') {
        const s = synthSnare(spec.kit, ev.vel, ev.style || 'main', passRng, ev.hand || 0);
        mixMonoIntoStereo(dryL, dryR, s, start, spec.mix.snare, -0.07);
      } else if (ev.type === 'hat') {
        hatEvents.push({ start, vel: ev.vel, kind: ev.kind });
      } else if (ev.type === 'ride') {
        const s = synthRide(spec.kit, ev.vel, ev.kind || 'bow', passRng);
        mixMonoIntoStereo(dryL, dryR, s, start, spec.mix.ride, ev.kind === 'crash' ? 0.16 : 0.28);
      } else if (ev.type === 'perc') {
        const s = synthPerc(ev.vel, ev.kind, passRng);
        mixMonoIntoStereo(dryL, dryR, s, start, spec.mix.perc, ev.kind === 'rim' ? -0.18 : 0.22);
      }
    }
  }

  // Render hi-hats sequentially with physical choke group (closed/pedal smoothly chokes open hats)
  hatEvents.sort((a, b) => a.start - b.start);
  const chokeFrames = Math.round(0.007 * SR);
  for (let i = 0; i < hatEvents.length; i++) {
    const ev = hatEvents[i];
    const s = synthHiHat(spec.kit, ev.vel, ev.kind, rng);
    if (ev.kind === 'ohh' || ev.kind === 'hhh') {
      const nextClose = hatEvents.find((o, j) => j > i && (o.kind === 'chh' || o.kind === 'pedal'));
      if (nextClose) {
        const cutAt = nextClose.start - ev.start;
        if (cutAt >= 0 && cutAt < s.length) {
          for (let k = cutAt; k < s.length; k++) {
            const u = (k - cutAt) / chokeFrames;
            s[k] *= u >= 1 ? 0 : Math.cos(u * Math.PI * 0.5);
          }
        }
      }
    }
    mixMonoIntoStereo(hatL, hatR, s, ev.start, spec.mix.hat, -0.26);
  }
  for (let i = 0; i < totalFrames; i++) { dryL[i] += hatL[i]; dryR[i] += hatR[i]; }

  // Shared acoustic room + bus processing across full continuous render
  const [roomL, roomR] = applyStudioRoom(dryL, dryR, spec.room);
  const [busL, busR] = masterBus(roomL, roomR, spec.bus);

  // Extract steady-state Pass 2 [loopFrames, 2 * loopFrames) with seamless 64-sample seam blend
  const outL = new Float64Array(loopFrames);
  const outR = new Float64Array(loopFrames);
  for (let i = 0; i < loopFrames; i++) {
    outL[i] = busL[loopFrames + i];
    outR[i] = busR[loopFrames + i];
  }
  for (let i = 0; i < xfade; i++) {
    const a = i / xfade;
    outL[i] = busL[loopFrames * 2 + i] * (1 - a) + outL[i] * a;
    outR[i] = busR[loopFrames * 2 + i] * (1 - a) + outR[i] * a;
  }

  // Consistent gain staging: target balanced RMS while capping peak strictly at -1.0 dBFS (0.891)
  let peak = 0, sumSq = 0;
  for (let i = 0; i < loopFrames; i++) {
    peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i]));
    sumSq += outL[i] * outL[i] + outR[i] * outR[i];
  }
  const rms = Math.sqrt(sumSq / (loopFrames * 2));
  const targetRms = Math.pow(10, spec.targetRmsDb / 20);
  const maxPeak = Math.pow(10, -1.0 / 20); // -1.0 dBFS = 0.89125
  const gain = Math.min(targetRms / Math.max(rms, 1e-6), maxPeak / Math.max(peak, 1e-6));

  let finalPeak = 0, finalSq = 0;
  for (let i = 0; i < loopFrames; i++) {
    // Gentle safety soft-ceiling above 0.88 so peak never clips even slightly
    outL[i] = Math.max(-maxPeak, Math.min(maxPeak, outL[i] * gain));
    outR[i] = Math.max(-maxPeak, Math.min(maxPeak, outR[i] * gain));
    finalPeak = Math.max(finalPeak, Math.abs(outL[i]), Math.abs(outR[i]));
    finalSq += outL[i] * outL[i] + outR[i] * outR[i];
  }
  const finalRmsDb = 20 * Math.log10(Math.sqrt(finalSq / (loopFrames * 2)));
  const finalPeakDb = 20 * Math.log10(finalPeak);
  const seamJump = Math.max(Math.abs(outL[loopFrames - 1] - outL[0]), Math.abs(outR[loopFrames - 1] - outR[0]));

  return { outL, outR, loopFrames, loopSec, finalRmsDb, finalPeakDb, seamJump };
}

function encodeWav16Stereo(L, R, sampleRate = SR) {
  const frames = L.length;
  const dataBytes = frames * 4;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20);  // PCM format
  buf.writeUInt16LE(2, 22);  // stereo
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28);
  buf.writeUInt16LE(4, 32);  // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i++) {
    const o = 44 + i * 4;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), o);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), o + 2);
  }
  return buf;
}

/* =========================================================
   Three original built-in breaks (2 bars = 32 16th-steps)
   ========================================================= */

const BREAK_SPECS = [
  {
    id: 'brk-builtin-tight',
    file: 'assets/breaks/tight.wav',
    name: 'TIGHT',
    bpm: 120,
    bars: 2,
    seed: 120471,
    humanJitterMs: 1.0,
    targetRmsDb: -11.5,
    kit: {
      kickBase: 51, kickDrop: 138, kickPitchTau: 0.028, kickBodyTau: 0.145, kickDecay: 0.30,
      kickWarmth: 0.16, kickBeaterHz: 3300, kickBeaterAmt: 0.62, kickShellHz: 155, kickShellAmt: 0.18, kickDrive: 1.65,
      snareHz: 222, snareDecay: 0.24, snareHeadTau: 0.044, snareWireTau: 0.068,
      wireLowHz: 1750, wireMidHz: 4500, wireHighHz: 8200, wireAmt: 0.92, rimRingHz: 870, snareDrive: 1.55,
      chhTau: 0.032, ohhTau: 0.19, hatBaseHz: 350, hatBrightHz: 9400,
    },
    mix: { kick: 0.96, snare: 0.90, hat: 0.44, ride: 0.30, perc: 0.34 },
    room: { wet: 0.19, decay: 0.22, brightHz: 5400, seed: 311 },
    bus: { threshDb: -15, ratio: 4.0, atkMs: 5, relMs: 65, parallelMix: 0.50, drive: 1.35, lowBoostDb: 2.5, midBoostHz: 2900, midBoostDb: 1.8 },
    events: [
      // Bar 1: Crisp, punchy, precise pocket with controlled syncopation
      { step: 0, type: 'kick', vel: 0.98 },
      { step: 0, type: 'hat', kind: 'chh', vel: 0.85 },
      { step: 2, type: 'hat', kind: 'chh', vel: 0.56 },
      { step: 3, type: 'hat', kind: 'chh', vel: 0.34 },
      { step: 4, type: 'snare', style: 'main', vel: 0.96 },
      { step: 4, type: 'hat', kind: 'chh', vel: 0.72 },
      { step: 6, type: 'hat', kind: 'chh', vel: 0.55 },
      { step: 7, type: 'kick', vel: 0.76 },
      { step: 8, type: 'hat', kind: 'chh', vel: 0.82 },
      { step: 9, type: 'snare', style: 'ghost', vel: 0.26, hand: 1 },
      { step: 10, type: 'kick', vel: 0.92 },
      { step: 10, type: 'hat', kind: 'chh', vel: 0.62 },
      { step: 11, type: 'hat', kind: 'chh', vel: 0.34 },
      { step: 12, type: 'snare', style: 'rimshot', vel: 0.95 },
      { step: 12, type: 'hat', kind: 'chh', vel: 0.68 },
      { step: 14, type: 'hat', kind: 'ohh', vel: 0.68 },
      { step: 15, type: 'snare', style: 'ghost', vel: 0.32, hand: 1 },
      // Bar 2: Tight turnaround with crisp syncopated skip & rim accent
      { step: 16, type: 'kick', vel: 0.96 },
      { step: 16, type: 'hat', kind: 'chh', vel: 0.88 },
      { step: 18, type: 'hat', kind: 'chh', vel: 0.56 },
      { step: 19, type: 'perc', kind: 'rim', vel: 0.38 },
      { step: 20, type: 'snare', style: 'main', vel: 0.96 },
      { step: 20, type: 'hat', kind: 'chh', vel: 0.72 },
      { step: 22, type: 'kick', vel: 0.80 },
      { step: 22, type: 'hat', kind: 'chh', vel: 0.52 },
      { step: 23, type: 'hat', kind: 'chh', vel: 0.42 },
      { step: 24, type: 'hat', kind: 'chh', vel: 0.80 },
      { step: 25, type: 'snare', style: 'ghost', vel: 0.30, hand: 1 },
      { step: 26, type: 'kick', vel: 0.90 },
      { step: 26, type: 'hat', kind: 'chh', vel: 0.64 },
      { step: 28, type: 'snare', style: 'rimshot', vel: 0.98 },
      { step: 28, type: 'hat', kind: 'chh', vel: 0.68 },
      { step: 29, type: 'kick', vel: 0.66 },
      { step: 30, type: 'hat', kind: 'ohh', vel: 0.72 },
      { step: 31, type: 'snare', style: 'roll', vel: 0.62, hand: 1 },
      { step: 31, type: 'hat', kind: 'chh', vel: 0.45 },
    ],
  },
  {
    id: 'brk-builtin-funky',
    file: 'assets/breaks/funky.wav',
    name: 'FUNKY',
    bpm: 105,
    bars: 2,
    seed: 105883,
    humanJitterMs: 2.8,
    targetRmsDb: -11.4,
    kit: {
      kickBase: 57, kickDrop: 120, kickPitchTau: 0.036, kickBodyTau: 0.175, kickDecay: 0.35,
      kickWarmth: 0.24, kickBeaterHz: 2550, kickBeaterAmt: 0.46, kickShellHz: 135, kickShellAmt: 0.24, kickDrive: 1.80,
      snareHz: 196, snareDecay: 0.28, snareHeadTau: 0.056, snareWireTau: 0.088,
      wireLowHz: 1450, wireMidHz: 3900, wireHighHz: 7400, wireAmt: 0.98, rimRingHz: 775, snareDrive: 1.65,
      chhTau: 0.040, ohhTau: 0.25, hatBaseHz: 325, hatBrightHz: 8400,
    },
    mix: { kick: 0.92, snare: 0.88, hat: 0.46, ride: 0.26, perc: 0.36 },
    room: { wet: 0.30, decay: 0.36, brightHz: 4800, seed: 523 },
    bus: { threshDb: -16.5, ratio: 4.2, atkMs: 7, relMs: 88, parallelMix: 0.56, drive: 1.55, lowBoostDb: 3.0, midBoostHz: 2350, midBoostDb: 1.5 },
    events: (() => {
      // Loose swung pocket: off-16ths pushed late by ~14ms, backbeats slightly relaxed (+4ms)
      const sw = s => (s % 2 === 1 ? 14 : 0);
      return [
        // Bar 1: Loose funky syncopation + expressive ghost notes + open-hat barks
        { step: 0, type: 'kick', vel: 0.96 },
        { step: 0, type: 'hat', kind: 'chh', vel: 0.82 },
        { step: 1, type: 'hat', kind: 'chh', vel: 0.34, offsetMs: sw(1) },
        { step: 2, type: 'kick', vel: 0.58, offsetMs: 4 },
        { step: 2, type: 'hat', kind: 'chh', vel: 0.62 },
        { step: 2, type: 'perc', kind: 'tamb', vel: 0.42 },
        { step: 3, type: 'hat', kind: 'chh', vel: 0.40, offsetMs: sw(3) },
        { step: 4, type: 'snare', style: 'main', vel: 0.94, offsetMs: 4 },
        { step: 4, type: 'hat', kind: 'chh', vel: 0.68 },
        { step: 5, type: 'hat', kind: 'chh', vel: 0.32, offsetMs: sw(5) },
        { step: 6, type: 'kick', vel: 0.78, offsetMs: -2 },
        { step: 6, type: 'hat', kind: 'ohh', vel: 0.72 },
        { step: 6, type: 'perc', kind: 'tamb', vel: 0.46 },
        { step: 7, type: 'snare', style: 'ghost', vel: 0.30, hand: 1, offsetMs: sw(7) },
        { step: 8, type: 'hat', kind: 'pedal', vel: 0.62 },
        { step: 9, type: 'snare', style: 'ghost', vel: 0.36, hand: 0, offsetMs: sw(9) },
        { step: 10, type: 'kick', vel: 0.88, offsetMs: 2 },
        { step: 10, type: 'hat', kind: 'chh', vel: 0.72 },
        { step: 10, type: 'perc', kind: 'tamb', vel: 0.40 },
        { step: 11, type: 'snare', style: 'ghost', vel: 0.24, hand: 1, offsetMs: sw(11) },
        { step: 12, type: 'snare', style: 'rimshot', vel: 0.92, offsetMs: 5 },
        { step: 12, type: 'hat', kind: 'chh', vel: 0.66 },
        { step: 13, type: 'hat', kind: 'chh', vel: 0.36, offsetMs: sw(13) },
        { step: 14, type: 'hat', kind: 'ohh', vel: 0.74 },
        { step: 14, type: 'perc', kind: 'tamb', vel: 0.48 },
        { step: 15, type: 'snare', style: 'ghost', vel: 0.38, hand: 1, offsetMs: sw(15) },
        // Bar 2: Syncopated kick push, expressive ghost flurry & offbeat accent turnaround
        { step: 16, type: 'kick', vel: 0.94 },
        { step: 16, type: 'hat', kind: 'pedal', vel: 0.66 },
        { step: 16, type: 'hat', kind: 'chh', vel: 0.76 },
        { step: 17, type: 'perc', kind: 'shaker', vel: 0.48, offsetMs: sw(17) },
        { step: 18, type: 'hat', kind: 'chh', vel: 0.60 },
        { step: 18, type: 'perc', kind: 'tamb', vel: 0.42 },
        { step: 19, type: 'kick', vel: 0.72, offsetMs: sw(19) },
        { step: 20, type: 'snare', style: 'main', vel: 0.95, offsetMs: 4 },
        { step: 20, type: 'hat', kind: 'chh', vel: 0.65 },
        { step: 21, type: 'snare', style: 'ghost', vel: 0.25, hand: 1, offsetMs: sw(21) },
        { step: 22, type: 'kick', vel: 0.82 },
        { step: 22, type: 'hat', kind: 'hhh', vel: 0.64 },
        { step: 22, type: 'perc', kind: 'tamb', vel: 0.44 },
        { step: 23, type: 'snare', style: 'ghost', vel: 0.36, hand: 0, offsetMs: sw(23) },
        { step: 24, type: 'hat', kind: 'ohh', vel: 0.70 },
        { step: 25, type: 'snare', style: 'ghost', vel: 0.32, hand: 1, offsetMs: sw(25) },
        { step: 26, type: 'kick', vel: 0.90 },
        { step: 26, type: 'hat', kind: 'chh', vel: 0.74 },
        { step: 26, type: 'perc', kind: 'tamb', vel: 0.42 },
        { step: 27, type: 'snare', style: 'ghost', vel: 0.28, hand: 0, offsetMs: sw(27) },
        { step: 28, type: 'snare', style: 'main', vel: 0.90, offsetMs: 5 },
        { step: 28, type: 'hat', kind: 'chh', vel: 0.66 },
        { step: 29, type: 'perc', kind: 'rim', vel: 0.44, offsetMs: sw(29) },
        { step: 30, type: 'snare', style: 'rimshot', vel: 0.74, offsetMs: 2 },
        { step: 30, type: 'hat', kind: 'ohh', vel: 0.68 },
        { step: 31, type: 'snare', style: 'ghost', vel: 0.34, hand: 1, offsetMs: sw(31) },
      ];
    })(),
  },
  {
    id: 'brk-builtin-jungle',
    file: 'assets/breaks/jungle.wav',
    name: 'RUFF JUNGLE',
    bpm: 160,
    bars: 2,
    seed: 160909,
    humanJitterMs: 1.4,
    targetRmsDb: -10.8,
    kit: {
      kickBase: 55, kickDrop: 155, kickPitchTau: 0.025, kickBodyTau: 0.125, kickDecay: 0.26,
      kickWarmth: 0.20, kickBeaterHz: 3700, kickBeaterAmt: 0.74, kickShellHz: 175, kickShellAmt: 0.22, kickDrive: 2.05,
      snareHz: 268, snareDecay: 0.25, snareHeadTau: 0.042, snareWireTau: 0.078,
      wireLowHz: 1950, wireMidHz: 5100, wireHighHz: 8800, wireAmt: 1.05, rimRingHz: 945, snareDrive: 1.95,
      chhTau: 0.028, ohhTau: 0.16, hatBaseHz: 390, hatBrightHz: 10200,
    },
    mix: { kick: 0.94, snare: 0.94, hat: 0.44, ride: 0.48, perc: 0.32 },
    room: { wet: 0.34, decay: 0.40, brightHz: 6200, seed: 907 },
    bus: { threshDb: -18, ratio: 5.2, atkMs: 3.5, relMs: 55, parallelMix: 0.64, drive: 1.85, lowBoostDb: 2.8, midBoostHz: 3250, midBoostDb: 2.6 },
    events: [
      // Bar 1: Raw high-energy jungle break — double kicks, cracking snares, shimmering ride
      { step: 0, type: 'kick', vel: 1.0 },
      { step: 0, type: 'ride', kind: 'bow', vel: 0.85 },
      { step: 1, type: 'hat', kind: 'chh', vel: 0.46 },
      { step: 2, type: 'kick', vel: 0.82 },
      { step: 2, type: 'ride', kind: 'bow', vel: 0.68 },
      { step: 3, type: 'hat', kind: 'chh', vel: 0.42 },
      { step: 4, type: 'snare', style: 'rimshot', vel: 1.0, hand: 0 },
      { step: 4, type: 'ride', kind: 'bow', vel: 0.78 },
      { step: 5, type: 'hat', kind: 'chh', vel: 0.44 },
      { step: 6, type: 'ride', kind: 'bell', vel: 0.82 },
      { step: 7, type: 'snare', style: 'roll', vel: 0.64, hand: 1 },
      { step: 8, type: 'ride', kind: 'bow', vel: 0.76 },
      { step: 8, type: 'perc', kind: 'shaker', vel: 0.55 },
      { step: 9, type: 'snare', style: 'roll', vel: 0.72, hand: 0 },
      { step: 10, type: 'kick', vel: 0.94 },
      { step: 10, type: 'ride', kind: 'bow', vel: 0.72 },
      { step: 11, type: 'kick', vel: 0.78 },
      { step: 11, type: 'hat', kind: 'chh', vel: 0.48 },
      { step: 12, type: 'snare', style: 'rimshot', vel: 0.98, hand: 1 },
      { step: 12, type: 'ride', kind: 'bow', vel: 0.80 },
      { step: 13, type: 'hat', kind: 'chh', vel: 0.45 },
      { step: 14, type: 'ride', kind: 'bell', vel: 0.84 },
      { step: 14, type: 'hat', kind: 'ohh', vel: 0.52 },
      { step: 15, type: 'snare', style: 'roll', vel: 0.68, hand: 0 },
      // Bar 2: Driving crash/ride + chopped offbeat snares + rapid 32nd-note rolling turnaround
      { step: 16, type: 'kick', vel: 0.98 },
      { step: 16, type: 'ride', kind: 'crash', vel: 0.74 },
      { step: 16, type: 'hat', kind: 'chh', vel: 0.64 },
      { step: 17, type: 'hat', kind: 'chh', vel: 0.44 },
      { step: 18, type: 'kick', vel: 0.84 },
      { step: 18, type: 'ride', kind: 'bow', vel: 0.74 },
      { step: 19, type: 'hat', kind: 'chh', vel: 0.48 },
      { step: 20, type: 'snare', style: 'rimshot', vel: 1.0, hand: 0 },
      { step: 20, type: 'ride', kind: 'bow', vel: 0.82 },
      { step: 21, type: 'snare', style: 'ghost', vel: 0.34, hand: 1 },
      { step: 22, type: 'ride', kind: 'bell', vel: 0.80 },
      { step: 23, type: 'snare', style: 'roll', vel: 0.74, hand: 0 },
      { step: 24, type: 'ride', kind: 'bow', vel: 0.76 },
      { step: 25, type: 'snare', style: 'roll', vel: 0.78, hand: 1 },
      { step: 26, type: 'kick', vel: 0.95 },
      { step: 26, type: 'ride', kind: 'bow', vel: 0.72 },
      { step: 27, type: 'snare', style: 'ghost', vel: 0.42, hand: 0 },
      { step: 28, type: 'snare', style: 'rimshot', vel: 0.96, hand: 1 },
      { step: 28, type: 'ride', kind: 'bell', vel: 0.86 },
      // Rolling 32nd-note snare crescendo into bar 1
      { step: 29.0, type: 'snare', style: 'ghost', vel: 0.38, hand: 0 },
      { step: 29.5, type: 'snare', style: 'roll', vel: 0.48, hand: 1 },
      { step: 30.0, type: 'snare', style: 'roll', vel: 0.62, hand: 0 },
      { step: 30.5, type: 'snare', style: 'roll', vel: 0.70, hand: 1 },
      { step: 31.0, type: 'snare', style: 'roll', vel: 0.82, hand: 0 },
      { step: 31.5, type: 'snare', style: 'rimshot', vel: 0.90, hand: 1 },
      { step: 30.0, type: 'hat', kind: 'ohh', vel: 0.56 },
      { step: 31.0, type: 'hat', kind: 'chh', vel: 0.52 },
    ],
  },
];

async function main() {
  for (const spec of BREAK_SPECS) {
    const outPath = resolve(ROOT, spec.file);
    await mkdir(dirname(outPath), { recursive: true });
    const res = renderBreak(spec);
    const wav = encodeWav16Stereo(res.outL, res.outR, SR);
    await writeFile(outPath, wav);
    console.log(
      `${spec.name.padEnd(12)} ${spec.bpm} BPM  ${spec.bars} bars  ` +
      `${res.loopFrames} frames (${res.loopSec.toFixed(4)}s)  ` +
      `${(wav.byteLength / 1024).toFixed(1)} KB  ` +
      `RMS ${res.finalRmsDb.toFixed(1)} dBFS  Peak ${res.finalPeakDb.toFixed(2)} dBFS  ` +
      `Seam Δ ${res.seamJump.toFixed(4)}`
    );
  }
}

main().catch(err => { console.error(err); process.exit(1); });
