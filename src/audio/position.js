// Pure playback-position logic (no Web Audio): which scene/step plays next, when queued
// scene changes happen, how the song arrangement is walked and where loops restart.
// Positions carry scene *indexes* (what is shown); arrangement blocks reference scenes by id.
// Kept separate so it can be unit-tested deterministically.

import { maxLen, blockScene } from '../core/project.js';
import { clamp } from '../core/util.js';

export const BAR = 16;
export const LOOP_WRAP = 64; // every pattern length (16/32/64) divides this

export const songActive = project => !!project.songMode && project.arrangement.length > 0;

/**
 * @returns position { song, block, rep, scene, step, fresh }
 *   step  — steps since this scene instance started (pattern step = step % pattern.len)
 *   fresh — true for the very first step after start / scene change (not a loop boundary)
 */
export function startPosition(project, { fromBlock = 0, scene } = {}) {
  if (songActive(project)) {
    const block = clamp(fromBlock, 0, project.arrangement.length - 1);
    return { song: true, block, rep: 0, scene: blockScene(project, project.arrangement[block]), step: 0, fresh: true };
  }
  return { song: false, block: 0, rep: 0, scene: scene ?? project.scene, step: 0, fresh: true };
}

/** advance one step. Returns { pos, pendingUsed, sceneChanged } without mutating input. */
export function advance(pos, project, pending = null) {
  let { song, block, rep, scene, step } = pos;
  step++;
  let pendingUsed = false, sceneChanged = false;
  const arr = project.arrangement, sceneOf = k => blockScene(project, arr[k]);
  if (songActive(project)) {
    if (!song) { // song mode switched on while looping: join the song on the next bar line
      if (step % BAR === 0) { song = true; block = 0; rep = 0; sceneChanged = scene !== sceneOf(0); scene = sceneOf(0); step = 0; }
      else if (step >= LOOP_WRAP) step = 0;
    } else {
      if (block >= arr.length) { block = 0; rep = 0; }
      if (step >= maxLen(project, scene)) {
        step = 0; rep++;
        const b = arr[block];
        if (rep >= b.reps || sceneOf(block) !== scene) {
          block = (block + 1) % arr.length; rep = 0;
          sceneChanged = sceneOf(block) !== scene;
          scene = sceneOf(block);
        }
      }
    }
  } else {
    song = false;
    if (pending != null && step % BAR === 0) { sceneChanged = pending !== scene; scene = pending; step = 0; pendingUsed = true; }
    else if (step >= LOOP_WRAP) step = 0;
  }
  return { pos: { song, block, rep, scene, step, fresh: sceneChanged }, pendingUsed, sceneChanged };
}

/** a pattern of `len` steps restarts at this position (excludes the very first step after start) */
export const isLoopBoundary = (pos, len) => !pos.fresh && pos.step % len === 0;
