// Song menu (Project): New, Open, Rename, Save a copy, Export/Import, Demo, Settings, Help.

import { store } from '../app/store.js';
import * as A from '../app/actions.js';
import { VERSION_LABEL, APP_CREDIT, MOODS } from '../core/constants.js';
import { $, h, btn } from '../ui/dom.js';
import { ico } from '../ui/icons.js';
import { dialog, closeDialog, confirmDialog, promptDialog, Switch, Seg } from '../ui/controls.js';

export function renderSongButton() {
  $('#songName').textContent = store.project.name;
  $('#hSong').setAttribute('aria-label', `Song menu — ${store.project.name}`);
}

export function openMenu() {
  const m = $('#menu');
  if (m.classList.contains('open')) return closeMenu();
  m.innerHTML = '';
  const item = (icon, label, sub, fn) => { const b = h('button', { type: 'button', class: 'mitem', role: 'menuitem' }, h('span', { class: 'mi', html: ico(icon) }), h('span', { class: 'mt' }, label, sub ? h('small', {}, sub) : null)); b.onclick = () => { closeMenu(); fn(); }; return b; };
  m.append(
    h('div', { class: 'mhead' }, h('small', {}, 'Current song'), h('b', {}, store.project.name), h('small', {}, 'Saved automatically on this device')),
    item('plus', 'New song…', 'start from an empty canvas', newSongDialog),
    item('folder', 'Open…', 'your songs on this device', openDialog),
    item('edit', 'Rename…', null, () => promptDialog('Rename song', store.project.name, 'Rename', v => A.renameProject(v), { maxlength: 60 })),
    item('dup', 'Save a copy', 'duplicate and keep working on the copy', A.duplicateProject),
    h('hr'),
    item('download', 'Export file', 'download a portable .hbn song', A.exportProject),
    item('upload', 'Import file…', 'open a .hbn or legacy .json song', () => $('#fileIn').click()),
    item('song', 'Load demo song', 'adds the demo as a new song', A.loadDemo),
    h('hr'),
    item('gear', 'Settings & help', null, settingsDialog));
  m.classList.add('open');
  $('#scrim').classList.add('show');
  m.querySelector('.mitem').focus();
}
export function closeMenu() { $('#menu').classList.remove('open'); if (!document.querySelector('.dialog')) $('#scrim').classList.remove('show'); }

export function newSongDialog() {
  let mood = 'bouncy', bpm = 120;
  const n = A.library.list().length + 1;
  const name = h('input', { class: 'dlg-input', value: `Song ${n}`, maxlength: 60, 'aria-label': 'Song name' });
  name.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') create(); });
  const bpmVal = h('b', { class: 'bpm-inline' }, String(bpm));
  const setB = d => { bpm = Math.max(60, Math.min(180, bpm + d)); bpmVal.textContent = bpm; };
  const body = h('div', { class: 'dlg-form' },
    h('label', { class: 'dlg-l' }, 'Name'), name,
    h('label', { class: 'dlg-l' }, 'Starting vibe'), Seg(MOODS.map(m => [m, m[0].toUpperCase() + m.slice(1)]), mood, v => { mood = v; }, { label: 'Mood' }),
    h('label', { class: 'dlg-l' }, 'Tempo'),
    h('div', { class: 'bpm-row' }, btn({ icon: ico('minus'), label: '', cls: 'mini icon', title: 'Slower', onClick: () => setB(-5) }), bpmVal, h('span', { class: 'hint' }, 'BPM'), btn({ icon: ico('plus'), label: '', cls: 'mini icon', title: 'Faster', onClick: () => setB(5) })),
    h('p', { class: 'dlg-note' }, `“${store.project.name}” stays safe in Open — nothing is deleted. The new song starts with empty patterns, default sounds and an empty arrangement.`));
  const create = () => { A.newSong({ name: name.value.trim() || `Song ${n}`, bpm, mood }); closeDialog(); };
  dialog({ title: 'New song', body, actions: [{ label: 'Export current first', onClick: () => { A.exportProject(); return false; } }, { label: 'Cancel' }, { label: 'Create', primary: true, onClick: () => { create(); return false; } }] });
  setTimeout(() => { name.focus(); name.select(); }, 40);
}

export function openDialog() {
  const list = h('div', { class: 'proj-list' });
  const fill = () => {
    list.innerHTML = '';
    const items = A.library.list();
    if (!items.length) list.append(h('p', { class: 'dlg-text' }, 'No songs yet.'));
    items.forEach(it => {
      const when = it.modified ? new Date(it.modified).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
      const row = h('div', { class: 'proj' + (it.current ? ' cur' : '') },
        h('div', { class: 'pinfo' }, h('b', {}, it.name), h('small', {}, it.current ? `Open now · ${when}` : when)));
      if (!it.current) {
        row.append(btn({ icon: ico('folder'), label: 'Open', cls: 'mini primary', onClick: () => { closeDialog(); A.openProject(it.id); } }));
        row.append(btn({ icon: ico('trash'), label: '', cls: 'mini icon danger', title: `Delete ${it.name}`, onClick: () => confirmDialog(`Delete “${it.name}”?`, 'This removes the song from this device. Export it first if you might want it back.', 'Delete', () => { A.deleteProject(it.id); setTimeout(openDialog, 0); }, { danger: true }) }));
      }
      list.append(row);
    });
  };
  fill();
  dialog({ title: 'Open a song', body: h('div', {}, list, h('p', { class: 'dlg-note' }, 'Songs are stored in this browser. Use Export to back them up or move them to another device.')), actions: [{ label: 'Import file…', onClick: () => { $('#fileIn').click(); } }, { label: 'Close', primary: true }], cls: 'wide' });
}

export function settingsDialog() {
  const body = h('div', { class: 'dlg-form' },
    Switch('Character animation', store.ui.motion, v => { store.ui.motion = v; document.body.classList.toggle('no-motion', !v); }),
    h('label', { class: 'dlg-l' }, 'How to play'),
    h('ul', { class: 'help' },
      h('li', {}, 'Pick an instrument card, tap the grid to add notes, tap a note again to remove it.'),
      h('li', {}, 'Press Generate in the Lab for a new idea — Mutate, Evolve and Remix keep it recognisable.'),
      h('li', {}, 'Deep edit opens every tool: velocity, chance, slides, locks, length, zoom and octaves.'),
      h('li', {}, 'Scenes are loops. Create or duplicate scenes in SCENES or ARRANGE, then line them up into a song.')),
    h('label', { class: 'dlg-l' }, 'Keyboard (optional)'),
    h('div', { class: 'keys' },
      ...[['Space', 'Play / pause'], ['Esc', 'Stop (back to start)'], ['1–4', 'Select BOP · GOO · BLIP · FUZZ'], ['B E L', 'Draw · Erase · Lock'], ['↑ ↓', 'Octave up / down'], ['F', 'Deep edit on/off'], ['G M', 'Generate · Mutate'], ['⌘/Ctrl Z', 'Undo (Shift = redo)']].flatMap(([k, v]) => [h('kbd', {}, k), h('span', {}, v)])),
    h('p', { class: 'dlg-note' }, `HarbuMatic ${VERSION_LABEL} · works offline once loaded · songs stay on this device`),
    h('p', { class: 'dlg-note credit' }, APP_CREDIT));
  dialog({ title: 'Settings & help', body, actions: [{ label: 'Close', primary: true }] });
}

export function bindFileInput() {
  $('#fileIn').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) { closeDialog(); await A.importFile(f); } };
}
