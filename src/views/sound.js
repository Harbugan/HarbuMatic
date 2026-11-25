// Sound Shapers bar (macros + FX toggles) and the SOUND view (deep parameters).

import { store, P, typeOf, slot, isSamplerSlot, isBreakSlot, isPlaceholderSlot } from '../app/store.js';
import * as A from '../app/actions.js';
import { BREAK_LANES } from '../core/instruments.js';
import { BUILTIN_BREAKS, laneVolKey, laneMuteKey, laneAudibleLevel } from '../core/breaks.js';
import { auditionPitch } from './strip.js';
import { $, h } from '../ui/dom.js';
import { Knob, Seg } from '../ui/controls.js';
import { ico } from '../ui/icons.js';
import { catSVG } from '../ui/characters.js';
import { MACRO_KEYS, MACRO_HINT } from '../music/macros.js';
import { renderMunch, setMunchRerender } from './munch.js';

let shaperKnobs = {};
export function renderBottom() {
  const sel = store.ui.sel, m = slot(sel).macros, def = typeOf(sel), hints = MACRO_HINT[def.role] || {};
  const host = $('#shapers'); host.innerHTML = '';
  host.append(h('span', { class: 'shapers-title' }, h('b', {}, 'Sound shapers'), h('small', {}, def.name)));
  shaperKnobs = {};
  if (!def.capabilities.macros) {
    const msg = def.capabilities.samples ? `Shape ${def.name} in SOUND → TWIST`
      : def.capabilities.breaks ? `Assign & mix ${def.name} A/B/C breaks in SOUND`
        : isPlaceholderSlot(sel) ? `${def.name} is a non-playing foundation slot`
          : `${def.name} has no sound shapers yet: shape it in SOUND`;
    host.append(h('span', { class: 'mini-hint' }, msg));
  } else MACRO_KEYS.forEach(k => {
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
let ruffLaneRefs = [];
let ruffStatusEl = null;

function ruffStatusSummary(sel) {
  const sl = slot(sel), p = P(sel), bpm = store.project.bpm;
  const aud = store.ui.ruff && store.ui.ruff.audition;
  if (aud && aud.slotId === sel) {
    const st = A.breakLaneState(aud.lane, sel);
    return { active: true, text: `Audition ${aud.lane.toUpperCase()} · ${st.desc ? st.desc.name : 'Break'}` };
  }
  const assigned = BREAK_LANES.filter(l => sl && sl.breaks && sl.breaks[l]);
  const audibleLanes = assigned.filter(l => laneAudibleLevel(p, l) > 0);
  const slotOn = A.engine.audible(sel);
  if (A.transport.playing) {
    if (!assigned.length) return { active: false, text: `Playing · No breaks assigned` };
    if (!slotOn || !audibleLanes.length) return { active: false, text: `Muted · ${bpm} BPM` };
    return { active: true, text: `Playing · ${audibleLanes.length} break${audibleLanes.length === 1 ? '' : 's'} · ${bpm} BPM` };
  }
  if (A.transport.state === 'paused') {
    return { active: false, text: `Paused · ${assigned.length} loaded · ${bpm} BPM` };
  }
  if (assigned.length) return { active: false, text: `Ready · ${assigned.length} loaded · ${bpm} BPM` };
  return { active: false, text: `Assign a break to A, B or C` };
}

function buildRuffDeck(sel, p) {
  const deck = h('div', { class: 'ruff-deck', 'data-testid': 'ruff-deck' });
  const playing = A.transport.playing && A.engine.audible(sel);
  BREAK_LANES.forEach(l => {
    const L = l.toUpperCase();
    const st = A.breakLaneState(l, sel);
    const muteKey = laneMuteKey(l), volKey = laneVolKey(l);
    const muted = !!p[muteKey], vol = p[volKey] ?? .85;
    const isLive = playing && !!st.id && !muted && vol > 0;
    const card = h('div', {
      class: 'ruff-lane' + (st.id ? ' loaded' : '') + (muted ? ' muted' : '') + (isLive ? ' playing' : '') + (st.auditioning ? ' auditioning' : ''),
      'data-lane': l,
    });
    const metaText = st.status === 'loading' ? 'Loading…' : st.status === 'error' || st.status === 'missing' ? 'Error' : st.desc ? `${st.desc.bpm} BPM` : 'Off';
    const head = h('div', { class: 'ruff-lane-head' },
      h('span', { class: 'ruff-lane-id' }, L),
      h('b', { class: 'ruff-lane-name' }, st.desc ? st.desc.name : (st.id || 'Empty')),
      h('span', { class: 'ruff-lane-meta' }, metaText),
      h('i', { class: 'ruff-led', 'aria-hidden': 'true' }));

    const srcGrid = h('div', { class: 'ruff-src-grid', role: 'group', 'aria-label': `Break ${L} source` });
    const offBtn = h('button', {
      type: 'button',
      class: 'ruff-src' + (!st.id ? ' on' : ''),
      'data-break': '',
      'aria-pressed': String(!st.id),
      title: `Clear Break ${L}`,
    }, 'Off');
    offBtn.onclick = () => A.assignBreak(l, null, sel);
    srcGrid.append(offBtn);
    BUILTIN_BREAKS.forEach(b => {
      const on = st.id === b.id;
      const btnEl = h('button', {
        type: 'button',
        class: 'ruff-src' + (on ? ' on' : ''),
        'data-break': b.id,
        'aria-pressed': String(on),
        title: `${b.name} — ${b.subtitle} (${b.bpm} BPM, ${b.bars} bars)`,
      }, b.name);
      btnEl.onclick = () => A.assignBreak(l, b.id, sel);
      srcGrid.append(btnEl);
    });

    const audBtn = h('button', {
      type: 'button',
      class: 'ruff-aud' + (st.auditioning ? ' on' : ''),
      'data-action': 'audition',
      disabled: !st.id,
      'aria-pressed': String(st.auditioning),
      title: st.id ? (st.auditioning ? `Stop Break ${L} audition` : `Audition Break ${L}`) : `Assign a break to ${L} first`,
    }, h('span', { class: 'ruff-aud-i', html: ico(st.auditioning ? 'stop' : 'play') }), h('span', {}, st.auditioning ? 'Stop' : 'Audition'));
    audBtn.onclick = () => A.auditionBreak(l, sel);

    const muteBtn = h('button', {
      type: 'button',
      class: 'ruff-mute' + (muted ? ' on' : ''),
      'data-action': 'mute',
      'aria-pressed': String(muted),
      title: `Mute Break ${L}`,
    }, 'M');
    muteBtn.onclick = () => A.toggleBreakLaneMute(l, sel);

    const volKnob = Knob({
      label: 'Vol',
      min: 0, max: 1,
      value: vol,
      def: .85,
      fmt: pct,
      title: `Break ${L} volume`,
      onChange: v => A.setBreakLaneVol(l, v, sel),
      onEnd: A.sealHistory,
    });
    volKnob.k = volKey;
    soundKnobs.push(volKnob);

    const ctls = h('div', { class: 'ruff-lane-ctl' }, audBtn, muteBtn, volKnob.el);
    card.append(head, srcGrid, ctls);
    deck.append(card);
    ruffLaneRefs.push({ lane: l, card, muteKey, volKey, muteBtn });
  });
  return deck;
}

export function refreshRuffState() {
  const sel = store.ui.sel;
  if (!isBreakSlot(sel)) return;
  const p = P(sel), playing = A.transport.playing && A.engine.audible(sel);
  if (ruffStatusEl) {
    const sum = ruffStatusSummary(sel);
    ruffStatusEl.classList.toggle('active', sum.active);
    const txt = ruffStatusEl.querySelector('.ruff-status-txt');
    if (txt) txt.textContent = sum.text;
  }
  ruffLaneRefs.forEach(r => {
    const st = A.breakLaneState(r.lane, sel);
    const muted = !!p[r.muteKey], vol = p[r.volKey] ?? .85;
    const isLive = playing && !!st.id && !muted && vol > 0;
    r.card.classList.toggle('muted', muted);
    r.card.classList.toggle('playing', isLive);
    r.card.classList.toggle('auditioning', st.auditioning);
    r.muteBtn.classList.toggle('on', muted);
    r.muteBtn.setAttribute('aria-pressed', String(muted));
  });
}

export function renderSound() {
  const host = $('#viewSound'); const scroll = host.scrollTop; host.innerHTML = '';
  soundKnobs = []; soundSwitches = []; ruffLaneRefs = []; ruffStatusEl = null;
  if (isSamplerSlot()) { renderMunch(host); host.scrollTop = scroll; return; } // MUNCH has its own workspace
  const sel = store.ui.sel, m = typeOf(sel), p = P(sel), type = m.type, placeholder = isPlaceholderSlot(sel), isBreak = isBreakSlot(sel);
  const hear = () => { if (!placeholder && !isBreak) A.engine.audition(sel, auditionPitch(m, store.project.key, 'soundPitch')); };
  const pr = h('div', { class: 'presets' + (isBreak ? ' ruff-head-ctls' : '') });
  if (isBreak) {
    const sum = ruffStatusSummary(sel);
    ruffStatusEl = h('span', { class: 'ruff-status' + (sum.active ? ' active' : ''), 'data-testid': 'ruff-status' },
      h('i', { class: 'ruff-led', 'aria-hidden': 'true' }),
      h('span', { class: 'ruff-status-txt' }, sum.text));
    const fitSeg = Seg(
      [['stretch', 'Stretch'], ['tape', 'Tape']],
      p.fitMode === 'tape' ? 'tape' : 'stretch',
      v => { A.setFitMode(v, sel); renderSound(); },
      { label: 'Tempo sync mode: Stretch keeps pitch, Tape follows speed' },
    );
    fitSeg.classList.add('ruff-fit-seg');
    pr.append(ruffStatusEl, fitSeg);
  } else if (placeholder) {
    pr.append(h('span', { class: 'ruff-ph-tag' }, 'Foundation · Non-playing'));
  } else {
    pr.append(h('span', { class: 'sect' }, 'Presets'));
    Object.entries(PRESETS[type] || {}).forEach(([n, vals]) => { const b = h('button', { type: 'button', class: 'preset' }, n); b.onclick = () => { A.applyPreset(sel, vals); hear(); }; pr.append(b); });
  }
  host.append(h('div', { class: 'view-head sound-head' },
    h('div', { class: 'chip' }, h('span', { class: 'dot' }), h('span', { class: 'chip-name' }, m.name), h('span', { class: 'chip-scene' }, isBreak ? 'Break Pool · A/B/C' : placeholder ? 'Breakbeat Machine' : 'Sound design')),
    pr));
  if (isBreak) host.append(buildRuffDeck(sel, p));
  const groups = h('div', { class: 'sgroups sound-grid' + (isBreak ? ' ruff-sound-bottom' : ''), 'data-inst': type });
  if (placeholder) {
    const sl = slot(sel);
    const sources = h('div', { class: 'ruff-lanes' }, BREAK_LANES.map(l =>
      h('div', { class: 'ruff-lane-pill' },
        h('b', {}, `Break ${l.toUpperCase()}`),
        h('span', {}, sl && sl.breaks && sl.breaks[l] ? sl.breaks[l] : 'Empty'))));
    groups.append(h('div', { class: 'sgroup wide ruff-sound-ph', 'data-group': 'ruff-foundation' },
      h('div', { class: 'ruff-ph-card compact' },
        h('div', { class: 'cat ' + m.visual.css, html: catSVG(m.type) }),
        h('div', { class: 'ruff-ph-body' },
          h('h4', {}, `${m.name} workspace foundation`),
          h('p', {}, 'Channel settings below persist in your song.'),
          sources))));
  }
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
  refreshRuffState();
}
setMunchRerender(() => renderSound());
