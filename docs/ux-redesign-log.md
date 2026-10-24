# Create workspace redesign log

## 2026-10-18 — Evidence and scope

- Reviewed both supplied screenshots and the 11.6-second screencast. The recording shows repeated scrolling through nested Render → Advanced controls and a long LoRA list inside a narrow column. The full-window screenshot also shows excessive page gutters, a large decorative heading, and an empty results area with little guidance.
- Created branch `redesign/create-workspace` from a clean `main` checkout.
- Keep the scope on Create and the requested Settings disclosure. Preserve generation, model/workflow choices, existing saved preferences, and the optional Assistant.
- Design: compact heading and useful page width; essential task, idea and output controls in the setup panel; wider Fine-tune dialog with Rendering, Look and Writing tabs; a clear results empty state. Detailed controls must not lengthen the setup panel.
- User media is evidence only: no supplied image, video, prompt, seed, file name or personal model name will be copied into shipped screenshots or fixtures.

## Implementation and verification

- Reduced the heading and gutters; widened the default setup panel to 400 px (360 px on smaller desktops). Kept the existing draggable split and saved widths.
- Replaced the large shape tiles plus separate exact-ratio fold with one Shape menu. Put task/model, shape/size and takes/Fine-tune side by side. Moved word-for-word mode into Prompt options and model guidance into Fine-tune.
- Removed folding from essential task, idea and output controls; old stored fold preferences cannot hide them. Optional image inputs retain their automatic reveal behavior.
- Added a native modal for Rendering, Look and Writing, with keyboard tabs, focus return and protection against accidental generation from Enter. Manual prompt mode shows only applicable rendering controls.
- Desktop LoRAs use a single row for toggle, name, slider, exact strength and action. Phone rows stack. Seed, sampler and LoRAs no longer require nested Render/Advanced disclosures.
- Added clearer empty-results guidance and shortened the Assistant welcome. No backend or generation semantics changed.
- Initial visual inspection found output controls still below the fold; tightened the layout until all essential controls fit without scrolling at 1440×900 and 1280×800. Required image/video inputs and expanded optional controls can still scroll.
- Focused browser suite: 5/5 passed (boot, existing creator flow, new layout/keyboard/mobile checks, Settings opt-in synchronization, console errors). Syntax and whitespace checks passed.
- An initial isolated run of the old responsive test had no saved-card fixture; it depends on earlier tests. Used the full suite to exercise those dependencies.
- Version set to 1.64.0 for this UI feature. README, release notes and current guide paths updated.

- Broad testing exposed a reproducible 4 px shift during prompt refinement: the reserved textarea height included the wrapper borders and counted them again. Corrected the reservation to use the inner height and account for borders once. The existing steady-takes regression now passes.
- Updated a setup-screen test that expected the old Render settings wording; its failure had left a modal open and caused subsequent tests to fail. Restarted the full suite with the corrected assertion.
- Kept validation messages and Undo inside Fine-tune while it is modal, and close Fine-tune when navigation leaves Create. Browser tests cover modal feedback.
- Retook all seven existing screenshots and added Fine-tune, using freshly created demo/clean data folders, existing approved sample artwork, blank prompts, seed 0 and synthetic workflow/LoRA names. Visually inspected every image before copying it into the repository.

- Verification uses mocked LM Studio and ComfyUI; no personal services, prompts or GPU render jobs are exercised. The full existing suite also checks workflows remain scrubbed.
- The broad run caught a 2 px outer-page overflow from the compact heading changing height after measurement. Gave the heading a stable minimum height and removed the desktop Create page's stale scroll floor; each panel retains its own scrolling. Updated the fold-position regression to open the optional image panel before folding it. The final focused rerun passed 5/5, including the complete no-jumps check, desktop/phone layout, keyboard access and Settings synchronization.
- Refreshed and visually reviewed the final eight screenshot files after the layout fix. The Fine-tune fixture explicitly uses a fixed seed of 0.
- Updated workflow and chain assertions to open Fine-tune before checking controls that now live there. An early visibility assertion left auto-render enabled and caused downstream chain-test failures; the corrected workflow rerun passed 7/7, and the chain sequence passed in the subsequent run.
- Visual review at phone width caught an open Fine-tune dialog disappearing with its parent form when a desktop Results session became narrow. Opening Fine-tune now selects the setup workspace, keeping the dialog visible on resize; the new browser test asserts visibility, not just width.
- Corrected the test helper to navigate to a panel's page before opening its dialog. The previous helper could programmatically open Fine-tune inside a hidden page and recurse while trying to close it. Restarted the complete suite with this corrected navigation.
- Final focused workflow/chain/LoRA sequence: 14/14 passed, including workflow CRUD, sampler edits, still-to-video, continuation choices, saved chains, LoRA strength/toggle/add/remove and newer-version replacement.
- Visually checked the final 390 px Fine-tune test capture: the dialog stays on screen after resize, its content scrolls, feedback remains inside it, and Done stays reachable. This test capture remains temporary; only the scrubbed demo screenshots ship.

## Final result

- Complete browser suite: **161/161 passed**, using `node tests/ui.test.mjs` with clean fixtures and mocked services. This includes desktop and phone navigation, all palettes, generation, rendering and recovery, workflow/LoRA editing, chains, batches, assistant tools, speech, storage and the shipped-workflow checks. No browser console errors.
- Unit suite: **4/4 passed** with `node --test tests/updates.test.mjs`. JavaScript syntax checks and `git diff --check` passed.
- Completed on `redesign/create-workspace`, version **1.64.0**. Updated README, guide, release notes and all seven existing README screenshots; added the Fine-tune screenshot.
- Scope stayed on the demonstrated Create workflow and the Settings disclosure, plus the layout/focus/feedback fixes needed to make the redesign work. Real LM Studio/ComfyUI hardware performance was not tested; the UI integration tests use mocks.
- Unrelated video-duration work appeared concurrently during final staging. Preserved those working-tree edits and excluded their hunks from this redesign commit.
