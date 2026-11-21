// MUNCH waveform editor: a small hardware-style display that draws the real decoded waveform (cached peaks from the
// sample bank), slice regions and markers, the cursor, the trim region and a beat/time ruler — and turns touches into
// editor actions. Pointer Events only, no hover; touch-action: none so editing never scrolls the page.
//
//   tap                 put the cursor there, select the slice under it and hear the sound from there
//   drag a marker       (CHOP) move a slice boundary · (TWIST) move the trim start/end
//   drag elsewhere      scrub the cursor, or pan when zoomed in
//   keys                ←/→ cursor (Shift: fine) · Enter: CHOP HERE (CHOP) or hear · Delete: delete the selected marker
//
// Markers have big round handles in the lane under the waveform, so nobody has to hit a thin line.

import { store, slot, P } from '../app/store.js';
import * as A from '../app/actions.js';
import { sliceCount, trimRegion, sliceAt, fitInfo } from '../core/samples.js';
import { peaksForView } from '../samples/peaks.js';
import { h } from '../ui/dom.js';

export const SLICE_COLORS = ['#F2AFC0', '#A5DFCE', '#F5D19A', '#C2B0ED'];
const SCREEN = '#262338', INK = '#FFF4E6', HANDLE_LANE = 26, RULER = 16, HIT = 24;
const ZOOMS = [1, 2, 4, 8, 16, 32];

let W = null; // { cv, wrap, ro }

const u = () => store.ui.munch;
const ref = () => { const s = slot(); return s && s.sample; };
const viewSpan = () => 1 / u().zoom;
function clampView() { const m = u(); m.view = Math.max(0, Math.min(1 - viewSpan(), m.view)); }

/** zoom in/out around the cursor (visible alternative to pinching) */
export function zoomWave(dir) {
  const m = u(), i = ZOOMS.indexOf(m.zoom), next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? 0 : i) + dir))];
  if (next === m.zoom) return;
  m.zoom = next; m.view = m.cursor - viewSpan() / 2; clampView();
  drawWave();
}
/** a marker drag or scrub is in progress (main.js then avoids rebuilding the workspace) */
export const waveDragging = () => !!(W && W.drag);
export const zoomLevels = () => ({ zoom: u().zoom, min: u().zoom === ZOOMS[0], max: u().zoom === ZOOMS[ZOOMS.length - 1] });

/** build the display (replaces any previous one) */
export function Wave({ tab }) {
  const cv = h('canvas', { class: 'mw-wave-cv', tabindex: 0, role: 'img', 'data-testid': 'munch-wave', 'aria-label': 'Waveform. Tap to place the cursor; drag the round handles to move markers. Arrow keys move the cursor, Enter chops or plays.' });
  const wrap = h('div', { class: 'mw-wave', 'data-tab': tab }, cv);
  if (W && W.ro) W.ro.disconnect();
  W = { cv, wrap, tab, drag: null, ro: null };
  if (typeof ResizeObserver === 'function') { W.ro = new ResizeObserver(() => drawWave()); W.ro.observe(wrap); }
  bind(cv, tab);
  requestAnimationFrame(drawWave);
  return wrap;
}

/** markers the current tab can drag: slice boundaries (CHOP) or trim start/end (TWIST) */
function markers() {
  const r = ref(); if (!r) return [];
  if (W.tab === 'chop') return r.slices.map((x, i) => ({ x, i, kind: 'slice' }));
  if (W.tab === 'twist') { const [a, b] = trimRegion(P()); return [{ x: a, i: 0, kind: 'start' }, { x: b, i: 1, kind: 'end' }]; }
  return [];
}
const xOf = (f, w) => ((f - u().view) / viewSpan()) * w;
const fOf = (x, w) => u().view + (x / w) * viewSpan();

function bind(cv, tab) {
  const pos = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }; };
  cv.addEventListener('pointerdown', e => {
    if (W.drag) return; // one finger edits; a second one is ignored
    e.preventDefault(); cv.focus({ preventScroll: true });
    const p = pos(e), f = fOf(p.x, p.w);
    let hit = null, best = HIT;
    const inLane = p.y > p.h - HANDLE_LANE - 8;
    for (const m of markers()) { const d = Math.abs(xOf(m.x, p.w) - p.x); if (d < (inLane ? best : 12) && d < best) { best = d; hit = m; } }
    try { cv.setPointerCapture(e.pointerId); } catch (er) { /* synthetic */ }
    W.drag = { id: e.pointerId, x0: p.x, f0: f, view0: u().view, marker: hit, moved: false };
    if (hit && hit.kind === 'slice') A.selectMarker(hit.i);
  });
  cv.addEventListener('pointermove', e => {
    const d = W.drag; if (!d || d.id !== e.pointerId) return;
    const p = pos(e);
    if (Math.abs(p.x - d.x0) > 6) d.moved = true;
    if (!d.moved) return;
    const f = Math.max(0, Math.min(1, fOf(p.x, p.w)));
    if (d.marker) {
      if (d.marker.kind === 'slice') A.moveSlice(d.marker.i, f);
      else { const pr = P(), other = d.marker.kind === 'start' ? pr.end : pr.start; A.setParam(store.ui.sel, d.marker.kind, d.marker.kind === 'start' ? Math.min(f, other - .002) : Math.max(f, other + .002)); }
      drawWave();
    } else if (u().zoom > 1) { u().view = d.view0 - ((p.x - d.x0) / p.w) * viewSpan(); clampView(); drawWave(); }
    else { u().cursor = f; drawWave(); }
  });
  const end = e => {
    const d = W.drag; if (!d || d.id !== e.pointerId) return;
    W.drag = null;
    if (e.type === 'pointercancel') { A.sealHistory(); drawWave(); return; }
    if (d.marker && d.moved) { A.sealHistory(); return; }
    const p = pos(e), f = Math.max(0, Math.min(1, d.moved && u().zoom > 1 ? u().cursor : fOf(p.x, p.w)));
    if (d.marker && !d.moved) { drawWave(); return; } // a tap on a handle just selects that marker
    A.setCursor(f);
    const r = ref(); if (!r) return;
    // hear it from the cursor: to the end of its slice (CHOP) or of the trimmed region (PLAY/TWIST)
    if (tab === 'chop') { const k = sliceAt(r.slices, f); A.auditionRegion(Math.max(f, r.slices[k]), r.slices[k + 1]); }
    else { const [, b] = trimRegion(P()); A.auditionRegion(f, b > f ? b : 1); }
  };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  cv.addEventListener('lostpointercapture', e => { if (W.drag && W.drag.id === e.pointerId) { W.drag = null; A.sealHistory(); } });
  cv.addEventListener('keydown', e => {
    const m = u(), step = e.shiftKey ? .001 : .01;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); A.setCursor(m.cursor + (e.key === 'ArrowLeft' ? -step : step)); keepCursorInView(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (tab === 'chop') A.chopAt(m.cursor); else A.auditionRegion(m.cursor, trimRegion(P())[1]); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && tab === 'chop') { e.preventDefault(); A.deleteBoundary(); }
  });
}
function keepCursorInView() { const m = u(); if (m.cursor < m.view || m.cursor > m.view + viewSpan()) { m.view = m.cursor - viewSpan() / 2; clampView(); } }

/** redraw the display (cheap: peaks are aggregated per pixel column from the cached peak data) */
export function drawWave() {
  if (!W || !W.cv.isConnected) return;
  const cv = W.cv, rect = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  if (!rect.width || !rect.height) return;
  const w = Math.round(rect.width), hgt = Math.round(rect.height);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hgt * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hgt * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = SCREEN; g.fillRect(0, 0, w, hgt);
  const r = ref(), m = u(), id = store.ui.sel;
  const top = RULER, laneY = hgt - HANDLE_LANE, mid = (top + laneY) / 2, amp = (laneY - top) / 2 - 3;
  const st = A.sampleState(id);
  if (!r) { label(g, w, hgt, 'Feed MUNCH a sound'); return; }
  clampView();
  const n = sliceCount(r.slices), X = f => xOf(f, w);
  // slice regions (tinted), selected slice brighter
  for (let k = 0; k < n; k++) {
    const a = X(r.slices[k]), b = X(r.slices[k + 1]); if (b < 0 || a > w) continue;
    g.fillStyle = SLICE_COLORS[k % 4] + (k === m.sel && W.tab === 'chop' ? '55' : '1c');
    g.fillRect(a, top, b - a, laneY - top);
  }
  // trim shading (PLAY / TWIST): outside the region is dimmed
  if (W.tab !== 'chop') {
    const [a, b] = trimRegion(P());
    g.fillStyle = '#00000088'; g.fillRect(0, top, Math.max(0, X(a)), laneY - top); g.fillRect(X(b), top, w - X(b), laneY - top);
  }
  // waveform
  const peaks = st.status === 'ready' ? A.samples.peaks(r.id) : null;
  if (peaks) {
    const cols = Math.max(1, Math.floor(w)), v = peaksForView(peaks, m.view, m.view + viewSpan(), cols);
    g.fillStyle = INK;
    for (let x = 0; x < cols; x++) { const y0 = mid - v.max[x] * amp, y1 = mid - v.min[x] * amp; g.fillRect(x, y0, 1, Math.max(1, y1 - y0)); }
  } else {
    label(g, w, hgt, st.status === 'loading' || st.status === 'idle' ? 'Loading…' : st.status === 'missing' ? 'Missing on this device' : st.status === 'error' ? 'Could not be loaded' : '');
  }
  g.fillStyle = '#ffffff22'; g.fillRect(0, mid, w, 1);
  // ruler: beats when Fit is on (bar.beat), seconds otherwise
  g.fillStyle = '#1b1929'; g.fillRect(0, 0, w, top);
  g.font = '700 9px Nunito, system-ui, sans-serif'; g.textBaseline = 'middle';
  const fit = fitInfo(P(), r.duration, store.project.bpm), rate = fit.rate;
  if (r.duration > 0) {
    const secPerBeat = 60 / store.project.bpm, total = r.duration / rate; // seconds of the whole sample at tape speed
    const unit = fit.on ? secPerBeat : niceStep(total * viewSpan() / Math.max(1, w / 70));
    for (let t = 0, i = 0; t <= total + 1e-9 && i < 4000; t += unit, i++) {
      const x = X(t / total); if (x < -20 || x > w + 20) continue;
      const major = fit.on ? i % 4 === 0 : true;
      g.fillStyle = major ? '#F5D19A' : '#ffffff55'; g.fillRect(x, top - (major ? 7 : 4), 1, major ? 7 : 4);
      if (major && x < w - 24) { g.fillStyle = '#d8cbe0'; g.fillText(fit.on ? `${Math.floor(i / 4) + 1}` : `${+t.toFixed(2)}s`, x + 3, 7); }
    }
  }
  // cursor position (bar.beat.16th with Fit, seconds without), right-aligned in the ruler
  const ct = cursorText();
  if (ct) { g.font = '800 10px Nunito, system-ui, sans-serif'; g.textAlign = 'right'; g.fillStyle = '#1b1929'; g.fillRect(w - 64, 0, 64, top); g.fillStyle = '#86D3BD'; g.fillText(ct, w - 6, 8); g.textAlign = 'start'; }
  // markers: lines + big handles in the lane
  const ms = markers();
  g.fillStyle = '#1b1929'; g.fillRect(0, laneY, w, HANDLE_LANE);
  for (const mk of ms) {
    const x = X(mk.x); if (x < -HIT || x > w + HIT) continue;
    const sel = (mk.kind === 'slice' && m.marker === mk.i) || (W.drag && W.drag.marker && W.drag.marker.i === mk.i && W.drag.marker.kind === mk.kind);
    g.fillStyle = sel ? '#F5D19A' : mk.kind === 'slice' ? '#F2AFC0' : '#A5DFCE';
    g.fillRect(x - (sel ? 1 : .5), top, sel ? 2 : 1, laneY - top);
    g.beginPath(); g.arc(Math.max(9, Math.min(w - 9, x)), laneY + HANDLE_LANE / 2, sel ? 9 : 7, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
  }
  // slice numbers
  if (W.tab === 'chop') {
    g.font = '900 10px Nunito, system-ui, sans-serif';
    for (let k = 0; k < n; k++) { const a = X(r.slices[k]), b = X(r.slices[k + 1]); if (b - a < 16 || b < 0 || a > w) continue; g.fillStyle = SLICE_COLORS[k % 4]; g.fillText(String(k + 1), Math.max(a, 0) + 4, top + 10); }
  }
  // cursor
  const cx = X(m.cursor);
  if (cx >= 0 && cx <= w) { g.fillStyle = '#86D3BD'; g.fillRect(cx - 1, top, 2, laneY - top); g.beginPath(); g.moveTo(cx - 6, top); g.lineTo(cx + 6, top); g.lineTo(cx, top + 7); g.fill(); }
  // zoom minimap
  if (m.zoom > 1) { g.fillStyle = '#ffffff22'; g.fillRect(0, hgt - 3, w, 3); g.fillStyle = '#F5D19A'; g.fillRect(m.view * w, hgt - 3, viewSpan() * w, 3); }
}
function label(g, w, hgt, text) {
  if (!text) return;
  g.fillStyle = '#d8cbe0'; g.font = '800 13px Nunito, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, w / 2, hgt / 2); g.textAlign = 'start';
}
function niceStep(x) { const p = Math.pow(10, Math.floor(Math.log10(Math.max(1e-4, x)))), n = x / p; return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p; }
/** the cursor position as text: bar.beat.16th when Fit is on, seconds otherwise */
export function cursorText() {
  const r = ref(); if (!r || !(r.duration > 0)) return '';
  const fit = fitInfo(P(), r.duration, store.project.bpm), t = u().cursor * r.duration / fit.rate;
  if (!fit.on) return `${t.toFixed(2)} s`;
  const steps = t / (60 / store.project.bpm / 4), s = Math.floor(steps + 1e-6);
  return `${Math.floor(s / 16) + 1}.${Math.floor((s % 16) / 4) + 1}.${(s % 4) + 1}`;
}
