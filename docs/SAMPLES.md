# MUNCH sample engine (v0.6 Phase 3)

MUNCH is HarbuMatic's fifth instrument: a sampler that plays one sample melodically (keyboard) or as slices (pads).
Phase 3 adds the working engine and a temporary test bench. The final PLAY / CHOP / TWIST interface is Phase 4.

> **Preview only.** MUNCH is registered with `status: 'preview'`. It is playable only when the app is opened with
> **`?munch=dev`** (e.g. `https://…/harbumatic/?munch=dev`). Without the flag MUNCH behaves exactly as in Phase 2:
> it is kept in every song, but it is not scheduled, has no card, does not affect solo or scene length, and the sample
> database is never opened. Production users therefore see and hear no change.

## Layers

```
src/core/samples.js      pure: sample references, slice boundaries, regions, pitch → playback rate
src/samples/hash.js      content id: 'smp-' + SHA-256 of the original bytes (Web Crypto, or the same hash in plain JS)
src/samples/store.js     durable assets in IndexedDB: original bytes + metadata; import checks and errors
src/samples/bank.js      decoded AudioBuffers in memory (bounded LRU), reversed copies, load states
src/samples/recorder.js  microphone recording (MediaRecorder) → the normal import
src/audio/voices.js      createMunchVoice: AudioBufferSourceNode playback through MUNCH's mixer channel
src/views/munch-dev.js   temporary test bench in the SOUND view (dev preview only)
```

The scheduler knows nothing about samples. It dispatches MUNCH notes like any other notes and only passes a note's
`slice` field on. Decoding, file I/O and IndexedDB stay in `src/samples/`.

## Project data (schema v6, additive)

```js
slot.sample = null | {
  id: 'smp-<64 hex>',          // SHA-256 of the original file bytes
  name: 'break.wav',           // shown in warnings when the asset is missing on this device
  duration: 2.0, sampleRate: 44100, channels: 2,   // metadata, usable before decoding
  slices: [0, .125, .25, .375, .5, .625, .75, .875, 1],  // boundaries, see below
}
slot.params (MUNCH): { root: 60, tune: 0, start: 0, end: 1, reverse: false, mode: 'oneshot' | 'gate' | 'loop',
                       attack: .002, release: .08, vol, pan, drive, driveOn, delayOn, reverbOn, delay, reverb }
```

- Only sampler slots (registry capability `samples`) have a `sample` key. Other instruments are unchanged.
- **Slices** are strictly increasing boundaries in [0, 1] of the whole, untrimmed sample. Slice *k* plays from
  `slices[k]` to `slices[k+1]`, so slices are contiguous and can never overlap. The default is nine boundaries,
  which give eight equal slices. Validation sorts, clamps and de-duplicates the boundaries, keeps every slice at
  least `MIN_SLICE` (0.1 % of the sample) long and caps them at 16 slices. When the boundaries cannot form one
  slice it falls back to eight. `moveSliceBoundary()` moves one boundary without crossing its neighbours. A future
  transient detector only has to produce a boundary list.
- **Trim** (`start`, `end`) applies to melodic notes only. Slices are positions in the whole sample.
- Everything is **non-destructive**: the stored asset is never changed. Reverse plays a reversed copy that lives in
  memory only.
- Params are clamped by `paramRanges`/`paramChoices` in the registry. Only MUNCH has them, so the other instruments
  keep the v0.5 validation.

### Pattern events

MUNCH reuses the notes pattern. A note may carry an explicit slice:

| Event | Plays | Transposition |
|---|---|---|
| `{ s, p, l, v }` | the trimmed sample | `p − params.root + params.tune` semitones |
| `{ s, p, l, v, slice: k }` | slice *k* | `p − 60 + params.tune` semitones (p = 60 plays the slice as recorded) |

- The slice's identity is always `slice`, never the pitch. Changing `p` transposes a slice note but never changes
  which slice plays.
- `slice` is kept only on notes of sampler slots and only as an integer 0–15. Any other value turns the note back
  into a melodic note, never into a different slice. A slice index the current sample does not have plays nothing.
- Length, velocity, chance, offset and lock work as for any note. Tempo, swing, scenes, arrangement, mute/solo and
  Pause/Stop come from the existing transport, so there is no second timing system.
- Snapshots and undo/redo store whole patterns and projects, so they include slice notes and the sample reference.

## Storage design

IndexedDB database `harbumatic-samples`, version 1:

| Store | Key | Value |
|---|---|---|
| `meta` | `id` | `{ id, name, type, size, duration, sampleRate, channels, frames, created }` |
| `bytes` | `id` | `{ id, data: ArrayBuffer }` (the original file, unchanged) |

- **Content-addressed ids.** The same file always gets the same id. Importing it twice stores it once, and a song
  whose sample is missing on this device gets it back by importing the same file again. Duplicated songs
  (Save a copy) share the asset.
- **Atomic writes.** Bytes and metadata are written in one transaction. A full disk gives
  `SampleError('quota')` and leaves nothing half-stored.
- **Nothing is deleted automatically.** `store.remove(id, { referenced })` is explicit and refuses ids that are
  still referenced. No UI calls it yet.
- **Import checks**, each with its own clear message: empty file, more than 32 MB, not decodable by this browser
  (`unsupported`), longer than 30 s, storage full, storage unavailable (e.g. blocked site data), and audio not
  started yet. The original bytes are always what is stored. Decoding is only used to validate the file and to read
  its metadata.
- **No localStorage.** The song library (localStorage) holds only the reference.

### Decoded buffers (bank)

- `bank.load(id)` reads the bytes and decodes them once with the playback AudioContext. Concurrent loads share
  one decode. Loads requested before audio starts wait until the engine attaches its context.
- States: `idle → loading → ready | missing | error` (with a message). Listeners update the UI.
- `bank.buffer(id, reverse)` is synchronous and never decodes, so it is safe in scheduler time. It returns `null`
  until the sample is ready, and the voice stays silent and counts a miss.
- **Memory bound:** decoded audio counts as `frames × channels × 4` bytes against a 96 MB budget. The least recently
  used unpinned sample is evicted first and reloads on demand. The current song's samples are pinned.
- Reversed copies are built once, when `reverse` is switched on (`voice.apply`), not when a note plays.
- Before Play the transport waits up to 2 s for a sample that is still loading.

### Missing or damaged samples

- The reference always stays in the song: validation never drops a valid `slot.sample`.
- When a song opens and its sample is missing, a toast says so once per sample and names the file. The test bench
  shows the state. Notes play silently, and nothing crashes or is replaced.
- Importing the same file again restores the sample, because the id is the content hash.

## Voice (createMunchVoice)

- One `AudioBufferSourceNode` and one gain envelope per hit, into MUNCH's own mixer channel (volume, pan, drive,
  delay and reverb sends, transport gate).
- Pitch is playback rate (`2^(st/12)`), so transposing changes length. There is no time-stretch in v0.6.
- Modes:
  - `oneshot` plays the whole region.
  - `gate` stops at note end + release, or at the region end, whichever comes first.
  - `loop` loops the region (`loopStart`/`loopEnd`) while the note is held, then releases.
- The envelope reaches 0 exactly at the region end and the source stops there, so a slice never runs into the next.
- Polyphony is bounded at 8 voices (`MUNCH_POLY`): the oldest voice is stolen with a 4 ms fade.
- Every source has a stop time. `onended` disconnects it and removes it from the pool. `silence()` (called on Pause,
  Stop and project switch) and `dispose()` stop every voice at once.

## Recording

`createRecorder()` uses `getUserMedia` and `MediaRecorder` in the browser's own format (WebM/Opus in Chromium,
MP4/AAC in Safari). The recording goes through the normal import, so it is hashed, stored and decoded like a file.
- Recording stops by itself at 30 s.
- Permission denial, a missing microphone and missing API support each give their own message.
- The microphone tracks are always stopped when recording ends, is cancelled or fails.
- Recording is cancelled when the page is hidden (backgrounded iPad).
- Starting a recording pauses the transport, so HarbuMatic itself is not recorded.

## Portability and the future `.hbn` package

**A JSON export with a MUNCH sample is not a portable project.** It holds only the reference, and the audio stays in
this browser's IndexedDB. Export says so in its message. Opening the file on another device shows the
missing-sample warning until the same file is imported there.

Planned `.hbn` (Phase 5), a ZIP container:

```
project.json            the v6 project (unchanged shape; references by id)
samples/<id>.<ext>      original bytes of every referenced sample (id = SHA-256, ext from the stored MIME type)
manifest.json           { format: 'harbumatic-package', v: 1, app: <version>, samples: [{ id, name, type, size, sha256 }] }
```

- **Packing:** collect `sampleRefsOf(project)`, then `store.getBytes(id)` for each.
- **Unpacking:** for each sample, re-hash the bytes, refuse any that do not match their id, and `importBytes` the
  rest. Assets already stored are deduplicated automatically. Then import `project.json` as today.
- Because ids are content hashes, a package can never point at the wrong audio, and unpacking twice stores
  nothing twice.

## Limits and performance

| Limit | Value | Why |
|---|---|---|
| File size | 32 MB | the original is kept |
| Length | 30 s | 30 s × 48 kHz × 2 ch × 4 B ≈ 11.5 MB decoded, ≈ 23 MB with the reversed copy |
| Decoded cache | 96 MB | eviction of unused samples |
| Voices | 8 | AudioBufferSourceNodes are cheap, but bounded pools keep iPad CPU predictable |

Measured in headless desktop Chromium (`?munch=dev`, WAV stereo 48 kHz, decoded at the context rate of 44.1 kHz):

| Sample | File | Import (hash + decode + store) | Reversed copy | Decoded (forward + reversed) |
|---|---|---|---|---|
| 1 s | 0.2 MB | 21 ms | 2 ms | 0.7 MB |
| 10 s | 1.8 MB | 44 ms | 3 ms | 7 MB |
| 30 s | 5.5 MB | 127 ms | 30 ms | 21 MB |

Neither import nor reversing touches scheduler time. Expect an iPad to be several times slower, so the 30 s limit
and the 96 MB budget are first estimates. They must be confirmed on an 11" and a 13" iPad (see below) before release.

## Automated tests and their limits

- `tests/munch-core.test.mjs` covers slices, regions, pitch → rate, references, schema, validation, legacy songs
  and duplication.
- `tests/samples-store.test.mjs` covers ids, import of several WAV formats and lengths, duplicates, refusals,
  quota, missing and damaged assets, deletion rules, bank states, eviction, reversed copies and waiting for the
  context. It uses an in-memory backend and a WAV decoder.
- `tests/munch-audio.test.mjs` runs the voice on a fake Web Audio graph. It covers rates, offsets, stop times,
  envelopes, modes, polyphony, cleanup, Pause/Stop, missing samples, audition, channel routing and transport
  dispatch (tempo, swing, scenes, song mode, mute/solo). It also checks that the four instruments dispatch
  identically with MUNCH on.
- `npm run test:ui` runs in real Chromium, with real IndexedDB, real `decodeAudioData` and a fake microphone. It
  covers WAV, MP3 and Ogg/Opus import, a broken file, de-duplication, pads, slice steps, transport playback, Pause,
  params, the reversed copy, recording, cancelling, permission denial, reload, Save a copy, the export warning, a
  missing asset, and layout at four sizes.
- `npm run test:baseline` renders MUNCH offline (current build). It checks that the demo with the MUNCH preview
  enabled sounds identical to `main`.

What automation cannot show: how the pitch and timing sound, Safari's codec support (AAC/M4A is not available in
Playwright's Chromium), iPad memory pressure, MediaRecorder on iOS, IndexedDB eviction on iOS, and touch feel.
**Physical iPad Safari testing is a release gate.**

## iPad Safari test plan (11" and 13", landscape)

Open `https://<host>/?munch=dev`, tap the start screen, select MUNCH (fifth card) and open SOUND.

1. **Import.** Import a WAV, an MP3 and an M4A from Files. Each one shows *Ready* with the right length. Try a 40 s
   file (refused, too long) and a non-audio file (refused).
2. **Record.** Tap Record and allow the microphone. Speak for 3 s, then tap Stop & keep: the sample is ready.
   Record again and tap Cancel: the previous sample stays. Deny the permission in Settings and check that the
   message is clear. Lock the screen while recording: the recording stops and the mic indicator goes off.
3. **Melodic.** In JAM draw notes across two octaves around C4. Pitch must follow the keys, with root C4 = original
   pitch. Change Root and Tune in SOUND.
4. **Slices.** Tap pads 1–8: each plays only its own part, with no click and no bleed into the next. Fill the slice
   step grid and press Play. Timing must be tight and follow tempo and swing.
5. **Edit.** Set Start and End, Reverse, Gate and Loop with a long note. Listen for clicks at loop points and note
   ends.
6. **Transport.** Pause mid-note (silence), Resume, Stop. Switch scenes while playing. Song mode with a block that
   uses MUNCH.
7. **Persistence.** Close the tab and reopen with `?munch=dev`: the sample is ready. Use Save a copy, then Export:
   check the "not portable" message.
8. **Memory.** Load a 30 s stereo sample, turn on Reverse and play for 10 minutes with Auto-evolve on BLIP. Watch
   for audio drop-outs and page reloads.
9. **Backgrounding.** Switch apps while playing and come back: Resume works.
10. **Regression.** Open without `?munch=dev`: four cards, and the demo sounds as before.

## Phase 4 integration notes

- Flip the registry status to `ready` (and drop the flag) only when the PLAY/CHOP/TWIST UI ships.
- PLAY can use `engine.audition(slot, pitch)` for the keyboard and `importSampleFile` / `recordStart` for capture.
- CHOP: pads use `auditionSlice(k)` and the pattern uses `{ slice: k }` notes. MAGIC CHOP writes slice notes and
  may add boundaries with `moveSliceBoundary` or a new boundary list.
- TWIST: waveform drawing needs peak data from the decoded buffer. Compute it once in the bank, not per frame.
  Trim, reverse, mode and envelope are already params.
- The piano roll shows slice notes at their pitch row. A pad-grid view of slice notes (rows = slices) belongs to CHOP.
- Sound shapers (macros) and Generate are disabled for MUNCH. Decide its `MACRO_MAP` and whether Generate should
  write slice patterns.
