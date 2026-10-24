# To do

The backlog, in the order it's worth doing. Point a new Claude session at this file. Each item says why it matters
and what "done" looks like; done items go to docs/whats-new.md with the version that shipped them.

## Next

1. **Rebuild the release packages** whenever a version ships: on Linux `packaging/deb/build.sh` and
   `packaging/deb/check.sh`; on Windows `packaging\windows\build.ps1` and `packaging\windows\check.ps1` (add
   `-UpdateFrom dist\prompt-maker-<previous>-setup.exe` to try the update path too); then attach both to the GitHub
   release (`gh release create vX.Y.Z dist/prompt-maker_X.Y.Z_amd64.deb dist/prompt-maker-X.Y.Z-setup.exe`). The
   Windows update looks for an asset named `*-setup.exe`. Latest: v1.68.0 (2026-10-21, the .deb only); the
   newest Windows installer is 1.67.0. Windows doesn't need every version: its installer is built when convenient.
2. **Check for updates should offer the newest release that has this computer's file.** It reads only
   `releases/latest`, so with v1.68.0 (no `*-setup.exe`) a Windows copy is offered 1.68.0 and ⬆ Update says "The
   newest release has no Windows installer yet". Read the release list and take the newest release carrying the
   wanted asset (`.deb` or `*-setup.exe`) in `lib/update.js`; Windows copies get it with their next installer.
3. **Windows, still to try** (the user's Windows testers do these): a render on the Intel Arc (needs a model file;
   the Krea 2 ones are 10+ GB) and on an NVIDIA card (the CUDA 13 / 12.6 choice by driver version is written, not
   tried); the Startup entry at a real sign-in; the first-start screen on a PC with less than 20 GB of memory
   (Qwen3-VL 4B) and on one with Smart App Control off (here it was on, and refused one scipy file once: the retry is
   written for that). The test suite doesn't run on Windows (its fakes are shell scripts and it wants
   `google-chrome`). Linux could get the same first-start screen (LM Studio through its AppImage or .deb, the Brain
   through lms).
4. **App-name change**: decided 2026-10-20, the name stays Prompt Maker for now. If that changes, do it before more
   users: repo, package name, data folder, service unit names, the `promptmaker://` link, the installer's AppId
   stays (it's a GUID), the README.
5. **🎲 Surprise me on a real Brain** (1.68.0 ran only against the mock): the user tries it on the main Brain.

Decided, not to do: **signing the Windows installer** (the user said no, more than once; don't propose it). The guide's
"More info → Run anyway" stays.

## Ideas, not scheduled

- A Linux install USB (Ubuntu autoinstall) with Prompt Maker, LM Studio, ComfyUI and the NVIDIA driver installed on
  first boot: the "dedicated box" tier.

## Done

Shipped items are in [docs/whats-new.md](docs/whats-new.md) and the [releases](https://github.com/VincentAZ/prompt-maker/releases).
