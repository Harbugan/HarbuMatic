// Canvas sequencer: drum grid + piano roll. One implementation, shared by Standard and
// Expanded JAM (they only differ in how much space and which tools are offered).
//
// Touch model (no hover, no right-click needed):
//   Draw   – tap empty cell/row to add · tap a note to delete · drag a note to move ·
//            drag its right edge to resize · drag across drum cells to paint
//   Erase  – tap or drag over notes/cells
//   Vel/Chance/Slide/Lock – tap a note or drum cell
//   Keys column – tap to hear, drag up/down to scroll · Ruler – drag sideways when zoomed

import { store, pat, typeOf, isDrumSlot, uiTop, uiLastLen } from '../app/store.js';
import { DRUMS, NOTE } from '../core/constants.js';
import { clamp } from '../core/util.js';
import { makeScale } from '../music/theory.js';
import { fixSlides } from '../music/generate.js';
import * as A from '../app/actions.js';

const RV = { cv: null, g: null, W: 0, H: 0, dpr: 1, drag: null, hover: null };
export const playhead = { step: -1, time: 0, scene: -1 };
const LO = 21, HI = 108;

function rowsFor() {
  const p = store.project, sc = makeScale(p.key, p.scale), out = [];
  for (let q = HI; q >= LO; q--) if (!store.ui.fold || sc.inScale(q)) out.push(q);
  return { list: out, sc };
}

export function geo() {
  const u = store.ui, p = pat(), drums = isDrumSlot();
  const coarse = u.coarse;
  const keysW = drums ? (coarse ? 96 : 92) : 54, rulerH = coarse ? 28 : 24;
  const velH = !drums && u.expanded ? 56 : 0;
  const vis = p.len / u.zoom; u.scrollX = clamp(u.scrollX, 0, p.len - vis);
  const stepW = (RV.W - keysW) / vis, gridTop = rulerH, gridBot = RV.H - velH - (velH ? 8 : 0);
  const G = { p, drums, keysW, rulerH, velH, vis, stepW, gridTop, gridBot,
    x: s => keysW + (s - u.scrollX) * stepW, stepAt: x => (x - keysW) / stepW + u.scrollX };
  if (drums) {
    G.rowH = (gridBot - gridTop) / DRUMS.length; G.rows = DRUMS.length;
    G.rowAt = y => clamp(Math.floor((y - gridTop) / G.rowH), 0, DRUMS.length - 1);
    return G;
  }
  const { list, sc } = rowsFor();
  G.rowH = coarse ? 26 : 19;
  G.rows = Math.max(1, Math.floor((gridBot - gridTop) / G.rowH));
  const top = uiTop(u.sel);
  let topIdx = list.indexOf(top);
  if (topIdx < 0) topIdx = list.findIndex(q => q <= top);
  topIdx = clamp(topIdx, 0, Math.max(0, list.length - G.rows));
  u.top[u.sel] = list[topIdx];
  Object.assign(G, { list, sc, topIdx,
    rowPitch: i => list[topIdx + i],
    idxOf: q => { let i = list.indexOf(q); if (i < 0) i = list.findIndex(x => x <= q); return i < 0 ? list.length - 1 : i; },
  });
  G.y = q => gridTop + (G.idxOf(q) - topIdx) * G.rowH;
  G.pitchAt = y => list[clamp(topIdx + Math.floor((y - gridTop) / G.rowH), 0, list.length - 1)];
  return G;
}

/** scroll the piano roll so the current notes are in view */
export function fitView() {
  const u = store.ui; if (isDrumSlot() || !RV.W) return;
  const notes = pat().notes;
  const G = geo();
  const center = notes.length ? notes.reduce((a, n) => a + n.p, 0) / notes.length : typeOf().ui.viewCenter;
  const ci = G.idxOf(Math.round(center));
  const topIdx = clamp(ci - Math.floor(G.rows / 2), 0, Math.max(0, G.list.length - G.rows));
  u.top[u.sel] = G.list[topIdx];
}
export function scrollRows(n) {
  const u = store.ui; if (isDrumSlot()) return;
  const G = geo(); const i = clamp(G.topIdx + n, 0, Math.max(0, G.list.length - G.rows)); u.top[u.sel] = G.list[i]; render();
}
export const octave = dir => scrollRows(-dir * (store.ui.fold ? makeScale(store.project.key, store.project.scale).intervals.length : 12));

export function resize() {
  if (!RV.cv) return;
  const r = RV.cv.getBoundingClientRect(); RV.dpr = window.devicePixelRatio || 1;
  RV.W = r.width; RV.H = r.height;
  RV.cv.width = Math.max(1, Math.round(r.width * RV.dpr)); RV.cv.height = Math.max(1, Math.round(r.height * RV.dpr));
  render();
}

function rr(g, x, y, w, h, r) { r = Math.max(0, Math.min(r, w / 2, h / 2)); g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

export function render() {
  if (!RV.g || !RV.W || !RV.H) return;
  const g = RV.g, G = geo(), u = store.ui, m = typeOf().visual;
  g.setTransform(RV.dpr, 0, 0, RV.dpr, 0, 0);
  g.fillStyle = '#28283F'; g.fillRect(0, 0, RV.W, RV.H);
  const s0 = Math.floor(u.scrollX), s1 = Math.ceil(u.scrollX + G.vis);
  const key = store.project.key;
  if (G.drums) {
    DRUMS.forEach((d, r) => { g.fillStyle = r % 2 ? '#2D2C46' : '#302F4B'; g.fillRect(G.keysW, G.gridTop + r * G.rowH, RV.W - G.keysW, G.rowH); });
  } else {
    for (let i = 0; i < G.rows; i++) {
      const q = G.rowPitch(i); if (q == null) break;
      const y = G.gridTop + i * G.rowH, pcl = ((q - key) % 12 + 12) % 12;
      g.fillStyle = pcl === 0 ? '#3E3A62' : G.sc.inScale(q) ? '#34324F' : '#26253A';
      g.fillRect(G.keysW, y, RV.W - G.keysW, G.rowH);
      g.fillStyle = pcl === 0 ? '#ffffff14' : '#ffffff08'; g.fillRect(G.keysW, y + G.rowH - 1, RV.W - G.keysW, 1);
    }
  }
  for (let s = s0; s <= s1; s++) {
    const x = G.x(s);
    if (s % 8 >= 4 && s < s1) { g.fillStyle = '#ffffff06'; g.fillRect(x, G.gridTop, G.stepW, G.gridBot - G.gridTop); }
    g.fillStyle = s % 16 === 0 ? '#ffffff40' : s % 4 === 0 ? '#ffffff1e' : '#ffffff0a';
    g.fillRect(Math.round(x), G.gridTop, 1, G.gridBot - G.gridTop);
  }
  // chord changes (subtle marks on the ruler)
  const h = store.project.scenes[store.project.scene].harmony;
  g.fillStyle = '#232238'; g.fillRect(G.keysW, 0, RV.W - G.keysW, G.rulerH);
  if (h && !G.drums) {
    const per = h.span / h.degrees.length;
    for (let s = Math.floor(s0 / per) * per; s < s1; s += per) { const x = G.x(s); if (x >= G.keysW) { g.fillStyle = '#C2B0ED55'; g.fillRect(x, G.rulerH - 4, Math.max(2, per * G.stepW - 3), 3); } }
  }
  g.font = '800 11px Nunito, system-ui'; g.textBaseline = 'middle';
  for (let s = s0; s < s1; s++) if (s % 4 === 0) {
    g.fillStyle = s % 16 === 0 ? '#E8E0FF' : '#8A84A8';
    g.fillText(s % 16 === 0 ? String(s / 16 + 1) : `${(s / 16 + 1) | 0}.${(s % 16) / 4 + 1}`, G.x(s) + 5, G.rulerH / 2);
  }
  if (u.zoom > 1) { // scroll indicator
    const w = (RV.W - G.keysW) * (G.vis / G.p.len), x = G.keysW + (RV.W - G.keysW) * (u.scrollX / G.p.len);
    g.fillStyle = '#ffffff22'; rr(g, x + 2, 2, w - 4, 4, 2); g.fill();
  }
  if (G.drums) drawDrums(g, G, m, s0, s1); else drawNotes(g, G, m, s0, s1);
  // keys / labels
  g.fillStyle = '#232238'; g.fillRect(0, 0, G.keysW, RV.H);
  if (G.drums) {
    DRUMS.forEach((d, r) => {
      const y = G.gridTop + r * G.rowH, sel = r === u.drumRow;
      rr(g, 5, y + 3, G.keysW - 10, G.rowH - 6, 9); g.fillStyle = sel ? m.color : '#3A3858'; g.fill();
      g.fillStyle = sel ? '#28283F' : '#D9D2F2'; g.font = `800 ${u.coarse ? 13 : 12}px Nunito, system-ui`; g.fillText(d.name, 14, y + G.rowH / 2 + 1);
      if (G.p.locked[d.id]) { g.fillStyle = sel ? '#28283F' : m.color; g.font = '900 12px Nunito'; g.fillText('🔒︎', G.keysW - 26, y + G.rowH / 2 + 1); }
    });
  } else {
    for (let i = 0; i < G.rows; i++) {
      const q = G.rowPitch(i); if (q == null) break;
      const y = G.gridTop + i * G.rowH, black = [1, 3, 6, 8, 10].includes(q % 12), root = ((q - key) % 12 + 12) % 12 === 0;
      g.fillStyle = root ? m.color : black && !u.fold ? '#4A4565' : '#F6EBDC';
      rr(g, 3, y + 1, G.keysW - (black && !u.fold ? 16 : 6), G.rowH - 2, 4); g.fill();
      if (u.fold || root || q % 12 === 0) {
        g.fillStyle = black && !u.fold ? '#fff' : '#4A3F5C'; g.font = `800 ${u.coarse ? 11 : 9.5}px Nunito, system-ui`;
        g.fillText(NOTE[q % 12] + (Math.floor(q / 12) - 1), 8, y + G.rowH / 2 + .5);
      }
    }
    if (G.velH) {
      const vy = G.gridBot + 8;
      g.fillStyle = '#232238'; g.fillRect(G.keysW, vy, RV.W - G.keysW, G.velH);
      g.fillStyle = '#8A84A8'; g.font = '800 9px Nunito, system-ui'; g.fillText('VEL', 14, vy + G.velH / 2);
      G.p.notes.forEach(n => {
        if (n.s < s0 - 1 || n.s > s1) return;
        const x = G.x(n.s) + 2, hh = (G.velH - 8) * n.v;
        rr(g, x, vy + G.velH - 4 - hh, Math.max(5, Math.min(12, G.stepW * .45)), hh, 3); g.fillStyle = n.locked ? '#fff' : m.color; g.fill();
      });
    }
  }
  // playhead (only when the edited scene is the one being heard)
  const tr = A.transport;
  if (tr.playing && playhead.step >= 0 && playhead.scene === store.project.scene && A.engine.ctx) {
    const frac = clamp((A.engine.ctx.currentTime - playhead.time) / A.engine.stepDur(), 0, 1);
    const pos = (playhead.step % G.p.len) + frac;
    if (u.zoom > 1 && (pos < u.scrollX || pos > u.scrollX + G.vis)) u.scrollX = Math.floor(pos / G.vis) * G.vis;
    const x = G.x(pos);
    if (x >= G.keysW) {
      g.fillStyle = '#F2AFC0'; g.fillRect(x - 1, G.gridTop, 2, G.gridBot - G.gridTop);
      g.fillStyle = '#F2AFC044'; g.fillRect(x - 4, G.gridTop, 8, G.gridBot - G.gridTop);
      g.beginPath(); g.arc(x, G.rulerH / 2, 5, 0, 7); g.fillStyle = '#F2AFC0'; g.fill();
    }
  }
  const empty = G.drums ? !DRUMS.some(d => G.p.steps[d.id].some(Boolean)) : !G.p.notes.length;
  if (empty) {
    g.fillStyle = '#ffffff66'; g.font = `800 ${u.coarse ? 15 : 13}px Nunito, system-ui`; g.textAlign = 'center';
    g.fillText(G.drums ? 'Tap cells to add hits — or press Generate in the Lab' : 'Tap the grid to add notes — or press Generate in the Lab', G.keysW + (RV.W - G.keysW) / 2, G.gridTop + (G.gridBot - G.gridTop) / 2 + (G.drums ? G.rowH / 2 : 0));
    g.textAlign = 'left';
  }
}

function drawNotes(g, G, m, s0, s1) {
  const p = G.p, u = store.ui, topQ = G.rowPitch(0), botQ = G.rowPitch(G.rows - 1) ?? G.list[G.list.length - 1];
  if (typeOf().capabilities.slide) p.notes.forEach(n => {
    if (!n.slide) return; const nx = p.notes.find(q => q.s === (n.s + n.l) % p.len); if (!nx) return;
    const x1 = G.x(n.s + n.l) - 2, y1 = G.y(n.p) + G.rowH / 2, x2 = G.x(nx.s + (nx.s < n.s ? p.len : 0)) + 6, y2 = G.y(nx.p) + G.rowH / 2;
    g.strokeStyle = '#fff'; g.lineWidth = 2.5; g.lineCap = 'round'; g.beginPath(); g.moveTo(x1, y1); g.bezierCurveTo(x1 + 8, y1, x2 - 8, y2, x2, y2); g.stroke();
  });
  p.notes.forEach(n => {
    if (n.p > topQ || n.p < botQ) return;
    const x = G.x(n.s) + 1, y = G.y(n.p) + 1.5, w = n.l * G.stepW - 2, hh = G.rowH - 3;
    if (x + w < G.keysW || x > RV.W) return;
    const off = !G.sc.inScale(n.p);
    rr(g, x, y, w, hh, 6);
    g.globalAlpha = .55 + n.v * .45; g.fillStyle = m.color; g.fill(); g.globalAlpha = 1;
    if (off) { g.strokeStyle = '#F5D19A'; g.lineWidth = 2; g.stroke(); }
    if (n === RV.hover || (RV.drag && RV.drag.n === n)) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke(); }
    g.fillStyle = '#ffffff70'; rr(g, x + 3, y + 2, Math.max(0, w - 6), 3, 2); g.fill();
    if (n.v > .9 && typeOf().capabilities.accent) { g.fillStyle = '#28283F'; g.font = '900 10px Nunito'; g.fillText('!', x + 5, y + hh / 2 + 1); }
    if (n.slice != null) { g.fillStyle = '#28283F'; g.font = '900 10px Nunito'; g.fillText(`S${n.slice + 1}`, x + 4, y + hh / 2 + 1); } // MUNCH slice trigger (edited in SOUND → CHOP)
    if (n.pr != null && n.pr < 1) { g.fillStyle = '#28283F'; g.font = '900 9px Nunito'; if (w > 26) g.fillText(Math.round(n.pr * 100) + '%', x + w - 26, y + hh / 2 + 1); else { g.beginPath(); g.arc(x + w - 6, y + hh / 2, 2.5, 0, 7); g.fill(); } }
    if (n.locked) { g.setLineDash([3, 3]); g.strokeStyle = '#fff'; g.lineWidth = 1.5; rr(g, x - 1, y - 1, w + 2, hh + 2, 7); g.stroke(); g.setLineDash([]); }
    g.fillStyle = '#28283F66'; g.fillRect(x + w - 5, y + 4, 2, hh - 8); // resize grip
  });
}

function drawDrums(g, G, m, s0, s1) {
  const p = G.p;
  DRUMS.forEach((d, r) => {
    const y = G.gridTop + r * G.rowH, locked = p.locked[d.id];
    for (let s = s0; s < s1; s++) {
      const c = p.steps[d.id][s], x = G.x(s), pad = Math.min(4, G.stepW * .12), w = G.stepW - pad * 2, hh = G.rowH - pad * 2;
      rr(g, x + pad, y + pad, w, hh, Math.min(8, w / 3));
      if (!c) { g.fillStyle = s % 4 === 0 ? '#ffffff14' : '#ffffff08'; g.fill(); continue; }
      g.globalAlpha = .45 + c.v * .55; g.fillStyle = m.color; g.fill(); g.globalAlpha = 1;
      if (c.v > .9) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke(); }
      if (locked) { g.setLineDash([3, 3]); g.strokeStyle = '#fff'; g.lineWidth = 1.2; g.stroke(); g.setLineDash([]); }
      g.fillStyle = '#ffffff80'; rr(g, x + pad + 3, y + pad + 3, Math.max(0, w - 6), 3, 2); g.fill();
      if (c.p < 1 && w > 20) { g.fillStyle = '#28283F'; g.font = '900 10px Nunito'; g.textAlign = 'center'; g.fillText(Math.round(c.p * 100) + '%', x + G.stepW / 2, y + G.rowH / 2 + 2); g.textAlign = 'left'; }
      else if (c.p < 1) { g.fillStyle = '#28283F'; g.beginPath(); g.arc(x + G.stepW / 2, y + G.rowH / 2, 2.5, 0, 7); g.fill(); }
    }
  });
}

/* ---------- pointer interaction ---------- */
const posOf = e => { const r = RV.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
const noteAt = (G, fs, q) => [...G.p.notes].reverse().find(n => n.p === q && fs >= n.s && fs < n.s + n.l);
const slop = () => (store.ui.coarse ? 10 : 5);
const edgeZone = (G, n) => { const w = n.l * G.stepW; const z = Math.max(store.ui.coarse ? 16 : 9, G.stepW * .3); return w < z * 2.2 ? w * .4 : z; };
const cycle = (v, list) => { const i = list.findIndex(x => Math.abs(x - v) < .02); return list[(i + 1) % list.length]; };

function down(e) {
  if (RV.drag && RV.drag.id !== e.pointerId) return; // ignore second finger
  A.engine.init();
  const { x, y } = posOf(e), G = geo(), u = store.ui, tool = u.tool;
  try { RV.cv.setPointerCapture(e.pointerId); } catch (er) { /* synthetic */ }
  const base = { id: e.pointerId, sx: x, sy: y, moved: false };
  if (e.button === 2) { RV.drag = null; return; }
  if (y < G.rulerH) { if (u.zoom > 1) RV.drag = { ...base, type: 'scrollX', start: u.scrollX }; return; }
  if (G.drums) {
    const row = G.rowAt(y), id = DRUMS[row].id;
    // keep the drum id apart from base.id (the pointerId): overwriting it left the drag stuck (BUG-001)
    if (x < G.keysW) { RV.drag = { ...base, type: 'drumKey', row, drum: id }; return; }
    const s = Math.floor(G.stepAt(x)); if (s < 0 || s >= G.p.len) return;
    const cell = G.p.steps[id][s]; u.drumRow = row;
    A.checkpoint();
    if (tool === 'lock') { G.p.locked[id] = !G.p.locked[id]; done(); A.patternEdited(); return; }
    if (tool === 'vel') { G.p.steps[id][s] = cell ? { ...cell, v: cycle(cell.v > .9 ? 1 : cell.v > .6 ? .75 : .45, [.45, .75, 1]) } : { v: .75, p: 1 }; A.engine.audition(u.sel, id, G.p.steps[id][s].v); A.patternEdited(); return; }
    if (tool === 'prob') { G.p.steps[id][s] = cell ? { ...cell, p: cycle(cell.p, [1, .75, .5, .25]) } : { v: .75, p: .75 }; A.patternEdited(); return; }
    const val = tool === 'erase' ? false : !cell;
    G.p.steps[id][s] = val ? { v: .8, p: 1 } : null;
    if (val) A.engine.audition(u.sel, id, .8);
    RV.drag = { ...base, type: 'paint', val };
    A.patternEdited(); return;
  }
  if (x < G.keysW && y < G.gridBot) { RV.drag = { ...base, type: 'keys', startIdx: G.topIdx, q: G.pitchAt(y) }; return; }
  if (y > G.gridBot) { if (G.velH) { A.checkpoint('vel-lane'); RV.drag = { ...base, type: 'vel' }; setVelAt(G, x, y); } return; }
  const fs = G.stepAt(x), q = G.pitchAt(y), s = Math.floor(fs);
  if (s < 0 || s >= G.p.len) return;
  const hit = noteAt(G, fs, q);
  if (tool === 'erase') { A.checkpoint(); if (hit) G.p.notes.splice(G.p.notes.indexOf(hit), 1); RV.drag = { ...base, type: 'erase' }; A.patternEdited(); return; }
  if (tool === 'lock') { if (hit) { A.checkpoint(); hit.locked = !hit.locked; A.patternEdited(); } return; }
  if (tool === 'slide') { if (hit) { A.checkpoint(); hit.slide = !hit.slide; fixSlides(G.p.notes, G.p.len); if (hit.slide && !G.p.notes.some(m => m.s === (hit.s + hit.l) % G.p.len)) A.toastMsg('Add a note right after it to slide into'); A.patternEdited(); } return; }
  if (tool === 'vel') { if (hit) { A.checkpoint(); hit.v = cycle(hit.v > .9 ? 1 : hit.v > .6 ? .75 : .45, [.45, .75, 1]); A.engine.audition(u.sel, hit.p, hit.v); A.patternEdited(); } return; }
  if (tool === 'prob') { if (hit) { A.checkpoint(); const nv = cycle(hit.pr ?? 1, [1, .75, .5, .25]); if (nv >= 1) delete hit.pr; else hit.pr = nv; A.patternEdited(); } return; }
  // draw
  if (hit) {
    const edge = G.x(hit.s + hit.l) - x < edgeZone(G, hit);
    RV.drag = { ...base, type: edge ? 'resize' : 'move', pending: true, n: hit, off: fs - hit.s, origS: hit.s, origP: hit.p };
    if (!edge) A.engine.audition(u.sel, hit.p, hit.v);
  } else {
    A.checkpoint();
    const n = { s, p: q, l: Math.min(uiLastLen(u.sel), G.p.len - s), v: .8 };
    G.p.notes.push(n); A.engine.audition(u.sel, q);
    RV.drag = { ...base, type: 'resize', n, fresh: true };
    A.patternEdited();
  }
  render();
}
function setVelAt(G, x, y) {
  const s = Math.floor(G.stepAt(x)), v = clamp(1 - (y - G.gridBot - 12) / (G.velH - 8), .05, 1);
  G.p.notes.forEach(n => { if (n.s === s) n.v = v; }); render();
}
function move(e) {
  const { x, y } = posOf(e), d = RV.drag;
  const G = geo();
  if (!d) { // hover feedback (mouse only)
    if (e.pointerType !== 'mouse' || G.drums) return;
    const hit = y > G.gridTop && y < G.gridBot && x > G.keysW ? noteAt(G, G.stepAt(x), G.pitchAt(y)) : null;
    if (hit !== RV.hover) { RV.hover = hit; if (!A.transport.playing) render(); }
    RV.cv.style.cursor = hit ? (G.x(hit.s + hit.l) - x < edgeZone(G, hit) ? 'ew-resize' : 'grab') : x < G.keysW ? 'ns-resize' : 'crosshair';
    return;
  }
  if (d.id !== e.pointerId) return;
  if (!d.moved && Math.hypot(x - d.sx, y - d.sy) > slop()) {
    d.moved = true;
    if (d.pending) { A.checkpoint(); d.pending = false; }
  }
  if (!d.moved) return;
  if (d.type === 'scrollX') { store.ui.scrollX = clamp(d.start - (x - d.sx) / G.stepW, 0, G.p.len - G.vis); render(); return; }
  if (d.type === 'keys') { const i = clamp(d.startIdx - Math.round((y - d.sy) / G.rowH), 0, Math.max(0, G.list.length - G.rows)); store.ui.top[store.ui.sel] = G.list[i]; render(); return; }
  if (d.type === 'drumKey') return;
  if (G.drums && d.type === 'paint') {
    const row = G.rowAt(y), s = Math.floor(G.stepAt(x));
    if (s >= 0 && s < G.p.len) { const id = DRUMS[row].id; if (!!G.p.steps[id][s] !== d.val) { G.p.steps[id][s] = d.val ? { v: .8, p: 1 } : null; render(); } }
    return;
  }
  if (d.type === 'vel') return setVelAt(G, x, y);
  const fs = G.stepAt(x);
  if (d.type === 'erase') { const hit = noteAt(G, fs, G.pitchAt(y)); if (hit) { G.p.notes.splice(G.p.notes.indexOf(hit), 1); render(); } return; }
  if (d.type === 'resize') { const l = clamp(Math.ceil(fs - d.n.s), 1, G.p.len - d.n.s); if (l !== d.n.l) { d.n.l = l; store.ui.lastLen[store.ui.sel] = l; render(); } return; }
  if (d.type === 'move') {
    const ns = clamp(Math.round(fs - d.off), 0, G.p.len - d.n.l), nq = G.pitchAt(y);
    if (ns !== d.n.s || nq !== d.n.p) { d.n.s = ns; if (nq !== d.n.p) { d.n.p = nq; A.engine.audition(store.ui.sel, nq, d.n.v); } render(); }
  }
}
function up(e) {
  const d = RV.drag; if (!d || d.id !== e.pointerId) return;
  RV.drag = null;
  const G = geo(), u = store.ui;
  if (!d.moved) {
    if (d.type === 'keys') { A.engine.audition(u.sel, d.q); return; }
    if (d.type === 'drumKey') {
      u.drumRow = d.row;
      if (u.tool === 'lock') { A.checkpoint(); G.p.locked[d.drum] = !G.p.locked[d.drum]; A.patternEdited(); }
      A.engine.audition(u.sel, d.drum, .9); render(); return;
    }
    if (d.pending && d.type === 'move') { A.checkpoint(); G.p.notes.splice(G.p.notes.indexOf(d.n), 1); A.patternEdited(); return; } // tap = delete
  }
  if (d.type === 'scrollX' || d.type === 'keys' || d.type === 'drumKey') return;
  if (typeOf().capabilities.slide) fixSlides(G.p.notes, G.p.len);
  A.sealHistory();
  done();
  A.patternEdited();
}
function cancel(e) { if (RV.drag && RV.drag.id === e.pointerId) { RV.drag = null; A.sealHistory(); A.patternEdited(); } }
function done() { RV.hover = null; }
function wheel(e) {
  e.preventDefault(); const G = geo(), u = store.ui;
  if (e.ctrlKey || e.metaKey) { const z = e.deltaY < 0 ? Math.min(4, u.zoom * 2) : Math.max(1, u.zoom / 2); if (G.p.len / z >= 8) { u.zoom = z; A.emitTool(); } }
  else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) u.scrollX = clamp(u.scrollX + Math.sign(e.deltaX || e.deltaY) * 2, 0, G.p.len - G.vis);
  else if (!G.drums) { scrollRows(Math.sign(e.deltaY) * 2); return; }
  render();
}

export function mount(canvas) {
  RV.cv = canvas; RV.g = canvas.getContext('2d');
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', cancel);
  canvas.addEventListener('lostpointercapture', cancel); // safety net: never leave a gesture stuck
  canvas.addEventListener('pointerleave', () => { if (!RV.drag && RV.hover) { RV.hover = null; render(); } });
  canvas.addEventListener('wheel', wheel, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  // desktop extra: right-click / double-click deletes a note
  canvas.addEventListener('mousedown', e => {
    if (e.button !== 2) return;
    const { x, y } = posOf(e), G = geo();
    if (G.drums) { const s = Math.floor(G.stepAt(x)), id = DRUMS[G.rowAt(y)].id; if (s >= 0 && s < G.p.len && G.p.steps[id][s]) { A.checkpoint(); G.p.steps[id][s] = null; A.patternEdited(); } return; }
    const hit = noteAt(G, G.stepAt(x), G.pitchAt(y)); if (hit) { A.checkpoint(); G.p.notes.splice(G.p.notes.indexOf(hit), 1); A.patternEdited(); }
  });
  new ResizeObserver(() => resize()).observe(canvas.parentElement);
}
