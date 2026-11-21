// The band: BOP, GOO, BLIP, FUZZ (cats in headphones) and UNI the unicorn.
// SVG artwork and reactions are unchanged from v0.4. Characters are chosen by the instrument type's
// `visual.character` and coloured from the registry; reactions are registered per slot id.

import { getInstrumentType } from '../core/instruments.js';
import { h } from './dom.js';
import { store } from '../app/store.js';

const INK = '#4A3F5C';
export const STAR = 'M0 -6 L1.7 -1.7 L6 0 L1.7 1.7 L0 6 L-1.7 1.7 L-6 0 L-1.7 -1.7Z';
const rand = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];

function phones(band, l, r, c) {
  return `<path d="${band}" fill="none" stroke="${INK}" stroke-width="8.5" stroke-linecap="round"/>
  <path d="${band}" fill="none" stroke="${c}" stroke-width="4" stroke-linecap="round"/>
  <rect x="${l[0]}" y="${l[1]}" width="16" height="26" rx="8" fill="${c}" stroke="${INK}" stroke-width="2.5"/>
  <rect x="${l[0] + 3.5}" y="${l[1] + 4}" width="3.5" height="10" rx="1.75" fill="#fff" opacity=".65"/>
  <rect x="${r[0]}" y="${r[1]}" width="16" height="26" rx="8" fill="${c}" stroke="${INK}" stroke-width="2.5"/>
  <rect x="${r[0] + 9}" y="${r[1] + 4}" width="3.5" height="10" rx="1.75" fill="#fff" opacity=".65"/>`;
}
function eyePair(x1, x2, y, rx = 4, ry = 5) {
  return `<g class="eyes"><ellipse cx="${x1}" cy="${y}" rx="${rx}" ry="${ry}" fill="${INK}"/><ellipse cx="${x2}" cy="${y}" rx="${rx}" ry="${ry}" fill="${INK}"/>
  <circle cx="${x1 + 1.4}" cy="${y - 1.8}" r="1.5" fill="#fff"/><circle cx="${x2 + 1.4}" cy="${y - 1.8}" r="1.5" fill="#fff"/></g>`;
}
/** character artwork for an instrument type ('bop', 'goo', …) */
export function catSVG(type) {
  const v = getInstrumentType(type).visual, tr = v.character, C = v.color, D = v.dark, hp = v.headphones, st = `stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"`;
  const shadow = `<ellipse cx="60" cy="105" rx="30" ry="4" fill="#5a3f4f" opacity=".13"/>`;
  let body = '';
  if (tr === 'bop') body = `
    <path d="M80 94 Q97 92 94 76" fill="none" stroke="${INK}" stroke-width="8" stroke-linecap="round"/><path d="M80 94 Q97 92 94 76" fill="none" stroke="${C}" stroke-width="3.5" stroke-linecap="round"/>
    <path d="M40 101 Q38 80 60 78 Q82 80 80 101 Z" fill="${C}" ${st}/>
    <ellipse cx="50" cy="101" rx="7" ry="4" fill="${C}" ${st}/><ellipse cx="70" cy="101" rx="7" ry="4" fill="${C}" ${st}/>
    <path d="M27 46 L29 13 L53 30 Z" fill="${C}" ${st}/><path d="M33 37 L34 22 L45 30Z" fill="${D}" opacity=".55"/>
    <path d="M93 46 L91 13 L67 30 Z" fill="${C}" ${st}/><path d="M87 37 L86 22 L75 30Z" fill="${D}" opacity=".55"/>
    <ellipse cx="60" cy="53" rx="36" ry="29" fill="${C}" ${st}/>
    ${phones('M23 52 Q20 9 60 9 Q100 9 97 52', [14, 40], [90, 40], hp)}
    ${eyePair(47, 73, 54)}
    <g class="eyes-alt"><path d="M42 56 Q47 49 52 56" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M68 56 Q73 49 78 56" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round"/></g>
    <ellipse cx="38" cy="63" rx="5.5" ry="3.2" fill="${D}" opacity=".55"/><ellipse cx="82" cy="63" rx="5.5" ry="3.2" fill="${D}" opacity=".55"/>
    <path d="M54 62 Q57 66.5 60 62 Q63 66.5 66 62" stroke="${INK}" stroke-width="2.3" fill="none" stroke-linecap="round"/>`;
  if (tr === 'goo') body = `
    <path d="M100 90 Q118 88 114 72 Q111 62 104 67" fill="none" stroke="${INK}" stroke-width="8" stroke-linecap="round"/><path d="M100 90 Q118 88 114 72 Q111 62 104 67" fill="none" stroke="${C}" stroke-width="3.5" stroke-linecap="round"/>
    <path d="M33 44 Q28 22 47 32 Z" fill="${C}" ${st}/><path d="M87 44 Q92 22 73 32 Z" fill="${C}" ${st}/>
    <path d="M16 97 Q7 64 27 46 Q41 32 60 32 Q79 32 93 46 Q113 64 104 97 Q60 107 16 97Z" fill="${C}" ${st}/>
    <path d="M34 92 Q60 99 86 92" fill="none" stroke="${D}" stroke-width="3" opacity=".5" stroke-linecap="round"/>
    ${phones('M21 66 Q17 22 60 22 Q103 22 99 66', [10, 54], [94, 54], hp)}
    ${eyePair(47, 73, 62, 3.6, 4.6)}
    <path d="M41 55 L52 57" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/><path d="M79 55 L68 57" stroke="${INK}" stroke-width="2.4" stroke-linecap="round" class="brow"/>
    <g class="eyes-alt"><path d="M43 58 L50 62 L43 66" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M77 58 L70 62 L77 66" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>
    <ellipse cx="37" cy="72" rx="5.5" ry="3" fill="${D}" opacity=".55"/><ellipse cx="83" cy="72" rx="5.5" ry="3" fill="${D}" opacity=".55"/>
    <path d="M57.5 73 Q60 80 62.5 73 Z" fill="#F49AB2" stroke="${INK}" stroke-width="1.8"/>
    <path d="M54 70 Q57 74.5 60 70 Q63 74.5 66 70" stroke="${INK}" stroke-width="2.3" fill="none" stroke-linecap="round"/>`;
  if (tr === 'blip') body = `
    <path d="M44 101 Q42 84 60 82 Q78 84 76 101 Z" fill="${C}" ${st}/>
    <ellipse cx="52" cy="101" rx="6" ry="3.6" fill="${C}" ${st}/><ellipse cx="68" cy="101" rx="6" ry="3.6" fill="${C}" ${st}/>
    <path d="M27 50 Q14 2 54 28 Z" fill="${C}" ${st}/><path d="M32 41 Q26 17 46 30Z" fill="${D}" opacity=".5"/>
    <path d="M93 50 Q106 2 66 28 Z" fill="${C}" ${st}/><path d="M88 41 Q94 17 74 30Z" fill="${D}" opacity=".5"/>
    <ellipse cx="60" cy="57" rx="35" ry="28" fill="${C}" ${st}/>
    <path d="M60 15 L60 3" stroke="${INK}" stroke-width="2.5"/>
    <path d="${STAR}" transform="translate(60 1) scale(1.15)" fill="#F5D19A" stroke="${INK}" stroke-width="2"/>
    ${phones('M24 56 Q21 15 60 15 Q99 15 96 56', [15, 44], [89, 44], hp)}
    <g class="eyes"><ellipse cx="47" cy="58" rx="5.5" ry="6.5" fill="${INK}"/><ellipse cx="73" cy="58" rx="5.5" ry="6.5" fill="${INK}"/>
      <circle cx="49" cy="55.5" r="2.1" fill="#fff"/><circle cx="75" cy="55.5" r="2.1" fill="#fff"/><circle cx="45.5" cy="60.5" r="1" fill="#fff"/><circle cx="71.5" cy="60.5" r="1" fill="#fff"/></g>
    <g class="eyes-alt"><path d="M42 58 Q47 63 52 58" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M68 58 Q73 63 78 58" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round"/></g>
    <ellipse cx="38" cy="68" rx="5" ry="3" fill="${D}" opacity=".55"/><ellipse cx="82" cy="68" rx="5" ry="3" fill="${D}" opacity=".55"/>
    <ellipse cx="60" cy="69" rx="2.6" ry="3" fill="${INK}"/>`;
  if (tr === 'fuzz') {
    const cs = [[60, 54, 29], [35, 50, 13], [85, 50, 13], [43, 33, 12], [60, 28, 13], [77, 33, 12], [34, 66, 11], [86, 66, 11], [47, 77, 11], [73, 77, 11], [60, 80, 10]];
    body = `
    <path d="M38 30 L37 12 L52 24Z" fill="${C}" ${st}/><path d="M82 30 L83 12 L68 24Z" fill="${C}" ${st}/>
    ${cs.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r + 2.5}" fill="${INK}"/>`).join('')}
    ${cs.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${C}"/>`).join('')}
    <ellipse cx="52" cy="94" rx="6" ry="4" fill="${C}" ${st}/><ellipse cx="68" cy="94" rx="6" ry="4" fill="${C}" ${st}/>
    ${phones('M22 54 Q19 10 60 10 Q101 10 98 54', [12, 42], [92, 42], hp)}
    <g class="eyes"><path d="M42 55 Q47 59 52 55" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M68 55 Q73 59 78 55" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round"/></g>
    <g class="eyes-alt"><circle cx="47" cy="55" r="3.6" fill="${INK}"/><circle cx="73" cy="55" r="3.6" fill="${INK}"/><circle cx="48" cy="53.6" r="1.2" fill="#fff"/><circle cx="74" cy="53.6" r="1.2" fill="#fff"/></g>
    <ellipse cx="39" cy="64" rx="5" ry="3" fill="${D}" opacity=".6"/><ellipse cx="81" cy="64" rx="5" ry="3" fill="${D}" opacity=".6"/>
    <path d="M56.5 63 Q60 66 63.5 63" stroke="${INK}" stroke-width="2.3" fill="none" stroke-linecap="round"/>
    <g class="zz" opacity=".55" stroke="${INK}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M100 12 h7 l-7 8 h7"/><path d="M110 2 h5 l-5 6 h5"/></g>`;
  }
  // MUNCH: a round sound-eater with a big mouth and headphones. Face variants (shown by the MUNCH workspace through
  // data-face on an ancestor): idle eyes, .eyes-alt happy arcs (also used by .joy), .f-wow star eyes, .f-oops x eyes,
  // .f-listen wide eyes; the mouth group animates for chomps.
  if (tr === 'munch') body = `
    <ellipse cx="49" cy="101" rx="7" ry="4" fill="${C}" ${st}/><ellipse cx="71" cy="101" rx="7" ry="4" fill="${C}" ${st}/>
    <path d="M38 34 Q36 16 52 27 Z" fill="${C}" ${st}/><path d="M82 34 Q84 16 68 27 Z" fill="${C}" ${st}/>
    <ellipse cx="60" cy="61" rx="38" ry="37" fill="${C}" ${st}/>
    <path d="M30 78 Q60 96 90 78" fill="none" stroke="${D}" stroke-width="3" opacity=".35" stroke-linecap="round"/>
    ${phones('M22 60 Q19 17 60 17 Q101 17 98 60', [12, 48], [92, 48], hp)}
    ${eyePair(47, 73, 48, 3.8, 4.8)}
    <g class="eyes-alt"><path d="M42 50 Q47 44 52 50" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M68 50 Q73 44 78 50" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round"/></g>
    <g class="f-wow" fill="#F5D19A" stroke="${INK}" stroke-width="1.6"><path d="${STAR}" transform="translate(47 48) scale(1.05)"/><path d="${STAR}" transform="translate(73 48) scale(1.05)"/></g>
    <g class="f-oops" stroke="${INK}" stroke-width="3" stroke-linecap="round"><path d="M43 44 L51 52 M51 44 L43 52"/><path d="M69 44 L77 52 M77 44 L69 52"/><path d="M86 30 q4 6 0 9 q-4 -3 0 -9z" fill="#9FD6EE" stroke-width="1.5"/></g>
    <g class="f-listen"><circle cx="47" cy="48" r="6" fill="#fff" stroke="${INK}" stroke-width="2.4"/><circle cx="73" cy="48" r="6" fill="#fff" stroke="${INK}" stroke-width="2.4"/><circle cx="48" cy="47" r="3" fill="${INK}"/><circle cx="74" cy="47" r="3" fill="${INK}"/></g>
    <ellipse cx="36" cy="60" rx="5" ry="3" fill="${D}" opacity=".55"/><ellipse cx="84" cy="60" rx="5" ry="3" fill="${D}" opacity=".55"/>
    <g class="mouth">
      <path d="M42 64 Q60 60 78 64 Q76 88 60 89 Q44 88 42 64 Z" fill="${INK}"/>
      <path d="M49 82 Q60 74 71 82 Q66 88 60 88 Q54 88 49 82 Z" fill="#F49AB2"/>
      <path d="M47 63.6 L50 69 L53 62.8 Z M67 62.8 L70 69 L73 63.6 Z" fill="#fff"/>
    </g>`;
  return `<svg viewBox="0 0 120 110" aria-hidden="true">${shadow}<g class="rig">${body}</g></svg>`;
}

export function uniSVG() {
  const st = `stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"`, W = '#FFF7F3';
  return `<svg viewBox="0 0 120 110" aria-hidden="true"><ellipse cx="60" cy="105" rx="30" ry="4" fill="#5a3f4f" opacity=".13"/>
  <g class="rig">
    <circle cx="27" cy="78" r="8" fill="#F2AFC0" ${st}/><circle cx="20" cy="89" r="7" fill="#C2B0ED" ${st}/><circle cx="28" cy="97" r="6" fill="#A5DFCE" ${st}/>
    <rect x="42" y="88" width="10" height="15" rx="5" fill="${W}" ${st}/><rect x="66" y="88" width="10" height="15" rx="5" fill="${W}" ${st}/>
    <path d="M42 99 h10 v2 a3 3 0 0 1 -3 3 h-4 a3 3 0 0 1 -3 -3z" fill="#C2B0ED"/><path d="M66 99 h10 v2 a3 3 0 0 1 -3 3 h-4 a3 3 0 0 1 -3 -3z" fill="#C2B0ED"/>
    <ellipse cx="58" cy="84" rx="27" ry="15" fill="${W}" ${st}/>
    <path d="M47 32 L44 14 L59 27Z" fill="${W}" ${st}/><path d="M48 28 L47 20 L54 26Z" fill="#F2AFC0"/>
    <path d="M66 28 L73 2 L78 30Z" fill="#F5D19A" ${st}/><path d="M68.5 20 L76 17 M67.5 25 L77 22 M70 13 L74.5 11" stroke="#C9973F" stroke-width="1.8"/>
    <ellipse cx="63" cy="51" rx="27" ry="23" fill="${W}" ${st}/>
    <ellipse cx="75" cy="61" rx="13" ry="10" fill="#FFE3EC" ${st}/>
    <circle cx="71" cy="61" r="1.4" fill="${INK}"/><circle cx="79" cy="61" r="1.4" fill="${INK}"/>
    <circle cx="44" cy="33" r="9" fill="#F2AFC0" ${st}/><circle cx="37" cy="45" r="9" fill="#C2B0ED" ${st}/><circle cx="37" cy="59" r="8" fill="#A5DFCE" ${st}/><circle cx="54" cy="28" r="7.5" fill="#F5D19A" ${st}/>
    <g class="face f-idle"><ellipse cx="57" cy="48" rx="3.4" ry="4.4" fill="${INK}"/><ellipse cx="75" cy="46" rx="3.4" ry="4.4" fill="${INK}"/><circle cx="58.3" cy="46.4" r="1.3" fill="#fff"/><circle cx="76.3" cy="44.4" r="1.3" fill="#fff"/></g>
    <g class="face f-happy" stroke="${INK}" stroke-width="2.8" fill="none" stroke-linecap="round"><path d="M53 49 Q57 43 61 49"/><path d="M71 47 Q75 41 79 47"/></g>
    <g class="face f-wow" fill="#F5D19A" stroke="${INK}" stroke-width="1.6"><path d="${STAR}" transform="translate(57 48)"/><path d="${STAR}" transform="translate(75 46)"/></g>
    <g class="face f-dizzy" stroke="${INK}" stroke-width="2" fill="none" stroke-linecap="round"><path d="M57 48 m-4 0 a4 4 0 1 0 4 -4 a2.5 2.5 0 1 0 2 2.5"/><path d="M75 46 m-4 0 a4 4 0 1 0 4 -4 a2.5 2.5 0 1 0 2 2.5"/></g>
    <ellipse cx="51" cy="58" rx="4.5" ry="2.6" fill="#F2AFC0" opacity=".7"/>
  </g></svg>`;
}

/* ---------- reactions ---------- */
export const CAT = {};   // slot id → { el, rig, led, card, mute, solo, mini, type }
const charOf = c => getInstrumentType(c.type).visual.character;
export function registerCat(t, refs) { CAT[t] = refs; }

function anim(el, frames, opts) { if (!store.ui.motion || !el || !el.animate) return; el.animate(frames, { duration: 180, easing: 'cubic-bezier(.3,1.4,.5,1)', ...opts }); }
function flashLed(tr) { const l = CAT[tr] && CAT[tr].led; if (!l) return; l.classList.add('hit'); setTimeout(() => l.classList.remove('hit'), 90); }

export function catReact(id, hits) {
  flashLed(id);
  const c = CAT[id]; if (!c || !store.ui.motion || !hits || !hits.length) return;
  const tr = charOf(c), v = getInstrumentType(c.type).visual;
  if (tr === 'bop') {
    if (hits.some(x => x.d === 'kick')) anim(c.rig, [{ transform: 'translateY(0) scale(1)' }, { transform: 'translateY(-9px) scale(1.04,.96)' }, { transform: 'translateY(0) scale(1)' }], { duration: 200 });
    else anim(c.rig, [{ transform: 'rotate(0)' }, { transform: 'rotate(-4deg)' }, { transform: 'rotate(0)' }], { duration: 160 });
  } else if (tr === 'goo') {
    const h0 = hits[0];
    if (h0.slide) anim(c.rig, [{ transform: 'scale(1,1)' }, { transform: 'scale(1.14,.9)' }, { transform: 'scale(1,1)' }], { duration: 260 });
    else anim(c.rig, [{ transform: 'scale(1,1)' }, { transform: 'scale(1.06,.94)' }, { transform: 'scale(1,1)' }], { duration: 140 });
    if (h0.acc) { c.el.classList.add('joy'); clearTimeout(c.jt); c.jt = setTimeout(() => c.el.classList.remove('joy'), 160); }
  } else if (tr === 'blip') {
    anim(c.rig, [{ transform: 'translateY(0)' }, { transform: 'translateY(-5px)' }, { transform: 'translateY(0)' }], { duration: 170 });
    if (hits.length >= 2) sparks(c.el, 3, v.dark);
  } else if (tr === 'munch') {
    anim(c.rig, [{ transform: 'scale(1,1)' }, { transform: hits.some(x => x.slice != null) ? 'scale(1.08,.9)' : 'translateY(-5px)' }, { transform: 'scale(1,1)' }], { duration: 150 });
  } else if (tr === 'fuzz') {
    anim(c.rig, [{ transform: 'scale(1)' }, { transform: 'scale(1.05)' }, { transform: 'scale(1)' }], { duration: 600, easing: 'ease-in-out', composite: 'add' });
    puff(c.el, v.dark);
  }
}
export function setCatsIdle() { Object.values(CAT).forEach(c => c.el.classList.remove('joy', 'wiggle')); }
export function sparks(el, n, color, spread = 46) {
  if (!store.ui.motion || !el) return;
  const r = el.getBoundingClientRect();
  if (!r.width) return;
  for (let i = 0; i < n; i++) {
    const s = h('div', { class: 'spark', html: `<svg viewBox="-7 -7 14 14"><path d="${STAR}" fill="${color}" stroke="#fff" stroke-width="1"/></svg>` });
    s.style.left = (r.left + r.width / 2 + rand(-12, 12)) + 'px'; s.style.top = (r.top + r.height * .35) + 'px';
    document.body.append(s);
    const dx = rand(-spread, spread), dy = rand(-spread * 1.1, -spread * .3);
    s.animate([{ transform: 'translate(0,0) scale(.4) rotate(0)', opacity: 1 }, { transform: `translate(${dx}px,${dy}px) scale(1.1) rotate(${rand(-90, 90)}deg)`, opacity: 0 }], { duration: rand(500, 900), easing: 'cubic-bezier(.2,.8,.3,1)' }).onfinish = () => s.remove();
  }
}
function puff(el, color) {
  const r = el.getBoundingClientRect(); if (!r.width) return;
  const s = h('div', { class: 'spark', html: `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" fill="none" stroke="${color}" stroke-width="2"/></svg>` });
  s.style.left = (r.left + r.width / 2 + rand(-20, 20)) + 'px'; s.style.top = (r.top + r.height * .4) + 'px';
  document.body.append(s);
  s.animate([{ transform: 'translateY(0) scale(.5)', opacity: .8 }, { transform: `translate(${rand(-20, 20)}px,-40px) scale(2)`, opacity: 0 }], { duration: 1200, easing: 'ease-out' }).onfinish = () => s.remove();
}
export function uniReact(intensity = .3) {
  const u = document.getElementById('uni'); if (!u) return;
  u.dataset.face = intensity > .8 ? 'dizzy' : intensity > .45 ? 'wow' : 'happy';
  clearTimeout(u._t); u._t = setTimeout(() => { u.dataset.face = 'idle'; }, 1100);
  const rig = u.querySelector('.rig');
  anim(rig, intensity > .8
    ? [{ transform: 'rotate(0)' }, { transform: 'rotate(-12deg) translateY(-6px)' }, { transform: 'rotate(10deg)' }, { transform: 'rotate(0)' }]
    : [{ transform: 'translateY(0)' }, { transform: 'translateY(-10px) scale(1.05)' }, { transform: 'translateY(0)' }], { duration: intensity > .8 ? 600 : 320 });
  sparks(u, 3 + Math.round(intensity * 8), pick(['#F2AFC0', '#C2B0ED', '#A5DFCE', '#F5D19A']), 40 + intensity * 40);
}
/** blinking + glancing idle life */
export function startIdleLife() {
  setInterval(() => {
    if (!store.ui.motion) return;
    const keys = Object.keys(CAT); if (!keys.length) return;
    const c = CAT[pick(keys)], t = charOf(c);
    const eyes = c.el.querySelector('.eyes');
    if (t === 'blip' && Math.random() < .4) anim(eyes, [{ transform: 'translateX(0)' }, { transform: `translateX(${pick([-3, 3])}px)` }, { transform: `translateX(${pick([-3, 3])}px)` }, { transform: 'translateX(0)' }], { duration: 1400, easing: 'ease-in-out' });
    else if (t !== 'fuzz') anim(eyes, [{ transform: 'scaleY(1)' }, { transform: 'scaleY(.1)' }, { transform: 'scaleY(1)' }], { duration: 150, easing: 'linear' });
  }, 1300);
}
