// Sound Shapers bar (macros + FX toggles) and the SOUND view (deep parameters).

import { store, P, typeOf, slot, isSamplerSlot } from '../app/store.js';
import * as A from '../app/actions.js';
import { auditionPitch } from './strip.js';
import { $, h } from '../ui/dom.js';
import { Knob, Seg } from '../ui/controls.js';
import { MACRO_KEYS, MACRO_HINT } from '../music/macros.js';
import { renderMunch, setMunchRerender } from './munch.js';

let shaperKnobs = {};
export function renderBottom() {
  const sel = store.ui.sel, m = slot(sel).macros, def = typeOf(sel), hints = MACRO_HINT[def.role] || {};
  const host = $('#shapers'); host.innerHTML = '';
  host.append(h('span', { class: 'shapers-title' }, h('b', {}, 'Sound shapers'), h('small', {}, def.name)));
  shaperKnobs = {};
  if (!def.capabilities.macros) host.append(h('span', { class: 'mini-hint' }, def.capabilities.samples ? `Shape ${def.name} in SOUND → TWIST` : `${def.name} has no sound shapers yet: shape it in SOUND`));
  else MACRO_KEYS.forEach(k => {
    const kn = Knob({ label: k, value: m[k], def: .5, title: `${k[0].toUpperCase() + k.slice(1)} → ${hints[k]}`, onChange: v => A.setMacro(sel, k, v), onEnd: A.sealHistory });
    shaperKnobs[k] = kn; host.append(kn.el);
  });
  const fx = $('#fxbar'); fx.innerHTML = '';
  [['delay', 'Delay'], ['reverb', 'Reverb'], ['drive', 'Drive']].forEach(([k, l]) => {
    const on = !!P(sel)[k + 'On'];
    const b = h('button', { type: 'button', class: 'fxbtn' + (on ? ' on' : ''), 'data-fx': k, 'aria-pressed': String(on) }, h('span', { class: 'lamp' }), l.toUpperCase());
    b.onclick = () => A.toggleParam(sel, k + 'On');
    fx.append(b);
  });
}
export function syncShapers() { const m = slot().macros; Object.entries(shaperKnobs).forEach(([k, kn]) => kn.set(m[k])); }

const pct = v => Math.round(v * 100) + '%';
const sec = v => (v < 1 ? Math.round(v * 1000) + 'ms' : v.toFixed(2) + 's');
const panFmt = v => (Math.abs(v) < .01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100));
// deep parameters and presets per instrument type (registry id)
const SOUNDDEF = {
  bop: [['Kit', [{ k: 'kit', seg: [['808', '808-ish'], ['909', '909-ish'], ['lofi', 'Lofi']] }, { k: 'tune', l: 'Tune', min: -12, max: 12, step: 1, fmt: v => (v > 0 ? '+' : '') + v + ' st' }, { k: 'decay', l: 'Decay', min: .3, max: 2, fmt: v => v.toFixed(2) + '×' }, { k: 'tone', l: 'Tone' }]]],
  goo: [
    ['Oscillator', [{ k: 'wave', seg: [['sawtooth', 'Saw'], ['square', 'Square']] }, { k: 'glide', l: 'Glide', min: .01, max: .25, fmt: sec }]],
    ['Filter', [{ k: 'cutoff', l: 'Cutoff' }, { k: 'res', l: 'Reso' }, { k: 'env', l: 'Env mod' }, { k: 'decay', l: 'Decay', min: .05, max: 1 }, { k: 'accent', l: 'Accent' }]],
  ],
  blip: [
    ['Oscillators', [{ k: 'wave1', seg: [['sawtooth', 'Saw'], ['square', 'Sqr'], ['triangle', 'Tri'], ['sine', 'Sin']] }, { k: 'wave2', seg: [['sawtooth', 'Saw'], ['square', 'Sqr'], ['triangle', 'Tri'], ['sine', 'Sin']] }, { k: 'oct2', l: 'Osc2 oct', min: -1, max: 2, step: 1, fmt: v => (v > 0 ? '+' : '') + v }, { k: 'detune', l: 'Detune', min: 0, max: 40, fmt: v => v.toFixed(0) + 'ct' }, { k: 'mix', l: 'Mix' }]],
    ['Filter', [{ k: 'cutoff', l: 'Cutoff' }, { k: 'res', l: 'Reso' }, { k: 'fenv', l: 'Env amt' }]],
    ['Envelope', [{ k: 'attack', l: 'Attack', min: .002, max: 2, fmt: sec }, { k: 'decay', l: 'Decay', min: .02, max: 2, fmt: sec }, { k: 'sustain', l: 'Sustain' }, { k: 'release', l: 'Release', min: .02, max: 3, fmt: sec }]],
    ['LFO → filter', [{ k: 'lfoRate', l: 'Rate', min: .1, max: 12, fmt: v => v.toFixed(1) + 'Hz' }, { k: 'lfoDepth', l: 'Depth' }]],
  ],
  fuzz: [
    ['Texture', [{ k: 'tone', l: 'Tone' }, { k: 'noise', l: 'Noise' }, { k: 'crush', l: 'Crush' }, { k: 'shimmer', l: 'Shimmer' }]],
    ['Envelope', [{ k: 'attack', l: 'Attack' }, { k: 'release', l: 'Release', min: .1, max: 4, fmt: sec }]],
  ],
};
const COMMON = [['Channel', [{ k: 'vol', l: 'Volume' }, { k: 'pan', l: 'Pan', min: -1, max: 1, fmt: panFmt }, { k: 'drive', l: 'Drive' }, { k: 'delay', l: 'Delay send', max: .8 }, { k: 'reverb', l: 'Reverb send' }]]];
export const PRESETS = {
  bop: { 'Soft Boom': { kit: '808', tune: 0, decay: 1.1, tone: .45, driveOn: false }, 'Club Punch': { kit: '909', tune: 2, decay: .8, tone: .65, driveOn: true, drive: .3 }, 'Dusty Box': { kit: 'lofi', tune: -2, decay: .9, tone: .3, driveOn: true, drive: .65 } },
  goo: { 'Classic Acid': { wave: 'sawtooth', cutoff: .3, res: .62, env: .6, decay: .35, accent: .6, glide: .06, driveOn: true, drive: .45 }, 'Rubber Sub': { wave: 'square', cutoff: .16, res: .3, env: .25, decay: .25, driveOn: false }, 'Squelch': { wave: 'sawtooth', cutoff: .2, res: .9, env: .85, decay: .5, accent: .9, driveOn: true, drive: .75 }, 'Wobble Worm': { wave: 'square', cutoff: .33, res: .78, env: .5, decay: .7, glide: .14 } },
  blip: { 'Dream Keys': { wave1: 'sawtooth', wave2: 'square', oct2: 0, detune: 10, mix: .35, cutoff: .5, res: .15, fenv: .35, attack: .004, decay: .35, sustain: .35, release: .45, lfoDepth: .1, lfoRate: 2.5 }, 'Glass Pluck': { wave1: 'triangle', wave2: 'sine', oct2: 1, detune: 4, mix: .4, cutoff: .62, res: .3, fenv: .5, attack: .002, decay: .18, sustain: .05, release: .35, lfoDepth: 0 }, 'Cloud Pad': { wave1: 'sawtooth', wave2: 'sawtooth', oct2: 0, detune: 22, mix: .5, cutoff: .42, res: .1, fenv: .1, attack: .6, decay: 1, sustain: .8, release: 1.6, lfoDepth: .25, lfoRate: .6 }, 'Sugar Lead': { wave1: 'square', wave2: 'sawtooth', oct2: 1, detune: 8, mix: .25, cutoff: .66, res: .35, fenv: .3, attack: .01, decay: .3, sustain: .6, release: .2, lfoDepth: .05, lfoRate: 5.5 } },
  fuzz: { 'Cloud': { tone: .45, noise: .35, crush: .1, shimmer: .35, attack: .6, release: 1.4 }, 'Static Rain': { tone: .75, noise: .85, crush: .3, shimmer: .6, attack: .1, release: .8 }, 'Bitmoth': { tone: .6, noise: .3, crush: .75, shimmer: .8, attack: .05, release: .5 } },
};

const FX_TOGGLE_KEYS = new Set(['drive', 'delay', 'reverb']);

let soundKnobs = [];
let soundSwitches = [];
export function renderSound() {
  const host = $('#viewSound'); const scroll = host.scrollTop; host.innerHTML = ''; soundKnobs = []; soundSwitches = [];
  if (isSamplerSlot()) { renderMunch(host); host.scrollTop = scroll; return; } // MUNCH has its own workspace
  const sel = store.ui.sel, m = typeOf(sel), p = P(sel), type = m.type;
  const hear = () => A.engine.audition(sel, auditionPitch(m, store.project.key, 'soundPitch'));
  const pr = h('div', { class: 'presets' }, h('span', { class: 'sect' }, 'Presets'));
  Object.entries(PRESETS[type] || {}).forEach(([n, vals]) => { const b = h('button', { type: 'button', class: 'preset' }, n); b.onclick = () => { A.applyPreset(sel, vals); hear(); }; pr.append(b); });
  host.append(h('div', { class: 'view-head sound-head' },
    h('div', { class: 'chip' }, h('span', { class: 'dot' }), h('span', { class: 'chip-name' }, m.name), h('span', { class: 'chip-scene' }, 'Sound design')),
    pr));
  const groups = h('div', { class: 'sgroups sound-grid', 'data-inst': type });
  [...(SOUNDDEF[type] || []), ...COMMON].forEach(([title, defs]) => {
    const row = h('div', { class: 'row' });
    defs.forEach(d => {
      if (d.seg) { row.append(h('div', { class: 'wave-pick' }, Seg(d.seg, p[d.k], v => { A.checkpoint(); p[d.k] = v; A.engine.applyParams(sel); A.save(); hear(); }), h('div', { class: 'klbl' }, (d.label || d.k.replace('wave', 'osc ')).toUpperCase()))); return; }
      const kn = Knob({ label: d.l, min: d.min ?? 0, max: d.max ?? 1, step: d.step || 0, value: p[d.k], def: m.defaultParams[d.k], fmt: d.fmt || pct, onChange: v => A.setParam(sel, d.k, v), onEnd: A.sealHistory });
      kn.k = d.k; soundKnobs.push(kn);
      if (title === 'Channel' && FX_TOGGLE_KEYS.has(d.k)) {
        const onKey = d.k + 'On', on = !!p[onKey];
        const sw = h('button', { type: 'button', class: 'fx-sw' + (on ? ' on' : ''), 'data-fx': d.k, 'aria-pressed': String(on), 'aria-label': `${d.l} on or off` }, h('i'), 'On');
        sw.onclick = () => A.toggleParam(sel, onKey);
        soundSwitches.push({ k: onKey, el: sw });
        row.append(h('div', { class: 'fx-ctl' }, kn.el, sw));
        return;
      }
      row.append(kn.el);
    });
    groups.append(h('div', { class: 'sgroup', 'data-group': title.toLowerCase().replace(/[^a-z0-9]+/g, '-') }, h('h4', {}, title), row));
  });
  const fx = store.project.fx, frow = h('div', { class: 'row' });
  const gk = (l, k, min, max) => Knob({ label: l, min, max, value: fx[k], def: { fb: .4, dtone: .5, rev: .9, master: .85 }[k], fmt: pct, onChange: v => A.setFx(k, v), onEnd: A.sealHistory }).el;
  const swing = Knob({ label: 'Swing', max: .5, value: store.project.swing, def: .08, color: '#9A82DD', fmt: pct, onChange: v => A.setSwing(v), onEnd: A.sealHistory });
  soundKnobs.push(Object.assign(swing, { k: '__swing' }));
  frow.append(swing.el, gk('Echo fdbk', 'fb', 0, .85), gk('Echo tone', 'dtone', 0, 1), gk('Room level', 'rev', 0, 1.2), gk('Master', 'master', 0, 1));
  groups.append(h('div', { class: 'sgroup wide', 'data-group': 'shared-fx' }, h('h4', {}, 'Groove + shared FX · all instruments'), frow));
  host.append(groups);
  host.scrollTop = scroll;
}
export function refreshSoundKnobs() {
  const p = P(store.ui.sel);
  soundKnobs.forEach(k => k.set(k.k === '__swing' ? store.project.swing : p[k.k]));
  soundSwitches.forEach(s => { const on = !!p[s.k]; s.el.classList.toggle('on', on); s.el.setAttribute('aria-pressed', String(on)); });
}
setMunchRerender(() => renderSound());
