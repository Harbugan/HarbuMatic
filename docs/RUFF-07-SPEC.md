# Ruff in the Jungle — v0.7 Approved Product Specification
**Approved:** 2026-11-25 | **Updated:** 2026-11-26 | **Status:** PR31–33 and CHOP IT! (GitHub PR #36) merged and owner-verified (20/20 iPad QA for CHOP IT!). WAV break import approved as next product scope, not implemented.
**Next:** HBM-07-PR35 Import Your Own Break — technical gates and implementation handoff; no import implementation authorized by this document.

## Identity
Standalone sixth instrument: a **Breakbeat Performance Machine**, not a MUNCH mode or BOP preset. 90s jungle/rave energy, tactile HarbuMatic Musical Toy feel, original punk kawaii cat mascot with lime/pink/purple accents. **Play first. Tweak forever.** Existing JAM/SOUND/ARRANGE structure retained.

## Round 1 — Sequencer
- PR33 implemented 16-step, two-bar A/B/C slicing with one scene-local editable pattern. **PR34 decision supersedes Compact/Lanes switch:** one unified RUFF sequencer/workspace, with CHOP IT! controls integrated and a contextual slice inspector. Preserve all PR33 editing capability.
- Up to three sources can play concurrently at the same step. Slice identity/source must remain inspectable in the unified view.
- Non-destructive step edits, undo, and locks. Contextual slice editor; avoid permanent dense controls.

## Round 2 — Performance
- Eight dynamic slice pads across A/B/C, automatically mapped with user-editable overrides.
- Roll, retrigger, ghost notes, reverse, HOLD and live CHAOS.
- Live Pattern Recording with Quantize On/Off; pads and representable discrete effects captured into the shared pattern. No continuous FX automation in v0.7.
- HOLD is intended to sustain an active pad/effect; exact gate/release interaction to specify against engine. CHAOS is **momentary**: held for musically bounded variations, returns to original groove on release, never destructive unless explicitly recorded.
- Preserve existing record/overdub, Undo/Redo and Stop semantics; verify multi-touch on physical iPad.

## Round 3 — CHOP IT! (implemented and owner-verified in PR #36)
- **One unified RUFF workspace:** remove redundant Compact/Lanes mode switching; retain existing 16-step A/B/C editing, contextual slice inspector and scene-local pattern. Place compact CHOP IT! controls alongside the sequencer within iPad landscape constraints; no new top-level mode.
- **New Groove** creates a fresh coherent, lock-aware arrangement from assigned breaks. **Evolve** develops the current audible pattern while preserving more recognizable anchors at lower intensity. Unedited original loops must be treated as audible source material; generating must not silently clear a lane or discard original content.
- **Four genre-grounded break-programming profiles:** **OLD SKOOL JUNGLE** (chopped, syncopated break phrases), **DARKSIDE** (angular rhythmic contrast and deliberate gaps), **ATMOSPHERIC** (restrained edits, space and continuity), **ROLLING / TWO-STEP** (stable rhythmic drive and small supporting variations). These are stylistic guides for break programming, not claims to recreate complete genres or recordings.
- **Musical algorithm:** analyze/use existing built-in break slice metadata and rhythmic position where reliable. Do not assume a fixed slice index always represents kick/snare. Preserve downbeat/backbeat anchors as appropriate, use phrase-aware changes, avoid random note soup and excessive simultaneous A/B/C density. Work with one, two or three assigned sources, adapting complementary roles to actual source content rather than fixed A/B/C assignments.
- **One Subtle–Wild intensity slider** governs magnitude of rhythmic transformation, not only number of changed cells. Each profile must be audibly distinguishable within the representable event model; no new audio-rate rolls/retrigger or live effects in PR34.
- **Immediate application:** CHOP IT! replaces the current pattern in one atomic, undoable action. Pressing again creates another variation from the current pattern (no preview/keep/cancel, no separate variation slots/history). Respect scene boundaries and preserve other instruments.
- **Locks:** support per-lane step (including locked empty step), full step-column A/B/C and full-lane protection. Both New Groove and Evolve must preserve all locked content and intentional silence. Show lock state clearly; editing locks and generation remain reversible through existing history semantics.
- **Not part of the completed CHOP IT! PR:** WAV import, live pads, HOLD, momentary live CHAOS, performance recording, DIRT or unrelated redesign. These remain later v0.7 tasks.
- **Verification:** automated invariants for locks, two-bar mapping, scene persistence, Undo/Redo, determinism with a fixed test seed and non-destructive A/B/C interplay; physical iPad musical listening and landscape QA required.

## Next milestone — Import Your Own Break (HBM-07-PR35; product approved, not implemented)
**Owner decision 2026-11-26:** prioritize personally selected breaks over additional polishing of built-in drum sounds (which owner describes as generic/eJay-like). This is a non-blocking musical-quality observation, not a PR #36 regression.

**Experience:** WAV from iPad Files → local analysis → immediate assignment to RUFF A/B/C → original groove playable and CHOP IT! ready, with optional manual corrections. No mandatory setup wizard.

- **Format and length:** WAV initially; 1, 2 and 4 bars. Keep original source bytes unchanged. Reuse existing content-addressed sample store/bank and safe file limits; imported breaks persist locally for reuse across projects and offline after successful storage.
- **Tempo:** local estimated BPM, with half-time/double-time ambiguity surfaced and user-editable BPM/bar count. Never misrepresent low-confidence estimates as facts.
- **Slicing:** locally detect transient candidates; bounded, ordered slice markers with robust fallback; touch-friendly waveform, marker drag/nudge/add/remove, slice audition and Undo. Keep musical beat grid separate from audio slice positions. Support more source slices than sequencer steps only if existing data model safely allows it; do not silently truncate.
- **Non-destructive editing:** slice boundaries, timing metadata and any trim are stored as project/source metadata without rewriting original audio; existing patterns and source assignments must not silently change or disappear.
- **Playback and CHOP IT!:** imported breaks preserve original groove on first play, support Stretch/Tape, assign to any of three concurrent A/B/C lanes, and participate in existing CHOP IT! profiles. Avoid pretending to have reliable kick/snare labels for unknown audio; use rhythmic position/transient/energy features and safe fallbacks.
- **Portable projects:** include referenced imported RUFF audio bytes and required source/slice/BPM metadata in `.hbn`; retain existing MUNCH package behavior and hash/size validation. Missing/unpersisted assets must be reported clearly, never silently replaced.
- **Critical technical gates before implementation:** verify 16-step/two-bar RUFF pattern and scheduler against 1/2/4-bar source playback; metadata location and source-ID lifetime; audio-voice slice handling; `src/core/package.js` sample reference collection; storage failures and iPad memory constraints. Stop and present alternatives before major schema/scheduler redesign or destructive migration.
- **Out of scope:** long recordings/region selection, MP3/M4A guarantees, RUFF microphone recording, advanced ML drum classification, new effects/DIRT, live pads/CHAOS/HOLD/recording, bundled copyrighted break recordings, character redesign.
- **Acceptance:** physical iPad Safari/PWA import, analysis correction, touch slicing, 1/2/4-bar timing, CHOP IT!, three-lane mixing, save/reopen, offline and portable `.hbn`; BOP/GOO/BLIP/FUZZ/MUNCH and built-in RUFF regression. Implementation pending a reviewed focused Task Contract.

## Round 4 — Integration and layout
- Six simultaneously active instruments, with **five visible in a compact selector at a time**. Technical feasibility and conflict with legacy five-slot/Catpound plans require explicit code review.
- Ruff retains existing JAM/SOUND/ARRANGE structure; PR34 consolidates only RUFF's sequencer subviews into one unified editor, with CHOP IT! embedded. No new top-level navigation.
- iPad landscape, no routine vertical scrolling; sequencer and pads readily available. Three compact, expandable break-source panels. Contextual slice editor; advanced controls appear as needed.
- Mockup images are conceptual, not pixel specifications or physical iPad QA.

## Round 5 — Sound, pool, scope
- **Hybrid Break Pool:** an extensible library of **original distributable** built-in jungle/breakbeat loops plus user-imported audio; option to add **licensed authentic classics later** only after rights clearance.
- Up to **three active breaks A/B/C**, selected from pool; audition, independent volume/mute and global Ruff instrument volume. Changing sources must not silently discard user edits.
- Historical inspiration/reference list (not bundled recordings): *Amen, Brother* (The Winstons); *Think (About It)* (Lyn Collins); *Apache* (identify specific recording; often Incredible Bongo Band); *Funky Drummer*, *Funky President*, *Hot Pants* (James Brown); *Ashley's Roachclip* (The Soul Searchers); *Impeach the President* (The Honey Drippers); *Skull Snaps* (Skull Snaps); *Sesame Street* (specific recording unresolved).
- **Copyright:** references are not license grants. Do not package original recordings without appropriate rights. Do not claim soundalike copies are necessarily safe; use independently composed and recorded material.
- Break-aware slicing, Stretch default (tempo changes preserve pitch), Tape optional (tempo and pitch follow together); pitch, reverse, DIRT character.
- Live CHAOS momentary; record pad hits and discrete performance events only where the event model can represent them.

## Excluded from v0.7
Universal Live Play across all instruments; MUTATOR; continuous live effect-automation; full Catpound replacement interface; unlicensed historical audio; full variations history.

## Technical questions / stop conditions
1. Verify sixth instrument/slot architecture, registry, scheduler, scene-local pattern model and current-version .hbn save/reopen; legacy migration not required under current roadmap policy. Do not silently erase stored work.
2. Confirm sample-bank and imported asset packaging, break-aware slicing, tempo-fit reuse, polyphony/choke, no orphan voices, and timing under 3 active breaks.
3. Define pad mapping, HOLD/CHAOS momentary behavior, discrete recorded event representation, lock granularity and undo boundary.
4. Check real iPad Safari/PWA landscape, touch targets, pad multi-touch, CPU/memory, latency, scrolling, and regression across BOP/GOO/BLIP/FUZZ/MUNCH.
5. Reconcile Catpound's older five-slot assumption with the approved six-instrument direction before implementation. Preserve existing current-version project integrity; do not add speculative compatibility migrations.
6. v0.6.1 final automated UI/baseline release checks remain outstanding per roadmap; do not claim them passed.

## Proposed planning sequence (not authorized PR contracts)
Completed: instrument integration and built-in pool → slicing/hybrid sequencer → CHOP IT! and locks/undo. Next approved priority: imported WAV breaks with analysis/slicing/portability → remaining pads/recording/performance, sound character and final iPad QA (subject to subsequent scope review). Split or reorder based on actual code dependencies, keep PRs narrow, tests explicit and owner iPad acceptance between stages.

## Handoff to new chat
Read current `ROADMAP.md`, this spec, `AGENTS.md`, `docs/agent/CONTEXT.md` and `docs/agent/WORKFLOW.md` selectively. Inspect actual source/test entry points before drafting the **next** Antigravity Task Contract. Clearly separate approved product design, planned tasks, implemented code, automated tests and owner physical iPad verification. No code was changed as part of this specification.
