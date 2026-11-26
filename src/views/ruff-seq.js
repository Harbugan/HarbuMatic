// RUFF Hybrid Sequencer (v0.7 PR3): Compact 16-step groove overview + Expanded A/B/C lanes + Contextual Slice Selector.
//
// Core principle: Start with the groove. Then break it apart.
// - Both Compact and Expanded modes render directly from the single scene-local pattern (`pat()`) and mutate
//   only through `src/app/actions.js`. Zero duplicated pattern state.
// - Opening the sequencer or tapping steps to inspect NEVER mutates project data; unedited assigned breaks
//   display their original 2-bar (16-slice) groove via `effectiveBreakRow()`.
// - Each of the 16 steps maps to 1 eighth-note across 2 bars (Steps 1–8 = Bar 1, Steps 9–16 = Bar 2),
//   preserving 100% of both bars and staying tightly synced to project BPM.

import { store, slot, pat, P, typeOf, isBreakSlot } from '../app/store.js';
import * as A from '../app/actions.js';
import { BREAK_LANES } from '../core/instruments.js';
import {
  BREAK_PATTERN_STEPS, BREAK_STEP_SPAN, BREAK_LOOP_STEPS,
  getBuiltinBreak, hasAssignedBreak, laneMuteKey, laneAudibleLevel,
  isBreakLaneEdited, effectiveBreakRow, suggestedSliceForStep, breakSliceInfo,
  breakSliceCount, breakStepBeatLabel,
} from '../core/breaks.js';
import { $, h } from '../ui/dom.js';
import { ico } from '../ui/icons.js';
import { catSVG } from '../ui/characters.js';
import { playhead } from '../ui/sequencer.js';

let stepElsByIndex = Array.from({ length: BREAK_PATTERN_STEPS }, () => []);
let lastPlayStep = -1;

function resolveActiveLane(sl, p) {
  const cur = store.ui.ruff.selLane;
  const hasCur = !!(sl && sl.breaks && sl.breaks[cur]) || isBreakLaneEdited(p, cur);
  if (BREAK_LANES.includes(cur) && hasCur) return cur;
  const first = BREAK_LANES.find(l => (sl && sl.breaks && sl.breaks[l]) || isBreakLaneEdited(p, l));
  return first || 'a';
}

function laneStatusKind(sl, p, lane) {
  const breakId = (sl && sl.breaks && sl.breaks[lane]) || null;
  const edited = isBreakLaneEdited(p, lane);
  if (!edited) return breakId ? 'orig' : 'none';
  const row = p && p.lanes && p.lanes[lane];
  const any = Array.isArray(row) && row.some(Boolean);
  return any ? 'edit' : 'silent';
}

function laneStatusText(kind) {
  if (kind === 'orig') return 'Orig';
  if (kind === 'edit') return 'Edit';
  if (kind === 'silent') return 'Silent';
  return 'Empty';
}

function buildEmptyState(m) {
  return h('div', { class: 'ruff-empty', 'data-testid': 'ruff-empty' },
    h('div', { class: 'ruff-empty-card' },
      h('div', { class: 'cat ' + m.visual.css, html: catSVG(m.type) }),
      h('div', { class: 'ruff-empty-body' },
        h('h3', {}, `${m.name} · Breakbeat Sequencer`),
        h('p', {}, 'Load a break into A, B or C in Break Pool to hear its original 2-bar groove, then chop and rearrange its 16 slices here.'),
        h('div', { class: 'ruff-empty-actions' },
          h('button', { type: 'button', class: 'btn tool on', 'data-action': 'open-pool', onclick: () => A.setMode('sound') }, 'Open RUFF Break Pool')))));
}

function buildInspector(sl, p, params, activeLane, selStep, rows) {
  const L = activeLane.toUpperCase();
  const breakId = (sl && sl.breaks && sl.breaks[activeLane]) || null;
  const desc = breakId ? getBuiltinBreak(breakId) : null;
  const kind = laneStatusKind(sl, p, activeLane);
  const edited = isBreakLaneEdited(p, activeLane);
  const effRow = rows[activeLane];
  const cell = effRow[selStep];
  const suggested = suggestedSliceForStep(breakId, selStep, p.len);
  const curSlice = cell ? cell.slice : suggested;
  const sliceInfo = breakSliceInfo(breakId, curSlice);
  const sliceTotal = breakSliceCount(breakId);
  const beatLabel = breakStepBeatLabel(selStep);
  const muted = !!(params && params[laneMuteKey(activeLane)]);

  // Lane tabs inside inspector showing A/B/C status at the selected step
  const laneTabs = h('div', { class: 'ruff-insp-lanes', role: 'group', 'aria-label': `Step ${selStep + 1} lanes` },
    BREAK_LANES.map(l => {
      const lId = sl && sl.breaks && sl.breaks[l];
      const lCell = rows[l][selStep];
      const lEdited = isBreakLaneEdited(p, l);
      const lMuted = !!(params && params[laneMuteKey(l)]);
      const active = l === activeLane;
      const badge = lCell ? `S${lCell.slice + 1}` : (lId || lEdited ? '—' : 'Off');
      const b = h('button', {
        type: 'button',
        class: 'ruff-insp-lane'
          + (active ? ' sel' : '')
          + (lCell ? (lCell.virtual ? ' orig' : ' hit') : '')
          + (lMuted ? ' muted' : ''),
        'data-lane': l,
        'data-testid': `ruff-insp-lane-${l}`,
        'aria-pressed': String(active),
        title: `Inspect Break ${l.toUpperCase()} at step ${selStep + 1}`,
      },
      h('span', { class: 'ruff-dot' }, l.toUpperCase()),
      h('span', { class: 'ruff-insp-lane-val' }, badge));
      b.onclick = () => A.selectRuffStep(selStep, l);
      return b;
    }));

  const identityText = !breakId && !edited
    ? `Break ${L} unassigned`
    : cell
      ? `${sliceInfo.code} · ${sliceInfo.label}${cell.virtual ? ' (Orig)' : ''}`
      : `Empty · Suggested ${breakSliceInfo(breakId, suggested).code} (${breakSliceInfo(breakId, suggested).label})`;

  const toggleBtn = h('button', {
    type: 'button',
    class: 'ruff-act' + (cell ? ' on' : ''),
    'data-testid': 'ruff-step-toggle',
    disabled: !breakId && !edited,
    'aria-pressed': String(!!cell),
    title: cell ? `Remove ${L} hit on step ${selStep + 1}` : `Add ${L} hit on step ${selStep + 1} (${breakSliceInfo(breakId, suggested).code})`,
  }, cell ? 'Hit On' : '+ Add');
  toggleBtn.onclick = () => A.toggleBreakStep(activeLane, selStep);

  const hearBtn = h('button', {
    type: 'button',
    class: 'ruff-act hear',
    'data-testid': 'ruff-slice-audition',
    disabled: !breakId,
    title: breakId ? `Audition ${sliceInfo.code} (${sliceInfo.label})` : 'Assign a break first',
  }, h('span', { class: 'ruff-act-i', html: ico('play') }), h('span', {}, sliceInfo.code));
  hearBtn.onclick = () => A.auditionBreakSlice(activeLane, curSlice);

  const laneActs = h('div', { class: 'ruff-insp-acts' }, toggleBtn, hearBtn);
  if (edited) {
    const clearBtn = h('button', {
      type: 'button',
      class: 'ruff-act subtle',
      'data-testid': 'ruff-lane-clear',
      disabled: kind === 'silent',
      title: `Clear all steps on Break ${L} (silent)`,
    }, 'Silence');
    clearBtn.onclick = () => A.clearBreakLane(activeLane);

    const resetBtn = h('button', {
      type: 'button',
      class: 'ruff-act subtle',
      'data-testid': 'ruff-lane-reset',
      title: `Restore Break ${L} to its unedited original groove`,
    }, 'Orig');
    resetBtn.onclick = () => A.resetBreakLane(activeLane);
    laneActs.append(clearBtn, resetBtn);
  } else if (breakId) {
    const clearBtn = h('button', {
      type: 'button',
      class: 'ruff-act subtle',
      'data-testid': 'ruff-lane-clear',
      title: `Clear Break ${L} to silence`,
    }, 'Silence');
    clearBtn.onclick = () => A.clearBreakLane(activeLane);
    laneActs.append(clearBtn);
  }

  const head = h('div', { class: 'ruff-insp-head', 'data-lane': activeLane },
    h('div', { class: 'ruff-insp-meta' },
      h('span', { class: 'ruff-step-tag', 'data-testid': 'ruff-selected-step' }, `Step ${selStep + 1} · ${beatLabel}`),
      laneTabs,
      h('span', { class: 'ruff-slice-id' + (muted ? ' muted' : ''), 'data-testid': 'ruff-slice-identity' },
        desc ? `${desc.name}: ` : '',
        h('b', {}, identityText))),
    laneActs);

  const sliceGrid = h('div', {
    class: 'ruff-slice-grid',
    'data-lane': activeLane,
    'data-testid': 'ruff-slice-grid',
    role: 'group',
    'aria-label': `Slices for Break ${L} step ${selStep + 1}`,
  });

  if (!breakId && !edited) {
    sliceGrid.classList.add('unassigned');
    sliceGrid.append(
      h('span', { class: 'ruff-unassigned-msg' }, `No break assigned to lane ${L}.`),
      h('button', { type: 'button', class: 'ruff-act on', onclick: () => A.setMode('sound') }, 'Assign in Break Pool'));
  } else {
    for (let k = 0; k < sliceTotal; k++) {
      const info = breakSliceInfo(breakId, k);
      const isCur = !!cell && cell.slice === k;
      const isSug = k === suggested;
      const sb = h('button', {
        type: 'button',
        class: 'ruff-slice-btn'
          + (isCur ? (cell.virtual ? ' orig-on' : ' on') : '')
          + (isSug ? ' sug' : '')
          + (k === 8 ? ' bar2' : ''),
        'data-slice': String(k),
        'data-role': info.role,
        'data-testid': `ruff-slice-${k}`,
        'aria-pressed': String(isCur),
        title: `${info.code} · ${info.label} (${info.pos})${isSug ? ' — suggested for this step' : ''}`,
      },
      h('b', {}, info.code),
      h('span', {}, info.label));
      sb.onclick = () => A.setBreakStepSlice(activeLane, selStep, k);
      sliceGrid.append(sb);
    }
  }

  return h('div', { class: 'ruff-inspector', 'data-lane': activeLane, 'data-testid': 'ruff-inspector' }, head, sliceGrid);
}

function buildCompactView(sl, p, params, activeLane, selStep, rows) {
  const legend = h('div', { class: 'ruff-compact-bar' },
    BREAK_LANES.map(l => {
      const id = (sl && sl.breaks && sl.breaks[l]) || null;
      const desc = id ? getBuiltinBreak(id) : null;
      const kind = laneStatusKind(sl, p, l);
      const muted = !!(params && params[laneMuteKey(l)]);
      const selected = l === activeLane;
      const pill = h('div', {
        class: 'ruff-src-chip' + (selected ? ' sel' : '') + (id ? ' loaded' : '') + (muted ? ' muted' : ''),
        'data-lane': l,
      });
      const mainBtn = h('button', {
        type: 'button',
        class: 'ruff-src-chip-btn',
        title: id ? `Focus Break ${l.toUpperCase()} (${desc ? desc.name : id})` : `Assign Break ${l.toUpperCase()} in SOUND`,
      },
      h('span', { class: 'ruff-dot' }, l.toUpperCase()),
      h('b', {}, desc ? desc.name : (id || 'Empty')),
      h('em', { class: 'ruff-mode-pill ' + kind }, laneStatusText(kind)));
      mainBtn.onclick = () => {
        if (!id && !isBreakLaneEdited(p, l)) A.setMode('sound');
        else A.selectRuffStep(selStep, l);
      };
      const mBtn = h('button', {
        type: 'button',
        class: 'ruff-chip-mute' + (muted ? ' on' : ''),
        disabled: !id,
        'aria-pressed': String(muted),
        title: `Mute Break ${l.toUpperCase()}`,
      }, 'M');
      mBtn.onclick = e => { e.stopPropagation(); A.toggleBreakLaneMute(l); };
      pill.append(mainBtn, mBtn);
      return pill;
    }),
    h('span', { class: 'ruff-sync-tag' }, `${params && params.fitMode === 'tape' ? 'Tape' : 'Stretch'} · 2 Bars`));

  const ruler = h('div', { class: 'ruff-bar-labels', 'aria-hidden': 'true' },
    h('span', {}, 'BAR 1 · Steps 1–8'),
    h('span', {}, 'BAR 2 · Steps 9–16'));

  const grid = h('div', { class: 'ruff-compact-grid', 'data-testid': 'ruff-compact-grid', role: 'group', 'aria-label': '16-step groove overview' });
  const erase = store.ui.tool === 'erase';

  for (let s = 0; s < BREAK_PATTERN_STEPS; s++) {
    const isSel = s === selStep;
    const isBeat = s % 2 === 0;
    const activeLanes = BREAK_LANES.filter(l => !!rows[l][s]);
    const cellBtn = h('button', {
      type: 'button',
      class: 'ruff-cstep'
        + (isSel ? ' sel' : '')
        + (isBeat ? ' beat' : '')
        + (s === 8 ? ' bar2' : '')
        + (activeLanes.length > 1 ? ' multi' : ''),
      'data-step': String(s),
      'data-hits': activeLanes.join(''),
      'data-testid': `ruff-compact-step-${s}`,
      'aria-pressed': String(isSel),
      title: `Step ${s + 1} (${breakStepBeatLabel(s)})${activeLanes.length ? ' · ' + activeLanes.map(l => `${l.toUpperCase()}:S${rows[l][s].slice + 1}`).join(' ') : ' · Empty'}`,
    });

    const numEl = h('span', { class: 'ruff-cstep-num' }, String(s + 1));
    const bands = h('span', { class: 'ruff-cstep-bands' }, BREAK_LANES.map(l => {
      const c = rows[l][s];
      const muted = !!(params && params[laneMuteKey(l)]);
      const cls = 'ruff-band'
        + (c ? (c.virtual ? ' orig' : ' hit') : '')
        + (muted ? ' muted' : '')
        + (l === activeLane ? ' focus' : '');
      return h('span', { class: cls, 'data-lane': l }, c ? `S${c.slice + 1}` : '');
    }));

    cellBtn.append(numEl, bands);
    cellBtn.onclick = () => {
      if (erase) A.eraseBreakStep(activeLane, s);
      else A.selectRuffStep(s);
    };
    stepElsByIndex[s].push(cellBtn);
    grid.append(cellBtn);
  }

  return h('div', { class: 'ruff-compact-wrap' }, legend, ruler, grid);
}

function buildExpandedView(sl, p, params, activeLane, selStep, rows) {
  const ruler = h('div', { class: 'ruff-exp-ruler', 'aria-hidden': 'true' },
    h('div', { class: 'ruff-exp-corner' }, '2 Bars · 16 Slices'),
    h('div', { class: 'ruff-exp-steps-hdr' }, Array.from({ length: BREAK_PATTERN_STEPS }, (_, s) =>
      h('span', { class: (s % 2 === 0 ? 'beat' : '') + (s === 8 ? ' bar2' : '') + (s === selStep ? ' sel' : '') },
        s % 2 === 0 ? breakStepBeatLabel(s) : String(s + 1)))));

  const lanesWrap = h('div', { class: 'ruff-exp-lanes', 'data-testid': 'ruff-expanded-grid' });
  const erase = store.ui.tool === 'erase';

  BREAK_LANES.forEach(l => {
    const L = l.toUpperCase();
    const id = (sl && sl.breaks && sl.breaks[l]) || null;
    const desc = id ? getBuiltinBreak(id) : null;
    const kind = laneStatusKind(sl, p, l);
    const muted = !!(params && params[laneMuteKey(l)]);
    const focused = l === activeLane;
    const row = rows[l];

    const headBtn = h('button', {
      type: 'button',
      class: 'ruff-exp-lbtn',
      title: id ? `Select Break ${L} (${desc ? desc.name : id})` : `Assign a break to ${L} in SOUND`,
    },
    h('span', { class: 'ruff-dot' }, L),
    h('span', { class: 'ruff-exp-lname' },
      h('b', {}, desc ? desc.name : (id || 'Empty')),
      h('small', { class: 'ruff-mode-pill ' + kind }, laneStatusText(kind))));
    headBtn.onclick = () => {
      if (!id && !isBreakLaneEdited(p, l)) A.setMode('sound');
      else A.selectRuffStep(selStep, l);
    };

    const muteBtn = h('button', {
      type: 'button',
      class: 'ruff-chip-mute' + (muted ? ' on' : ''),
      disabled: !id,
      'aria-pressed': String(muted),
      title: `Mute Break ${L}`,
    }, 'M');
    muteBtn.onclick = e => { e.stopPropagation(); A.toggleBreakLaneMute(l); };

    const head = h('div', { class: 'ruff-exp-head' }, headBtn, muteBtn);
    const cells = h('div', { class: 'ruff-exp-cells' });

    for (let s = 0; s < BREAK_PATTERN_STEPS; s++) {
      const c = row[s];
      const isSel = focused && s === selStep;
      const isBeat = s % 2 === 0;
      const cellBtn = h('button', {
        type: 'button',
        class: 'ruff-ecell'
          + (c ? (c.virtual ? ' orig' : ' hit') : '')
          + (isSel ? ' sel' : '')
          + (isBeat ? ' beat' : '')
          + (s === 8 ? ' bar2' : '')
          + (muted ? ' muted' : ''),
        'data-lane': l,
        'data-step': String(s),
        'data-slice': c ? String(c.slice) : '',
        'data-testid': `ruff-cell-${l}-${s}`,
        'aria-pressed': String(!!c),
        disabled: !id && !isBreakLaneEdited(p, l),
        title: c
          ? `Break ${L} · Step ${s + 1} (${breakStepBeatLabel(s)}) · S${c.slice + 1} ${breakSliceInfo(id, c.slice).label}${c.virtual ? ' (Original)' : ''}`
          : `Break ${L} · Step ${s + 1} (${breakStepBeatLabel(s)}) · Empty (tap to add S${suggestedSliceForStep(id, s, p.len) + 1})`,
      }, c ? `S${c.slice + 1}` : '');

      cellBtn.onclick = () => {
        if (erase) {
          A.eraseBreakStep(l, s);
          return;
        }
        if (!c) {
          A.toggleBreakStep(l, s);
          return;
        }
        if (store.ui.ruff.selLane === l && store.ui.ruff.selStep === s) {
          A.toggleBreakStep(l, s);
        } else {
          A.selectRuffStep(s, l);
        }
      };
      stepElsByIndex[s].push(cellBtn);
      cells.append(cellBtn);
    }

    lanesWrap.append(h('div', {
      class: 'ruff-exp-row' + (focused ? ' focus' : '') + (muted ? ' muted' : '') + (id ? ' loaded' : ''),
      'data-lane': l,
      'data-testid': `ruff-lane-${l}`,
    }, head, cells));
  });

  return h('div', { class: 'ruff-exp-wrap' }, ruler, lanesWrap);
}

/** Render the RUFF Hybrid Sequencer inside `#ruffSeq` without mutating project data. */
export function renderRuffSequencer() {
  const host = $('#ruffSeq');
  if (!host || !isBreakSlot()) return;
  const sl = slot(), p = pat(), params = P(), m = typeOf();
  host.innerHTML = '';
  stepElsByIndex = Array.from({ length: BREAK_PATTERN_STEPS }, () => []);
  lastPlayStep = -1;

  const anyEdited = BREAK_LANES.some(l => isBreakLaneEdited(p, l));
  if (!hasAssignedBreak(sl) && !anyEdited) {
    host.dataset.view = 'empty';
    host.append(buildEmptyState(m));
    return;
  }

  const view = store.ui.ruff.view === 'expanded' ? 'expanded' : 'compact';
  const selStep = Math.max(0, Math.min(BREAK_PATTERN_STEPS - 1, store.ui.ruff.selStep || 0));
  const activeLane = resolveActiveLane(sl, p);
  const rows = Object.fromEntries(BREAK_LANES.map(l => [l, effectiveBreakRow(p, l, sl && sl.breaks && sl.breaks[l])]));

  host.dataset.view = view;
  const mainGrid = view === 'expanded'
    ? buildExpandedView(sl, p, params, activeLane, selStep, rows)
    : buildCompactView(sl, p, params, activeLane, selStep, rows);
  const inspector = buildInspector(sl, p, params, activeLane, selStep, rows);

  host.append(mainGrid, inspector);
  updateRuffPlayhead(true);
}

/** Update the live 16-step (2-bar) playhead highlight without rebuilding DOM. */
export function updateRuffPlayhead(force = false) {
  if (!isBreakSlot() || store.ui.mode !== 'jam') return;
  const live = A.transport.playing && playhead.scene === store.project.scene && playhead.step >= 0;
  const step = live ? Math.floor((playhead.step % BREAK_LOOP_STEPS) / BREAK_STEP_SPAN) : -1;
  if (!force && step === lastPlayStep) return;
  if (lastPlayStep >= 0 && stepElsByIndex[lastPlayStep]) {
    stepElsByIndex[lastPlayStep].forEach(el => el.classList.remove('now'));
  }
  if (step >= 0 && stepElsByIndex[step]) {
    stepElsByIndex[step].forEach(el => el.classList.add('now'));
  }
  lastPlayStep = step;
}
