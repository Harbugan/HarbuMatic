// Application state container + a tiny event bus.
// `project` is the portable song data; `ui` is view state that never goes into the song file.
// Instruments are addressed by slot id ('slot-01' …), never by instrument name.

import { slotById, typeOfSlot, patternAt, selectableSlots } from '../core/project.js';
import { isPlayableType } from '../core/instruments.js';

const listeners = new Map();
export const on = (evt, fn) => { if (!listeners.has(evt)) listeners.set(evt, new Set()); listeners.get(evt).add(fn); return () => listeners.get(evt).delete(fn); };
export const emit = (evt, data) => { (listeners.get(evt) || []).forEach(fn => fn(data)); (listeners.get('*') || []).forEach(fn => fn(evt, data)); };

const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

export const MAX_VISIBLE_CARDS = 5;

export const store = {
  project: null,
  ui: {
    sel: 'slot-01',         // selected instrument slot
    stripOffset: 0,         // first visible slot index when > MAX_VISIBLE_CARDS slots exist
    mode: 'jam',            // jam | arrange | sound
    expanded: false,        // Deep edit (expanded JAM)
    drawer: false,          // Lab drawer open (portrait / expanded)
    rtab: 'lab',            // lab | scenes
    tool: 'draw',
    zoom: 1, scrollX: 0,
    top: {},                // highest visible pitch per melodic slot (defaults: registry ui.viewTop)
    fold: true,             // show only in-scale rows
    lastLen: {},            // last drawn note length per slot (defaults: registry ui.noteLength)
    drumRow: 0,
    motion: !reducedMotion,
    coarse,
    autoEvolve: false,
    labOpen: { more: false, key: false, snaps: false },
    arrSel: null,           // selected arrangement block id
    libSel: null,           // selected scene in the arrange library
    // MUNCH workspace (SOUND view of a sampler slot): view state only, never saved in the song
    munch: {
      tab: 'play',          // play | chop | twist
      sel: 0,               // selected slice (shared by waveform, pads and sequencer)
      marker: null,         // selected boundary index (for delete / nudge), or null
      cursor: 0,            // editor cursor, fraction of the whole sample
      zoom: 1, view: 0,     // waveform zoom and left edge (fraction)
      bank: 0, page: 0,     // pad bank (slices 1–8 / 9–16) and sequencer page (16 steps)
      octave: 0,            // keyboard octave shift
      tool: 'draw',         // CHOP sequencer tool: draw | accent | lock
      style: 'straight',    // MAGIC CHOP style
      magic: null,          // pending MAGIC CHOP result { slot, scene, before, after, style, seed }
    },
    // MUNCH opens SOUND when selected unless the player left it on purpose (see selectSlot / setMode in actions.js)
    munchNav: { away: false, autoFrom: null },
    // Live pattern recording state (view/session state only, never saved in the song)
    rec: { mode: 'off', quantize: true },
    // RUFF workspace view state (never saved in the song)
    ruff: {
      audition: null, selStep: 0, selLane: 'a', chopMode: 'new', profile: 'jungle', intensity: 0.5,
      editBreakId: null, editSlice: 0, editMarker: null, editCursor: 0,
    },
  },
};
export const slot = (id = store.ui.sel) => slotById(store.project, id);
/** registry definition of a slot's instrument type */
export const typeOf = (id = store.ui.sel) => typeOfSlot(slot(id));
export const isDrumSlot = (id = store.ui.sel) => typeOf(id).pattern === 'drum';
export const isBreakSlot = (id = store.ui.sel) => { const s = slot(id); return !!(s && typeOfSlot(s).pattern === 'break'); };
export const isPlaceholderSlot = (id = store.ui.sel) => { const s = slot(id); return !!(s && !isPlayableType(s.type)); };
export const P = id => slot(id).params;
export const pat = (id = store.ui.sel, sc = store.project.scene) => patternAt(store.project, id, sc);
/** the instrument slots shown and selectable in the UI (playable + intentional placeholders) */
export const visibleSlots = () => selectableSlots(store.project);
export function uiTop(id = store.ui.sel) { const u = store.ui; if (u.top[id] == null) u.top[id] = typeOf(id).ui.viewTop ?? 79; return u.top[id]; }
export function uiLastLen(id = store.ui.sel) { const u = store.ui; if (u.lastLen[id] == null) u.lastLen[id] = typeOf(id).ui.noteLength ?? 1; return u.lastLen[id]; }
/** keep the selection and strip window valid after a project change */
export function ensureSelection() {
  const vis = visibleSlots();
  if (vis.length && !vis.some(s => s.id === store.ui.sel)) store.ui.sel = vis[0].id;
  const maxOff = Math.max(0, vis.length - MAX_VISIBLE_CARDS);
  store.ui.stripOffset = Math.max(0, Math.min(store.ui.stripOffset || 0, maxOff));
  const idx = vis.findIndex(s => s.id === store.ui.sel);
  if (idx >= 0) {
    if (idx < store.ui.stripOffset) store.ui.stripOffset = idx;
    else if (idx >= store.ui.stripOffset + MAX_VISIBLE_CARDS) store.ui.stripOffset = idx - MAX_VISIBLE_CARDS + 1;
  }
}
/** the selected slot is a sampler (MUNCH): SOUND shows its workspace instead of the generic knobs */
export const isSamplerSlot = (id = store.ui.sel) => { const s = slot(id); return !!(s && typeOfSlot(s).capabilities.samples); };
