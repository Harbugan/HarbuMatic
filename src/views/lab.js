// Right panel: Happy Accident Lab (Experiment) and the Scenes list.

import { store, typeOf, visibleSlots } from '../app/store.js';
import * as A from '../app/actions.js';
import { NOTE, SCALES, MAX_SCENES, sceneLabel, MOODS } from '../core/constants.js';
import { getInstrumentType } from '../core/instruments.js';
import { $, h, btn } from '../ui/dom.js';
import { ico } from '../ui/icons.js';
import { Knob, Seg, Switch } from '../ui/controls.js';
import { uniSVG, uniReact } from '../ui/characters.js';
import { harmonyLabel } from '../music/harmony.js';
import { occupancy } from './strip.js';
import { renameSceneDialog, copySceneDialog, deleteSceneDialog } from './scene-dialogs.js';

const MOOD_LABEL = { dreamy: 'Dreamy', bouncy: 'Bouncy', dark: 'Dark', weird: 'Weird' };

function section(key, title, build) {
  const open = store.ui.labOpen[key];
  const head = h('button', { type: 'button', class: 'lsect' + (open ? ' open' : ''), 'aria-expanded': String(open) }, h('span', {}, title), h('span', { class: 'chev', html: ico('down') }));
  const body = h('div', { class: 'lsect-body' });
  if (open) build(body);
  head.onclick = () => { store.ui.labOpen[key] = !store.ui.labOpen[key]; renderLab(); };
  return open ? [head, body] : [head];
}

export function renderLab() {
  const host = $('#rLab'); const scroll = host.scrollTop; host.innerHTML = '';
  const p = store.project, L = p.lab, m = typeOf();
  const uni = h('div', { class: 'uni', id: 'uni', 'data-face': 'idle', title: 'UNI — keeper of happy accidents', html: uniSVG() });
  uni.onclick = () => uniReact(.3);
  host.append(h('div', { class: 'uni-home' }, uni, h('div', { class: 'uni-say' }, h('b', {}, 'Happy Accident Lab'), h('span', {}, `Playing with ${m.name} in scene ${sceneLabel(p.scene)}`))));

  if (m.capabilities.samples) { renderSamplerLab(host, p); host.scrollTop = scroll; return; }
  if (m.capabilities.breaks) {
    host.append(h('div', { class: 'lab-munch' },
      h('p', { class: 'mini-hint' }, `${m.name} has CHOP IT! and A/B/C locks right in the JAM sequencer. Pick, audition & mix breaks in SOUND.`),
      h('button', { type: 'button', class: 'lbtn big', onclick: () => { A.setDrawer(false); A.setMode('sound'); } },
        h('span', { class: 'lbtn-i', html: ico('spark') }),
        h('span', { class: 'lbtn-t' }, `Open ${m.name}`, h('small', {}, 'pick, audition & mix breaks in SOUND')))));
    keyAndSnaps(host, p);
    host.scrollTop = scroll;
    return;
  }
  const gen = m.capabilities.generate;
  const act = (k, label, kind, cls = '', sub) => {
    const b = h('button', { type: 'button', class: 'lbtn ' + cls, title: gen ? label : `${label} is not available for ${m.name}`, disabled: !gen }, h('span', { class: 'lbtn-i', html: ico(k) }), h('span', { class: 'lbtn-t' }, label, sub ? h('small', {}, gen ? sub : 'not for ' + m.name) : null));
    b.onclick = () => A.runTransform(kind);
    return b;
  };
  host.append(h('div', { class: 'lab-grid' },
    act('spark', 'Generate', 'generate', 'big', `a new idea for ${m.name}`),
    act('mutate', 'Mutate', 'mutate', '', 'twist it'), act('evolve', 'Evolve', 'evolve', '', 'tiny change'),
    act('remix', 'Remix', 'remix', '', 'reshuffle'), act('dice', 'Surprise', 'surprise', 'surprise', 'go wild')));

  host.append(h('div', { class: 'sect' }, 'Vibe'));
  const moods = h('div', { class: 'moods', role: 'radiogroup', 'aria-label': 'Mood' });
  MOODS.forEach(md => {
    const b = h('button', { type: 'button', class: 'mood-chip' + (L.mood === md ? ' on' : ''), role: 'radio', 'aria-checked': String(L.mood === md), 'data-mood': md }, MOOD_LABEL[md]);
    b.onclick = () => A.setLab('mood', md);
    moods.append(b);
  });
  host.append(moods);
  const chaos = Knob({ label: 'Chaos', value: L.chaos, def: .35, color: '#E07D98', onChange: v => { L.chaos = v; A.save(); }, title: 'How far ideas wander from the safe path' });
  const dens = Knob({ label: 'Density', value: L.density, def: .55, color: '#9A82DD', onChange: v => { L.density = v; A.save(); }, title: 'How busy new patterns are' });
  host.append(h('div', { class: 'lab-knobs' }, chaos.el, dens.el));

  host.append(...section('more', 'More tricks', body => {
    body.append(h('div', { class: 'lab-grid small' }, act('rhythm', 'Rhythm', 'rhythm'), act('call', 'Answer', 'callresp'), act('human', 'Humanize', 'humanize')));
    body.append(Switch('Auto-evolve every loop', store.ui.autoEvolve, v => A.setAutoEvolve(v), 'Gently evolves the selected instrument at the end of each loop while playing'));
    body.append(h('div', { class: 'sect' }, 'Mutate changes'));
    const tg = h('div', { class: 'targets' });
    Object.keys(L.targets).forEach(k => { const b = h('button', { type: 'button', class: 'tg' + (L.targets[k] ? ' on' : ''), 'aria-pressed': String(L.targets[k]) }, k); b.onclick = () => { L.targets[k] = !L.targets[k]; A.save(); renderLab(); }; tg.append(b); });
    body.append(tg);
  }));
  keyAndSnaps(host, p);
  host.scrollTop = scroll;
}

/**
 * MUNCH has no Lab generators: instead of five disabled buttons it gets a pointer to its own creative tools
 * (MAGIC CHOP lives in CHOP). Key & chords and Snapshots are song-wide, so they stay.
 */
function renderSamplerLab(host, p) {
  const m = typeOf();
  const go = (label, sub, icon, tab) => {
    const b = h('button', { type: 'button', class: 'lbtn ' + (tab === 'chop' ? 'big' : ''), 'data-testid': `lab-munch-${tab}` }, h('span', { class: 'lbtn-i', html: ico(icon) }), h('span', { class: 'lbtn-t' }, label, h('small', {}, sub)));
    b.onclick = () => { store.ui.munch.tab = tab; A.setDrawer(false); A.setMode('sound'); };
    return b;
  };
  host.append(h('div', { class: 'lab-munch' }, h('p', { class: 'mini-hint' }, `${m.name} makes its own happy accidents.`),
    h('div', { class: 'lab-grid' }, go('Magic chop', 'grooves from your slices', 'spark', 'chop'), go('Play', 'keys', 'play', 'play'), go('Twist', 'shape it', 'mutate', 'twist'))));
  keyAndSnaps(host, p);
}

function keyAndSnaps(host, p) {
  host.append(...section('key', `Key & chords · ${NOTE[p.key]} ${p.scale}`, body => {
    const keySel = h('select', { 'aria-label': 'Key' }, NOTE.map((n, i) => h('option', { value: i, selected: i === p.key }, n)));
    const scSel = h('select', { 'aria-label': 'Scale' }, Object.keys(SCALES).map(k => h('option', { value: k, selected: k === p.scale }, k)));
    keySel.onchange = () => A.setKeyScale(+keySel.value, p.scale);
    scSel.onchange = () => A.setKeyScale(p.key, scSel.value);
    body.append(h('div', { class: 'lab-row' }, keySel, scSel));
    const hm = p.scenes[p.scene].harmony;
    body.append(h('div', { class: 'chords' }, h('span', { class: 'chords-l' }, `Scene ${sceneLabel(p.scene)} chords`), h('b', {}, hm ? harmonyLabel(p.key, p.scale, hm) : 'chosen on first Generate')));
    body.append(btn({ icon: ico('chords'), label: 'New chords', cls: 'lbtn', onClick: A.newChords }));
  }));
  host.append(...section('snaps', 'Snapshots', body => {
    body.append(h('p', { class: 'mini-hint' }, 'Store the whole scene. Tap an empty slot to save, a full slot to recall.'));
    const sn = h('div', { class: 'snaps' });
    p.snaps.forEach((snp, i) => {
      const b = h('button', { type: 'button', class: 'snap' + (snp ? ' full' : ''), title: snp ? 'Recall snapshot' : 'Save current scene here' }, String(i + 1));
      b.onclick = () => (snp ? A.snapshotRecall(i) : A.snapshotSave(i));
      const wrap = h('div', { class: 'snap-wrap' }, b);
      if (snp) { const x = h('button', { type: 'button', class: 'snap-x', 'aria-label': `Clear snapshot ${i + 1}`, html: ico('close') }); x.onclick = () => A.snapshotClear(i); wrap.append(x); }
      sn.append(wrap);
    });
    body.append(sn);
  }));
}

export function renderScenes() {
  const host = $('#rScenes'); const scroll = host.scrollTop; host.innerHTML = '';
  const p = store.project, tr = A.transport, pos = tr.position;
  const song = p.songMode && p.arrangement.length;
  host.append(h('p', { class: 'mini-hint' }, tr.playing ? (song ? 'Song mode is playing the arrangement — tap to edit a scene' : 'Tap a scene: it starts on the next bar') : 'Tap a scene to edit it'));
  const list = h('div', { class: 'scene-list' });
  p.scenes.forEach((sc, i) => {
    const dots = h('span', { class: 'dots' }, visibleSlots().map(s => { const d = h('i', { class: occupancy(s.id, i, 16).some(Boolean) ? 'on' : '' }); d.style.background = getInstrumentType(s.type).visual.dark; return d; }));
    const playing = tr.state !== 'stopped' && pos && pos.scene === i;
    const b = h('button', { type: 'button', class: 'scene' + (p.scene === i ? ' cur' : '') + (playing ? ' playing' : '') + (tr.pending === i ? ' queued' : ''), 'aria-pressed': String(p.scene === i), 'data-scene': i },
      h('span', { class: 'L' }, sceneLabel(i)), h('span', { class: 'nm' }, sc.name), dots);
    b.onclick = () => A.selectScene(i);
    list.append(b);
  });
  host.append(list);
  const atLimit = p.scenes.length >= MAX_SCENES, canMulti = p.scenes.length > 1;
  const badge = sceneLabel(p.scene);
  const newBtn = btn({ icon: ico('plus'), label: 'New scene', cls: 'lbtn', disabled: atLimit, title: atLimit ? `Up to ${MAX_SCENES} scenes per song` : 'Create an empty scene', onClick: () => A.createScene() });
  newBtn.dataset.testid = 'scene-new';
  const dupBtn = btn({ icon: ico('dup'), label: `Duplicate ${badge}`, cls: 'lbtn', disabled: atLimit, title: atLimit ? `Up to ${MAX_SCENES} scenes per song` : `Create an independent copy of scene ${badge}`, onClick: () => A.duplicateScene(p.scene) });
  dupBtn.dataset.testid = 'scene-dup';
  const renBtn = btn({ icon: ico('edit'), label: 'Rename', cls: 'lbtn', title: `Rename scene ${badge}`, onClick: () => renameSceneDialog(p.scene) });
  renBtn.dataset.testid = 'scene-rename';
  const copyBtn = btn({ icon: ico('remix'), label: 'Copy to…', cls: 'lbtn', disabled: !canMulti, title: canMulti ? `Copy scene ${badge} into another scene` : 'Create another scene first', onClick: () => copySceneDialog(p.scene) });
  copyBtn.dataset.testid = 'scene-copy';
  const delBtn = btn({ icon: ico('trash'), label: `Delete ${badge}`, cls: 'lbtn danger', disabled: !canMulti, title: canMulti ? `Delete scene ${badge}` : 'A song needs at least one scene', onClick: () => deleteSceneDialog(p.scene) });
  delBtn.dataset.testid = 'scene-delete';
  host.append(h('div', { class: 'scene-actions' },
    newBtn,
    dupBtn,
    h('div', { class: 'scene-actions-row' }, renBtn, copyBtn),
    delBtn,
    btn({ icon: ico('song'), label: 'Arrange song', cls: 'lbtn', onClick: () => A.setMode('arrange') })));
  host.scrollTop = scroll;
}

export function renderRightTabs() {
  const tabs = $('#rtabSeg'); tabs.innerHTML = '';
  tabs.append(Seg([['lab', 'LAB'], ['scenes', 'SCENES']], store.ui.rtab, v => { store.ui.rtab = v; showRightTab(); }, { label: 'Panel' }));
  showRightTab();
}
export function showRightTab() {
  $('#rLab').hidden = store.ui.rtab !== 'lab';
  $('#rScenes').hidden = store.ui.rtab !== 'scenes';
}
