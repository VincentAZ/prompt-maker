# To do

The backlog, in the order it's worth doing. Point a new Claude session at this file. Each item says why it matters
and what "done" looks like; done items move to the bottom with the version that shipped them.

## Next

1. **Rebuild the release package** whenever a version ships: `packaging/deb/build.sh`, `packaging/deb/check.sh`,
   then attach to the GitHub release (`gh release create vX.Y.Z dist/prompt-maker_X.Y.Z_amd64.deb`). Latest:
   v1.31.3 (2026-10-08).
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
