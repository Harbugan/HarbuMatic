// Application state container + a tiny event bus.
// `project` is the portable song data; `ui` is view state that never goes into the song file.

import { TRACKS } from '../core/constants.js';

const listeners = new Map();
export const on = (evt, fn) => { if (!listeners.has(evt)) listeners.set(evt, new Set()); listeners.get(evt).add(fn); return () => listeners.get(evt).delete(fn); };
export const emit = (evt, data) => { (listeners.get(evt) || []).forEach(fn => fn(data)); (listeners.get('*') || []).forEach(fn => fn(evt, data)); };

const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

export const store = {
  project: null,
  ui: {
    sel: 'drums',           // selected instrument
    mode: 'jam',            // jam | arrange | sound
    expanded: false,        // Deep edit (expanded JAM)
    drawer: false,          // Lab drawer open (portrait / expanded)
    rtab: 'lab',            // lab | scenes
    tool: 'draw',
    zoom: 1, scrollX: 0,
    top: { bass: 45, synth: 79, fuzz: 86 },  // highest visible pitch per melodic track
    fold: true,             // show only in-scale rows
    lastLen: { bass: 1, synth: 2, fuzz: 8 },
    drumRow: 0,
    motion: !reducedMotion,
    coarse,
    autoEvolve: false,
    labOpen: { more: false, key: false, snaps: false },
    arrSel: null,           // selected arrangement block id
    libSel: null,           // selected scene in the arrange library
  },
};
export const P = t => store.project.tracks[t].params;
export const pat = (t = store.ui.sel, sc = store.project.scene) => store.project.tracks[t].patterns[sc];
export { TRACKS };
