# HarbuMatic

A little machine for making music. Play first. Tweak forever.

Four kawaii band members in headphones — **BOP** (drums), **GOO** (acid bass), **BLIP** (melody synth) and **FUZZ** (texture) — plus **UNI** and the Happy Accident Lab. Built for iPad and other tablets first, desktop second. Runs in the browser, works offline once loaded and can be added to the home screen.

## Run it locally

No build step and no dependencies. The app uses native ES modules, so it has to be served over HTTP; opening `index.html` straight from disk won't work.

```bash
npm run dev
```

Then open http://localhost:5173. Any static server works too, for example `python3 -m http.server`.

To try it on an iPad on the same network, open `http://<your-computer-ip>:5173` in Safari. Use *Share → Add to Home Screen* for the standalone app.

## Tests

```bash
npm test
```

Runs the music, project and playback-logic tests with `node:test` (Node 20 or newer). No browser needed.

```bash
npm run test:ui
```

Runs the layout and interaction checks in headless Chromium at iPad-sized viewports. This needs Playwright (`npm i -D playwright && npx playwright install chromium`) and `npm run dev` running in another terminal.

## Project layout

| Path | What lives there |
|---|---|
| `index.html` | App shell (markup only) |
| `src/core/` | Project schema and migration, history, local song library, rng, constants |
| `src/music/` | Theory, harmony, rhythm, generators, transformations, macros, metrics. Pure, no DOM. |
| `src/audio/` | Web Audio engine and instruments, transport and scheduler, pure position logic |
| `src/app/` | Store, actions (all mutations) and bootstrap |
| `src/ui/` | Controls, characters, canvas sequencer |
| `src/views/` | Strip (transport + cards), JAM toolbar, Lab, Sound, Arrange, Song menu |
| `styles/` | Tokens, layout, components, views |
| `tests/` | `node:test` suites + v0.4 fixture |
| `tools/` | Dev server, UI checks |
| `legacy/` | The untouched v0.4 and v0.2 prototypes for reference |

More detail is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/TESTING.md](docs/TESTING.md) and [CHANGELOG.md](CHANGELOG.md).

## Deploy

Pushes to `main` upload the static files via FTPS (see `.github/workflows`). Nothing is built. Tests, tools and `package.json` are excluded from the upload.
