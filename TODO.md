# To do

The backlog, in the order it's worth doing. Point a new Claude session at this file. Each item says why it matters
and what "done" looks like; done items move to the bottom with the version that shipped them.

## Next

1. **One-click ComfyUI set-up.** The .deb makes ComfyUI the next wall a new person hits: today it's a git clone, a
   Python environment, torch, and the first model files, all by hand. Done: a "Set up ComfyUI" button (Settings →
   Services, and the Create page's "ComfyUI not found" state) that fetches ComfyUI into the data folder (or a chosen
   folder), makes its Python environment with the right torch for the GPU, offers the NVIDIA driver through the
   system's package tool when it's missing, and shows progress in plain words. The voice set-up (lib/voice.js) already
   installs packages beside ComfyUI's Python: same approach. Verify with a real render.
2. **Clean uninstall.** After `apt remove prompt-maker`, the user's background service points at a folder that is
   gone. Done: the app notices (Settings → Services) and offers the fix; `prompt-maker --uninstall` documented; the
   package's prerm leaves a note.
3. **Rebuild the release package** whenever a version ships: `packaging/deb/build.sh`, `packaging/deb/check.sh`,
   then attach to the GitHub release (`gh release create vX.Y.Z dist/prompt-maker_X.Y.Z_amd64.deb`). The v1.30.0
   release still carries the 1.30.0 package; main is ahead.
4. **README brainstorm (own session, `readme` worktree).** The opener is fixed; the rest of the README still reads
   like a manual. Results first: real renders in the first screen, fewer settings screenshots. Bring real renders.
5. **"Ask again" for the delete warning.** "Don't show this again" is per browser with no way back except clearing
   site data. Done: a small link in Settings → Privacy check that brings the warning back.
6. **Windows installer.** After the Windows port: the same shape as the .deb (bundled Node, Start menu entry, first
   start sets up the rest). Consider a WebView/Electron wrapper then, so Windows gets an app window too.
7. **App-name change** (see the discussion of 2026-10-07): if it happens, do it before the Windows port and before
   more users: repo, package name, data folder, service unit names, the `promptmaker://` link, the README.

## Ideas, not scheduled

- A Linux install USB (Ubuntu autoinstall) with full-disk encryption preselected and Prompt Maker, LM Studio, ComfyUI
  and the NVIDIA driver installed on first boot: the "dedicated box" tier. Only this gives disk encryption.
- Privacy check: scrub the systemd journal for the ComfyUI unit's past entries (new ones no longer go there).
- At "Nothing stays": the browser profile is removed with the session folder while the window may still be open;
  harmless (memory), but the window should close first on ■ Stop.

## Done

- 1.30.1 — ComfyUI's console output to comfyui.log (memory at "Nothing stays"), not the journal; the launcher opens
  Prompt Maker as its own browser window with its own profile; workflows test fixed.
- 1.30.0 — Ubuntu/Debian package with bundled Node; privacy levels named Safe, Safer, Nothing stays.
- 1.29.0 — "How private?" on first start; Safer and Nothing stays levels; the session in memory.
- 1.28.0 — deletes shred everything (3 passes), .bak copies forget, the line's clip and ComfyUI's copy go, words
  scrubbed from the chat, jobs, LM Studio's server logs and ComfyUI's log; delete warning with "Don't show this
  again"; Undo countdown; Privacy check card; ComfyUI working files in memory; the pitch rewritten for creators.
