# HarbuMatic — Bug & Improvement Tracker

> Last updated: 2026-11-20  
> Current baseline: **v0.5**  
> Proposed stabilization release: **v0.5.1 — Bugfix & UI Polish**

This file tracks reproducible bugs and smaller usability improvements. It complements [ROADMAP.md](ROADMAP.md), which covers larger product capabilities.

## Workflow

**Status:** `Open` → `In Progress` → `Ready for Test` → `Resolved` (or `Won't Fix`).

**Priority:**
- **P1 — High:** Blocks a core workflow.
- **P2 — Medium:** Material usability or component issue with a workaround.
- **P3 — Low:** Cosmetic polish or minor enhancement.

A fix is **not Resolved until it has been verified**. Record device/browser and verification notes when possible. Do not assume the suspected root cause is proven.

## Open issues

### BUG-001 — BOP sequencer becomes unusable after tapping a drum label
- **Type:** Bug
- **Priority:** P1 — High
- **Status:** Open
- **Reported in:** v0.5
- **Observed:** Clicking/tapping the drum names or rows on the left side of BOP's sequencer makes the sequencer stop responding to subsequent editing.
- **Reproduction (reported):** Open JAM → select BOP → tap a drum label on the left side of the sequencer → attempt to edit steps.
- **Expected:** Selecting/auditioning a drum row must not block subsequent step editing.
- **Investigation:** Inspect pointer capture, pointerdown/up/cancel handling, drum-label hit testing, drag state, and any overlay intercepting input. Confirm the actual cause before changing code.
- **Acceptance:** Drum labels can be tapped repeatedly and steps can immediately be added, removed, and edited afterward, on iPad touch and desktop pointer input.

### BUG-002 — Inconsistent button/text alignment
- **Type:** UI polish
- **Priority:** P3 — Low
- **Status:** Open
- **Reported in:** v0.5
- **Observed:** Some buttons and text labels appear misaligned in different areas of the interface.
- **Reproduction:** Visually inspect JAM, SOUND, and ARRANGE at tablet landscape and desktop viewport sizes; capture exact instances.
- **Expected:** Consistent centering, baseline alignment, spacing, and touch-target geometry.
- **Acceptance:** Identified alignment defects are corrected without introducing clipping or layout regressions. Document the affected components/screens.

### BUG-003 — Knob shadow rotates with the dial
- **Type:** Visual component bug
- **Priority:** P2 — Medium
- **Status:** Open
- **Reported in:** v0.5
- **Observed:** The knob's shadow/highlight rotates together with the knob when its value changes, making the physical lighting look incorrect.
- **Reproduction:** Adjust any affected rotary knob and watch its shading.
- **Expected:** The knob's stationary housing, cast shadow, and environmental lighting remain fixed; only the intended indicator/rotating surface changes orientation.
- **Investigation:** Separate fixed housing/shadow from rotating dial indicator or use an equivalent layered rendering approach.
- **Acceptance:** Rotate knobs across their full range; shadows remain visually consistent and pointer interaction still works.

### BUG-004 — ARRANGE navigation header differs from JAM and SOUND
- **Type:** UX consistency bug
- **Priority:** P2 — Medium
- **Status:** Open
- **Reported in:** v0.5
- **Observed:** Switching to ARRANGE changes the top navigation/header composition instead of keeping the same persistent app shell as JAM and SOUND.
- **Reproduction:** Switch between JAM, SOUND, and ARRANGE and compare the top region.
- **Expected:** One consistent app header/navigation across all modes; only mode-specific content should change.
- **Acceptance:** Header height, placement, branding, mode switcher, and global actions stay consistent during mode changes, including on iPad.

### ENH-001 — Expand Scene Library beyond six scenes
- **Type:** Enhancement (not a bug)
- **Priority:** P3 — Low / product review
- **Status:** Open
- **Reported in:** v0.5
- **Observed:** The Scene Library is limited to six scenes.
- **Desired:** Let users add more scenes when needed, without overwhelming the tablet UI.
- **Design questions:** Dynamic scene creation/removal? Practical upper limit? Scene duplication? How to display and navigate larger libraries?
- **Technical considerations:** Review fixed-size assumptions across scene IDs, pattern storage, song chains, rendering, serialization, migrations, and scene switching.
- **Acceptance (provisional):** Users can create, select, rename, duplicate, arrange, and persist additional scenes beyond the original six; existing projects remain compatible.
- **Note:** Scope and version placement require a product decision; do not silently expand this during a bugfix pass.

## v0.5.1 proposed scope

**Fix first:** BUG-001, BUG-003, BUG-004.  
**Polish:** BUG-002 after collecting concrete visual examples.  
**Evaluate separately:** ENH-001; include only after confirming its scope.

## Verification log

| ID | Tested version | Device / browser | Result | Notes |
| --- | --- | --- | --- | --- |
| BUG-001 | — | — | Not tested | |
| BUG-002 | — | — | Not tested | |
| BUG-003 | — | — | Not tested | |
| BUG-004 | — | — | Not tested | |
| ENH-001 | — | — | Not implemented | |

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
