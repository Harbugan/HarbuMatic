# Changelog

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
