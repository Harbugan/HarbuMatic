# HarbuMatic — Agent Instructions

## Identity
HarbuMatic is a playful, iPad-first groovebox with the personality of a musical toy.
Play first. Tweak forever.
It is built with native ES modules (no build step, no external runtime dependencies) and runs in the browser over HTTP.
Keep the instrument feel and tactile iPad usability central; avoid turning it into a conventional DAW.

## Source of Truth
1. Repository source code (`src/`, `styles/`, `index.html`, `sw.js`, `manifest.json`)
2. Current task contract
3. `BUGS.md` and `ROADMAP.md`
4. `docs/ARCHITECTURE.md`, `docs/TESTING.md`, `CHANGELOG.md`

If sources conflict, flag the conflict rather than guessing. Never treat planned roadmap items as implemented.

## Context & Token Discipline
- Inspect `git status` and `git branch` once at task start.
- Use targeted symbol/file search before opening full files.
- Never dump the whole repository or preload every doc/test file.
- Do not re-read unchanged files without a clear reason.
- Keep notes concise and verify file paths against the live workspace before editing.

## Musical, Audio & iPad Guardrails
- Protect audio timing, Web Audio engine/voices, transport, and scheduler behavior.
- Keep `src/music/` pure (no DOM dependencies) and keep scheduling decoupled from sample loading/decoding.
- Route state mutations through `src/app/` actions and store; avoid parallel playback or state systems.
- Preserve current-version project integrity and save/reopen behavior (historical project-format compatibility is not required from v0.6.1), instrument definitions (`src/core/instruments.js`), version constants (`src/core/constants.js`), and the creator credit `Created by .::H∆RBUGΛП::.`.
- Prioritize iPad touch ergonomics and offline/PWA (`sw.js`, `manifest.json`) behavior.

## Experimental Project-Data Policy (v0.6.1 onward)
- Develop and test version by version. Old `.hbn`/JSON projects and browser-stored test projects from earlier versions do not need migration or backward compatibility.
- Do not add or maintain historical migration layers, fixtures or compatibility tests unless the task explicitly requires them. Do not remove legacy code solely for cleanup without task scope.
- A new version may intentionally invalidate/reset test projects. Disclose destructive implications and ask before deleting or resetting any stored data; never silently clear browser storage.
- Preserve all existing working musical features, audio timing, transport, UI behavior, current-version `.hbn` export/import and project save/reopen. Historical data compatibility is waived, not regression quality.
- Keep Git history for recovery. Follow explicit task contracts for any schema change.

## Implementation & Delegation
- Make the smallest clean, complete change that satisfies the task contract.
- Do not refactor unrelated code, add dependencies, bump versions, or touch unrelated files unless explicitly authorized.
- Work directly on small or tightly coupled tasks. Only delegate to subagents when work is substantial, separable into non-overlapping file ownership, and clearly benefits from parallelism (max 2 concurrent implementation subagents).
- Do not regenerate baseline snapshots merely to make tests pass.

## Verification & Reporting
- Run focused checks while iterating; before finishing, run the relevant test suite (`npm test`, `npm run test:ui` with a running local server such as `npm run dev`, or baseline checks if applicable). Report any test that could not run as `NOT RUN`, never `PASS`.
- Keep final responses concise: list files changed, test results, remaining risks/iPad checks needed, and commit/PR status if applicable.

## Escalation
Stop and ask before changing established musical/transport behavior, introducing dependencies or major architectural shifts, deleting/resetting user data, or expanding task scope. Schema changes are permitted within an explicitly scoped task under the experimental project-data policy; flag destructive consequences first.
