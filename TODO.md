# To do

The backlog, in the order it's worth doing. Point a new Claude session at this file. Each item says why it matters
and what "done" looks like; done items move to the bottom with the version that shipped them.

## Next

1. **Rebuild the release package** whenever a version ships: `packaging/deb/build.sh`, `packaging/deb/check.sh`,
   then attach to the GitHub release (`gh release create vX.Y.Z dist/prompt-maker_X.Y.Z_amd64.deb`). Latest:
   v1.53.1 (2026-10-12).
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

- 1.58.1 — Rendering a take again with the same seed no longer fails with "ComfyUI returned 404 for /view…". ComfyUI
  skipped the job it had just done, Save node included, and named the file it saved last time, which Clean up had
  removed. Each job's end nodes carry a tag of their own now (comfy.tagRun), so the Save node runs again (from
  ComfyUI's memory, instantly) and saves a new file.
- 1.58.0 — The viewer's Open original prompt opens just the take the render came from, on its version, the render
  ringed; Show all takes above it brings the others back. Open all takes (a tick under the button, off by default,
  remembered in the browser) opens every take, scrolled to that one.
- 1.57.2 — A render landing never switches Create to Your renders by itself (the tab gets a dot); a render that
  lands takes the place of its own running tile, on the take and in Your renders (×4: four tiles from the start),
  so nothing slides over mid-run. Pick from your Library shows each picture's stars.
- 1.57.5 — The Library's ring around the render you looked at last was a 2 px line, lost among a few hundred small
  tiles: it's a wider ring with a glow now.
- 1.57.4 — Studio polish (ChatGPT): a draggable divider between Create's form and results, a resizable prompt box
  in the render viewer (both remembered in the browser), Saved-prompts cards with a ▶ Video badge and a two-column
  action row. Three UI tests still expect the old viewer and Settings layout (the stars before the prompt box, the
  Create tab covered in the character-sheet test, the cleanup folder field); the UI side owes them a fix.
- 1.57.3 — Add an image's **browse** lists videos too, so a video's recipe can be picked from the file dialog, not
  only dragged in; the box says a picture or video you made brings its recipe.
- 1.57.1 — At the Safer and Nothing-stays levels (ComfyUI in memory), a kept render's copy stayed in ComfyUI's
  output folder, whole job inside: keep-time cleanup looked only at the install folder's output (or the one set),
  never at the one ComfyUI was started with. It looks there first now, as deletes already did.
- 1.57.0 — The studio redesign and the render-file tags (1.55.0, 1.55.1) are one branch again: videos and
  pictures made from here on say which model made them, the way Civitai reads it, and nothing else.
- 1.56.1 — Closing the viewer on a video no longer looks like the video playing on: the tile it was opened from
  (Library, takes) started its silent hover preview the moment the viewer went, with the pointer still on it; it now
  keeps its still until you move to another tile. The viewer's video is also stopped and unloaded before it goes.
- 1.56.0 — **Make it again from a file**: a picture or video made with ComfyUI, A1111, Forge or Civitai keeps how
  it was made; dropped (or browsed) in, **📜 Recipe inside** puts back its model and workflow (the one loading the
  same model file), prompt word for word, LoRAs at their strengths (missing ones named, left out), fixed seed, size,
  length, sampler settings, and the picture it began from when it's still in the data folder. A video asks first
  (recipe or motion video). Read in the browser (public/recipe.js), matched on the server (lib/recipe.js).
- 1.55.1 — The model a render says is written the way Civitai reads it (its AIR in `workflow`, the loader node in
  `prompt`), for every built-in model but Wan Animate 2.
- 1.55.0 — A render file says which model made it and nothing else: ComfyUI wrote its whole job (the prompt word for
  word, file names, seed) into every PNG and video, and Prompt Maker's copy kept it. Older renders are cleaned once at
  start-up. Saved prompts cards show their whole picture, smaller, and a title starts where look-alike prompts differ.
- 1.53.1 — The idea box's text was 19 px: it's 15 px now, and 13.5 px with your own prompt (a whole prompt, often
  long), so much more of it shows at once.
- 1.53.0 — Renders survive a restart of Prompt Maker: each render sent to ComfyUI is noted (ids and settings, no prompt
  text), and at start every one ComfyUI still has, running or finished meanwhile, is followed again and kept on its take.
  (Two MiniMax videos were lost from view when Prompt Maker was restarted mid-render.) Fixed a leftover "step 6".
  Step ④ as you left it (shape, size, duration, length, how adventurous) is kept per model in the data folder, not
  the browser: the app window and a Brave tab each kept their own, so a size picked in one wasn't picked in the other.
- 1.52.1 — `scripts/launch_branch`: runs Prompt Maker from a git branch in place of what runs now (and `main` back),
  to try a branch with your own data before it's merged.
- 1.52.0 — **☐ Let AI choose** at the top of the chains section: one click makes the AI pick the best render at every
  step (and steps added later), off waits for you. Fixed: a video came out flat grey when "How much to change your
  picture" had been set to 0 on an image-to-video workflow; the slider now shows on picture models only, stops at
  0.05, and a 0 saved before renders at the workflow's own value.
- 1.51.0 — A size you type in step ④ stays in that model's Size menu for good: it's kept in the data folder (with
  your own looks), not in the browser, so it survives a reboot and shows in any browser; at *Nothing stays*, for the
  session only. Sizes typed before move there on their own.
- 1.50.0 — **A calmer Create**: flat panels, one accent color, no gradients or glow; quiet step numbers and
  headers with more air between steps; plain words instead of emoji on the Create page's labels and the renders
  box's filters; the model line is its name and Change, with "About this model" folded under it; the drop zones are
  one line; the picture's denoise folds under "Picture settings"; ⑤ and ⑥ are one closed **Settings** fold holding
  **Render** and **Writing & more steps**; the empty takes tab is one line of ideas; the renders box keeps only
  search, Filters, Select, the size slider and a full-screen icon on its row, with every filter behind Filters.
  Not done: a light theme (about a hundred colors are hard-coded, so it isn't a cheap switch).
- 1.49.0 — **Results in two tabs on Create**: ✦ Prompt takes and 🎞 Your renders share the stage one at a time, so
  neither pushes the other down the page (the main button shows the takes, the first render landing shows Your
  renders unless you're typing, with a dot on the tab instead). A caption under every render: the idea's first words
  and the model. Shape is a row of tiles with the shape drawn. Steps ⑤ **Render settings** and ⑥ **More creative
  controls** (prompt length, how adventurous, Then…) are quiet folds, closed to start; a folded ⑤ no longer says
  "No workflow yet" while a workflow is picked.
- 1.48.2 — A render waiting to be deleted is greyed out wherever it shows (the full-screen view too), with the
  seconds left and ↶ Undo on it. The idea at the top of the full-screen view's side panel was a big bold heading: now small, plain, folded
  to two lines under ▸ Your idea.
- 1.48.1 — A size picked renders at that size with a workflow that only takes a shape (Krea Dual Resolution
  Selector: it made 1456×2176 for 832×1216). With a fixed seed and ×2–×4, the seed chip says which seeds (🔒 Seeds 4242–4244).
- 1.48.0 — Spell check in every box you write in (the take's prompt had it off). A take renders at step ④'s size as
  it is now, not the size its prompt was written for (queued, batch and chain renders keep theirs). The take's ⚙ offers
  your typed sizes (picking one brings its shape), and a LoRA switched in step ⑤ shows there at once: a take keeps only
  the LoRAs you changed in it, not a copy of all of them.
- 1.47.3 — In the full-screen view, a render rated out of the filters leaves what you browse whichever stars rate it:
  the stars under the one browsed in ⇆ Compare skipped that, and the viewer now drops anything that stops fitting.
- 1.47.2 — A size you type turns Shape to its exact shape (1000×700 → 10:7 ✎, not the nearest preset) and comes back,
  shape and all, after a restart; picking your size from the menu brings its shape back, another Shape moves off it.
- 1.47.1 — The tweak chips under a take no longer appear and vanish with the mouse (everything below jumped): they
  stay, dimmed on the takes you're not on. The toast sits above the full-screen view, so its ↶ Undo can be clicked
  there.
- 1.47.0 — **⬇ Download** in the Gallery's selection bar: one render as it is, several as one .zip (stored as they
  are, streamed, Zip64 past 4 GB). Fixed: the Gallery stopped at 120 cards when the end of the grid was still in
  view after a load (small cards, or right after a filter changed). In the full-screen view, a render rated out of
  the filters (browsing ★★★, rated ★★) leaves what you browse, with ↶ Undo. A Saved prompts card too narrow for its
  buttons wraps them instead of cutting off **Open prompt →**.
- 1.46.0 — **🔁 All takes**: one change typed once above the takes refines every take with it, each as its own
  version. The *Tweak it…* boxes are never locked anymore: a tweak sent while a prompt is written (or a batch or a
  chain runs) is lined up and runs as soon as that's done, before the next prompt in line (✕ Take it out cancels it).
- 1.45.1 — While something cooks, the main button reads **＋ Line up another** (a plain button, no longer the moving
  gradient) and what's cooking (**✦ Writing prompt…**, a batch's progress) shows on the line above it. A click on the
  dark beside a picture in the full-screen viewer closes it.
- 1.45.0 — **Several pictures in step ③.** A workflow's Load Image nodes are its picture slots (named by the node's
  title, needed or optional); step ③ shows a slot per picture under the first, the Brain gets them all with their
  names, the render uploads them all and leaves an empty optional slot (and what only it fed) out of the workflow.
  Starters: **Krea 2 Character: into your picture** (Place + Person, the Identity Edit v1.2 two-picture edit,
  rendered for real), Qwen Image Edit with two more optional pictures, MiniMax H3 Reference with a second picture of
  the person. Saved prompts keep and restore the extra pictures; deleting shreds them.
- 1.44.0 — **Settings → ⬆ Updates**: Check for a newer version (GitHub, only on click), ⬆ Update in one click (git
  pull for a repo copy; the new .deb downloaded and installed behind pkexec for a package install; a folder copy
  is sent to the downloads page), then **↻ Restart Prompt Maker**. ↻ Restart on the Services row too, and
  everything that said "restart Prompt Maker" offers ↻ Restart now; the page waits for the server and reloads.
- 1.43.0 — Finer Gallery filters: 📅 Today / This week / This month / Older, shape (portrait, landscape, square),
  ☆ Not rated yet, 🎙 Spoken line, and menus for the workflow, LoRA and look a render was made with (each shows once
  there's a choice); search also finds a seed, a size, a look or a LoRA.
- 1.42.0 — Every parameter of a take can be changed on the take: **⚙ This take's settings** under its render bar
  holds shape, size, duration, seed, every sampler setting and the LoRA switches and strengths, for that take's
  renders only (step ⑤ and the other takes keep theirs; ↺ Same as step ⑤ gives it all back).
- 1.41.0 — No waiting for the Brain: while a prompt is cooking the main button stays live and lines up the
  next one (**＋ Click to line up the next one** under it counts the line) (as `Ctrl+Enter` did), the way ComfyUI queues renders; the separate ＋ Queue button is gone. On the stage,
  **＋ Add a take** writes one more take for the set from everything it was made with, and **🗑** on a take deletes
  it with its renders (shredded like a card; the last take takes the card). A take's render tiles are redrawn only
  when they change: a redraw replayed their entrance animation and stopped the video under the mouse, so a take
  seemed to jolt up on hover.
- 1.40.0 — Everything that comes with the app ships attached, nothing is opt-in. Every starter workflow a model has is
  added by itself (also one that arrives with an update), not just the first. "Video from words" is its own model:
  **LTX 2.3: video from words** and **MiniMax H3: video from words** sit under **Make a video** in step ①, while
  **LTX 2.3** and **MiniMax H3** animate a picture, so the two are two choices, each with its own starter attached. A
  model that works from words alone greys out step ③ (**No image**): nothing can be dropped there, and a picture
  already there is set aside, not sent. ("MiniMax H2" was asked for again; still no such model exists, so it's H3.)
- 1.39.0 — Two new models with playbooks and starter workflows, each rendered for real before shipping: **Z-Image Turbo**
  (text to image, 8 steps, text in the picture renders right) and **Qwen Image Edit** (one instruction edits your picture,
  4 steps with the Lightning LoRA). **LTX 2.3** and **MiniMax H3** get a second starter, "video from words", that
  needs no picture (＋ Add workflow → 🎁); their playbooks list ComfyUI's own templates too. ("MiniMax H2" was asked
  for: no such model or template exists on this machine or in ComfyUI, so the MiniMax one is H3.)
- 1.38.0 — Steady takes: a take's box holds the height its prompt is expected to need from the first word, its
  word-count row is there from the start, and a refine keeps the box, so nothing under a take moves while the Brain
  writes. 🎥 Looks: **🚫 No look** (the Brain adds no camera or light of its own) and **＋ Your own look…** (name it,
  say what the camera and light do; edit, delete with undo; session-only at Nothing stays; a take keeps the words of
  its look). Every detail of the idea stays: a keep-the-theme rule plus one short check per take that puts back what
  the Brain changed (the take says ✓ Checked / ✎ Put back; a switch under How the Brain thinks). ✦ Ask: a `plan`
  tool pinned in its instructions and shown as a checklist above the chat; a long chat folds older steps into their
  one-line summaries, then into a Brain-written progress note, sized from the Brain's loaded context; an overflow
  folds and retries; big tool results are trimmed at the source.
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
