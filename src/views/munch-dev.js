// MUNCH test bench (v0.6 Phase 3, temporary): a plain panel in the SOUND view for validating the sample engine.
// Only reachable with ?munch=dev. It is not the MUNCH design (PLAY/CHOP/TWIST arrive in Phase 4) and offers only
// controls that work: import, record, sample state, eight slice pads, a slice step grid for the current scene and
// the slice reset. Pitch, trim, reverse, envelope and play mode are the regular SOUND knobs above it; melodic
// notes are drawn in JAM's piano roll as for any instrument.

import { store, pat, slot } from '../app/store.js';
import * as A from '../app/actions.js';
import { SCENE_LETTERS } from '../core/constants.js';
import { sliceCount } from '../core/samples.js';
import { h } from '../ui/dom.js';

const STATUS = {
  none: 'No sample yet: import a file or record one.',
  idle: 'Waiting for audio to start…', loading: 'Loading…', ready: 'Ready',
  missing: 'Missing on this device: import the same file again to bring it back.', error: 'Could not be loaded',
};

export function renderMunchDev(host) {
  const id = store.ui.sel, s = slot(id), st = A.sampleState(id), ref = st.ref;
  const box = h('div', { class: 'sgroup wide munch-dev', 'data-testid': 'munch-dev' });
  box.append(h('h4', {}, 'MUNCH test bench · dev preview'));

  // sample + status
  const info = ref
    ? h('div', { class: 'md-info' }, h('b', {}, ref.name), h('span', {}, ` · ${ref.duration.toFixed(2)} s · ${ref.channels === 1 ? 'mono' : ref.channels + ' ch'} · ${ref.sampleRate} Hz`))
    : h('div', { class: 'md-info' });
  const status = h('div', { class: 'md-status', 'data-status': st.status }, STATUS[st.status] || st.status, st.error && st.status === 'error' ? ` (${st.error})` : '');
  box.append(info, status);

  // import + record
  const file = h('input', { type: 'file', accept: 'audio/*,.wav,.mp3,.m4a,.aac,.ogg,.webm,.flac', hidden: true, 'data-testid': 'munch-file' });
  file.onchange = async () => { const f = file.files && file.files[0]; file.value = ''; if (f) await A.importSampleFile(f, id); };
  const imp = h('button', { type: 'button', class: 'preset' }, 'Import sample…'); imp.onclick = () => file.click();
  const row = h('div', { class: 'md-row' }, imp, file);
  if (A.recordingSupported()) {
    const r = A.recorder.state;
    const rec = h('button', { type: 'button', class: 'preset md-rec' + (r === 'recording' ? ' on' : ''), 'data-testid': 'munch-rec', disabled: r === 'starting' || r === 'stopping' }, r === 'recording' ? '■ Stop & keep' : r === 'starting' ? 'Allow the mic…' : '● Record');
    rec.onclick = () => (A.recorder.state === 'recording' ? A.recordStop(id) : A.recordStart());
    row.append(rec);
    if (r === 'recording') { const c = h('button', { type: 'button', class: 'preset' }, 'Cancel'); c.onclick = A.recordCancel; row.append(c); }
  } else row.append(h('span', { class: 'mini-hint' }, 'Recording is not supported in this browser.'));
  box.append(row);

  if (ref) {
    const n = sliceCount(ref.slices), ready = st.status === 'ready';
    // slice pads
    const pads = h('div', { class: 'md-pads', 'data-testid': 'munch-pads' });
    for (let k = 0; k < n; k++) { const b = h('button', { type: 'button', class: 'md-pad', disabled: !ready, 'aria-label': `Play slice ${k + 1}` }, String(k + 1)); b.onclick = () => A.auditionSlice(k, id); pads.append(b); }
    const reset = h('button', { type: 'button', class: 'preset' }, '8 equal slices'); reset.onclick = () => A.resetSlices(8, id);
    box.append(h('div', { class: 'md-sub' }, 'Slices'), pads, h('div', { class: 'md-row' }, reset));

    // slice step grid for the current scene (one-step slice triggers; melodic notes live in JAM)
    const p = pat(id), steps = Math.min(16, p.len);
    const grid = h('div', { class: 'md-grid', 'data-testid': 'munch-grid', style: `--steps:${steps}` });
    for (let k = 0; k < n; k++) for (let i = 0; i < steps; i++) {
      const on = p.notes.some(x => x.s === i && x.slice === k);
      const c = h('button', { type: 'button', class: 'md-cell' + (on ? ' on' : '') + (i % 4 === 0 ? ' beat' : ''), 'aria-pressed': String(on), 'aria-label': `Slice ${k + 1}, step ${i + 1}`, 'data-k': k, 'data-s': i });
      c.onclick = () => A.toggleSliceStep(k, i, id);
      grid.append(c);
    }
    box.append(h('div', { class: 'md-sub' }, `Slice steps · scene ${SCENE_LETTERS[store.project.scene]} (first 16 steps)`), grid);
  }
  box.append(h('p', { class: 'mini-hint' }, 'Draw melodic notes in JAM. Samples stay in this browser: exported songs do not include them yet.'));
  host.append(box);
  return s;
}
