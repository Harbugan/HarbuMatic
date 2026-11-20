// Minimal DOM helpers (no framework).

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/** h('button', { class: 'x', onclick: fn }, 'label', childNode) */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
}

/** a button with an icon and a visible label (touch-friendly, no hover needed) */
export function btn({ icon, label, cls = '', title, onClick, pressed, disabled }) {
  const b = h('button', { class: 'btn ' + cls, type: 'button', title: title || label, 'aria-label': label || title, 'aria-pressed': pressed == null ? null : String(!!pressed), disabled: !!disabled });
  if (icon) b.insertAdjacentHTML('beforeend', icon);
  if (label) b.append(h('span', { class: 'btn-l' }, label));
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/** pointer "tap" that tolerates small finger movement and ignores drags */
export function onTap(el, fn, { slop = 10 } = {}) {
  let sx = 0, sy = 0, id = null;
  el.addEventListener('pointerdown', e => { id = e.pointerId; sx = e.clientX; sy = e.clientY; });
  el.addEventListener('pointerup', e => { if (e.pointerId === id && Math.hypot(e.clientX - sx, e.clientY - sy) < slop) fn(e); id = null; });
  el.addEventListener('pointercancel', () => { id = null; });
}
