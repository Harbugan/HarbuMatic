// Touch-first controls: knob, segmented control, switch, toast, modal dialog.

import { h, $ } from './dom.js';
import { clamp } from '../core/util.js';

/**
 * Knob: drag up/right to increase (finger-friendly: both axes count), wheel, arrow keys.
 * Double-tap / double-click resets to default. Calls onStart once per gesture (for history).
 */
export function Knob({ label, min = 0, max = 1, value, def, size = '', color, fmt, onStart, onChange, onEnd, step = 0, title }) {
  def = def ?? value;
  const el = h('div', { class: 'knob ' + size, tabindex: 0, role: 'slider', 'aria-label': label, 'aria-valuemin': min, 'aria-valuemax': max, title: title || `${label} — drag, double-tap to reset` });
  if (color) el.style.setProperty('--kc', color);
  const dial = h('div', { class: 'dial', html: `<svg class="ring" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="none" stroke="#00000014" stroke-width="2.6" pathLength="100" stroke-dasharray="75 100" stroke-linecap="round"/><circle class="arc" cx="20" cy="20" r="18" fill="none" stroke="var(--kc)" stroke-width="2.6" pathLength="100" stroke-dasharray="0 100" stroke-linecap="round"/></svg><div class="cap"><i class="tick"></i></div>` });
  const lbl = h('div', { class: 'klbl' }, label), val = h('div', { class: 'kval' });
  el.append(dial, lbl, val);
  const cap = dial.querySelector('.cap'), arc = dial.querySelector('.arc');
  const f = fmt || (v => Math.round((v - min) / (max - min) * 100) + '%');
  let v = value;
  const draw = () => {
    const n = (v - min) / (max - min);
    cap.style.transform = `rotate(${-135 + 270 * n}deg)`;
    arc.setAttribute('stroke-dasharray', `${(75 * n).toFixed(2)} 100`);
    val.textContent = f(v);
    el.setAttribute('aria-valuenow', (+v).toFixed(2)); el.setAttribute('aria-valuetext', f(v));
  };
  const setV = (nv, fire = true) => { nv = clamp(nv, min, max); if (step) nv = Math.round(nv / step) * step; if (nv === v) return; v = nv; draw(); if (fire && onChange) onChange(v); };
  let sx = 0, sy = 0, sv = 0, drag = null, lastTap = 0;
  el.addEventListener('pointerdown', e => {
    e.preventDefault(); el.focus({ preventScroll: true });
    const now = performance.now();
    if (now - lastTap < 320) { onStart && onStart(); setV(def); onEnd && onEnd(); lastTap = 0; return; }
    lastTap = now;
    try { el.setPointerCapture(e.pointerId); } catch (er) { /* synthetic */ }
    sx = e.clientX; sy = e.clientY; sv = v; drag = e.pointerId; el.classList.add('active');
    onStart && onStart();
  });
  el.addEventListener('pointermove', e => {
    if (drag !== e.pointerId) return;
    const d = (sy - e.clientY) + (e.clientX - sx) * .6;
    setV(sv + d / (e.shiftKey ? 700 : 170) * (max - min));
  });
  const end = e => { if (drag !== e.pointerId) return; drag = null; el.classList.remove('active'); onEnd && onEnd(); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('wheel', e => { e.preventDefault(); onStart && onStart(); setV(v - Math.sign(e.deltaY) * (step || (max - min) / 50)); onEnd && onEnd(); }, { passive: false });
  el.addEventListener('keydown', e => {
    const d = step || (max - min) / 50;
    if (['ArrowUp', 'ArrowRight'].includes(e.key)) { onStart && onStart(); setV(v + d); e.preventDefault(); e.stopPropagation(); }
    if (['ArrowDown', 'ArrowLeft'].includes(e.key)) { onStart && onStart(); setV(v - d); e.preventDefault(); e.stopPropagation(); }
  });
  draw();
  return { el, set: nv => { v = clamp(nv, min, max); draw(); }, get value() { return v; } };
}

/** segmented control: opts = [[value, label], ...] */
export function Seg(opts, cur, onPick, { cls = '', label } = {}) {
  const s = h('div', { class: 'seg ' + cls, role: 'radiogroup', 'aria-label': label || null });
  opts.forEach(([val, lbl, dis]) => {
    const b = h('button', { type: 'button', class: val === cur ? 'on' : '', role: 'radio', 'aria-checked': String(val === cur), disabled: !!dis });
    if (typeof lbl === 'string') b.textContent = lbl; else b.append(lbl);
    b.onclick = () => { [...s.children].forEach(x => { x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); }); b.classList.add('on'); b.setAttribute('aria-checked', 'true'); onPick(val); };
    s.append(b);
  });
  return s;
}

export function Switch(label, on, onToggle, title) {
  const b = h('button', { type: 'button', class: 'switch' + (on ? ' on' : ''), role: 'switch', 'aria-checked': String(!!on), title: title || label }, h('i'), h('span', {}, label));
  b.onclick = () => { const v = !b.classList.contains('on'); b.classList.toggle('on', v); b.setAttribute('aria-checked', String(v)); onToggle(v); };
  return b;
}

let toastT = 0;
export function toast(msg) {
  const t = $('#toast'); if (!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800);
}

/* ---------- modal dialog ---------- */
let openDlg = null;
export function closeDialog() { if (!openDlg) return; const d = openDlg; openDlg = null; d.remove(); $('#scrim').classList.remove('show', 'modal'); }
export const dialogOpen = () => !!openDlg;
/**
 * dialog({ title, body: Node|string, actions: [{ label, primary, danger, onClick → false keeps open }] })
 */
export function dialog({ title, body, actions = [], cls = '' }) {
  closeDialog();
  const box = h('div', { class: 'dialog ' + cls, role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  box.append(h('h3', {}, title));
  if (body) box.append(typeof body === 'string' ? h('p', { class: 'dlg-text' }, body) : body);
  if (actions.length) {
    const row = h('div', { class: 'dlg-actions' });
    actions.forEach(a => {
      const b = h('button', { type: 'button', class: 'dbtn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : '') }, a.label);
      b.onclick = () => { if (a.onClick && a.onClick() === false) return; closeDialog(); };
      row.append(b);
    });
    box.append(row);
  }
  document.body.append(box);
  $('#scrim').classList.add('show', 'modal');
  openDlg = box;
  const first = box.querySelector('input, .dbtn.primary, .dbtn');
  if (first) setTimeout(() => first.focus(), 30);
  return box;
}
export function confirmDialog(title, text, okLabel, onOk, { danger = false } = {}) {
  dialog({ title, body: text, actions: [{ label: 'Cancel' }, { label: okLabel, primary: !danger, danger, onClick: onOk }] });
}
export function promptDialog(title, value, okLabel, onOk, { placeholder = '', maxlength = 40 } = {}) {
  const inp = h('input', { class: 'dlg-input', value: value || '', placeholder, maxlength, 'aria-label': title });
  const body = h('div', {}, inp);
  inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { onOk(inp.value); closeDialog(); } });
  dialog({ title, body, actions: [{ label: 'Cancel' }, { label: okLabel, primary: true, onClick: () => onOk(inp.value) }] });
  setTimeout(() => { inp.focus(); inp.select(); }, 40);
}
