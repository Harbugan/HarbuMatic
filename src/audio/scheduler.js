// Transport + lookahead scheduler.
//
// Semantics:  play()   — from Stopped: start at the beginning (scene or song start)
//                        from Paused:  resume at the paused musical position
//             pause()  — keep the position, silence everything
//             stop()   — silence and return to the beginning
//             toggle() — play ⇄ pause (Space)
//
// The scheduler never touches the DOM. It pushes time-stamped events into `queue` which the
// UI drains in requestAnimationFrame when their time has come, so visuals match what is heard.
//
// Dispatch goes through instrument instances: for every playable slot it reads that slot's pattern for
// the current scene, decides by the type's pattern kind and capabilities (never by instrument name) and
// hands each hit to engine.trigger(slotId, …). Event hits are keyed by slot id.

import { DRUMS } from '../core/constants.js';
import { playableSlots, slotById, typeOfSlot, sceneIdAt } from '../core/project.js';
import { clamp } from '../core/util.js';
import { startPosition, advance, isLoopBoundary } from './position.js';

const LOOKAHEAD = .12, INTERVAL = 25;

export function createTransport(engine, getProject, hooks = {}) {
  const T = {
    state: 'stopped', pos: null, pending: null, next: 0, timer: 0, queue: [],
    get playing() { return T.state === 'playing'; },
    /** current musical position for display, even when paused */
    get position() { return T.pos; },
  };
  const emit = () => hooks.onState && hooks.onState(T.state);

  function scheduleStep(t) {
    const project = getProject(), pos = T.pos, sd = engine.stepDur();
    const sc = clamp(pos.scene, 0, Math.max(0, project.scenes.length - 1));
    if (sc !== pos.scene) T.pos = { ...pos, scene: sc };
    if (hooks.beforeStep) hooks.beforeStep(T.pos, isLoopBoundary); // e.g. auto-evolve on a loop boundary
    const ev = { time: t, step: T.pos.step, scene: sc, block: T.pos.block, song: T.pos.song, hits: {} };
    const sceneId = sceneIdAt(project, sc);
    if (sceneId) {
      for (const slot of playableSlots(project)) {
        const def = typeOfSlot(slot), caps = def.capabilities;
        const p = slot.patterns[sceneId];
        if (!p) continue;
        const ls = T.pos.step % p.len;
        const sw = ls % 2 ? project.swing * sd * .5 : 0, hits = [];
        const on = engine.audible(slot.id);
        if (def.pattern === 'drum') {
          for (const d of DRUMS) {
            const c = p.steps[d.id][ls];
            if (c && Math.random() <= c.p) { hits.push({ d: d.id, v: c.v }); if (on) engine.trigger(slot.id, t + sw, { d: d.id, v: c.v }); }
          }
        } else {
          let starts = null;
          for (const n of p.notes) {
            if (n.s !== ls) continue;
            if (n.pr != null && n.pr < 1 && Math.random() > n.pr) continue;
            let slideIn = false, slideOut = false;
            if (caps.slide) {
              starts = starts || new Set(p.notes.map(m => m.s));
              slideIn = p.notes.some(m => m.slide && (m.s + m.l) % p.len === ls);
              slideOut = !!n.slide && starts.has((n.s + n.l) % p.len);
            }
            // a mono acid voice gates shorter unless it slides on; everything else holds ~the full length
            const dur = caps.mono && !slideOut ? Math.max(sd * .45, n.l * sd - sd * .45) : n.l * sd * .98;
            const hit = { p: n.p, v: n.v, dur, slideIn, slideOut };
            if (n.slice != null) hit.slice = n.slice; // sampler slice trigger (only MUNCH notes carry it)
            hits.push(n.slice != null ? { p: n.p, v: n.v, slide: slideIn, acc: n.v > .9, slice: n.slice } : { p: n.p, v: n.v, slide: slideIn, acc: n.v > .9 });
            if (on) engine.trigger(slot.id, t + sw + (n.o || 0) * sd, hit);
          }
        }
        if (hits.length && on) ev.hits[slot.id] = hits;
      }
    }
    T.queue.push(ev);
    const r = advance(T.pos, project, T.pending);
    if (r.pendingUsed) T.pending = null;
    T.pos = r.pos;
  }
  function tick() {
    const ctx = engine.ctx;
    if (!ctx || T.state !== 'playing') return;
    // if the tab stalled, don't machine-gun the backlog — jump to now
    if (T.next < ctx.currentTime - .25) T.next = ctx.currentTime + .02;
    while (T.next < ctx.currentTime + LOOKAHEAD) { scheduleStep(T.next); T.next += engine.stepDur(); }
  }
  function run() {
    const ctx = engine.init();
    engine.openGates();
    T.next = ctx.currentTime + .06;
    T.state = 'playing';
    clearInterval(T.timer); T.timer = setInterval(tick, INTERVAL); tick();
    emit();
  }
  function halt() {
    clearInterval(T.timer); T.timer = 0;
    engine.closeGates();
    T.queue.length = 0;
  }

  Object.assign(T, {
    play() {
      if (T.state === 'playing') return;
      if (T.state === 'stopped' || !T.pos) T.pos = startPosition(getProject());
      else T.pos = { ...T.pos, fresh: true }; // resume: not a loop boundary
      run();
    },
    pause() { if (T.state !== 'playing') return; halt(); T.state = 'paused'; emit(); },
    stop() { halt(); T.pos = null; T.pending = null; T.state = 'stopped'; emit(); },
    toggle() { T.state === 'playing' ? T.pause() : T.play(); },
    /** jam mode: switch scene on the next bar line (or immediately when not playing) */
    queueScene(i) {
      const project = getProject();
      if (!Number.isInteger(i) || i < 0 || i >= project.scenes.length) return;
      const song = project.songMode && project.arrangement.length > 0;
      if (song) return; // the arrangement decides what plays
      if (T.state === 'playing') T.pending = i === T.pos.scene && !T.pos.song ? null : i;
      else if (T.state === 'paused' && T.pos) T.pos = { ...T.pos, song: false, scene: i, step: 0, fresh: true };
    },
    /** reconcile live/paused position and queued scene after dynamic scene deletion, reordering or undo/redo */
    reconcile(nextPos, nextPending = null) {
      const maxSc = Math.max(0, getProject().scenes.length - 1);
      T.pos = nextPos ? { ...nextPos, scene: clamp(nextPos.scene, 0, maxSc) } : null;
      T.pending = nextPending != null && Number.isInteger(nextPending) && nextPending >= 0 && nextPending <= maxSc ? nextPending : null;
      if (T.queue.length) {
        for (let k = T.queue.length - 1; k >= 0; k--) {
          if (T.queue[k].scene > maxSc) T.queue.splice(k, 1);
        }
      }
      emit();
    },
    /** start (or restart) the song at a given arrangement block */
    playFromBlock(k) {
      halt();
      T.pos = startPosition(getProject(), { fromBlock: k });
      T.pending = null;
      run();
    },
  });
  return T;
}

/**
 * Local lookahead preview for a single sampler slot's slice pattern (MUNCH CHOP).
 * Reuses the existing timing constants, engine, AudioContext, BPM, swing and voice dispatch
 * without starting or mutating global transport or triggering any other instrument.
 */
export function createSlicePreview(engine, getProject, hooks = {}) {
  const P = {
    state: 'stopped', slotId: null, scene: -1, step: 0, next: 0, timer: 0, queue: [],
    get playing() { return P.state === 'playing'; },
  };
  const emit = () => hooks.onState && hooks.onState(P.state);

  function scheduleStep(t) {
    const project = getProject();
    const slot = P.slotId ? slotById(project, P.slotId) : null;
    const sc = clamp(project.scene, 0, Math.max(0, project.scenes.length - 1));
    const sceneId = sceneIdAt(project, sc);
    const pat = slot && sceneId ? slot.patterns[sceneId] : null;
    if (!slot || !pat || !slot.sample) { P.stop(); return; }
    const len = Math.max(1, pat.len || 16);
    const ls = P.step % len;
    const sd = engine.stepDur();
    const sw = ls % 2 ? project.swing * sd * .5 : 0;
    const hits = [];
    for (const n of pat.notes) {
      if (n.slice == null || n.s !== ls) continue;
      if (n.pr != null && n.pr < 1 && Math.random() > n.pr) continue;
      const dur = n.l * sd * .98;
      const hit = { p: n.p, v: n.v, dur, slideIn: false, slideOut: false, slice: n.slice };
      hits.push({ p: n.p, v: n.v, slide: false, acc: n.v > .9, slice: n.slice });
      engine.trigger(slot.id, t + sw + (n.o || 0) * sd, hit, 'preview');
    }
    P.queue.push({ time: t, step: ls, scene: sc, slotId: slot.id, hits });
    P.step = (ls + 1) % len;
  }

  function tick() {
    const ctx = engine.ctx;
    if (!ctx || P.state !== 'playing') return;
    if (P.next < ctx.currentTime - .25) P.next = ctx.currentTime + .02;
    while (P.next < ctx.currentTime + LOOKAHEAD) {
      scheduleStep(P.next);
      if (P.state !== 'playing') return;
      P.next += engine.stepDur();
    }
  }

  function halt(silence = true) {
    clearInterval(P.timer); P.timer = 0;
    P.queue.length = 0;
    if (P.slotId && engine.closePreviewGate) engine.closePreviewGate(P.slotId, silence);
  }

  Object.assign(P, {
    start(slotId) {
      const project = getProject();
      const slot = slotId ? slotById(project, slotId) : null;
      if (!slot || !slot.sample) return false;
      halt(true);
      const ctx = engine.init();
      if (engine.openPreviewGate) engine.openPreviewGate(slot.id);
      P.slotId = slot.id;
      P.scene = clamp(project.scene, 0, Math.max(0, project.scenes.length - 1));
      P.step = 0;
      P.next = ctx.currentTime + .06;
      P.state = 'playing';
      P.timer = setInterval(tick, INTERVAL);
      tick();
      emit();
      return true;
    },
    stop() {
      const was = P.state !== 'stopped' || P.timer !== 0;
      halt(true);
      P.state = 'stopped';
      P.step = 0;
      P.scene = -1;
      P.slotId = null;
      if (was) emit();
    },
    toggle(slotId) {
      if (P.state === 'playing' && (!slotId || P.slotId === slotId)) { P.stop(); return false; }
      return P.start(slotId);
    },
  });
  return P;
}
