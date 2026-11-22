// MUNCH workspace (v0.6 Phase 4): the SOUND view of a sampler slot. One instrument, three layers:
//   PLAY   hear it at once: a chunky two-octave keyboard (velocity from where you press, polyphonic, hold for gate/loop)
//   CHOP   the waveform editor, eight jelly pads (+ a second bank), MAGIC CHOP and the slice sequencer
//   TWIST  the deeper knobs, grouped by what they do to the sound
// Empty (no sample, or the sample is missing on this device): MUNCH asks to be fed, with big RECORD and IMPORT.
//
// Everything here goes through actions (history, autosave) and the existing engine; the slice sequencer edits the
// same pattern JAM draws. See docs/MUNCH-PHASE4.md.

import { store, slot, P, pat } from '../app/store.js';
import * as A from '../app/actions.js';
import { SCENE_LETTERS } from '../core/constants.js';
import { sliceCount, sliceRegion, FIT_CHOICES, fitChoicesOk, fitInfo } from '../core/samples.js';
import { MAGIC_STYLES, MAGIC_LABEL } from '../music/magicchop.js';
import { h } from '../ui/dom.js';
import { ico } from '../ui/icons.js';
import { Knob, Seg, dialog, confirmDialog } from '../ui/controls.js';
import { catSVG, sparks } from '../ui/characters.js';
import { Wave, drawWave, zoomWave, zoomLevels, cursorText, SLICE_COLORS } from './munch-wave.js';

const NOTE_NAME = m => ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
const pct = v => Math.round(v * 100) + '%';
const sec = v => (v < 1 ? Math.round(v * 1000) + 'ms' : v.toFixed(2) + 's');
const panFmt = v => (Math.abs(v) < .01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100));
const FIT_LABEL = { off: 'Orig', half: '½', 1: '1', 2: '2', 4: '4' };
const STYLE_SHORT = { straight: 'Straight', syncopated: 'Synco', halftime: 'Half', playful: 'Playful', chaos: 'Chaos' };
const STATUS = { none: 'Record or import a sound', idle: 'Waiting for audio…', loading: 'Loading…', ready: 'Ready', missing: 'Missing on this device', error: 'Could not be loaded' };

let refs = {};
let knobs = [];
const held = new Map(); // pointerId → { handle, el }
const u = () => store.ui.munch;
const sel = () => store.ui.sel;

/* ---------- public API (main.js) ---------- */

/** full render into the SOUND view host */
export function renderMunch(host) {
  releaseAll();
  refs = {}; knobs = [];
  const s = slot(), ref = s.sample, st = A.sampleState(sel()), rec = A.recorder.state;
  const empty = !ref || st.status === 'missing' || rec === 'recording' || rec === 'starting' || rec === 'stopping';
  const ws = h('div', { class: 'mw' + (empty ? ' empty' : ''), 'data-testid': 'munch', 'data-tab': u().tab });
  ws.append(head(s, st, empty));
  if (empty) ws.append(feed(s, st));
  else {
    const wave = Wave({ tab: u().tab }), zl = zoomLevels();
    const zb = (icon, label, dir, dis) => { const b = h('button', { type: 'button', class: 'mw-zoom', 'aria-label': label, title: label, disabled: dis, html: ico(icon) }); b.onclick = () => { zoomWave(dir); rerender(); }; return b; };
    wave.append(h('div', { class: 'mw-zooms', title: `Zoom ${zl.zoom}×` }, zb('plus', 'Zoom in', 1, zl.max), zb('minus', 'Zoom out', -1, zl.min)));
    ws.append(wave);
    ws.append(u().tab === 'chop' ? chop(s, host) : u().tab === 'twist' ? twist(s) : play(s));
  }
  host.append(ws);
  drawWave();
  if (rec === 'recording') tickRecording();
}

/** cheap update after a selection / cursor change (no rebuild, safe during gestures) */
export function refreshMunchSel() {
  drawWave();
  const m = u();
  if (refs.pads) refs.pads.querySelectorAll('.mw-pad').forEach(p => p.classList.toggle('sel', +p.dataset.k === m.sel));
  if (refs.grid) refs.grid.querySelectorAll('.mw-row').forEach(r => r.classList.toggle('sel', +r.dataset.k === m.sel));
  if (refs.cursor) refs.cursor.textContent = cursorText();
  if (refs.tools) refs.tools.querySelectorAll('[data-needs=marker]').forEach(b => { b.disabled = m.marker == null; });
}
/** params changed (knob drag, fit): refresh knob values and the head readout without rebuilding */
export function refreshMunchParams() {
  const p = P();
  knobs.forEach(k => k.set(k.k === '__swing' ? store.project.swing : k.k.startsWith('fx:') ? store.project.fx[k.k.slice(3)] : p[k.k]));
  if (refs.status) refs.status.textContent = statusLine();
  drawWave();
}
/** scheduler hits for MUNCH (drained in rAF at their audio time): pads, keys and the character move */
export function munchHits(hits) {
  for (const x of hits) {
    if (x.slice != null) flash(refs.pads && refs.pads.querySelector(`.mw-pad[data-k="${x.slice}"]`));
    else flash(refs.keys && refs.keys.querySelector(`.mk[data-midi="${x.p}"]`));
  }
  if (hits.length) bounce('note');
}
/** sequencer playhead column */
let lastCol = -1;
export function munchStep(step) {
  if (!refs.grid) return;
  const p = pat(), m = u(), per = refs.perPage || 16, local = step >= 0 ? step % p.len : -1;
  const col = local >= 0 && Math.floor(local / per) === m.page ? local % per : -1;
  if (col === lastCol) return;
  lastCol = col;
  refs.grid.querySelectorAll('.mw-cell.now').forEach(c => c.classList.remove('now'));
  if (col >= 0) refs.grid.querySelectorAll(`.mw-cell[data-c="${col}"]`).forEach(c => c.classList.add('now'));
}
/** character reactions (lightweight, never block input; reduced motion = face only) */
let faceT = 0;
export function munchReact(kind) {
  const c = refs.char; if (!c) return;
  const face = { yum: 'happy', oops: 'oops', listen: 'listen', snip: 'wow', magic: 'wow' }[kind];
  if (face) { c.dataset.face = face; clearTimeout(faceT); if (kind !== 'listen') faceT = setTimeout(() => { if (c.dataset.face !== 'listen' || A.recorder.state !== 'recording') c.dataset.face = 'idle'; }, kind === 'oops' ? 1300 : 1000); }
  bounce(kind);
  if (kind === 'magic' && store.ui.motion) sparks(c, 7, '#F5D19A', 60);
  if (kind === 'yum' && store.ui.motion) sparks(c, 4, '#F2AFC0', 40);
}

/* ---------- head ---------- */
function statusLine() {
  const s = slot(), ref = s.sample, st = A.sampleState(sel());
  if (A.recorder.state === 'recording') return `Listening… ${A.recorder.elapsed().toFixed(1)} s`;
  if (!ref) return STATUS.none;
  if (st.status !== 'ready') return STATUS[st.status] || st.status;
  if (A.samples.store.isUnsaved(ref.id)) return 'Plays now · NOT saved on this device';
  const f = fitInfo(s.params, ref.duration, store.project.bpm);
  const base = `${ref.duration.toFixed(2)} s · ${ref.channels === 1 ? 'mono' : 'stereo'} · ${sliceCount(ref.slices)} slices`;
  if (!f.on) return `${base} · original speed`;
  const far = f.clamped ? ` · can't fit at ${store.project.bpm} BPM` : '';
  if (f.mode === 'stretch') return `${base} · stretch ×${(1 / f.rate).toFixed(2)} · pitch kept${A.stretchStatus() === 'pending' ? ' · stretching…' : ''}${far}`;
  const st2 = f.semitones >= 0 ? `+${f.semitones.toFixed(1)}` : f.semitones.toFixed(1);
  return `${base} · tape ×${f.rate.toFixed(2)} (${st2} st)${far}`;
}
function head(s, st, empty) {
  const ref = s.sample, hd = h('div', { class: 'mw-head' });
  if (!empty) { refs.char = character('small'); hd.append(refs.char); }
  refs.status = h('span', { class: 'mw-status', 'data-status': A.recorder.state === 'recording' ? 'recording' : ref ? st.status : 'none' }, statusLine());
  const info = h('div', { class: 'mw-info' }, h('b', { class: 'mw-name' }, ref ? ref.name : 'MUNCH'), refs.status);
  hd.append(info);
  if (!empty) {
    const hear = h('button', { type: 'button', class: 'btn icon mw-hear', 'aria-label': 'Hear the whole sound', title: 'Hear the whole sound', html: ico('play') });
    hear.onclick = () => A.auditionSample();
    const newSound = h('div', { class: 'mw-newsound' }, hear, recButton('mini'), importButton('mini'));
    if (ref && A.samples.store.isUnsaved(ref.id)) {
      const warn = h('button', { type: 'button', class: 'btn mini mw-unsaved', 'data-testid': 'munch-unsaved', title: 'This sound is not saved on this device' }, h('span', { html: ico('upload') }), h('span', { class: 'btn-l' }, 'Not saved'));
      warn.onclick = storageDialog;
      newSound.prepend(warn);
    }
    hd.append(newSound);
    const tabs = h('div', { class: 'mw-tabs', role: 'tablist', 'aria-label': 'MUNCH layer' });
    [['play', 'PLAY'], ['chop', 'CHOP'], ['twist', 'TWIST']].forEach(([k, l]) => {
      const b = h('button', { type: 'button', role: 'tab', class: 'mw-tab' + (u().tab === k ? ' on' : ''), 'aria-selected': String(u().tab === k), 'data-testid': `munch-tab-${k}` }, l);
      b.onclick = () => { if (u().tab === k) return; u().tab = k; rerender(); };
      tabs.append(b);
    });
    hd.append(tabs);
    hd.append(fitControl(s));
  }
  const dr = h('button', { type: 'button', class: 'btn mini mw-drawer', title: 'Scenes, snapshots and key', 'aria-label': 'Open scenes and Lab' }, h('span', { html: ico('lab') }), h('span', { class: 'btn-l' }, 'Scenes'));
  dr.onclick = () => A.setDrawer(!store.ui.drawer);
  hd.append(dr);
  return hd;
}
function fitControl(s) {
  const ok = fitChoicesOk(s.params, s.sample.duration, store.project.bpm), cur = s.params.fit;
  const box = h('div', { class: 'mw-fit', role: 'radiogroup', 'aria-label': 'Fit to beat (bars)', 'data-testid': 'munch-fit' });
  box.append(h('span', { class: 'mw-fit-l' }, h('b', {}, 'FIT'), h('small', {}, 'to beat')));
  FIT_CHOICES.forEach(c => {
    const on = cur === c;
    const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(on), class: (on ? 'on' : '') + (ok[c] ? '' : ' far'), 'data-fit': c,
      title: c === 'off' ? 'Original speed' : `${FIT_LABEL[c]} bar${c === 'half' || c === '1' ? '' : 's'} at ${store.project.bpm} BPM${ok[c] ? '' : ' — too far to fit'}`,
      'aria-label': c === 'off' ? 'Original speed' : `Fit to ${c === 'half' ? 'half a bar' : c + (c === '1' ? ' bar' : ' bars')}` }, FIT_LABEL[c]);
    b.onclick = () => A.setFit(c);
    box.append(b);
  });
  // how the fit is made: STRETCH keeps the pitch (default), TAPE lets the pitch follow the speed. One big toggle.
  const mode = s.params.fitMode === 'tape' ? 'tape' : 'stretch', other = mode === 'tape' ? 'stretch' : 'tape';
  const modes = h('button', { type: 'button', class: 'mw-fitmode ' + mode, 'data-testid': 'munch-fitmode', 'data-fitmode': mode,
    title: mode === 'stretch' ? 'Stretch: tempo changes the length, the pitch stays. Tap for Tape.' : 'Tape: speed and pitch change together. Tap for Stretch.',
    'aria-label': `Fit mode: ${mode === 'stretch' ? 'Stretch, pitch kept' : 'Tape, pitch follows speed'}. Tap to switch to ${other}.` },
    h('b', {}, mode === 'stretch' ? 'STRETCH' : 'TAPE'), h('small', {}, mode === 'stretch' ? 'pitch kept' : 'pitch moves'));
  modes.onclick = () => A.setFitMode(other);
  box.append(modes);
  return box;
}
function character(size) {
  const c = h('div', { class: `mw-char ${size}`, 'data-face': A.recorder.state === 'recording' ? 'listen' : 'idle', html: catSVG('munch'), role: 'img', 'aria-label': 'MUNCH' });
  c.onclick = () => { munchReact('yum'); };
  return c;
}
function bounce(kind) {
  const c = refs.char; if (!c || !store.ui.motion) return;
  const anim = { yum: 'chomp2', chomp: 'chomp', note: 'bop', snip: 'snip', magic: 'spin', oops: 'shake', listen: 'chomp' }[kind];
  if (!anim) return;
  c.classList.remove('a-chomp', 'a-chomp2', 'a-bop', 'a-snip', 'a-spin', 'a-shake');
  void c.offsetWidth; // restart the animation
  c.classList.add('a-' + anim);
}
function flash(el) { if (!el) return; el.classList.add('hit'); clearTimeout(el._ft); el._ft = setTimeout(() => el.classList.remove('hit'), 110); }

/* ---------- record / import ---------- */
function importButton(size) {
  const file = h('input', { type: 'file', accept: 'audio/*,.wav,.mp3,.m4a,.aac,.ogg,.webm,.flac,.aif,.aiff', hidden: true, 'data-testid': 'munch-file' });
  file.onchange = async () => { const f = file.files && file.files[0]; file.value = ''; if (f) await A.importSampleFile(f, sel()); };
  const big = size === 'big';
  const b = h('button', { type: 'button', class: big ? 'mw-big import' : 'btn icon mw-imp', 'data-testid': 'munch-import', 'aria-label': 'Import a sound file', title: 'Import a sound file' },
    h('span', { class: big ? 'mw-big-i' : 'mw-mini-i', html: ico('upload') }), big ? h('span', { class: 'mw-big-t' }, h('b', {}, 'IMPORT'), h('small', {}, 'a file from your device')) : null);
  b.onclick = () => file.click();
  return h('span', { class: 'mw-filewrap' }, b, file);
}
function recButton(size) {
  const big = size === 'big', r = A.recorder.state;
  const sup = A.recordingSupport();
  if (!sup.ok) {
    const why = sup.reason === 'insecure' ? 'needs an https page' : 'not supported in this browser';
    return big ? h('div', { class: 'mw-big rec', 'aria-disabled': 'true', 'data-testid': 'munch-rec-off' }, h('span', { class: 'mw-big-i', html: ico('mic') }), h('span', { class: 'mw-big-t' }, h('b', {}, 'RECORD'), h('small', {}, why))) : h('span');
  }
  const on = r === 'recording';
  const b = h('button', { type: 'button', class: (big ? 'mw-big rec' : 'btn icon mw-rec') + (on ? ' on' : ''), 'data-testid': 'munch-rec', disabled: r === 'starting' || r === 'stopping',
    'aria-label': on ? 'Stop and keep the recording' : 'Record a sound', title: on ? 'Stop and keep' : 'Record a sound' },
    h('span', { class: big ? 'mw-big-i' : 'mw-mini-i', html: on ? ico('stop') : '<i class="mw-dot"></i>' }),
    big ? h('span', { class: 'mw-big-t' }, h('b', {}, on ? 'STOP & KEEP' : r === 'starting' ? 'ALLOW THE MIC…' : 'RECORD'), h('small', { 'data-testid': 'munch-rec-time' }, on ? `${A.recorder.elapsed().toFixed(1)} s · up to 30 s` : 'with the microphone')) : null);
  b.onclick = () => (A.recorder.state === 'recording' ? A.recordStop(sel()) : A.recordStart());
  return b;
}
let recT = 0;
function tickRecording() {
  clearTimeout(recT);
  recT = setTimeout(() => {
    if (A.recorder.state !== 'recording') return;
    const t = document.querySelector('[data-testid=munch-rec-time]'); if (t) t.textContent = `${A.recorder.elapsed().toFixed(1)} s · up to 30 s`;
    if (refs.status) refs.status.textContent = statusLine();
    tickRecording();
  }, 200);
}
function feed(s, st) {
  const ref = s.sample, missing = ref && st.status === 'missing', r = A.recorder.state;
  refs.char = character('big');
  const title = r === 'recording' ? 'I’m listening…' : missing ? `“${ref.name}” is missing here` : 'Feed me a sound!';
  const sub = r === 'recording' ? 'Make some noise! Tap STOP & KEEP when you are done.'
    : missing ? 'Import the same file again and everything comes back: slices, grooves and all. Your patterns are safe.'
      : 'Record anything: your voice, a beatbox, a pan lid. Or import a short break (up to 30 s).';
  const btns = h('div', { class: 'mw-feed-btns' }, recButton('big'));
  if (r === 'recording') { const c = h('button', { type: 'button', class: 'btn mw-cancel' }, 'Cancel'); c.onclick = A.recordCancel; btns.append(c); }
  else btns.append(importButton('big'));
  return h('div', { class: 'mw-feed', 'data-testid': 'munch-feed' }, refs.char, h('div', { class: 'mw-feed-r' }, h('h3', {}, title), h('p', {}, sub), btns));
}

/** a sample could not be written to this browser's storage: explain, retry, or (after confirmation) repair */
function storageDialog() {
  const err = A.samples.store.lastError();
  const body = h('div', { class: 'dlg-form' },
    h('p', {}, 'This sound plays now, but the browser refused to save it. After a reload it will be missing (your song keeps its slices and grooves; importing the same file again brings it back).'),
    h('p', {}, 'Try again first. If that keeps failing, Repair rebuilds HarbuMatic’s sample storage: it rescues every sample it can still read, deletes only HarbuMatic’s sample database and saves everything again. Songs and other websites are not touched.'),
    err ? h('p', { class: 'dlg-note', 'data-testid': 'munch-storage-diag' }, `Browser said: ${err.name} while ${err.phase === 'read' ? 'reading' : err.phase === 'open' ? 'opening' : 'saving'}${err.message && err.message !== err.name ? ` — ${err.message}` : ''}`) : null);
  dialog({ title: 'Not saved on this device', body, actions: [
    { label: 'Close' },
    { label: 'Repair storage…', danger: true, onClick: () => setTimeout(() => confirmDialog('Repair sample storage?', 'HarbuMatic will rescue the samples it can read, delete its own sample database and save them again. Samples that cannot be read are lost (songs keep their references). This cannot be undone.', 'Repair', () => A.repairSampleStorage(), { danger: true }), 0) },
    { label: 'Try again', primary: true, onClick: () => A.retrySaveSamples() },
  ] });
}

/* ---------- PLAY ---------- */
function play(s) {
  const p = s.params, m = u();
  const step = (k, d, lo, hi) => { A.setParam(sel(), k, Math.max(lo, Math.min(hi, p[k] + d))); A.sealHistory(); rerender(); };
  const root = h('div', { class: 'mw-stepper', role: 'group', 'aria-label': 'Root note' },
    smallBtn('left', 'Root down', () => step('root', -1, 24, 96)),
    h('span', { class: 'mw-stepper-v' }, h('small', {}, 'ROOT'), h('b', {}, NOTE_NAME(p.root))),
    smallBtn('right', 'Root up', () => step('root', 1, 24, 96)));
  const base = 48 + 12 * m.octave;
  const oct = h('div', { class: 'mw-stepper', role: 'group', 'aria-label': 'Keyboard octave' },
    smallBtn('minus', 'Octave down', () => { m.octave = Math.max(-2, m.octave - 1); rerender(); }, m.octave <= -2),
    h('span', { class: 'mw-stepper-v' }, h('small', {}, 'KEYS'), h('b', {}, `${NOTE_NAME(base)}–${NOTE_NAME(base + 24)}`)),
    smallBtn('plus', 'Octave up', () => { m.octave = Math.min(2, m.octave + 1); rerender(); }, m.octave >= 2));
  const mode = h('div', { class: 'mw-labeled' }, Seg([['oneshot', 'One-shot'], ['gate', 'Gate'], ['loop', 'Loop']], p.mode, v => { A.checkpoint(); P().mode = v; A.engine.applyParams(sel()); A.save(); }, { label: 'Play mode' }), h('small', {}, 'HOLD A KEY: GATE / LOOP'));
  const row = h('div', { class: 'mw-ctl' }, root, oct, mode);
  return h('div', { class: 'mw-play' }, row, keyboard(base, p.root));
}
function keyboard(base, root) {
  const box = h('div', { class: 'mkeys', role: 'group', 'aria-label': 'MUNCH keyboard: press lower on a key to play louder', 'data-testid': 'munch-keys' });
  const whites = [];
  for (let i = 0; i <= 24; i++) if (![1, 3, 6, 8, 10].includes(i % 12)) whites.push(i);
  box.style.setProperty('--nw', whites.length);
  let wi = 0;
  for (let i = 0; i <= 24; i++) {
    const midi = base + i, black = [1, 3, 6, 8, 10].includes(i % 12);
    const k = h('button', { type: 'button', class: 'mk ' + (black ? 'b' : 'w') + (midi === root ? ' root' : ''), 'data-midi': midi, 'aria-label': `${NOTE_NAME(midi)}${midi === root ? ' (root: as recorded)' : ''}` },
      !black && (midi % 12 === 0 || midi === root) ? h('span', { class: 'mk-l' }, midi === root ? 'ROOT' : NOTE_NAME(midi)) : null, h('i', { class: 'mk-v' }));
    if (black) k.style.left = `calc(var(--kw) * ${wi} - var(--bw) / 2)`; else wi++;
    bindKey(k, midi);
    box.append(k);
  }
  refs.keys = box;
  return box;
}
function bindKey(k, midi) {
  const on = (id, v) => { k.style.setProperty('--v', v.toFixed(2)); k.classList.add('down'); held.set(id, { handle: A.munchNoteOn(midi, v), el: k }); };
  const off = id => { const x = held.get(id); if (!x) return; held.delete(id); A.munchNoteOff(x.handle); x.el.classList.remove('down'); };
  k.addEventListener('pointerdown', e => {
    e.preventDefault();
    const r = k.getBoundingClientRect(), v = .35 + .65 * Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    try { k.setPointerCapture(e.pointerId); } catch (er) { /* synthetic */ }
    on(e.pointerId, v);
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => k.addEventListener(t, e => off(e.pointerId)));
  k.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); e.stopPropagation(); on('key' + midi, .8); } });
  k.addEventListener('keyup', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); off('key' + midi); } });
  k.addEventListener('click', e => e.preventDefault());
}
function releaseAll() { for (const [id, x] of held) { A.munchNoteOff(x.handle); held.delete(id); } }

/* ---------- CHOP ---------- */
function chop(s, host) {
  const ref = s.sample, n = sliceCount(ref.slices), m = u();
  const tool = (icon, label, fn, { cls = '', needs, testid, title } = {}) => {
    const b = h('button', { type: 'button', class: 'btn mw-tool ' + cls, 'aria-label': label, title: title || label, 'data-needs': needs || null, 'data-testid': testid || null, disabled: needs === 'marker' && m.marker == null },
      h('span', { html: ico(icon) }), h('span', { class: 'btn-l' }, label));
    b.onclick = fn; return b;
  };
  refs.cursor = h('span', { class: 'sr-only', 'aria-live': 'polite' }, cursorText()); // the display shows it too
  refs.tools = h('div', { class: 'mw-tools' },
    tool('scissors', 'CHOP HERE', () => A.chopAt(u().cursor), { cls: 'primary wide', testid: 'munch-chop-here', title: 'Add a marker at the cursor' }),
    tool('split', 'Split', () => A.splitSliceAt(u().sel), { testid: 'munch-split', title: 'Split the selected slice in half' }),
    tool('left', 'Nudge', () => A.nudgeBoundary(-1), { needs: 'marker', cls: 'icon', testid: 'munch-nudge-l', title: 'Move the selected marker a little earlier' }),
    tool('right', 'Nudge', () => A.nudgeBoundary(1), { needs: 'marker', cls: 'icon', testid: 'munch-nudge-r', title: 'Move the selected marker a little later' }),
    tool('trash', 'Delete', () => A.deleteBoundary(), { needs: 'marker', testid: 'munch-delete', title: 'Delete the selected marker' }),
    tool('repeat', '8 equal', () => A.resetSlices(8), { testid: 'munch-reset', title: 'Back to eight equal slices' }));
  refs.tools.querySelectorAll('.btn.icon .btn-l').forEach(l => l.remove());
  const left = h('div', { class: 'mw-left' }, refs.tools, refs.cursor, pads(ref, n), magicPanel());
  const right = h('div', { class: 'mw-right' }, sequencer(ref, n, host));
  return h('div', { class: 'mw-chop' }, left, right);
}
function pads(ref, n) {
  const m = u(), st = A.sampleState(sel()), ready = st.status === 'ready';
  const wrap = h('div', { class: 'mw-padwrap' });
  const grid = h('div', { class: 'mw-pads' + (n > 8 ? ' banks' : ''), 'data-testid': 'munch-pads' });
  for (let i = 0; i < 8; i++) {
    const k = m.bank * 8 + i;
    if (k >= n) { grid.append(h('div', { class: 'mw-pad ghost', 'aria-hidden': 'true' })); continue; }
    const reg = sliceRegion(ref.slices, k), len = (reg[1] - reg[0]) * ref.duration;
    const b = h('button', { type: 'button', class: 'mw-pad' + (k === m.sel ? ' sel' : ''), 'data-k': k, disabled: !ready, style: `--pc:${SLICE_COLORS[k % 4]}`, 'aria-label': `Pad ${k + 1}: play slice ${k + 1}` },
      h('b', {}, String(k + 1)), h('small', {}, len < 1 ? `${Math.round(len * 1000)} ms` : `${len.toFixed(2)} s`));
    bindPad(b, k);
    grid.append(b);
  }
  if (n > 8) { // second bank: a slim column beside the pads, so the panel keeps its height
    const col = h('div', { class: 'mw-bankcol', role: 'radiogroup', 'aria-label': 'Pad bank' });
    [[0, '1–8'], [1, n === 9 ? '9' : `9–${n}`]].forEach(([v, l]) => {
      const b = h('button', { type: 'button', role: 'radio', class: 'mw-bankbtn' + (m.bank === v ? ' on' : ''), 'aria-checked': String(m.bank === v), 'data-testid': `munch-bank-${v}` }, l);
      b.onclick = () => { m.bank = v; if (Math.floor(m.sel / 8) !== v) m.sel = v * 8; rerender(); };
      col.append(b);
    });
    grid.append(col);
  }
  refs.pads = grid;
  wrap.append(grid);
  return wrap;
}
/** pads behave like keys: press = play (velocity from where you press), release = end a Gate/Loop note */
function bindPad(b, k) {
  const on = (id, v) => { b.classList.add('down'); held.set(id, { handle: A.munchPadOn(k, v), el: b }); A.selectSlice(k); flash(b); };
  const off = id => { const x = held.get(id); if (!x) return; held.delete(id); A.munchPadOff(x.handle); x.el.classList.remove('down'); };
  b.addEventListener('pointerdown', e => {
    e.preventDefault();
    const r = b.getBoundingClientRect(), v = .45 + .55 * Math.max(0, Math.min(1, (e.clientY - r.top) / Math.max(1, r.height)));
    try { b.setPointerCapture(e.pointerId); } catch (er) { /* synthetic */ }
    on(e.pointerId, v);
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => b.addEventListener(t, e => off(e.pointerId)));
  b.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); e.stopPropagation(); on('pad' + k, .9); } });
  b.addEventListener('keyup', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); off('pad' + k); } });
  b.addEventListener('click', e => e.preventDefault());
}
function magicPanel() {
  const m = u(), pending = !!(m.magic && m.magic.slot === sel() && m.magic.scene === store.project.scene);
  const box = h('div', { class: 'mw-magic', 'data-testid': 'munch-magic' });
  const go = h('button', { type: 'button', class: 'mw-magic-go', 'data-testid': 'munch-magic-go', 'aria-label': pending ? 'MAGIC CHOP again' : 'MAGIC CHOP: make a groove from the slices' },
    h('span', { html: ico(pending ? 'repeat' : 'spark') }), pending ? 'AGAIN' : 'MAGIC CHOP');
  go.onclick = () => A.magicChop(m.style);
  const row = h('div', { class: 'mw-magic-row' }, go);
  if (pending) {
    const keep = h('button', { type: 'button', class: 'btn mw-keep', 'data-testid': 'munch-magic-keep' }, h('span', { html: ico('check') }), h('span', { class: 'btn-l' }, 'Keep'));
    keep.onclick = A.magicKeep;
    const undo = h('button', { type: 'button', class: 'btn mw-undo', 'data-testid': 'munch-magic-undo' }, h('span', { html: ico('undo') }), h('span', { class: 'btn-l' }, 'Undo'));
    undo.onclick = A.magicUndo;
    row.append(keep, undo);
  }
  const styles = h('div', { class: 'mw-styles', role: 'radiogroup', 'aria-label': 'MAGIC CHOP style' });
  MAGIC_STYLES.forEach(st => {
    const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(m.style === st), class: 'mw-style' + (m.style === st ? ' on' : ''), title: MAGIC_LABEL[st] }, STYLE_SHORT[st]);
    b.onclick = () => { m.style = st; A.magicChop(st); };
    styles.append(b);
  });
  box.append(row, styles);
  return box;
}
function sequencer(ref, n, host) {
  const p = pat(), m = u(), sc = store.project.scene;
  // 16 steps per page when every cell can stay ≥ 38 px wide, else 8 (two pages per bar)
  const avail = (host.clientWidth || 900) - (host.clientWidth > 860 ? 380 : 24);
  const per = avail >= 16 * 41 + 52 ? 16 : 8;
  refs.perPage = per;
  const pages = p.len / per;
  m.page = Math.min(m.page, pages - 1);
  const head = h('div', { class: 'mw-seqhead' });
  const scenes = h('div', { class: 'mw-scenes', role: 'group', 'aria-label': 'Scene' });
  store.project.scenes.forEach((s, i) => {
    const b = h('button', { type: 'button', class: 'mw-scene' + (i === sc ? ' on' : ''), 'aria-pressed': String(i === sc), title: `Scene ${SCENE_LETTERS[i]} · ${s.name}`, 'aria-label': `Scene ${SCENE_LETTERS[i]}` }, SCENE_LETTERS[i]);
    b.onclick = () => A.selectScene(i);
    scenes.append(b);
  });
  head.append(scenes);
  head.append(Seg([[16, '1'], [32, '2'], [64, '4']], p.len, v => { A.setLength(v); }, { label: 'Pattern length in bars', cls: 'mw-bars' }));
  const tl = (icon, text) => h('span', { class: 'mw-tl', title: text }, h('span', { html: ico(icon) }), h('span', { class: 'mw-tl-t' }, text));
  head.append(Seg([['draw', tl('draw', 'Draw')], ['accent', tl('vel', 'Accent')], ['lock', tl('lock', 'Lock')]], m.tool, v => { m.tool = v; }, { label: 'Sequencer tool', cls: 'mw-seqtool' }));
  if (pages > 1) {
    const pg = h('div', { class: 'mw-pages', role: 'group', 'aria-label': 'Page' },
      smallBtn('left', 'Previous steps', () => { m.page = (m.page - 1 + pages) % pages; rerender(); }),
      h('span', { class: 'mw-page-t', 'aria-live': 'polite' }, `${m.page + 1}/${pages}`),
      smallBtn('right', 'Next steps', () => { m.page = (m.page + 1) % pages; rerender(); }));
    head.append(pg);
  }
  const grid = h('div', { class: 'mw-grid', 'data-testid': 'munch-grid', style: `--steps:${per}` });
  const rows = Math.min(8, n - m.bank * 8);
  for (let r = 0; r < rows; r++) {
    const k = m.bank * 8 + r;
    const row = h('div', { class: 'mw-row' + (k === m.sel ? ' sel' : ''), 'data-k': k, style: `--pc:${SLICE_COLORS[k % 4]}` });
    const lbl = h('button', { type: 'button', class: 'mw-rowlbl', 'aria-label': `Slice ${k + 1}: hear and select` }, String(k + 1));
    lbl.onclick = () => { A.auditionSlice(k); A.selectSlice(k); };
    row.append(lbl);
    for (let c = 0; c < per; c++) {
      const step = m.page * per + c, note = p.notes.find(x => x.s === step && x.slice === k);
      const cls = 'mw-cell' + (note ? ' on' : '') + (note && note.v < .5 ? ' soft' : '') + (note && note.v >= .95 ? ' acc' : '') + (note && note.locked ? ' locked' : '') + (step % 4 === 0 ? ' beat' : '') + (step % 16 === 0 ? ' bar' : '');
      const b = h('button', { type: 'button', class: cls, 'data-k': k, 'data-s': step, 'data-c': c, 'aria-pressed': String(!!note), 'aria-label': `Slice ${k + 1}, step ${step + 1}${note && note.locked ? ', locked' : ''}` });
      b.onclick = () => cell(k, step);
      row.append(b);
    }
    grid.append(row);
  }
  refs.grid = grid;
  const melodic = p.notes.filter(x => x.slice == null).length;
  if (melodic) { const j = h('button', { type: 'button', class: 'mw-melodic', title: 'Melodic notes are edited in JAM' }, `♪ ${melodic}`); j.setAttribute('aria-label', `${melodic} melodic note${melodic > 1 ? 's' : ''} in this scene: edit them in JAM`); j.onclick = () => A.setMode('jam'); head.append(j); }
  return h('div', { class: 'mw-seq' }, head, grid);
}
function cell(k, step) {
  const t = u().tool, has = pat().notes.some(x => x.s === step && x.slice === k);
  if (t === 'draw' || !has) A.toggleSliceStep(k, step);
  else if (t === 'accent') A.cycleSliceVel(k, step);
  else A.toggleSliceLock(k, step);
}

/* ---------- TWIST ---------- */
function twist(s) {
  const p = s.params, typeDef = { root: 60, tune: 0, start: 0, end: 1, attack: .002, release: .08, vol: .8, pan: 0, drive: .3, delay: .2, reverb: .2, fitFine: 0 };
  const K = (k, l, o = {}) => { const kn = Knob({ label: l, min: o.min ?? 0, max: o.max ?? 1, step: o.step || 0, value: p[k], def: typeDef[k], fmt: o.fmt || pct, onChange: v => A.setParam(sel(), k, v), onEnd: A.sealHistory, title: o.title }); kn.k = k; knobs.push(kn); return kn.el; };
  const seg = (k, opts, label) => h('div', { class: 'wave-pick' }, Seg(opts, p[k], v => { A.checkpoint(); P()[k] = v; A.engine.applyParams(sel()); A.save(); refreshMunchParams(); }, { label }), h('div', { class: 'klbl' }, label.toUpperCase()));
  const sw = (k, l) => { const on = !!p[k]; const b = h('button', { type: 'button', class: 'mw-sw' + (on ? ' on' : ''), 'aria-pressed': String(on) }, h('i'), l); b.onclick = () => { A.toggleParam(sel(), k); rerender(); }; return b; };
  const group = (title, hint, ...kids) => h('div', { class: 'sgroup mw-group' }, h('h4', {}, title, hint ? h('small', {}, hint) : null), h('div', { class: 'row' }, ...kids));
  const fit = fitInfo(p, s.sample.duration, store.project.bpm);
  const groups = h('div', { class: 'mw-twist sgroups' },
    group('Region', 'what part plays', K('start', 'Start'), K('end', 'End'), seg('reverse', [[false, 'Fwd'], [true, 'Rev']], 'Direction')),
    group('Pitch', 'root = as recorded', K('root', 'Root', { min: 24, max: 96, step: 1, fmt: NOTE_NAME }), K('tune', 'Tune', { min: -24, max: 24, step: 1, fmt: v => (v > 0 ? '+' : '') + v + ' st' }),
      K('fitFine', 'Fit fine', { min: -.12, max: .12, fmt: v => (v > 0 ? '+' : '') + Math.round(v * 100) + '%', title: fit.on ? 'Fine-tune the tape fit' : 'Works when FIT is on' })),
    group('Play', null, seg('mode', [['oneshot', 'One-shot'], ['gate', 'Gate'], ['loop', 'Loop']], 'Mode'), K('attack', 'Attack', { max: 2, fmt: sec }), K('release', 'Release', { min: .005, max: 4, fmt: sec }),
      seg('choke', [[false, 'Overlap'], [true, 'Cut']], 'Chops')),
    group('Space & colour', null, K('vol', 'Volume'), K('pan', 'Pan', { min: -1, max: 1, fmt: panFmt }),
      h('div', { class: 'mw-fxk' }, K('drive', 'Drive'), sw('driveOn', 'On')), h('div', { class: 'mw-fxk' }, K('delay', 'Delay', { max: .8 }), sw('delayOn', 'On')), h('div', { class: 'mw-fxk' }, K('reverb', 'Reverb'), sw('reverbOn', 'On'))));
  const fx = store.project.fx, frow = [];
  const gk = (l, k, min, max, d) => { const kn = Knob({ label: l, min, max, value: fx[k], def: d, fmt: pct, onChange: v => A.setFx(k, v), onEnd: A.sealHistory }); kn.k = 'fx:' + k; knobs.push(kn); return kn.el; };
  const swing = Knob({ label: 'Swing', max: .5, value: store.project.swing, def: .08, color: '#9A82DD', fmt: pct, onChange: v => A.setSwing(v), onEnd: A.sealHistory }); swing.k = '__swing'; knobs.push(swing);
  frow.push(swing.el, gk('Echo fdbk', 'fb', 0, .85, .4), gk('Echo tone', 'dtone', 0, 1, .5), gk('Room level', 'rev', 0, 1.2, .9), gk('Master', 'master', 0, 1, .85));
  groups.append(h('div', { class: 'sgroup wide mw-group' }, h('h4', {}, 'Groove + shared FX', h('small', {}, 'all instruments')), h('div', { class: 'row' }, ...frow)));
  return groups;
}

/* ---------- helpers ---------- */
function smallBtn(icon, label, fn, disabled = false) {
  const b = h('button', { type: 'button', class: 'btn icon', 'aria-label': label, title: label, disabled, html: ico(icon) });
  b.onclick = fn; return b;
}
let rerenderFn = null;
/** main.js hands in its SOUND re-render (keeps scroll position etc.) */
export function setMunchRerender(fn) { rerenderFn = fn; }
function rerender() { if (rerenderFn) rerenderFn(); }
