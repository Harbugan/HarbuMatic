# HarbuMatic — Bug & Improvement Tracker

> Last updated: 2026-11-22  
> Current baseline: **v0.5.1** (MUNCH dev preview from v0.6 Phase 4)  
> Stabilization: **v0.6 MUNCH stabilization** — MUNCH-1 … MUNCH-4 implemented, awaiting physical iPad verification (see `docs/MUNCH-STABILIZATION.md`)

This file tracks reproducible bugs and smaller usability improvements. It complements [ROADMAP.md](ROADMAP.md), which covers larger product capabilities.

## Workflow

**Status:** `Open` → `In Progress` → `Ready for Test` → `Resolved` (or `Won't Fix`).

**Priority:**
- **P1 — High:** Blocks a core workflow.
- **P2 — Medium:** Material usability or component issue with a workaround.
- **P3 — Low:** Cosmetic polish or minor enhancement.

A fix is **not Resolved until it has been verified**. Record device/browser and verification notes when possible. Do not assume the suspected root cause is proven.

## Issues

### BUG-001 — BOP sequencer becomes unusable after tapping a drum label
- **Type:** Bug
- **Priority:** P1 — High
- **Status:** Ready for Test (fixed in v0.5.1)
- **Reported in:** v0.5
- **Observed:** Clicking/tapping the drum names or rows on the left side of BOP's sequencer makes the sequencer stop responding to subsequent editing.
- **Reproduction (reported):** Open JAM → select BOP → tap a drum label on the left side of the sequencer → attempt to edit steps.
- **Expected:** Selecting/auditioning a drum row must not block subsequent step editing.
- **Investigation:** Inspect pointer capture, pointerdown/up/cancel handling, drum-label hit testing, drag state, and any overlay intercepting input. Confirm the actual cause before changing code.
- **Acceptance:** Drum labels can be tapped repeatedly and steps can immediately be added, removed, and edited afterward, on iPad touch and desktop pointer input.
- **Root cause (confirmed):** In `src/ui/sequencer.js`, a press on a drum label stored its gesture as `{ ...base, type: 'drumKey', row, id }`. The drum's `id` (e.g. `'kick'`) overwrote `base.id`, which holds the pointer id. `up()` then ignored the release (`d.id !== e.pointerId`), so the gesture was never cleared, and the "ignore a second finger" guard in `down()` dropped every later press. Reproduced in headless Chromium with touch and mouse, playing and stopped. The same bug also made the Lock tool on drum labels do nothing.
- **Fix:** The drum id is stored as `drum`, so the pointer id is kept. A finished label tap no longer falls through to the save/history path. As a safety net, `lostpointercapture` ends any gesture that is still open.
- **Verification:** `npm run test:ui` now taps labels (touch and mouse, stopped and playing), then adds and removes hits, drag-paints a row and undoes the stroke. These checks fail on the v0.5 code and pass with the fix. An extra scripted check sent a touch cancel during a label press and during a paint stroke; editing kept working afterwards. Not yet verified on a physical iPad.

### BUG-002 — Inconsistent button/text alignment
- **Type:** UI polish
- **Priority:** P3 — Low
- **Status:** Ready for Test (fixed in v0.5.1)
- **Reported in:** v0.5
- **Observed:** Some buttons and text labels appear misaligned in different areas of the interface.
- **Reproduction:** Visually inspect JAM, SOUND, and ARRANGE at tablet landscape and desktop viewport sizes; capture exact instances.
- **Expected:** Consistent centering, baseline alignment, spacing, and touch-target geometry.
- **Acceptance:** Identified alignment defects are corrected without introducing clipping or layout regressions. Document the affected components/screens.
- **Defects found and root causes (confirmed by measurement):**
  1. *Instrument cards, all modes:* the Solo button stuck out of the card by 7 px at 1024×768 and 13 px at 768×1024. The narrow-screen card rules in `styles/layout.css` (smaller cat, tighter padding, smaller M/S) never applied, because `components.css` loads later and its base rules have the same specificity.
  2. *ARRANGE scene library:* at container widths of 1000 px or more (e.g. 1180×820), tiles showed 3 wide columns with Preview/Add/Edit stacked as full-width buttons. The `@container` rule stood before the base `.arr-scenes` rule, so its 6-column grid lost the cascade while its button stacking still applied.
  3. *SOUND:* labels under segment pickers (KIT, OSC 1/2, WAVE) sat 8 px higher than the knob labels in the same row (BOP, GOO, BLIP).
- **Fix:** The narrow-screen rules gain a `.device` prefix so they apply, and a ~1024 px landscape rule makes the card cat slightly smaller. M/S may shrink to 38 px before they would overflow. The `@container` rule moved after its base rule. `.wave-pick` uses the same row geometry as a knob.
- **Verification:** The layout audit in `npm run test:ui` now also fails when a control spills out of its card, tile or group. It checks the library column count in ARRANGE and the label baselines in SOUND, at all seven viewports. Before/after screenshots were reviewed in headless Chromium. Not yet verified on a physical iPad.

### BUG-003 — Knob shadow rotates with the dial
- **Type:** Visual component bug
- **Priority:** P2 — Medium
- **Status:** Ready for Test (fixed in v0.5.1)
- **Reported in:** v0.5
- **Observed:** The knob's shadow/highlight rotates together with the knob when its value changes, making the physical lighting look incorrect.
- **Reproduction:** Adjust any affected rotary knob and watch its shading.
- **Expected:** The knob's stationary housing, cast shadow, and environmental lighting remain fixed; only the intended indicator/rotating surface changes orientation.
- **Investigation:** Separate fixed housing/shadow from rotating dial indicator or use an equivalent layered rendering approach.
- **Acceptance:** Rotate knobs across their full range; shadows remain visually consistent and pointer interaction still works.
- **Root cause (confirmed):** `Knob()` in `src/ui/controls.js` rotated `.cap`. That element carries the radial highlight, the inset shading, the bottom edge and the cast shadow, so all of them turned with the value.
- **Fix:** A transparent `.ind` layer inside `.cap` now holds the tick, and only `.ind` rotates. `.cap` and its lighting stay fixed. Value ranges, mapping, gestures, wheel, keys and double-tap reset are unchanged.
- **Verification:** `npm run test:ui` drags a knob and checks that the value changes, the indicator rotates and `.cap` has no transform. Screenshots at 0 %, 32 %, 68 % and 100 % show the highlight and shadow in the same place. Not yet verified on a physical iPad.

### BUG-004 — ARRANGE navigation header differs from JAM and SOUND
- **Type:** UX consistency bug
- **Priority:** P2 — Medium
- **Status:** Ready for Test (fixed in v0.5.1)
- **Reported in:** v0.5
- **Observed:** Switching to ARRANGE changes the top navigation/header composition instead of keeping the same persistent app shell as JAM and SOUND.
- **Reproduction:** Switch between JAM, SOUND, and ARRANGE and compare the top region.
- **Expected:** One consistent app header/navigation across all modes; only mode-specific content should change.
- **Acceptance:** Header height, placement, branding, mode switcher, and global actions stay consistent during mode changes, including on iPad.
- **Root cause (confirmed):** The `<header>` itself was already identical in every mode. `applyLayout()` in `src/app/main.js` added the `compact` class in ARRANGE, which collapsed the transport and instrument strip right under the header (124 → 66 px at 1180×820). The LCD and button labels disappeared and the content jumped up by 58 px.
- **Fix:** `compact` applies only to Deep edit, the JAM sub-mode where the player asks for more room. JAM, SOUND and ARRANGE now share the same header and strip; only the content below changes. ARRANGE stays scrollable, and its 6-column library (BUG-002) keeps it compact.
- **Verification:** For each of the seven viewports, `npm run test:ui` compares the position and size of the header, brand, mode switcher, global actions, strip, transport and cards across JAM, SOUND and ARRANGE. The check fails on v0.5 and passes now. Not yet verified on a physical iPad.

### MUNCH-1 — Microphone recording fails on iPad
- **Type:** Bug
- **Priority:** P1 — High
- **Status:** Ready for Test
- **Reported in:** v0.6 Phase 4 (PR #10 preview), physical iPad
- **Device / browser:** iPad, Safari, Chrome and Firefox (all WebKit)
- **Observed:** RECORD immediately shows *The microphone could not be started.* No permission prompt appears. The microphone works in other apps.
- **Root cause (identified in code, strongly supported, not confirmed on a device):** `engine.init()` sets `navigator.audioSession.type = 'playback'` (to play with the silent switch on). WebKit refuses capture under the `playback` session: `getUserMedia` rejects with `InvalidStateError` before any prompt. The recorder's error mapping did not list that name, so the generic message appeared. Desktop Chromium has no Audio Session API, so automated tests passed.
- **Fix:** The session switches to `play-and-record` inside the tap and is restored afterwards (`src/audio/session.js`). Constraints fall back from raw audio to `{ audio: true }`, and a refusal is never retried. Messages are mapped per error name and end with the browser error name. Diagnostics are kept in `recorder.diagnostics()`. MP4 is preferred on WebKit, there is no timeslice, and Safari's late last chunk is collected. The 30 s limit or a system interruption now keeps the recording (before, the limit discarded it). The AudioContext resumes after capture.
- **Test evidence:** `tests/munch-recorder.test.mjs` (15 tests) first reproduces the failure: under `playback`, without the switch, it gets `InvalidStateError`. It then covers the switch and restore, the fallback, the no-retry rule on denial, the error mapping, the format choice, cancel during the prompt, the time limit, interruption, MediaRecorder errors, repeated recordings and browsers without the API. `npm run test:ui` emulates the iPad Audio Session in Chromium: recording works twice, `playback` is restored and the audio keeps running.
- **Remaining limitations:** iPad Safari/WebKit itself has not been run. MP4/AAC decoding of iPad recordings has only been emulated.
- **Physical-device verification:** **not tested**.

### MUNCH-2 — "The sample could not be stored." on import
- **Type:** Bug
- **Priority:** P1 — High
- **Status:** Ready for Test (root cause not confirmed)
- **Reported in:** v0.6 Phase 4 (PR #10 preview)
- **Device / browser:** iPad Safari, normal sessions (private mode and desktop worked)
- **Observed:** Import sometimes ends with *The sample could not be stored.*
- **Analysis:** The message came from the generic wrapper around IndexedDB reads and writes after a successful open. The schema never changed in the repository's history. The most probable mechanisms are a dead long-lived connection (Safari's *Connection to Indexed Database server lost*) or a damaged database. Neither is proven, because the old code kept no browser error name.
- **Fix:** A failed transaction drops the connection and is retried once (connection-type errors only), and `onclose` drops dead connections. Database v2 adds missing stores without deleting data. Newer versions still open, and opening times out instead of hanging. Decode errors (*not an audio format…*) and storage errors (*could not be saved… [UnknownError while saving]*) are now distinct. A sample that decodes but cannot be written still plays from memory and is marked *Not saved on this device*. From there, *Try again* rewrites it, and *Repair storage…* (with confirmation) rescues readable samples, deletes only `harbumatic-samples` and writes them back. Persistent storage is requested after the first save.
- **Test evidence:** `tests/samples-store.test.mjs` adds failure injection: a refused write keeps the sample playable, retry, unreadable lookups, read errors versus *missing*, repair, and no eviction of unsaved samples. `npm run test:ui` covers real Chromium IndexedDB: a stale v1 database without its audio store, a lost connection (reopened and stored), and a browser refusing every write (Not saved → dialog with the browser error → Try again → survives reload → Repair keeps everything).
- **Remaining limitations:** The root cause is unconfirmed. If it recurs on the iPad, the toast and the dialog show the browser's error name and phase, and that text identifies the cause.
- **Physical-device verification:** **not tested**.

### MUNCH-3 — Samples do not stop when triggered again; playback leftovers
- **Type:** Bug
- **Priority:** P1 — High
- **Status:** Ready for Test
- **Reported in:** v0.6 Phase 4
- **Observed:** Retriggered samples overlap instead of stopping, which gives unwanted layering.
- **Root causes (confirmed):** (1) One-shot voices never cut each other, and choke was off by default and only applied between different slices. (2) `engine.closeGates()` returned early without an open play session, so **Stop while stopped** left auditions, held keys and long one-shots playing. (3) Cuts used `cancelScheduledValues`, which jumps back when a ramp is in progress, so cuts during attack or release could click. (4) Pads played a fixed 0.4 s audition, so Gate and Loop ignored release.
- **Fix:** Each voice has a key (slice, pitch or audition). A new hit with the same key cuts the previous one at the hit time, and different keys stay polyphonic. Choke is on by default for new sounds and cuts other slices. Cuts hold the current envelope value and ramp over 6 ms, and a later-scheduled voice is never cut by an earlier hit. Stop and Pause always silence. Pads use note on/off like keys.
- **Test evidence:** `tests/munch-voices.test.mjs` covers retrigger of the same slice, key and audition, polyphony across keys, cuts during the release ramp and during attack, pad Gate/Loop/One-shot, Stop while stopped, 10 Play/Stop cycles without orphaned sources, and later voices never being cut. The existing pool, choke, transport and scene tests were updated. `npm run test:ui` checks Stop-while-stopped and a held pad in Gate mode in Chromium.
- **Remaining limitations:** Choke applies between slices only; melodic keys stay polyphonic by design.
- **Physical-device verification:** **not tested**.

### MUNCH-4 — Fit to Beat: pitch-preserving Stretch and Tape
- **Type:** Feature gap (product decision) / Bug
- **Priority:** P1 — High
- **Status:** Ready for Test
- **Reported in:** v0.6 Phase 4 (only tape fit existed: changing BPM transposed the sample)
- **Decision:** Stretch (pitch kept) is the default, and Tape (pitch follows speed) is the alternative.
- **Fix:** New param `fitMode` (`stretch` | `tape`, default `stretch`), validated. Stretch uses WSOLA time-stretching anchored at slice boundaries (`src/samples/stretch.js`, pure JS, no dependency): slice attacks are copied exactly, positions scale exactly, there is no pre-echo, and joins are blended. Renders run in a Worker with a time-sliced fallback and are cached in the bank (two per sample). The voice plays the closest copy at an exact-duration residual rate and falls back to tape timing until a copy exists. Tape behaves as before. The fit is applied once: buffer (Stretch) or rate (Tape). The UI has a STRETCH/TAPE toggle, and the head shows *pitch kept* or the semitone shift.
- **Test evidence:** `tests/munch-stretch.test.mjs` covers pitch kept at ×0.5…×2 (440 Hz within 1 %), exact lengths, steady level, exact attacks at anchors, no pre-echo, stereo positions, the time-sliced runner matching the direct render, 30 s stereo performance, Stretch as default, BPM changes (exact timing, small residual before the re-render, musical pitch after), Tape pitch, transpose and tune independence, transport slices one per beat at the original pitch, and mode switching with no stuck voices. `npm run test:ui` checks that the render runs in a Worker in Chromium, the rate stays 1.0 in Stretch and becomes 0.833 in Tape.
- **Remaining limitations:** Typical WSOLA phasiness near ×0.5 or ×2 on sustained rich material. On pure sustained tones, the 5 ms join before a slice marker can dip about 3 dB. Until a re-render after a BPM change finishes, a small residual pitch is audible. Not yet listened to on an iPad.
- **Physical-device verification:** **not tested**.

### ENH-001 — Expand Scene Library beyond six scenes
- **Type:** Enhancement (not a bug)
- **Priority:** P3 — Low / product review
- **Status:** Planned for v0.9 (not part of v0.5.1)
- **Reported in:** v0.5
- **Observed:** The Scene Library is limited to six scenes.
- **Desired:** Let users add more scenes when needed, without overwhelming the tablet UI.
- **Design questions:** Dynamic scene creation/removal? Practical upper limit? Scene duplication? How to display and navigate larger libraries?
- **Technical considerations:** Review fixed-size assumptions across scene IDs, pattern storage, song chains, rendering, serialization, migrations, and scene switching.
- **Acceptance (provisional):** Users can create, select, rename, duplicate, arrange, and persist additional scenes beyond the original six; existing projects remain compatible.
- **Decision:** Scheduled for v0.9 Expand & Finish. v0.6 .hbn project schema must support variable scene counts and migration, without requiring the expanded UI in v0.6. Excluded from v0.5.1.

## v0.5.1 proposed scope

**Fix first:** BUG-001, BUG-003, BUG-004. Implemented and Ready for Test.  
**Polish:** BUG-002. Three concrete defects were found and fixed (see above).  
**Release identity:** Implemented. `APP_VERSION` in `src/core/constants.js` is the only version source. It drives the footer on the case's bottom bezel (`HarbuMatic v0.5.1 · Created by .::H∆RBUGΛП::.`), Settings & help and the service-worker cache name. `tests/identity.test.mjs` keeps `package.json` in sync, checks the credit's exact code points and fails if another shipped file hardcodes the version.  
**Deferred:** ENH-001 is planned for v0.9, with project-schema preparation in v0.6.

## Verification log

| ID | Tested version | Device / browser | Result | Notes |
| --- | --- | --- | --- | --- |
| BUG-001 | 0.5.1 | Headless Chromium (Playwright), touch emulation + mouse, 1180×820 | Pass (automated) | Reproduced on 0.5.0 first. iPad Safari: **not tested** |
| BUG-002 | 0.5.1 | Headless Chromium, 7 viewports (1024×768 … 768×1024) | Pass (automated + screenshots) | iPad Safari: **not tested** |
| BUG-003 | 0.5.1 | Headless Chromium, mouse drag | Pass (automated + screenshots) | Touch feel on iPad: **not tested** |
| BUG-004 | 0.5.1 | Headless Chromium, 7 viewports | Pass (automated) | iPad Safari: **not tested** |
| ENH-001 | — | — | Not implemented | Planned for v0.9 |
| MUNCH-1 | 0.5.1 + stabilization | Node (fake WebKit env) + headless Chromium with emulated iPad Audio Session | Pass (automated) | Reproduced first (InvalidStateError under `playback`). iPad: **not tested** |
| MUNCH-2 | 0.5.1 + stabilization | Node (failure injection) + headless Chromium IndexedDB | Pass (automated) | Root cause unconfirmed. iPad: **not tested** |
| MUNCH-3 | 0.5.1 + stabilization | Node (fake Web Audio) + headless Chromium | Pass (automated) | Stop-while-stopped reproduced in code. iPad: **not tested** |
| MUNCH-4 | 0.5.1 + stabilization | Node (DSP + fake Web Audio) + headless Chromium (Worker) | Pass (automated) | Not listened to on an iPad: **not tested** |

### Known remaining issues (v0.5.1)
- No fix has been verified on a physical iPad or in desktop Safari. Statuses stay *Ready for Test* until that is done.
- More stylesheet-order dead rules exist in `styles/layout.css` and were left untouched, because enabling them changes the design and needs sign-off: bigger cats on large screens (`min-height: 900px`) and smaller cats and UNI on short landscape screens (`max-height: 760px`).
- Deep edit still compacts the strip under the header. This is intentional; it is a JAM sub-mode, not a mode switch.
- At short landscape heights (e.g. 1180×740) the ARRANGE scene library needs a little scrolling, because the strip no longer collapses there.
- The footer credit uses the system fallback font for ∆ and Λ; Nunito has no glyphs for them. Glyph rendering on iPad still needs checking by eye.
- The service-worker cache is now named per version. A PR preview on another version can still clear the production offline cache on the same origin, and the reverse; this was already true whenever the cache name changed.

## New issue template

```md
### BUG-XXX — Short title
- **Type:** Bug / UI polish / Enhancement
- **Priority:** P1 / P2 / P3
- **Status:** Open
- **Reported in:** version
- **Device / browser:** if known
- **Observed:**
- **Steps to reproduce:**
- **Expected:**
- **Acceptance:**
- **Verification notes:**
```
