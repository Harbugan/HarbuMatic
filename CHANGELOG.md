# Changelog

## Unreleased — v0.6 Phase 3: MUNCH sample engine

MUNCH can import, record, store and play samples, melodically and as eight slices, through the normal transport. It is a **dev preview**: playable only with `?munch=dev`. Without the flag nothing changes for players. The version stays 0.5.1.

### Added
- **Sample store** (`src/samples/store.js`): IndexedDB with original bytes and metadata, SHA-256 content ids (identical files stored once; a missing sample is restored by importing the same file), atomic writes, clear errors for empty, unsupported, too large (> 32 MB), too long (> 30 s), quota and unavailable storage. Nothing is deleted automatically.
- **Sample bank** (`src/samples/bank.js`): decoded AudioBuffers with a 96 MB LRU budget (the current song's samples are pinned), reversed copies built ahead of time, explicit load states.
- **Recorder** (`src/samples/recorder.js`): MediaRecorder in the browser's own format, 30 s limit, permission and hardware errors, the mic is always released, cancelled when the page is hidden.
- **MUNCH voice** (`createMunchVoice`): AudioBufferSourceNode playback through MUNCH's mixer channel; pitch as playback rate around a root (default C4); oneshot, gate and loop; reverse; non-destructive trim; attack/release; velocity; 8-voice pool with stealing; every source stopped and disconnected.
- **Slices**: eight equal slices by default, stored as normalized boundaries, validated and movable through the data model; notes trigger a slice with an explicit `slice` field.
- **Test bench** in SOUND (dev preview): import, record, sample state, slice pads, slice step grid; Pitch, Trim and Play knobs.
- `docs/SAMPLES.md`: design, schema, limits, `.hbn` packaging plan, iPad Safari test plan.

### Changed
- Registry: MUNCH has `engine: 'munch'` and the new `status: 'preview'` (playable only while previews are enabled), plus clamped params (`paramRanges`/`paramChoices`, MUNCH only).
- Schema v6 (additive): `slot.sample` on sampler slots; optional `slice` on sampler notes.
- Export warns when a song references samples: the JSON file is not portable yet.
- Lab generators and sound shapers are shown as unavailable for an instrument without them (only MUNCH).

## Unreleased — v0.6 Phase 2: five instrument slots

Structure only. The four instruments sound, look and behave exactly as before, the normal UI still shows four cards, and the version stays 0.5.1.

### Changed
- **Five slots in every song**: new songs hold `slot-01` BOP, `slot-02` GOO, `slot-03` BLIP, `slot-04` FUZZ and `slot-05` MUNCH. MUNCH stays `planned`: kept in the song, never played, soloed, timed, generated or selected.
- **Migration**: v4, v5 and four-slot v6 songs gain one empty MUNCH slot when opened (`slot-05`, or the next free id if another instrument owns it). Existing slots are never changed, existing MUNCH slots are kept, and repeated imports are idempotent. The schema stays v6.
- **Selection**: `selectSlot` refuses planned instruments.
- **Layout**: `#cards[data-count="5"]` has a five-column strip with a stacked card for narrow widths. It is only used by the dev preview `?preview=five`, which shows MUNCH as an inert placeholder card (provisional artwork and colours).
- **MUNCH integration points**: `ui.layers` (`play`, `chop`, `twist`) in the registry, and the voice-factory route for a future sampler documented in `docs/ARCHITECTURE.md`.

### Tests
- New `tests/five-slots.test.mjs`; existing slot tests updated for five slots.
- `npm run test:ui` checks the five-card preview at twelve viewports in four modes and the four-slot import.

## Unreleased — v0.6 Phase 1: instrument foundation

Architecture only. The four instruments sound, look and behave exactly as in 0.5.1, and nothing new is visible in the UI. The version stays 0.5.1 until v0.6 is released.

### Changed
- **Instrument Registry** (`src/core/instruments.js`): one frozen definition per instrument type (`bop`, `goo`, `blip`, `fuzz`, plus `munch` registered as a planned, non-playable type). Each holds name, description, colours, pattern kind, capabilities, default parameters, UI metadata, the musical role and the audio engine id.
- **Instrument slots**: songs hold `slots` with stable ids (`slot-01` … `slot-04`) that are independent of the instrument type. Each slot owns its parameters, macros, patterns, mute and solo. Several slots of one type are supported by the data model, engine and scheduler.
- **Project schema v6**: scenes have stable ids, patterns are keyed by scene id, arrangement blocks reference `sceneId`, and snapshots are keyed by slot id and remember the instrument type. The schema has no fixed scene count (the UI still shows six).
- **Audio**: one mixer channel per slot. Synthesis moved unchanged into per-type voice factories (`src/audio/voices.js`), so per-instance state (mono bass oscillator, LFO, hat choke, crusher) is no longer shared. The scheduler dispatches through slots by pattern kind and capabilities.
- **UI**: cards, sequencer, SOUND, Lab, ARRANGE, LCD and characters resolve instruments through the registry and slot ids. The card strip renders whatever slots are visible.
- **Library**: songs are stored under `harbumatic.v6.*`. On first run the v0.5 library is copied and migrated; the v0.5 keys are left untouched, so the live 0.5.1 site on the same origin keeps working.

### Migration
- v4 and v5 songs migrate to v6 without loss: patterns, notes, steps, parameters, macros, mute/solo, scenes, harmony, arrangement (ids and repeats) and snapshots. v5 → v6 is deterministic and idempotent.
- Files from a newer version, with an unknown instrument, or with more scenes/slots than supported are refused with a message instead of being cut down.

### Fixed (post-merge hardening)
- **Recoverable v0.5 → v6 library migration**: the v6 index keeps a per-song ledger (`v5Migration`). A song that fails to copy (storage quota vs. damaged data are told apart) no longer marks the whole library as adopted: it is retried on every launch, copied songs are never duplicated or overwritten, deleted ones are not resurrected, and the v0.5 keys are never written. A warning toast appears when songs could not be copied. Libraries created by the first v6 build are reconciled once.
- **Solo ignores planned instruments**: `anySolo()` only counts playable slots, so a stored MUNCH slot with `solo: true` can no longer silence BOP, GOO, BLIP or FUZZ.

### Tests
- New `tests/library-migration.test.mjs` and `tests/solo.test.mjs`.
- New `tests/instruments.test.mjs`, `tests/migration.test.mjs`, `tests/scheduler.test.mjs` and `tests/app.test.mjs`, with golden references frozen from v0.5.1 (songs, scheduler dispatch logs, generator output).
- `npm run test:ui` covers the slot flows and the v0.5 → v6 library upgrade.
- New `npm run test:baseline` compares offline audio renders and screenshots with a baseline build.

### Known limitations
- MUNCH has no engine, artwork, SOUND panel or generator yet; see "Adding MUNCH" in `docs/ARCHITECTURE.md`.
- Five cards have not been laid out or tested at every viewport.
- Songs saved by this version cannot be opened by 0.5.1 (it refuses them with a message; nothing is deleted).
- Verification ran in Node and headless Chromium only, not on a physical iPad.

## 0.5.1 — Bugfix & UI polish

Stabilization only. No musical behaviour, project format or saved data changed.

### Fixed
- **BOP sequencer stopped responding after tapping a drum label (BUG-001).** The label gesture overwrote its own pointer id, so the release was ignored and every later press was dropped. Labels can now be tapped again and again. Steps stay editable straight away, with touch and mouse, while playing and while stopped. The Lock tool on drum labels works again, and a lost pointer capture can no longer leave a gesture stuck.
- **Knob lighting rotated with the dial (BUG-003).** Only the indicator layer rotates now. The cap's highlight, shading and cast shadow stay fixed.
- **ARRANGE changed the area under the header (BUG-004).** JAM, SOUND and ARRANGE now share one header and one transport/instrument strip. Only Deep edit still compacts the strip.
- **Alignment and spacing (BUG-002):**
  - The Solo button no longer sticks out of instrument cards at 1024×768 or in portrait. Narrow-screen card rules that never applied now do.
  - The ARRANGE scene library uses 6 columns on wide screens, as intended, instead of 3 tiles with stacked full-width buttons.
  - In SOUND, labels under segment pickers line up with the knob labels.

### Release identity
- `APP_VERSION` in `src/core/constants.js` is the only version source. The UI, the service-worker cache name and `package.json` (checked by a test) follow it.
- A subtle footer on the case's bottom bezel shows `HarbuMatic v0.5.1 · Created by .::H∆RBUGΛП::.`. Settings & help shows the same version and credit.

### Tests
- New `tests/identity.test.mjs` covers the version source, the exact credit code points and the absence of hardcoded version strings. It also checks that the identity never goes into song data.
- New checks in `npm run test:ui`:
  - Regression flows for BUG-001 and BUG-003.
  - Header and strip geometry across modes, at every viewport.
  - Controls staying inside their cards and tiles, the ARRANGE library columns and the SOUND label baselines.
  - The footer text and that it covers no control.

### Known limitations (0.5.1)
- All verification ran in headless Chromium. Nothing has been checked on a physical iPad yet; see `BUGS.md` for the remaining issues.

## 0.5.0 — Tablet-first refinement & architecture

### Architecture
- The single 140 KB HTML file is split into ES modules: `core`, `music`, `audio`, `app`, `ui`, `views` and `styles`. There is still no build step and there are no dependencies.
- Music generation and the audio scheduler are independent of the DOM. The music core is unit-tested in Node.
- Project schema v5 has explicit v0.4 migration, validation/repair and friendly errors for unsupported files.
- The v0.4 and v0.2 prototypes are kept untouched in `legacy/`.

### Tablet UX
- New layout for iPad landscape:
  - The transport sits beside the instrument cards, so the editor gets the full width.
  - All touch targets are about 44 px.
  - No essential action needs hover, right-click or a keyboard.
- Portrait and narrow screens get the Lab as a slide-over drawer. Short screens compact the transport and Lab. The editor toolbar uses container queries.
- Safe areas, `100dvh`, no page scroll or bounce, no text selection or tap highlight, and pointer-capture gestures with cancellation handling.
- **Standard JAM:** Draw and Erase, octave buttons, Clear and Deep edit. Tap to add, tap a note to remove, drag to move, drag the edge to resize.
- **Deep edit (expanded JAM):** Velocity, Chance (now also for melodic notes), Slide, Lock, bar length, ×2, zoom, In key / All notes, octave buttons and the velocity lane. It shares state with Standard JAM. Switching keeps notes, playback, selection and zoom.
- The piano roll can fold to in-key rows ("In key"). Rows are bigger and you can't hit wrong notes. Drag the key column to scroll and tap it to hear a note.
- Knobs respond to both vertical and horizontal drags, and a double tap resets them.
- **Lab:**
  - Generate, Mutate, Evolve, Remix and Surprise are up front.
  - Mood chips and the Chaos/Density knobs sit under a "Vibe" heading.
  - "More tricks", "Key & chords" and "Snapshots" fold away.
  - Snapshot clear is a visible button. It no longer appears only on hover.

### Projects
- A **Song menu** in the header holds New song…, Open…, Rename…, Save a copy, Export file, Import file…, Load demo song and Settings & help.
- **New Song** creates a genuinely empty song: four instruments, default sounds, an empty arrangement, a chosen name, tempo and starting vibe. The previous song stays in the library.
- Songs live in a local library and autosave. Saving also happens immediately when the tab is hidden. A v0.4 autosave is adopted once without being deleted.

### ARRANGE
- The view is split into the **Song** (arrangement lane) and the **Scene library**.
- Each scene tile shows a mini map of which instruments play and roughly where, its length and its chords. Tiles have Preview, Add and Edit buttons and can be renamed.
- Blocks are scene instances. Drag them to reorder, or tap one for Move ◀ ▶ (the button fallback), Repeat ×1–8, Duplicate, Play from here, Edit scene and Remove. Removing a block never deletes the scene.
- Loop scene and Whole song are an explicit choice. The playing block is highlighted in sync with the audio.

### Musical intelligence
- A shared musical context combines key, scale, the scene's harmony, the drum groove, mood, density and chaos.
- Scenes have a chord progression. It is chosen per mood, inferred from an existing bass, or rerolled with "New chords". Loops of different lengths stay harmonically aligned.
- Each mood has its own drum groove, with backbeats, ghost notes, fills and chaos-driven syncopation.
- Bass lines are built from a kick-aware rhythm cell, follow chord roots, use approach notes and slide only into adjacent notes.
- Melodies are built from motifs with call/response forms, chord tones on strong beats, gap-fill after leaps and resolved endings. Dreamy pads are voice-led.
- Generate, Mutate, Evolve, Remix and Surprise now behave as clearly different operations, and all of them respect locks.

### Audio and stability
- Real transport semantics: Play, Pause (keeps the position), Resume and Stop (back to the start).
- No stale notes after Stop, Pause or a project switch. Each play session uses its own gates.
- Fixed: Auto-evolve missed loop boundaries for some lengths and applied changes one step late. It now runs inside the scheduler on every loop boundary.
- The scheduler recovers after tab stalls instead of firing a burst of backlog notes.
- iOS: the transport pauses on audio interruption, and playback works with the silent switch on (iOS 17+).
- Undo/redo also covers tempo, swing, scene names, the arrangement, repeats, global FX and snapshot recall. Continuous gestures produce one history entry each.
- Fixed: undo didn't reapply global FX.

### PWA
- Web app manifest, icons, Apple meta tags, and a network-first service worker that gives offline use after the first visit.

### Relocated (not removed)
- Card Vol/Pan knobs moved to SOUND → Channel. They were too small to use on cards with touch.
- The Swing knob moved to SOUND → Groove + shared FX. It is also still the Movement macro on BOP.
- Focus view is replaced by Deep edit (`F`).
- Right-click delete still works on desktop, but tapping a note now deletes it.

## Known limitations (0.5.0)
- The app has not been tested on a physical iPad yet. All viewport checks are simulated in Chromium (see `docs/TESTING.md`).
- Browsers stop Web Audio when the app is in the background. There is no background playback.
- The app must be served over HTTP. Opening `index.html` from disk doesn't work because of ES module rules.
- Songs are stored per browser (localStorage). There is no cloud sync, so use Export for backups. Very large libraries may hit storage quotas, and the app warns when an autosave fails.
- Harmony works in diatonic terms. In `chromatic` the chords are built on natural minor.
- There is no pinch-zoom in the piano roll. Use the Zoom buttons in Deep edit.
- Drag-reordering in ARRANGE uses pointer events. Keyboard users can use the block's Move buttons or Alt+←/→.
