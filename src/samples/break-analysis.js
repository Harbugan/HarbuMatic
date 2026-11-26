// Local, deterministic WAV validation and drum-break analysis for RUFF (v0.7 PR35).
// Pure JavaScript: zero DOM, zero Web Audio API, zero network/API dependencies.
//
// Design principles:
// - Never modifies original audio bytes or PCM samples.
// - Estimates BPM and bar length (1, 2 or 4 bars) deterministically from duration + onset pulse.
// - Explicitly surfaces half-time / double-time ambiguity and low-confidence estimates instead of
//   presenting uncertain guesses as facts.
// - Detects transient candidates into bounded, ordered slice boundaries [0, ..., 1] with a safe
//   even-grid fallback when audio lacks reliable transients (silent, flat, drone, noisy).
// - Computes factual per-slice audio features (position, energy, transient strength, low/high band
//   balance, beat placement) without pretending to have ML kick/snare classification.

import { defaultSlices, cleanSlices, MAX_SLICES, MIN_SLICE } from '../core/samples.js';
import { clamp } from '../core/util.js';

export const ALLOWED_BARS = Object.freeze([1, 2, 4]);
export const ANALYSIS_BPM_MIN = 50;
export const ANALYSIS_BPM_MAX = 200;
const PLAUSIBLE_BPM_MIN = 62;
const PLAUSIBLE_BPM_MAX = 196;

/**
 * Verify that `bytes` looks like a real RIFF/WAVE container (minimum 44-byte header with RIFF...WAVE).
 * Used to accept WAV files safely without mislabeling unrelated files before decoding.
 */
export function isWavBytes(bytes) {
  let u8;
  if (bytes instanceof Uint8Array) u8 = bytes;
  else if (bytes instanceof ArrayBuffer) u8 = new Uint8Array(bytes);
  else if (ArrayBuffer.isView(bytes)) u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  else return false;
  if (u8.byteLength < 44) return false;
  // "RIFF" at 0..3 and "WAVE" at 8..11
  return u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46
    && u8[8] === 0x57 && u8[9] === 0x41 && u8[10] === 0x56 && u8[11] === 0x45;
}

const r1 = x => Math.round(x * 10) / 10;
const r3 = x => Math.round(x * 1000) / 1000;
const r6 = x => Math.round(x * 1e6) / 1e6;

/** Mix down any AudioBuffer-like object to a mono Float32Array without mutating source channels. */
function toMono(buffer) {
  if (!buffer || !buffer.length) return new Float32Array(0);
  const n = buffer.length;
  const ch = Math.max(1, buffer.numberOfChannels || 1);
  if (ch === 1) return buffer.getChannelData(0);
  const out = new Float32Array(n);
  const inv = 1 / ch;
  for (let c = 0; c < ch; c++) {
    const src = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += src[i] * inv;
  }
  return out;
}

/**
 * Compute short-time RMS, low-band (< ~220 Hz) and high-band (> ~2.4 kHz) envelopes,
 * plus half-wave rectified onset flux on a ~5 ms hop grid.
 */
function computeEnvelopes(mono, sampleRate) {
  const n = mono.length;
  const sr = Math.max(8000, sampleRate || 44100);
  const hop = Math.max(64, Math.round(sr * 0.005)); // ~5 ms
  const win = Math.max(hop * 2, Math.round(sr * 0.015)); // ~15 ms
  const frames = Math.max(1, Math.floor(n / hop));

  const rms = new Float32Array(frames);
  const low = new Float32Array(frames);
  const high = new Float32Array(frames);

  // Simple 1-pole IIR filters for low (~220 Hz) and high (~2400 Hz) energy cues
  const alphaLow = 1 - Math.exp((-2 * Math.PI * 220) / sr);
  const alphaHi = 1 - Math.exp((-2 * Math.PI * 2400) / sr);
  let lp = 0;
  let hpLp = 0;
  const lowSig = new Float32Array(n);
  const highSig = new Float32Array(n);

  let peakAbs = 0;
  for (let i = 0; i < n; i++) {
    const x = mono[i];
    const ax = x < 0 ? -x : x;
    if (ax > peakAbs) peakAbs = ax;
    lp += alphaLow * (x - lp);
    hpLp += alphaHi * (x - hpLp);
    lowSig[i] = lp;
    highSig[i] = x - hpLp;
  }

  let meanRms = 0;
  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    const end = Math.min(n, start + win);
    const len = Math.max(1, end - start);
    let sAll = 0, sLow = 0, sHi = 0;
    for (let i = start; i < end; i++) {
      const a = mono[i], l = lowSig[i], h = highSig[i];
      sAll += a * a;
      sLow += l * l;
      sHi += h * h;
    }
    rms[f] = Math.sqrt(sAll / len);
    low[f] = Math.sqrt(sLow / len);
    high[f] = Math.sqrt(sHi / len);
    meanRms += rms[f];
  }
  meanRms /= frames;

  // Onset strength: half-wave rectified log-compressed energy rise (full + high-band accent)
  const onset = new Float32Array(frames);
  const eps = 1e-4;
  let maxOnset = 0;
  for (let f = 1; f < frames; f++) {
    const dAll = Math.max(0, Math.log1p(rms[f] * 30) - Math.log1p(rms[f - 1] * 30));
    const dHi = Math.max(0, Math.log1p(high[f] * 30) - Math.log1p(high[f - 1] * 30));
    const dLow = Math.max(0, Math.log1p(low[f] * 30) - Math.log1p(low[f - 1] * 30));
    // Weight positive attack across bands
    const val = (dAll + 0.55 * dHi + 0.35 * dLow) * (rms[f] > eps ? 1 : 0);
    onset[f] = val;
    if (val > maxOnset) maxOnset = val;
  }
  // Also allow an attack right at frame 0 if the break starts immediately on a hit
  if (rms[0] > meanRms * 0.45 && rms[0] > 0.015) {
    onset[0] = Math.max(maxOnset * 0.65, Math.log1p(rms[0] * 30) * 0.8);
    if (onset[0] > maxOnset) maxOnset = onset[0];
  }

  return { frames, hop, sr, rms, low, high, onset, peakAbs, meanRms, maxOnset };
}

/**
 * Pick local transient peaks above an adaptive moving threshold.
 * Returns normalized transient candidates [{ pos, frame, strength, energy, lowRatio, highRatio }].
 */
function pickTransients(env, duration) {
  const { frames, hop, sr, rms, low, high, onset, peakAbs, maxOnset } = env;
  if (peakAbs < 0.008 || maxOnset < 0.04 || frames < 4 || !(duration > 0)) return [];

  const radius = Math.max(4, Math.round((0.12 * sr) / hop)); // ±120 ms adaptive window
  const minGapFrames = Math.max(2, Math.round((0.055 * sr) / hop)); // 55 ms min spacing
  const globalFloor = maxOnset * 0.14;

  // Compute global RMS contrast (detect flat drones / constant noise)
  let sumR = 0, sumR2 = 0;
  for (let f = 0; f < frames; f++) { sumR += rms[f]; sumR2 += rms[f] * rms[f]; }
  const avgR = sumR / frames;
  const stdR = Math.sqrt(Math.max(0, sumR2 / frames - avgR * avgR));
  const cv = avgR > 1e-6 ? stdR / avgR : 0;
  // Flat steady-state signal (pure sine, continuous pad, steady noise) has very low envelope variance
  if (cv < 0.16 && maxOnset < 0.25) return [];

  const rawPeaks = [];
  for (let f = 0; f < frames; f++) {
    const v = onset[f];
    if (v < globalFloor) continue;
    // Strict local peak within ±2 frames
    let isPeak = true;
    for (let k = Math.max(0, f - 2); k <= Math.min(frames - 1, f + 2); k++) {
      if (k === f) continue;
      if (onset[k] > v || (k < f && onset[k] === v)) { isPeak = false; break; }
    }
    if (!isPeak) continue;

    // Adaptive local threshold
    const lo = Math.max(0, f - radius), hi = Math.min(frames - 1, f + radius);
    let locSum = 0;
    for (let k = lo; k <= hi; k++) locSum += onset[k];
    const locMean = locSum / (hi - lo + 1);
    const thresh = Math.max(globalFloor, locMean * 1.45 + maxOnset * 0.06);
    if (v < thresh && f > 1) continue;

    // Backtrack 1 frame if attack rose sharply on the preceding hop (tighter drum onset)
    const attackFrame = f > 0 && onset[f - 1] > v * 0.45 ? f - 1 : f;
    const pos = clamp((attackFrame * hop) / (duration * sr), 0, 1);
    const e = rms[f];
    const l = low[f];
    const h = high[f];
    const bandSum = l + h + 1e-6;
    rawPeaks.push({
      pos,
      frame: attackFrame,
      strength: clamp(v / maxOnset, 0, 1),
      energy: e,
      lowRatio: clamp(l / bandSum, 0, 1),
      highRatio: clamp(h / bandSum, 0, 1),
    });
  }

  // Non-maximum suppression within minGapFrames (strongest peak wins)
  const byStrength = [...rawPeaks].sort((a, b) => (b.strength - a.strength) || (a.frame - b.frame));
  const kept = [];
  for (const p of byStrength) {
    if (kept.some(q => Math.abs(q.frame - p.frame) < minGapFrames)) continue;
    kept.push(p);
  }
  kept.sort((a, b) => a.pos - b.pos);
  return kept;
}

/**
 * Score how cleanly detected transients align with an 8th- or 16th-note grid for `bars` bars,
 * plus onset-envelope autocorrelation at the beat lag.
 */
function scoreBarCandidate(bars, duration, env, transients) {
  const rawBpm = (bars * 4 * 60) / duration;
  const inRange = rawBpm >= ANALYSIS_BPM_MIN - 2 && rawBpm <= ANALYSIS_BPM_MAX + 2;
  const clampedBpm = clamp(r1(rawBpm), ANALYSIS_BPM_MIN, ANALYSIS_BPM_MAX);

  // Breakbeat tempo plausibility prior (gentle bell centered around ~125–155 BPM, strong across 85–175)
  let tempoPrior = 0;
  if (rawBpm >= 85 && rawBpm <= 178) {
    // Prefer classic breakbeat/jungle zone (95–172 BPM) slightly over extremes
    const dCenter = Math.abs(rawBpm - 132) / 60;
    tempoPrior = 1.0 - 0.28 * dCenter * dCenter;
  } else if (rawBpm >= PLAUSIBLE_BPM_MIN && rawBpm <= PLAUSIBLE_BPM_MAX) {
    tempoPrior = 0.52;
  } else if (inRange) {
    tempoPrior = 0.22;
  } else {
    tempoPrior = -1.5; // outside 50–200 BPM
  }

  // 1) Transient grid alignment (against 16th-note grid of `bars * 16` steps)
  const gridSteps = bars * 16;
  let gridScore = 0;
  if (transients.length >= 2) {
    let wSum = 0, alignSum = 0;
    for (const tr of transients) {
      const scaled = tr.pos * gridSteps;
      const dist = Math.abs(scaled - Math.round(scaled)); // 0 .. 0.5 of a 16th step
      const hitAlign = Math.max(0, 1 - dist / 0.28);
      // Slight bonus if strong hits land on 8th-note beats (even 16th index)
      const onEighth = Math.round(scaled) % 2 === 0 ? 1.08 : 0.96;
      const w = 0.35 + tr.strength;
      alignSum += hitAlign * onEighth * w;
      wSum += w;
    }
    gridScore = wSum > 0 ? clamp(alignSum / wSum, 0, 1) : 0;
  }

  // 2) Onset autocorrelation at beat lag (1 beat = 60 / rawBpm seconds)
  let pulseScore = 0;
  const { onset, frames, hop, sr } = env;
  const beatLag = Math.round(((60 / rawBpm) * sr) / hop);
  if (beatLag >= 4 && beatLag < frames - 2) {
    let num = 0, denA = 0, denB = 0;
    const lim = frames - beatLag;
    for (let f = 0; f < lim; f++) {
      const a = onset[f], b = onset[f + beatLag];
      num += a * b;
      denA += a * a;
      denB += b * b;
    }
    const denom = Math.sqrt(denA * denB);
    pulseScore = denom > 1e-6 ? clamp(num / denom, 0, 1) : 0;
  }

  // Slight structural tie-breaker favoring 2 bars (most common breakbeat phrase) when evidence is equal
  const barPrior = bars === 2 ? 0.09 : bars === 1 ? 0.04 : 0.03;

  const total = tempoPrior * 1.35 + gridScore * 0.75 + pulseScore * 0.7 + barPrior;
  return {
    bars,
    rawBpm: r1(rawBpm),
    bpm: clampedBpm,
    inRange,
    plausible: rawBpm >= PLAUSIBLE_BPM_MIN && rawBpm <= PLAUSIBLE_BPM_MAX,
    gridScore: r3(gridScore),
    pulseScore: r3(pulseScore),
    score: r3(total),
  };
}

/**
 * Build bounded, strictly increasing slice boundaries [0, ..., 1] from transient candidates,
 * with a clean fallback to equal grid slices when transient detection is unreliable.
 */
function buildSlices(transients, bars, fallbackNeeded) {
  const targetCount = bars === 1 ? 8 : MAX_SLICES; // 8 for 1 bar, 16 for 2 or 4 bars
  if (fallbackNeeded || transients.length < 3) {
    return { slices: defaultSlices(targetCount), fallback: true };
  }

  // Filter out points too close to 0 or 1 (0 and 1 are always outer bounds so zero audio is truncated)
  const edgePad = Math.max(MIN_SLICE * 3, 0.012);
  const inner = transients.filter(t => t.pos >= edgePad && t.pos <= 1 - edgePad);
  if (inner.length < 2) {
    return { slices: defaultSlices(targetCount), fallback: true };
  }

  // Pick up to (targetCount - 1) strongest interior transient boundaries, maintaining musical spacing
  const minSpacing = Math.max(MIN_SLICE * 4, 0.42 / targetCount);
  const byStrength = [...inner].sort((a, b) => (b.strength - a.strength) || (a.pos - b.pos));
  const picked = [];
  for (const tr of byStrength) {
    if (picked.length >= targetCount - 1) break;
    if (picked.some(p => Math.abs(p - tr.pos) < minSpacing)) continue;
    picked.push(r6(tr.pos));
  }
  picked.sort((a, b) => a - b);

  // If transients leave very few boundaries (< 3 slices), fallback to even grid so the break stays sliceable
  if (picked.length < 2) {
    return { slices: defaultSlices(targetCount), fallback: true };
  }

  const rawBounds = [0, ...picked, 1];
  const cleaned = cleanSlices(rawBounds);
  if (cleaned.length < 4) {
    return { slices: defaultSlices(targetCount), fallback: true };
  }
  return { slices: cleaned, fallback: false };
}

/** Format rhythmic bar.beat position string for a normalized position `pos` inside a `bars`-bar break. */
export function formatBreakBeatPos(pos, bars = 2) {
  const b = ALLOWED_BARS.includes(bars) ? bars : 2;
  const totalEighths = b * 8;
  const idx = clamp(Math.round(clamp(pos, 0, 1) * totalEighths), 0, totalEighths - 1);
  const bar = Math.floor(idx / 8) + 1;
  const beat = Math.floor((idx % 8) / 2) + 1;
  const off = idx % 2 === 1 ? '+' : '';
  return `${bar}.${beat}${off}`;
}

/**
 * Compute objective per-slice feature metadata from decoded audio and slice boundaries.
 * Never invents drum-class labels (kick/snare); reports factual position, energy, transient & band balance.
 */
export function extractSliceFeatures(buffer, slices, bars = 2) {
  const b = cleanSlices(slices);
  const count = Math.max(1, b.length - 1);
  const mono = toMono(buffer);
  const n = mono.length;
  const sr = Math.max(8000, (buffer && buffer.sampleRate) || 44100);

  if (!n) {
    return Array.from({ length: count }, (_, k) => ({
      pos: r6(b[k]),
      energy: 0.5,
      transient: 0.5,
      lowEnergy: 0.5,
      highEnergy: 0.5,
      beatPos: formatBreakBeatPos(b[k], bars),
    }));
  }

  const alphaLow = 1 - Math.exp((-2 * Math.PI * 220) / sr);
  const alphaHi = 1 - Math.exp((-2 * Math.PI * 2400) / sr);
  const attackLen = Math.max(32, Math.round(sr * 0.025)); // first 25 ms of slice

  const raw = [];
  let maxRms = 1e-6;
  let maxAttack = 1e-6;

  for (let k = 0; k < count; k++) {
    const s0 = clamp(Math.floor(b[k] * n), 0, n - 1);
    const s1 = clamp(Math.floor(b[k + 1] * n), s0 + 1, n);
    const len = Math.max(1, s1 - s0);
    const aEnd = Math.min(s1, s0 + attackLen);
    const aLen = Math.max(1, aEnd - s0);

    let sumAll = 0, sumAtk = 0, sumLow = 0, sumHi = 0;
    let lp = 0, hpLp = 0;
    for (let i = s0; i < s1; i++) {
      const x = mono[i];
      const x2 = x * x;
      sumAll += x2;
      if (i < aEnd) sumAtk += x2;
      lp += alphaLow * (x - lp);
      hpLp += alphaHi * (x - hpLp);
      const hi = x - hpLp;
      sumLow += lp * lp;
      sumHi += hi * hi;
    }
    const rmsVal = Math.sqrt(sumAll / len);
    const atkVal = Math.sqrt(sumAtk / aLen);
    const lowVal = Math.sqrt(sumLow / len);
    const hiVal = Math.sqrt(sumHi / len);
    if (rmsVal > maxRms) maxRms = rmsVal;
    if (atkVal > maxAttack) maxAttack = atkVal;
    raw.push({ pos: r6(b[k]), rmsVal, atkVal, lowVal, hiVal });
  }

  return raw.map(r => {
    const bandTotal = r.lowVal + r.hiVal + 1e-6;
    return {
      pos: r.pos,
      energy: r3(clamp(r.rmsVal / maxRms, 0, 1)),
      transient: r3(clamp(r.atkVal / maxAttack, 0, 1)),
      lowEnergy: r3(clamp(r.lowVal / bandTotal, 0, 1)),
      highEnergy: r3(clamp(r.hiVal / bandTotal, 0, 1)),
      beatPos: formatBreakBeatPos(r.pos, bars),
    };
  });
}

/**
 * Analyze a decoded AudioBuffer-like drum break locally and deterministically.
 *
 * Returns:
 * {
 *   bpm, bars, slices, sliceMeta,
 *   analysis: {
 *     estimatedBpm, estimatedBars, confidence, fallback,
 *     transientCount, ambiguity, candidates, note
 *   }
 * }
 */
export function analyzeBreakBuffer(buffer, { preferredBars = null } = {}) {
  const duration = buffer && buffer.duration > 0
    ? buffer.duration
    : (buffer && buffer.length && buffer.sampleRate ? buffer.length / buffer.sampleRate : 0);

  if (!(duration > 0) || !buffer || !buffer.length) {
    const bars = 2;
    const slices = defaultSlices(MAX_SLICES);
    return {
      bpm: 120,
      bars,
      slices,
      sliceMeta: extractSliceFeatures(null, slices, bars),
      analysis: {
        estimatedBpm: 120,
        estimatedBars: bars,
        confidence: 'low',
        fallback: true,
        transientCount: 0,
        ambiguity: null,
        candidates: [{ bars: 2, bpm: 120, rawBpm: 120 }],
        note: 'Audio duration unavailable — using 120 BPM / 2-bar even grid.',
      },
    };
  }

  const mono = toMono(buffer);
  const env = computeEnvelopes(mono, buffer.sampleRate);
  const transients = pickTransients(env, duration);

  const scored = ALLOWED_BARS.map(b => scoreBarCandidate(b, duration, env, transients));
  scored.sort((a, b) => (b.score - a.score) || (a.bars - b.bars));

  let best = scored[0];
  if (ALLOWED_BARS.includes(preferredBars)) {
    const pref = scored.find(c => c.bars === preferredBars);
    if (pref) best = pref;
  }

  // Detect half-time / double-time ambiguity among plausible 1/2/4-bar candidates
  const plausible = scored.filter(c => c.plausible);
  const halfOrDouble = plausible.filter(c => c.bars !== best.bars && (c.bars === best.bars * 2 || c.bars * 2 === best.bars));
  const ambiguity = halfOrDouble.length > 0
    ? {
      kind: 'half-double',
      alternatives: halfOrDouble.map(c => ({ bars: c.bars, bpm: c.bpm, factor: c.bars > best.bars ? 2 : 0.5 })),
    }
    : null;

  const unreliableTransients = transients.length < 3 || env.peakAbs < 0.015;
  const { slices, fallback } = buildSlices(transients, best.bars, unreliableTransients);
  const sliceMeta = extractSliceFeatures(buffer, slices, best.bars);

  // Honest confidence level: never claim 'high' when fallback or half/double ambiguity is present
  let confidence = 'medium';
  if (fallback || !best.inRange) {
    confidence = 'low';
  } else if (ambiguity) {
    confidence = best.gridScore >= 0.65 && best.pulseScore >= 0.35 ? 'medium' : 'low';
  } else if (best.gridScore >= 0.68 && best.pulseScore >= 0.32 && transients.length >= best.bars * 3) {
    confidence = 'high';
  }

  let note;
  if (fallback) {
    note = `Low transient contrast — even ${slices.length - 1}-slice grid used. Check BPM & bars.`;
  } else if (ambiguity) {
    const alt = ambiguity.alternatives[0];
    note = `Est. ${best.bpm} BPM (${best.bars}B) — could be ${alt.bpm} BPM (${alt.bars}B).`;
  } else if (!best.inRange) {
    note = `Tempo outside 50–200 BPM for ${best.bars}B — adjust bars or BPM.`;
  } else if (confidence === 'high') {
    note = `Est. ${best.bpm} BPM · ${best.bars} ${best.bars === 1 ? 'bar' : 'bars'} · ${slices.length - 1} slices.`;
  } else {
    note = `Est. ${best.bpm} BPM · ${best.bars} ${best.bars === 1 ? 'bar' : 'bars'} — verify timing & markers.`;
  }

  return {
    bpm: best.bpm,
    bars: best.bars,
    slices,
    sliceMeta,
    analysis: {
      estimatedBpm: best.bpm,
      estimatedBars: best.bars,
      confidence,
      fallback,
      transientCount: transients.length,
      ambiguity,
      candidates: scored.map(c => ({ bars: c.bars, bpm: c.bpm, rawBpm: c.rawBpm })),
      note,
    },
  };
}
