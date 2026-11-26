// RUFF Unified Sequencer & CHOP IT! (v0.7 PR34):
// One unified 16-step / 2-bar A/B/C sequencer with integrated CHOP IT! controls,
// full lock protection (cell hits, locked empty silence, columns, lanes) and contextual slice inspector.
//
// Core principle: Play first. Tweak forever.
// - Renders directly from the single scene-local pattern (`pat()`) and mutates only through `src/app/actions.js`.
// - Opening/inspecting NEVER mutates project data; unedited assigned breaks show their original 2-bar groove
//   via `effectiveBreakRow()`.
// - Each of the 16 steps maps to 1 eighth-note across 2 bars (Steps 1–8 = Bar 1, Steps 9–16 = Bar 2).

import { store, slot, pat, P, typeOf, isBreakSlot } from '../app/store.js';
import * as A from '../app/actions.js';
import { BREAK_LANES } from '../core/instruments.js';
import {
  BREAK_PATTERN_STEPS, BREAK_STEP_SPAN, BREAK_LOOP_STEPS,
  getBuiltinBreak, hasAssignedBreak, laneMuteKey,
  isBreakLaneEdited, effectiveBreakRow, suggestedSliceForStep, breakSliceInfo,
  breakSliceCount, breakStepBeatLabel, isBreakLaneLocked, isBreakStepColumnLocked,
  isBreakCellDirectlyLocked, isBreakCellLocked,
} from '../core/breaks.js';
import { RUFF_CHOP_PROFILES, RUFF_PROFILE_META } from '../music/ruffchop.js';
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
        h('p', {}, 'Load a break into A, B or C in Break Pool to hear its original 2-bar groove, then slice or CHOP IT! here.'),
        h('div', { class: 'ruff-empty-actions' },
          h('button', { type: 'button', class: 'btn tool on', 'data-action': 'open-pool', onclick: () => A.setMode('sound') }, 'Open RUFF Break Pool')))));
}

function buildChopBar(sl) {
  const u = store.ui.ruff;
  const mode = u.chopMode === 'evolve' ? 'evolve' : 'new';
  const profile = RUFF_CHOP_PROFILES.includes(u.profile) ? u.profile : 'jungle';
  const intensity = Number.isFinite(u.intensity) ? u.intensity : 0.5;
  const pct = Math.round(intensity * 100);
  const canChop = hasAssignedBreak(sl);

  const modeSeg = h('div', {
    class: 'ruff-chop-mode',
    role: 'group',
    'aria-label': 'CHOP IT! mode',
    'data-testid': 'ruff-chop-mode',
  },
  [['new', 'New Groove', 'Create a fresh arrangement from active breaks'], ['evolve', 'Evolve', 'Transform the current audible pattern']].map(([id, label, tip]) => {
    const b = h('button', {
      type: 'button',
      class: 'ruff-cm-btn' + (mode === id ? ' on' : ''),
      'data-mode': id,
      'data-testid': `ruff-mode-${id}`,
      'aria-pressed': String(mode === id),
      title: tip,
    }, label);
    b.onclick = () => A.setRuffChopMode(id);
    return b;
  }));

  const profGroup = h('div', {
    class: 'ruff-chop-profiles',
    role: 'group',
    'aria-label': 'Musical profile',
    'data-testid': 'ruff-chop-profiles',
  },
  RUFF_CHOP_PROFILES.map(id => {
    const meta = RUFF_PROFILE_META[id];
    const active = profile === id;
    const b = h('button', {
      type: 'button',
      class: 'ruff-prof-btn' + (active ? ' on' : ''),
      'data-profile': id,
      'data-testid': `ruff-profile-${id}`,
      'aria-pressed': String(active),
      title: `${meta.label} — ${meta.desc}`,
    },
    h('span', { class: 'ruff-prof-full' }, meta.label),
    h('span', { class: 'ruff-prof-short', 'aria-hidden': 'true' }, meta.shortLabel));
    b.onclick = () => A.setRuffChopProfile(id);
    return b;
  }));

  const range = h('input', {
    type: 'range',
    class: 'ruff-int-range',
    min: '0',
    max: '100',
    step: '1',
    value: String(pct),
    'data-testid': 'ruff-intensity',
    'aria-label': 'CHOP IT! intensity from Subtle to Wild',
    'aria-valuetext': `${pct}% (${pct < 34 ? 'Subtle' : pct < 72 ? 'Balanced' : 'Wild'})`,
  });
  range.style.setProperty('--val', `${pct}%`);
  range.oninput = () => {
    const p = Math.max(0, Math.min(100, Number(range.value) || 0));
    range.style.setProperty('--val', `${p}%`);
    range.setAttribute('aria-valuetext', `${p}% (${p < 34 ? 'Subtle' : p < 72 ? 'Balanced' : 'Wild'})`);
    A.setRuffChopIntensity(p / 100, { silent: true });
  };
  range.onchange = () => {
    const p = Math.max(0, Math.min(100, Number(range.value) || 0));
    A.setRuffChopIntensity(p / 100, { silent: true });
  };

  const intWrap = h('div', { class: 'ruff-int-wrap', 'data-testid': 'ruff-intensity-wrap' },
    h('span', { class: 'ruff-int-lbl' }, 'Subtle'),
    range,
    h('span', { class: 'ruff-int-lbl' }, 'Wild'));

  const chopBtn = h('button', {
    type: 'button',
    class: 'ruff-chop-go',
    'data-testid': 'ruff-chop-btn',
    disabled: !canChop,
    title: canChop
      ? `Apply ${RUFF_PROFILE_META[profile].label} (${mode === 'evolve' ? 'Evolve' : 'New Groove'}) immediately · Undoable`
      : 'Assign a break in Break Pool first',
  },
  h('span', { class: 'ruff-chop-go-i', html: ico('scissors') }),
  h('span', {}, 'CHOP IT!'));
  chopBtn.onclick = () => A.chopRuff();

  return h('div', { class: 'ruff-chop-bar', 'data-testid': 'ruff-chop-bar' },
    modeSeg, profGroup, intWrap, chopBtn);
}

function buildUnifiedGrid(sl, p, params, activeLane, selStep, rows) {
  const tool = store.ui.tool;
  const fitLabel = params && params.fitMode === 'tape' ? 'Tape' : 'Stretch';

  const ruler = h('div', { class: 'ruff-exp-ruler' },
    h('div', { class: 'ruff-exp-corner', title: `${fitLabel} · 2 Bars · 16 Slices · Tap step numbers to lock columns` },
      h('span', {}, '2 Bars'),
      h('small', {}, fitLabel)),
    h('div', { class: 'ruff-exp-steps-hdr', role: 'group', 'aria-label': 'Step column locks' },
      Array.from({ length: BREAK_PATTERN_STEPS }, (_, s) => {
        const colLocked = isBreakStepColumnLocked(p, s);
        const colBtn = h('button', {
          type: 'button',
          class: 'ruff-col-btn'
            + (s % 2 === 0 ? ' beat' : '')
            + (s === 8 ? ' bar2' : '')
            + (s === selStep ? ' sel' : '')
            + (colLocked ? ' locked' : ''),
          'data-step': String(s),
          'data-testid': `ruff-col-lock-${s}`,
          'aria-pressed': String(colLocked),
          title: colLocked
            ? `Unlock step ${s + 1} (${breakStepBeatLabel(s)}) across A/B/C`
            : `Lock step ${s + 1} (${breakStepBeatLabel(s)}) across A/B/C`,
        },
        h('span', { class: 'ruff-col-lbl' }, s % 2 === 0 ? breakStepBeatLabel(s) : String(s + 1)),
        colLocked ? h('span', { class: 'ruff-lock-pip', html: ico('lock') }) : null);
        colBtn.onclick = () => A.toggleBreakColumnLock(s);
        return colBtn;
      })));

  const lanesWrap = h('div', { class: 'ruff-exp-lanes', 'data-testid': 'ruff-expanded-grid' });

  BREAK_LANES.forEach(l => {
    const L = l.toUpperCase();
    const id = (sl && sl.breaks && sl.breaks[l]) || null;
    const desc = id ? getBuiltinBreak(id) : null;
    const kind = laneStatusKind(sl, p, l);
    const muted = !!(params && params[laneMuteKey(l)]);
    const laneLocked = isBreakLaneLocked(p, l);
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

    const lockBtn = h('button', {
      type: 'button',
      class: 'ruff-chip-lock' + (laneLocked ? ' on' : ''),
      'data-testid': `ruff-lane-lock-${l}`,
      'aria-pressed': String(laneLocked),
      'aria-label': laneLocked ? `Unlock Break ${L} lane` : `Lock Break ${L} lane`,
      title: laneLocked ? `Unlock Break ${L} lane` : `Lock entire Break ${L} lane`,
    }, h('span', { class: 'ruff-lock-i', html: ico('lock') }));
    lockBtn.onclick = e => { e.stopPropagation(); A.toggleBreakLaneLock(l); };

    const muteBtn = h('button', {
      type: 'button',
      class: 'ruff-chip-mute' + (muted ? ' on' : ''),
      disabled: !id,
      'aria-pressed': String(muted),
      title: `Mute Break ${L}`,
    }, 'M');
    muteBtn.onclick = e => { e.stopPropagation(); A.toggleBreakLaneMute(l); };

    const head = h('div', { class: 'ruff-exp-head' }, headBtn, lockBtn, muteBtn);
    const cells = h('div', { class: 'ruff-exp-cells' });

    for (let s = 0; s < BREAK_PATTERN_STEPS; s++) {
      const c = row[s];
      const isSel = focused && s === selStep;
      const isBeat = s % 2 === 0;
      const colLocked = isBreakStepColumnLocked(p, s);
      const cellDirectLock = isBreakCellDirectlyLocked(p, l, s);
      const locked = laneLocked || colLocked || cellDirectLock;
      const disabled = !id && !isBreakLaneEdited(p, l) && !cellDirectLock;

      const lockTag = locked
        ? (laneLocked ? ' · Lane locked' : colLocked ? ' · Column locked' : ' · Locked')
        : '';

      const cellBtn = h('button', {
        type: 'button',
        class: 'ruff-ecell'
          + (c ? (c.virtual ? ' orig' : ' hit') : '')
          + (isSel ? ' sel' : '')
          + (isBeat ? ' beat' : '')
          + (s === 8 ? ' bar2' : '')
          + (muted ? ' muted' : '')
          + (locked ? ' locked' : '')
          + (locked && !c ? ' locked-empty' : '')
          + (cellDirectLock ? ' locked-direct' : '')
          + (colLocked ? ' locked-col' : '')
          + (laneLocked ? ' locked-lane' : '')
          + (tool === 'lock' ? ' lock-mode' : ''),
        'data-lane': l,
        'data-step': String(s),
        'data-slice': c ? String(c.slice) : '',
        'data-locked': locked ? 'true' : 'false',
        'data-testid': `ruff-cell-${l}-${s}`,
        'aria-pressed': String(!!c),
        disabled,
        title: c
          ? `Break ${L} · Step ${s + 1} (${breakStepBeatLabel(s)}) · S${c.slice + 1} ${breakSliceInfo(id, c.slice).label}${c.virtual ? ' (Original)' : ''}${lockTag}`
          : `Break ${L} · Step ${s + 1} (${breakStepBeatLabel(s)}) · ${locked ? 'Locked Silence' : `Empty (tap to add S${suggestedSliceForStep(id, s, p.len) + 1})`}${lockTag}`,
      },
      h('span', { class: 'ruff-ecell-txt' }, c ? `S${c.slice + 1}` : (locked ? '—' : '')),
      locked ? h('span', { class: 'ruff-ecell-lock', html: ico('lock') }) : null);

      cellBtn.onclick = () => {
        if (tool === 'lock') {
          A.toggleBreakCellLock(l, s);
          return;
        }
        if (tool === 'erase') {
          A.eraseBreakStep(l, s);
          return;
        }
        if (locked) {
          A.selectRuffStep(s, l);
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
      class: 'ruff-exp-row' + (focused ? ' focus' : '') + (muted ? ' muted' : '') + (id ? ' loaded' : '') + (laneLocked ? ' lane-locked' : ''),
      'data-lane': l,
      'data-testid': `ruff-lane-${l}`,
    }, head, cells));
  });

  return h('div', { class: 'ruff-exp-wrap' }, ruler, lanesWrap);
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

  const laneLocked = isBreakLaneLocked(p, activeLane);
  const colLocked = isBreakStepColumnLocked(p, selStep);
  const cellDirectLock = isBreakCellDirectlyLocked(p, activeLane, selStep);
  const cellLocked = isBreakCellLocked(p, activeLane, selStep);

  // Lane tabs inside inspector showing A/B/C status at the selected step
  const laneTabs = h('div', { class: 'ruff-insp-lanes', role: 'group', 'aria-label': `Step ${selStep + 1} lanes` },
    BREAK_LANES.map(l => {
      const lId = sl && sl.breaks && sl.breaks[l];
      const lCell = rows[l][selStep];
      const lEdited = isBreakLaneEdited(p, l);
      const lMuted = !!(params && params[laneMuteKey(l)]);
      const lLocked = isBreakCellLocked(p, l, selStep);
      const active = l === activeLane;
      const badge = lCell ? `S${lCell.slice + 1}` : (lId || lEdited ? '—' : 'Off');
      const b = h('button', {
        type: 'button',
        class: 'ruff-insp-lane'
          + (active ? ' sel' : '')
          + (lCell ? (lCell.virtual ? ' orig' : ' hit') : '')
          + (lMuted ? ' muted' : '')
          + (lLocked ? ' locked' : ''),
        'data-lane': l,
        'data-testid': `ruff-insp-lane-${l}`,
        'aria-pressed': String(active),
        title: `Inspect Break ${l.toUpperCase()} at step ${selStep + 1}${lLocked ? ' (Locked)' : ''}`,
      },
      h('span', { class: 'ruff-dot' }, l.toUpperCase()),
      h('span', { class: 'ruff-insp-lane-val' }, badge),
      lLocked ? h('span', { class: 'ruff-insp-lock-pip', html: ico('lock') }) : null);
      b.onclick = () => A.selectRuffStep(selStep, l);
      return b;
    }));

  const lockSuffix = laneLocked ? ' · Lane Locked' : colLocked ? ' · Col Locked' : cellDirectLock ? ' · Locked' : '';
  const identityText = !breakId && !edited
    ? `Break ${L} unassigned`
    : cell
      ? `${sliceInfo.code} · ${sliceInfo.label}${cell.virtual ? ' (Orig)' : ''}${lockSuffix}`
      : cellLocked
        ? `Locked Silence${laneLocked ? ' (Lane)' : colLocked ? ' (Col)' : ''}`
        : `Empty · Suggested ${breakSliceInfo(breakId, suggested).code} (${breakSliceInfo(breakId, suggested).label})`;

  const toggleBtn = h('button', {
    type: 'button',
    class: 'ruff-act' + (cell ? ' on' : ''),
    'data-testid': 'ruff-step-toggle',
    disabled: (!breakId && !edited) || cellLocked,
    'aria-pressed': String(!!cell),
    title: cellLocked
      ? 'Unlock this step before editing'
      : cell
        ? `Remove ${L} hit on step ${selStep + 1}`
        : `Add ${L} hit on step ${selStep + 1} (${breakSliceInfo(breakId, suggested).code})`,
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

  const cellLockBtn = h('button', {
    type: 'button',
    class: 'ruff-act lock' + (cellDirectLock ? ' on' : (cellLocked ? ' inherited' : '')),
    'data-testid': 'ruff-cell-lock',
    disabled: !breakId && !edited && !cellDirectLock,
    'aria-pressed': String(cellDirectLock),
    title: cellDirectLock
      ? `Unlock ${L} step ${selStep + 1}`
      : cellLocked
        ? `Protected by ${laneLocked ? `Break ${L} lane lock` : `step ${selStep + 1} column lock`} · tap to also lock this cell`
        : `Lock ${L} step ${selStep + 1} (${cell ? 'protect hit' : 'protect silence'})`,
  },
  h('span', { class: 'ruff-act-i', html: ico('lock') }),
  h('span', {}, cellDirectLock ? 'Locked' : (cellLocked ? (laneLocked ? 'Lane 🔒' : 'Col 🔒') : 'Lock')));
  cellLockBtn.onclick = () => A.toggleBreakCellLock(activeLane, selStep);

  const laneActs = h('div', { class: 'ruff-insp-acts' }, toggleBtn, hearBtn, cellLockBtn);
  if (edited) {
    const clearBtn = h('button', {
      type: 'button',
      class: 'ruff-act subtle',
      'data-testid': 'ruff-lane-clear',
      disabled: kind === 'silent' || laneLocked,
      title: laneLocked ? `Break ${L} is locked` : `Clear unlocked steps on Break ${L} (silent)`,
    }, 'Silence');
    clearBtn.onclick = () => A.clearBreakLane(activeLane);

    const resetBtn = h('button', {
      type: 'button',
      class: 'ruff-act subtle',
      'data-testid': 'ruff-lane-reset',
      disabled: laneLocked,
      title: laneLocked ? `Break ${L} is locked` : `Restore Break ${L} to its original groove`,
    }, 'Orig');
    resetBtn.onclick = () => A.resetBreakLane(activeLane);
    laneActs.append(clearBtn, resetBtn);
  } else if (breakId) {
    const clearBtn = h('button', {
      type: 'button',
      class: 'ruff-act subtle',
      'data-testid': 'ruff-lane-clear',
      disabled: laneLocked,
      title: laneLocked ? `Break ${L} is locked` : `Clear Break ${L} to silence`,
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
    class: 'ruff-slice-grid' + (cellLocked ? ' locked' : ''),
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
        disabled: cellLocked,
        title: cellLocked
          ? `Unlock step ${selStep + 1} to change slice`
          : `${info.code} · ${info.label} (${info.pos})${isSug ? ' — suggested for this step' : ''}`,
      },
      h('b', {}, info.code),
      h('span', {}, info.label));
      sb.onclick = () => A.setBreakStepSlice(activeLane, selStep, k);
      sliceGrid.append(sb);
    }
  }

  return h('div', { class: 'ruff-inspector', 'data-lane': activeLane, 'data-testid': 'ruff-inspector' }, head, sliceGrid);
}

/** Render the Unified RUFF Sequencer & CHOP IT! inside `#ruffSeq` without mutating project data. */
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

  const selStep = Math.max(0, Math.min(BREAK_PATTERN_STEPS - 1, store.ui.ruff.selStep || 0));
  const activeLane = resolveActiveLane(sl, p);
  const rows = Object.fromEntries(BREAK_LANES.map(l => [l, effectiveBreakRow(p, l, sl && sl.breaks && sl.breaks[l])]));

  host.dataset.view = 'unified';
  const chopBar = buildChopBar(sl);
  const mainGrid = buildUnifiedGrid(sl, p, params, activeLane, selStep, rows);
  const inspector = buildInspector(sl, p, params, activeLane, selStep, rows);

  host.append(chopBar, mainGrid, inspector);
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
