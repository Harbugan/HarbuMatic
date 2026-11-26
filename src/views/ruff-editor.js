// RUFF Compact Break Editor (v0.7 PR35):
// Touch-friendly waveform & slice editor for user-imported WAV drum breaks inside RUFF's SOUND view.
//
// Features:
// - Imported Break Pool strip with quick A/B/C lane assignment (without overwriting other lanes).
// - BPM correction (-1 / input / +1) + one-tap ½× / 2× half/double-time resolution.
// - 1 / 2 / 4 bar length selector (non-destructive timing interpretation).
// - Honest analysis uncertainty badge & note (never pretends guesses are certain).
// - Interactive waveform canvas (Pointer Events only, touch-action: none, big round marker handles):
//     tap waveform  → move cursor, select slice under it, and audition that slice immediately
//     drag handle   → move slice boundary continuously (one coalesced Undo step)
// - Nudge ◀/▶, + Slice, − Delete, Auto, Even, Audition Slice & Loop controls.
// - Missing-asset & unsaved-storage recovery banners (never silently drops or replaces a break).

import { store, slot } from '../app/store.js';
import * as A from '../app/actions.js';
import { BREAK_LANES } from '../core/instruments.js';
import { IMPORTED_BREAK_BARS, BREAK_BPM_RANGE, breakPosBeatLabel } from '../core/breaks.js';
import { sliceCount, sliceAt, MAX_SLICES } from '../core/samples.js';
import { peaksForView } from '../samples/peaks.js';
import { h } from '../ui/dom.js';
import { ico } from '../ui/icons.js';

const SLICE_COLORS = ['#C6EB88', '#F2AFC0', '#C2B0ED', '#F5D19A'];
const SCREEN = '#262338';
const INK = '#FFF4E6';
const HANDLE_LANE = 26;
const RULER = 16;
const HIT = 24;

let E = null; // { cv, wrap, breakId, slotId, drag, ro, refs }

export const ruffWaveDragging = () => !!(E && E.drag);

function activeBreak(slotId) {
  const list = A.listImportedBreaks(slotId);
  if (!list.length) return { list, cur: null };
  const want = store.ui.ruff.editBreakId;
  const cur = (want && list.find(b => b.id === want)) || list[0];
  if (cur && store.ui.ruff.editBreakId !== cur.id) {
    store.ui.ruff.editBreakId = cur.id;
  }
  return { list, cur };
}

function drawRuffWave() {
  if (!E || !E.cv || !E.cv.isConnected) return;
  const cv = E.cv;
  const rect = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (!rect.width || !rect.height) return;
  const w = Math.round(rect.width), hgt = Math.round(rect.height);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hgt * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(hgt * dpr);
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = SCREEN;
  g.fillRect(0, 0, w, hgt);

  const desc = A.getBreakDesc(E.breakId, E.slotId);
  const top = RULER;
  const laneY = hgt - HANDLE_LANE;
  const mid = (top + laneY) / 2;
  const amp = (laneY - top) / 2 - 3;
  if (!desc) return;

  const st = A.samples.state(desc.id);
  const slices = desc.slices || [0, 1];
  const n = Math.max(1, sliceCount(slices));
  const u = store.ui.ruff;
  const selSlice = Math.max(0, Math.min(n - 1, u.editSlice || 0));
  const selMarker = u.editMarker != null ? Math.max(0, Math.min(slices.length - 1, u.editMarker)) : null;

  // Tinted slice regions
  for (let k = 0; k < n; k++) {
    const a = slices[k] * w, b = slices[k + 1] * w;
    g.fillStyle = SLICE_COLORS[k % 4] + (k === selSlice ? '4a' : '18');
    g.fillRect(a, top, Math.max(1, b - a), laneY - top);
  }

  // Waveform peaks
  const peaks = st.status === 'ready' ? A.samples.peaks(desc.id) : null;
  if (peaks) {
    const cols = Math.max(1, Math.floor(w));
    const v = peaksForView(peaks, 0, 1, cols);
    g.fillStyle = INK;
    for (let x = 0; x < cols; x++) {
      const y0 = mid - v.max[x] * amp;
      const y1 = mid - v.min[x] * amp;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  } else {
    const msg = st.status === 'loading' || st.status === 'idle'
      ? 'Loading waveform…'
      : st.status === 'missing'
        ? 'WAV missing on this device — re-import same file to restore'
        : 'Audio could not be decoded';
    g.fillStyle = '#d8cbe0';
    g.font = '800 12px Nunito, system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(msg, w / 2, mid);
    g.textAlign = 'start';
  }
  g.fillStyle = '#ffffff22';
  g.fillRect(0, mid, w, 1);

  // Beat / bar ruler for 1, 2 or 4 bars
  g.fillStyle = '#1b1929';
  g.fillRect(0, 0, w, top);
  const bars = desc.bars || 2;
  const totalBeats = bars * 4;
  g.font = '700 9px Nunito, system-ui, sans-serif';
  g.textBaseline = 'middle';
  for (let b = 0; b < totalBeats; b++) {
    const x = (b / totalBeats) * w;
    const major = b % 4 === 0;
    g.fillStyle = major ? '#C6EB88' : '#ffffff44';
    g.fillRect(x, top - (major ? 7 : 4), 1, major ? 7 : 4);
    if (major) {
      g.fillStyle = '#d8cbe0';
      g.fillText(`Bar ${Math.floor(b / 4) + 1}`, x + 3, 7);
    }
  }

  // Slice numbers
  g.font = '900 10px Nunito, system-ui, sans-serif';
  for (let k = 0; k < n; k++) {
    const a = slices[k] * w, b = slices[k + 1] * w;
    if (b - a < 16) continue;
    g.fillStyle = SLICE_COLORS[k % 4];
    g.fillText(`S${k + 1}`, a + 3, top + 10);
  }

  // Handle lane + draggable markers
  g.fillStyle = '#1b1929';
  g.fillRect(0, laneY, w, HANDLE_LANE);
  for (let i = 0; i < slices.length; i++) {
    const x = slices[i] * w;
    const sel = i === selMarker || (E.drag && E.drag.marker === i);
    const edge = i === 0 || i === slices.length - 1;
    g.fillStyle = sel ? '#F5D19A' : edge ? '#86D3BD' : '#F2AFC0';
    g.fillRect(x - (sel ? 1 : 0.5), top, sel ? 2 : 1, laneY - top);
    g.beginPath();
    g.arc(Math.max(9, Math.min(w - 9, x)), laneY + HANDLE_LANE / 2, sel ? 8.5 : 6.5, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#fff';
    g.lineWidth = 1.8;
    g.stroke();
  }

  // Cursor line
  const cx = Math.max(0, Math.min(1, u.editCursor || 0)) * w;
  g.fillStyle = '#86D3BD';
  g.fillRect(cx - 1, top, 2, laneY - top);
  g.beginPath();
  g.moveTo(cx - 5, top);
  g.lineTo(cx + 5, top);
  g.lineTo(cx, top + 6);
  g.fill();
}

function bindWave(cv, breakId, slotId) {
  const pos = e => {
    const r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: Math.max(1, r.width), h: Math.max(1, r.height) };
  };

  cv.addEventListener('pointerdown', e => {
    if (!E || E.drag) return;
    e.preventDefault();
    cv.focus({ preventScroll: true });
    const desc = A.getBreakDesc(breakId, slotId);
    if (!desc) return;
    const p = pos(e);
    const f = Math.max(0, Math.min(1, p.x / p.w));
    const inLane = p.y > p.h - HANDLE_LANE - 8;
    let hit = null, best = HIT;
    for (let i = 0; i < desc.slices.length; i++) {
      const d = Math.abs(desc.slices[i] * p.w - p.x);
      if (d < (inLane ? best : 12) && d < best) { best = d; hit = i; }
    }
    try { cv.setPointerCapture(e.pointerId); } catch (er) { /* synthetic */ }
    E.drag = { id: e.pointerId, x0: p.x, marker: hit, moved: false };
    if (hit != null) A.selectRuffEditMarker(hit, breakId, slotId);
  });

  cv.addEventListener('pointermove', e => {
    if (!E || !E.drag || E.drag.id !== e.pointerId) return;
    const d = E.drag;
    const p = pos(e);
    if (Math.abs(p.x - d.x0) > 5) d.moved = true;
    if (!d.moved) return;
    const f = Math.max(0, Math.min(1, p.x / p.w));
    if (d.marker != null) {
      A.moveImportedBreakSlice(breakId, d.marker, f, slotId);
      drawRuffWave();
    } else {
      store.ui.ruff.editCursor = f;
      drawRuffWave();
    }
  });

  const finish = e => {
    if (!E || !E.drag || E.drag.id !== e.pointerId) return;
    const d = E.drag;
    E.drag = null;
    if (e.type === 'pointercancel') { A.sealHistory(); drawRuffWave(); return; }
    if (d.marker != null && d.moved) { A.sealHistory(); refreshRuffEditor(); return; }
    const p = pos(e);
    const f = Math.max(0, Math.min(1, p.x / p.w));
    if (d.marker != null && !d.moved) {
      const desc = A.getBreakDesc(breakId, slotId);
      const n = desc ? sliceCount(desc.slices) : 0;
      if (n > 0) A.auditionImportedBreak(breakId, { slice: Math.min(d.marker, n - 1), slotId });
      refreshRuffEditor();
      return;
    }
    A.setRuffEditCursor(f, breakId, slotId);
    const desc = A.getBreakDesc(breakId, slotId);
    if (desc) {
      const k = sliceAt(desc.slices, f);
      A.auditionImportedBreak(breakId, { slice: k, slotId });
    }
  };

  cv.addEventListener('pointerup', finish);
  cv.addEventListener('pointercancel', finish);
  cv.addEventListener('lostpointercapture', e => {
    if (E && E.drag && E.drag.id === e.pointerId) { E.drag = null; A.sealHistory(); }
  });
}

function sliceSummaryText(desc) {
  if (!desc) return '';
  const n = Math.max(1, sliceCount(desc.slices));
  const sel = Math.max(0, Math.min(n - 1, store.ui.ruff.editSlice || 0));
  const pos = desc.slices[sel] ?? 0;
  const beat = breakPosBeatLabel(pos, desc.bars || 2);
  const sec = desc.duration > 0 ? `${(pos * desc.duration).toFixed(2)}s` : '';
  return `S${sel + 1}/${n} · ${beat}${sec ? ` · ${sec}` : ''}`;
}

/** Update canvas & slice readout in place (safe during continuous marker drags). */
export function refreshRuffEditor() {
  if (!E || !E.cv || !E.cv.isConnected) return;
  drawRuffWave();
  const desc = A.getBreakDesc(E.breakId, E.slotId);
  if (!desc || !E.refs) return;
  if (E.refs.sliceInfo) E.refs.sliceInfo.textContent = sliceSummaryText(desc);
  const mk = store.ui.ruff.editMarker;
  const canDel = mk != null && mk > 0 && mk < desc.slices.length - 1;
  if (E.refs.delBtn) E.refs.delBtn.disabled = !canDel;
  if (E.refs.addBtn) E.refs.addBtn.disabled = sliceCount(desc.slices) >= MAX_SLICES;
  if (E.refs.nudgeL) E.refs.nudgeL.disabled = mk == null;
  if (E.refs.nudgeR) E.refs.nudgeR.disabled = mk == null;
}

/**
 * Build the compact RUFF Imported Break Pool & Break Editor panel.
 * Returns null when no imported breaks exist yet (keeping built-in RUFF SOUND layout compact).
 */
export function buildRuffBreakEditor(slotId, { onReimport } = {}) {
  const { list, cur } = activeBreak(slotId);
  if (!list.length || !cur) {
    if (E && E.ro) E.ro.disconnect();
    E = null;
    return null;
  }

  const sl = slot(slotId);
  const u = store.ui.ruff;
  const slices = cur.slices || [0, 1];
  const n = Math.max(1, sliceCount(slices));
  const selSlice = Math.max(0, Math.min(n - 1, u.editSlice || 0));
  const selMarker = u.editMarker != null ? Math.max(0, Math.min(slices.length - 1, u.editMarker)) : 0;
  const isMissing = cur.status === 'missing' || cur.status === 'error';
  const analysis = cur.analysis || null;
  const ambiguous = !!(analysis && analysis.ambiguity && analysis.ambiguity.kind === 'half-double');
  const audLoop = !!(u.audition && u.audition.slotId === slotId && u.audition.breakId === cur.id && u.audition.lane === 'edit');

  // 1) Local Imported Break selector chips
  const poolBar = h('div', { class: 'ruff-ed-pool', role: 'group', 'aria-label': 'Imported breaks', 'data-testid': 'ruff-imported-pool' },
    list.map(b => {
      const on = b.id === cur.id;
      const laneTags = b.assignedLanes.length ? b.assignedLanes.map(l => l.toUpperCase()).join('/') : '';
      const chip = h('button', {
        type: 'button',
        class: 'ruff-ed-chip' + (on ? ' on' : '') + (b.status === 'missing' ? ' missing' : '') + (b.unsaved ? ' unsaved' : ''),
        'data-break-id': b.id,
        'aria-pressed': String(on),
        title: `${b.name} (${b.bpm} BPM, ${b.bars}B)${b.unsaved ? ' — NOT saved offline' : ''}${b.status === 'missing' ? ' — missing WAV' : ''}`,
      },
      h('span', { class: 'ruff-ed-chip-name' }, b.name),
      h('small', {}, `${b.bpm} · ${b.bars}B`),
      laneTags ? h('em', { class: 'ruff-ed-chip-lanes' }, laneTags) : null);
      chip.onclick = () => A.selectRuffEditBreak(b.id);
      return chip;
    }));

  // 2) Assign-to-A/B/C quick buttons (never overwrite other lanes)
  const assignRow = h('div', { class: 'ruff-ed-assign', role: 'group', 'aria-label': `Assign ${cur.name} to lane` },
    h('span', { class: 'ruff-ed-lbl' }, 'Assign'),
    BREAK_LANES.map(l => {
      const L = l.toUpperCase();
      const on = !!(sl && sl.breaks && sl.breaks[l] === cur.id);
      const b = h('button', {
        type: 'button',
        class: 'ruff-ed-lane-btn' + (on ? ' on' : ''),
        'data-lane': l,
        'data-testid': `ruff-ed-assign-${l}`,
        'aria-pressed': String(on),
        title: on ? `Remove ${cur.name} from Break ${L}` : `Assign ${cur.name} to Break ${L} (keeps other lanes)`,
      }, L);
      b.onclick = () => A.assignBreak(l, on ? null : cur.id, slotId);
      return b;
    }));

  // 3) BPM & half/double-time + 1/2/4-bar controls
  const bpmMinus = h('button', { type: 'button', class: 'ruff-ed-step', 'data-testid': 'ruff-ed-bpm-dec', 'aria-label': 'Decrease BPM by 1', title: 'BPM −1' }, '−');
  bpmMinus.onclick = () => { A.setImportedBreakBpm(cur.id, Math.round(cur.bpm - 1), slotId); A.sealHistory(); };

  const bpmInput = h('input', {
    type: 'number',
    class: 'ruff-ed-bpm-in',
    min: String(BREAK_BPM_RANGE[0]),
    max: String(BREAK_BPM_RANGE[1]),
    step: '0.5',
    value: String(cur.bpm),
    'data-testid': 'ruff-ed-bpm',
    'aria-label': 'Break BPM',
  });
  bpmInput.onchange = () => { A.setImportedBreakBpm(cur.id, Number(bpmInput.value), slotId); A.sealHistory(); };

  const bpmPlus = h('button', { type: 'button', class: 'ruff-ed-step', 'data-testid': 'ruff-ed-bpm-inc', 'aria-label': 'Increase BPM by 1', title: 'BPM +1' }, '+');
  bpmPlus.onclick = () => { A.setImportedBreakBpm(cur.id, Math.round(cur.bpm + 1), slotId); A.sealHistory(); };

  const halfBtn = h('button', {
    type: 'button',
    class: 'ruff-ed-mini' + (ambiguous ? ' hint' : ''),
    'data-testid': 'ruff-ed-half',
    title: 'Half-time interpretation (½× BPM / bars)',
  }, '½×');
  halfBtn.onclick = () => A.scaleImportedBreakTempo(cur.id, 0.5, slotId);

  const dblBtn = h('button', {
    type: 'button',
    class: 'ruff-ed-mini' + (ambiguous ? ' hint' : ''),
    'data-testid': 'ruff-ed-double',
    title: 'Double-time interpretation (2× BPM / bars)',
  }, '2×');
  dblBtn.onclick = () => A.scaleImportedBreakTempo(cur.id, 2, slotId);

  const barsRow = h('div', { class: 'ruff-ed-bars', role: 'group', 'aria-label': 'Break length in bars', 'data-testid': 'ruff-ed-bars' },
    IMPORTED_BREAK_BARS.map(b => {
      const on = cur.bars === b;
      const btn = h('button', {
        type: 'button',
        class: 'ruff-ed-bar' + (on ? ' on' : ''),
        'data-bars': String(b),
        'data-testid': `ruff-ed-bars-${b}`,
        'aria-pressed': String(on),
        title: `Interpret break as ${b} ${b === 1 ? 'bar' : 'bars'}`,
      }, `${b}B`);
      btn.onclick = () => A.setImportedBreakBars(cur.id, b, slotId);
      return btn;
    }));

  const conf = analysis ? analysis.confidence : 'medium';
  const confLabel = isMissing ? 'Missing WAV'
    : cur.unsaved ? 'Not saved'
      : analysis && analysis.fallback ? 'Even fallback'
        : ambiguous ? 'Check ½× / 2×'
          : conf === 'high' ? 'Est. OK' : conf === 'low' ? 'Check BPM' : 'Verify';
  const badge = h('span', {
    class: 'ruff-ed-badge ' + (isMissing || cur.unsaved ? 'warn' : (ambiguous || conf === 'low' || (analysis && analysis.fallback) ? 'caution' : 'ok')),
    'data-testid': 'ruff-ed-confidence',
    title: analysis && analysis.note ? analysis.note : `${cur.bpm} BPM · ${cur.bars} bars`,
  }, confLabel);

  const timingBar = h('div', { class: 'ruff-ed-timing' },
    h('div', { class: 'ruff-ed-bpm-wrap' },
      h('span', { class: 'ruff-ed-lbl' }, 'BPM'),
      bpmMinus, bpmInput, bpmPlus, halfBtn, dblBtn),
    barsRow,
    assignRow,
    badge);

  // 4) Interactive waveform canvas
  const cv = h('canvas', {
    class: 'ruff-wave-cv',
    tabindex: 0,
    role: 'img',
    'data-testid': 'ruff-wave',
    'aria-label': `${cur.name} waveform with ${n} slices. Tap to audition a slice; drag round handles to adjust slice markers.`,
  });
  const waveWrap = h('div', { class: 'ruff-wave' + (isMissing ? ' missing' : '') }, cv);

  // 5) Compact slice editing toolbar
  const sliceInfo = h('span', { class: 'ruff-ed-sinfo', 'data-testid': 'ruff-ed-slice-info' }, sliceSummaryText(cur));

  const nudgeL = h('button', { type: 'button', class: 'ruff-ed-btn', 'data-testid': 'ruff-ed-nudge-l', disabled: selMarker == null, title: 'Nudge selected marker left (−10 ms)' }, '◀');
  nudgeL.onclick = () => A.nudgeImportedBreakSlice(cur.id, -1, store.ui.ruff.editMarker ?? selMarker, slotId);

  const nudgeR = h('button', { type: 'button', class: 'ruff-ed-btn', 'data-testid': 'ruff-ed-nudge-r', disabled: selMarker == null, title: 'Nudge selected marker right (+10 ms)' }, '▶');
  nudgeR.onclick = () => A.nudgeImportedBreakSlice(cur.id, 1, store.ui.ruff.editMarker ?? selMarker, slotId);

  const addBtn = h('button', { type: 'button', class: 'ruff-ed-btn', 'data-testid': 'ruff-ed-add-slice', disabled: n >= MAX_SLICES, title: 'Add slice boundary at cursor (or split selected slice)' }, '+ Slice');
  addBtn.onclick = () => {
    const c = store.ui.ruff.editCursor || 0;
    const tooClose = cur.slices.some(x => Math.abs(x - c) < 0.008);
    A.addImportedBreakSlice(cur.id, tooClose ? null : c, slotId);
  };

  const delBtn = h('button', {
    type: 'button',
    class: 'ruff-ed-btn',
    'data-testid': 'ruff-ed-del-slice',
    disabled: !(selMarker > 0 && selMarker < slices.length - 1),
    title: 'Remove selected inner slice boundary',
  }, '− Del');
  delBtn.onclick = () => A.removeImportedBreakSlice(cur.id, store.ui.ruff.editMarker ?? selMarker, slotId);

  const audSliceBtn = h('button', {
    type: 'button',
    class: 'ruff-ed-btn hear',
    'data-testid': 'ruff-ed-aud-slice',
    disabled: isMissing,
    title: `Audition slice S${selSlice + 1}`,
  }, h('span', { class: 'ruff-ed-i', html: ico('play') }), h('span', {}, `S${selSlice + 1}`));
  audSliceBtn.onclick = () => A.auditionImportedBreak(cur.id, { slice: store.ui.ruff.editSlice || 0, slotId });

  const audLoopBtn = h('button', {
    type: 'button',
    class: 'ruff-ed-btn hear' + (audLoop ? ' on' : ''),
    'data-testid': 'ruff-ed-aud-loop',
    disabled: isMissing,
    'aria-pressed': String(audLoop),
    title: audLoop ? 'Stop break audition' : `Audition full ${cur.bars}-bar break`,
  }, h('span', { class: 'ruff-ed-i', html: ico(audLoop ? 'stop' : 'play') }), h('span', {}, audLoop ? 'Stop' : 'Loop'));
  audLoopBtn.onclick = () => A.auditionImportedBreak(cur.id, { slice: null, slotId });

  const autoBtn = h('button', { type: 'button', class: 'ruff-ed-btn subtle', 'data-testid': 'ruff-ed-auto', disabled: isMissing, title: 'Re-detect transient slices' }, 'Auto');
  autoBtn.onclick = () => A.resetImportedBreakSlices(cur.id, 'auto', slotId);

  const evenBtn = h('button', { type: 'button', class: 'ruff-ed-btn subtle', 'data-testid': 'ruff-ed-even', title: `Reset to ${cur.bars === 1 ? 8 : MAX_SLICES} even grid slices` }, 'Even');
  evenBtn.onclick = () => A.resetImportedBreakSlices(cur.id, 'even', slotId);

  const tools = h('div', { class: 'ruff-ed-tools' },
    sliceInfo,
    h('div', { class: 'ruff-ed-tgrp' }, nudgeL, nudgeR, addBtn, delBtn),
    h('div', { class: 'ruff-ed-tgrp' }, audSliceBtn, audLoopBtn, autoBtn, evenBtn));

  // Optional honest uncertainty / missing / unsaved status strip
  let noteBar = null;
  if (isMissing) {
    const reimp = h('button', { type: 'button', class: 'ruff-ed-btn on', 'data-testid': 'ruff-ed-reimport' }, 'Re-import WAV');
    reimp.onclick = () => onReimport && onReimport();
    noteBar = h('div', { class: 'ruff-ed-note warn', 'data-testid': 'ruff-ed-missing-note' },
      h('span', {}, `Audio file for “${cur.name}” is missing on this device. Metadata and slices are preserved.`),
      reimp);
  } else if (cur.unsaved) {
    const retry = h('button', { type: 'button', class: 'ruff-ed-btn on', 'data-testid': 'ruff-ed-retry-save' }, 'Retry save');
    retry.onclick = () => A.retrySaveSamples();
    noteBar = h('div', { class: 'ruff-ed-note warn', 'data-testid': 'ruff-ed-unsaved-note' },
      h('span', {}, `“${cur.name}” plays in this session, but is NOT saved offline on this device.`),
      retry);
  } else if (analysis && analysis.note) {
    noteBar = h('div', { class: 'ruff-ed-note' + (ambiguous || analysis.fallback || conf === 'low' ? ' caution' : ''), 'data-testid': 'ruff-ed-analysis-note' },
      h('span', {}, analysis.note));
  }

  const panel = h('section', { class: 'ruff-editor', 'data-testid': 'ruff-editor', 'aria-label': 'Imported Break Editor' },
    poolBar,
    timingBar,
    waveWrap,
    tools,
    noteBar);

  if (E && E.ro) E.ro.disconnect();
  E = {
    cv,
    wrap: waveWrap,
    breakId: cur.id,
    slotId,
    drag: null,
    ro: null,
    refs: { sliceInfo, nudgeL, nudgeR, addBtn, delBtn },
  };
  if (typeof ResizeObserver === 'function') {
    E.ro = new ResizeObserver(() => drawRuffWave());
    E.ro.observe(waveWrap);
  }
  bindWave(cv, cur.id, slotId);
  requestAnimationFrame(drawRuffWave);

  return panel;
}
