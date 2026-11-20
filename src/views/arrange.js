// ARRANGE: Scene Library (reusable scenes A–F) → Song Arrangement (ordered scene instances).
// Direct manipulation: drag blocks to reorder; tap a block for its contextual actions
// (move, repeat, duplicate, remove, edit, play from here) — the button fallback for drag.

import { store, visibleSlots } from '../app/store.js';
import * as A from '../app/actions.js';
import { SCENE_LETTERS, MAX_REPS } from '../core/constants.js';
import { getInstrumentType } from '../core/instruments.js';
import { maxLen, sceneHasContent, blockScene } from '../core/project.js';
import { $, $$, h, btn } from '../ui/dom.js';
import { ico } from '../ui/icons.js';
import { Seg, promptDialog, confirmDialog } from '../ui/controls.js';
import { harmonyLabel } from '../music/harmony.js';
import { occupancy } from './strip.js';

function miniMap(sc, cells = 16) {
  return h('div', { class: 'map', 'aria-hidden': 'true' }, visibleSlots().map(s => h('div', {}, occupancy(s.id, sc, cells).map(o => { const c = h('i'); if (o) c.style.background = getInstrumentType(s.type).visual.dark; return c; }))));
}
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export function renderArrange() {
  const host = $('#viewArr'); const scroll = host.scrollTop; host.innerHTML = '';
  const p = store.project, u = store.ui, arr = p.arrangement;
  if (u.libSel == null) u.libSel = p.scene;
  const totalSteps = arr.reduce((a, b) => a + maxLen(p, blockScene(p, b)) * b.reps, 0);
  host.append(h('div', { class: 'view-head' },
    h('div', { class: 'chip lav' }, h('span', { class: 'dot' }), h('span', { class: 'chip-name' }, 'ARRANGE'), h('span', { class: 'chip-scene' }, 'scenes → song')),
    h('span', { class: 'spacer' }),
    h('span', { class: 'glbl' }, 'Play'),
    Seg([[false, 'Loop scene'], [true, 'Whole song', !arr.length]], !!p.songMode && arr.length > 0, v => A.setSongMode(v), { label: 'Playback mode' })));

  // --- song lane
  host.append(h('div', { class: 'arr-title' }, h('b', {}, 'Song'),
    h('span', { class: 'hint' }, arr.length ? `${arr.length} block${arr.length > 1 ? 's' : ''} · ${totalSteps / 16} bars · ${fmtTime(totalSteps * A.engine.stepDur())} · drag to reorder, tap for options` : ''),
    h('span', { class: 'spacer' }),
    arr.length ? btn({ icon: ico('trash'), label: 'Clear song', cls: 'mini ghost', onClick: () => confirmDialog('Clear the song?', 'All blocks are removed from the arrangement. Your scenes stay untouched. (Undo can bring it back.)', 'Clear song', A.clearSong, { danger: true }) }) : null));
  const lane = h('div', { class: 'chain', id: 'chain' });
  if (!arr.length) lane.append(h('div', { class: 'chain-empty' }, h('b', {}, 'Your song is empty'), h('span', {}, 'Pick a scene above and press “+ Add” — scenes can appear as many times as you like.')));
  const pos = A.transport.position;
  arr.forEach((b, k) => {
    const bs = blockScene(p, b), sc = p.scenes[bs];
    const now = A.transport.state !== 'stopped' && pos && pos.song && pos.block === k;
    const el = h('div', { class: 'cblock' + (u.arrSel === b.id ? ' sel' : '') + (now ? ' now' : ''), 'data-id': b.id, 'data-k': k, role: 'button', tabindex: 0, 'aria-label': `Block ${k + 1}: scene ${SCENE_LETTERS[blockScene(p, b)]} ${sc.name}, ${b.reps} time${b.reps > 1 ? 's' : ''}` },
      h('span', { class: 'grip', html: ico('grab') }),
      h('span', { class: 'L' }, SCENE_LETTERS[blockScene(p, b)]),
      h('small', {}, sc.name),
      b.reps > 1 ? h('span', { class: 'reps' }, `×${b.reps}`) : null,
      miniMap(blockScene(p, b), 8));
    attachDrag(el, b.id);
    el.onkeydown = e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); u.arrSel = u.arrSel === b.id ? null : b.id; renderArrange(); }
      if (e.key === 'ArrowLeft' && e.altKey) A.moveBlock(b.id, k - 1);
      if (e.key === 'ArrowRight' && e.altKey) A.moveBlock(b.id, k + 1);
    };
    lane.append(el);
  });
  if (u.libSel != null) {
    const add = h('button', { type: 'button', class: 'cblock add' }, h('span', { class: 'L', html: ico('plus') }), h('small', {}, `Add ${SCENE_LETTERS[u.libSel]}`));
    add.onclick = () => A.addToSong(u.libSel);
    lane.append(add);
  }
  host.append(lane);

  // --- contextual actions for the selected block
  const k = arr.findIndex(b => b.id === u.arrSel);
  if (k >= 0) {
    const b = arr[k];
    host.append(h('div', { class: 'ctxbar', role: 'toolbar', 'aria-label': 'Block actions' },
      h('span', { class: 'ctx-title' }, `Block ${k + 1} · ${SCENE_LETTERS[blockScene(p, b)]}`),
      btn({ icon: ico('left'), label: 'Move', cls: 'mini', disabled: k === 0, onClick: () => A.moveBlock(b.id, k - 1) }),
      btn({ icon: ico('right'), label: 'Move', cls: 'mini', disabled: k === arr.length - 1, onClick: () => A.moveBlock(b.id, k + 1) }),
      h('span', { class: 'reps-ctl' },
        btn({ icon: ico('minus'), label: '', cls: 'mini icon', title: 'Fewer repeats', disabled: b.reps <= 1, onClick: () => A.setReps(b.id, b.reps - 1) }),
        h('span', { class: 'reps-v' }, `${b.reps}×`),
        btn({ icon: ico('plus'), label: '', cls: 'mini icon', title: 'More repeats', disabled: b.reps >= MAX_REPS, onClick: () => A.setReps(b.id, b.reps + 1) })),
      btn({ icon: ico('dup'), label: 'Duplicate', cls: 'mini', onClick: () => A.duplicateBlock(b.id) }),
      btn({ icon: ico('play'), label: 'Play from here', cls: 'mini', onClick: () => A.playFromBlock(b.id) }),
      btn({ icon: ico('edit'), label: 'Edit scene', cls: 'mini', onClick: () => { A.selectScene(blockScene(p, b)); A.setMode('jam'); } }),
      btn({ icon: ico('trash'), label: 'Remove', cls: 'mini danger', onClick: () => A.removeBlock(b.id) })));
  }
  // --- library
  host.append(h('div', { class: 'arr-title' }, h('b', {}, 'Scene library'), h('span', { class: 'hint' }, 'Tap a scene to pick it · ▶ to hear it · + to add it to the song')));
  const grid = h('div', { class: 'arr-scenes' });
  p.scenes.forEach((sc, i) => {
    const has = sceneHasContent(p, i);
    const tile = h('div', { class: 'atile' + (u.libSel === i ? ' sel' : '') + (p.scene === i ? ' cur' : '') + (has ? '' : ' empty'), role: 'button', tabindex: 0, 'aria-label': `Scene ${SCENE_LETTERS[i]} ${sc.name}` });
    const rename = h('button', { type: 'button', class: 'ren', 'aria-label': `Rename scene ${SCENE_LETTERS[i]}`, html: ico('edit') });
    rename.onclick = e => { e.stopPropagation(); promptDialog(`Rename scene ${SCENE_LETTERS[i]}`, sc.name, 'Rename', v => A.renameScene(i, v), { maxlength: 24 }); };
    tile.append(h('div', { class: 'top' }, h('span', { class: 'L' }, SCENE_LETTERS[i]), h('span', { class: 'nm' }, sc.name), rename));
    tile.append(miniMap(i));
    tile.append(h('div', { class: 'meta' }, has ? `${maxLen(p, i) / 16} bar${maxLen(p, i) > 16 ? 's' : ''}${sc.harmony ? ' · ' + harmonyLabel(p.key, p.scale, sc.harmony) : ''}` : 'empty — tap Edit to start'));
    const playingHere = A.transport.playing && A.transport.position && !A.transport.position.song && A.transport.position.scene === i;
    tile.append(h('div', { class: 'btns' },
      btn({ icon: ico(playingHere ? 'pause' : 'play'), label: playingHere ? 'Playing' : 'Preview', cls: 'mini' + (playingHere ? ' on' : ''), onClick: e => { e.stopPropagation(); if (playingHere) A.togglePlay(); else A.previewScene(i); } }),
      btn({ icon: ico('plus'), label: 'Add', cls: 'mini', title: 'Add to the end of the song', onClick: e => { e.stopPropagation(); A.addToSong(i); } }),
      btn({ icon: ico('edit'), label: 'Edit', cls: 'mini', title: 'Open in JAM', onClick: e => { e.stopPropagation(); A.selectScene(i); A.setMode('jam'); } })));
    tile.onclick = () => { u.libSel = i; renderArrange(); };
    tile.onkeydown = e => { if (e.key === 'Enter') { u.libSel = i; renderArrange(); } };
    grid.append(tile);
  });
  host.append(grid);

  host.scrollTop = scroll;
  if (u.revealSel) { // a block was just added from the library: show it
    u.revealSel = false;
    const el = host.querySelector('.cblock.sel');
    if (el) { el.scrollIntoView({ block: 'nearest', behavior: u.motion ? 'smooth' : 'auto' }); el.animate && u.motion && el.animate([{ transform: 'scale(.6)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }], { duration: 320, easing: 'cubic-bezier(.3,1.4,.5,1)' }); }
  }
}

/** live highlight of the playing block without re-rendering */
export function markPlayingBlock() {
  const pos = A.transport.position, live = A.transport.state !== 'stopped' && pos && pos.song;
  $$('#chain .cblock[data-k]').forEach(el => el.classList.toggle('now', !!live && +el.dataset.k === pos.block));
}

/* ---------- drag to reorder (pointer events: touch, pen and mouse) ---------- */
function attachDrag(el, id) {
  let st = null;
  el.addEventListener('pointerdown', e => {
    if (e.button > 0) return;
    st = { x: e.clientX, y: e.clientY, pid: e.pointerId, drag: false };
    try { el.setPointerCapture(e.pointerId); } catch (er) { /* synthetic */ }
  });
  el.addEventListener('pointermove', e => {
    if (!st || st.pid !== e.pointerId) return;
    if (!st.drag && Math.hypot(e.clientX - st.x, e.clientY - st.y) > 8) {
      st.drag = true;
      const r = el.getBoundingClientRect();
      st.ghost = el.cloneNode(true); st.ghost.classList.add('ghost');
      Object.assign(st.ghost.style, { width: r.width + 'px', height: r.height + 'px' });
      st.dx = e.clientX - r.left; st.dy = e.clientY - r.top;
      document.body.append(st.ghost);
      el.classList.add('dragging');
    }
    if (!st.drag) return;
    st.ghost.style.transform = `translate(${e.clientX - st.dx}px, ${e.clientY - st.dy}px) rotate(-3deg)`;
    st.to = dropIndex(el, e.clientX, e.clientY);
  });
  const end = e => {
    if (!st || st.pid !== e.pointerId) return;
    const s = st; st = null;
    $$('#chain .cblock').forEach(b => b.classList.remove('drop-before', 'drop-after'));
    if (s.drag) {
      s.ghost.remove(); el.classList.remove('dragging');
      if (e.type === 'pointerup' && s.to != null) A.moveBlock(id, s.to);
    } else if (e.type === 'pointerup') {
      store.ui.arrSel = store.ui.arrSel === id ? null : id; renderArrange();
    }
  };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
}
function dropIndex(dragEl, x, y) {
  const others = $$('#chain .cblock[data-id]').filter(b => b !== dragEl);
  others.forEach(b => b.classList.remove('drop-before', 'drop-after'));
  let idx = others.length;
  for (let i = 0; i < others.length; i++) {
    const r = others[i].getBoundingClientRect();
    if (y < r.top) { idx = i; break; }
    if (y <= r.bottom && x < r.left + r.width / 2) { idx = i; break; }
  }
  if (others[idx]) others[idx].classList.add('drop-before'); else if (others.length) others[others.length - 1].classList.add('drop-after');
  return idx;
}
