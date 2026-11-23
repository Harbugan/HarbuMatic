# v0.6.1 — iPad UX Review & Polish Plan
Captured 2026-11-23. Planning reference only; no implementation authorized.

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
| UX-14 | MUNCH CHOP | DECIDED / OBSERVED | Waveform, all 8 pads, slice sequencer and MAGIC CHOP visible simultaneously in iPad landscape, no routine scrolling. No pads/sequencer mode switch. Keep manual slice marker editing, Split/Chop, and existing style. Screenshot clips lower content. |
| UX-15 | CHOP local preview | DECIDED goal / OPEN technical behavior | Dedicated Play/Stop previews only current MUNCH slice pattern, loops from step 1 at BPM, shows playhead and reflects live step edits; must not start global loop/song. Reuse scheduler/engine. Investigate behavior when global playback is active to avoid double MUNCH, and stop/voice semantics. |
| UX-16 | Responsive | DECIDED | Physical iPad landscape checks, 11/13-inch plus smaller supported widths, Deep Edit, no clipping or tiny hit targets. |

## Mode-specific workspace decision
JAM keeps sequencer + Lab + bottom Sound Shapers/FX. SOUND and ARRANGE reclaim the bottom strip's vertical space for their own workspaces. MUNCH is a SOUND workspace: retain empty/PLAY/TWIST patterns; focus on CHOP layout and local preview. No-scroll-by-default applies to typical content, not arbitrarily large projects.

## Proposed implementation grouping — NOT authorized yet
1. Small fixes UX-01..04.
2. Responsive shell and SOUND/ARRANGE layouts UX-05..09,16, prototype and owner review.
3. MUNCH CHOP UX-14..15, first inspect scheduler and transport.
4. Musical playability UX-10 and final polish.

## Verification and open decisions
- Separate decided, implemented, automated-tested and owner-verified status.
- PRs require relevant unit/UI/baseline checks, physical iPad acceptance and no regressions in audio, transport, scenes or current-version .hbn.
- OPEN: compact-top interaction/persistence; fallback when controls cannot fit small landscape screens; CHOP preview during global playback; first-run/demo-track improvements.
- Out of scope: v0.7 Ruff in the Jungle, v0.9 Song WAV Export, unrelated engine rewrites.
