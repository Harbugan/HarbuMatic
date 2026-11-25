# Ruff in the Jungle — v0.7 Approved Product Specification
**Approved:** 2026-11-25 | **Status:** product decisions only; NOT implemented, NOT technically validated.
**Next:** repo-grounded Antigravity PR planning; no implementation authorization in this document.

## Identity
Standalone sixth instrument: a **Breakbeat Performance Machine**, not a MUNCH mode or BOP preset. 90s jungle/rave energy, tactile HarbuMatic Musical Toy feel, original punk kawaii cat mascot with lime/pink/purple accents. **Play first. Tweak forever.** Existing JAM/SOUND/ARRANGE structure retained.

## Round 1 — Sequencer
- 16-step pattern. Hybrid compact groove view + expanded A/B/C break lanes, both operating on **one shared editable pattern**.
- Up to three sources can play concurrently at the same step. Slice identity/source must be inspectable in both views.
- Non-destructive step edits, undo, and locks. Contextual slice editor; avoid permanent dense controls.

## Round 2 — Performance
- Eight dynamic slice pads across A/B/C, automatically mapped with user-editable overrides.
- Roll, retrigger, ghost notes, reverse, HOLD and live CHAOS.
- Live Pattern Recording with Quantize On/Off; pads and representable discrete effects captured into the shared pattern. No continuous FX automation in v0.7.
- HOLD is intended to sustain an active pad/effect; exact gate/release interaction to specify against engine. CHAOS is **momentary**: held for musically bounded variations, returns to original groove on release, never destructive unless explicitly recorded.
- Preserve existing record/overdub, Undo/Redo and Stop semantics; verify multi-touch on physical iPad.

## Round 3 — CHOP IT!
- **New Groove** creates a new lock-aware pattern; **Evolve** transforms unlocked content of the existing pattern.
- Four musical profiles: **TIGHT** (precise), **FUNKY** (syncopation/ghosts), **RUFF** (cuts/rolls), **CHAOS** (controlled jungle variation).
- One **Subtle–Wild** intensity slider.
- Lock individual lane steps or entire step columns across A/B/C; locked content remains intact. Undo can restore previous state.
- One current generated variation + Undo; no variation slots/history in v0.7.
- Rhythm-aware outcomes, not unstructured randomness. Must work with one, two or three loaded breaks.

## Round 4 — Integration and layout
- Six simultaneously active instruments, with **five visible in a compact selector at a time**. Technical feasibility and conflict with legacy five-slot/Catpound plans require explicit code review.
- Ruff uses existing SOUND workspace; no new top-level navigation.
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
Repository/architecture review → instrument integration and pool → break slicing and hybrid sequencer → CHOP IT! and locks/undo → pads/recording/performance → sound character, import and final iPad QA. Split or reorder based on actual code dependencies, keep PRs narrow, tests explicit and owner iPad acceptance between stages.

## Handoff to new chat
Read current `ROADMAP.md`, this spec, `AGENTS.md`, `docs/agent/CONTEXT.md` and `docs/agent/WORKFLOW.md` selectively. Inspect actual source/test entry points before drafting the **first** Antigravity Task Contract. Clearly separate approved product design, planned tasks, implemented code, automated tests and owner physical iPad verification. No code was changed as part of this specification.
