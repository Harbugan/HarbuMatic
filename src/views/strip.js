// Transport panel (play/pause, stop, LCD, tempo) + the four instrument cards.

import { store, P } from '../app/store.js';
import * as A from '../app/actions.js';
import { TRACKS, META, DRUM_IDS, SCENE_LETTERS } from '../core/constants.js';
import { $, h } from '../ui/dom.js';
import { ico } from '../ui/icons.js';
import { catSVG, HP, registerCat, CAT } from '../ui/characters.js';
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
  const g = cv.getContext('2d'), W = cv.width, H = cv.height, sel = store.ui.sel, m = META[sel];
  const E = A.engine, playing = A.transport.playing;
  g.fillStyle = '#211f33'; g.fillRect(0, 0, W, H);
  const ph = playing && E.ctx ? (E.ctx.currentTime - playhead.time) / E.stepDur() : 1;
  const beat = playing && playhead.step % 4 === 0 && ph < .5;
  const ox = 4, oy = 12 - (beat ? 2 : 0);
  PIX.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === '.') return;
    g.fillStyle = ch === '1' ? m.c : ch === 'H' ? HP[sel] : '#211f33';
    g.fillRect(ox + x * 2, oy + y * 2, 2, 2);
  }));
  g.fillStyle = HP[sel]; for (let x = 2; x < 22; x += 2) g.fillRect(ox + x, oy - 2 - (x > 6 && x < 16 ? 2 : 0), 2, 2);
  if (playing && playhead.step % 16 < 2) { g.fillStyle = '#F2AFC0'; ['.1.1.', '11111', '11111', '.111.', '..1..'].forEach((r, y) => [...r].forEach((c, x) => c === '1' && g.fillRect(31 + x, 4 + y, 1, 1))); }
  if (E.analyser) {
    E.analyser.getByteFrequencyData(fbuf);
    const cols = TRACKS.map(t => META[t].c);
    for (let b = 0; b < 6; b++) {
      const v = fbuf[Math.floor(Math.pow(b / 6, 1.6) * 60) + 1] / 255, hgt = Math.round(v * 8);
      for (let k = 0; k < hgt; k++) { g.fillStyle = cols[Math.min(3, k >> 1)]; g.fillRect(31 + b * 5, H - 4 - k * 2, 4, 1); }
    }
  }
  const pos = A.transport.position, st = A.transport.state;
  const sc = st !== 'stopped' && pos ? pos.scene : store.project.scene;
  $('#scrScene').textContent = `${SCENE_LETTERS[sc]}${pos && pos.song && st !== 'stopped' ? ' ♪' : ''}`;
  const step = st === 'playing' ? playhead.step : pos && st === 'paused' ? pos.step : -1;
  $('#scrStep').textContent = step >= 0 ? `${Math.floor(step / 16) + 1}.${Math.floor((step % 16) / 4) + 1}` : st === 'paused' ? 'II' : '—';
  $('#scrStep').classList.toggle('blink', st === 'paused');
}

/* ---------- instrument cards ---------- */
export function buildCards() {
  const host = $('#cards'); host.innerHTML = '';
  TRACKS.forEach((t, i) => {
    const m = META[t];
    const card = h('div', { class: 'card', 'data-t': t, role: 'button', tabindex: 0, 'aria-label': `${m.name} — ${m.type}. Select instrument ${i + 1}` });
    const led = h('i', { class: 'led' });
    const catEl = h('div', { class: 'cat ' + t, html: catSVG(t) });
    const mute = h('button', { type: 'button', class: 'pill mute', 'aria-pressed': 'false', title: `Mute ${m.name}` }, 'M');
    const solo = h('button', { type: 'button', class: 'pill solo', 'aria-pressed': 'false', title: `Solo ${m.name}` }, 'S');
    mute.onclick = e => { e.stopPropagation(); A.toggleMute(t); };
    solo.onclick = e => { e.stopPropagation(); A.toggleSolo(t); };
    const mini = h('div', { class: 'mini-steps' }, Array.from({ length: 16 }, () => h('i')));
    card.append(
      h('div', { class: 'card-cat' }, catEl),
      h('div', { class: 'card-info' }, h('div', { class: 'card-head' }, h('span', { class: 'card-name' }, m.name), led), h('div', { class: 'card-type' }, m.type), h('div', { class: 'card-ms' }, mute, solo)),
      mini);
    card.addEventListener('click', e => {
      if (e.target.closest('.pill')) return;
      A.selectTrack(t);
      const k = store.project.key;
      A.engine.audition(t, t === 'drums' ? 'kick' : t === 'bass' ? 33 + (k - 9) : t === 'synth' ? 69 + (k - 9) : 76 + (k - 9), .8);
    });
    card.addEventListener('keydown', e => { if (e.key === 'Enter') A.selectTrack(t); });
    host.append(card);
    registerCat(t, { el: catEl, rig: catEl.querySelector('.rig'), led, card, mute, solo, mini });
  });
}
export function occupancy(t, sc, cells) {
  const p = store.project.tracks[t].patterns[sc], out = Array(cells).fill(false), k = cells / p.len;
  if (t === 'drums') DRUM_IDS.forEach(id => p.steps[id].forEach((c, i) => { if (c) out[Math.floor(i * k)] = true; }));
  else p.notes.forEach(n => { for (let i = n.s; i < n.s + n.l && i < p.len; i++) out[Math.floor(i * k)] = true; });
  return out;
}
export function updateCards() {
  const pr = store.project, anySolo = TRACKS.some(x => pr.tracks[x].solo);
  TRACKS.forEach(t => {
    const c = CAT[t], tr = pr.tracks[t]; if (!c) return;
    c.card.classList.toggle('sel', t === store.ui.sel);
    c.card.setAttribute('aria-pressed', String(t === store.ui.sel));
    c.card.classList.toggle('silent', anySolo ? !tr.solo : tr.mute);
    c.mute.classList.toggle('on', tr.mute); c.mute.setAttribute('aria-pressed', String(tr.mute));
    c.solo.classList.toggle('on', tr.solo); c.solo.setAttribute('aria-pressed', String(tr.solo));
    const occ = occupancy(t, pr.scene, 16);
    [...c.mini.children].forEach((i, k) => i.classList.toggle('on', occ[k]));
  });
}
export function updateWiggle() {
  const c = CAT.bass; if (c) c.el.classList.toggle('wiggle', A.transport.playing && A.engine.audible('bass') && P('bass').res > .85 && store.ui.motion);
}
