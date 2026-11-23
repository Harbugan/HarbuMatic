# HarbuMatic — Context Map

Purpose: Locate relevant code quickly. This is an index, not a complete architecture specification.

## Architecture

| Area | Primary location |
|---|---|
| App bootstrap and interactions | `src/app/` |
| Project schema, state and migration | `src/core/` |
| Music theory and generation | `src/music/` |
| Audio engine, voices and transport | `src/audio/` |
| Sample handling and storage | `src/samples/` |
| Reusable UI controls | `src/ui/` |
| JAM, SOUND, ARRANGE and instrument views | `src/views/` |
| Layout and styling | `styles/` |
| Automated tests | `tests/` |
| Development and test tools | `tools/` |

This map is a navigation hint. Verify paths against the current repository before modifying code.

## Important files

- `src/core/constants.js` — canonical application version and creator credit.
- `src/core/instruments.js` — instrument definitions and registry.
- `src/core/project.js` — project model.
- `src/ui/sequencer.js` — sequencer interaction.
- `docs/ARCHITECTURE.md` — detailed architectural reference.
- `docs/TESTING.md` — testing documentation.

## Existing test commands

- `npm test`
- `npm run test:ui`
- `npm run test:baseline`

UI tests may require a running local server and Playwright.

## Architectural boundaries

- Keep scheduling independent from sample loading and decoding.
- Keep music generation independent from the DOM.
- Use established application state and mutation paths.
- Preserve instrument registry and project-schema compatibility.
- Reuse existing audio voices and transport infrastructure.
- Avoid introducing parallel state or playback systems.

## Release identity

The application version is defined in `src/core/constants.js`.

Preserve the creator credit exactly:

Created by .::H∆RBUGΛП::.

Do not bump versions unless the task explicitly authorizes it.

## Context loading

Start with this file only when the task requires architecture navigation.

Then inspect the relevant source files.

Read detailed documentation only when a concrete question requires it.

Do not preload every source file, test or historical design document.
