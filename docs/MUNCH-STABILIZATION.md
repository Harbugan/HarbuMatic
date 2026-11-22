# MUNCH v0.6 stabilization — record of causes, decisions and tests

> Starting point: `main` at the merge of PR #11 (Phase 4 merged in PR #10). Goal: make MUNCH reliable on a physical
> iPad: Import → Record → Play → Chop → Sequence → Fit to Tempo → Stop → Play again. MUNCH stays a dev preview
> (`?munch=dev`) and the version stays **0.5.1** until the owner's iPad test and release decision.
> Bug entries: `BUGS.md` MUNCH-1 … MUNCH-4.

## 1. Microphone (MUNCH-1)

**Symptom.** On a physical iPad (Safari, Chrome, Firefox) RECORD immediately said *The microphone could not be
started*, with no permission prompt.

**Cause (identified in code; strongly supported, not yet confirmed on a device).** `engine.init()` sets
`navigator.audioSession.type = 'playback'` so HarbuMatic plays with the silent switch on (iPadOS 17+). Under the Audio
Session API, WebKit refuses capture while the type is `playback`: `getUserMedia` rejects with `InvalidStateError`
before any prompt. Every iPad browser is WebKit, so all three failed the same way. Desktop Chromium has no
`navigator.audioSession`, which is why every automated test passed. The generic message came from the catch-all branch
of the error mapping, which did not list `InvalidStateError`.

**Fix** (`src/audio/session.js`, `src/samples/recorder.js`):
- RECORD switches the session to `play-and-record` synchronously inside the tap, then calls `getUserMedia`. When
  recording ends, fails, is cancelled or interrupted, the previous type (`playback`) is restored, and the AudioContext
  is resumed if the switch suspended it.
- Constraints fall back from raw audio (no echo cancellation, noise suppression or AGC: best for a sampler) to
  `{ audio: true }`. Permission refusals are never retried, so nobody gets prompted twice.
- Clear messages per error name (blocked permission with where to change it, insecure page, no microphone, microphone
  busy, audio mode), each ending with the browser's error name in brackets. `recorder.diagnostics()` keeps the
  attempts, session types and chosen format; failures are also logged to the console.
- MP4/AAC is preferred on WebKit (it may claim WebM support it cannot always decode); WebM/Opus elsewhere.
- No MediaRecorder timeslice (one complete file; fragmented MP4 chunks trip some decoders); the last Safari data chunk
  that arrives after `stop` is still collected.
- Hitting the 30 s limit, or the system taking the microphone (a call, Siri, another app), now **keeps** the recording
  (before, the 30 s limit silently discarded it).

## 2. Import and storage (MUNCH-2)

**Symptom.** *The sample could not be stored* on iPad in normal sessions, while private mode and desktop worked.

**What is known.** The message came from the generic wrapper around IndexedDB reads/writes, i.e. after the database
had opened. The schema never changed in the repository's history, so a schema mismatch from an older build is
unlikely. The likely mechanisms are those known for Safari: a long-lived connection that dies when the storage
process is restarted (backgrounded tabs; *Connection to Indexed Database server lost*), or a database in a damaged
state. Fresh private sessions avoid both. **The root cause is not confirmed** — no device logs were available, and
the old code did not keep the browser's error name.

**Fix** (`src/samples/store.js`, `src/samples/bank.js`, `src/app/actions.js`, `src/views/munch.js`):
- **Reconnect and retry:** a transaction failing with a connection-type error drops the connection, reopens and
  retries once (writes are idempotent: content-addressed ids). `onclose` also drops a dead connection.
- **Non-destructive schema repair:** database version 2 only adds missing object stores; a database without its
  stores is upgraded, never wiped. A newer version on disk still opens. `open()` times out instead of hanging.
- **Decode and storage are separate errors.** A file the browser cannot decode is refused (*not an audio format this
  browser can read*). A sample that decodes but cannot be written **still plays** in this session: it is pinned in
  memory, the head shows *Plays now · NOT saved on this device*, and the toast names the browser error.
- **Not saved → Try again / Repair.** *Try again* rewrites the pending samples. *Repair storage…* asks for
  confirmation, rescues every sample it can still read, deletes **only** `harbumatic-samples` and writes everything
  back. Songs (localStorage) and other sites are untouched. Nothing is ever cleared silently.
- After the first successful save the app asks for persistent storage (`navigator.storage.persist()`, best effort).

## 3. Retrigger, choke and transport (MUNCH-3)

**Confirmed causes.**
1. One-shot voices never cut each other: re-tapping a pad or key, or retriggering a long sample from the sequencer,
   piled up copies (choke was off by default and only applied between different slices).
2. `engine.closeGates()` returned early when no play session was open, so **Stop while stopped did nothing**:
   auditions (*hear the whole sound*), held keys and long one-shots kept playing.
3. Cuts used `cancelScheduledValues`, which drops an in-progress ramp and jumps back to the previous value: a cut
   during attack or release could click.
4. Pads always played a fixed 0.4 s audition, so Gate and Loop ignored pad release.

**Semantics now** (`src/audio/voices.js`, `src/audio/engine.js`):

| Mode | Behaviour |
|---|---|
| One-shot | Plays the whole region. Release is ignored. |
| Gate | Stops at the note end or key/pad release (with the release time), or at the region end, whichever is first. |
| Loop | Loops the region while the note, key or pad is held, then releases. |
| Retrigger (always) | Each voice has a key: slice *k*, pitch *p* or the editor audition. A new hit with the same key cuts the previous one at the new hit's time. Different keys stay polyphonic (chords). |
| Choke (param, now **on** by default) | A slice hit also cuts every other slice still sounding (one chop at a time). Songs that stored `choke: false` keep Overlap. |
| Stop / Pause | Close the session gates and fade every MUNCH voice, also when the transport was already stopped. |

Every cut holds the envelope at its current value and ramps to 0 over 6 ms. The pool stays bounded (8 voices, oldest
stolen), and every source ends at a known time and is disconnected. A voice scheduled later is never cut by an
earlier hit.

## 4. Fit to Beat: Stretch and Tape (MUNCH-4)

**Product decision implemented:** `fitMode: 'stretch' | 'tape'`, default **Stretch**.

| | Stretch (default) | Tape |
|---|---|---|
| BPM change | Length changes, **pitch stays** | Speed changes length and pitch together |
| Playback rate of a note | transpose + tune only | transpose + tune × fit ratio |
| Buffer | time-stretched copy | original |

The timing maths is shared: `ratio = trimmed seconds / (bars × 4 × 60 / bpm) × (1 + fitFine)`, clamped to ×0.5…×2,
computed at trigger time. Nothing is applied twice: in Stretch the fit lives in the buffer, in Tape in the playback
rate (`fitPlayback()` in `src/core/samples.js` returns exactly one of the two).

**Approach chosen: WSOLA, anchored at slice boundaries** (`src/samples/stretch.js`, pure JS, no dependency).

| Candidate | Why (not) |
|---|---|
| Granular in an AudioWorklet | Real-time and flexible, but sample-accurate start/stop and per-voice state through a worklet is a large rewrite of the voice and scheduler. |
| Phase vocoder | Good for tonal material, but smears drum transients (the main use: breaks) and costs more. |
| **WSOLA, pre-rendered** | Time-domain, cheap, good on rhythmic and vocal material. Playback stays an AudioBufferSourceNode, so scheduling, envelopes, loop points, choke and reverse are unchanged. Chosen. |
| Library (e.g. Rubber Band WASM, SoundTouch) | Larger bundle, licensing and WASM loading for a single feature. Not needed for this quality target. |

Details:
- ~32 ms Hann frames, ~50 % overlap, ±8 ms normalised cross-correlation search on the mono mix (coarse, then fine).
  The same positions are used for every channel, so the stereo image is kept.
- **Anchors = slice boundaries.** Every segment is stretched on its own and lands exactly at its scaled position. Its
  first frame copies the slice's attack sample for sample, it never reads past its end (no pre-echo of the next hit),
  and its last 5 ms blend into the original audio that leads into the next anchor, so segments join without a step.
- **Off the audio path:** renders run in a module Worker (`stretch-runner.js` / `stretch-worker.js`), falling back to
  ≈6 ms main-thread time slices. Measured in Node: 2 s mono ≈ 15–30 ms; the 30 s stereo worst case ≈ 0.4–0.5 s.
- **Cache:** at most two copies per sample, on a 0.001 factor grid, counted in the bank's memory budget and evicted
  with the sample.
- **Never blocks playback:** the voice plays the closest copy at a tiny residual rate that makes the duration exact
  (for example 120→126 BPM before the new render: ≈ 0.8 semitones for a few hundred ms). With no copy at all, it plays
  the original with tape timing. Timing is always exact; the pitch is exact once the copy is ready, which is usually
  before the next bar.

## 5. Chopping UX (P2)

- Selecting a slice (pad, sequencer row, waveform tap) selects its **start marker**: Earlier / Later / Delete are
  ready at once. Tapping a handle selects that marker and the slice that starts there.
- A slice info row (*SLICE n · length · start–end*) with Undo/Redo sits under the pads where the screen is tall enough.
  On short screens Undo/Redo stay in the header.
- *Equal…* offers 4, 8 or 16 equal slices. Grooves are remapped as before, and Undo restores the markers.
- Pads play like keys: velocity comes from where you press, and Gate/Loop respect release.
- Fit control: one large **STRETCH / TAPE** toggle (*pitch kept* / *pitch moves*). The head shows `stretch ×1.20 ·
  pitch kept` or `tape ×0.83 (−3.2 st)`, and *stretching…* while a render is pending.

## 6. Known limitations

- **No fix is verified on a physical iPad yet.** iPad behaviour was emulated in Chromium (Audio Session refusal
  under `playback`, IndexedDB failure injection). WebKit itself was not available in this environment.
- MUNCH-2's root cause is unconfirmed. If storage still fails on the device, the toast and the *Not saved* dialog
  now show the browser's error name and phase. Please report that text.
- Stretch quality: very large ratios (towards ×0.5 / ×2) add WSOLA's typical phasiness on sustained, harmonically
  rich material. On pure sustained tones, the 5 ms join before each slice marker can dip about 3 dB. Fast drum rolls
  inside one slice are stretched like any other audio (only slice starts are protected).
- Changing BPM in Stretch re-renders (debounced 60 ms). Until the copy is ready, the previous copy plays with a small
  residual pitch. Timing is never affected.
- Recording format and decoding on iPad (MP4/AAC) were tested only through emulation.
- Choke now defaults to on for new sounds and for songs that never stored it (Phase 4 songs saved `choke: false`
  explicitly and keep Overlap).

## 7. Physical iPad acceptance checklist

Open the PR preview with `?munch=dev` in **Safari** (iPadOS 17+, landscape), tap the start screen and select MUNCH.
Then repeat the starred (★) steps in **Chrome for iPad**.

1. ★ **Import:** IMPORT a WAV/MP3/M4A from Files. MUNCH chomps and PLAY opens. There must be no *Not saved* button.
2. ★ **Play:** play keys and tap ▶ in the head.
3. ★ **Reload:** close the tab and reopen it. The sample is ready (no *missing* message).
4. ★ **Record:** tap RECORD. The permission prompt appears the first time, then *Listening…*. Make noise and tap
   STOP & KEEP. ★ Expected: a recording plays and can be chopped. If an error appears, note the text in [brackets].
5. **Record again**, then **Cancel** one recording. The microphone indicator in the status bar goes off each time.
6. **Interruption:** start a recording and trigger Siri or a call. The recording so far is kept. Playback still works
   afterwards.
7. **Chop:** CHOP → tap the waveform, CHOP HERE, drag a round handle, tap pad 3, then use ◀ ▶ (moves slice 3's start)
   and Delete. Use Undo/Redo, and *Equal… → 16*.
8. **Pads:** tap pads fast and repeatedly. The same pad cuts itself (no pile-up). With TWIST › Chops *Cut* (default),
   one slice plays at a time; *Overlap* lets slices ring. Set Mode to Gate: holding a pad sounds, release stops.
9. **Sequence:** draw steps or use MAGIC CHOP, then press Play.
10. **Stretch:** with a loop, tap FIT 1 or 2 (STRETCH is shown). Change BPM by ±10. ★ The pitch stays and the loop
    stays in time.
11. **Tape:** tap STRETCH → TAPE and change BPM. ★ The pitch follows the speed.
12. **Stop:** tap ▶ *hear the whole sound*, then Stop. ★ It stops immediately. Hold a Loop key and press Stop: silence.
    Play/Stop ten times: no leftover sound.
13. **Scenes:** switch scenes from the sequencer letters while playing, and play song mode in ARRANGE.
14. **Storage repair (only if *Not saved* appears):** open it, read the browser error, try *Try again*, then *Repair
    storage…*.
15. **Regression:** BOP, GOO, BLIP and FUZZ play and edit as before. Without `?munch=dev`, four cards are shown.

Document anything unsupported (for example a browser without MediaRecorder) in `BUGS.md` with device, iPadOS and
browser versions.
