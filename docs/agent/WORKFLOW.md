# Antigravity Workflow — HarbuMatic

## Execution Modes
- **Small** (UI/CSS tweak, targeted bugfix, docs): Execute directly in one pass. Keep the final report brief.
- **Medium** (feature in one subsystem, focused UI/MUNCH/sequencer flow): Execute directly or delegate at most 1 focused subagent with explicit file ownership.
- **Large** (serialization/format work like `.hbn`, audio/transport changes, cross-module work): Break into small verifiable steps; scale planning depth to risk. Use at most 2 parallel subagents only when file ownership and interfaces do not overlap.

## Standard Loop
1. **Scope:** Confirm goal, target files/subsystem, constraints, and acceptance criteria.
2. **Inspect:** Read only the relevant files and tests.
3. **Change:** Apply minimal, scoped edits following `AGENTS.md`.
4. **Verify:** Run `npm test` and relevant `npm run test:ui` checks (start `npm run dev` / local HTTP server when UI tests require it). Check musical/transport behavior for audio/sequencer changes and tablet layout/touch behavior for UI changes.
5. **Report:** Summarize changes, test status (`PASS` / `FAIL` / `NOT RUN`), risks, and physical iPad checks.

## Interrupts & `docs/agent/HANDOFF.md`
If interrupted mid-task, update `docs/agent/HANDOFF.md` with only current status, task, branch/commit, key decisions, touched files, completed steps, test status, exact next step, and blockers. Do not paste logs or full files. Clear or reset it once complete.

## Stop Conditions
Pause and ask if requirements conflict, user data or backward compatibility is at risk, a major architectural change is needed, or a regression cannot be resolved safely within scope.
