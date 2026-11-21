# MUNCH Phase 4 — The Playful Instrument: audit and plan

> v0.6 Phase 4. Written before implementation, kept as the design record. Starting point: `main` at the merge of
> PR #9 (Phase 3 sample engine). MUNCH stays a **preview** instrument (`?munch=dev`) in this phase: the registry
> status flips to `ready` only when the release decision is made (see "Release gate" below).

## 1. UX audit of the Phase 3 test bench

| Finding | Effect | Phase 4 answer |
|---|---|---|
| Selecting MUNCH keeps whatever mode was open (usually JAM). | The first thing a new user sees is an empty piano roll for an instrument with no sound. | Selecting MUNCH opens its SOUND workspace, unless the player explicitly left it before. Leaving MUNCH returns to the mode it came from. |
| Import and Record sit at the bottom of the SOUND view, under Pitch/Trim/Play/Channel/Groove knobs. | At 1194×834 they are below the fold: the instrument's only entry point needs scrolling. | Empty state: one big RECORD and one big IMPORT button are the first controls, next to MUNCH asking to be fed. |
| The Lab shows Generate, Mutate, Evolve, Remix, Surprise, all disabled "not for MUNCH". | Five dead buttons in the most prominent panel. | For MUNCH the Lab hides its generators, vibe and chaos, and points to MAGIC CHOP. Key & chords and Snapshots stay. The other four instruments are unchanged. |
| Melodic notes are drawn in JAM, slice steps in a SOUND grid, only the first 16 steps. | Two editors, one hidden pattern half. | One pattern (the slot's notes), two views: CHOP's slice sequencer (paged, all lengths) and JAM's piano roll. No second pattern state. |
| No waveform; slices can only be reset to eight equal parts. | Chopping is impossible in the UI. | A real waveform editor: cursor, CHOP HERE, drag, delete, split, reset, zoom, undo. |
| Sound shapers bar says "MUNCH has no sound shapers yet". | Wasted row in SOUND. | The MUNCH workspace uses the full width and height: the side panel becomes a drawer and the bottom bar is hidden while the workspace is open; FX toggles move into TWIST. |
| Pitch/Trim/Play knobs are generic SOUND knobs. | Technical, not playful. | PLAY (keys), CHOP (waveform, pads, sequencer, MAGIC CHOP) and TWIST (grouped knobs) with large touch targets. |

## 2. Architecture audit

Phase 3 gives Phase 4 everything it needs at the engine level, so Phase 4 is UI + small pure additions:

- `src/core/samples.js` — pure slice and pitch maths. Extended with slice edit operations, deterministic note
  remapping and tape-fit maths.
- `src/samples/bank.js` — decoded buffers. Extended with cached waveform peaks (computed once per buffer).
- `src/audio/voices.js` — `createMunchVoice`. Extended with the fit rate, held notes (key down/up), an explicit
  audition region and an optional "one chop at a time" cut. No second playback system.
- `src/app/actions.js` — the only mutators. New MUNCH actions record history and autosave like every other edit.
- `src/views/munch-dev.js` (test bench) is removed and replaced by `src/views/munch.js` (+ `munch-wave.js`).
- The scheduler is not changed: it already forwards `slice` and reads params at trigger time.

## 3. Data-model risks and decisions

### 3.1 Slice identity (the main risk)

Notes refer to slices by **index** (`note.slice = k`). Inserting a boundary inside slice *j* shifts every slice
after it by +1; deleting a boundary shifts them by −1. Without care, a saved groove would silently start playing
the wrong slices.

Options considered:

1. **Stable slice ids** (`sample.sliceIds[]`, notes store `sliceId`). Robust, but changes the meaning of the note
   field. A Phase 3 build on the same origin (PR preview vs. live site share the song library) would ignore the new
   field and play stale indexes; two sources of truth could drift. Needs a schema bump and migration.
2. **Index + explicit, deterministic remap** (chosen). The schema stays v6 and unchanged in shape. Every structural
   slice edit is one action that rewrites the slice indexes of **all** of this slot's notes in **every scene** and
   in **every snapshot** in the same step, and records one history entry, so undo/redo restores boundaries and notes
   together.

The remap rule is positional and the same for every structural edit: **an old slice maps to the new slice that
contains its start position** (its attack). That gives:

| Edit | Old slice → new slice |
|---|---|
| CHOP HERE / Split inside slice *j* | `k ≤ j` → `k` (the first half keeps the attack), `k > j` → `k + 1` |
| Delete boundary *i* (merge *i − 1* and *i*) | `k < i` → `k`, `i` → `i − 1` (the merged slice contains its audio), `k > i` → `k − 1` |
| Reset to eight equal slices | each old slice → the new slice that holds its old start |
| Move a boundary | no remap: index identity is kept, only the region changes (that is what "move" means) |
| A new sample | no remap: the groove keeps its pad numbers and plays the new sound (swap the break, keep the pattern) |

A note can never be remapped to an index outside the new slice list, and notes never move in time. Edits that
would exceed 16 slices are refused with a message. Tests cover insertion, deletion, movement, reset, snapshots,
undo/redo and loading Phase 3 songs unchanged.

### 3.2 Tempo fit (Tape Fit)

New MUNCH params (additive, schema stays v6):

```
fit:     'off' | 'half' | '1' | '2' | '4'   (bars of 4/4 at the project tempo; 'off' = original speed)
fitFine: −0.12 … +0.12                     (manual fine adjustment of the fit speed, ±12 %)
choke:   false | true                      (slice notes cut the slice that is still playing)
```

- **Source duration** = the active (trimmed) region `(end − start) × duration`, never blindly the whole file.
- **Target** = `bars × 4 × 60 / bpm` seconds. `fitRatio = source / target × (1 + fitFine)`.
- The ratio is computed **at trigger time** from the current BPM, so changing tempo re-fits immediately and nothing
  is stored per BPM.
- **Reasonable range** is ×0.5 … ×2 (±1 octave). Choosing a length outside it is refused with a clear message; if a
  later BPM change pushes an enabled fit outside it, playback clamps to the range and the workspace says so.
- **Pitch stays explicit and separable.** The playback rate of any MUNCH note is
  `2^((transpose + tune) / 12) × fitRatio`, with `transpose = p − root` for melodic notes and `p − 60` for slice
  notes. Root, transposition, manual tune and fit are separate values; enabling Fit never touches `tune` or `root`.
  Fit is tape-style: it changes speed **and** pitch. Pitch-preserving stretch is not part of v0.6 and is not offered.
- **Slices.** The fit ratio is a tape speed for the whole sample, applied once per voice to melodic and slice notes
  alike. Slices are not re-timed by the scheduler; each slice note plays its region at the same tape speed. When the
  trimmed region is a loop of *N* bars and Fit is *N* bars, each slice therefore lasts exactly its share of those
  bars at the project tempo, and slice *k* played on its home step reproduces the loop. The ratio is never applied
  twice: step times come from the transport, durations from the voice.
- **Default off.** Existing songs get `fit: 'off'` and play exactly as before.

### 3.3 Unknown and newer data

Validation used to rebuild `slot.sample` and MUNCH `params` from known keys only. Phase 4 keeps unknown keys there
(primitive values only, bounded) so a song saved by a later build survives a round trip through this one. Files from
a newer schema version are still refused, as before.

### 3.4 What stays out of the JSON

Audio stays in IndexedDB. The export message keeps saying that the file is not portable. `.hbn` is Phase 5.

## 4. UX structure

```
MUNCH workspace (SOUND, full width; side panel = drawer, bottom bar hidden)
├─ head      character · sample name + status + ▶ · PLAY | CHOP | TWIST · FIT TO BEAT (Off ½ 1 2 4) · Scenes/Lab
├─ empty     "Feed me a sound!" · ● RECORD · ⤓ IMPORT        (no sample, or missing on this device)
├─ waveform  real peaks · cursor · slice markers + handles · selected slice · trim shading · zoom ± · beat ruler
├─ PLAY      2-octave keyboard (velocity from touch height, polyphonic, hold for gate/loop) · root ◀▶ · octave · mode
├─ CHOP      CHOP HERE · split · delete · nudge ◀▶ · reset 8 · zoom | pads (bank A/B) · MAGIC CHOP | slice sequencer
└─ TWIST     Region · Pitch · Play · Space & colour · Groove (shared)
```

Navigation rule: selecting MUNCH opens SOUND unless the player explicitly chose another mode while MUNCH was
selected; choosing SOUND again re-arms it. When MUNCH opened SOUND by itself and the player selects another
instrument without touching the mode buttons, the previous mode comes back. BOP/GOO/BLIP/FUZZ never change mode.

## 5. MAGIC CHOP

Pure and deterministic (`src/music/magicchop.js`, seeded rng). It reasons about where each slice sits in the loop
at the current tempo and tape speed ("home step"), classifies slices by metrical role (downbeat, backbeat,
off-beat), and fills one-bar templates per style with slices of the matching role, so kicks land where kicks
belong. Bars repeat with controlled variation at phrase ends. Styles: Straight, Syncopated, Half-time, Playful,
Chaos. It writes slice notes only: melodic notes and locked notes stay, and steps that hold a locked note get no new
notes. One history entry per generation; the workspace offers Again / Keep / Undo (Undo returns to the pattern from
before the first generation).

## 6. Release gate

MUNCH remains behind `?munch=dev` in this PR. Flipping `status: 'ready'` is a one-line change, deliberately left for
the release decision after physical iPad testing (Phase 5 also brings `.hbn` so samples can travel with songs).

## 7. Implementation status (this PR)

Implemented as planned above. Deviations and additions:

- **Zoom** uses visible ± buttons beside the display (1× … 32×) plus drag-to-pan when zoomed; there is no pinch.
- **Choke** ("Chops: Overlap / Cut" in TWIST) was added because overlapping one-shot slices smear chopped breaks. It
  defaults to off, so existing patterns play as before.
- **Sequencer paging**: 16 steps per page when every cell can stay at least 38 px wide, otherwise 8 (≈1024 px
  landscape). All pattern lengths (1, 2, 4 bars) are editable.
- The **second pad bank** (slices 9–16) is a slim switch beside the pads; the sequencer shows the same bank.
- Slice notes show `S1 … S16` in the JAM piano roll; the CHOP sequencer shows how many melodic notes the scene has
  and links to JAM.

## 8. Known limitations

- Automated tests run in headless Chromium. Touch feel, iPad Safari audio latency, MediaRecorder/codec support,
  memory pressure and reduced-motion behaviour on iPadOS are **not** verified on a physical device.
- Tape Fit is tape-style only (speed and pitch together); ×0.5 … ×2 is the usable range. No pitch-preserving stretch,
  no BPM detection, no transient detection (out of scope for v0.6).
- MAGIC CHOP classifies slices by position, not by content. A break whose hits do not sit on the grid (unfitted,
  swung or trimmed oddly) gives less convincing roles; Straight then plays it as recorded.
- Keyboard: one key per finger, no glissando by sliding. Velocity comes from where the key is pressed (higher =
  softer), not from force.
- At ≈700 px tall landscape (e.g. 1024×700) the CHOP layer scrolls inside the workspace instead of shrinking touch
  targets; portrait scrolls by design.
- Samples still live only in this browser (IndexedDB). JSON export does not include audio; `.hbn` is Phase 5.
- MUNCH remains behind `?munch=dev`.

## 9. Physical iPad test (11" and 13", Safari, landscape first)

Open `https://<preview-host>/?munch=dev`, tap the start screen.

1. **Entry.** Tap the MUNCH card: SOUND opens with RECORD and IMPORT visible, no scrolling. Tap JAM, then BOP, then
   MUNCH again: JAM stays (your choice is respected). Tap SOUND: MUNCH's workspace is back.
2. **Feed.** Import a short drum break (WAV, MP3, M4A from Files). MUNCH chomps and PLAY opens. Record 3 s with the
   mic; deny the mic once in Settings and check the message.
3. **Fit.** Tap FIT 2 (or the bar count of your loop). The head shows the tape speed; play it with the transport and
   check it loops in time. Change BPM: it re-fits. Tap 4 on a short sound: refused with a message.
4. **Chop.** In CHOP tap the waveform (cursor + you hear it), CHOP HERE, drag a round handle, nudge it with ◀ ▶,
   delete it, Undo/Redo in the header. Zoom in and pan. Check the page never scrolls while editing.
5. **Pads.** Tap all eight pads fast with several fingers: immediate, no clicks, the pad and the sequencer row light up.
6. **Keys.** In PLAY play chords; press low on a key (loud) and high (soft). Switch to Loop, hold keys, release.
7. **MAGIC CHOP.** Tap it: a groove plays at once. Try each style, Again, Undo, Keep. Edit single steps (Draw,
   Accent, Lock); lock a step and regenerate: it stays.
8. **JAM.** Open JAM: the slice notes are there (S1…). Draw a melodic note; back in CHOP the ♪ counter shows it.
9. **Scenes.** Switch scenes from the sequencer letters; make a groove in another scene; play song mode in ARRANGE.
10. **Persist.** Close the tab, reopen with `?munch=dev`: sample, slices, fit and grooves are back. Save a copy.
11. **Regression.** Open without `?munch=dev`: four cards, everything as before.
12. **Comfort.** Turn on Reduce Motion in iPadOS settings: MUNCH changes faces but does not bounce.

## 10. Phase 5 readiness

- **`.hbn` packaging:** ready. Everything MUNCH needs is addressed by content-hash id (`sampleRefsOf`, `getBytes`),
  slice edits and fit are plain params/boundaries in the v6 JSON, and unknown keys survive validation.
- **WAV export:** the offline renderer in `tools/baseline-compare.mjs` already renders MUNCH through the real engine;
  an export needs the bank to decode into an `OfflineAudioContext` (attach a second context) and the fit rate reads the
  project BPM, so it renders identically.
- **Release:** flip MUNCH to `status: 'ready'` only after the physical iPad test above, ideally together with `.hbn`
  so samples can travel with songs.
