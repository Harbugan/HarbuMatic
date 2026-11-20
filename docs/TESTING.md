# Testing HarbuMatic

## Automated (run on every change)

| Command | Covers | Environment |
|---|---|---|
| `npm test` | Release identity: one version source, `package.json` in sync, the exact creator credit, no hardcoded version elsewhere. Musical coherence metrics over many fixed seeds: chord tones on strong beats, motif repetition, smooth contour, resolved endings, controlled chaos, density, groove fundamentals, bass↔kick relationship, monophony. Also lock preservation for every transform × instrument, v0.4 migration, validation and repair, library safety, history coalescing, scene switching on bar lines, arrangement order and repeats, and loop-boundary detection for 16/32/64 steps. | Node 20+ |
| `npm run test:ui` | Layout audit at 1024×768, 1180×820, 1366×1024, 1440×900, 1180×740 (Safari with toolbars), 820×1180 and 768×1024 in JAM, Deep edit, ARRANGE and SOUND. It checks for clipped or overlapping controls, controls spilling out of their card or tile, console errors, an identical header and strip across JAM, SOUND and ARRANGE, the ARRANGE library column count and the SOUND label baselines. Interaction flows with touch emulation: tap to add and remove drum hits and notes, drag notes, undo/redo, Deep edit keeping state and playback, Pause/Resume/Stop, New Song, Generate in an empty song, Open, Arrange add/drag/duplicate/repeat/remove, Play from here, Export. Regression flows: drum label taps never block step editing (BUG-001, touch and mouse, stopped and playing), knob drags rotate only the indicator (BUG-003), and the version footer and Settings & help show the release identity. | Headless Chromium (Playwright) |

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
