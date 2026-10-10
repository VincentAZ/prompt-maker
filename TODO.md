# To do

The backlog, in the order it's worth doing. Point a new Claude session at this file. Each item says why it matters
and what "done" looks like; done items move to the bottom with the version that shipped them.

## Next

1. **Rebuild the release package** whenever a version ships: `packaging/deb/build.sh`, `packaging/deb/check.sh`,
   then attach to the GitHub release (`gh release create vX.Y.Z dist/prompt-maker_X.Y.Z_amd64.deb`). Latest:
   v1.35.0 (2026-10-09).
2. **Windows installer** (on hold: other work first). After the Windows port: the same shape as the .deb (bundled Node, Start menu entry, first
   start sets up the rest). Consider a WebView/Electron wrapper then, so Windows gets an app window too.
3. **App-name change** (on hold) (see the discussion of 2026-10-07): if it happens, do it before the Windows port and before
   more users: repo, package name, data folder, service unit names, the `promptmaker://` link, the README.

## Ideas, not scheduled

- A Linux install USB (Ubuntu autoinstall) with full-disk encryption preselected and Prompt Maker, LM Studio, ComfyUI
  and the NVIDIA driver installed on first boot: the "dedicated box" tier. Only this gives disk encryption.
- Privacy check: scrub the systemd journal for the ComfyUI unit's past entries (new ones no longer go there).
- At "Nothing stays": the browser profile is removed with the session folder while the window may still be open;
  harmless (memory), but the window should close first on ■ Stop.

## Done

- 1.37.2 — Size is back in step ④, next to Shape (1.37.0 had folded it under More options, where your own width ×
  height was hard to find), and it offers real choices: every size in the picked shape from Small (~0.5 MP) through
  Standard, Large, Extra large and Huge to Giant (~4 MP), with HD, Full HD, 2K and 4K by name, instead of one ~1 MP
  size per shape on picture models. A shape change keeps about the same size. ✎ Type your own size… opens its boxes
  on a row of their own, so Shape and Size stay put. The "Automatic size" line and button are gone: the size starts on
  the model's usual one and follows the shape.
- 1.37.1 — Creator UI, second pass: the idea field is in view on a laptop (task chips, tighter steps, the review
  choice on one line); the top bar says Prompts (the page is still Saved prompts); each built-in playbook carries its
  plain description and its task (step ①'s "What do you want to make?"), and the i2i model is Krea 2 RAW Edit, so
  nothing about a model is hard-coded in the page; Hide from Create shortens to Hide on a small tile; the task chips
  and the Models chooser redraw only when they change (no lost focus while ComfyUI is checked); on a narrow screen the
  Create / Results switch no longer scrolls what it opens under itself; stale "Generate" wording in the guide and the
  Gallery's empty text.
- 1.37.0 — Creator UI: Create starts with "What do you want to make?" (five tasks pick the model; Change model, the
  guide and the precise dials are folded); the main button says what it makes (Write prompt, Make 8 images, Run all
  steps) with Review prompt first beside it; Create / Results switch when the form and the work can't sit side by side;
  Ask starts closed; History is Saved prompts with bookmarks (stars stay for artwork); Gallery: Select → two →
  Compare 2, Pin on the left, Filters folded on a phone; Models opens as a chooser (what it makes, what you need,
  ready or not; Customize opens the editor).
- 1.36.1 — The app-menu icon opened nothing for about a minute after 1.35.0: the launcher shredded the old on-disk
  browser profile before opening the window. The window opens at once now, and the shredding runs after it, in the
  background at low priority (one that was cut short goes at the next start).
- 1.36.0 — Step ⑤ names a node ComfyUI lacks, the pack it comes from and why it didn't load (from ComfyUI's log),
  with ↻ Restart ComfyUI and ↻ Check again; a render stops with the same words instead of "Node 'X' not found".
  Every workflow is checked against ComfyUI in the background at start, whenever ComfyUI comes back and every ten
  minutes: ⚠ in the workflow list, the list in Settings → ComfyUI.
- 1.35.0 — Step ③'s Duration is a number box (whole seconds, 1–20), not a menu of the model's few lengths.
  Deleting a card left its picture and theme on Create when the renders strip failed to redraw (1.33.0 to
  1.34.1): Create is cleared first now, whatever else fails. Deletes also reach ComfyUI's folders on disk from before it
  worked in memory, and its leftover uploads of Prompt Maker's go at start. Safer keeps the app window's own files in
  memory too, and says plainly that your work stays until you delete it. The start no longer asks "How private?":
  the level is set in Settings → Privacy check (Safe until changed), and the README says less about privacy.
- 1.34.2 — Wan Animate 2 made about 1 s from a 60 fps phone video: renders now use a 24 fps copy of a fast
  video, and the one-piece Distilled workflow is chained to follow the whole video. Your renders no longer breaks while
  a render runs (a name clash from 1.33.0).
- 1.34.1 — Step ⑤: Renders per take (×1–×4) shows under Auto-render, not only with a chain; auto-render uses it.
- 1.34.0 — History: pick several cards (Ctrl-click, Shift-click or drag a box) and delete them in one go, 8 s to undo.
- 1.33.0 — Your renders and the Gallery: pick several (Ctrl-click, Shift-click or drag a box) and delete them in one
  go, with 8 s to undo them all.
- 1.32.1 — Chains: a video step's duration is a 1–20 s slider.
- 1.32.0 — Chains: a third choice between steps, 🧠 Brain picks. The Brain looks at every render of the step and
  only the best one goes on (16 stills → the best one → 2 videos, instead of 32 on Auto).
- 1.31.6 — Opening took a minute: a test copy's start-up rewrote the start-with-the-computer service to its own
  port and folder, and the launcher waited 60 s for it. Rewrites now keep the service's own port and data folder;
  the launcher stops waiting as soon as the service fails. "How private?" choices were squeezed unreadable (the
  text-box style hit the radio buttons): fixed.
- 1.31.3 — README rewritten, results first: a 22 s film of one man in four scenes, a grid of real renders, the
  same person in every shot, still → video, three-step install; the manual moved to `docs/guide.md` (with its
  screenshots); the in-app assistant reads both; the .deb carries the guide. No prompts shown anywhere.
- 1.31.2 — "Show it again" in Settings → Privacy check brings back the delete warning after "Don't show this again".
- 1.31.1 — clean uninstall: the start-up service and the menu entry do nothing once their copy is gone (no failing at
  every login); a start from another copy moves them there, and Settings → Services says so with Use this copy; the
  package stops Prompt Maker on removal and says what stays; the README says how to remove it.
- 1.31.0 — one-click ComfyUI set-up (Settings → Services, and Create): checks the card, driver and Python, fetches
  ComfyUI, its own Python environment (uv or venv), PyTorch for the card, its packages, starts it; root fixes
  (NVIDIA driver, python3-venv) through pkexec; resumable; the .deb recommends git and python3-venv.
- 1.30.1 — ComfyUI's console output to comfyui.log (memory at "Nothing stays"), not the journal; the launcher opens
  Prompt Maker as its own browser window with its own profile; workflows test fixed.
- 1.30.0 — Ubuntu/Debian package with bundled Node; privacy levels named Safe, Safer, Nothing stays.
- 1.29.0 — "How private?" on first start; Safer and Nothing stays levels; the session in memory.
- 1.28.0 — deletes shred everything (3 passes), .bak copies forget, the line's clip and ComfyUI's copy go, words
  scrubbed from the chat, jobs, LM Studio's server logs and ComfyUI's log; delete warning with "Don't show this
  again"; Undo countdown; Privacy check card; ComfyUI working files in memory; the pitch rewritten for creators.
