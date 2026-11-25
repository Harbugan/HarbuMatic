// JAM toolbar. Standard = Play & Create (draw/erase + expand). Expanded = Deep Edit
// (every editing tool, length, zoom, scale fold, octave). Both drive the same sequencer.

import { store, pat, slot, P, typeOf, isDrumSlot, isBreakSlot, isPlaceholderSlot } from '../app/store.js';
import * as A from '../app/actions.js';
import { sceneLabel } from '../core/constants.js';
import { BREAK_LANES } from '../core/instruments.js';
import { getBuiltinBreak, laneMuteKey } from '../core/breaks.js';
import { $, h, btn } from '../ui/dom.js';
import { ico } from '../ui/icons.js';
import { Seg } from '../ui/controls.js';
import { catSVG } from '../ui/characters.js';
import * as Seq from '../ui/sequencer.js';
import { occupancy } from './strip.js';
import { playhead } from '../ui/sequencer.js';

// which tools an instrument offers comes from the registry (ui.tools); labels live here
const TOOL_LABEL = { draw: 'Draw', erase: 'Erase', vel: 'Velocity', prob: 'Chance', slide: 'Slide', lock: 'Lock' };
const toolsFor = def => def.ui.tools.map(k => [k, k === 'lock' && def.pattern === 'drum' ? 'Lock row' : TOOL_LABEL[k]]);
const HINTS = {
  draw: { drums: 'Tap cells to add or remove hits · drag to paint', mel: 'Tap to add · tap a note to remove · drag to move · drag its right edge to resize' },
  erase: 'Tap or drag over notes to remove them',
  vel: 'Tap a note or hit: soft → normal → accent',
  prob: 'Tap to set the chance it plays: 100 → 75 → 50 → 25%',
  slide: 'Tap a GOO note to glide into the next one',
  lock: 'Locked notes and rows survive Generate, Mutate & friends',
};
export const hintFor = () => {
  if (isBreakSlot()) return `${typeOf().name} plays your A/B/C breaks in sync with the tempo — assign, audition & mix them in SOUND`;
  if (isPlaceholderSlot()) return `${typeOf().name} is a non-playing foundation slot`;
  const t = store.ui.tool, x = HINTS[t] || '';
  return typeof x === 'string' ? x : x[isDrumSlot() ? 'drums' : 'mel'];
};

const COMMON_TOOLS = new Set(['draw', 'erase', 'vel', 'prob', 'lock']);

function renderBreakJamSummary(m) {
  const host = $('#ruffPlaceholder');
  if (!host) return;
  const sl = slot(), p = P();
  host.innerHTML = '';
  const lanes = h('div', { class: 'ruff-lanes' }, BREAK_LANES.map(l => {
    const id = sl && sl.breaks && sl.breaks[l];
    const desc = id ? getBuiltinBreak(id) : null;
    const muted = !!(p && p[laneMuteKey(l)]);
    return h('div', { class: 'ruff-lane-pill' + (id ? ' loaded' : '') + (muted ? ' muted' : '') },
      h('b', {}, `Break ${l.toUpperCase()}${muted ? ' · Muted' : ''}`),
      h('span', {}, desc ? `${desc.name} (${desc.bpm} BPM)` : (id || 'Empty')));
  }));
  const activeCount = BREAK_LANES.filter(l => sl && sl.breaks && sl.breaks[l] && !(p && p[laneMuteKey(l)])).length;
  const tag = A.transport.playing && A.engine.audible(sl.id) && activeCount
    ? `Playing · ${activeCount} break${activeCount === 1 ? '' : 's'}`
    : `${p && p.fitMode === 'tape' ? 'Tape' : 'Stretch'} · ${store.project.bpm} BPM`;
  host.append(
    h('div', { class: 'ruff-ph-card' },
      h('div', { class: 'cat ' + m.visual.css, html: catSVG(m.type) }),
      h('div', { class: 'ruff-ph-body' },
        h('div', { class: 'ruff-ph-head' },
          h('h3', {}, `${m.name} · ${m.description}`),
          h('span', { class: 'ruff-ph-tag' }, tag)),
        h('p', {}, 'Assign built-in breaks to A, B and C, audition them, balance lane levels, and switch Stretch / Tape in SOUND. Break slicing & hybrid sequencer arrive next.'),
        lanes,
        h('div', { class: 'ruff-ph-actions' },
          h('button', { type: 'button', class: 'tool on', onclick: () => A.setMode('sound') }, `Open ${m.name} Break Pool`)))));
}

export function renderJamBar() {
  const u = store.ui, m = typeOf(), p = pat(), drums = m.pattern === 'drum', noRoll = isPlaceholderSlot() || isBreakSlot(), TOOLS = toolsFor(m);
  const bar = $('#jamBar'); bar.innerHTML = '';
  bar.classList.toggle('deep', !!u.expanded && !noRoll);
  const sc = store.project.scene;
  const rollWrap = $('#rollWrap'), ph = $('#ruffPlaceholder'), leds = $('#leds');
  if (rollWrap) rollWrap.hidden = noRoll;
  if (ph) ph.hidden = !noRoll;
  if (leds) leds.hidden = noRoll;

  const chip = h('div', { class: 'chip' }, h('span', { class: 'dot' }), h('span', { class: 'chip-name' }, m.name), h('span', { class: 'chip-scene' }, `${sceneLabel(sc)} · ${store.project.scenes[sc].name}`));
  if (noRoll) {
    const actions = h('div', { class: 'tgroup tb-actions' },
      btn({ icon: ico('lab'), label: 'Lab', cls: 'tool lab-toggle', title: 'Open the Happy Accident Lab', onClick: () => A.setDrawer(!store.ui.drawer) }));
    bar.append(chip, h('span', { class: 'spacer' }), actions);
    $('#edHint').textContent = hintFor();
    renderBreakJamSummary(m);
    return;
  }

  if (!u.expanded && !['draw', 'erase'].includes(u.tool)) u.tool = 'draw'; // standard mode: simple tools only
  if (!TOOLS.some(([k]) => k === u.tool)) u.tool = 'draw';
  const makeToolBtn = ([k, label]) => {
    const b = btn({ icon: ico(k), label, cls: 'tool' + (u.tool === k ? ' on' : ''), pressed: u.tool === k, onClick: () => A.setTool(k) });
    b.dataset.tool = k;
    return b;
  };
  const actions = h('div', { class: 'tgroup tb-actions' },
    btn({ icon: ico('lab'), label: 'Lab', cls: 'tool lab-toggle', title: 'Open the Happy Accident Lab', onClick: () => A.setDrawer(!store.ui.drawer) }),
    btn({ icon: ico('clear'), label: 'Clear', cls: 'tool', title: 'Clear this instrument in this scene (locked notes stay)', onClick: A.clearPattern }),
    btn({ icon: ico(u.expanded ? 'collapse' : 'expand'), label: u.expanded ? 'Done' : 'Deep edit', cls: 'tool expand' + (u.expanded ? ' on' : ''), title: u.expanded ? 'Back to the simple view (F)' : 'Expand the sequencer with all editing tools (F)', onClick: () => A.setExpanded(!u.expanded) }));
  actions.children[0].dataset.action = 'lab';
  actions.children[1].dataset.action = 'clear';
  actions.children[2].dataset.action = 'expand';

  if (u.expanded) {
    // Deep edit: two structured rows so common tools, Bars/Zoom, and Lab/Clear/Done never shift across instruments
    const commonTools = TOOLS.filter(([k]) => COMMON_TOOLS.has(k));
    const extraTools = TOOLS.filter(([k]) => !COMMON_TOOLS.has(k));
    const tools = h('div', { class: 'tgroup tb-tools' }, commonTools.map(makeToolBtn));
    const mainRow = h('div', { class: 'tb-row tb-main' }, chip, tools, actions);

    const bars = h('div', { class: 'tgroup tb-bars' }, h('span', { class: 'glbl' }, 'Bars'),
      Seg([[16, '1'], [32, '2'], [64, '4']], p.len, v => A.setLength(v), { label: 'Pattern length in bars' }),
      btn({ icon: ico('dup'), label: '×2', cls: 'tool', title: 'Double the pattern (copies content)', disabled: p.len >= 64, onClick: A.doubleLength }));
    const zoom = h('div', { class: 'tgroup tb-zoom' }, h('span', { class: 'glbl' }, 'Zoom'),
      Seg([[1, '1×'], [2, '2×', p.len / 2 < 8], [4, '4×', p.len / 4 < 8]], u.zoom, v => { u.zoom = v; u.scrollX = 0; Seq.render(); }, { label: 'Zoom' }));
    // Dedicated instrument-specific zone (e.g. GOO Slide + melodic scale/octave controls)
    const inst = h('div', { class: 'tgroup tb-inst' });
    extraTools.forEach(t => inst.append(makeToolBtn(t)));
    if (!drums) {
      inst.append(btn({ icon: ico('scale'), label: u.fold ? 'In key' : 'All notes', cls: 'tool fold' + (u.fold ? ' on' : ''), pressed: u.fold, title: 'Show only notes in the key (fewer wrong notes, bigger rows)', onClick: () => { u.fold = !u.fold; Seq.fitView(); renderJamBar(); Seq.render(); } }));
      inst.append(btn({ icon: ico('up'), label: 'Oct', cls: 'tool narrow', title: 'Octave up', onClick: () => Seq.octave(1) }), btn({ icon: ico('down'), label: 'Oct', cls: 'tool narrow', title: 'Octave down', onClick: () => Seq.octave(-1) }));
    }
    if (!inst.children.length) inst.classList.add('empty');
    const subRow = h('div', { class: 'tb-row tb-sub' }, bars, zoom, inst);
    bar.append(mainRow, subRow);
  } else {
    const tools = h('div', { class: 'tgroup tb-tools' }, TOOLS.slice(0, 2).map(makeToolBtn));
    bar.append(chip, tools);
    if (!drums) {
      bar.append(h('div', { class: 'tgroup tb-inst' },
        btn({ icon: ico('up'), label: 'Oct', cls: 'tool narrow', title: 'Octave up', onClick: () => Seq.octave(1) }),
        btn({ icon: ico('down'), label: 'Oct', cls: 'tool narrow', title: 'Octave down', onClick: () => Seq.octave(-1) })));
    }
    bar.append(h('span', { class: 'spacer' }), actions);
  }
  $('#edHint').textContent = hintFor();
}

export function updateLeds() {
  const leds = $('#leds'); if (!leds || isPlaceholderSlot() || isBreakSlot()) return;
  if (leds.children.length !== 16) { leds.innerHTML = ''; for (let i = 0; i < 16; i++) leds.append(h('i', { class: i % 4 === 0 ? 'beat' : '' })); }
  const p = pat(), sc = store.project.scene, occ = occupancy(store.ui.sel, sc, p.len);
  const live = A.transport.playing && playhead.scene === sc && playhead.step >= 0;
  const local = live ? playhead.step % p.len : -1;
  const bar = live ? Math.floor(local / 16) : 0;
  for (let i = 0; i < 16; i++) {
    leds.children[i].classList.toggle('has', !!occ[bar * 16 + i]);
    leds.children[i].classList.toggle('now', live && local % 16 === i);
  }
}
