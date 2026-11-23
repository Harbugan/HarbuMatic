// Transport panel (play/pause, stop, LCD, tempo) + one instrument card per visible slot.

import { store, P, typeOf, visibleSlots, slot } from '../app/store.js';
import * as A from '../app/actions.js';
import { DRUM_IDS, sceneLabel } from '../core/constants.js';
import { getInstrumentType } from '../core/instruments.js';
import { patternAt, anySolo } from '../core/project.js';
import { $, h } from '../ui/dom.js';
import { Knob } from '../ui/controls.js';
import { ico } from '../ui/icons.js';
import { catSVG, registerCat, CAT } from '../ui/characters.js';
import { playhead } from '../ui/sequencer.js';

/* ---------- transport ---------- */
export function buildTransport() {
  $('#play').onclick = () => A.togglePlay();
  $('#stop').onclick = () => A.stop();
  const step = d => () => A.setBpm(store.project.bpm + d);
  repeatPress($('#bpmUp'), step(1)); repeatPress($('#bpmDn'), step(-1));
  const box = $('#bpmBox'); let sy = null, sb = 0;
  box.addEventListener('pointerdown', e => { sy = e.clientY; sb = store.project.bpm; try { box.setPointerCapture(e.pointerId); } catch (er) { /* */ } });
  box.addEventListener('pointermove', e => { if (sy != null) A.setBpm(sb + (sy - e.clientY) / 4); });
  const end = () => { sy = null; A.sealHistory(); };
  box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
  box.addEventListener('wheel', e => { e.preventDefault(); A.setBpm(store.project.bpm - Math.sign(e.deltaY)); }, { passive: false });
}
/** press-and-hold auto-repeat for +/- buttons */
function repeatPress(b, fn) {
  let t = 0, i = 0;
  const stop = () => { clearTimeout(t); clearInterval(i); A.sealHistory(); };
  b.addEventListener('pointerdown', e => { e.preventDefault(); fn(); t = setTimeout(() => { i = setInterval(fn, 70); }, 380); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => b.addEventListener(ev, stop));
  b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
}
export function renderTransport() {
  const st = A.transport.state;
  const play = $('#play');
  play.classList.toggle('on', st === 'playing');
  play.classList.toggle('paused', st === 'paused');
  play.innerHTML = ico(st === 'playing' ? 'pause' : 'play') + `<span class="btn-l">${st === 'playing' ? 'Pause' : st === 'paused' ? 'Resume' : 'Play'}</span>`;
  play.setAttribute('aria-label', st === 'playing' ? 'Pause' : st === 'paused' ? 'Resume' : 'Play');
  $('#stop').classList.toggle('armed', st !== 'stopped');
  $('#bpmVal').textContent = store.project.bpm;
}

/* ---------- pixel LCD ---------- */
const PIX = ['11........11', '111......111', '111111111111', 'H1111111111H', 'H11e1111e11H', 'H11e1111e11H', 'H1111mm1111H', '111111111111', '.1111111111.', '..11111111..'];
const fbuf = new Uint8Array(128);
export function drawScreen() {
  const cv = $('#screen'); if (!cv || !cv.offsetParent) return;
  const g = cv.getContext('2d'), W = cv.width, H = cv.height, m = typeOf().visual;
  const E = A.engine, playing = A.transport.playing;
  g.fillStyle = '#211f33'; g.fillRect(0, 0, W, H);
  const ph = playing && E.ctx ? (E.ctx.currentTime - playhead.time) / E.stepDur() : 1;
  const beat = playing && playhead.step % 4 === 0 && ph < .5;
  const ox = 4, oy = 12 - (beat ? 2 : 0);
  PIX.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === '.') return;
    g.fillStyle = ch === '1' ? m.color : ch === 'H' ? m.headphones : '#211f33';
    g.fillRect(ox + x * 2, oy + y * 2, 2, 2);
  }));
  g.fillStyle = m.headphones; for (let x = 2; x < 22; x += 2) g.fillRect(ox + x, oy - 2 - (x > 6 && x < 16 ? 2 : 0), 2, 2);
  if (playing && playhead.step % 16 < 2) { g.fillStyle = '#F2AFC0'; ['.1.1.', '11111', '11111', '.111.', '..1..'].forEach((r, y) => [...r].forEach((c, x) => c === '1' && g.fillRect(31 + x, 4 + y, 1, 1))); }
  if (E.analyser) {
    E.analyser.getByteFrequencyData(fbuf);
    const cols = visibleSlots().map(s => getInstrumentType(s.type).visual.color);
    for (let b = 0; b < 6; b++) {
      const v = fbuf[Math.floor(Math.pow(b / 6, 1.6) * 60) + 1] / 255, hgt = Math.round(v * 8);
      for (let k = 0; k < hgt; k++) { g.fillStyle = cols[Math.min(cols.length - 1, k >> 1)]; g.fillRect(31 + b * 5, H - 4 - k * 2, 4, 1); }
    }
  }
  const pos = A.transport.position, st = A.transport.state;
  const rawSc = st !== 'stopped' && pos ? pos.scene : store.project.scene;
  const sc = Math.max(0, Math.min(store.project.scenes.length - 1, rawSc));
  $('#scrScene').textContent = `${sceneLabel(sc)}${pos && pos.song && st !== 'stopped' ? ' ♪' : ''}`;
  const step = st === 'playing' ? playhead.step : pos && st === 'paused' ? pos.step : -1;
  $('#scrStep').textContent = step >= 0 ? `${Math.floor(step / 16) + 1}.${Math.floor((step % 16) / 4) + 1}` : st === 'paused' ? 'II' : '—';
  $('#scrStep').classList.toggle('blink', st === 'paused');
}

/* ---------- instrument cards ---------- */
// One card per visible slot, in slot order (five by default: BOP, GOO, BLIP, FUZZ, MUNCH); `data-t` carries the
// type's CSS key so the colour rules apply unchanged and `#cards[data-count]` picks the column layout.
let cardSlots = '';
/** pitch a type auditions at, transposed from A minor to the song key */
export const auditionPitch = (def, key = store.project.key, which = 'pitch', id = store.ui.sel) => (def.pattern === 'drum' ? def.ui.audition.drum
  : def.capabilities.samples ? P(id).root // a sampler previews its sample at the root: as recorded
    : (def.ui.audition[which] ?? def.ui.audition.pitch) + (key - 9));
export function buildCards() {
  const host = $('#cards'); host.innerHTML = '';
  Object.keys(CAT).forEach(k => delete CAT[k]);
  const slots = visibleSlots();
  cardSlots = slots.map(s => `${s.id}:${s.type}`).join();
  host.dataset.count = String(slots.length);
  slots.forEach((s, i) => {
    const id = s.id, m = getInstrumentType(s.type);
    const card = h('div', { class: 'card', 'data-t': m.visual.css, 'data-slot': id, role: 'button', tabindex: 0, 'aria-label': `${m.name} — ${m.description}. Select instrument ${i + 1}` });
    const led = h('i', { class: 'led' });
    const catEl = h('div', { class: 'cat ' + m.visual.css, html: catSVG(s.type) });
    const mute = h('button', { type: 'button', class: 'pill mute', 'aria-pressed': 'false', title: `Mute ${m.name}` }, 'M');
    const solo = h('button', { type: 'button', class: 'pill solo', 'aria-pressed': 'false', title: `Solo ${m.name}` }, 'S');
    mute.onclick = e => { e.stopPropagation(); A.toggleMute(id); };
    solo.onclick = e => { e.stopPropagation(); A.toggleSolo(id); };
    const vol = Knob({
      label: `${m.name} volume`,
      min: 0, max: 1,
      value: P(id)?.vol ?? m.defaultParams.vol,
      def: m.defaultParams.vol,
      size: 'card-vol',
      title: `${m.name} volume — drag, double-tap to reset`,
      onChange: v => A.setParam(id, 'vol', v),
      onEnd: A.sealHistory,
    });
    const stop = e => e.stopPropagation();
    ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click', 'dblclick', 'wheel'].forEach(ev => vol.el.addEventListener(ev, stop));
    vol.el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === 'Home' || e.key === 'End' || e.key.startsWith('Arrow')) e.stopPropagation();
    });
    const mini = h('div', { class: 'mini-steps' }, Array.from({ length: 16 }, () => h('i')));
    card.append(
      h('div', { class: 'card-cat' }, catEl),
      h('div', { class: 'card-info' }, h('div', { class: 'card-head' }, h('span', { class: 'card-name' }, m.name), led), h('div', { class: 'card-type' }, m.description), h('div', { class: 'card-ms' }, mute, solo, vol.el)),
      mini);
    card.addEventListener('click', e => {
      if (e.target.closest('.pill, .knob')) return;
      A.selectSlot(id);
      A.engine.audition(id, auditionPitch(m, store.project.key, 'pitch', id), .8);
    });
    card.addEventListener('keydown', e => {
      if (e.target.closest('.pill, .knob')) return;
      if (e.key === 'Enter') A.selectSlot(id);
    });
    host.append(card);
    registerCat(id, { el: catEl, rig: catEl.querySelector('.rig'), led, card, mute, solo, vol, mini, type: s.type });
  });
}
/** rebuild the cards only when the set of visible slots (or their types) changed */
export function syncCards() { if (visibleSlots().map(s => `${s.id}:${s.type}`).join() !== cardSlots) buildCards(); }
/** keep card volume knobs in step with params (SOUND, presets, undo/redo) without interrupting an active drag */
export function syncCardVolume(id = null) {
  const list = id ? (CAT[id] ? [id] : []) : Object.keys(CAT);
  list.forEach(t => {
    const c = CAT[t];
    if (c && c.vol && !c.vol.dragging) c.vol.set(P(t).vol);
  });
}
export function occupancy(id, sc, cells) {
  const s = slot(id), p = patternAt(store.project, id, sc), out = Array(cells).fill(false), k = cells / p.len;
  if (getInstrumentType(s.type).pattern === 'drum') DRUM_IDS.forEach(d => p.steps[d].forEach((c, i) => { if (c) out[Math.floor(i * k)] = true; }));
  else p.notes.forEach(n => { for (let i = n.s; i < n.s + n.l && i < p.len; i++) out[Math.floor(i * k)] = true; });
  return out;
}
export function updateCards() {
  syncCards();
  const pr = store.project, solo = anySolo(pr);
  visibleSlots().forEach(tr => {
    const t = tr.id, c = CAT[t]; if (!c) return;
    c.card.classList.toggle('sel', t === store.ui.sel);
    c.card.setAttribute('aria-pressed', String(t === store.ui.sel));
    c.card.classList.toggle('silent', solo ? !tr.solo : tr.mute);
    c.mute.classList.toggle('on', tr.mute); c.mute.setAttribute('aria-pressed', String(tr.mute));
    c.solo.classList.toggle('on', tr.solo); c.solo.setAttribute('aria-pressed', String(tr.solo));
    if (c.vol && !c.vol.dragging) c.vol.set(P(t).vol);
    const occ = occupancy(t, pr.scene, 16);
    [...c.mini.children].forEach((i, k) => i.classList.toggle('on', occ[k]));
  });
}
/** acid voices wiggle when the resonance is screaming */
export function updateWiggle() {
  for (const s of visibleSlots()) {
    if (!getInstrumentType(s.type).capabilities.slide) continue;
    const c = CAT[s.id]; if (c) c.el.classList.toggle('wiggle', A.transport.playing && A.engine.audible(s.id) && P(s.id).res > .85 && store.ui.motion);
  }
}
