# HarbuMatic — Product Roadmap

> **A little machine for making music.**  
> Last updated: 2026-11-26 (RUFF PR31–33 merged; PR34 CHOP IT! unified UX and genre-based behavior approved for specification, not implemented)  
> Status: Living product roadmap — version assignments are provisional unless explicitly marked as decided.

## Development baseline — decided 2026-11-23

**Version-by-version experimental development:** v0.6.1 establishes a new baseline for project and scene data. During pre-1.0 development, older `.hbn`/JSON projects and browser-stored test projects are disposable and need not migrate or remain readable. Do not add legacy migration layers or compatibility tests unless explicitly requested. A version change may reset test data when needed; warn before destructive changes and never silently delete data. Preserve working audio, transport, instruments, UI, current-version save/reopen, and `.hbn` round-trip behavior. Retain Git history as the recovery path. This policy is about old project data, not permission to introduce regressions.

## Product direction

**The Playful Groovebox, with the personality of a Musical Toy.**

HarbuMatic is an original, tactile, whimsical music-making instrument. It should be easy to start, rewarding to experiment with, and deep enough to finish actual tracks — without feeling like a conventional DAW wearing cute graphics.

**Product principles**
- **iPad/tablet first:** touch, landscape-first composition, and an excellent iPad Safari experience; desktop is secondary.
- **Play first, tweak forever:** immediate results, with advanced controls available when wanted.
- **Musically useful surprises:** controlled chaos, coherent rhythms, harmony, and instrument interplay.
- **Five instruments in v0.6:** BOP, GOO, BLIP, FUZZ and MUNCH are available together. Slot identity is independent of instrument type; user-facing replacement and slot management are deferred.
- **Personality matters:** warm tactile UI, kawaii headphone-wearing characters, small reactive animations, and UNI.
- **Portable foundation:** modular audio/music/state/UI boundaries, versioned project data, and a credible future native-app path.
- **Create and keep:** easy projects, eventual audio export, and offline-first use where feasible.

## Roadmap overview

| Version | Theme | Intended outcome | Status |
| --- | --- | --- | --- |
| **v0.5** | The Foundation | Tablet-first UX, modular architecture, better JAM/ARRANGE, musical generation, reliability | **Live** |
| **v0.5.1** | Bugfix & UI Polish | BOP sequencer reliability, knob shadows, navigation, alignment, release identity | **Accepted** — BUG-001…004 user-verified on iPad; remaining minor polish deferred |
| **v0.6** | Sample Playground | Instrument foundation, five slots, MUNCH sampler, PLAY/CHOP/TWIST and .hbn | Phase 4 merged; **MUNCH stabilization** (mic, storage, retrigger, Stretch/Tape) implemented and owner-verified on physical iPad 2026-11-24; low mic recording level tracked as non-blocking MUNCH-5; Phase 5A (.hbn) merged in PR #13; WAV export moved to v0.9 |
| **v0.6.1** | Dynamic Scenes & Playability | One scene by default; create, duplicate, copy, rename and delete scenes; focused iPad UX polish | **Physical iPad QA accepted (7/7 final checks)** — PR #15/#18/#21/#23/#25/#27/#29 merged; automated release regression checks still outstanding; next Ruff v0.7 after release gate; Preset UX deferred to final pre-1.0 polish |
| **v0.7** | **Ruff in the Jungle** | Standalone sixth breakbeat instrument, hybrid Break Pool, CHOP IT!, live pads | **In progress:** PR31 foundation, PR32 first breaks and PR33 slicing/hybrid sequencer merged; PR33 physical iPad QA 22/22 PASS; PR34 CHOP IT! next (not implemented) |
| **v0.8** | Play Together | Live performance, MIDI Clock, Ableton Link feasibility/integration | Proposed scope |
| **v0.9** | Expand & Finish | The Catpound instrument selection and replacement, Song WAV Export, automation, stronger finishing tools | Replacement and Scene Library placement decided; other scope proposed |
| **Pre-v1.0** | Preset UX + Musical Playability | Final preset/audition and creative-quality polish after v0.9 | Planned final polish milestone |
| **v1.0** | The Little Music Machine | Stable, polished, installable tablet music app | Target |
| **v1.1 (proposed)** | The Skin Playground | Optional visual themes and character universes, without changing musical behavior | Post-1.0 proposal |

The roadmap is directional, **not** a promise of release dates or a locked implementation order.

## Future instrument experience — The Catpound (decided concept, not for current implementation)

**The Catpound** is a dedicated, playful instrument-selection screen accessible from the top navigation near SOUND. It is not merely a dropdown or generic instrument list: it is where the player assembles their band of kawaii instrument cats.

- **Your Band (top):** existing five-slot baseline is historical; Ruff v0.7 targets six simultaneous instruments (five visible at once). Revisit final Catpound capacity and replacement behavior against the implemented v0.7 architecture before Catpound development.
- **The Catpound (below):** a collection of available instrument cats side by side, each with its own identity and sound.
- **Interaction:** drag cats into an active slot to join or replace the band; drag a cat out to free its slot; allow rearrangement. Provide a clear tap-to-select alternative for touch accessibility and precision.
- **Creative safety:** replacing or removing a cat must not silently destroy patterns, instrument settings, scenes or saved work. Design reversible replacement and clear restoration semantics.
- **Architecture:** distinguish instrument type, slot identity and saved musical data; preserve current-version project integrity and align future capacity with the approved six-instrument Ruff direction, subject to code validation.
- **Placement:** provisionally v0.9 alongside instrument replacement; revisit scope and release placement before implementation. No UI or code changes requested now.
- **Open design questions:** exact handling of existing patterns on replacement, whether multiple instances of one instrument are allowed, and how inactive instrument state is stored.

**Design intent:** choosing instruments should feel like assembling a little band of characters, not configuring a DAW.

## Future idea — Genre-based startup presets / Groove Worlds (exploration only, 2026-11-25)

**Status: Idea backlog; not scoped, scheduled or approved for implementation.** Revisit after Ruff and The Catpound are available, when a wider instrument selection makes genre-specific starting bands useful.

Explore reusing the existing startup choices (currently including Dreamy) as meaningful musical starting points such as **Jungle, Vaporwave, House**, plus other styles to be decided. Keep an immediate **Start Fresh** option.

- Selecting a style preselects a coherent combination of available instruments and sound presets (e.g. RUFF for Jungle).
- After choosing a style, offer **New Song** (empty composition, chosen instruments/presets ready to play) or **Play Demo** (a short illustrative composition using that setup).
- All selections remain editable and replaceable through the normal instrument workflow; these are **starting configurations, not separate modes**, and not a mandatory onboarding wizard.
- Revisit naming, style count, default band choices, demo content and how startup selection/preset loading currently work when this idea is actually designed.
- No changes to current startup UX, instrument architecture or demos are authorized by this note.

## v0.5 — The Foundation

**Live baseline.** This section records the original v0.5 goals; individual completion and verification should be checked against code and testing.

- Tablet-first layouts for 11-inch and 13-inch iPads, touch-sized controls, and portrait fallback.
- Simplified **JAM** sequencer: functional compact editor, expanded advanced editor, same state and playback.
- More intuitive navigation and progressive disclosure of editing controls.
- Improved **ARRANGE**: clear scene selection, scene library vs. song chain, add/remove/duplicate/reorder instances, touch interactions.
- Explicit **New Song** from an empty project, alongside save/open.
- More coherent generation: shared musical context, motifs, groove-aware bass, harmonic relationships, meaningful moods and chaos.
- Modularize the single-file app: audio engine, scheduler, music theory/generation, project model, persistence, UI, styles.
- Stabilize Play/Pause/Resume/Stop, scheduling, scene transitions, Auto-evolve, and Undo/Redo.
- Preserve BOP, GOO, BLIP, FUZZ, UNI, existing synthesis and creative tools.
- Maintain compatibility/migration for v0.4 projects where feasible.

**Exit criterion:** Making a coherent musical idea on an iPad is intuitive, stable, and enjoyable.

## v0.5.1 — Bugfix & UI Polish

**Decided scope:** stabilization only; no new musical feature or scene-library expansion.

- Fix BUG-001: tapping BOP drum labels must not disable subsequent step editing (touch and mouse).
- Fix BUG-003: knob lighting/shadow stays stationary while the indicator rotates; preserve knob interactions.
- Fix BUG-004: use a consistent persistent header across JAM, SOUND and ARRANGE.
- Polish BUG-002: correct documented button/text alignment issues without clipping or touch regressions.
- Display the application version from one canonical source and the exact creator credit **Created by .::H∆RBUGΛП::.** consistently and discreetly.
- Verify transport, sequencer editing, scenes, project save/open, audio behavior, and iPad landscape interaction before release.

**Out of scope:** ENH-001 Dynamic Scene Library; scheduled for v0.6.1. Do not silently expand this bugfix release.

**Exit criterion:** v0.5 core workflows remain reliable, reported regressions are verified fixed, and the release identity is correct.

## v0.6 — Sample Playground

**Decided direction:** MUNCH is a dedicated fifth instrument, always available alongside BOP, GOO, BLIP and FUZZ. Five fixed slots in v0.6; instrument type and slot identity are separate. The Instrument Registry and versioned schema are prepared in Phase 1 (PR #6, subject to merge/verification). No user-facing replacement or adding/removing slots in v0.6.

**Experience:** CHOMPI-like immediacy on the surface, Flip-like depth when exploring. MUNCH is a playful, original sound-eating musical toy with a characterful, tactile iPad-landscape interface. PLAY (record/import and melodic keys), CHOP (eight slice pads, musical editable MAGIC CHOP variations), TWIST (non-destructive trim, pitch, reverse and looping). Both melodic keyboard and rhythmic pads are in v0.6 scope. The sample engine is shared/reusable, while MUNCH has its own instrument identity. MUNCH is a working name accepted for design; revisit branding if needed.

**Phased delivery:** (1) instrument registry, slot/schema migration and regression protection; (2) five-slot audio/transport/UI integration; (3) sample engine; (4) MUNCH PLAY/CHOP/TWIST and sequencer integration; (4b) **MUNCH stabilization** — microphone on iPad (audio session), resilient sample storage, voice retrigger/choke/Stop, Stretch/Tape fit, clearer chopping — **implemented and owner-verified on physical iPad 2026-11-24** (`docs/MUNCH-STABILIZATION.md`, BUGS.md MUNCH-1…4); (5) portable .hbn project format (Phase 5A merged), five instruments active by default (no URL flags), iPad QA; Song WAV Export deferred to v0.9. Each phase must preserve existing musical behavior.

- Import audio samples and record samples using the device microphone.
- Display waveforms and provide touch-friendly trim, slice/chop, loop points, audition, and editing.
- Pitch, reverse, and basic sample playback controls. **Decided:** Stretch (preserve pitch when tempo changes) is the default tempo-fit behavior; Tape (pitch follows speed) is the alternative. **Implemented** (WSOLA anchored at slice boundaries, rendered in a Worker); iPad listening test outstanding.
- Make slices usable from the sequencer.
- **Song WAV Export moved to v0.9**; not a v0.6 release blocker.
- Introduce **.hbn** as the native HarbuMatic project extension (**decided**).
  - Versioned, validated format for patterns, scenes, arrangement, instruments, parameters, and metadata.
  - **Design for a variable number of scenes now** (stable IDs and dynamic collections); the dynamic scene UI is scheduled for v0.6.1.
  - Support embedded or packaged sample assets as sampling arrives.
  - Historical JSON migration was implemented earlier; maintaining it is no longer required after the v0.6.1 baseline.
  - Prefer a portable container format if sample assets make plain JSON impractical.

**Scope guardrails:** No instrument swapping UI or unlimited slots in v0.6. Beyond the decided Stretch/Tape fit: no advanced time-stretch modes, transient detection, full parameter-lock system or full jungle break engine in v0.6. MAGIC CHOP must create musically useful, editable patterns with Undo; avoid arbitrary note soup. Verify iPad Safari recording, timing, touch and sample memory limits before release.

**Release blocker (reported 2026-11-22):** During physical iPad testing of PR #10, MUNCH reported `The sample could not be stored.` on import and `The microphone could not be started.` on RECORD. **Stabilization status:** the microphone failure is explained by WebKit refusing capture under the `playback` audio session and is fixed; storage is hardened (reconnect, non-destructive schema repair, play-from-memory fallback, explicit repair) but its root cause is unconfirmed; retrigger/Stop and Stretch/Tape are implemented. The original microphone/storage blocker is cleared by owner physical iPad QA on 2026-11-24. Low recording level remains a separate non-blocking P2 issue (MUNCH-5).

**Exit criterion:** A user can record/import a sound, creatively manipulate it, use it in music, and save the work in a portable project.

## v0.6.1 — Dynamic Scenes & Playability

**UX review source of truth:** [docs/UX-REVIEW-061.md](docs/UX-REVIEW-061.md) tracks owner-observed issues, decided design directions, proposals and unresolved technical questions. This is planning, not authorization to implement. Key decisions: mode-specific JAM/SOUND/ARRANGE workspace, no-scroll-by-default landscape, simultaneous CHOP pads and sequencer, and dedicated CHOP pattern preview goal.


**Implementation progress (2026-11-23):** Quick Volume & card alignment (PR #15) merged and user-verified on iPad. Five instruments by default (PR #16) merged and user-tested. Dynamic Scene Library (PR #18) merged: one empty scene for new projects, create/duplicate/rename/edit/copy-to/delete/reorder, maximum 64 scenes, dynamic labels, scene-local pattern/harmony deep-copy, Undo/Redo and `.hbn` round-trip. PR #18 reports 266/266 unit tests passing and a separate headless Chrome UI flow passing; standard `npm run test:ui` and `npm run test:baseline` were NOT RUN in that PR environment. Physical iPad verification of Dynamic Scenes confirmed by the owner on 2026-11-23. Remaining v0.6.1 work: iPad UX/preset review, compact top exploration and musical playability polish; scope each as separate tasks.

### Completed UX task — HBM-061-04 (2026-11-24)

**Merged PR #23; owner accepted physical iPad test.** One focused PR for responsive SOUND (UX-07), ARRANGE (UX-08), Deep Edit toolbar stability (UX-17) and iPad responsive verification (UX-16). See `docs/UX-REVIEW-061.md` and the HBM-061-04 Antigravity Task Contract for acceptance criteria.

- SOUND: reclaim usable workspace height, use responsive width for presets and knobs, avoid routine scrolling on typical 11/13-inch landscape iPads. Preserve MUNCH empty/PLAY/TWIST.
- ARRANGE: improve Scene Library and Song Arrangement visibility, preserving all scene actions and allowing large collections to scroll.
- Deep Edit: BOP-to-BLIP instrument changes currently cause variable tool groups to wrap, moving Lab/Clear/Done. Stabilize shared control positions and provide dedicated space for instrument-specific tools without shrinking touch targets.
- Verify all five instruments, Safari/PWA, landscape/portrait, smaller supported widths, relevant unit/UI/baseline tests, and no musical, transport or current-version `.hbn` regressions.
- **Explicit exclusions:** collapsible top/header (UX-05), broader JAM redesign (UX-06), preset UX redesign (UX-09), MUNCH CHOP redesign/local preview (UX-14/15), audio engine changes, new dependencies and version bump. No automatic merge.

**PR #21:** UX-01..04 quick fixes merged and passed all 16 owner physical iPad checks on 2026-11-24. The release-version bump remains separate. The release-version bump remains a separate task.

### Approved remaining v0.6.1 execution order — 2026-11-24

**One task / one PR / physical iPad acceptance / merge, sequentially.** Do not combine stages into a single implementation PR.

1. **HBM-061-05 — DONE / owner-accepted:** MUNCH CHOP (UX-14/15) implemented in PR #25; dedicated local Preview/Stop, live step edits, BPM/swing and transport isolation passed physical iPad checks (35/36 initial). Row-8 bottom-edge clipping fixed in PR #26; the fix was restored to `main` through PR #27 after a branch-target mix-up. Owner confirmed final iPad layout looks correct on 2026-11-24. PR #26 reported 271/271 unit tests plus UI/baseline checks; these were implementation-reported, not independently rerun during documentation update.
2. **Live Pattern Recording — DONE / owner-accepted (PR #29):** REC and Quantize On/Off, live capture on all five instruments, overdub, Undo/Redo and current-version `.hbn` round-trip. Owner physical iPad test passed 29/30 checks (2026-11-24). Multi-touch on existing sequencer playing surfaces was not accepted; owner explicitly deferred dedicated multi-touch performance to future Universal Live Play instead of requiring a PR #29 fix. MUNCH PLAY keyboard multi-touch works. `npm test` reported 280/280 PASS; standard `npm run test:ui` and `npm run test:baseline` were NOT RUN in the PR environment, although supplemental Chromium E2E/layout checks passed. PR #29 merged. No claim that the deferred multi-touch capability is implemented.
3. **Final release QA (no Compact Top or Preset UX):** Owner physical iPad QA PASS 7/7 (2026-11-24): microphone, import/reopen, retrigger, Stop, Stretch, Tape and other-instrument regression. MUNCH-1…4 resolved; low microphone recording level logged as non-blocking P2 MUNCH-5. **Still outstanding:** run/document standard automated UI and baseline regression checks and confirm release identity; do not claim full automated release sign-off yet. Defer all non-blocking polish. **Compact Top (UX-05) moved to post-v0.6.1 Nice to Have / UX Backlog**; not a release gate.

**Next-task guardrails:** Preset UX + Musical Playability (UX-09/10) is deferred to the final polish milestone immediately before v1.0, after v0.9. Do not implement it in v0.6.1. After essential QA, proceed to v0.7 Ruff in the Jungle. Preserve Live Pattern Recording, CHOP Preview, timing, Undo and `.hbn`. Deferred multi-touch performance belongs to Universal Live Play, not a sequencer retrofit.

### Future UX exploration — Collapsible top instrument/transport area

**Status: Nice to Have / UX Backlog after v0.6.1; explicitly not a v0.6.1 release gate (2026-11-24).** During the tablet-first playability review, evaluate an expanded and a highly compact/collapsed state for the top area (header, instrument strip and transport). The user's initial idea is a collapsed height around **20% of the current expanded area**, as an aspirational space-saving target rather than a fixed requirement.

- Prioritize freeing vertical space for playing, sequencer editing and MUNCH workflows on landscape iPad.
- Preserve quick, comfortable access to Play, Stop, future Pattern Record, active instrument selection and essential feedback.
- Keep kawaii character identity visible in a smaller form when appropriate.
- Ensure accessible touch targets, discoverable expand/collapse control, consistent behavior across JAM/SOUND/ARRANGE and no overlapping UI.
- Evaluate whether the collapsed state should persist per project/session; decide through actual iPad UX testing.
- Do not implement this as part of the next small Quick Volume or Live Pattern Recording PR; plan as a separate, focused UX change.



**Decided sequence (2026-11-22):** Complete and verify v0.6 first, then a focused UX and quality round, then start v0.7 Ruff in the Jungle. This is a quality milestone, not a feature expansion.

- Review preset discoverability, selection and consistency across BOP, GOO, BLIP, FUZZ and MUNCH.
- Audit JAM / SOUND / ARRANGE navigation, progressive disclosure, first-run experience and instrument workflows on a physical iPad.
- Improve touch targets, gesture reliability, visual hierarchy, feedback and accessibility without hiding essential controls.
- Evaluate musical usefulness of Generate, Mutate, Evolve, Happy Accident Lab and MAGIC CHOP; preserve locks, user intent and undoability.
- Polish character, microinteractions and visual consistency only where they improve playability.
- Run physical iPad Safari checks and regression tests for transport, timing, sequencer, scenes, projects, sampling and export.

**Dynamic Scene Library (ENH-001) implemented and merged in PR #18:** new projects start with one empty scene; create, duplicate, copy to (overwrite confirmation), rename, edit, reorder and delete (last scene protected), up to 64 scenes. Duplicate deep-copies all five scene patterns and scene harmony; global instrument sound parameters and FX remain shared. Scene mutations reconcile transport and arrangement references, support Undo/Redo and current-version `.hbn` round-trip. Automated unit and separate headless Chrome UI checks passed; physical iPad acceptance confirmed by the owner on 2026-11-23.

**Out of scope:** New instruments, Ruff in the Jungle implementation, major architecture rewrites and unrelated feature expansion. Critical v0.6 defects must be fixed before this phase, not carried into it.

**Exit criterion:** A first-time user can create a beat quickly (target: 30 seconds), find and audition presets, operate core controls comfortably on iPad and produce musically useful variations without breaking existing projects or workflows.

## v0.6.1 — Exit verification note (2026-11-24)

Owner completed the focused physical iPad final QA: **7/7 PASS** (MUNCH microphone capture, sample import/reopen, retrigger, Stop, Stretch, Tape, and BOP/GOO/BLIP/FUZZ + scene/REC/.hbn regression). The original MUNCH-1…4 physical-device verification blockers are resolved. **Known non-blocking P2:** microphone capture level is very low (MUNCH-5; cause not established). Standard automated `npm run test:ui` and `npm run test:baseline` were NOT RUN in the PR #29 environment; a final automated release regression pass is still required or must be explicitly documented as unavailable. This is **physical QA acceptance**, not a claim of complete technical release sign-off. No additional preset UX or Compact Top work is required before starting v0.7 design.

## v0.7 — Ruff in the Jungle (product specification approved 2026-11-25)

**Status: implementation in progress.** PR31–33 are merged and owner-accepted on physical iPad; CHOP IT!, pads, recording, DIRT/import and final v0.7 QA are not implemented/accepted. Technical feasibility and release QA remain open for subsequent stages. Full specification: [docs/RUFF-07-SPEC.md](docs/RUFF-07-SPEC.md). Ruff is a **standalone sixth instrument**, not a BOP mode or MUNCH skin; the mascot is a punk/rave **kawaii cat** with lime accents and a Keith Flint-inspired attitude (original character design, not a replica).

### Implemented milestones and next PR (2026-11-26)

- **PR31 — Instrument Foundation: merged; owner-verified.** Sixth RUFF slot, selectable/playable integration, scene-local A/B/C pattern foundation, five-visible strip paging and current-version project persistence.
- **PR32 — First Breaks: merged; owner-verified.** Original built-in TIGHT, FUNKY and RUFF JUNGLE loops, simultaneous A/B/C playback, independent lane volume/mute and audition, Stretch/Tape, transport, save/reopen and .hbn.
- **PR33 — Break-aware Slicing & Hybrid Sequencer: merged** (merge commit `99cab751`); **owner physical iPad QA 22/22 PASS**. Original groove preserved on first edit; compact and expanded A/B/C views share the pattern; auto-suggested/manual slices, explicit silent edited lanes, two-bar playback, Undo/Redo, scene independence, .hbn and existing instruments verified. Owner also retested the BLIP/FUZZ audio fix successfully. AntiGravity reported `npm test` 306/306 PASS (including four targeted audio tests); `npm run test:ui` NOT RUN in its VM; no full UI/baseline sign-off claimed.
- **PR33 associated P1 fix:** BLIP/FUZZ synth voice-pool exhaustion after repeated MUNCH CHOP scene switching and Stop/Play. Root cause reported as pre-existing on main; fix in `src/audio/voices.js` (commit `9d9a2a0`) merged with PR33; owner verified restored manual audition and loop playback on physical iPad. See BUGS.md.
- **PR34 — CHOP IT!: NEXT, product/UX direction decided; not implemented.** Consolidate redundant Compact/Lanes views into one RUFF sequencer with contextual slice editing and integrated CHOP IT!. New Groove/Evolve, genre-grounded OLD SKOOL JUNGLE / DARKSIDE / ATMOSPHERIC / ROLLING-TWO-STEP profiles, Subtle–Wild, intelligent complementary A/B/C roles, per-hit/column/lane locks (including locked silence), atomic Undo and immediate generation. Preserve PR33 16-step/two-bar timing and source edits. No live pads, audio-rate rolls, import or DIRT in this task. See docs/RUFF-07-SPEC.md. Implementation awaits reviewed Task Contract.

**Musical identity:** a playful, immediate Breakbeat Performance Machine with the energy of 90s jungle, breakbeat and rave. Play first; tweak forever. Generated and manually edited events share one non-destructive pattern.

**Approved scope:**
- **Hybrid Break Pool:** original distributable built-in jungle breaks plus user-imported audio; future licensed recordings may be added only after rights clearance. Ten historical breaks are musical references, **not bundled audio**. Choose up to three active sources A/B/C from an extensible pool; each has audition, volume and mute. Replacing a source must not silently destroy edits.
- **16-step RUFF sequencer:** PR33 implemented compact and expanded A/B/C views sharing one pattern; PR34 approved UX direction consolidates these into a single editor with contextual slice/step controls and integrated CHOP IT!. Multiple break slices may play on the same step; per-hit, column and lane locks are planned.
- **Break-aware slicing; CHOP IT!:** PR33 slicing implemented; PR34 plans genre-based OLD SKOOL JUNGLE, DARKSIDE, ATMOSPHERIC and ROLLING/TWO-STEP break-programming profiles; New Groove and Evolve, Subtle–Wild, intelligent A/B/C interplay, lock-aware immediate variation and Undo. No separate variation slots/history in v0.7.
- **Eight dynamic performance pads:** automatic slice mapping with manual overrides; HOLD, ROLL, momentary live CHAOS, retrigger, ghost notes and reverse. Releasing CHAOS returns to the original groove without destructive pattern mutation unless intentionally recorded.
- **Recording:** reuse Live Pattern Recording with Quantize On/Off; capture pad slices and representable discrete effects in the shared pattern. Do not assume continuous parameter automation.
- **Audio:** Stretch (pitch-preserving tempo fit) by default; Tape alternative; pitch/reverse and DIRT character; three active breaks with individual volume/mute plus Ruff instrument volume.
- **iPad UX:** SOUND workspace, six simultaneous instruments with a compact selector showing five at once; sequencer and pads readily available; three compact expandable break-source panels; contextual editor; landscape no routine vertical scrolling.

**Explicit exclusions:** universal cross-instrument Live Play, MUTATOR, continuous effect automation, full Catpound replacement UI, and bundled unlicensed historical recordings. No automatic version bump or code change is authorized by this planning update.

**Historical technical gates (before PR31):** inspect slot/project schema and current-version .hbn round-trip, existing sample/Stretch/Tape reuse, polyphonic slice scheduling and choke, live recording event model, library asset handling, touch/multi-touch and physical iPad Safari performance. Specify HOLD/CHAOS event semantics and replacement safety during implementation design. Pre-1.0 historical migration remains waived per baseline policy; preserve current-version projects and never silently delete stored work.

**Delivery:** small sequential Antigravity PRs with focused automated checks and owner physical iPad acceptance; verify musical quality, timing, transport, save/reopen, other instruments and landscape ergonomics. The final PR plan must follow repository inspection, not assumptions.

**Exit criterion:** select up to three breaks, create an immediately musical jungle groove, play/record expressive variations, edit/lock/undo, and save/reopen reliably on a physical iPad.

## Future feature — Universal Live Play (proposed v0.8)

**Decided experience, release placement provisional (2026-11-24):** a summonable, tablet-first performance surface available across HarbuMatic without navigating away from the current JAM/SOUND/ARRANGE workflow. It follows the selected instrument: a polyphonic multi-touch keyboard for melodic instruments, dedicated multi-touch drum pads for BOP, and keyboard/slice-pad options for MUNCH. Designed for both live playing and existing Live Pattern Recording, with clear close/open behavior, reliable independent finger release and no stuck voices. Plan sufficient iPad landscape space for future simultaneous keyboard/pads and MUTATOR. This is **not implemented**; do not retrofit the existing sequencer's multi-touch as part of PR #29. Decide exact overlay/panel behavior and scope before implementation.

## v0.8 — Play Together

**Confirmed direction:** occasional collaborative jams with other musicians and gear.

- Live performance controls, expressive effect manipulation, and scene triggering.
- **Universal Live Play (proposed):** shared summonable keyboard/drum-pad/slice-pad performance surface across the app; see dedicated future-feature section above.
- **MUTATOR — decided feature concept (2026-11-24), deferred beyond Ruff v0.7:** a tactile, analog-inspired, assignable real-time performance controller beside the live keyboard, inspired by HiChord. While playing notes/chords, move the controller with another finger to continuously shape the active instrument's sound. Support assignment to musically useful parameters such as filter cutoff, resonance, pitch, drive, modulation or FX wetness, subject to each engine's capabilities. Prioritize simultaneous multi-touch keyboard + MUTATOR use, smooth audible response without clicks/latency, clear parameter feedback, and an immediately playable default mapping. Explore XY control with independent X/Y assignments, but **do not lock the physical control shape yet**. Decide parameter ranges, reset/hold behavior, per-instrument mappings, recording/automation and persistence during UX/technical design. Must fit the iPad landscape workspace without requiring scrolling. No implementation authorized yet.
- **MUTATOR instrument coverage — decided 2026-11-24:** intended across available instruments (including Ruff once integrated), with instrument-specific useful default mappings. It should work during Live Pattern Recording: notes are recorded, while live parameter movements remain unrecorded until automation recording exists.
- **Live Automation Recording — planned concept, proposed for v0.8:** record real-time movements from MUTATOR and regular knobs as beat-aligned, editable, replayable parameter automation. Keep automation separate from note events; preserve overdub, Undo and reversible editing. Decide recording modes, smoothing, conflicts, persistence and UX before implementation. Advanced automation editing may follow in v0.9.
- **MIDI Clock synchronization** for compatible gear.
- **Ableton Link** for shared tempo and beat phase between participating apps/devices.
- Investigate sync roles, transport behavior, latency, and recovery from device/app interruptions.
- Assess iPad browser limitations early: Web MIDI support and Ableton Link integration cannot be assumed in Safari/PWA.
- Keep sync behind a transport abstraction; consider native integration if required.

**Exit criterion:** HarbuMatic can join a small jam session with reliable timing on a supported deployment platform.

## v0.9 — Expand & Finish

**Confirmed direction:** instrument replacement UI is deferred; v0.6 had five fixed slots, while v0.7 product scope targets six concurrent instruments. Validate final slot behavior against the implementation before building Catpound.

- Select alternative instrument engines within the then-current slot layout; do not silently erase existing patterns or instrument state.
- Candidate future engines: sampler, FM synth, or other characterful instruments (**examples, not commitments**).
- Define behavior when replacing an instrument with existing patterns/automation.
- **Dynamic Scene Library moved to v0.6.1 (ENH-001).**
- Preserve current-version scene references and song chains; pre-v0.6.1 project compatibility is not required.
- Stronger arrangement transitions, automation, export, and light finishing/mastering tools.
- Review instrument names **BOP / GOO / BLIP / FUZZ**; current names are not permanently locked.

**Exit criterion:** More sound choices and a path to finished tracks, without sacrificing the five-slot simplicity.

## Final pre-v1.0 polish — Preset UX + Musical Playability (UX-09/10)

**Owner decision 2026-11-24:** schedule as the last focused product-quality milestone after v0.9 and before v1.0; not a v0.6.1 release gate. Improve preset discovery, selected-state feedback and fast audition across instruments. Review the musical usefulness of Generate, Mutate, Evolve, Remix, Surprise, Lab and MAGIC CHOP while protecting user intent, locked material and Undo. Keep scope evidence-based and split into focused tasks if necessary. Complete essential regression and physical iPad acceptance before v1.0. Compact Top remains optional Nice to Have, not a required part of this milestone.

## Final pre-v1.0 polish — JAM Scene Awareness & Playback Navigation (2026-11-25)

**Owner-observed while composing a real track; planned UX improvement, not implemented.** Schedule alongside the final pre-v1.0 polish, after v0.9, without expanding Ruff v0.7 scope.

- **Persistent active edit-scene indicator:** clearly show which scene is being edited across JAM, SOUND and ARRANGE, without opening Happy Accident Lab. Prefer the existing top/transport area and preserve iPad landscape workspace. Example: SCENE 03 / 08.
- **Direct JAM playback-mode switch:** expose LOOP (repeat the active scene) and WHOLE SONG (play the arrangement) on the main JAM surface, near transport. Make the selected mode unambiguous; no trip into ARRANGE or Happy Accident Lab required.
- **Scene navigation:** explore compact previous/next scene controls next to the indicator, subject to iPad usability and space; not yet a locked requirement.
- **Transport semantics to specify before implementation:** distinguish edit scene from currently playing scene, define behavior when switching playback mode or edit scene during playback, and avoid timing glitches or accidental jumps.
- **Acceptance:** physical iPad landscape, touch target and no-scroll checks; scene selection, loop/song playback, transport, recording, arrangement, save/reopen and .hbn regression checks.

## v1.0 — The Little Music Machine

A cohesive, reliable, installable tablet-first groovebox:
- Excellent touch UX and dependable audio on supported iPads/tablets.
- Solid project management and .hbn compatibility.
- Robust creative workflow from first idea through arrangement and export.
- Offline-first capabilities where technically practical.
- Consistent characterful identity and polished performance.
- Explicit documentation of any platform-specific limitations.

## v1.1 (proposed) — The Skin Playground

**Post-v1.0 idea; not authorized for implementation now.** Optional complete visual themes, not merely palette swaps: different colors, character artwork and decorative hardware styling, while retaining identical musical behavior, control locations, accessible touch targets and project compatibility. Keep Original HarbuMatic as default; explore Midnight Ghosts, Kitsune and Rave Machine as illustrative concepts, not committed assets. Switch skins from Settings without disrupting playback or losing edits. Avoid unnecessary hardcoded visual dependencies before v1.0, but do not build a skin framework prematurely.

## Architecture decisions to protect now

These are **forward-looking constraints**, not requests to build every future feature in v0.5.

1. **Instrument slot abstraction:** five slots from v0.6, with six simultaneous instruments targeted for Ruff v0.7 (pending technical validation); keep stable slot identity separate from engine type and prepare for future replacement.
2. **Audio source abstraction:** synthesis now, sample playback/recording later.
3. **Transport/sync abstraction:** internal clock now, external MIDI Clock/Link integration later.
4. **Project format:** use .hbn with embedded sample assets; v0.6.1 is the experimental data baseline, without mandatory historical migrations.
5. **Independent music logic:** generation and transformations testable without UI/audio rendering.
6. **Tablet input model:** gestures, hit targets, pointer cancellation, and no hover-only essential actions.
7. **Export pathway:** future offline rendering/bounce and project packaging without coupling to the visual UI.

## Decisions register

| Decision | Status |
| --- | --- |
| Product direction: Playful Groovebox with Musical Toy personality | **Decided** |
| Primary platform: iPad/tablet | **Decided** |
| Five simultaneous instrument slots (BOP, GOO, BLIP, FUZZ, MUNCH) from v0.6 | **Implemented historical baseline; Ruff v0.7 targets six, pending technical validation** |
| Future ability to swap instruments in those slots (UI deferred beyond v0.6) | **Decided** |
| Import and record samples; chop and loop them | **Decided** |
| MUNCH standalone fifth instrument; shared sample engine | **Decided** |
| MUNCH PLAY/CHOP/TWIST, melodic keys and slice pads | **Decided for v0.6 scope** |
| CHOMPI-like first interaction; Flip-like deeper editing | **Decided design direction** |
| MAGIC CHOP: musically guided, editable variations | **Decided goal; first version (metrical-role templates) in Phase 4 review** |
| Focused v0.6.1 Playability & Polish milestone before v0.7 | **Decided 2026-11-22** |
| v0.6 release blocked on reported iPad MUNCH sample-storage and microphone failures in PR #10 | **Fixes implemented (stabilization); blocker stays until physical iPad verification** |
| Default tempo-fit Stretch (pitch preserved); optional Tape (pitch changes with speed) | **Decided; implemented, iPad verification pending** |
| Dedicated jungle/breakbeat creation feature | **Decided** |
| Feature name: **Ruff in the Jungle** | **Decided** |
| Ruff mascot: kawaii anteater / kattemyrer | **Decided direction** |
| Live keyboard MUTATOR: assignable real-time sound-shaping controller, HiChord-inspired; control shape and mapping details open | **Decided concept; all five instruments; candidate v0.7/v0.8** |
| Universal Live Play: summonable multi-touch keyboard for melodic instruments, drum pads for BOP and keyboard/slice pads for MUNCH | **Decided future experience; proposed v0.8, not implemented** |
| Live Pattern Recording (PR #29): REC, Quantize On/Off, overdub, five instruments | **Merged and owner-accepted on iPad 2026-11-24; multi-touch on sequencer surfaces deferred; standard UI/baseline scripts not run in PR environment** |
| Live Automation Recording: capture MUTATOR and knob movements in musical time, editable separately from notes | **Decided future goal; proposed v0.8, detailed UX/architecture open** |
| Optional visual skins / The Skin Playground | **Post-v1.0 proposal (v1.1); no implementation now** |
| MIDI Clock and Ableton Link are desired | **Decided goal; feasibility pending** |
| Native project file extension: **.hbn** | **Decided** |
| Dynamic Scene Library (ENH-001) in v0.6.1 | **Implemented, merged PR #18 and owner-verified on physical iPad (2026-11-23)** |
| v0.6 .hbn schema supports variable scene counts ahead of the v0.6.1 UI | **Decided architectural requirement** |
| Song WAV Export deferred to v0.9; not a v0.6 blocker | **Decided 2026-11-23** |
| BUG-001…004 verified and accepted on physical iPad; minor remaining polish deferred to v0.6.1 | **User-confirmed 2026-11-23** |
| v0.6.1 resets the project-data compatibility baseline; develop and test version by version, no required legacy .hbn/JSON migration | **Decided 2026-11-23** |
| Quick Volume and Mute/Solo alignment (PR #15) | **Merged; user-verified on iPad** |
| Five instruments by default, without URL flags (PR #16) | **Merged; user-tested** |
| Exact versions for other future features | **Provisional** |
| Sampling shared across instruments vs. sampler slot | **Resolved: shared engine with standalone MUNCH instrument** |
| Ruff integrated into BOP vs. separate engine/tool | **Open** |
| Persistent edit-scene indicator and JAM LOOP / WHOLE SONG switch | **Decided UX goals 2026-11-25; planned final pre-v1.0 polish, not implemented** |
| Final instrument names | **Open** |
| PWA-only vs. native wrapper for external sync | **Open** |

## Nice to Have / UX Backlog

- **Compact Top (UX-05):** collapsible instrument/transport area to free iPad landscape workspace; preserve accessible transport, REC, instrument selection, Quick Volume and character identity. Deferred from v0.6.1 by owner decision on 2026-11-24. Revisit after new creative features, not before v0.7.
- Other non-blocking preset, visual and microinteraction polish found during v0.6.1 QA; prioritize only when there is demonstrated user value.

## Parking lot — ideas for later

- More expressive character reactions and playful hardware details.
- Additional sound engines and user presets.
- Improved intelligent variations of entire grooves.
- Sample transient detection, more advanced time-stretch modes, and more advanced sample manipulation.
- Optional MIDI mapping and external controllers.
- Additional export options.

New ideas should be evaluated against the product principles, not added automatically to the next release.

---

*Maintain this file as the product source of truth. Update the decisions register when choices are made, and keep implementation status distinct from aspirations.*
