// Shared dialogs for scene management (Rename, Copy To with overwrite confirmation, Delete confirmation).
// Used by both the SCENES side-panel tab (src/views/lab.js) and ARRANGE (src/views/arrange.js).

import { store } from '../app/store.js';
import * as A from '../app/actions.js';
import { sceneLabel } from '../core/constants.js';
import { sceneHasContent } from '../core/project.js';
import { h } from '../ui/dom.js';
import { dialog, closeDialog, confirmDialog, promptDialog } from '../ui/controls.js';

export function renameSceneDialog(idx) {
  const sc = store.project.scenes[idx];
  if (!sc) return;
  promptDialog(`Rename scene ${sceneLabel(idx)}`, sc.name, 'Rename', v => A.renameScene(idx, v), { maxlength: 24 });
}

export function copySceneDialog(srcIdx) {
  const p = store.project, src = p.scenes[srcIdx];
  if (!src || p.scenes.length <= 1) return;
  const list = h('div', { class: 'scene-pick', role: 'list' });
  p.scenes.forEach((sc, j) => {
    if (j === srcIdx) return;
    const has = sceneHasContent(p, j) || !!sc.harmony;
    const b = h('button', {
      type: 'button',
      class: 'scene',
      'data-scene-target': j,
      'aria-label': `Copy to scene ${sceneLabel(j)} ${sc.name}${has ? ' (will overwrite)' : ' (empty)'}`,
    },
      h('span', { class: 'L' }, sceneLabel(j)),
      h('span', { class: 'nm' }, sc.name),
      h('small', { class: 'scene-state' }, has ? 'has pattern' : 'empty'));
    b.onclick = () => {
      if (has) {
        confirmDialog(
          `Overwrite ${sceneLabel(j)} · ${sc.name}?`,
          `All patterns and chords in ${sceneLabel(j)} will be replaced with ${sceneLabel(srcIdx)} · ${src.name}. (Undo can bring it back.)`,
          'Overwrite',
          () => A.copyScene(srcIdx, j),
          { danger: true },
        );
      } else {
        closeDialog();
        A.copyScene(srcIdx, j);
      }
    };
    list.append(b);
  });
  const body = h('div', { class: 'dlg-form' },
    h('p', { class: 'dlg-text' }, `Choose a scene to replace with ${sceneLabel(srcIdx)}’s patterns and chords.`),
    list);
  dialog({ title: `Copy ${sceneLabel(srcIdx)} · ${src.name} to…`, body, actions: [{ label: 'Cancel' }] });
}

export function deleteSceneDialog(idx) {
  const p = store.project, sc = p.scenes[idx];
  if (!sc || p.scenes.length <= 1) return;
  const refs = p.arrangement.filter(b => b.sceneId === sc.id).length;
  const msg = refs
    ? `This deletes ${sceneLabel(idx)} · ${sc.name} and removes its ${refs} block${refs === 1 ? '' : 's'} from the Song arrangement. (Undo can bring it back.)`
    : `This deletes ${sceneLabel(idx)} · ${sc.name} and all its patterns. (Undo can bring it back.)`;
  confirmDialog(`Delete ${sceneLabel(idx)} · ${sc.name}?`, msg, 'Delete', () => A.deleteScene(idx), { danger: true });
}
