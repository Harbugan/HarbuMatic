// MAGIC CHOP: musically structured slice patterns for MUNCH (v0.6 Phase 4). Pure and deterministic (seeded rng),
// no DOM, no audio — so it runs and is tested in Node.
//
// Idea: without transient detection we still know *where* each slice sits in the loop at the current tempo and tape
// speed (its home step, see sliceHomeSteps). A slice that starts on beat 1 or 3 of the original bar most likely holds
// a kick, one on beat 2 or 4 a snare, the others ghost notes and hats. MAGIC CHOP fills one-bar rhythm templates with
// slices of the matching role, so kicks land where kicks belong and the result stays a groove, not note soup.
// Bars repeat (A A' A A'') with fills at phrase ends: repetition first, controlled variation second.
//
// Lock semantics (same as the Lab transforms): locked notes are kept; a step that holds a locked note gets no new
// notes. Melodic notes (no `slice`) are left alone: MAGIC CHOP only writes slice notes.

import { createRng } from '../core/rng.js';
import { sliceCount, sliceHomeSteps, SLICE_REF_PITCH } from '../core/samples.js';

export const MAGIC_STYLES = Object.freeze(['straight', 'syncopated', 'halftime', 'playful', 'chaos']);
export const MAGIC_LABEL = Object.freeze({ straight: 'Straight', syncopated: 'Syncopated', halftime: 'Half-time', playful: 'Playful', chaos: 'Chaos' });

// one bar = 16 steps. K kick role · S snare role · O off-beat · G ghost (soft) · R repeat the previous hit · . rest
const TEMPLATES = {
  straight: ['K.O.S.O.K.O.S.O.'],
  syncopated: ['K.O.S..K..K.S.O.', 'K..KS.O..KK.S..O', 'K.O.S.OK.OK.S..G'],
  halftime: ['K.......S.......', 'K..O..K.S..O...G', 'K.....O.S.K..O..'],
  playful: ['KRO.S.O.KRO.S.SR', 'K.O.SKOSK..OS.SR', 'K.OKS.OKK.O.S.KR'],
};
const FILLS = ['SRRR', 'SSOS', 'OSRS', 'KSRR'];
const VEL = { K: .95, S: .9, O: .7, G: .45, R: .6 };

/** metrical role of a slice from its home step: 'K' (beats 1/3), 'S' (beats 2/4), 'O' (8th off-beat), 'G' (16th) */
export function sliceRoles(home) {
  return home.map(h => {
    const pos = ((Math.round(h) % 16) + 16) % 16;
    if (pos % 4 === 2) return 'O';
    if (pos % 4) return 'G';
    return pos % 8 === 0 ? 'K' : 'S';
  });
}

/** candidate slices per role, with sensible fallbacks so every role has at least one slice */
function candidates(roles, n) {
  const by = r => roles.map((x, k) => (x === r ? k : -1)).filter(k => k >= 0);
  const K = by('K'), S = by('S'), O = by('O'), G = by('G');
  const rest = Array.from({ length: n }, (_, k) => k);
  return {
    K: K.length ? K : [0],
    S: S.length ? S : [Math.min(n - 1, Math.round(n / 4)) || (n > 1 ? 1 : 0)],
    O: O.length ? O : G.length ? G : rest.filter(k => !K.includes(k)).length ? rest.filter(k => !K.includes(k)) : rest,
    G: G.length ? G : O.length ? O : rest,
  };
}

/** play the loop as recorded: each slice on its home step, repeating every `span` steps */
function asRecorded(home, span, len) {
  const out = Array(len).fill(null);
  for (let r = 0; r < len; r += span) home.forEach((h, k) => { const s = r + Math.round(h); if (s < len && s < r + span && !out[s]) out[s] = { k, role: 'K', v: Math.round(h) % 4 ? .7 : .9 }; });
  return out;
}

/** fill one bar from a template */
function fromTemplate(tpl, pick) {
  const out = Array(16).fill(null);
  let prev = null;
  [...tpl].forEach((ch, s) => {
    if (ch === '.') return;
    if (ch === 'R') { if (prev) out[s] = { k: prev.k, role: 'R', v: Math.max(.4, prev.v - .2) }; return; }
    prev = out[s] = { k: pick(ch), role: ch, v: VEL[ch] };
  });
  return out;
}

/**
 * @param pattern   the MUNCH pattern of the current scene { len, notes }
 * @param slices    the sample's slice boundaries
 * @param duration  sample length in seconds
 * @param rate      tape speed (fit rate; 1 = original speed)
 * @param bpm       project tempo
 * @param style     one of MAGIC_STYLES
 * @param seed      rng seed (same inputs + seed → same pattern)
 * @returns { pattern, info: { style, seed, notes } }   (the input pattern is not mutated)
 */
export function magicChop({ pattern, slices, duration, rate = 1, bpm = 120, style = 'straight', seed = 1 }) {
  const len = pattern.len, n = sliceCount(slices), rng = createRng(seed >>> 0);
  const kept = pattern.notes.filter(x => x.locked || x.slice == null).map(x => ({ ...x }));
  if (!n) return { pattern: { len, notes: kept }, info: { style, seed, notes: 0 } };
  if (!MAGIC_STYLES.includes(style)) style = 'straight';
  const lockedSteps = new Set(pattern.notes.filter(x => x.locked).map(x => x.s));

  // where the slices sit at this tempo; a sample shorter than a beat falls back to evenly spread slices
  let home = sliceHomeSteps(slices, duration, rate, bpm);
  const span = Math.round(((slices[n] - slices[0]) * duration / rate) / (60 / bpm / 4)); // steps the sliced area lasts
  const tiny = !(duration > 0) || span < 4;
  if (tiny) home = home.map((_, k) => (k * 16) / n);
  const C = candidates(sliceRoles(home), n);

  // per phrase one kick and one snare voice (repetition), off-beats cycle through their slices
  const voice = { K: rng.pick(C.K), S: rng.pick(C.S) };
  const offs = rng.shuffle(C.O), ghosts = rng.shuffle(C.G);
  let oi = 0, gi = 0;
  const pick = ch => (ch === 'K' ? voice.K : ch === 'S' ? voice.S : ch === 'O' ? offs[oi++ % offs.length] : ghosts[gi++ % ghosts.length]);

  const bars = len / 16, steps = Array(len).fill(null);
  if (style === 'straight' && !tiny) {
    asRecorded(home, Math.max(4, span), len).forEach((h, s) => { steps[s] = h; });
  } else {
    const list = TEMPLATES[style === 'chaos' || style === 'straight' ? 'straight' : style];
    const A = style === 'chaos' ? null : rng.pick(list);
    const B = style === 'playful' ? rng.pick(list.filter(t => t !== A).concat(A)) : A; // call and response
    for (let b = 0; b < bars; b++) {
      oi = 0; gi = 0; // every bar re-reads the same voices: repetition
      let bar;
      if (style === 'chaos') bar = chaosBar(rng, pick, b);
      else bar = fromTemplate(b % 2 ? B : A, pick);
      bar.forEach((h, i) => { steps[b * 16 + i] = h; });
    }
  }
  // phrase-end fills: the second bar of every two (the last 2 steps of a one-bar loop, half the time)
  const fill = rng.pick(FILLS);
  for (let b = 0; b < bars; b++) {
    const last = b === bars - 1, size = bars === 1 ? (rng.chance(.5) ? 2 : 0) : b % 2 ? (last && bars === 4 ? 4 : rng.chance(.7) ? 4 : 0) : 0;
    if (!size) continue;
    oi = 0; gi = 0;
    const f = fill.slice(4 - size), at = b * 16 + 16 - size;
    let prev = steps[at - 1] && steps[at - 1].k != null ? steps[at - 1] : { k: voice.S, v: .7 };
    [...f].forEach((ch, i) => {
      const v = .55 + .4 * ((i + 1) / size);
      steps[at + i] = ch === 'R' ? { k: prev.k, role: 'R', v } : (prev = { k: pick(ch), role: ch, v });
    });
  }

  const gen = [];
  const hitSteps = steps.map((h, s) => (h ? s : -1)).filter(s => s >= 0);
  hitSteps.forEach((s, i) => {
    if (lockedSteps.has(s)) return;
    const h = steps[s], next = hitSteps[i + 1] ?? len, cap = style === 'halftime' ? 8 : 4;
    gen.push({ s, p: SLICE_REF_PITCH, l: Math.max(1, Math.min(cap, next - s, len - s)), v: Math.round(h.v * 100) / 100, slice: h.k });
  });
  const notes = [...kept, ...gen].sort((a, b) => a.s - b.s || (a.slice ?? -1) - (b.slice ?? -1));
  return { pattern: { len, notes }, info: { style, seed, notes: gen.length } };
}

/** controlled chaos: anchors stay (downbeat, mostly backbeats), the rest is weighted by metre and bounded in density */
function chaosBar(rng, pick, b) {
  const tpl = [...'K...S...K...S...'];
  if (rng.chance(.2)) tpl[12] = '.'; // a dropped backbeat now and then
  for (let s = 1; s < 16; s++) {
    if (tpl[s] !== '.') continue;
    const w = s % 4 === 2 ? .5 : s % 2 ? .3 : .45;
    if (rng.chance(w)) tpl[s] = rng.weighted(['O', 'G', 'R', 'K', 'S'], [4, 3, 2, 1, b % 2 ? 1.5 : .5]);
  }
  // bound density: never more than 11 hits in a bar
  let hits = tpl.filter(c => c !== '.').length;
  for (let s = 15; s > 0 && hits > 11; s--) if (tpl[s] !== '.' && s % 4) { tpl[s] = '.'; hits--; }
  return fromTemplate(tpl.join(''), pick);
}
