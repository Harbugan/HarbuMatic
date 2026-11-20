# HarbuMatic — architecture

## Technology decision

**Vanilla JavaScript with native ES modules, no build step, no runtime dependencies.**

- The deploy pipeline is a plain FTPS upload of static files. Native modules keep it that way. Every file in the repo is exactly what runs.
- Safari on iPadOS 15+ supports modules, container queries (16+), `dvh` and `color-mix` (16.2+). The UI needs iPadOS 16.2 or newer.
- No framework was added. The UI is a handful of imperative render functions driven by a small event bus. React or Vue would add weight without solving a real problem at this size.
- Vite and TypeScript were left out. They would need a build step in CI and give little benefit at ~5k lines. The music core is written so it can be moved to TypeScript later without restructuring. Data shapes are documented in `src/core/project.js`.
- Tests use Node's built-in `node:test`, so `npm test` needs nothing installed.

## Release identity

`APP_VERSION` in `src/core/constants.js` is the single version source. It feeds the footer on the case bezel, Settings & help and the service-worker cache (`sw.js?v=<version>`). For a release, bump it together with `package.json`; `npm test` fails if the two differ or another shipped file hardcodes the version. `APP_CREDIT` holds the exact creator credit with escaped Unicode.

## Layers

```
src/core    instrument registry, project schema + migration + validation, history, persistence, rng, constants
   ↑
src/music   theory → harmony → rhythm → context → generate → transform   (pure functions + seeded rng)
   ↑
src/audio   engine (Web Audio graph, one channel per slot) · voices (synthesis per instrument type) · position (pure) · scheduler (transport)
   ↑
src/app     store (project + ui state, event bus) · actions (the only mutators) · main (bootstrap, rAF loop)
   ↑
src/ui, src/views   rendering + touch interaction
```

Rules:

- `core` and `music` never touch the DOM or Web Audio. They run unchanged in Node, and that is how they are tested.
- The scheduler never touches the DOM. It pushes time-stamped events into a queue, and the UI drains that queue in `requestAnimationFrame` when each event's audio time arrives. The playhead, characters and active scene therefore match what you hear.
- Views call `actions`. Actions mutate the project, record history, autosave and emit events. `main.js` maps events to re-renders.
- A future native or other frontend can reuse `core`, `music` and `audio` as they are.

## Instruments: types and slots

HarbuMatic separates *what kind of instrument* something is from *which instrument in the song* it is.

- **Instrument Registry** (`src/core/instruments.js`). One definition per instrument **type**, keyed by a stable type id: `bop`, `goo`, `blip`, `fuzz` and the planned `munch`. A definition holds the display name and description, visual metadata (colours, headphones, CSS hook, character), the pattern kind (`drum` grid or `notes` piano roll), capabilities (`mono`, `slide`, `accent`, `generate`, `macros`, `presets`, …), default length and parameters, UI metadata (sequencer tools, audition note, piano-roll view) and two links:
  - `role`: the musical role (`drums`, `bass`, `synth`, `fuzz`) that `src/music` reasons about. Generators, transforms, macro maps and pitch ranges are keyed by role. This is the compatibility adapter that let the music layer stay untouched. It is also the track key the type had in v4/v5 songs.
  - `engine`: the id of the audio voice factory in `src/audio/voices.js`, or `null` when the type has no sound engine yet. The registry only names it, so `core` stays free of Web Audio.
  The registry is frozen pure data. It is not a plugin framework.
- **Slots** (`project.slots`). Each slot is one **instrument instance** with a stable id (`slot-01` …) that never depends on its type. It owns its parameters, macros, patterns (one per scene) and mute/solo. Two slots may share a type, and replacing an instrument later changes a slot's `type`/`params`/`patterns` in place while its id, position and snapshot keys stay.
- **Status.** Types with `status: 'ready'` and an engine are *playable*: they get a card, a channel and scheduler dispatch. `munch` is `planned`. A song may hold a MUNCH slot (validation keeps its data), but it is never played or shown. New songs get four slots: `slot-01` BOP, `slot-02` GOO, `slot-03` BLIP, `slot-04` FUZZ. `nextSlotId()` therefore hands out `slot-05` next, which is reserved for MUNCH.
- **Access.** Code reaches instrument data only through accessors in `src/core/project.js` (`slotById`, `typeOfSlot`, `playableSlots`, `patternAt`/`setPatternAt`, `slotAudible`, `rolePatterns`, `blockScene`, …) and their UI wrappers in `src/app/store.js` (`slot()`, `typeOf()`, `isDrumSlot()`, `visibleSlots()`, `pat()`). `store.ui.sel` is a slot id. No module outside the registry, the role-keyed music tables and the character artwork branches on an instrument name.

### Adding MUNCH (not done in this phase)

The slot model, schema, scheduler and card strip already take a fifth slot. What remains before MUNCH can ship:

1. A sampler voice factory in `src/audio/voices.js`. Then set `engine: 'munch'` and `status: 'ready'` in the registry.
2. A sample store (decode, keep, reference by id) outside the scheduler. Persisting samples needs storage beyond `localStorage` (IndexedDB or `.hbn`).
3. Decide MUNCH's pattern kind. `notes` is provisional (slices played like keys); a pad grid would add a pattern kind to `validatePattern` and the sequencer.
4. Character artwork (`catSVG` has none for `munch`), card CSS for `data-t=munch`, a SOUND panel (`SOUNDDEF`/`PRESETS`) and tool labels.
5. Musical role and generator decisions. MUNCH has `role: null` and `generate: false`, so the Lab skips it, and `MACRO_MAP` has no entry.
6. Layout. The strip has been verified with four cards only, so five cards need a layout pass at every viewport. The LCD spectrum colours and keyboard shortcuts already follow the visible slots.
7. Add `munch` to new songs (`DEFAULT_SLOT_TYPES`) or offer it as an opt-in, and migrate nothing else: older songs simply lack `slot-05`.

## Project data (schema v6)

Projects are plain JSON (`format: "harbumatic-project", v: 6`). See the header comment in `src/core/project.js` for the full shape:

```
scenes:      [{ id: 'scene-01', name, harmony }]
arrangement: [{ id, sceneId: 'scene-02', reps }]
slots:       [{ id: 'slot-01', type: 'bop', mute, solo, params, macros, patterns: { 'scene-01': Pattern, … } }]
snaps:       [null | { slots: { 'slot-01': { type, pattern, macros }, … } }]   (4)
```

- **Stable scene references.** Scenes have ids. Patterns are keyed by scene id and arrangement blocks reference `sceneId`, so a future Dynamic Scene Library can add, remove or reorder scenes without re-indexing anything. `project.scene` (the scene being edited) stays an index because it is view state. The schema has no fixed scene count. This version shows and plays six, and refuses a file with more scenes instead of truncating it.
- **Snapshots** key their content by slot id and remember the type. Recall only pours a pattern back into the same kind of instrument.
- **Packaging.** Everything a song references is addressed by id (slots, scenes, blocks), so a later `.hbn` package can add a sample/asset table keyed the same way without changing this structure.

### Migration

`importProject()` detects the version and migrates step by step: v4 → v5 (`migrateV4`, unchanged from v0.5) → v6 (`migrateV5`). It then validates and repairs the result: it clamps numbers, fills missing parameters, resizes rows, repairs duplicate or invalid ids and drops only impossible notes and references.

`migrateV5` is purely structural and deterministic (no random ids, no timestamps):

- The tracks `drums`, `bass`, `synth`, `fuzz` become `slot-01` … `slot-04` (BOP, GOO, BLIP, FUZZ).
- The six scenes get `scene-01` … `scene-06`.
- Block `scene: i` becomes `sceneId: scene-0(i+1)`, keeping block ids and repeats.
- Snapshot arrays become `{ slots: { slot-0k: { type, pattern, macros } } }`.

Re-importing a migrated song gives the identical song. Tests compare the result against songs frozen from v0.5.1 and replay the v0.5.1 scheduler output (see `docs/TESTING.md`).

Files from a newer version, with an unknown instrument type, or with more scenes or slots than supported are refused with a clear message. A v0.4 autosave (`localStorage['harbumatic.v4']`) is adopted into the library once and the old key is left untouched.

### Song library

`localStorage` holds an index plus one key per song under `harbumatic.v6.*`. On its first run the v6 library copies every song of the v0.5 library (`harbumatic.v5.*`) into its own keys, migrating each one, and keeps the current song current. The v0.5 keys are never modified or deleted. An older build on the same origin, such as the live site next to a PR preview, therefore keeps opening its songs. The copy happens once: songs an older build adds later are not imported again. Export/Import moves them. New Song, Open, Import, Save a copy and Load demo all create or switch entries. None of them overwrites another song. Export downloads a `.json` file.

## Musical intelligence

All generators take a **shared context** built by `buildContext(project, scene)`. It contains key and scale, the scene's harmony, the drum groove (kick and backbeat lookup), mood, density and chaos.

- **Harmony.** Each scene has a progression (2–4 chords spread over a span of 16–64 steps). It is chosen from mood-specific progressions (no diminished chords, roots must be in the scale), or inferred from existing bass notes, for example in migrated v0.4 songs. Patterns shorter than the span use `chordsHeard()`, so notes fit every chord they will sound against as the loops wrap.
- **Drums.** Each mood has a groove template: four-on-the-floor for bouncy, laid back for dreamy, half-time for dark, euclidean for weird. Backbeat, hats by density, ghost notes and a phrase-end fill are added on top. Chaos adds syncopation and probability.
- **Bass.** A rhythm cell tied to the kick, in one of these styles: offbeat, lock, roll, flow or syncopated. The cell is repeated across the progression and transposed to each chord root. Approach notes lead into the next chord, slides go only into adjacent notes, and the result is always monophonic.
- **Melody.** Motif rhythm and contour are developed in forms like A R A E (call, response, ending). Strong beats snap to chord tones, leaps are followed by a step back, endings resolve to the tonic or a chord tone, and dreamy pads are voice-led.
- **Chaos** scales repetition variance, non-chord tones, leaps, syncopation and (weird mood only) chromatic neighbours. It stays bounded even at 100%.
- **Transform semantics.** Generate makes a new idea. Mutate makes a bounded number of local edits and leaves the first statement mostly alone. Evolve makes one or two tiny edits. Remix moves segments and re-fits each one to the chord at its new position. Surprise is a bold move (invert, octave, displace, double-time or regenerate) that is snapped back onto the harmony. All of them respect locks.

## Audio and transport

- **Engine identity.** The engine (`src/audio/engine.js`) keeps one mixer channel per playable slot, keyed by slot id: bus → colour → drive → volume·mute → pan, plus delay and reverb sends. Each channel's voice comes from the factory its type names (`registry.engine` → `src/audio/voices.js`). A factory builds independent per-instance state: the mono acid oscillator, the BLIP LFO, the open-hat choke and the FUZZ crusher. Two slots of one type therefore never share a voice. The synthesis code itself is unchanged from v0.5. `syncSlots()` keeps channels in step with the song (new song, undo, a future slot change).
- **Dispatch.** For every playable slot the scheduler reads that slot's pattern for the current scene. It decides by pattern kind and capabilities (`slide` → slide detection, `mono` → acid gate length), never by instrument name. It calls `engine.trigger(slotId, time, hit)`. UI events carry hits keyed by slot id.
- **Future sampler.** A sample engine registers as another voice factory. Sample decoding and storage stay outside the scheduler: the voice receives playable buffers, and the scheduler keeps dispatching hits as it does for the synths.

- **Transport.** Play starts from Stopped. Pause freezes the musical position and Resume continues from it. Stop returns to the beginning.
- **No stale events.** Each play session routes voices through fresh per-slot gain gates. Pause, Stop and project switches close the gates, which cuts notes the 120 ms lookahead had already scheduled. Reverb and delay tails still ring out naturally.
- **Position logic** (`src/audio/position.js`) is pure and unit-tested:
  - Queued scene switches land on the next bar.
  - Song mode walks the arrangement, honours repeats and uses each scene's longest pattern as its length.
  - `isLoopBoundary()` detects every loop restart for 16, 32 and 64-step patterns. v0.4 missed boundaries after its step counter wrapped.
- **Auto-evolve** runs inside the scheduler before the boundary step is scheduled. The new loop therefore plays the evolved pattern, with no one-step lag.
- **Interruptions.** If iOS suspends or interrupts the AudioContext, the transport pauses and asks you to tap Resume. `navigator.audioSession.type = 'playback'` is set where supported, so the ring/silent switch doesn't mute the app on iOS 17+.

## UI structure

- **Standard JAM** shows Draw and Erase, octave buttons, Clear and Deep edit. You can add and remove notes by tapping, and move or resize them by dragging.
- **Deep edit** (the expanded JAM) uses the same sequencer and state. It adds Velocity, Chance, Slide, Lock, bar length, ×2, zoom, the scale fold ("In key") and the velocity lane. Cards shrink to cat, name and M/S, the bottom bar hides, and the Lab becomes a drawer.
- **Layout** responds to available space:
  - Landscape tablets get a side Lab panel.
  - Portrait and narrow screens get a Lab drawer.
  - Short screens compress the transport and Lab.
  - Container queries fit the editor toolbar to the space it actually has.
- **History** stores snapshots of the whole project. Continuous gestures (knobs, tempo, repeats) are coalesced into one entry.
