// Application state container + a tiny event bus.
// `project` is the portable song data; `ui` is view state that never goes into the song file.
// Instruments are addressed by slot id ('slot-01' …), never by instrument name.

import { slotById, typeOfSlot, patternAt, playableSlots } from '../core/project.js';
import { isPlayableType, MUNCH_TYPE } from '../core/instruments.js';

const listeners = new Map();
export const on = (evt, fn) => { if (!listeners.has(evt)) listeners.set(evt, new Set()); listeners.get(evt).add(fn); return () => listeners.get(evt).delete(fn); };
export const emit = (evt, data) => { (listeners.get(evt) || []).forEach(fn => fn(data)); (listeners.get('*') || []).forEach(fn => fn(evt, data)); };

const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

export const store = {
  project: null,
  ui: {
    sel: 'slot-01',         // selected instrument slot
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
    previewPlanned: false,  // dev only (?preview=five): show planned instruments as inert layout placeholders
  },
};
export const slot = (id = store.ui.sel) => slotById(store.project, id);
/** registry definition of a slot's instrument type */
export const typeOf = (id = store.ui.sel) => typeOfSlot(slot(id));
export const isDrumSlot = (id = store.ui.sel) => typeOf(id).pattern === 'drum';
export const P = id => slot(id).params;
export const pat = (id = store.ui.sel, sc = store.project.scene) => patternAt(store.project, id, sc);
/** the instrument slots shown and played (planned types such as MUNCH are left out) */
export const visibleSlots = () => playableSlots(store.project);
/**
 * Slots that get an instrument card: the visible ones, plus (dev preview only) planned slots as inert
 * placeholders, so the five-card layout can be checked before MUNCH is playable. Never used for selection,
 * keyboard shortcuts, audio or the LCD.
 */
export const cardSlotList = () => (store.ui.previewPlanned ? store.project.slots.filter(s => isPlayableType(s.type) || s.type === MUNCH_TYPE) : visibleSlots());
export function uiTop(id = store.ui.sel) { const u = store.ui; if (u.top[id] == null) u.top[id] = typeOf(id).ui.viewTop ?? 79; return u.top[id]; }
export function uiLastLen(id = store.ui.sel) { const u = store.ui; if (u.lastLen[id] == null) u.lastLen[id] = typeOf(id).ui.noteLength ?? 1; return u.lastLen[id]; }
/** keep the selection on a visible slot after a project change */
export function ensureSelection() {
  const vis = visibleSlots();
  if (vis.length && !vis.some(s => s.id === store.ui.sel)) store.ui.sel = vis[0].id;
}
