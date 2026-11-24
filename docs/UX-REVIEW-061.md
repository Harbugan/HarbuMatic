# v0.6.1 — iPad UX Review & Polish Plan
Captured 2026-11-23; updated 2026-11-24. This document tracks decisions and scope. HBM-061-04 is merged and owner-accepted. HBM-061-05 (UX-14/15) is implemented and owner-accepted after PR #25 and the PR #26 fix restored via PR #27; Live Pattern Recording is next for scoping. Other proposed items remain planning only.

## Status legend
DECIDED = owner-approved direction; OBSERVED = owner screenshot/feedback; PROPOSED = design hypothesis; OPEN = needs technical/product decision; DONE = merged and owner-verified.

## Baseline
DONE: five always-available instruments, Quick Volume and M/S alignment, Dynamic Scenes (one scene for new songs, independent pattern duplication, 64 maximum). Preserve working audio, transport, project save/reopen and current-version .hbn. Historical pre-v0.6.1 project migration not required.

DECIDED: Play first, tweak forever. Retain existing kawaii hardware visual identity. No-scroll-by-default for ordinary workflows on 11/13-inch landscape iPad; never shrink controls below comfortable touch sizes to force a fit. Large scene collections may scroll.

## Tracked UX findings

| ID | Area | Status | Requirement / finding |
| --- | --- | --- | --- |
| UX-01 | Instrument selection | DECIDED / OBSERVED | Card tap only selects instrument, no automatic audition note. Pads/keys and deliberate audition still sound. |
| UX-02 | Version/footer | DECIDED / OBSERVED | Screenshot shows v0.5.1; correct version through canonical release process and place footer lower/discreetly, preserving exact creator credit `Created by .::H∆RBUGΛП::.`. No arbitrary bump in unrelated PR. |
| UX-03 | Navigation | DECIDED | Top order JAM → SOUND → ARRANGE. |
| UX-04 | Lab drawer | DECIDED / OBSERVED | Deep Edit LAB/SCENES close X is misaligned at top right; correct alignment/inset on iPad. |
| UX-05 | Top area | PROPOSED | Explore collapsible/compact header + transport + five instrument cards, preserving Play/Stop, selection, Quick Volume and character identity. 20% of expanded height is aspirational, not a hard specification. |
| UX-06 | JAM | PROPOSED | Sequencer first; retain Lab and bottom Sound Shapers/FX here. Reduce competing chrome. |
| UX-07 | SOUND | DECIDED direction / OBSERVED | BOP screenshot: unused right-side space while Channel knobs clip below. Use responsive multi-column layout for presets and all relevant controls. Reclaim bottom strip and avoid duplicate controls. |
| UX-08 | ARRANGE | DECIDED direction / OBSERVED | Song empty-state, headers and action row consume height; scene tile clips. Reclaim bottom strip, preserve existing Song/Scene Library cards and actions, use space more efficiently. |
| UX-09 | Presets | PROPOSED | Improve discoverability, active selection feedback and fast audition. |
| UX-10 | Musical reward | PROPOSED | Review Generate, Mutate, Evolve, Remix, Surprise, Lab and MAGIC CHOP for useful results; preserve user control and Undo. |
| UX-11 | MUNCH empty | OBSERVED / preserve | Feed me a sound, large RECORD/IMPORT and mascot work well. |
| UX-12 | MUNCH PLAY | OBSERVED / preserve | Waveform and playable keyboard use space well. |
| UX-13 | MUNCH TWIST | OBSERVED / preserve | Parameter grouping works well; minor bottom-edge polish. |
| UX-14 | MUNCH CHOP | IMPLEMENTED / OWNER-ACCEPTED 2026-11-24 | Waveform, all 8 pads, slice sequencer and MAGIC CHOP visible simultaneously in iPad landscape, no routine scrolling. No pads/sequencer mode switch. Keep manual slice marker editing, Split/Chop, and existing style. Screenshot clips lower content. |
| UX-15 | CHOP local preview | IMPLEMENTED / OWNER-ACCEPTED 2026-11-24 | Dedicated Play/Stop previews only current MUNCH slice pattern, loops from step 1 at BPM, shows playhead and reflects live step edits; must not start global loop/song. Reuse scheduler/engine. Investigate behavior when global playback is active to avoid double MUNCH, and stop/voice semantics. |
| UX-16 | Responsive | DECIDED | Physical iPad landscape checks, 11/13-inch plus smaller supported widths, Deep Edit, no clipping or tiny hit targets. |
| UX-17 | Deep Edit toolbar stability | DECIDED / OBSERVED | Switching BOP → BLIP introduces melodic controls (In key, Oct) and wraps Lab/Clear/Done onto a second row. Common actions must remain in stable, predictable positions regardless of instrument name, scene label or tool count. Use a dedicated instrument-control zone and intentional narrow-screen fallback; preserve comfortable touch targets and all actions. |

## Mode-specific workspace decision
JAM keeps sequencer + Lab + bottom Sound Shapers/FX. SOUND and ARRANGE reclaim the bottom strip's vertical space for their own workspaces. MUNCH is a SOUND workspace: retain empty/PLAY/TWIST patterns; focus on CHOP layout and local preview. No-scroll-by-default applies to typical content, not arbitrarily large projects.

## Agreed implementation sequence — 2026-11-24
One task → one PR → physical iPad test → owner approval → merge. Do not bundle stages.

1. **DONE:** HBM-061-03 / PR #21 (UX-01..04) and HBM-061-04 / PR #23 (UX-07,08,16,17) merged; owner accepted physical iPad testing on 2026-11-24. UX-02 release-version bump remains separate.
2. **DONE / OWNER-ACCEPTED: HBM-061-05 — MUNCH CHOP UX-14/15.** PR #25 delivered full CHOP landscape workspace and isolated local slice Preview/Stop. Physical iPad testing passed 35/36 initially, with row 8 bottom-edge clipping remaining. PR #26 fixed the clipping; PR #27 restored the fix to `main` after it was merged to the wrong branch. Owner confirmed the final iPad layout looks correct on 2026-11-24. PR #26 reported 271/271 unit tests and UI/baseline checks; not independently rerun for this documentation update.
3. **NEXT / TO SCOPE: Live Pattern Recording.** Play live pads/keyboard and record editable sequencer events, not sample audio. Decide quantization, overdub, undo and transport semantics before implementation; no implementation authorization implied by this status update.
4. **THEN: Preset UX + Musical Playability (UX-09/10).** Review preset discoverability/audition and musical usefulness of creative actions; split into focused PRs if necessary.
5. **LAST: Compact Top (UX-05) + final v0.6.1 QA.** Explore compact/collapsible header as a separate design decision, run regression and physical iPad release checks, and handle release-version bump separately.

### HBM-061-05 implementation entry points (main, 2026-11-24)
- `src/views/munch.js`: `chop()` composes tools, pads, MAGIC CHOP and `sequencer()`; `bindPad()` handles live pad presses; `munchStep()` displays existing global playhead.
- `src/views/munch-wave.js`: waveform, slice markers and touch editing.
- `src/audio/scheduler.js`: `createTransport()` handles global transport; PR #25 added `createSlicePreview()` for local CHOP pattern playback.
- `styles/views.css`: MUNCH CHOP responsive layout rules. Inspect actual selectors and test coverage locally before changes.

### HBM-061-05 decisions and verification
- Starting CHOP Preview during global playback pauses global transport to avoid double MUNCH; local Stop silences preview voices only.
- Local Preview uses the existing audio engine and scheduler infrastructure, supporting live edits and playhead synchronization.
- Very short landscape and portrait retain intentional scrolling; typical landscape shows all eight sequencer rows after PR #26/#27.
- Owner accepted the final physical iPad result on 2026-11-24.

## Verification and open decisions
- Separate decided, implemented, automated-tested and owner-verified status.
- PRs require relevant unit/UI/baseline checks, physical iPad acceptance and no regressions in audio, transport, scenes or current-version .hbn.
- OPEN: compact-top interaction/persistence; fallback for unusually small landscape screens; Live Pattern Recording quantization/overdub/Undo/transport semantics; first-run/demo-track improvements.
- Out of scope: v0.7 Ruff in the Jungle, v0.9 Song WAV Export, unrelated engine rewrites.
