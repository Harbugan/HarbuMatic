// Bootstrap: build the UI, wire events to renders, run the animation loop.

import { store, on } from './store.js';
import * as A from './actions.js';
import { META, TRACKS, APP_VERSION, VERSION_LABEL, APP_CREDIT } from '../core/constants.js';
import { $, $$ } from '../ui/dom.js';
import { ico } from '../ui/icons.js';
import { toast, dialogOpen, closeDialog } from '../ui/controls.js';
import { catSVG, catReact, uniReact, setCatsIdle, startIdleLife, CAT } from '../ui/characters.js';
import * as Seq from '../ui/sequencer.js';
import { buildTransport, renderTransport, buildCards, updateCards, drawScreen, updateWiggle } from '../views/strip.js';
import { renderJamBar, updateLeds } from '../views/jam.js';
import { renderLab, renderScenes, renderRightTabs } from '../views/lab.js';
import { renderBottom, syncShapers, renderSound, refreshSoundKnobs } from '../views/sound.js';
import { renderArrange, markPlayingBlock } from '../views/arrange.js';
import { renderSongButton, openMenu, closeMenu, bindFileInput, newSongDialog } from '../views/menu.js';

/* ---------- layout ---------- */
function applyLayout() {
  const u = store.ui, d = $('#device');
  d.dataset.mode = u.mode;
  d.classList.toggle('expanded', u.expanded && u.mode === 'jam');
  // the app shell (header + transport/instrument strip) stays identical across JAM, SOUND and ARRANGE;
  // only Deep edit, a JAM sub-mode the player opts into, compacts the strip (BUG-004)
  d.classList.toggle('compact', u.expanded && u.mode === 'jam');
  d.classList.toggle('drawer-open', u.drawer);
  $('#scrim').classList.toggle('show', u.drawer || dialogOpen() || $('#menu').classList.contains('open'));
  $$('.mode').forEach(b => { const on = b.dataset.mode === u.mode; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
  $('#viewJam').hidden = u.mode !== 'jam';
  $('#viewSound').hidden = u.mode !== 'sound';
  $('#viewArr').hidden = u.mode !== 'arrange';
  if (u.mode === 'sound') renderSound();
  if (u.mode === 'arrange') renderArrange();
  if (u.mode === 'jam') { renderJamBar(); requestAnimationFrame(() => { Seq.resize(); }); }
}
function setAccent() {
  const m = META[store.ui.sel], r = document.documentElement.style;
  r.setProperty('--accent', m.c); r.setProperty('--accent-d', m.d); r.setProperty('--accent-dd', m.dd);
}
function updateUndo() { $('#hUndo').disabled = !A.history.canUndo; $('#hRedo').disabled = !A.history.canRedo; }

function renderAll() {
  setAccent(); renderSongButton(); renderTransport(); updateCards(); renderBottom();
  renderLab(); renderScenes(); applyLayout(); Seq.render(); updateUndo();
}

/* ---------- event → render wiring ---------- */
function wire() {
  on('project', () => { Seq.fitView(); renderAll(); });
  on('meta', renderSongButton);
  on('history', updateUndo);
  on('toast', msg => toast(msg));
  on('layout', applyLayout);
  on('drawer', applyLayout);
  on('tool', () => { renderJamBar(); Seq.render(); });
  on('selection', () => { setAccent(); Seq.fitView(); updateCards(); renderJamBar(); Seq.render(); renderBottom(); renderLab(); if (store.ui.mode === 'sound') renderSound(); });
  on('scene', () => { Seq.fitView(); updateCards(); renderJamBar(); Seq.render(); renderScenes(); renderLab(); if (store.ui.mode === 'arrange') renderArrange(); });
  on('pattern', () => { updateCards(); renderJamBar(); Seq.render(); renderScenes(); if (store.ui.mode === 'arrange') renderArrange(); });
  on('params', t => { if (t === store.ui.sel) { syncShapers(); if (store.ui.mode === 'sound') refreshSoundKnobs(); renderBottomFx(); } updateWiggle(); });
  on('mix', updateCards);
  on('tempo', () => { renderTransport(); if (store.ui.mode === 'sound') refreshSoundKnobs(); if (store.ui.sel === 'drums') syncShapers(); });
  on('lab', renderLab);
  on('arrangement', () => { if (store.ui.mode === 'arrange') renderArrange(); renderScenes(); });
  on('transport', () => {
    renderTransport(); renderScenes(); if (store.ui.mode === 'arrange') renderArrange();
    if (!A.transport.playing) { setCatsIdle(); Seq.playhead.step = -1; Seq.render(); updateLeds(); }
  });
  on('transformed', ({ intensity, info }) => { uniReact(intensity); if (info) toast(info); if (!A.transport.playing) auditionPattern(); });
  on('evolved', () => { /* UI catches up in the next frame via 'pattern' */ });
  on('library', () => {});
}
function renderBottomFx() { $$('#fxbar .fxbtn').forEach(b => { const on = !!store.project.tracks[store.ui.sel].params[b.dataset.fx + 'On']; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }); }

let audT = [];
function auditionPattern() { // when stopped, give a tiny taste of the new idea
  audT.forEach(clearTimeout); audT = [];
  const t = store.ui.sel; if (t === 'drums') return;
  const p = store.project.tracks[t].patterns[store.project.scene];
  [...p.notes].sort((a, b) => a.s - b.s).slice(0, 4).forEach((n, i) => audT.push(setTimeout(() => { A.engine.audition(t, n.p, n.v); catReact(t, [{ p: n.p, v: n.v }]); }, i * 120)));
}

/* ---------- animation loop: drain scheduler events at their audio time ---------- */
let lastBar = -1, lastScene = -1;
function frame() {
  const E = A.engine, tr = A.transport;
  if (E.ctx && tr.playing) {
    const now = E.ctx.currentTime;
    let changedScene = false;
    while (tr.queue.length && tr.queue[0].time <= now) {
      const ev = tr.queue.shift();
      Seq.playhead.step = ev.step; Seq.playhead.time = ev.time; Seq.playhead.scene = ev.scene;
      for (const t in ev.hits) catReact(t, ev.hits[t]);
      if (ev.scene !== lastScene) { lastScene = ev.scene; changedScene = true; }
      const bar = Math.floor(ev.step / 16);
      if (ev.step % 16 === 0 && bar !== lastBar) { lastBar = bar; const c = CAT.drums; if (c && store.ui.motion) c.el.classList.toggle('joy', bar % 4 === 3); }
    }
    if (changedScene) { renderScenes(); if (store.ui.mode === 'arrange') renderArrange(); }
    if (store.ui.mode === 'arrange') markPlayingBlock();
    if (store.ui.mode === 'jam') { Seq.render(); updateLeds(); }
    updateWiggle();
  }
  drawScreen();
  requestAnimationFrame(frame);
}

/* ---------- keyboard (desktop extra; never required) ---------- */
function keys(e) {
  if (e.target.closest('input,select,textarea')) return;
  const k = e.key.toLowerCase(), mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Escape') { if (dialogOpen()) closeDialog(); else if ($('#menu').classList.contains('open')) closeMenu(); else if (store.ui.drawer) A.setDrawer(false); else A.stop(); applyLayout(); return; }
  if (dialogOpen()) return;
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? A.redo() : A.undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); A.redo(); return; }
  if (mod) return;
  if (e.target.closest('.knob') && e.key.startsWith('Arrow')) return;
  if (k === ' ') { e.preventDefault(); A.togglePlay(); }
  else if ('1234'.includes(k) && k.length === 1) A.selectTrack(TRACKS[+k - 1]);
  else if (k === 'f') A.setExpanded(!store.ui.expanded);
  else if (k === 'b') A.setTool('draw');
  else if (k === 'e') A.setTool('erase');
  else if (k === 'l') { if (!store.ui.expanded) A.setExpanded(true); A.setTool('lock'); }
  else if (k === 'g') A.runTransform('generate');
  else if (k === 'm') A.runTransform('mutate');
  else if (e.key === 'ArrowUp' && store.ui.sel !== 'drums') { e.preventDefault(); Seq.octave(1); }
  else if (e.key === 'ArrowDown' && store.ui.sel !== 'drums') { e.preventDefault(); Seq.octave(-1); }
}

/* ---------- boot ---------- */
function init() {
  const { fresh } = A.bootProject();
  $('#ident').textContent = `HarbuMatic ${VERSION_LABEL} · ${APP_CREDIT}`;
  $('#hUndo').innerHTML = ico('undo'); $('#hRedo').innerHTML = ico('redo');
  $('#hUndo').onclick = A.undo; $('#hRedo').onclick = A.redo;
  $('#hSong').onclick = e => { e.stopPropagation(); openMenu(); };
  $('#scrim').onclick = () => { if (dialogOpen()) return; closeMenu(); if (store.ui.drawer) A.setDrawer(false); };
  $('#drawerClose').innerHTML = ico('close');
  $('#drawerClose').onclick = () => A.setDrawer(false);
  $$('.mode').forEach(b => { b.onclick = () => A.setMode(b.dataset.mode); });
  bindFileInput();
  buildTransport(); buildCards(); renderRightTabs();
  Seq.mount($('#roll'));
  wire();
  window.addEventListener('keydown', keys);
  document.body.classList.toggle('no-motion', !store.ui.motion);
  document.body.classList.toggle('coarse', store.ui.coarse);
  A.engine.onInterrupt = state => { if (A.transport.playing) { A.transport.pause(); toast(state === 'interrupted' ? 'Audio was interrupted — tap Resume' : 'Audio paused by the system — tap Resume'); } };
  // save immediately when the tab is hidden (iPad may discard background tabs)
  document.addEventListener('visibilitychange', () => { if (document.hidden) A.flushSave(); });
  window.addEventListener('pagehide', () => A.flushSave());
  startIdleLife();
  renderAll(); Seq.fitView();
  // start overlay: one tap unlocks audio (required by iOS) and starts the groove
  const sc = $('#startCats'); TRACKS.forEach(t => { const c = document.createElement('div'); c.className = 'cat ' + t; c.innerHTML = catSVG(t); sc.append(c); });
  $('#startSong').textContent = fresh ? 'Starting with the demo jam' : `Continue “${store.project.name}”`;
  $('#startBtn').onclick = () => {
    A.engine.init(); A.engine.applyAll();
    $('#start').classList.add('hide');
    const hasContent = TRACKS.some(t => { const p = store.project.tracks[t].patterns[store.project.scene]; return t === 'drums' ? Object.values(p.steps).some(r => r.some(Boolean)) : p.notes.length; });
    if (hasContent) A.transport.play();
    uniReact(.5);
  };
  $('#startNew').onclick = () => { A.engine.init(); $('#start').classList.add('hide'); newSongDialog(); };
  requestAnimationFrame(frame);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register(`./sw.js?v=${encodeURIComponent(APP_VERSION)}`).catch(() => {});
  window.__harbu = { store, A }; // handy for debugging and automated UI tests
}
init();
