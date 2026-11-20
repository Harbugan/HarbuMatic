# HarbuMatic — Product Roadmap

> **A little machine for making music.**  
> Last updated: 2026-11-20  
> Status: Living product roadmap — version assignments are provisional unless explicitly marked as decided.

## Product direction

**The Playful Groovebox, with the personality of a Musical Toy.**

HarbuMatic is an original, tactile, whimsical music-making instrument. It should be easy to start, rewarding to experiment with, and deep enough to finish actual tracks — without feeling like a conventional DAW wearing cute graphics.

**Product principles**
- **iPad/tablet first:** touch, landscape-first composition, and an excellent iPad Safari experience; desktop is secondary.
- **Play first, tweak forever:** immediate results, with advanced controls available when wanted.
- **Musically useful surprises:** controlled chaos, coherent rhythms, harmony, and instrument interplay.
- **Four slots, always:** four simultaneously active instruments; future versions may allow swapping which instruments occupy them.
- **Personality matters:** warm tactile UI, kawaii headphone-wearing characters, small reactive animations, and UNI.
- **Portable foundation:** modular audio/music/state/UI boundaries, versioned project data, and a credible future native-app path.
- **Create and keep:** easy projects, eventual audio export, and offline-first use where feasible.

## Roadmap overview

| Version | Theme | Intended outcome | Status |
| --- | --- | --- | --- |
| **v0.5** | The Foundation | Tablet-first UX, modular architecture, better JAM/ARRANGE, musical generation, reliability | **Live** |
| **v0.5.1** | Bugfix & UI Polish | BOP sequencer reliability, knob shadows, consistent navigation, alignment, version and creator signature | **In review** — fixes implemented, iPad verification pending |
| **v0.6** | Sample Playground | Import/record samples, waveform editing, chopping/looping, .hbn, initial WAV export | Proposed scope |
| **v0.7** | **Ruff in the Jungle** | Purpose-built jungle/breakbeat maker | Name and feature direction decided; scope proposed |
| **v0.8** | Play Together | Live performance, MIDI Clock, Ableton Link feasibility/integration | Proposed scope |
| **v0.9** | Expand & Finish | Swappable instruments, Dynamic Scene Library, automation, stronger finishing/export tools | Scene Library placement decided; other scope proposed |
| **v1.0** | The Little Music Machine | Stable, polished, installable tablet music app | Target |

The roadmap is directional, **not** a promise of release dates or a locked implementation order.

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

**Out of scope:** ENH-001 Dynamic Scene Library; scheduled for v0.9. Do not silently expand this bugfix release.

**Exit criterion:** v0.5 core workflows remain reliable, reported regressions are verified fixed, and the release identity is correct.

## v0.6 — Sample Playground

**Confirmed direction:** sampling is a major future capability. Version placement is provisional.

- Import audio samples and record samples using the device microphone.
- Display waveforms and provide touch-friendly trim, slice/chop, loop points, audition, and editing.
- Pitch, reverse, and basic sample playback controls; explore tempo matching and transient detection.
- Make slices usable from the sequencer.
- Initial **WAV audio export** so musical ideas can leave the app.
- Introduce **.hbn** as the native HarbuMatic project extension (**decided**).
  - Versioned, validated format for patterns, scenes, arrangement, instruments, parameters, and metadata.
  - **Design for a variable number of scenes now** (stable IDs, dynamic collections and backward compatibility); the UI for creating more than six scenes is scheduled for v0.9.
  - Support embedded or packaged sample assets as sampling arrives.
  - Preserve a migration path from existing JSON projects.
  - Prefer a portable container format if sample assets make plain JSON impractical.

**Open design decision:** Sampling should probably be a shared capability, with a dedicated sampler instrument becoming an optional slot later. This is a proposal, **not yet decided**.

**Exit criterion:** A user can record/import a sound, creatively manipulate it, use it in music, and save the work in a portable project.

## v0.7 — Ruff in the Jungle

**Decided name:** **Ruff in the Jungle** — a deliberate nod to The Prodigy's *Ruff in the Jungle Bizness*.

A **purpose-built jungle and breakbeat creation environment**, potentially integrated with BOP. Not merely a jungle preset.

- Load or select breaks; chop them into slices and sequence/rearrange the slices.
- Fast rolls, retriggers, ghost notes, reverse, pitch changes, and syncopated break variations.
- Musically guided break transformations: tight, funky, and chaotic but usable.
- A playful **CHOP IT!** creative action is a proposed interaction.
- Distinct mascot direction: **a kawaii anteater (kattemyrer)** with oversized rave headphones, mischievous energy, and audio-reactive animations.
- Explore an original 90s rave-inspired visual identity while retaining HarbuMatic's aesthetic.

**Still open:** Whether this is a special BOP mode, a shared tool, or an interchangeable instrument.

**Exit criterion:** Quickly turn a break into expressive, editable jungle rhythms with HarbuMatic's signature playful feel.

## v0.8 — Play Together

**Confirmed direction:** occasional collaborative jams with other musicians and gear.

- Live performance controls, expressive effect manipulation, scene triggering, and potentially XY pads.
- **MIDI Clock synchronization** for compatible gear.
- **Ableton Link** for shared tempo and beat phase between participating apps/devices.
- Investigate sync roles, transport behavior, latency, and recovery from device/app interruptions.
- Assess iPad browser limitations early: Web MIDI support and Ableton Link integration cannot be assumed in Safari/PWA.
- Keep sync behind a transport abstraction; consider native integration if required.

**Exit criterion:** HarbuMatic can join a small jam session with reliable timing on a supported deployment platform.

## v0.9 — Expand & Finish

**Confirmed direction:** exactly four active instrument slots, with the ability to replace an instrument in a slot.

- Select alternative instrument engines without adding a fifth simultaneous slot.
- Candidate future engines: sampler, FM synth, or other characterful instruments (**examples, not commitments**).
- Define behavior when replacing an instrument with existing patterns/automation.
- **Dynamic Scene Library (ENH-001):** create, select, rename, duplicate, delete, reorder and persist more than six scenes, with touch-friendly navigation and a sensible technical limit.
- Preserve compatibility with existing six-scene projects and the v0.6 .hbn schema; ensure scene references and song chains remain valid.
- Stronger arrangement transitions, automation, export, and light finishing/mastering tools.
- Review instrument names **BOP / GOO / BLIP / FUZZ**; current names are not permanently locked.

**Exit criterion:** More sound choices and a path to finished tracks, without sacrificing the four-slot simplicity.

## v1.0 — The Little Music Machine

A cohesive, reliable, installable tablet-first groovebox:
- Excellent touch UX and dependable audio on supported iPads/tablets.
- Solid project management and .hbn compatibility.
- Robust creative workflow from first idea through arrangement and export.
- Offline-first capabilities where technically practical.
- Consistent characterful identity and polished performance.
- Explicit documentation of any platform-specific limitations.

## Architecture decisions to protect now

These are **forward-looking constraints**, not requests to build every future feature in v0.5.

1. **Instrument slot abstraction:** four slots; separate slot identity from instrument engine identity.
2. **Audio source abstraction:** synthesis now, sample playback/recording later.
3. **Transport/sync abstraction:** internal clock now, external MIDI Clock/Link integration later.
4. **Versioned project schema:** plan for .hbn, embedded sample assets, and migrations.
5. **Independent music logic:** generation and transformations testable without UI/audio rendering.
6. **Tablet input model:** gestures, hit targets, pointer cancellation, and no hover-only essential actions.
7. **Export pathway:** future offline rendering/bounce and project packaging without coupling to the visual UI.

## Decisions register

| Decision | Status |
| --- | --- |
| Product direction: Playful Groovebox with Musical Toy personality | **Decided** |
| Primary platform: iPad/tablet | **Decided** |
| Four simultaneous instrument slots | **Decided** |
| Future ability to swap instruments in those slots | **Decided** |
| Import and record samples; chop and loop them | **Decided** |
| Dedicated jungle/breakbeat creation feature | **Decided** |
| Feature name: **Ruff in the Jungle** | **Decided** |
| Ruff mascot: kawaii anteater / kattemyrer | **Decided direction** |
| MIDI Clock and Ableton Link are desired | **Decided goal; feasibility pending** |
| Native project file extension: **.hbn** | **Decided** |
| Dynamic Scene Library (ENH-001) scheduled for v0.9 | **Decided placement** |
| v0.6 .hbn schema supports variable scene counts ahead of the v0.9 UI | **Decided architectural requirement** |
| Exact versions for other future features | **Provisional** |
| Sampling shared across instruments vs. sampler slot | **Open** |
| Ruff integrated into BOP vs. separate engine/tool | **Open** |
| Final instrument names | **Open** |
| PWA-only vs. native wrapper for external sync | **Open** |

## Parking lot — ideas for later

- More expressive character reactions and playful hardware details.
- Additional sound engines and user presets.
- Improved intelligent variations of entire grooves.
- Sample transient detection, time stretching, and more advanced sample manipulation.
- Optional MIDI mapping and external controllers.
- Additional export options.

New ideas should be evaluated against the product principles, not added automatically to the next release.

---

*Maintain this file as the product source of truth. Update the decisions register when choices are made, and keep implementation status distinct from aspirations.*
