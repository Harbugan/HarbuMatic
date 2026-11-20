# Testing HarbuMatic

## Automated (run on every change)

| Command | Covers | Environment |
|---|---|---|
| `npm test` | **Instrument architecture (v0.6 Phase 1):** registry resolution, immutability and the exact v0.5.1 defaults of BOP/GOO/BLIP/FUZZ; stable slot ids, several instances of a type, MUNCH kept but never played; v4 → v6 and v5 → v6 migration compared field by field with songs frozen from v0.5.1 (patterns, notes, steps, parameters, macros, mute/solo, scenes, arrangement, snapshots); idempotent and deterministic migration, JSON round-trips, refusal of unknown types and oversized files; the non-destructive v0.5 → v6 library copy; **scheduler dispatch replayed against eight logs frozen from the v0.5.1 scheduler** (same hits, times, durations, slides, mute/solo, scene switches, song mode); Generate/Mutate/Remix/Call & response/Humanize output identical to v0.5.1 for 12 seeded scenes; actions (selection, mute/solo, snapshots, scene/arrangement edits, pattern edits, undo/redo, autosave). Release identity: one version source, `package.json` in sync, the exact creator credit, no hardcoded version elsewhere. Musical coherence metrics over many fixed seeds: chord tones on strong beats, motif repetition, smooth contour, resolved endings, controlled chaos, density, groove fundamentals, bass↔kick relationship, monophony. Also lock preservation for every transform × instrument, v0.4 migration, validation and repair, library safety, history coalescing, scene switching on bar lines, arrangement order and repeats, and loop-boundary detection for 16/32/64 steps. | Node 20+ |
| `npm run test:ui` | Layout audit at 1024×768, 1180×820, 1366×1024, 1440×900, 1180×740 (Safari with toolbars), 820×1180 and 768×1024 in JAM, Deep edit, ARRANGE and SOUND. It checks for clipped or overlapping controls, controls spilling out of their card or tile, console errors, an identical header and strip across JAM, SOUND and ARRANGE, the ARRANGE library column count and the SOUND label baselines. Interaction flows with touch emulation: tap to add and remove drum hits and notes, drag notes, undo/redo, Deep edit keeping state and playback, Pause/Resume/Stop, New Song, Generate in an empty song, Open, Arrange add/drag/duplicate/repeat/remove, Play from here, Export. Regression flows: drum label taps never block step editing (BUG-001, touch and mouse, stopped and playing), knob drags rotate only the indicator (BUG-003), and the version footer and Settings & help show the release identity. Slot flows: four cards in slots 01–04, keyboard 1–4, Export writes v6 and re-imports, a stored MUNCH slot is kept but not shown, a v0.5 file imports with mute/arrangement/snapshots intact, and upgrading a browser that holds a v0.5 library leaves the v0.5 keys untouched. | Headless Chromium (Playwright) |
| `npm run test:baseline` | Compares the current build with a baseline build (e.g. the last release). Renders four songs **offline through both engines** (seeded randomness, virtual clock) and compares them sample by sample. Compares **screenshots** of JAM, Deep edit, SOUND for every instrument and ARRANGE pixel by pixel, plus the card markup. Without a baseline it only checks that every slot sounds on its own. Rendering the same build twice in Chromium differs by up to ~3e-5 per sample, so the limit is 1e-4 (max) / 1e-6 (rms). | Headless Chromium + a second dev server for the baseline (see the header of `tools/baseline-compare.mjs`) |

Golden references live in `tests/fixtures/`: `v5-*.json`, `dispatch-v051.json` and `generate-v051.json` were produced by `tests/fixtures/make-golden-v051.mjs` from the v0.5.1 code and must not be regenerated from newer code.

The musical tests don't just check that notes are in the scale. They measure structure (see `src/music/analysis.js`), so a regression that turns ideas into noise fails the suite.

## What automated tests cannot prove

`npm run test:ui` runs **simulated viewports in Chromium**, not iPad Safari. Check these by hand on a real iPad:

1. **Audio start and interruptions.** Tap to play on first load. Lock the screen or take a call, then resume. Try with the ring/silent switch both on and off (iPadOS 17+ should play either way).
2. **Touch feel.** Knob dragging (both vertical and horizontal motion work), drawing and moving notes, dragging the right edge to resize, painting drum rows, and dragging arrangement blocks. Confirm the page never scrolls or zooms while you do any of this.
3. **Safe areas and toolbars.** Landscape and portrait in Safari with the toolbar visible and in standalone mode (Add to Home Screen). Rotate while playing.
4. **Timing under load.** Play a busy scene with Deep edit open and pinch the browser chrome. The audio must not stutter. Visuals may drop frames.
5. **Offline.** Add to the home screen, open it once online, then switch on airplane mode and reopen.
6. **Long sessions.** Ten minutes or more with Auto-evolve on. Undo should step back through the evolutions.

## Manual smoke test (5 minutes)

- New song, then BOP and Generate, GOO and Generate, BLIP and Generate. Press Play. The parts should sound like they belong together.
- Set Chaos to 0, press Mutate a few times, and confirm the idea stays recognisable. Set Chaos to 100 and press Surprise. It should be wilder but still in key.
- Lock two BLIP notes in Deep edit, then press Generate. The locked notes must survive.
- In ARRANGE, add A, B, B and C. Drag C to the front, set B to ×2, switch to Whole song and press Play. The highlighted block should follow what you hear.
- Pause in the middle of a bar, then Resume. Playback continues from the same place. Stop goes back to bar 1.
- Export the song, start a new song, then Import the exported file. Everything should be back.
