// CHOP IT!: Pure, deterministic jungle/DnB breakbeat generator for RUFF (v0.7 PR34).
// Zero DOM, zero Web Audio, zero coupling to MUNCH's magicchop.js — runs identically in Node tests and the browser.
//
// Musical principles:
// - 16 steps = 2 bars at 8th-note resolution (Steps 0–7 = Bar 1, Steps 8–15 = Bar 2).
// - Infers complementary rhythmic roles (foundation / counter / chop / accent) from each break's actual
//   slice metadata and native tempo rather than hardcoding A/B/C lane roles.
// - Treats A/B/C as interlocking layers with bounded simultaneous-hit density and deliberate space.
// - Respects every lock (lane, column, populated cell, and locked empty cell) and explicitly silenced lanes.
// - Unedited assigned lanes enter as their audible 16-step original groove so Evolve and locks preserve them.

import { createRng, hashString } from '../core/rng.js';
import { BREAK_LANES } from '../core/instruments.js';
import {
  BREAK_PATTERN_STEPS, isBuiltinBreakId, resolveBreakDesc, breakBarsOf, breakSlicesOf,
  breakSliceCount, breakSliceInfo, suggestedSliceForStep, clampBreakSlice, isBreakLaneEdited,
  effectiveBreakRow, isBreakLaneLocked, isBreakCellLocked, isBreakLaneExplicitlySilent,
} from '../core/breaks.js';
import { clamp, clone } from '../core/util.js';

export const RUFF_CHOP_MODES = Object.freeze(['new', 'evolve']);
export const RUFF_CHOP_PROFILES = Object.freeze(['jungle', 'darkside', 'atmospheric', 'rolling']);

export const RUFF_PROFILE_META = Object.freeze({
  jungle: Object.freeze({
    id: 'jungle',
    label: 'Old Skool Jungle',
    shortLabel: 'Jungle',
    desc: 'Syncopated chopped break phrases',
  }),
  darkside: Object.freeze({
    id: 'darkside',
    label: 'Darkside',
    shortLabel: 'Darkside',
    desc: 'Angular rhythms, dramatic gaps & accents',
  }),
  atmospheric: Object.freeze({
    id: 'atmospheric',
    label: 'Atmospheric',
    shortLabel: 'Atmospheric',
    desc: 'Restrained transformations, continuity & space',
  }),
  rolling: Object.freeze({
    id: 'rolling',
    label: 'Rolling / Two-Step',
    shortLabel: 'Rolling 2-Step',
    desc: 'Stable rhythmic drive with supporting variations',
  }),
});

const DOWNBEATS = new Set([0, 8]);
const BACKBEATS = new Set([2, 6, 10, 14]);
const TWO_STEP_KICKS = new Set([0, 5, 8, 13]);
const TWO_STEP_ANCHORS = new Set([0, 2, 5, 6, 8, 10, 13, 14]);

/* ---------- 1. Metadata analysis & complementary role inference ---------- */

function positionalFallbackRole(posStep) {
  if (posStep === 0 || posStep === 5 || posStep === 8 || posStep === 13) return 'kick';
  if (posStep === 2 || posStep === 6 || posStep === 10 || posStep === 14) return 'snare';
  if (posStep === 1 || posStep === 7 || posStep === 9) return 'hat';
  if (posStep === 15) return 'fill';
  return 'ghost';
}

/**
 * Derive honest rhythmic/energy slice role cues for an unknown imported WAV break using ONLY
 * transient position, bar placement, and low/high/overall energy (never claiming reliable drum class).
 */
function inferImportedSliceRole(k, count, pos, bars, feat) {
  const barFrac = ((pos * bars) % 1 + 1) % 1; // position within a 4/4 bar [0, 1)
  const near = (target, tol = 0.085) => Math.min(Math.abs(barFrac - target), 1 - Math.abs(barFrac - target)) <= tol;
  const energy = feat && Number.isFinite(feat.energy) ? feat.energy : 0.5;
  const transient = feat && Number.isFinite(feat.transient) ? feat.transient : 0.5;
  const lowE = feat && Number.isFinite(feat.lowEnergy) ? feat.lowEnergy : 0.5;
  const highE = feat && Number.isFinite(feat.highEnergy) ? feat.highEnergy : 0.5;

  // Late turnaround slice (near end of phrase/loop)
  if (k === count - 1 || pos >= 0.87) return 'fill';
  // Downbeat or syncopated anchor with heavier low/overall weight
  if (near(0, 0.08) || (near(0.625, 0.075) && (lowE >= 0.48 || energy >= 0.55))) return 'kick';
  // Backbeat positions (beat 2 / beat 4) with solid transient/energy
  if ((near(0.25, 0.085) || near(0.75, 0.085)) && (transient >= 0.35 || energy >= 0.45)) return 'snare';
  // Brighter / higher-band offbeat hits
  if (highE >= 0.58 && energy >= 0.25) return 'hat';
  // Lower-energy supporting hits
  if (energy < 0.45) return 'ghost';
  // Rhythmic fallback by quantized 16-step position
  const posStep = Math.floor(((pos * bars) % 2) * 8) % BREAK_PATTERN_STEPS;
  return positionalFallbackRole(posStep);
}

/**
 * Analyze one assigned break source using its metadata (slice roles, slice count, native BPM).
 * Built-in breaks use authored slice roles; imported breaks use factual transient position,
 * rhythmic placement and energy features without pretending to have drum classification.
 */
export function analyzeBreakSource(breakId, breakMeta = null) {
  const desc = resolveBreakDesc(breakId, breakMeta);
  const count = breakSliceCount(breakId, breakMeta);
  const bars = breakBarsOf(breakId, breakMeta);
  const slices = breakSlicesOf(breakId, breakMeta);
  const bpm = desc && Number.isFinite(desc.bpm) ? desc.bpm : 120;
  const isBuiltin = isBuiltinBreakId(breakId);
  const hasRichMeta = !!(isBuiltin && desc && Array.isArray(desc.sliceMeta) && desc.sliceMeta.length > 0);
  const usesAudioFeatures = !!(!isBuiltin && desc && Array.isArray(desc.sliceMeta) && desc.sliceMeta.length > 0);

  const roleOf = [];
  const raw = { kick: [], snare: [], hat: [], ghost: [], perc: [], fill: [] };
  let energyVariance = 0;
  let avgTransient = 0.5;

  if (usesAudioFeatures) {
    const energies = desc.sliceMeta.map(m => (m && Number.isFinite(m.energy) ? m.energy : 0.5));
    const meanE = energies.reduce((a, b) => a + b, 0) / Math.max(1, energies.length);
    energyVariance = energies.reduce((a, e) => a + (e - meanE) * (e - meanE), 0) / Math.max(1, energies.length);
    avgTransient = desc.sliceMeta.reduce((a, m) => a + (m && Number.isFinite(m.transient) ? m.transient : 0.5), 0) / Math.max(1, desc.sliceMeta.length);
  }

  for (let k = 0; k < count; k++) {
    let role;
    if (hasRichMeta) {
      const info = breakSliceInfo(breakId, k, breakMeta);
      role = info.role;
    } else if (usesAudioFeatures) {
      const pos = slices[k] ?? (k / count);
      role = inferImportedSliceRole(k, count, pos, bars, desc.sliceMeta[k]);
    } else {
      const posStep = Math.floor((k * BREAK_PATTERN_STEPS) / count);
      role = positionalFallbackRole(posStep);
    }
    roleOf.push(role);
    if (raw[role]) raw[role].push(k);
    else raw.perc.push(k);
  }

  const all = Array.from({ length: count }, (_, k) => k);
  const kick = raw.kick.length ? raw.kick : [0, Math.min(count - 1, Math.floor(count / 2))];
  const snare = raw.snare.length ? raw.snare : [Math.min(count - 1, Math.floor(count / 8) || 1), Math.min(count - 1, Math.floor((count * 3) / 8))];
  const hat = raw.hat.length ? raw.hat : (raw.perc.length ? raw.perc : (raw.ghost.length ? raw.ghost : all.filter(k => k % 2 === 1)));
  const ghost = raw.ghost.length ? raw.ghost : (raw.perc.length ? raw.perc : (hat.length ? hat : all));
  const fill = raw.fill.length ? raw.fill : (raw.snare.length ? raw.snare : [count - 1]);
  const perc = raw.perc.length ? raw.perc : ghost;

  const bpmNorm = clamp((bpm - 95) / 80, 0, 1);
  // Foundation suitability: balanced anchor/accent/texture clarity, moderate tempo, lower fill excess
  const anchorScore = (raw.kick.length > 0 ? 1 : 0)
    + (raw.snare.length > 0 ? 1 : 0)
    + raw.hat.length * 0.6
    + (1 - Math.abs(bpm - 118) / 80) * 1.5
    - raw.fill.length * 0.45
    + (roleOf[0] === 'kick' ? 0.35 : 0)
    + (usesAudioFeatures ? Math.sqrt(energyVariance) * 0.6 : 0);
  // Chop/energy suitability: rich fills, ghosts, transient sharpness, and faster native tempo
  const chopScore = raw.fill.length * 1.6 + raw.ghost.length * 0.9 + bpmNorm * 2.2
    + (usesAudioFeatures ? avgTransient * 0.8 : 0);
  // Texture/support suitability: hats, ghosts, perc, and looser pocket
  const textureScore = raw.hat.length * 1.2 + raw.ghost.length * 1.1 + raw.perc.length * 1.2 + (1 - bpmNorm) * 0.8;

  return {
    breakId,
    breakMeta,
    count,
    bars,
    bpm,
    hasRichMeta,
    usesAudioFeatures,
    roleOf,
    slicesByRole: { kick, snare, hat: hat.length ? hat : all, ghost, perc, fill, any: all },
    scores: { anchor: anchorScore, chop: chopScore, texture: textureScore },
  };
}

/**
 * Assign complementary rhythmic roles across 1, 2 or 3 active break sources strictly from
 * their analyzed metadata (never hardcoded to A/B/C lane order unless metadata is identical).
 */
export function assignBreakRoles(entries) {
  const roles = {};
  if (!entries.length) return roles;
  if (entries.length === 1) {
    roles[entries[0].lane] = 'solo';
    return roles;
  }

  const byAnchor = [...entries].sort((a, b) =>
    (b.src.scores.anchor - a.src.scores.anchor)
    || (a.src.scores.chop - b.src.scores.chop)
    || (hashString(a.src.breakId) - hashString(b.src.breakId))
    || (BREAK_LANES.indexOf(a.lane) - BREAK_LANES.indexOf(b.lane)));

  const foundation = byAnchor[0];
  roles[foundation.lane] = 'foundation';

  const rest = entries.filter(e => e.lane !== foundation.lane);
  if (rest.length === 1) {
    roles[rest[0].lane] = 'counter';
    return roles;
  }

  const byChop = [...rest].sort((a, b) =>
    (b.src.scores.chop - a.src.scores.chop)
    || (a.src.scores.texture - b.src.scores.texture)
    || (hashString(b.src.breakId) - hashString(a.src.breakId))
    || (BREAK_LANES.indexOf(a.lane) - BREAK_LANES.indexOf(b.lane)));

  roles[byChop[0].lane] = 'chop';
  roles[byChop[1].lane] = 'accent';
  return roles;
}

/* ---------- 2. Musical profile templates & parameters ---------- */

// 16 steps = Bar 1 (0..7) + Bar 2 (8..15).
// K: strong kick · k: syncopated kick · S: primary snare · s: syncopated/alt snare
// H: hat/ride · G: ghost/perc · F: fill/turnaround · R: repeat/bounce previous slice · .: rest
const PROFILE_CFG = {
  jungle: {
    solo: {
      subtle: ['KHSGkSHGKHSGkSGF', 'KHSGKS.HKHSGKS.F', 'KHS.kSHGKHSGkS.F'],
      medium: ['K.SGkS.FK.SRkRSF', 'KH.kSG.FK.SGkRSF', 'K.SG.kSFK.RkS.RF'],
      wild: ['K.SR.kSF.KRS.RFF', 'K.S.kRSFK.Rk.SRF', 'K.kS.SR.K.RSk.FF'],
    },
    counter: ['.H.G..H..H.R..RF', '...G.k.H...R.S.F', '..s..G.F.H.s..RF'],
    accent: ['...G...H...G..RF', '.......F...H..GF', '...H...F.....GRF'],
    vel: { K: [.90, .98], k: [.78, .88], S: [.90, 1.0], s: [.72, .84], H: [.54, .70], G: [.50, .68], F: [.84, .98], R: [.68, .88] },
    maxTwoSteps: 7,
    maxThreeSteps: 1,
    minSilentSteps: 1,
    preferNative: 0.42,
    continuityBias: 0.2,
    chopMotifProb: 0.72,
    evolveBase: 0.22,
    evolveSpan: 0.56,
  },
  darkside: {
    solo: {
      subtle: ['K.S..kS.K.S..k.F', 'K..Gk.S.K.S...SF', 'K.S.G.S.K.S...kF'],
      medium: ['K.S...k.K..S..GF', 'K..S.k..K.S...RF', 'K.S.G...K..kS..F'],
      wild: ['K..S..k..K.S..FF', 'K.S...F.K...kS.F', 'K..k.S...K..SR.F'],
    },
    counter: ['...G...S...G...F', '....k.....S...G.', '..S....G....k..F'],
    accent: ['.......F.......F', '...S.......G...F', '....G..........F'],
    vel: { K: [.94, 1.0], k: [.84, .94], S: [.95, 1.0], s: [.78, .92], H: [.42, .54], G: [.40, .52], F: [.92, 1.0], R: [.76, .94] },
    maxTwoSteps: 3,
    maxThreeSteps: 0,
    minSilentSteps: 4,
    preferNative: 0.35,
    continuityBias: 0.12,
    chopMotifProb: 0.35,
    evolveBase: 0.22,
    evolveSpan: 0.58,
  },
  atmospheric: {
    solo: {
      subtle: ['KHSGkSHGKHSGkSH.', 'KHS.kSHGKHS.kSH.', 'KHSGkSH.KHSGkSHG'],
      medium: ['KHS.kS.HKHS.kS.G', 'KH.GkSH.KHS.k.HG', 'K.SGkSH.K.SGkS.H'],
      wild: ['KH.G.SH.K.SGk.HF', 'K.S.kSHGK.HG.S.G', 'KH.Gk.H.K.SGkS.G'],
    },
    counter: ['...H...G...H...G', '..H...G...H...G.', '.G...H...G...H..'],
    accent: ['.......H.......G', '...G.......H....', '.....H.........G'],
    vel: { K: [.74, .86], k: [.66, .78], S: [.74, .86], s: [.60, .72], H: [.50, .66], G: [.46, .62], F: [.68, .80], R: [.58, .70] },
    maxTwoSteps: 3,
    maxThreeSteps: 0,
    minSilentSteps: 2,
    preferNative: 0.78,
    continuityBias: 0.78,
    chopMotifProb: 0.08,
    evolveBase: 0.12,
    evolveSpan: 0.40,
  },
  rolling: {
    solo: {
      subtle: ['KHSGkSHGKHSGkSHF', 'KHS.kSHGKHSGkSHF', 'KHSGkSHGKHS.kSHF'],
      medium: ['KHSGkSHHKHSGkSGF', 'KHS.kSHGKHS.kSGF', 'KHSGkSHGKHSGkRSF'],
      wild: ['KHSGkSHFKHSGkRSF', 'KHSGkS.FKHSGkRFF', 'KHS.kSHFKHSGkSRF'],
    },
    counter: ['.H.G..H..H.G.k.F', '.H.G.H...H.G..HF', '...G.k.H...G.k.F'],
    accent: ['...H...G...H...F', '.H.....G.H.....F', '...G...H.....k.F'],
    vel: { K: [.86, .95], k: [.78, .88], S: [.86, .96], s: [.74, .84], H: [.62, .75], G: [.58, .72], F: [.82, .94], R: [.72, .86] },
    maxTwoSteps: 7,
    maxThreeSteps: 1,
    minSilentSteps: 0,
    preferNative: 0.62,
    continuityBias: 0.48,
    chopMotifProb: 0.3,
    evolveBase: 0.16,
    evolveSpan: 0.46,
  },
};

function roundVel(v) {
  return Math.round(clamp(v, 0.1, 1) * 100) / 100;
}

function tokenRole(ch) {
  if (ch === 'K' || ch === 'k') return 'kick';
  if (ch === 'S' || ch === 's') return 'snare';
  if (ch === 'H') return 'hat';
  if (ch === 'G') return 'ghost';
  if (ch === 'F') return 'fill';
  return 'ghost';
}

function velForToken(cfg, ch, rng, intensity) {
  const pair = cfg.vel[ch] || [.65, .82];
  const spread = 0.45 + intensity * 0.55;
  const mid = (pair[0] + pair[1]) / 2;
  const half = ((pair[1] - pair[0]) / 2) * spread;
  return roundVel(rng.float(mid - half, mid + half));
}

/** Pick a musically coherent slice index for `(src, role, step)` according to profile and intensity. */
function pickSlice(src, role, step, len, { cfg, profile, intensity, rng, prevSlice, voices }) {
  const home = suggestedSliceForStep(src.breakId, step, len, src.breakMeta);
  const pool = src.slicesByRole[role] || src.slicesByRole.any;
  const mid = Math.max(1, Math.floor(src.count / 2));

  // Rolling: lock a consistent primary kick/snare voice for solid two-step propulsion
  if (profile === 'rolling' && (role === 'kick' || role === 'snare') && voices && voices[role] != null) {
    const lockProb = 0.85 - intensity * 0.35;
    if (rng.chance(lockProb)) {
      if (step >= 8 && voices[`${role}2`] != null && rng.chance(0.6)) return voices[`${role}2`];
      return voices[role];
    }
  }

  // Atmospheric continuity: prefer moving sequentially forward from the previous slice when role matches
  if (prevSlice != null && rng.chance(cfg.continuityBias * (1 - intensity * 0.4))) {
    const nextSeq = (prevSlice + 1) % src.count;
    if (src.roleOf[nextSeq] === role || (role === 'ghost' && (src.roleOf[nextSeq] === 'hat' || src.roleOf[nextSeq] === 'perc'))) {
      return nextSeq;
    }
  }

  // Native-position bias: strong at subtle intensity and in Atmospheric/Rolling
  const nativeChance = clamp(cfg.preferNative * (1 - intensity * 0.65), 0.08, 0.92);
  if (src.roleOf[home] === role && rng.chance(nativeChance)) return home;

  // Jungle & wild intensity: encourage cross-bar swaps (pull second half into first or vice versa)
  if ((profile === 'jungle' || intensity > 0.65) && pool.length > 1) {
    const otherBar = pool.filter(k => (step < 8 ? k >= mid : k < mid));
    if (otherBar.length && rng.chance(0.35 + intensity * 0.45)) return rng.pick(otherBar);
  }

  // Subtle / Atmospheric: prefer a matching-role slice close to the current step's bar/beat position
  if (intensity < 0.4 || profile === 'atmospheric') {
    const sameBar = pool.filter(k => (step < 8 ? k < mid : k >= mid));
    if (sameBar.length && rng.chance(0.72)) {
      sameBar.sort((a, b) => Math.abs(a - home) - Math.abs(b - home));
      return sameBar[0];
    }
  }

  return rng.pick(pool);
}

function buildVoiceAnchors(src, rng) {
  const mid = Math.max(1, Math.floor(src.count / 2));
  const bar1K = src.slicesByRole.kick.filter(k => k < mid);
  const bar2K = src.slicesByRole.kick.filter(k => k >= mid);
  const bar1S = src.slicesByRole.snare.filter(k => k < mid);
  const bar2S = src.slicesByRole.snare.filter(k => k >= mid);
  return {
    kick: bar1K.length ? bar1K[0] : rng.pick(src.slicesByRole.kick),
    kick2: bar2K.length ? bar2K[0] : rng.pick(src.slicesByRole.kick),
    snare: bar1S.length ? rng.pick(bar1S) : rng.pick(src.slicesByRole.snare),
    snare2: bar2S.length ? rng.pick(bar2S) : rng.pick(src.slicesByRole.snare),
  };
}

/* ---------- 3. NEW GROOVE synthesis ---------- */

function chooseTier(intensity) {
  if (intensity < 0.34) return 'subtle';
  if (intensity < 0.72) return 'medium';
  return 'wild';
}

function generateLaneNew(entry, role, len, { cfg, profile, intensity, rng, lockedMask, baseAudible }) {
  const { src } = entry;
  const tier = chooseTier(intensity);
  const voices = buildVoiceAnchors(src, rng);

  let tpl;
  if (role === 'solo' || role === 'foundation') {
    tpl = rng.pick(cfg.solo[tier]);
  } else if (role === 'counter' || role === 'chop') {
    tpl = rng.pick(cfg.counter);
  } else {
    tpl = rng.pick(cfg.accent);
  }

  // Intensity-driven phrase adjustments on the template before slice realization
  const chars = [...tpl];
  if (role === 'solo' || role === 'foundation') {
    if (profile === 'jungle' && intensity >= 0.45) {
      // Optional bar-2 syncopated snare/fill bounce
      if (rng.chance(0.5 + intensity * 0.35)) {
        const at = rng.pick([11, 13, 14]);
        chars[at] = rng.pick(['S', 'F', 'R']);
        if (at + 1 < len) chars[at + 1] = 'R';
      }
      if (intensity > 0.75 && rng.chance(0.55)) chars[4] = rng.pick(['.', 's', 'R']);
    } else if (profile === 'darkside') {
      // Ensure angular dramatic pauses in Bar 1 or Bar 2
      const gapStart = rng.pick([3, 4, 9, 11]);
      if (intensity >= 0.3 && gapStart + 1 < len) {
        chars[gapStart] = '.';
        if (intensity >= 0.55) chars[gapStart + 1] = '.';
      }
      if (intensity >= 0.65 && rng.chance(0.5)) chars[6] = '.'; // dropped secondary backbeat for tension
    } else if (profile === 'atmospheric') {
      // Soft space: occasionally open step 7 or 15 to let tails breathe
      if (rng.chance(0.45 + intensity * 0.25)) chars[7] = '.';
      if (intensity > 0.5 && rng.chance(0.5)) chars[3] = '.';
    } else if (profile === 'rolling') {
      // Guarantee two-step drive anchors stay intact!
      chars[0] = 'K';
      chars[2] = 'S';
      chars[5] = 'k';
      chars[6] = 'S';
      chars[8] = 'K';
      chars[10] = 'S';
      chars[13] = 'k';
      chars[14] = 'S';
      if (intensity >= 0.5 && rng.chance(0.55)) chars[15] = 'F';
    }
  } else {
    // Secondary layers scale density gently with intensity (quieter/sparser at subtle, more active at wild)
    const keepScale = role === 'accent' ? (0.45 + intensity * 0.55) : (0.55 + intensity * 0.45);
    for (let s = 0; s < len; s++) {
      if (chars[s] !== '.' && !rng.chance(keepScale)) chars[s] = '.';
    }
    // Ensure a secondary active lane contributes at least 2 meaningful hits (unless all locked)
    const count = chars.filter(c => c !== '.').length;
    if (count < 2) {
      const picks = role === 'accent' ? [7, 15, 3, 11] : [3, 7, 11, 15, 1, 9];
      for (const s of picks) {
        if (chars[s] === '.') {
          chars[s] = s === 15 ? 'F' : (s % 4 === 3 ? 'H' : 'G');
          if (chars.filter(c => c !== '.').length >= 2) break;
        }
      }
    }
  }

  // Realize template tokens into slice cells, respecting locked steps verbatim
  const row = Array(len).fill(null);
  let prevSlice = null;
  for (let s = 0; s < len; s++) {
    if (lockedMask[s]) {
      row[s] = baseAudible[s] ? clone(baseAudible[s]) : null;
      if (row[s]) prevSlice = row[s].slice;
      continue;
    }
    const ch = chars[s % chars.length];
    if (ch === '.') {
      row[s] = null;
      continue;
    }
    let slice;
    if (ch === 'R' && prevSlice != null) {
      slice = prevSlice;
    } else {
      const r = ch === 'R' ? 'snare' : tokenRole(ch);
      slice = pickSlice(src, r, s, len, { cfg, profile, intensity, rng, prevSlice, voices });
    }
    const v = velForToken(cfg, ch, rng, intensity);
    row[s] = { slice: clampBreakSlice(src.breakId, slice, 0, src.breakMeta), v, p: 1 };
    prevSlice = row[s].slice;
  }

  // Subtle intensity safety: preserve recognizable bar downbeat/backbeat anchors on solo/foundation
  if ((role === 'solo' || role === 'foundation') && intensity <= 0.25) {
    for (const s of [0, 2, 6, 8, 10, 14]) {
      if (lockedMask[s]) continue;
      if (!row[s] && profile !== 'darkside') {
        const r = DOWNBEATS.has(s) ? 'kick' : 'snare';
        row[s] = {
          slice: clampBreakSlice(src.breakId, pickSlice(src, r, s, len, { cfg, profile, intensity, rng, prevSlice: null, voices }), 0, src.breakMeta),
          v: velForToken(cfg, DOWNBEATS.has(s) ? 'K' : 'S', rng, intensity),
          p: 1,
        };
      }
    }
  }

  return row;
}

/* ---------- 4. EVOLVE transformation ---------- */

function stepTargetRole(s, profile) {
  if (DOWNBEATS.has(s)) return 'kick';
  if (BACKBEATS.has(s)) return 'snare';
  if (s === 5 || s === 13) return profile === 'darkside' ? 'ghost' : 'kick';
  if (s === 15) return 'fill';
  if (s === 7) return profile === 'jungle' ? 'fill' : 'hat';
  return s % 2 === 1 ? 'hat' : 'ghost';
}

function evolveLane(entry, role, len, { cfg, profile, intensity, rng, lockedMask, baseAudible }) {
  const { src } = entry;
  const voices = buildVoiceAnchors(src, rng);
  const row = baseAudible.map(c => (c ? { slice: clampBreakSlice(src.breakId, c.slice, 0, src.breakMeta), v: c.v, p: c.p ?? 1, ...(c.o ? { o: c.o } : {}), ...(c.rev ? { rev: true } : {}), ...(c.locked ? { locked: true } : {}) } : null));

  const unlockedSteps = [];
  for (let s = 0; s < len; s++) if (!lockedMask[s]) unlockedSteps.push(s);
  if (!unlockedSteps.length) return row;

  const currentHits = row.filter(Boolean).length;
  const rate = clamp(cfg.evolveBase + intensity * cfg.evolveSpan, 0.08, 0.88);
  let mutations = 0;

  // If the lane is very sparse (e.g. user drew 1-3 hits), grow profile-appropriate support around existing hits
  const growMode = currentHits > 0 && currentHits <= 4 && (role === 'solo' || role === 'foundation');

  let prevSlice = null;
  for (let s = 0; s < len; s++) {
    if (lockedMask[s]) {
      if (row[s]) prevSlice = row[s].slice;
      continue;
    }

    const cur = row[s];
    const isDown = DOWNBEATS.has(s);
    const isBack = BACKBEATS.has(s);
    const isTwoStep = TWO_STEP_ANCHORS.has(s);

    // Anchor preservation: strong at low intensity, especially for Rolling & Atmospheric
    let stepRate = rate;
    if (isDown) stepRate *= (profile === 'rolling' ? 0.12 : 0.20 + intensity * 0.45);
    else if (isBack) stepRate *= (profile === 'rolling' ? 0.18 : (profile === 'darkside' ? 0.40 + intensity * 0.45 : 0.25 + intensity * 0.50));
    else if (s >= 8) stepRate *= 1.18; // favor phrase-level Bar 2 evolution!

    // Rolling: ensure missing two-step backbone hits are reinforced on solo/foundation
    if (profile === 'rolling' && (role === 'solo' || role === 'foundation') && isTwoStep && !cur && rng.chance(0.55 + intensity * 0.35)) {
      const r = TWO_STEP_KICKS.has(s) ? 'kick' : 'snare';
      const slice = pickSlice(src, r, s, len, { cfg, profile, intensity, rng, prevSlice, voices });
      row[s] = { slice, v: velForToken(cfg, TWO_STEP_KICKS.has(s) ? 'K' : 'S', rng, intensity), p: 1 };
      prevSlice = slice;
      mutations++;
      continue;
    }

    if (!rng.chance(stepRate)) {
      // Even when keeping a hit, softly nudge velocity toward profile character on secondary steps
      if (cur && profile === 'darkside' && !isDown && !isBack && cur.v > 0.6) {
        row[s] = { ...cur, v: roundVel(cur.v * 0.72) };
      }
      if (row[s]) prevSlice = row[s].slice;
      continue;
    }

    if (cur) {
      // Decide whether to drop (carve silence/space) or swap slice/accent
      let dropProb = 0.22 + intensity * 0.18;
      if (profile === 'darkside') dropProb = (isDown ? 0.08 : 0.42 + intensity * 0.28);
      else if (profile === 'atmospheric') dropProb = (isDown || isBack ? 0.08 : 0.30 + intensity * 0.20);
      else if (profile === 'rolling') dropProb = (isTwoStep ? 0.04 : 0.18 + intensity * 0.14);
      else if (profile === 'jungle') dropProb = (isDown ? 0.06 : 0.26 + intensity * 0.22);

      if (role === 'accent') dropProb += 0.22;
      else if (role === 'counter' || role === 'chop') dropProb += 0.12;

      if (!growMode && rng.chance(clamp(dropProb, 0.02, 0.85))) {
        row[s] = null;
        mutations++;
        continue;
      }

      // Slice variation (profile-flavored!)
      let targetRole = stepTargetRole(s, profile);
      if (profile === 'jungle' && intensity > 0.4 && !isDown && rng.chance(0.45)) {
        targetRole = rng.pick(['snare', 'fill', 'ghost']);
      } else if (profile === 'darkside' && !isDown && rng.chance(0.4)) {
        targetRole = rng.pick(['snare', 'kick', 'fill']);
      } else if (profile === 'atmospheric' && !isDown && !isBack) {
        targetRole = rng.pick(['hat', 'ghost']);
      }

      let nextSlice = pickSlice(src, targetRole, s, len, { cfg, profile, intensity, rng, prevSlice, voices });
      // Try once more to avoid a no-op identical slice when evolving
      if (nextSlice === cur.slice && src.slicesByRole[targetRole].length > 1) {
        const alts = src.slicesByRole[targetRole].filter(k => k !== cur.slice);
        if (alts.length) nextSlice = rng.pick(alts);
      }
      const tok = targetRole === 'kick' ? (isDown ? 'K' : 'k') : targetRole === 'snare' ? 'S' : targetRole === 'fill' ? 'F' : targetRole === 'hat' ? 'H' : 'G';
      row[s] = { slice: clampBreakSlice(src.breakId, nextSlice, 0, src.breakMeta), v: velForToken(cfg, tok, rng, intensity), p: cur.p ?? 1 };
      prevSlice = row[s].slice;
      mutations++;
    } else {
      // Currently empty unlocked step: decide whether to add a syncopated/supporting hit
      let addProb = growMode ? (0.45 + intensity * 0.35) : (0.18 + intensity * 0.32);
      if (profile === 'darkside') addProb *= 0.52;
      else if (profile === 'atmospheric') addProb *= 0.62;
      else if (profile === 'rolling') addProb *= 1.15;
      else if (profile === 'jungle') addProb *= 1.05;
      if (role === 'accent') addProb *= 0.45;
      else if (role === 'counter' || role === 'chop') addProb *= 0.70;

      if (rng.chance(clamp(addProb, 0.05, 0.85))) {
        const targetRole = stepTargetRole(s, profile);
        const slice = pickSlice(src, targetRole, s, len, { cfg, profile, intensity, rng, prevSlice, voices });
        const tok = targetRole === 'kick' ? 'k' : targetRole === 'snare' ? 's' : targetRole === 'fill' ? 'F' : targetRole === 'hat' ? 'H' : 'G';
        row[s] = { slice: clampBreakSlice(src.breakId, slice, 0, src.breakMeta), v: velForToken(cfg, tok, rng, intensity), p: 1 };
        prevSlice = slice;
        mutations++;
      }
    }
  }

  // Profile-specific phrase-level signature transform in EVOLVE
  if (profile === 'jungle' && rng.chance(cfg.chopMotifProb * (0.45 + intensity * 0.65))) {
    // Inject a 2-step jungle slice-bounce motif in Bar 2 on unlocked consecutive steps
    const pairs = [[11, 12], [13, 14], [14, 15], [6, 7]];
    const valid = pairs.filter(([a, b]) => !lockedMask[a] && !lockedMask[b]);
    if (valid.length) {
      const [a, b] = rng.pick(valid);
      const chopRole = b === 15 ? 'fill' : rng.pick(['snare', 'fill', 'ghost']);
      const slice = pickSlice(src, chopRole, a, len, { cfg, profile, intensity, rng, prevSlice: null, voices });
      row[a] = { slice, v: roundVel(rng.float(0.76, 0.90)), p: 1 };
      row[b] = { slice: b === 15 && rng.chance(0.5) ? rng.pick(src.slicesByRole.fill) : slice, v: roundVel(rng.float(0.86, 1.0)), p: 1 };
      mutations++;
    }
  } else if (profile === 'darkside' && intensity >= 0.25) {
    // Carve an intentional dramatic pocket of silence (2 consecutive unlocked non-downbeat steps)
    const pockets = [[3, 4], [4, 5], [9, 10], [11, 12]];
    const valid = pockets.filter(([a, b]) => !lockedMask[a] && !lockedMask[b]);
    if (valid.length) {
      const [a, b] = rng.pick(valid);
      row[a] = null;
      row[b] = null;
      // Accent the hit right after the silence if unlocked!
      const after = (b + 1) % len;
      if (!lockedMask[after] && !DOWNBEATS.has(after)) {
        const slice = pickSlice(src, after === 15 ? 'fill' : 'snare', after, len, { cfg, profile, intensity, rng, prevSlice: null, voices });
        row[after] = { slice, v: 0.98, p: 1 };
      }
      mutations++;
    }
  }

  // Guarantee at least one tasteful audible change when evolving an unlocked lane
  if (mutations === 0) {
    const pref = unlockedSteps.filter(s => s >= 8 && !DOWNBEATS.has(s));
    const s = rng.pick(pref.length ? pref : unlockedSteps);
    const cur = row[s];
    if (cur) {
      const targetRole = stepTargetRole(s, profile);
      const alts = (src.slicesByRole[targetRole] || src.slicesByRole.any).filter(k => k !== cur.slice);
      const nextSlice = alts.length ? rng.pick(alts) : ((cur.slice + 1) % src.count);
      row[s] = { slice: clampBreakSlice(src.breakId, nextSlice, 0, src.breakMeta), v: cur.v, p: cur.p ?? 1 };
    } else {
      const targetRole = stepTargetRole(s, profile);
      const slice = pickSlice(src, targetRole, s, len, { cfg, profile, intensity, rng, prevSlice: null, voices });
      row[s] = { slice, v: velForToken(cfg, 'G', rng, intensity), p: 1 };
    }
  }

  return row;
}

/* ---------- 5. Multi-lane interplay, polyphony & silence guardrails ---------- */

const ROLE_PRIORITY = { accent: 0, chop: 1, counter: 1, foundation: 2, solo: 3 };

function balanceMultiLane(rows, activeEntries, roles, { len, cfg, profile, intensity, rng, lockedMasks, allAudible }) {
  // Helper: count active hits at step `s` across ALL 3 lanes (including locked/unedited lanes!)
  const countAt = s => BREAK_LANES.reduce((n, l) => n + (rows[l][s] ? 1 : 0), 0);

  // Sort active lanes from lowest priority (trimmed first) to highest priority (foundation kept)
  const trimOrder = [...activeEntries].sort((a, b) =>
    (ROLE_PRIORITY[roles[a.lane]] ?? 1) - (ROLE_PRIORITY[roles[b.lane]] ?? 1));

  // 1) Cap 3-way simultaneous stacks (at most `cfg.maxThreeSteps`, only on climactic steps 0/8/15 when wild)
  let threeCount = 0;
  const allowThree = intensity >= 0.5 ? cfg.maxThreeSteps : 0;
  for (let s = 0; s < len; s++) {
    if (countAt(s) < 3) continue;
    const climactic = s === 0 || s === 8 || s === 15;
    if (climactic && threeCount < allowThree) {
      threeCount++;
      continue;
    }
    for (const e of trimOrder) {
      if (countAt(s) <= 2) break;
      if (!lockedMasks[e.lane][s] && rows[e.lane][s]) {
        rows[e.lane][s] = null;
      }
    }
  }

  // 2) Bound 2-way simultaneous steps so multi-break arrangements interlock instead of smearing
  if (activeEntries.length >= 2) {
    const twoSteps = [];
    for (let s = 0; s < len; s++) if (countAt(s) >= 2) twoSteps.push(s);
    const maxTwo = Math.max(1, Math.round(cfg.maxTwoSteps - (profile === 'atmospheric' ? 1 : 0) + (intensity > 0.75 ? 1 : 0)));
    if (twoSteps.length > maxTwo) {
      // Keep climactic steps (0, 8, 15, backbeats) first, thin redundant mid-bar collisions
      const expendable = rng.shuffle(twoSteps.filter(s => s !== 0 && s !== 8 && s !== 15));
      let excess = twoSteps.length - maxTwo;
      for (const s of expendable) {
        if (excess <= 0) break;
        for (const e of trimOrder) {
          if (countAt(s) <= 1) break;
          if (!lockedMasks[e.lane][s] && rows[e.lane][s]) {
            rows[e.lane][s] = null;
            excess--;
            break;
          }
        }
      }
    }

    // 3) Complementary fill: if a non-foundation active lane got thinned to 0 hits, give it 2–3 open pockets
    for (const e of trimOrder) {
      if (roles[e.lane] === 'foundation' || roles[e.lane] === 'solo') continue;
      const curCount = rows[e.lane].filter(Boolean).length;
      if (curCount >= 2) continue;
      const openSteps = [];
      for (let s = 0; s < len; s++) {
        if (!lockedMasks[e.lane][s] && !rows[e.lane][s] && countAt(s) === 0) openSteps.push(s);
      }
      const fallbackSteps = [];
      for (let s = 0; s < len; s++) {
        if (!lockedMasks[e.lane][s] && !rows[e.lane][s] && countAt(s) <= 1) fallbackSteps.push(s);
      }
      const candidates = openSteps.length >= 2 ? openSteps : fallbackSteps;
      const shuffled = rng.shuffle(candidates);
      let added = curCount;
      for (const s of shuffled) {
        if (added >= 2) break;
        const r = s === 15 ? 'fill' : (s % 2 === 1 ? 'hat' : 'ghost');
        const slice = pickSlice(e.src, r, s, len, { cfg, profile, intensity, rng, prevSlice: null, voices: null });
        rows[e.lane][s] = { slice, v: velForToken(cfg, s === 15 ? 'F' : 'G', rng, intensity), p: 1 };
        added++;
      }
    }
  }

  // 4) Guarantee intentional silent steps for Darkside & Atmospheric (where unlocked steps allow)
  if (cfg.minSilentSteps > 0) {
    let silentSteps = 0;
    for (let s = 0; s < len; s++) if (countAt(s) === 0) silentSteps++;
    if (silentSteps < cfg.minSilentSteps) {
      // Prefer non-downbeat, non-turnaround steps for dramatic/airy gaps
      const candidates = rng.shuffle([3, 4, 7, 9, 11, 12, 1, 5, 13, 6].filter(s => s < len && countAt(s) > 0));
      for (const s of candidates) {
        if (silentSteps >= cfg.minSilentSteps) break;
        const canClearAll = activeEntries.every(e => !rows[e.lane][s] || !lockedMasks[e.lane][s])
          && BREAK_LANES.every(l => activeEntries.some(e => e.lane === l) || !allAudible[l][s]);
        if (!canClearAll) continue;
        for (const e of activeEntries) {
          if (!lockedMasks[e.lane][s]) rows[e.lane][s] = null;
        }
        if (countAt(s) === 0) silentSteps++;
      }
    }
  }
}

/* ---------- 6. Public generator entry point ---------- */

/**
 * Pure, deterministic CHOP IT! generator for RUFF A/B/C break patterns.
 *
 * @param {object} opts
 * @param {object} opts.pattern     Current scene RUFF pattern `{ len, lanes, locked, edited }` (not mutated)
 * @param {object} opts.breaks      Slot break assignments `{ a, b, c }` (not mutated)
 * @param {'new'|'evolve'} [opts.mode='new']
 * @param {'jungle'|'darkside'|'atmospheric'|'rolling'} [opts.profile='jungle']
 * @param {number} [opts.intensity=0.5]   Subtle (0) .. Wild (1)
 * @param {number} [opts.seed=1]          Deterministic seed
 * @returns {{ pattern: object, changed: boolean, info: object }}
 */
export function chopBreakPattern({
  pattern,
  breaks,
  breakMeta = null,
  mode = 'new',
  profile = 'jungle',
  intensity = 0.5,
  seed = 1,
}) {
  const len = (pattern && pattern.len) || BREAK_PATTERN_STEPS;
  const cleanMode = RUFF_CHOP_MODES.includes(mode) ? mode : 'new';
  const cleanProfile = RUFF_CHOP_PROFILES.includes(profile) ? profile : 'jungle';
  const cleanIntensity = clamp(Number.isFinite(Number(intensity)) ? Number(intensity) : 0.5, 0, 1);
  const cleanSeed = (Number(seed) >>> 0);
  const rng = createRng(cleanSeed);
  const cfg = PROFILE_CFG[cleanProfile];

  const srcBreaks = breaks || {};
  const nextLanes = {};
  const nextEdited = pattern && pattern.edited ? clone(pattern.edited) : {};
  const nextLocked = pattern && pattern.locked ? clone(pattern.locked) : {};

  // Snapshot pre-existing audible content & locks per lane
  const allAudible = {};
  const lockedMasks = {};
  const activeEntries = [];

  for (const lane of BREAK_LANES) {
    const breakId = srcBreaks[lane] || null;
    const wasEdited = isBreakLaneEdited(pattern, lane);
    const laneLocked = isBreakLaneLocked(pattern, lane);
    const explicitSilent = isBreakLaneExplicitlySilent(pattern, lane);
    const eff = effectiveBreakRow(pattern, lane, breakId, breakMeta);

    // Strip `virtual` from audible snapshot so materialized locked cells are clean persisted objects
    allAudible[lane] = eff.map((c, s) => {
      if (!c) return null;
      if (!c.virtual && pattern && pattern.lanes && pattern.lanes[lane] && pattern.lanes[lane][s]) {
        return clone(pattern.lanes[lane][s]);
      }
      return { slice: c.slice, v: c.v ?? 1, p: c.p ?? 1 };
    });

    lockedMasks[lane] = Array.from({ length: len }, (_, s) => isBreakCellLocked(pattern, lane, s));

    // Preserve raw lane by default (exact clone) for untouched/locked/silent/unassigned lanes
    const rawRow = pattern && pattern.lanes && Array.isArray(pattern.lanes[lane])
      ? Array.from({ length: len }, (_, s) => (pattern.lanes[lane][s] ? clone(pattern.lanes[lane][s]) : null))
      : Array(len).fill(null);
    nextLanes[lane] = rawRow;

    // Eligibility: assigned break, NOT lane-locked, NOT explicitly silenced, and has at least 1 unlocked step
    const hasUnlockedStep = lockedMasks[lane].some(locked => !locked);
    if (breakId && !laneLocked && !explicitSilent && hasUnlockedStep) {
      activeEntries.push({ lane, breakId, src: analyzeBreakSource(breakId, breakMeta), wasEdited });
    }
  }

  if (!activeEntries.length) {
    return {
      pattern: { len, lanes: nextLanes, locked: nextLocked, edited: nextEdited },
      changed: false,
      info: {
        mode: cleanMode,
        profile: cleanProfile,
        intensity: cleanIntensity,
        seed: cleanSeed,
        roles: {},
        activeLanes: [],
        stats: computeStats(allAudible, len),
      },
    };
  }

  const roles = assignBreakRoles(activeEntries);

  // Working audible grid for interplay balancing (starts with locked/unedited lanes' audible hits)
  const workRows = {};
  for (const lane of BREAK_LANES) {
    workRows[lane] = allAudible[lane].map(c => (c ? clone(c) : null));
  }

  // Generate or evolve each eligible active lane
  for (const entry of activeEntries) {
    const laneRng = rng.fork(`${entry.lane}:${cleanProfile}:${cleanMode}`);
    const role = roles[entry.lane];
    const generated = cleanMode === 'evolve'
      ? evolveLane(entry, role, len, {
          cfg, profile: cleanProfile, intensity: cleanIntensity, rng: laneRng,
          lockedMask: lockedMasks[entry.lane], baseAudible: allAudible[entry.lane],
        })
      : generateLaneNew(entry, role, len, {
          cfg, profile: cleanProfile, intensity: cleanIntensity, rng: laneRng,
          lockedMask: lockedMasks[entry.lane], baseAudible: allAudible[entry.lane],
        });
    workRows[entry.lane] = generated;
  }

  // Multi-lane concurrency, interlocking & intentional silence balancing
  balanceMultiLane(workRows, activeEntries, roles, {
    len, cfg, profile: cleanProfile, intensity: cleanIntensity,
    rng: rng.fork('balance'), lockedMasks, allAudible,
  });

  // Final lock-and-safety commit pass (guarantees locks and untouched lanes by construction)
  for (const entry of activeEntries) {
    const { lane } = entry;
    nextEdited[lane] = true;
    nextLanes[lane] = Array.from({ length: len }, (_, s) => {
      if (lockedMasks[lane][s]) {
        return allAudible[lane][s] ? clone(allAudible[lane][s]) : null;
      }
      const cell = workRows[lane][s];
      return cell ? { slice: clampBreakSlice(entry.breakId, cell.slice, 0, breakMeta), v: roundVel(cell.v ?? 1), p: cell.p ?? 1 } : null;
    });
  }

  const nextPattern = { len, lanes: nextLanes, locked: nextLocked, edited: nextEdited };
  const changed = JSON.stringify(nextPattern) !== JSON.stringify({
    len,
    lanes: Object.fromEntries(BREAK_LANES.map(l => [l, (pattern && pattern.lanes && pattern.lanes[l]) || Array(len).fill(null)])),
    locked: (pattern && pattern.locked) || {},
    edited: (pattern && pattern.edited) || {},
  });

  return {
    pattern: nextPattern,
    changed,
    info: {
      mode: cleanMode,
      profile: cleanProfile,
      intensity: cleanIntensity,
      seed: cleanSeed,
      roles,
      activeLanes: activeEntries.map(e => e.lane),
      stats: computeStats(workRows, len),
    },
  };
}

function computeStats(rows, len) {
  let totalHits = 0;
  let maxConcurrent = 0;
  let silentSteps = 0;
  let bar1Hits = 0;
  let bar2Hits = 0;
  for (let s = 0; s < len; s++) {
    let c = 0;
    for (const l of BREAK_LANES) {
      if (rows[l] && rows[l][s]) {
        c++;
        totalHits++;
        if (s < 8) bar1Hits++;
        else bar2Hits++;
      }
    }
    if (c > maxConcurrent) maxConcurrent = c;
    if (c === 0) silentSteps++;
  }
  return { totalHits, maxConcurrent, silentSteps, bar1Hits, bar2Hits };
}
