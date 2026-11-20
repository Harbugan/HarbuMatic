# HarbuMatic v0.5 — architecture

## Technology decision

**Vanilla JavaScript with native ES modules, no build step, no runtime dependencies.**

- The deploy pipeline is a plain FTPS upload of static files. Native modules keep it that way. Every file in the repo is exactly what runs.
- Safari on iPadOS 15+ supports modules, container queries (16+), `dvh` and `color-mix` (16.2+). The UI needs iPadOS 16.2 or newer.
- No framework was added. The UI is a handful of imperative render functions driven by a small event bus. React or Vue would add weight without solving a real problem at this size.
- Vite and TypeScript were left out. They would need a build step in CI and give little benefit at ~5k lines. The music core is written so it can be moved to TypeScript later without restructuring. Data shapes are documented in `src/core/project.js`.
- Tests use Node's built-in `node:test`, so `npm test` needs nothing installed.

## Layers

```
src/core    project schema + migration + validation, history, persistence, rng, constants
   ↑
src/music   theory → harmony → rhythm → context → generate → transform   (pure functions + seeded rng)
   ↑
src/audio   engine (Web Audio graph + instruments) · position (pure) · scheduler (transport)
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

## Project data (schema v5)

Projects are plain JSON (`format: "harbumatic-project", v: 5`). See the header comment in `src/core/project.js` for the full shape. Changes from v0.4:

- `chain: [sceneIndex]` became `arrangement: [{ id, scene, reps }]`. These are scene instances with a repeat count, and a scene can appear many times.
- `scenes[i].harmony = { degrees, span } | null`: the scene's chord progression as scale degrees.
- Added `id`, `name`, `created`, `modified` and `format`.
- Melodic notes can have `pr` (chance to play), like drum steps.

`importProject()` detects the version and migrates v4 explicitly (`migrateV4`). It then validates and repairs the result: it clamps numbers, fills missing parameters, resizes rows and drops only impossible notes. Files from a newer version are refused with a clear message. A v0.4 autosave (`localStorage['harbumatic.v4']`) is adopted into the library once and the old key is left untouched.

### Song library

`localStorage` holds an index plus one key per song. New Song, Open, Import, Save a copy and Load demo all create or switch entries. None of them overwrites another song. Export downloads a `.json` file.

## Musical intelligence

All generators take a **shared context** built by `buildContext(project, scene)`. It contains key and scale, the scene's harmony, the drum groove (kick and backbeat lookup), mood, density and chaos.

- **Harmony.** Each scene has a progression (2–4 chords spread over a span of 16–64 steps). It is chosen from mood-specific progressions (no diminished chords, roots must be in the scale), or inferred from existing bass notes, for example in migrated v0.4 songs. Patterns shorter than the span use `chordsHeard()`, so notes fit every chord they will sound against as the loops wrap.
- **Drums.** Each mood has a groove template: four-on-the-floor for bouncy, laid back for dreamy, half-time for dark, euclidean for weird. Backbeat, hats by density, ghost notes and a phrase-end fill are added on top. Chaos adds syncopation and probability.
- **Bass.** A rhythm cell tied to the kick, in one of these styles: offbeat, lock, roll, flow or syncopated. The cell is repeated across the progression and transposed to each chord root. Approach notes lead into the next chord, slides go only into adjacent notes, and the result is always monophonic.
- **Melody.** Motif rhythm and contour are developed in forms like A R A E (call, response, ending). Strong beats snap to chord tones, leaps are followed by a step back, endings resolve to the tonic or a chord tone, and dreamy pads are voice-led.
- **Chaos** scales repetition variance, non-chord tones, leaps, syncopation and (weird mood only) chromatic neighbours. It stays bounded even at 100%.
- **Transform semantics.** Generate makes a new idea. Mutate makes a bounded number of local edits and leaves the first statement mostly alone. Evolve makes one or two tiny edits. Remix moves segments and re-fits each one to the chord at its new position. Surprise is a bold move (invert, octave, displace, double-time or regenerate) that is snapped back onto the harmony. All of them respect locks.

## Audio and transport

- **Transport.** Play starts from Stopped. Pause freezes the musical position and Resume continues from it. Stop returns to the beginning.
- **No stale events.** Each play session routes voices through fresh per-track gain gates. Pause, Stop and project switches close the gates, which cuts notes the 120 ms lookahead had already scheduled. Reverb and delay tails still ring out naturally.
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
