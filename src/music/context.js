// Shared musical context: everything a generator needs to know about the scene it writes
// into — key, scale, harmony, groove (kick/snare placement), mood, density and chaos.
// Generators never read global state; they get a context + an rng.

import { TRACKS, MELODIC } from '../core/constants.js';
import { clamp } from '../core/util.js';
import { makeScale } from './theory.js';
import { chooseHarmony, inferHarmony } from './harmony.js';

export function harmonySpanFor(patterns, forLen = 16) {
  const lens = MELODIC.filter(t => patterns[t].notes.length).map(t => patterns[t].len);
  return clamp(Math.max(forLen, ...lens, 32), 16, 64);
}

/**
 * @param project  v5 project
 * @param sceneIdx scene to write into
 * @param opts     { rng, forLen, ensureHarmony, overrides: { mood, chaos, density } }
 */
export function buildContext(project, sceneIdx, { rng, forLen = 16, ensureHarmony = true, overrides = {} } = {}) {
  const lab = { ...project.lab, ...overrides };
  const patterns = {};
  TRACKS.forEach(t => { patterns[t] = project.tracks[t].patterns[sceneIdx]; });
  let harmony = project.scenes[sceneIdx].harmony, harmonyNew = false;
  if (!harmony && ensureHarmony) {
    const span = harmonySpanFor(patterns, forLen);
    const n = span >= 32 ? 4 : 2;
    harmony = inferHarmony(project.key, project.scale, patterns, span, n)
      || chooseHarmony(rng, { key: project.key, scale: project.scale, mood: lab.mood, chaos: lab.chaos, span });
    harmonyNew = true;
  }
  const dr = patterns.drums;
  const cellAt = (id, step) => { const c = dr.steps[id][((step % dr.len) + dr.len) % dr.len]; return c && c.p >= .6 ? c.v : 0; };
  return {
    key: project.key, scaleName: project.scale, scale: makeScale(project.key, project.scale),
    mood: lab.mood, chaos: lab.chaos, density: lab.density, targets: lab.targets,
    harmony, harmonyNew, patterns,
    kickAt: step => cellAt('kick', step),
    backbeatAt: step => Math.max(cellAt('snare', step), cellAt('clap', step)),
    hasDrums: dr.steps.kick.some(Boolean),
  };
}
