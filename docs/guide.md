# Prompt Maker guide

The full manual for [Prompt Maker](../README.md): every page, setting and trick. The README has the short version.

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Using Prompt Maker](#using-prompt-maker)
- [Rendering with ComfyUI (optional)](#rendering-with-comfyui-optional)
- [Target models](#target-models)
- [Choosing a Brain](#choosing-a-brain)
- [Settings](#settings)
- [Privacy & offline](#privacy--offline)
- [Your data](#your-data)
- [Troubleshooting](#troubleshooting)
- [Platform support](#platform-support)
- [Development](#development)
- [Contributing](../README.md#contributing)
- [Acknowledgements](../README.md#acknowledgements)
- [License](../README.md#license)

## Features

- **Theme → prompt.** Type an idea ("a woman at the beach with a soda in her hand"), pick a model, and get a finished prompt.
- **Image → prompt.** Drop in an image and use it three ways:
  - 🎯 **Reference**: borrow its look and blend it with your theme.
  - 🪞 **Recreate**: describe it so the model can reproduce it.
  - 🎬 **Animate**: video models only. The image is frame one, and the prompt describes what happens next.
- **Image alone.** Leave the theme empty and it suggests a prompt from the image.
- **✍️ Your own prompt (off by default).** Already have the prompt? Switch on **✍️ Use my own prompt, word for word** under step ②: what you type or paste is sent to the model exactly as it is, with your image and your workflow. No Brain is asked, so LM Studio can even be off.
- **🧾 Same person, every render (Krea 2 Character, MiniMax H3 Reference).** Drop in a picture of someone and they stay themselves in brand-new pictures and clips: the Brain writes their **character sheet** once (face, eyes, hair, skin, build, marks), you can fix any line, and every take carries all of it. **🪪 Turnaround** renders them from every side and makes that the picture to follow. No denoise: the picture is the person, not a picture to repaint ([more](#same-person-every-render)).
- **🎙 Voices.** Describe a voice once ("a woman in her late twenties, warm light alto, soft Midwestern lilt"), hear it, keep it by name. Any line you write is then said in that voice, on this computer, and MiniMax H3 makes the person in your picture say it ([more](#voices)). One-click setup; ComfyUI isn't touched.
- **🕺 Character animation (Wan Animate 2).** Give it a character image and a motion video: your character performs the video's moves, in a setting and from a camera angle you describe. The Brain watches the video (a sheet of its frames) to name the motion, and ComfyUI's own Wan Animate 2 templates are one click away, set up for you. A model file your ComfyUI lacks is one **⬇ Download** away, and a video's black bars one **✂️ Crop** away.
- **Spell check where you write.** Your idea, the prompts in the takes, the Tweak it… boxes, the character sheet, looks, voice descriptions, the assistant's message box and the Brain's instructions underline misspelled words; right-click one for suggestions. It uses your browser's own spell check, so it works offline and follows the browser's language (if nothing is underlined, turn spell check on in the browser's settings).
- **Model-aware settings.** Shape, size, duration (video) and prompt length. Size offers the model's own sizes for the shape plus a range from Small to Huge (about 0.5 to 4 megapixels). None of them fit? Pick **✎ Type your own size…**, enter a width and height and click **✓ Use**: Shape turns to the size's shape (1280×720 → 16:9; a size no preset fits gets its own, like 1000×700 → **10:7 ✎**), so the render and the prompt are never sideways. The size stays in that model's menu as "Your size: …" and stays picked, shape and all, even after a restart; picking it again from the menu brings its shape back, and picking another Shape moves to a size in that shape. **✕ Forget** takes it out. The render comes out at the size you pick, even with a workflow that works out its own size from a shape (like Krea's Dual Resolution Selector): the size goes past that node, straight to its latent and final size, so that workflow's own upscale is not used.
  - Uploading an image **matches the aspect ratio to it** automatically.
  - Each model remembers your last choices.
- **🎥 Directed like a film shot.** Every prompt gets camera and light chosen for your theme's mood, not the same default every time: a shot size, a camera angle, a lens, the focus, a main light and a second one with where they come from, a contrast word ("low-key", "high contrast") and a composition ("leading lines", "frame within a frame"). Want a particular feel? One click on a **Look** under your theme: 🪟 Natural, 🕯️ Intimate, ⚡ Powerful, 🌫️ Lonely, 🫣 Suspense, 👻 Horror, 🕵️ Noir, ☁️ Dreamy, 📷 Gritty, 🏔️ Epic or 💎 Luxury (video models get a camera move to match). Name a camera or light in your theme and it's kept. With a picture to 🎬 animate, its framing and light stay, and only the camera's movement is chosen.
- **🚫 No look, or your own.** **No look** keeps the Brain's hands off the camera and light: only what your theme or image says. **＋ Your own look…** keeps a look you describe yourself (a name, what the camera and light do, the camera move on video) next to the built-in ones.
- **Every detail you typed stays.** The Brain is told to keep every fact of your idea (who and how many, colors, clothes, objects, place, time, weather, what happens, quoted words) and to add detail only where you said nothing. After each take, one short check puts back any detail it changed, and the take says so.
- **Variations.** Write 1–4 prompts at once. Each take deliberately goes a different way (angle, lighting, setting, moment).
- **⏳ Queue.** No waiting for one to finish: while a prompt is cooking, the main button turns into **＋ Line up another** (what's cooking shows just above it) and, like `Ctrl+Enter`, lines up the next one, as many as you like. Each keeps the setup it was queued with, and its renders go on in ComfyUI while the next prompt is written.
- **Refine.** Tell a take what to change ("golden hour", "add a dog", "shorter") or tap a quick chip, or type it once in **🔁 All takes** to change every take the same way. Every version is kept and you can page through them, and hand edits are saved as versions too.
- **Live output.** Text streams in as it's written.
  - Word count against the model's ideal length (✓ when it's on target).
  - Timing for each take, plus a status while the model loads or thinks.
  - Progress shown in the browser tab title.
- **✦ Assistant with 🗂 jobs.** A creative partner that sees your renders and runs the whole app, anything you can click, and takes long jobs that run on their own, judge as they go and leave a log to review (*"8 stills of her in a noir café, same seed; animate the best in MiniMax at 20, 17, 13 and 10 steps. I'll be back in a couple of hours."*). For a task of a few steps it writes a plan first and ticks it off on screen; when a chat gets long, its earlier steps fold into a short note, so the Brain doesn't run out of room.
- **Saved prompts.** Every prompt is saved automatically and grouped by day. You can search it, filter by model, bookmark favorites, and reopen any entry to keep refining.
- **Delete means shredded.** Deleting a card takes everything about it with it: prompts, picture, motion video, spoken line and renders, in Prompt Maker and in ComfyUI (its folders on disk included, from before it worked in memory). The files are written over three times before they're removed (the three passes of the DoD 5220.22-M wipe) and its words are wiped from the assistant chat, from jobs and from LM Studio's and ComfyUI's own logs. See [Saved prompts](#saved-prompts).
- **🎨 Render with ComfyUI (optional).** Attach as many ComfyUI workflows as you like to each model, then hit **▶ Render** on any take:
  - Pick any workflow you've saved in ComfyUI. Prompt Maker reads it directly, with no "Export (API)" step, and works out where the prompt, image, size, duration and seed go.
  - **🎁 Every model comes with a workflow**, already attached: pick a model and **▶ Render** is there. A model file you don't have yet is one **⬇ Download** away. Prefer your own? Add it and it's the one used; the one that came with the app stays in the list until you delete it.
  - Watch live progress (and previews) right on the take.
  - **🎞 Your renders**, on its own tab beside the takes, holds every render you've made, newest first, with filters and a caption under each (the idea's first words and the model), so nothing gets lost below a long prompt. Drag the cards into your own order, pick several (Ctrl-click or drag a box) to download or delete them in one go, and make the box as tall as you like, or full screen.
  - Rate the good ones: **★ Pretty good**, **★★ Very good**, **★★★ Excellent**.
  - **⇆ Compare** two renders side by side and **Pin on the left** until the best is left.
  - **Hide from Create** tidies your workspace; the artwork stays in Gallery and Saved prompts. **Delete** waits 8 seconds with **↶ Undo**.
  - Browse every result in the **Gallery**: the same grid as 🎞 Your renders, as tall as the window, in the same order you dragged them into. View any of them in a full-screen lightbox.
  - Chain models: turn a still into the input image for a video model with one click.
- **🧠 Brain profiles.** **Models → Brains** shows every LM Studio model: how it thinks, how fast it is here, and how its prompts did for each of your models. The Brain menu suggests the best ones for the model you're on, and a one-click **Quick check** tests a new model in about 20 seconds.
- **🔞 Adult content (optional, off by default).** A switch under **Settings → Master instructions** lets the Brain write explicit prompts between adults: plain anatomical language, who does what to whom kept exact, the act at the center of the shot. Each model can also have **Adult examples**, used only while the switch is on.
- **Model playbooks you own.** Add a new model, edit its instructions, or paste a model's official docs and let your Brain draft the playbook. Import and export models as `.json`.
- **Zero install fuss.** Plain Node.js with no dependencies: no `npm install`, no build step.
- **No terminal after the first start.** On Linux and Windows a launcher puts Prompt Maker in your app menu and starts it with your computer. **Settings → Services** starts and stops LM Studio, ComfyUI and Prompt Maker itself.
- **Private by design.** Nothing leaves your machine (see [Privacy & offline](#privacy--offline)).

## How it works

```
 You (browser) ──▶ Prompt Maker (localhost:5317) ──▶ LM Studio (localhost:1234)
                    • the target model's playbook      • your Brain (a local AI model)
                    • your theme / image / settings    • writes the prompt, streamed back
                                   │
                                   └──(optional)──▶ ComfyUI (localhost:8188)
                                                     • your workflow, with the prompt dropped in
                                                     • renders the image/video on your GPU
```

Prompt Maker builds a request out of three parts and sends it to LM Studio: its shared master rules (with a camera-and-light guide to how a cinematographer picks the shot and the light), the target model's playbook and example prompts, and your theme, image and settings. The Brain's reply streams back into the page as your prompt. When you render, Prompt Maker makes a copy of the workflow you picked, puts the prompt (plus image, size, duration and a fresh seed) into it, and queues it on your ComfyUI. The result is saved alongside the take.

## Requirements

| What | Details |
|---|---|
| **Node.js 20.11+** | [nodejs.org](https://nodejs.org). Check with `node --version`. |
| **LM Studio** | [lmstudio.ai](https://lmstudio.ai), free for macOS (Apple Silicon), Windows and Linux. |
| **A Brain** (a local AI model) | Any chat model works. Use a **vision** model (tagged "Vision" in LM Studio) if you want to use images. See [Choosing a Brain](#choosing-a-brain). |
| **Hardware** | Enough memory to run that model. A small 4–8B vision model needs roughly 4–8 GB of GPU VRAM or Mac unified memory. CPU-only works, just slowly. |
| **A modern browser** | Chrome/Edge 111+, Firefox 121+, Safari 16.2+ |
| **ComfyUI** *(optional)* | Only for rendering. Any recent [ComfyUI](https://github.com/comfyanonymous/ComfyUI) running locally (default port `8188`); on Linux, **Settings → Services → ⬇ Set up ComfyUI** installs it for you (see [Rendering](#rendering-with-comfyui-optional)). Node 22+ gives live progress; older Node versions poll instead. |

## Installation

**Ubuntu / Debian, one click:** download `prompt-maker_<version>_amd64.deb` from the [releases page](https://github.com/VincentAZ/prompt-maker/releases) and double-click it (or `sudo apt install ./prompt-maker_*.deb`). It brings its own Node.js, puts **Prompt Maker** in your app menu, and the first start sets up the rest and asks how private you want it. Then do step 2 below for LM Studio, and you're done; steps 1, 3 and 4 are for every other system. To build the package yourself: `packaging/deb/build.sh` (it fetches Node 22 and writes `dist/`).

**Updating it:** **Settings → ⬆ Updates → Check for a newer version**, then **⬆ Update** and **↻ Restart**: no terminal, for the .deb and for a git copy alike (see [Settings](#settings)).

**Removing it:** `sudo apt remove prompt-maker` (or remove it in your software app, if it lists it). Your pictures, videos, playbooks and settings stay in your data folder, and ComfyUI and LM Studio stay too. Prompt Maker's start-with-your-computer entry stays in your home folder, but it does nothing once the app is gone, and installing again brings it back as it was. To remove that too, run `prompt-maker --uninstall` first. If you then run Prompt Maker from another folder, it notices that the start-up entry points at the removed copy and moves it to itself; **Settings → Services** also says when that entry opens another copy, with a **Use this copy** button.

### 1. Install Node.js

- **macOS / Windows:** download the LTS installer from [nodejs.org](https://nodejs.org).
- **Linux:** use your package manager, or [nvm](https://github.com/nvm-sh/nvm): `nvm install --lts`.

### 2. Install LM Studio and get a model

1. Install [LM Studio](https://lmstudio.ai) and open it once. This also installs its `lms` command-line tool.
2. Go to the **Discover** tab (🔍) and download a vision model, for example **Qwen3-VL 8B**.
3. Turn on the local server. Any of these works:
   - In LM Studio: **Developer** tab → **Start server** (it runs on port `1234`).
   - In a terminal: `lms server start`
   - Or skip this step: Prompt Maker shows a **▶ Start it** button when the server is off.

> **Tip:** LM Studio loads a model automatically the first time it's used, so you don't have to load one by hand. The first prompt just takes a few extra seconds.

### 3. Get Prompt Maker

```bash
git clone https://github.com/VincentAZ/prompt-maker.git
cd prompt-maker
```

No git? Click **Code → Download ZIP** on GitHub and unzip it.

There's nothing to install. Prompt Maker has no dependencies.

### 4. Start it

```bash
npm start
```

Then open **http://127.0.0.1:5317** in your browser.

On **Linux** you can use the launcher instead. It starts LM Studio's server if needed, starts the app and opens your browser, and if the app is already running it just opens it:

```bash
./start.sh
```

To stop Prompt Maker, press `Ctrl+C` in the terminal.

**On Linux, the first start sets everything up for you,** so you never need the terminal again:

- **Prompt Maker in your app menu.** Open it from there like any other app.
- **It starts with your computer** and keeps running in the background. It turns on LM Studio's server too, and comes back on its own if it ever stops. Switch this off or on in **Settings → Services**.
- **A Start button that works even when Prompt Maker is off.** If the page ever says *Prompt Maker's server isn't running*, click **▶ Start Prompt Maker**. The first time, your browser asks to open Prompt Maker: allow it (tick *Always allow*). The page keeps a copy of itself, so it opens even while the server is off.

**Start and stop everything from Settings → Services,** with no terminal:

| Row | What you can do |
|---|---|
| **Prompt Maker** | ■ Stop it. The page shows it stopped right away (the rows say *Stopped*) and offers ▶ Start Prompt Maker |
| **LM Studio** | ▶ Start its server, or ■ Stop it, which first unloads every model to free the GPU |
| **ComfyUI** | ▶ Start it, or ■ Stop it. It starts from its folder, the way Prompt Maker last saw you run it, or with live previews on (`--preview-method auto`); change the folder or the options under **ComfyUI** in Settings. Tick *Start ComfyUI along with it* to have it come up with Prompt Maker. Not on this computer yet? **⬇ Set up ComfyUI** installs it (see [Setting up ComfyUI](#setting-up-comfyui-one-click)) |

**■ Stop everything (frees the GPU)** stops ComfyUI, unloads LM Studio's models and turns its server off, then stops Prompt Maker. On Create, *ComfyUI offline* has a **▶ Start it** link too.

If the app folder moves or is removed, the start-up entry does nothing instead of failing at every login, and the next start from the new place moves it there. To undo all of it, run `./start.sh --uninstall`; `./start.sh --install` sets it up again. Logs: `journalctl --user -u prompt-maker -f`; ComfyUI's own output, when Prompt Maker starts it, goes to `comfyui.log` in your data folder (in memory at the "Nothing stays" level), not the system journal, and a delete cleans it like ComfyUI's logs. The launcher opens Prompt Maker as its own window with its own browser profile (Brave, Chromium, Chrome or Edge, whichever is there; the default browser otherwise), so nothing of it lands in your everyday browser's history; that profile lives in the data folder, or in memory at "Nothing stays". `PM_BROWSER=/path/to/browser` picks the browser, `PM_BROWSER=default` keeps the old way. macOS gets the same setup with its own launcher (coming).

On **Windows**, double-click **`start.bat`** in the app folder. It starts LM Studio's server if needed, starts the app and opens your browser. The first start also puts **Prompt Maker** in your Start menu and makes it start with your computer (without a window); **Settings → Services** switches that off, and `start.bat --uninstall` removes it. ⚠️ The Windows launcher and setup are new and have **not yet been tried on a real Windows PC**: if something doesn't work, start the app with `npm start` and please report it.

## Quick start

1. **Pick a brain.** Use the **Brain** menu at the top right: models marked 👁 can see images, and "loaded" means it's ready right now.
2. **Choose what to make**, for example **Make a picture**. The task picks a suitable model; **Change model** lets you choose another.
3. **Describe the shot.** Type a theme, or hit **🎲 Surprise me**. **✕ Clear** empties the box in one click (**↶ Undo** brings it back).
4. Click **Write prompt**, or turn off **Review prompt first** to **Make image** or **Make video** with your configured workflow. `Ctrl+Enter` runs the same action. Existing auto-render preferences are preserved.
5. **Copy** the prompt, or tweak it: type *"make it night time"* in the box under the take and press Enter.

## Using Prompt Maker

### Create

<img src="screenshots/create.png" alt="Create starts with your creative task and idea; model details stay folded and artwork has its own stage" width="900">

| Step | What it does |
|---|---|
| **① What do you want to make?** | Choose a creative task. Its recommended model appears below as one line; **Change model** opens the full choice and remembers your preference, and **About this model** folds out what it's for and how to use it. **Animate a picture** and **Make a video** are different models: the first starts from your picture (LTX 2.3, MiniMax H3), the second from your words alone (**LTX 2.3: video from words**, **MiniMax H3: video from words**). **About this model** starts folded and offers the practical guide and example ideas when you want them. |
| **② Describe the shot** | Your theme: short or long, casual is fine. Optional if you add an image. Under it, the **🎥 Look** sets how the camera and light feel: one of eleven, **No look**, or **your own** (see below). Have the exact prompt already? **✍️ Use my own prompt, word for word** (below) sends it as it is, with no Brain (the Look steps aside). |
| **③ Add an image** | Drop, paste (`Ctrl+V`) or browse. **More than one picture:** when the workflow picked in step ⑤ takes several (a person and a place, pictures to combine), step ③ grows a slot per picture under the first, each named by the workflow (**Person**, **Another picture**…) and marked *needed* or *optional*: ＋ Add, Gallery, Replace, Remove, or drop a picture straight onto the slot. The Brain sees every picture and is told which is which; the render uploads them all, and an optional slot left empty is simply left out of the workflow. On a model that works from words alone (the **video from words** ones) this step is greyed out and says **No image**: nothing can be dropped, and a picture you already added is set aside, not sent, until you pick a model that takes one. Otherwise:  Click the image to see it full screen (click again for actual size). Picking from your Gallery? Drag the 🔍 slider for bigger thumbnails, or hit a tile's 🔍 to look closer. Then choose how to use it (below). On a character-animation model (Wan Animate 2) this step is **Character & motion**: the image is your character, and a **🕺 motion video** goes under it (see [Character animation](#character-animation-wan-animate-2)). |
| **④ Shape, size & variations** | Click a shape tile (Portrait, Square, Landscape or Wide, each with its exact ratio drawn as a little frame), then the size, video duration and the number of alternatives. **Size** lists sizes in the picked shape, from Small (about half a megapixel) through Standard, Large and Extra large to Huge (about four), with HD, Full HD, 2K and 4K by name; it starts on the model's usual size and follows the shape. **✎ Type your own size…** at the bottom takes any width × height; **✓ Use** keeps it in that model's Size menu for good (the last twelve, in your data folder, so after a reboot and in any browser too; at the *Nothing stays* privacy level, for the session only). Pick it and **✕ Forget** takes it out. Step ④ as you leave it (shape, size, duration, and in ⑤ prompt length and how adventurous) is kept per model in the data folder too, so the app window, a browser tab and every restart open on what you picked last. |
| **⑤ Settings** | One quiet fold at the bottom, closed to start, with two folds inside. **Render** (optional, with ComfyUI): the workflow that renders your takes, edit it or add one, and under **Advanced** its seed, LoRAs and sampler, then auto-render, renders per take and batches (see [Rendering](#rendering-with-comfyui-optional)). **Writing & more steps**: **Prompt length** and **How adventurous** for the Brain's writing, and **Then…** to chain more steps, like still → video (see [Chains](#4-chains-build-your-own-pipelines)). |

**The results have two tabs**, beside the steps: **✦ Prompt takes** (what the Brain wrote, with its buttons) and **🎞 Your renders** (every picture and video, in one grid that fills the rest of the window). One shows at a time, so neither ever pushes the other down the page. Before you write anything, the takes tab is one line of ideas to try. Pressing the main button (or opening a saved prompt) shows the takes; the first render of a run landing shows Your renders, unless you're typing in a take, in which case the tab gets a dot instead. On a wide window the renders grid fills the stage; on a narrow one the box has a bottom edge to drag.

**Review prompt first** beside the main action remembers your choice per model. The button states the outcome and total count, such as **Make 8 images** for four variations rendered twice. Progress shows **Writing prompt → Making image/video → Ready**. On narrow screens, including a laptop with Ask open, **Create / Results** switches directly between the form and current work. Current results come before the historical render grid.

**＋ New session** beside the main action clears the theme, image and takes but keeps your model and dials. **↶ Undo** brings it all back, and everything stays in Saved prompts.

**⏳ Queue: line up as many as you like.** While a prompt is cooking (or a batch is rendering), the main button turns into **＋ Line up another**, with what's cooking (**✦ Writing prompt…**, a batch's progress) on the line above it and how many are waiting under it; it (or `Ctrl+Enter`) puts the form, as it is right then, in line, the way ComfyUI queues renders:

- **What you see when you click is what runs.** Each one in line keeps its model, theme, image and role, dials, takes, batch, and render setup (workflow, auto-render, LoRAs and sampler settings). Change the form afterwards to set up the next one; it won't touch those already waiting. (The Brain and the seed are the ones in use when its turn comes.)
- **They run in order**, each its own run and Saved prompts entry. A take's renders go on in ComfyUI while the next prompt is written; a batch finishes its renders before the next starts.
- **Up next**, at the top of the results, lists them: **✕** takes one out (with **↶ Undo**), **Clear** empties the line. Clicking twice on the same form within a second queues it once.
- **■ Stop** (or `Esc`) stops only the one running; the rest carry on. If one fails (LM Studio or ComfyUI went away, say), the line goes **⏸ on hold** so the rest don't fail the same way: fix it, then **▶ Carry on**.
- A chain (step ⑤, Then…) can't wait in line, since it may stop to ask you to pick. The line lives in the page: reloading it lets go of what's waiting (the page asks first).

**✍️ Your own prompt, word for word.** Off by default. When you already know exactly what to send, switch on **✍️ Use my own prompt, word for word**, under the box in step ②. Then no Brain is involved at all:

- **② Your prompt** is the prompt. What you type or paste goes to the model letter for letter: weights like `(red kite:1.3)`, odd spellings, all of it. It must not be empty.
- **③ Your image** goes into the workflow as it is: there's no Reference / Recreate / Animate to pick, since those tell the Brain what to write.
- **① Your model** and **⑤ your workflow** are the ones that render it. Aspect, resolution and duration in step ④ still set the size; prompt length and how adventurous step aside, and **Takes** becomes **Renders**: how many times your prompt is rendered (×1–4), each with its own seed.
- The main button becomes **Make image** or **Make video** and renders right away (auto-render isn't needed). No workflow for that model yet? It becomes **Keep my prompt**: the take is saved, ready to copy or render later.
- The take says *✍️ your own prompt, word for word*, and Saved prompts marks it the same way. Reopening one from Saved prompts switches the mode back on; reopening a Brain's prompt switches it off. You can still click **Refine** on the take if you do want the Brain's help with it.
- A batch renders your one prompt as many times as it says. A chain (step ⑤, Then…) is written by the Brain, so it's hidden while the switch is on, and waits for you, untouched, until you switch it off.
- LM Studio doesn't need to be running.

**Image modes**

| Mode | Use it when… | What the prompt does |
|---|---|---|
| 🎯 **Reference** | You like the image's vibe | Carries its subject, palette, lighting and mood into *your* theme. |
| 🪞 **Recreate** | You want *that* image | Describes it faithfully so the target model can reproduce it. Your theme becomes changes. |
| 🎬 **Animate** | Image-to-video (video models only) | Treats the image as the first frame and describes the motion, camera and sound from there. |
| 🧍 **Character** | Character animation (Wan Animate 2) | The generator gets the image as the character to animate. The prompt describes how it looks exactly as it is, and where it is. It's the only way those models use an image, so there's nothing to pick. |

**🎥 Look** (under the theme) is how the camera and the light feel: how close, from which angle, what kind of light. **✨ Brain picks** (the default) lets the Brain choose them for your theme's mood. Or pick one, and every take is built on it:

| Look | What you get |
|---|---|
| 🪟 **Natural** | Like a real photo: eye level, soft window light, the background softly blurred. |
| 🕯️ **Intimate** | Close and quiet: a tight shot, the background melting away, soft light from the side. |
| ⚡ **Powerful** | Larger than life: the camera looks up, strong light from behind outlines the subject. |
| 🌫️ **Lonely** | Small in a big world: a wide shot, lots of empty space, cool dim light. |
| 🫣 **Suspense** | Something's wrong: a tilted frame, half hidden, deep shadows. |
| 👻 **Horror** | Dread: dark, centered, flickering light, light from below. |
| 🕵️ **Noir** | An old detective film: black and white, hard light, blind-stripe shadows, smoke. |
| ☁️ **Dreamy** | Soft and glowing: hazy focus, warm light from behind, pastel colors. |
| 📷 **Gritty** | Raw and real: handheld, only the light that's there, every detail and flaw. |
| 🏔️ **Epic** | Huge and grand: very wide, everything sharp, hazy light from behind. |
| 💎 **Luxury** | A polished ad: studio light, gleaming highlights, perfect composition. |
| 🚫 **No look** | Nothing of the Brain's own: the camera and light are only what your theme or image says. |

On a video model the look also picks the camera's move (a slow push in for Intimate, handheld for Gritty, a drone reveal for Epic). Anything your theme says about the camera or light still wins. The look is remembered, saved with each prompt (Saved prompts shows it on the card), and the ✦ assistant can set it too.

**Your own look.** Click **＋ Your own look…** at the end of the row, give it a name (and an emoji if you like), say what the camera and light do ("a 35mm lens at eye level, neon signs as the only light, wet reflections") and, for video, what the camera does; **✓ Keep this look** adds it to the row, picked. **✎ Edit this look** and **🗑 Delete this look** under the row work on the picked one (↶ Undo for a few seconds). A take keeps the words of the look it was written with, so refining it works even after the look is edited or deleted; opening such a take from Saved prompts says so and goes back to Brain picks. At the **Nothing stays** privacy level your own looks live in memory and go when Prompt Maker stops (the row says so).

**How adventurous** (in step ⑤ → Writing & more steps; the Brain's *temperature*, the number beside the slider) runs from 🎯 *precise* to 🌶️ *wild*. Lower values stick closely to your words, higher values get more inventive. Each model sets its own default.

**Prompt length** (in step ⑤ → Writing & more steps; *short / medium / long*) means something different for each model. For example, "medium" is about 70–120 words for Krea and about 160–260 for MiniMax. Every take shows its word count against that target.

**Every detail of your idea stays in the prompt.** The Brain is told to keep every fact you typed (who and how many, colors, clothes, objects, place, time, weather, what happens, quoted words) and to add detail only where you said nothing. After each take, one more short Brain call checks it against your idea; if a detail was changed or dropped, it is put back and the take says so under the text: *✓ Checked against your idea* or *✎ Put back: a red dress, two dogs*. Saved prompts shows the same on the card. A refine is checked too (what you asked to change isn't a lost detail). Switch it off under **Settings → 🧠 How the Brain thinks** if you'd rather save a few seconds per take.

**Keep it tidy:** every step on Create, every card in Settings and Models, and every take folds down to a one-line summary. Click its header or the ▾ button; Prompt Maker remembers what you folded. The technical parts start folded: in Settings the server addresses, how the Brain thinks and the master instructions; on a model's page its instructions, sizes, defaults and lengths. Step ⑤ Settings starts folded; seed, LoRAs and the sampler settings live under step ⑤ → Render → **Advanced**.

**Nothing jumps.** On a wide window the steps and your takes sit side by side and each scrolls on its own, so new takes and renders never move the steps. While a take is being written, its buttons are already there, greyed out, and so is the tile for its render when auto-render is on; nothing below moves when the take is done. Fold a step or a take and the header you clicked stays where it is: the space it freed sits at the end until you scroll back up. A running job's bar (from the assistant) sits above the takes. The box of a take is held at the height its prompt is expected to need from the first word (from the model's length target), its word count's row is there from the start, and a refine keeps the box at least as tall as it was, so nothing under a take moves while it's written or rewritten.

### Voices

<img src="screenshots/voices.png" alt="The Voices page before the one-time setup: what it needs, about 9 GB downloaded once, and the Install voices button" width="900">

The **🎙 Voices** page makes speech on this computer, so the same person can say every line of a video in the same voice.

- **One-time setup.** Click **⬇ Install voices**: Prompt Maker fetches two speech models ([Qwen3-TTS](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base), Apache 2.0, about 9 GB) into its data folder and sets up the few packages they need, beside ComfyUI's own Python. ComfyUI's packages aren't changed, so nothing there can break. After that, voices work offline. A graphics card makes a line take a few seconds; without one it still works, slower.
- **Describe a voice** in plain words (age, warmth, accent, pace, mood), give it a sentence, and **▶ Hear it**. Not it? Change the words and hear it again. Right? Name it and **💾 Keep this voice**. No real person is cloned: the voice is made from your description.
- **Your voices** are listed with their description. **▶ Sample** plays the sentence they were made with; type any line in **Try a line** and **🗣 Say it** on a voice to hear it. **✏** renames, **🗑** deletes (it asks once).
- **In a video** ([MiniMax H3](#target-models)): step ③ shows **🎙 Says a line**. If the picked workflow takes no line but one of the model's does (or the one that comes with the app), it offers **🎙 Use the one that does**: one click adds and picks it; the assistant's `set_line` does the same by itself. Then: pick the voice, write the line word for word. When you create, the line is said in that voice and the Brain writes the take around it; at **Render** the clip is the video's soundtrack, so the person in your picture says exactly those words, lips in time, and the video is made at least as long as the line. The line is saved with the prompt (Saved prompts puts it back; the full-screen view shows *Says*). A take with no line renders as before: the sound nodes are simply left out.
- **The assistant does it too:** *"make a new voice called Sam: a deep, calm narrator"* (`make_voice`), *"make her say 'Hello there' in Sam's voice"* (`set_line`). In a job, a `set_line` step before `generate` gives each cut its line, so a whole promo can run overnight: stills, the pick, the line, the video, the judge.
- **Where it lives:** `voice/` in your data folder: the packages (`site/`), the models (`hf/`), your voices (`voices.json`) and their clips (`clips/`). Delete the folder to start over.

### Same person, every render

Two models keep the person in your picture instead of repainting the picture: **Krea 2 Character** (pictures) and **MiniMax H3 Reference** (video clips with sound, MiniMax's *ref2va*). Your picture only tells them *who*: the place, clothes, pose, camera and light come from your theme. There is no denoise to set.

- **🧾 Character sheet.** Pick one of the two models and add a picture in step ③: a **Character sheet** box appears under it. When you create, your Brain (one that sees images 👁) looks at the picture and writes the person's traits, one per line: age, face, eyes, eyebrows, nose, lips, skin, hair, facial hair, build, height and marks (freckles, moles, tattoos). Then every take carries **all** of them, in the sheet's words; a trait the Brain leaves out is added back by the app. It's saved with the prompt in Saved prompts.
  - **Fix a line** by typing in the box (the Brain got the eye color wrong, say): the next prompt uses your sheet as it is.
  - **↻** writes a fresh one from the picture next time you create. A new picture starts a new sheet.
- **🪪 Turnaround** (Krea 2 Character): one click renders the person on a plain background from the front, three-quarter, side and back, with a close-up of the face, and when it's done it becomes your picture in step ③ (the sheet stays). From then on every render reproduces them from all sides, and a full-body turnaround also lets the sheet name their build and height. It uses the workflow that comes with the model (or yours) in step ⑤.
- **The workflows that come with these two models**:
  - **Krea 2 Character**: Krea 2 Turbo with the [Krea 2 Identity Edit](https://huggingface.co/conradlocke/krea2-identity-edit) LoRA, 10 steps, its likeness dial at 4. It needs the [comfyui-krea2edit](https://github.com/lbouaraba/comfyui-krea2edit) nodes (in ComfyUI: **Manager → Install Missing Custom Nodes**). The LoRA is under the Krea 2 Community License.
  - **MiniMax H3 Reference**: ComfyUI's own reference-to-video template, with one reference picture and 20 steps (its optional 4-step turbo LoRA left out, so nothing extra to download); only ComfyUI's own nodes.
- **Good to know:** the likeness holds best for faces whose identity is in their texture (freckles, marks, hair). Very unusual face shapes drift toward typical ones. A change of outfit sometimes lets a bit of the old one through: re-roll, or say the new outfit plainly in your theme.

### Character animation (Wan Animate 2)

[Wan Animate 2](https://github.com/Wan-Video/Wan-Animate-2) makes a **character image** perform the moves of a **motion video**: a dance, a walk, a fight scene. The character keeps its look from the image, the moves come from the video, and the **setting, light and camera angle come from your theme**. Pick **Wan Animate 2** in step ① and step ③ becomes **Character & motion**:

- **🧍 Character:** drop, paste or pick an image, like any image. A clear, full shot of one character works best.
- **🕺 Motion video:** drop a video on the page, **browse**, or **🎞️ Pick a video from your Gallery** (any video you rendered). MP4, WebM, MOV and MKV work, up to 500 MB. It plays in step ③.
  - **The clip takes your character's shape**, as in Wan-AI's own code: **Aspect** (step ④) follows the character image, and ComfyUI crops the motion video to it at the center. (Until you add a character, Aspect follows the video.) When the two differ a lot, step ③ says which sides of the video get cropped: keep the moves near the middle, or use a character image in the video's shape.
  - Frame it like your character: full body to full body. A close-up character with a full-body dance (or the other way round) is the most common cause of a bad result.
  - **⬛ Black bars** (a webcam or screen recording inside a wider frame, a letterboxed film) would count as part of the video. Step ③ spots them and offers **✂️ Crop the bars**: a copy with just the picture, sound kept.
  - **✂️ Trim** (under the video) uses just part of a long video, cut to the frame, in a big window of its own:
    - **The frame at the playhead** fills the window, with its time and number below it (*0:05.92 · frame 72 of 1159*).
    - **The timeline** is a strip of the video's frames. Press and drag anywhere to move the playhead. The part you keep is lit between two handles, and the rest is dimmed: drag a handle to move the start or the end, and the frame it lands on shows as you go.
    - **Step one frame** with **‹ frame / frame ›** or `←` `→` (`Shift` for a second).
    - **⇤ Start here** (`I`) and **End here ⇥** (`O`) mark the frame you're looking at, or type the times. It says how many frames the part is.
    - **▶ Play part** (`Space`) plays just that stretch, over and over.
    - It starts out as the whole video, or as long as the picked workflow animates when that is less. **✂️ Use this part** swaps in a copy of just those frames, sound kept.
  - The video's length, size and frame rate and its buttons sit in a bar under it, so nothing covers the picture.
  - The clip is as long as the video. Step ③ shows its length, shape and frame rate. Wan Animate 2 uses the frames one for one, so above 30 fps (many phones film at 60 or 120) the moves would play too fast and take longer to render: Prompt Maker renders from a 24 fps copy instead, made for the render and shredded after it. Your video itself stays as it is.
  - **Phone videos (H.265/HEVC)** often don't play in the browser. ComfyUI uses them as they are; for the page, Prompt Maker makes a small upright preview, so you still see it, Aspect still matches it, and the Brain still sees the moves. The preview, the 24 fps copy for rendering and the crop need [ffmpeg](https://ffmpeg.org) on this computer (most Linux systems have it). Without it, the video still renders; the Brain then goes by your theme for the moves.
- **② The theme** says where the character is and from where the camera sees it: *"on a rooftop at dusk, low angle, three-quarter view"*. Leave it empty and the Brain picks a setting that suits the character.

**What the Brain writes.** The prompt is in Wan Animate 2's own format: a `Character appearance description:` line (looks only: no actions or emotions), a `Background description:` line (the place, the light, the camera), and a `Motion:` line naming the moves. A 👁 vision Brain sees your character and a **contact sheet of the motion video** (6 frames in order, with their times), so it describes the character faithfully and names the motion from the video. A text-only Brain still works: it goes by your theme.

**Rendering it.** In step ⑤, click **＋ Add workflow**. **⭐ ComfyUI's templates for Wan Animate 2** come first, straight from your ComfyUI (update ComfyUI if they're missing):

| Template | What it does |
|---|---|
| **Wan Animate 2: Motion Transfer** | The full model with the LightX2V LoRA (6 steps). It follows the whole motion video, however long, in 81-frame pieces. |
| **Wan Animate 2 Distilled: Motion Transfer** | The distilled model (10 steps). Also the built-in workflow. It makes 81 frames at a time and Prompt Maker chains them to follow the whole motion video. |

Prompt Maker sets them up for you: the look and setting go to the prompt, the **Motion** line to the pose prompt, your character to *Load Image*, the motion video to *Load Video*, and the size from step ④. It also **fixes a mistake in ComfyUI's template**: its pose window starts and ends at 0, which leaves the motion video unused; Prompt Maker sets the end to 1.0 and says so in the setup. The templates also save a side-by-side of the render and the motion video; Prompt Maker leaves that out, so only your render lands in the Gallery. While a long video renders in pieces, the progress line says which piece it's on (*piece 3 of 15*), and the percentage counts the whole render.

**How much of the video.** The clip follows the whole motion video. The Distilled template makes 81 frames (3.4 s at 24 fps) in one piece; Prompt Maker adds pieces like it, each carrying on from the last frame of the one before and reading the video from where that one stopped, and cuts the last piece to what's left. A long video takes a while (a minute of video is about 18 pieces), so use **✂️ Trim** in step ③ to pick the stretch you want. A workflow of your own that makes a fixed stretch and can't be chained: step ⑤ says how much it makes, and which of your workflows does all of it.

Your own Wan Animate 2 (or SCAIL) workflows work too, from ComfyUI or a file. One that **renders in pieces** (copies of the same part, each making the next stretch of the video) gets the same prompt and size in every piece, and if it also saves its first piece on its own, only the full video is kept. The setup says so.

**Whose background.** A SCAIL 2 workflow can keep either background, and step ③ shows a **Background** choice for it, under your motion video: **🖼️ From your picture** brings your picture to life (its character moves like the person in your video, its background stays), and **🎬 From your video** puts your character in place of the person in your video (the video's background stays). It starts at the workflow's own setting (a *character replacement* workflow keeps the video's), and your pick stays with the workflow. (Wan Animate 2's own templates keep neither: their background comes from the prompt's *Background description* line.)

**Any length.** A workflow built as a chain of pieces (SCAIL 2's *Base* + *Extend*: 81 frames each, every next piece carrying on from the last 5 frames of the one before) makes only as much as it has pieces, about 6.5 s for two. Prompt Maker adds pieces like the last one, as many as your motion video (or the part you trimmed) needs: a 48 s clip at 24 fps takes 16. Each new piece carries on from the one before, they're all joined into one video, and the model and LoRAs are loaded once for all of them. Up to 50 pieces (about 2½ minutes at 24 fps).

**Long videos say how far they are.** A video made in pieces shows which piece it is on (*piece 2 of 5*) and one percentage for the whole render, instead of jumping to 100% with every step. The size shown for a render is the size it really came out at. If the motion video's sound is shorter than the video, the video keeps its full length and the rest is silent.

**Long videos don't run out of memory.** ComfyUI saves each piece as its own short video, and Prompt Maker joins them into one, with your motion video's sound (the progress line says *Joining the pieces into one video…*). Joined inside ComfyUI instead, a long video needs a lot of memory all at once right at the end (13 GB more for 35 pieces), and ComfyUI could be shut down for running out of memory just as the render finished. Joining needs ffmpeg; on a computer without it, ComfyUI joins the pieces as before.

**Models it needs.** Each template needs five model files in ComfyUI (the Wan Animate 2 model, a LoRA, the text encoder, a CLIP vision model and the VAE). If your ComfyUI lacks one, step ⑤ names it and where it goes, with **⬇ Download** (see [Missing models](#missing-models)). A file that sits in a subfolder (`checkpoints/wan-2.1/sam3.1….safetensors` where the workflow says `sam3.1….safetensors`) is found there on its own.

The setup's **🎛️ Sampler** settings add Wan Animate 2's own controls:

| Setting | What it does |
|---|---|
| **Pose strength** | How strongly the motion video drives the moves. 1 is as trained; lower loosens it, higher follows it harder. |
| **Pose start / Pose end** | When, in the sampling steps (0–1), the motion video counts. An end around 0.7 keeps the moves but loosens fine detail. |
| **Character strength** | How closely the character keeps the image's look. Below 1 lets the prompt restyle it (a new outfit); above 1 holds it tighter. |

**From a render.** In the lightbox, **🧍 Animate as a character** sends a still to Wan Animate 2 as the character, and **🕺 Use as motion video** sends a video render as the moves. A chain can do it too: a **Then** step on Wan Animate 2 uses the still before it as the 🧍 *character* and the motion video in step ③.

The motion video is kept with the take (Saved prompts puts it back), and deleting the Saved prompts card deletes it, here and in ComfyUI.

### ✦ The assistant

<img src="screenshots/ask.jpg" alt="The optional Assistant panel beside the Gallery, ready to help with your artwork" width="900">

Your creative partner, ready when you need it: **✦ Ask** in the top bar (or **Ctrl+K**) opens or closes it. It starts closed and remembers your choice. The page takes the room beside the panel; when Create becomes one column, **Create / Results** keeps either workspace one click away. The top bar's menus (Brain, 🎨 Rendering) open over it. It runs on your **Brain** (the same LM Studio model, so it stays offline):

- **As big as you like.** Drag the panel's left edge to make it wider or narrower, as far as the whole window; **⤢** in its header fills the window in one click, and **⤡** puts it back at the side. The message box grows as you write, and dragging the little bar above it makes it as tall as you want. A double click on either edge goes back to normal. Your sizes are remembered.
- **Ask what it thinks.** *"Which of these renders do you like better?"*, *"Should the princess be in the high tower or the dungeon?"*, *"Based on this prompt, what aspect ratio should it be?"* It gives a real opinion with a reason, and offers to act on it.
- **It sees.** It looks at renders (and frames of videos), the image in step 3, the lightbox, 🎞 Your renders, the Gallery, and pictures and videos in any folder on your computer. The chat shows a 👁 strip of what it looked at. Seeing needs a 👁 vision Brain; the pictures are never saved, only their names.
- **Show it a picture.** Paste a picture into the message box (or drop one on it): it shows above the box until you send, with ✕ to take it out, and goes with your message (*"what do you think of this?"*, *"set up a shot like this one"*). Up to 8 at a time; shrunk to 768 px for the Brain.
- **📋 Copy any reply.** Every reply has a copy button in its corner.
- **It follows ✍️ your own prompt.** While that switch (step ②) is on, what the assistant puts in step ② is sent word for word and rendered, the same as when you click; it knows this, and only you can switch it.
- **It finds your work.** *"Check out the renders of the woman walking around her apartment"*: it searches every render you ever made by the words of its prompt (typos are fine) instead of only the newest. *"They're in my renderings folder"*: it finds a folder by its name or one close to it ("renderings" finds "renders"), first Prompt Maker's own renders folder and ComfyUI's output, then anywhere in your home folder and on your other drives (USB sticks, a second disk). It can look for any file or folder by name too, and looks before it asks you where something is.
- **💻 Let it use your computer (opt-in).** Switch on **Settings → ✦ Assistant → 💻 Let the assistant use my computer** and click **Save settings**, and it can also work outside Prompt Maker: run programs and commands (*"open these in GIMP"*, *"make a folder Best of October and copy my excellent renders into it"*), and read and write any file. It doesn't ask each time, except before anything that may delete, move, copy over or replace a file, however the command is written (`/bin/rm`, inside `bash -c "…"`, `> file`, code handed to Python or PowerShell), and before a command that talks to Prompt Maker itself: it shows you the command and waits for **▶ Run it**. Off by default; only you can switch it (the assistant can't press that switch), and only the app on this computer can use it.
- **It knows what you're looking at:** the takes on screen (their full text), the render open in the lightbox, this session's runs and their ratings, renders in progress.
- **Tell it what to make.** *"Set up a 9:16 Krea shot of a surfer at golden hour, 2 takes, film grain LoRA at 0.6, then render them."* Or *"use seconds 12 to 15 of the motion video and crop its black bars."*
  - It runs the app with the same controls you have: model, theme, dials, workflow, sampler settings (steps, CFG, sampler, scheduler, denoise), LoRAs, seed, takes, renders, refining, animating, motion videos (trimmed, cropped, 24 fps) and characters (Wan Animate 2), chains, Saved prompts, playbooks, ratings, the lightbox, cancelling renders, the Brain, and settings (adult content, thinking, top-p, max tokens, ComfyUI cleanup).
  - **And anything else on screen.** It reads what the app is showing (every page, dialog, fold and setting) and presses, types and picks there like you do: *"make a batch called Hero shots, 6 images, a different prompt each"*, *"add my ComfyUI workflow z_image_base to Krea as a second workflow"*, *"set the LM Studio address and save"*, *"start ComfyUI"*. Pressing anything that deletes or removes asks you first.
  - **It picks the best for you.** *"Pick the best render for a winter poster and use it as the reference"*: it looks at them, says which and why, and puts it in step ③ (as a reference, the first frame of a video, or the character).
  - Each step shows in the chat ("✓ Model → Krea 2 RAW") and on screen.
  - **■ Stop** or **Esc** stops it.
- **🗂 Give it long jobs.** *"Use the 4 pictures in folder ABC to do 2 takes each, the first with low temperature, the second with high. Skip any problems and log them for me to review later."*
  - **Jobs judge as they go.** A job can pick the best of what it has made so far and carry it on (animate it, or make it the character), and change sampler settings between renders. *"Generate 8 images with Krea of a woman in a noir coffee shop, a different prompt each, same seed. Then pick the best for 'a stranger sits down next to her' and make 4 MiniMax videos of it, steps from 20 down to 10."* becomes one job: 8 stills, the pick, then the video at 20, 17, 13 and 10 steps.
  - **🎬 Join videos.** In 🎞 Your renders (or the Gallery), show the videos you want (filters, drag them into order) and click **🎬 Join N videos**: they become one video, in that order, as a new render (*Joined video*) that lands in the grid like any other, with its own stars. Clips of different sizes are padded to the first one's; a clip without sound gets silence. The assistant and jobs do it too: *"join the videos shown"*, or as a job's last step `join_videos` takes the best video of each run (the highest rated, else the newest), in the runs' order, so a job ends with one film of its cuts. Needs ffmpeg.
  - **Jobs rate while you sleep.** A pick can also rate the winner (★ to ★★★), and look only at what the current run made, so every scene of a job gets its own best. *"…and rate every video of each run for 'her face matches the still, the sign is spelled right'"* rates each render of the run ★ pretty good, ★★ very good or ★★★ excellent, and hides a clear failure (a warped face, garbled text) from 🎞 Your renders: nothing is deleted, the hidden filter shows it again, and the log says why. Renders you rated yourself keep your rating. The Brain sees a video as a few still frames, so it can't judge sound or lip sync. It works in chat too: *"rate the renders from the Promo job"*.
  - It looks in the folder (a full path, `~/…`, or just its name, found anywhere in your home folder or on your other drives), plans the job, and starts it. The job then runs **on its own**, one item after another, while you do other things. Its tools don't pull you back to Create.
  - Anything that fails is **skipped and logged**, and the job goes on. If the same thing fails 3 times in a row (LM Studio off, ComfyUI down…), it pauses so you can fix that first.
  - **🗂 Job** in the top bar shows progress (item 3 of 8). On Create, a strip says a job is using the page: changes you make there go into it. You can leave Create and come back any time: the job's steps don't pull you back, and the **Create** tab always answers your click.
  - The **Jobs** window has each job's log: ✓ done or ⏭ skipped (with why), the picture (click it to look closer), **👁 View** for what it rendered and **↗ Open** to bring it onto Create. **Only the skipped ones** filters the log, and **↻ Retry skipped** tries them again. You can **⏸ Pause** (after the current item), **■ Stop now**, **▶ Resume** or **🗑 Remove** (what the job made stays in Saved prompts).
  - Jobs survive reloads: each step is saved. If the page reloads or closes mid-job, the job pauses, the item it was on is marked to check, and a toast offers **Resume**.
  - Ask *"how did the job go?"* and it tells you what was done and what was skipped, and why. Once you've seen a finished job's log, the pill goes away; **🗂** in the assistant panel opens the Jobs window any time.
- **It keeps working in a long session.** Only the newest pictures it looked at are kept in the conversation, so asking it to look at renders many times doesn't make the conversation too big to send. A long file or command output keeps its start and its end. If it runs out of room in the middle of a step, it says so (*say "go on"*) instead of showing half a step as text.
- **Long tasks start with a plan.** For anything that takes more than a few steps it writes a short to-do list first, shown as a card at the top of the chat, and ticks the steps off as it goes, so it doesn't rethink the whole task every turn. When every step is ticked it says so and the card goes away. (A thinking Brain thinks a little less while it has a plan.) The very long jobs still go to 🗂 Jobs.
- **When the chat gets long, earlier steps fold into a note.** Before each turn it checks how much the Brain has room for (the context length the model was loaded with in LM Studio, shown on **Models → Brains**). First the details of older steps go, keeping one line each; then the oldest part of the conversation is folded into a short progress note (what you asked, what was done and found, what's left), written by the Brain, and the chat shows *🗜 Earlier steps were folded into a short note to make room*. Your request is kept word for word. The saved conversation shrinks the same way. If LM Studio still answers that the conversation doesn't fit, it folds once more and asks again before telling you.
- **One step at a time.** When a step it asked for fails (a render it couldn't put in step 3, a model name that fits two models), the rest of that step is not run: it looks at what the app holds and goes on from there, instead of generating with the wrong picture. A model name that fits two models ("Krea 2") is an error, not a guess, unless one of them is the model on Create.
- **Videos are asked first.** In a chat, it may start a couple of video renders on its own; more than that in one turn (a third one, four takes of MiniMax, rendering again what auto-render already started) it asks you on screen: **▶ Go ahead** or **No**. Many renders belong in a job, which never asks. It is told when auto-render already rendered the takes it wrote, so it doesn't render them twice.
- **The chat is saved as it goes**, after each step, so a long turn (renders that take an hour) leaves its log even if the page closes in the middle.
- **Deleting asks you first.** It can delete a prompt or a render when you ask, but only after you click **🗑 Delete** in the chat; **Keep it** says no. Any button that asks **Sure?** (↺ Reset to built-in, ■ Stop everything, clearing the line…) is yours to answer too: it asks you in the chat before the second press. A ☁️ cloud Brain still asks you before it's used, and only you can answer that question: the assistant doesn't get its buttons, so it can't click **OK, use it** or **Don't ask again** for you.

The conversation is kept in your data folder; 🧹 clears it. It works best with a model that supports tool calling and vision (Qwen 3/3.5/3.6 VL, Gemma 3+, Llama 3.2 Vision).

Some community fine-tunes come with a chat template that LM Studio can't fill in once the app's controls are sent along ("Error rendering prompt with jinja template"). The assistant handles those on its own: it describes the controls to the Brain in writing instead and reads back what the Brain asks for, so nothing needs changing in LM Studio. It remembers which Brains need this, so only the very first question to such a Brain takes a moment longer, and it reads what they write even when it comes out a little off (in a code block, several steps at once, Gemma's own notation).

### Refine and versions

- Type a change in **Tweak it…** and press Enter, or tap a chip like ✂️ *Shorter*, 🎞️ *More cinematic* or ⚡ *More dynamic motion*.
- **The same change for every take:** with two or more takes, the **🔁 All 4 takes** bar above them takes one change ("give her a red umbrella") and refines each take with it, one after the other. Each take gets it as its own new version (and its own render, if auto-render is on). ■ Stop ends it; takes already done keep the change.
- **Tweak while it's still writing.** The *Tweak it…* boxes (and 🔁 All takes) are never locked: type or paste your change while a prompt is being written, a batch renders or a chain runs, and press Enter. The tweak is *lined up* (its box gets a dashed edge) and runs as soon as what's cooking is done, before the next prompt waiting in line. **✕ Take it out** in the toast cancels it. A take still being written can get a tweak too: it runs once the take is there.
- Every refine adds a version. Page through them with **‹ ›**.
- You can edit a prompt by hand. Click **💾 Save edit**, or page away and it's saved automatically.
- **＋ Add a take** (above the takes) writes one more for the set: the same idea, picture, look, line and dials, different from the takes already there. It lands at the end, numbered on, and is saved on the same card.
- **🗑 on a take** deletes that take and its renders for good (the same warning and shredding as a deleted card; afterwards it asks *Sure?* on the take itself). The other takes keep their order. Deleting the last take deletes the card. A take that is still rendering is cancelled first.
- **Stop** (■ or `Esc`) cancels a run but keeps any takes that already finished. Runs waiting in line (see [Queue](#create)) carry on.

### Saved prompts

**Prompts** in the top bar. Every prompt you write is saved automatically:

- **Each card shows its whole picture or video**, uncropped, small enough to see many at once. When several prompts start with the same words (a pasted template, "For the target video, at 0.00 seconds…"), the title skips them and starts at the word where they differ, after an "…"; hover it for the start.

- **Find things:** search themes and prompts, filter by model, or show only **Bookmarks**. The bookmark saves a prompt for reuse; stars in Gallery rate artwork.
- **Pick up where you left off:** click a card to reopen it exactly as it was made: model, theme, image and its role, aspect, resolution, duration, length, temperature, takes and batch, plus how it was rendered (workflow, renders per take, seed and seed mode, LoRAs and their strengths, sampler settings). Keep refining, or write and render again the same way. The card that's open on Create is ringed in Saved prompts, which scrolls to it.
- **Delete several at once.** **Ctrl**-click (**⌘** on a Mac) the cards, **Shift**-click to take every card up to the one you click, or drag a box across them from an empty spot (or with **Ctrl** held, from a card). Picked cards get a ✓ and a bar at the bottom says how many; **🗑 Delete** (twice: *Sure?*) or the **Delete** key deletes them all the way one Delete does, with one **↶ Undo** for all of them during the 8 seconds. **Esc**, **✕** or a click on an empty spot lets go; **Ctrl + A** picks every card shown.
- **Delete gives you a few seconds to undo, then it's for good.** The first time, **Delete** opens **Delete it for good?**, which says what goes; tick **Don't show this again** and from then on it's **Delete**, then **Sure?** (**Settings → 🔒 Privacy check → Show it again** brings the warning back) (it says so when rated renders go too; a double click only asks, it doesn't confirm). Either way the card stays in place, dimmed, for 8 seconds with **↶ Undo** on it and in the toast, both counting down the seconds left; a render deleted from the full-screen view works the same way: the render is greyed out wherever it shows (the full-screen view, 🎞 Your renders, the Gallery, its take), with the seconds left and **↶ Undo** on it. After that, or when you close the page, it's gone. Deleting a card removes its prompts, its input image and motion video (unless another card, or a prompt waiting in line or being written, uses the same one), the clip of its spoken line, and its renders, along with ComfyUI's copies of them: the files in its output folder, the image and clip uploaded to its input folder, and the job (with your prompt in it) in ComfyUI's history. A render you made yourself in ComfyUI with the same prompt is yours and stays. If the Create form still shows the deleted card's theme, picture or motion video, it lets go of them too. Quotes of it in the assistant chat and in jobs become "[deleted]", and so do the lines in LM Studio's own server logs that quote the request and the answer, and any line in ComfyUI's log that names one of its files (both unless you switch that off in [Settings](#settings); LM Studio keeps those logs in its `.lmstudio/server-logs` folder, and when it runs on another computer, the toast says its logs there are out of reach). A video made from a deleted still keeps its own frame but loses the link and the still's prompt. On start-up, Prompt Maker also removes any render, image or video no Saved prompts card uses anymore; a picture or motion video still waiting in the Create form is never one of them.
- **Shredded, not just removed.** Every file a delete takes (renders, pictures, videos, clips, ComfyUI's copies, and the copy of Saved prompts from before the delete) is written over three times, with zeros, ones and random bytes, each pass put on the disk before the next, then given a meaningless name and removed: the three passes of the DoD 5220.22-M wipe, so a recovery tool finds nothing. Honest limit: an SSD, and a file system that keeps old copies of blocks (Btrfs, ZFS, APFS), may hold the old bytes somewhere no program can reach; full-disk encryption covers that.

### Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl` / `⌘` + `Enter` | The main button: write the prompt or make the image or video (while one is cooking: queue the next) |
| `Tab` (first press) | **Skip to your results**: jumps past the steps |
| `←` `→` on the model cards | Move between models (they are one Tab stop) |
| `Esc` | Stop the current run (when a dialog, a menu or the assistant has it, it only closes that) |
| `Enter` (in *Tweak it…*) | Refine that take (in 🔁 All takes: every take); while something cooks, it lines up |
| `Ctrl` / `⌘` + `V` | Paste an image |
| `Ctrl` / `⌘` + `K` | Open or close the assistant |
| `←` `→` (full-screen view) | The render before or after |
| `1` `2` `3` (full-screen view) | Rate it ★, ★★ or ★★★; `0` takes the rating off |
| `Shift` + `←` `→` on a render card | Move the card in 🎞 Your renders or the Gallery |
| `Ctrl` / `⌘` + click, `Shift` + click on a render card | Pick several in 🎞 Your renders, the Gallery or Saved prompts; `Delete` deletes them (8 s to undo), `Esc` lets go |

## Rendering with ComfyUI (optional)

Prompt Maker is great on its own. If you run [ComfyUI](https://github.com/comfyanonymous/ComfyUI), it can also **render** your prompts, using your own workflows on your own GPU.

### 1. Attach a workflow to a model

**Every built-in model already has one.** The first time you open Prompt Maker, each of the eleven models gets every workflow that comes with it (listed below), so you can **▶ Render** right away; step ⑤ offers **⬇ Download** for any model file ComfyUI doesn't have yet. A workflow that arrives with an update is added the same way, next to the ones you have. Each is added once: delete it and it stays gone (**＋ Add workflow → 🎁 Comes with Prompt Maker** brings it back).

**To use your own instead**, add it as below: a workflow you add is the one the model uses from then on, and the picker in step ⑤ (or on the take) switches between them.

| Model | The workflow that comes with it |
|---|---|
| **Krea 2 RAW** | Text to image: Krea 2 RAW with Krea's turbo LoRA, 12 steps, about 1.5 megapixels. |
| **Krea 2 RAW Edit** | Image to image: the same, starting from your picture. |
| **Z-Image Turbo** | Text to image: ComfyUI's Z-Image Turbo template, 8 steps, no guidance. |
| **Qwen Image Edit** | ComfyUI's Qwen Image Edit 2509 template with its Lightning LoRA, 4 steps; the result keeps your picture's size. Two more optional slots take pictures to bring into it (a product, a person, a style). |
| **Krea 2 Character** | Krea 2 Turbo with the Krea 2 Identity Edit LoRA v1.2, 10 steps ([more](#same-person-every-render)). Needs the comfyui-krea2edit nodes. A second one, **Krea 2 Character: into your picture**, takes two pictures: the **Place** (the picture the person goes into: its setting, light and framing stay) and the **Person**. |
| **LTX 2.3** | ComfyUI's LTX 2.3 image-to-video template: two passes with the distilled LoRA and a 2× upscale, with sound. Its own prompt writer is taken out, so your prompt is used as written. |
| **LTX 2.3: video from words** | The same, from ComfyUI's text-to-video template: the clip comes from your prompt alone, no picture. |
| **MiniMax H3** | ComfyUI's MiniMax H3 image-to-video template, 20 steps, with sound (its optional turbo LoRA left out), plus a Load Audio → Add Guide pair for a [🎙 spoken line](#voices); without a line those two nodes are left out. |
| **MiniMax H3: video from words** | ComfyUI's MiniMax H3 text-to-video template, 20 steps, with sound and the same 🎙 pair: no picture needed. |
| **MiniMax H3 Reference** | ComfyUI's MiniMax H3 reference-to-video template, 20 steps, with sound. An optional second slot takes another picture of the same person, so the likeness holds. |
| **Wan Animate 2** | ComfyUI's Wan Animate 2 Distilled template: your person, moving like the motion video, 10 steps. |

All but Krea 2 Character use only ComfyUI's own nodes.

1. Start ComfyUI as usual. Prompt Maker expects it at `http://127.0.0.1:8188`; change that in **Settings → ComfyUI**. No ComfyUI yet? See [Setting up ComfyUI](#setting-up-comfyui-one-click) below: one click installs it.
2. On **Create**, pick a model (say *Krea 2 RAW*) and click **＋ Add workflow** in step ⑤. (Or do it in **Models**, which lists every model's workflows.)
3. Choose where the workflow comes from:
   - **🎁 Comes with Prompt Maker** shows first: the workflow the app has for the model. Click it and it's set up: where the prompt and your picture go, the seed, the sampler. Step ⑤ offers **⬇ Download** for any of its model files you don't have (see [Missing models](#missing-models)). It shows even while ComfyUI is off.
   - **From ComfyUI** lists every workflow you've saved in ComfyUI. Click one. For some models (Wan Animate 2), **⭐ ComfyUI's own templates** for it come first: one click, and it's set up.
   - **Upload a file** accepts a saved workflow, an *Export (API)* file, or a workflow exported from Prompt Maker.
4. Check the **setup**. Prompt Maker reads the workflow and suggests where things go:

   | Slot | What Prompt Maker puts there |
   |---|---|
   | ✍️ **Prompt** | The take's prompt. It picks the text that feeds the sampler's *positive* input, never the negative. You can send it to several inputs. |
   | 🖼️ **Image** | The take's image, uploaded to ComfyUI (for image-to-image or image-to-video). |
   | 🕺 **Motion** | Character animation only: the take's `Motion:` line (Wan Animate 2's pose prompt). The rest of the take goes to ✍️ Prompt. |
   | 🎞️ **Video** | Character animation only: the take's motion video, uploaded to ComfyUI (a *Load Video* node). |
   | 📐 **Size** | Width and height from the take's resolution and aspect, rounded to a multiple of 8/16/32/64. An *aspect ratio* input gets its closest option. |
   | ⏱️ **Duration** | Seconds, or a frame count worked out from the frame rate (with 8n+1 or 4n+1 rounding for LTX and Wan-style models). |
   | 🎲 **Seed** | A fresh random seed every render, unless you lock it. |

   Anything you don't map stays exactly as the workflow has it. Add as many workflows per model as you like, for example a fast draft workflow and a slow hi-res one. If the workflow loads a model file your ComfyUI doesn't have, the setup says which (see [Missing models](#missing-models)).

5. Tune the **🎛️ Sampler** settings if you like. Prompt Maker shows the workflow's own **seed, steps, CFG, sampler and scheduler** (every sampler in it, two-stage ones included), plus Wan Animate 2's pose and character strengths, and lets you change any of them; **↺** puts a value back.
   - A **CFG of 1 is locked**, because distilled, turbo and lightning models need it. **🔒 unlock** is there if you really mean it.
   - Leave *New random seed every render* on, or turn it off to use a fixed seed.

**Changed a workflow in ComfyUI?** Prompt Maker renders from its own copy, saved when you added the workflow. When you save the workflow again in ComfyUI, Prompt Maker notices (next time you come back to its tab) and shows **↻ Changed in ComfyUI · Update** in step ⑤, on the take's render bar and in **Models**. One click pulls in the new version and keeps your setup: where the prompt goes, the size and seed slots, and your sampler tweaks. If a part of your setup no longer fits (say the prompt node was replaced), the setup opens so you can check it. **↻ Update from ComfyUI** in a workflow's setup does the same any time. Workflows you uploaded as files offer **↻ Update from a file** instead, and a workflow that came with the app offers **↻ Update to this version's**, for when a newer Prompt Maker brings a better one.

### 2. Render

Step **⑤ Settings → Render** on the Create page is your control center:

- **Pick the workflow** your takes render with. Prompt Maker remembers it for each model.
- **⚙ Edit** changes its name, inputs and sampler settings; under **Advanced**, chips show what it will use (sampler, steps, CFG), and clicking them jumps to those settings. **＋** adds another workflow. **Delete workflow** is in the edit dialog.
- **Auto-render every new prompt** sends each new or refined take to ComfyUI as soon as it's written.
- **Renders per take** (×1–×4, just below) is how many renders each take gets on auto-render, each with its own seed, so 2 takes ×3 make 6 renders. Each take's 🎨 Render bar starts from it too. While you build a chain (Then…, in the same step) it is how many renders step 1 makes. It hides while a batch is picked (the batch says how many) and with ✍️ your own prompt (Takes is the count).
- **Batch** (folds open like Advanced) holds your saved batches, for images and videos alike. Each one stands on its own:
  - **a name** you give it, e.g. *Hero shots* or *Explore*,
  - **how many** images or videos (any number up to 50),
  - **🔁 One prompt** (one prompt, rendered that many times with a new seed each) or **🔀 A different prompt each** (that many different prompts, each rendered once).

  **Batch to make** picks what the main button does: no batch, one of your batches, or **all of them, one after another**. Each batch is its own run, with its own takes and its own Saved prompts entry, tagged 🎞 with its name (search Saved prompts by it). The button says what will happen and counts along while it renders. **■ Stop** (or `Esc`) cancels the rest and keeps what finished. **✕** deletes a batch (**↶ Undo** puts it back where it was, and keeps any batch you made or changed in the meantime). While a batch renders, Saved prompts cards can't be opened on Create, so the batch always renders its own takes. While a batch is picked, it decides the number of takes; a chain (Then…) has its own takes and renders, so Batch hides while you build one.

Every take also has a **🎨 Render** bar:

- **The workflow menu** is the same choice as step ⑤; change either one.
- **⚙ This take's settings** opens every knob a render of this take uses, on the take itself: **Shape**, **Size** and **Duration** (step ④'s as it is now, even changed after the prompt was written, unless you change them here; your own typed sizes are in the Size menu too, and picking one brings its shape), the **Seed** (new each render, or fixed at a number), every sampler setting the workflow has (steps, CFG, sampler, scheduler, denoise…) and the LoRAs' switches and strengths (a LoRA you switch or change in step ⑤ shows here at once; one you changed here stays as you set it). What you set here is this take's alone: step ⑤, the other takes and the workflow keep theirs, and the line under the bar says what the take has of its own (⚙ 9:16 · 1080×1920, own sampler settings…). **↺ Same as step ⑤** gives it all back. With a fixed seed and ×2 or more, the seed chip shows the seeds the renders use (🔒 Seeds 4242–4244): the first is your seed, each next one the seed after it, so they differ. A queued prompt, a batch or a chain renders at the size its prompt was written for. Picking another workflow for the take clears its own sampler, seed and LoRA settings (they belonged to the other one). ＋ Add LoRA and the workflow itself stay in step ⑤.
- **×1–×4**: render several at once, each with its own seed. It starts at **Renders per take** from step ⑤. (For more, use **Batch** in step ⑤.)
- **🎲 Random seed / 🔒 Seed**: the seed the take renders with (step ⑤'s, or the take's own from ⚙); click it to change it for this take.
- **▶ Render**: live progress shows on the tile (queue position, node, step, %), with previews if ComfyUI was started with `--preview-method auto`. **✕** cancels.
- **🎨 Render all** does every take in one go.

Click any result to open the **lightbox**, where you can:
- rate it (the stars come first, right under the title) and read its prompt, seed, size and timing,
- watch a video with sound: it plays at the volume you left the last one at (or muted, if you muted it), so you set it once. In ⇆ Compare only the one on the right is heard,
- **⇆ Compare** it with another: it stays on the left while **← →** browse the others on the right, each with its own stars. **Pin on the left** moves the one on the right to the left, so you can work through a set and end with the best. **✕ Stop comparing** goes back to one at a time,
- **download** the file,
- **render again** with a new seed,
- **🎬 Animate this** (see below), or **🖼️ use it as the input image** for your next prompt,
- or delete it.

### Setting up ComfyUI (one click)

<img src="screenshots/comfy-setup.png" alt="The Set up ComfyUI dialog: the graphics card with its driver, the Python it found, where ComfyUI goes, and the Set it up button" width="600">

Without a ComfyUI on this computer, **Settings → Services** shows **⬇ Set up ComfyUI**, and so does *ComfyUI isn't set up* in step ⑤ on Create. One click, and Prompt Maker:

1. **Checks the computer**: your graphics card and its driver, and Python. An NVIDIA card without a driver gets **Install the driver** (Ubuntu's own driver tool, or Debian's package, behind the system's password prompt; then restart the computer). Python's environment tool, when Ubuntu left it out, gets **Install it** the same way.
2. **Fetches ComfyUI** from GitHub into `ComfyUI/` in the data folder (or the folder under **Settings → ComfyUI**, or one you pick with **Change**; an existing folder must be empty, or ComfyUI's own).
3. **Makes its own Python environment** (`venv/` inside that folder), with [uv](https://docs.astral.sh/uv/) and Python 3.12 when uv is on the computer, else the system's Python. Nothing else on the computer is changed.
4. **Installs PyTorch for your card**: the CUDA build for NVIDIA (about 3 GB), the ROCm build for AMD (new, not yet tried on a real card), the small CPU build without a card.
5. **Installs ComfyUI's packages**, then **starts it** and points **Settings → ComfyUI** at it, so ▶ Start, ■ Stop and *Start ComfyUI along with it* work from then on.

Each step shows in plain words, with the last line of what runs under it. Close the dialog and it goes on; Services shows how far it is. **✕ Stop** stops it, and a set-up that stopped (no internet, the laptop closed) **carries on from where it was** next time: what's done is skipped. Model files aren't part of it: step ⑤ offers **⬇ Download** for each one a workflow needs (see [Missing models](#missing-models)).

Linux for now. On Windows and macOS, install [ComfyUI Desktop](https://www.comfy.org/download) and enter its folder in **Settings → ComfyUI**.

### Missing models

A workflow can load a model file your ComfyUI doesn't have yet: a checkpoint, a LoRA, a CLIP vision model… ComfyUI would refuse it. Prompt Maker checks before every render, so nothing is half-done:

- **Step ⑤ says which files are missing** for the picked workflow, and the ComfyUI folder each goes in (`models/clip_vision`, say). A render started anyway stops with the same list.
- **⬇ Download** gets one (or **⬇ Download all**) straight into that folder, with a progress bar. It uses the link the workflow carries: ComfyUI's templates and most shared workflows list a download link for each model. It runs in Prompt Maker's server, so it goes on through a reload; **✕** stops it. As soon as it's done, the notice goes and the workflow renders.
- **Only from Hugging Face**, and only when you click. A link to another site is shown for you to open yourself, and a workflow with no link for a file says so: get it there (or where the workflow came from) and put it in that folder.
- **A file in a subfolder** (the workflow says `sam3.1.safetensors`, your ComfyUI has `wan-2.1/sam3.1.safetensors`) is found there, with nothing to do.
- **ComfyUI skipping part of a workflow** (an output that fails its checks) also stops the render, with ComfyUI's reasons in short. Before, the render ran without its result.

**Missing nodes.** A workflow can also use a node your ComfyUI doesn't offer right now. Most often the node's pack *is* installed but didn't load when ComfyUI started (a Python package broke, a ComfyUI update changed something it needs), and ComfyUI only says so in its log, so a render would just say "Node 'Image Save' not found". Prompt Maker reads that log: step ⑤ names the node, the pack it comes from and why it didn't load ("the pack was-node-suite-comfyui didn't load when ComfyUI started: cannot import name 'ThreadpoolController'…"), with **↻ Restart ComfyUI** for once you've fixed the pack in ComfyUI (Manager → Try fix, or install what it says is missing) and **↻ Check again**. A node no loaded pack has is reported too: install the pack (ComfyUI Manager → Install Missing Custom Nodes), then restart ComfyUI.

**Checked at start, for every workflow.** When Prompt Maker starts (and whenever ComfyUI comes back, and every ten minutes while it runs), every workflow of every model is checked against ComfyUI in the background: nodes it lacks, model files it lacks. A workflow that can't render is marked **⚠** in step ⑤'s workflow list and the notice says why, before you pick it; a toast says so once. **Settings → ComfyUI** lists them all, with **↻ Check again**.

### Seed

Step ⑤ has a **🎲 Seed** row for the picked workflow, with ComfyUI's four modes:

| Mode | What each render gets |
|---|---|
| 🎲 **Random** | A new random seed. The row shows the last one, and **🔒 Keep it** switches to Fixed with it. |
| 🔒 **Fixed** | The same seed every time. (×2 renders in one go use the seed and the seed + 1.) |
| **＋1** | The seed, then one higher each render. |
| **−1** | The seed, then one lower each render. |

- **Type any seed** in the box. **↶** puts back the last render's seed, and **🎲** rolls a new one.
- **The hint says what comes next,** e.g. *Next render: 1000, then 1001…*
- **Each take's render bar shows the mode** (e.g. 🔒 Seed 4211). Click it to jump to the row.
- **In the lightbox,** **🔒 Use this seed** fixes the seed of a render you liked, and **🎲 Render again** always uses a new one.
- **Seeds are saved per workflow,** and renders started together never share one.

### Denoise (image-to-image)

When the picked workflow takes an image and has a **denoise** setting, step ③ shows a **🎚️ How much to change your picture** slider under your image, inside **Picture settings**. Only on picture models: a video model follows your picture as its first frame (or its character) rather than repainting it, so there denoise could only make it render less (at 0 nothing at all: a flat grey clip). Not on Krea 2 Character either: there your picture is the person to keep. It goes down to 0.05, never 0, and a 0 saved earlier renders at the workflow's own value instead. Lower keeps more of your image, higher changes more, and a hint says which. **↺** puts the workflow's value back. It's saved with the workflow, like its other sampler settings.

### LoRAs

Step ⑤ shows the **🧬 LoRAs** of the picked workflow:

- **The workflow's own LoRAs** (LoRA loader nodes, and rgthree's Power Lora Loader) are listed with a switch and a strength slider, −5 to 5. For a LoRA made for more (some go up to 100), type the strength in the box next to the slider: any value goes.
  - **Switching one off** leaves it out of the render entirely, so its file isn't even loaded.
  - **Strength 0 isn't off**: a LoRA left on at 0 still goes in at 0, because some LoRAs change the render even there. Use the switch to leave one out.
  - **↺** puts the workflow's strength back.
- **＋ Add LoRA** lists only the LoRAs for the selected model. Prompt Maker matches the model to its folder in ComfyUI's `models/loras` (e.g. `krea2/` for Krea 2 RAW, `LTX_2.3/` for LTX 2.3). If the match is wrong, pick the folder in the list. Search narrows it down, and the LoRA goes in at strength 1.
- **Added LoRAs go in right after the workflow's model loader,** so there's nothing to wire up in ComfyUI.
- **A workflow that renders in pieces** (like SCAIL 2, where each piece loads its own copy of the same LoRAs) shows each LoRA once, marked *×2 pieces*: its switch and strength set every piece.

- **🆕 A newer version is offered.** When your LoRA folder has a newer release of a LoRA in use (`film_grain` → `film_grain_v2`, `v1.1` → `v2`), its row shows **🆕 v2**: one click uses it, with the same switch and strength (**Undo** in the message; on the workflow's own LoRAs, **↺** goes back to its file). A later training step (`-000800` after `-000600`) is offered the same way, though later isn't always better: compare. **✕** keeps the one you have and stops suggesting that file.
- **A LoRA file that's gone** (you deleted v1 when v2 came out): step ⑤'s missing-files notice offers **Use v2**, the newest version you have, instead of a dead end.

- **The assistant swaps versions too:** *"use the newest film grain"*. When it changes a LoRA, it says if a newer version is in the folder.

Your LoRA choices are saved with the workflow in your data folder. Every render records the LoRAs it used, shown in its lightbox, and each file's size and date (read from the file with ComfyUI on this computer, else from ComfyUI's model list). **A LoRA file replaced under the same name** since a render (you downloaded v2 over v1) is marked *⚠️ file changed since* in that render's lightbox, and opening it from Saved prompts says so: a render now may look different.

### 3. Turn a still into a video

Hover any still you rendered and click **🎬 Animate** (it's also in the lightbox):

- **The still becomes the first frame.** Create switches to your video model (the one you used last) and picks 🎬 *Animate*. The theme box asks **what happens**. Leave it empty and the Brain picks fitting motion.
- **It stays consistent.** The Brain sees the frame and also gets the still's prompt, so people, clothes and places are described the same way.
- **Full quality.** ComfyUI gets the original render file as the first frame, not a re-compressed copy.
- **It remembers where it came from.** The video's results, Saved prompts card and lightbox link back with **⬑ from Krea 2 RAW · take 1 · seed …**.

You'll need an image-to-video workflow (one with a *Load Image* node) on the video model. Step ⑤ warns you if the picked workflow can't take the frame.

### 4. Chains: build your own pipelines

A chain runs several steps in a row, each one continuing from the renders of the step before, like a still that becomes a video. Build it in step **⑤ Settings → Writing & more steps → Then…** on the Create page:

1. Set up step 1 as usual (model, theme, dials, and a workflow in step ⑤).
2. Click **＋ Then…** to add a step. Pick its model, how it uses the image (🎬 *first frame*, *reference* or *recreate*; 🧍 *character* on Wan Animate 2, which also uses the motion video in step ③), **what happens** (optional; empty lets the Brain choose), its workflow, takes and renders, and for a video step its **duration** (a slider, 1 to 20 seconds).
3. **☐ Let AI choose** at the top of the chains section is the one-click version: on, the AI picks the best render at every step (a still becomes the video's first frame) and for steps you add later; off, the chain waits for you to pick. Or, between steps, choose each on its own: **⏸️ Let me pick** (the chain waits while you pick the best renders), **🧠 Brain picks** (the Brain looks at every render and only the best one goes on, so 16 stills and a video step with 2 takes make 2 videos, not 32) or **⚡ Auto** (every render goes on). Brain picks needs a Brain that can see images (👁); if it can't pick, the chain waits for you instead.
4. Click **Run all steps**. The line above it says what you'll get, e.g. *2 stills → you pick → videos*.

While a chain runs, a strip above the results shows every step. Click any thumbnail to see that step's takes.

- **At a ⏸️ step,** tick **☐ Pick** on the renders you like and click **Continue ▶**. Pick several to make one video from each.
- **Change a step while you pick,** for example what happens next. Continue uses the chain as you see it.
- **Stop (■ or Esc)** ends the chain. Finished steps are kept.
- **Reopen a run any time from Saved prompts.** Its cards are marked ⛓. You can send more stills on from it later.

**💾 Save as a chain** keeps your steps, so you can run them again with a new idea. Saved chains show up under the steps, next to the starter chains *Still → Video* and *One still, 3 motions*. **⤒** exports one to share, and **⤓ Import** adds one from a file. A chain from someone else picks your matching workflows by name, or asks you to choose.

> Chains continue from images for now: a video can't feed the next step yet. Extending a clip from its last frame is coming next.

### 5. Your renders and the Gallery

<img src="screenshots/gallery.jpg" alt="The Gallery: every rated render in one grid, with stars, filters and a size slider" width="900">

**🎞 Your renders** is a tab beside the takes on Create. It holds a card for every render you've ever made, from every run and batch, all in one grid, newest first, each with a caption: the first words of the idea it was made from and the model (small pictures keep it for the hover). It keeps them when you reload the page or restart Prompt Maker.

- **Live.** A render shows up the moment it starts, with its preview, progress and **✕ Cancel**, and stays when it's done.
- **Filters**, behind the one **Filters** button over the grid (it counts the ones that are on): Images or Videos, **🕘 This session** (only what you made since Prompt Maker last started), **★ & up**, **★★ & up** or **★★★** or **☆ Not rated yet**, a model, **📅 Today / This week / This month / Older**, the shape (**▯ Portrait**, **▭ Landscape**, **▢ Square**), **🎙 Spoken line** (videos made with one), and, once there's a choice, the **workflow**, the **LoRA** and the **look** they were made with. **Find…** searches the words of the prompt, the model, the workflow, the look, the LoRAs, the seed and the size (type *1920×1080* or a seed number). The count says how many show (*12 of 183*). The filters are remembered, except Find.
- **Arrange them your way.** Drag a card where you want it and the others slide aside to make room: over a card's left half it goes before it, over its right half after it. On a touch screen, hold it a moment first; with the keyboard, **Shift + ←** or **→** moves the card you're on. Your order is saved in your data folder, so it stays. New renders come in first, ahead of the ones you've placed. **↺ Newest first** goes back to newest first.
- **As big as you want.** On a wide window the grid fills the stage beside the steps; on a narrow one, drag the box's bottom edge to make it taller or shorter. **🔍** makes the pictures bigger or smaller, up to one picture as tall as the box. **⛶ Full screen** gives the box the whole window (**Esc** goes back). All of this is remembered.
- **Download or delete several at once.** **Ctrl**-click (**⌘** on a Mac) the cards you want (or click **Select** in the Gallery, then the cards), **Shift**-click to take every card up to the one you click, or drag a box across them from an empty spot (or with **Ctrl** held, from a card). Picked cards get a ✓. The bar at the bottom says how many. **⬇ Download** saves them in your Downloads folder: one picture or video as it is, several as one .zip file (*prompt-maker-12-renders-2026-10-11.zip*) holding each file as it is, untouched; your browser shows the download as it comes. **Delete** (click twice: *Sure?*) or the **Delete** key deletes them for good, here and in ComfyUI. They dim for 8 seconds first, with one **↶ Undo** for them all. **Esc**, **✕** or a click on an empty spot lets go of the selection; **Ctrl + A** picks every card shown.
- **A dragged card is never left hanging.** Let go outside the window, or switch to another program mid-drag, and the card drops where it was.
- **In the Gallery, a hidden one is marked** (dimmed, with **👁 Show** on it), so you can tell it from the others and bring it back there too.
- **Hide from Create** at a picture's top right tidies this grid (**↶ Undo** brings it back). Nothing is deleted; it stays in Saved prompts, Gallery and its take. **Hidden (n)** in the filters shows the ones you hid; **Show in Create** puts one back.
- Hover a card for its prompt, model, take, seed and when it was made. Click it to see it full screen: **← →** browse what the filters show, and **↗ Open in Create** puts its take back on the stage. To close it, click ✕, press **Esc**, or click anywhere in the dark around the picture.

**Rate your renders** so the best ones are easy to find again: **★ Pretty good**, **★★ Very good** or **★★★ Excellent**.

- In the full-screen view, the side panel starts with **▸ Your idea**: the idea the render was made from, folded to two lines; click to read it all (it stays open for the next renders until you fold it again).
- Click the stars on a render in **Your renders** (hover a render to see them), or the buttons at the top of the lightbox's side panel, or press **1**, **2** or **3** in the lightbox. Clicking the rating it already has takes it off (or press **0**). Browsing with a rating filter on (say **★★★**) and you rate one lower, however you rate it (the side panel, the keys, or the stars under the one you browse in **⇆ Compare**): it leaves what you browse and the next one comes up, with **↶ Undo** in case. The one pinned on the left in Compare stays.
- Renders you marked ♥ favorite before ratings count as ★★★ Excellent.

Every render also appears in the **Gallery** tab. It *is* 🎞 Your renders, given the whole page: the same cards, stars, filters, 🔍 size, ⛶ full screen and drag to arrange, with one order shared by both (move a card in the Gallery and it's moved on Create too). The Gallery always shows everything, the renders you 🙈 hid included. The newest render becomes the thumbnail of its Saved prompts card.

- After you close the lightbox, the Gallery rings the render you looked at last, so you don't lose your place.
- **Select → choose two → Compare 2** opens those exact pictures or videos side by side. **Select → choose any → ⬇ Download** saves them all at once (several as one .zip). **Pin on the left** changes the comparison reference; stars rate the work. **Open original prompt** returns to its saved prompt on Create.
- Search stays visible on narrow screens. **Filters** opens the remaining choices and counts active filters; **Clear filters** resets them and the search together.
- Video tiles show a still of their first frame and play while you hover them.
- **🎨 Rendering** in the top bar shows while anything renders, with how many are left. Click it for every render still going, from any take (also ones you moved off the stage, started in another tab, or before a reload): its live preview and progress, **Open** to bring its take back with live tiles, **✕ Cancel**, and **Cancel all**.
- **If ComfyUI crashes mid-render** (it ran out of memory, say, or was closed), the render stops within seconds and says so: *ComfyUI stopped before this render finished*, instead of staying stuck at 0% · Starting… Close other big programs (games especially) and render again. A ComfyUI that is only too busy to answer (a heavy step can do that for minutes) is waited for: the render is given up only after 15 minutes without an answer.
- **Many renders at once don't slow the page.** However many are going, Stop, Cancel, the main button and saving settings answer right away. **✕ Cancel** on a ×2–×4 render also stops the ones that hadn't started yet, whenever you click it.
- **Renders survive a page reload.** A render keeps going in Prompt Maker's server if you reload or close the page; when the page comes back it shows the take again with the render still live. Only **✕ Cancel** on a running tile (or **■ Stop**) stops it. A chain or batch run is steered by the page, though: after a reload, the step that was rendering finishes, but the next ones don't start.
- **And a restart of Prompt Maker.** Restart it (↻ Restart, ⬆ Update, a crash, the computer's service) while ComfyUI renders, and when it's back it picks up every render ComfyUI still has, running or finished meanwhile, and puts each on its take as usual, with its tile and 🎨 Rendering showing it again. What it keeps for that is a short note per render in `rendering.json` (ids and settings, never your prompt), gone once the render is kept. Renders of a ×2–×4 that hadn't been sent to ComfyUI yet aren't sent; render those again.
- **Moved a render out of the renders folder?** (to sort your favorites into a folder of your own, say) It leaves the Gallery, Saved prompts, the takes and the pickers, with no blank tile, even if it's on screen when you move it. Put the file back and it shows again.

> **Tip:** if a workflow runs its own prompt-writing node (an LLM inside the workflow; some LTX workflows have one), Prompt Maker warns you during setup. Its prompt is already written for the model, so you may want that node off.

## Target models

Eleven models come with ready-made playbooks, researched from their official prompting guides (September and October 2026). More are on the way, and you can [add your own](#adding-or-updating-a-model) any time:

| Model | Type | Prompt style |
|---|---|---|
| **Krea 2 RAW** | Image | Dense, literal natural-language captions. Medium and shot first; skin texture and restrained color to avoid the "airbrushed" look. Its example prompts each frame and light the shot differently (from high above, from the floor, through a telephoto lens, film noir), so the Brain doesn't copy one camera into every prompt. |
| **Krea 2 RAW Edit** | Image (image-to-image) | Krea 2 RAW changing a picture you give it: the caption describes the picture as it is, then states the one change you want and what stays. Its workflow (12 steps with Krea's turbo LoRA) comes with the app. Step ③'s **🎚️ How much to change your picture** slider sets how far it goes ([Denoise](#denoise-image-to-image)). |
| **Krea 2 Character** | Image (same person) | Krea 2 with the Identity Edit LoRA: an instruction (*"Create a photo of this woman…"*), every trait of the [character sheet](#same-person-every-render), the new clothes, pose, camera and light, then "Preserve the exact facial identity and body". Its workflow comes with the app. |
| **Z-Image Turbo** | Image | Tongyi-MAI's fast 6B model, 8 steps: one caption paragraph with the medium first, skin texture for realism, and the exact words of any sign or label in quotes, which it renders correctly in English and Chinese. |
| **Qwen Image Edit** | Image (editing) | Qwen-Image-Edit-2509: one short instruction, not a caption: the change, then what must stay ("keep her face and the background"). The person, the product and the layout stay as they are; edited text keeps its font. Its workflow (4 steps with the Lightning LoRA) comes with the app. |
| **LTX 2.3** | Video + audio (from a picture) | One chronological paragraph: shot, subject, action beats, explicit camera, and ambience, sound effects and dialogue woven in. |
| **LTX 2.3: video from words** | Video + audio (from words) | The same prompt style, for a clip that starts from your words alone: step ③ takes no picture. Under **Make a video** in step ①. |
| **MiniMax H3 (Hailuo 03)** | Video + audio (from a picture) | MiniMax's structured shooting-script format (`integrated_multimodal_description` / `overall_soundscape` / `non_diegetic_music`) with `[Shot N]` cuts and `(S1)` dialogue tags. |
| **MiniMax H3: video from words** | Video + audio (from words) | The same shooting-script format, for a clip from your words alone: step ③ takes no picture. Under **Make a video** in step ①. |
| **MiniMax H3 Reference** | Video + audio (same person) | MiniMax's full-reference format (`subject_definitions` / `summary` / `retention_analysis` / `detailed_description` / `overall_soundscape` / `non_diegetic_music`): your picture is `<Subject 1>`, defined once with every trait of the [character sheet](#same-person-every-render). Its workflow comes with the app. |
| **Wan Animate 2** | Video (character animation) | Wan-AI's official caption format: `Character appearance description:` (looks only) and `Background description:` (place, light, camera angle), plus a `Motion:` line for the pose prompt. Takes a character image and a motion video ([more](#character-animation-wan-animate-2)). |

> **Good to know**
> - Krea recommends *Krea 2 Turbo* for everyday generation. RAW is the undistilled base model, mainly meant for training.
> - If you run MiniMax H3 through a host that rewrites prompts (for example fal.ai's prompt expansion), turn that off so the structured format arrives intact.
> - Wan Animate 2 was trained on Chinese captions; the playbook writes English, like ComfyUI's own templates, which its text encoder (UMT5) reads well. It makes no sound: ComfyUI's templates keep the motion video's audio.
> - Each model's sources are listed in its editor.

### Adding or updating a model

<img src="screenshots/models.png" alt="The Models chooser: what each model makes, what it needs, local readiness and a Use this model action" width="900">

The **Models** tab first shows what each model makes, what input it needs and whether its rendering setup is ready locally. **Use this model** returns to Create. **Customize** opens its playbook and workflows; **Customize models** opens the full editor. From there:

- **＋ New model** (or **Duplicate** a similar one), then fill in:

  | Field | What it's for |
  |---|---|
  | **Instructions** | The playbook: prompt structure, vocabulary that works, things to avoid, how to use an attached image. Markdown. |
  | **Example prompts** | 2–4 gold-standard prompts. The Brain copies their *style*, never their content. |
  | **Aspect ratios / resolutions / durations** | The options shown on the Create page. Durations: the first is where step ③'s Duration box starts (the box takes any whole number of seconds, 1 to 20); a video model with none, like Wan Animate 2, shows no box: its clip is as long as the motion video. |
  | **Defaults** | Starting aspect, resolution, duration, length and temperature. |
  | **Length guide** | What *short / medium / long* mean for this model, e.g. `≈70–120 words`. |
  | **Color** | Its accent color in the app. |

- **✨ Draft the instructions from pasted docs:** paste the model's official prompting guide (or a good community write-up) and your Brain turns it into a playbook in the standard format. Review it, then click **Use this draft**.
- **Import / Export:** share models as `.json`. Importing a model with an existing ID updates it, which is handy when someone publishes an improved playbook.

- **Built-in vs. yours:** the playbooks that ship with the app live in `playbooks/` and are never modified. When you edit one, your copy is saved in your [data folder](#your-data) and used instead. **↺ Reset to built-in** drops your copy. If you delete a built-in, a **↺ Bring back** button appears under the model list.

Each model is a single `.json` file (built-ins in `playbooks/<id>.json`, yours in `models/<id>.json` inside your data folder):

```jsonc
{
  "id": "ltx-2-3",
  "name": "LTX 2.3",
  "kind": "video",                       // "image" or "video"
  "description": "One line shown under the model picker",
  "guide": {                             // optional: 📖 How to use this model, in plain words
    "bestFor": "What it's good for",
    "youNeed": "What to give it (a picture? a video? nothing?)",
    "steps": ["Step one", "Step two"],
    "tryThese": ["a theme to try, one click puts it in step ②"]
  },
  "color": "#22d3ee",
  "instructions": "## Prompt format\n- Write ONE flowing paragraph…",
  "examples": ["A complete example prompt…"],
  "aspectRatios": ["16:9", "9:16", "1:1"],
  "resolutions": ["1920×1080", "1080×1920", "1024×1024"],
  "durations": ["6s", "8s", "10s"],
  "defaults": { "aspectRatio": "16:9", "resolution": "1920×1080", "duration": "6s", "temperature": 0.7, "length": "medium" },
  "lengthGuide": { "short": "≈50–90 words", "medium": "≈100–170 words", "long": "≈170–250 words" },
  "sources": ["https://…"]
  // Optional:
  // "imageRoles": ["character"],         the ways the image can be used (reference, recreate, animate, character)
  // "motionVideo": true,                 character animation: step 3 takes a motion video too
  // "comfyTemplates": [{ "name": "video_wan_animate2", "title": "…", "note": "…" }]   ComfyUI templates offered first
}
```

## Choosing a Brain

The **Brain** is the AI model in LM Studio that writes your prompts. Pick it from the **Brain** menu at the top right. Type a few letters to narrow the list (words in any order: `qwen 27` finds *Qwen3.8 27B…*), use ↑ ↓ and Enter, and sort it **Smart** (suggestions first), by **Last used** or by **Name**:

- **👁 vision** models can see images. Text-only models still work for themes, and the app tells you if you try to use an image with one.
- **Bigger follows the playbooks better,** especially exact length and structured formats like MiniMax's. Smaller is faster.

| Your hardware | Good starting point |
|---|---|
| 6–8 GB VRAM, or a 16 GB Mac | Qwen3-VL 4B–8B |
| 12–24 GB VRAM, or a 32 GB+ Mac | Qwen3-VL 8B, Gemma 3/4 12B–27B, Qwen 3.5/3.6 (vision variants) |
| 24 GB+ VRAM | 27B–35B vision models for the best playbook-following |

> **Reasoning ("thinking") models** such as Qwen 3.5/3.6 can spend thousands of tokens thinking before they write. Prompt Maker turns thinking **off** by default (**Settings → 🧠 How the Brain thinks**), which makes them answer in seconds instead of minutes.
>
> LM Studio can only switch thinking off for models it recognizes, mostly the official releases. Many community fine-tunes ignore the switch. Prompt Maker handles those itself: if a Brain starts thinking when Thinking is Off, it stops it right away and asks again with the thinking already marked as finished. It remembers which Brains need this, and hovering over the Brain in the top bar shows it.

### Brain profiles (Models → Brains)

Open **Models** and switch to **🧠 Brains** to see every model in LM Studio. Prompt Maker fills in each card on its own as you work:

- **LM Studio's facts:** size, quantization, 👁 vision, 🛠 tool calling (which ✦ Ask uses), and the room it was loaded with (its context length), which ✦ Ask uses to know when to fold a long chat.
- **Thinking:** how *Thinking: Off* works on it (LM Studio's switch, Prompt Maker's workaround, or it thinks anyway). You can give a Brain **its own Thinking level**, which wins over Settings, e.g. Off for one that rambles and Low for one you like thinking a little.
- **Speed:** seconds per prompt on your machine, from your own runs, plus how often it ran out of room, came back empty or refused.
- **Record:** takes it wrote for image and video models, and how many you rendered or starred.
- **⚡ Quick check:** about 20 seconds. It writes one image prompt and one video prompt and, for vision models, names the colors in a test image. You see the time, word count and whether the prompt needed tidying. It loads the Brain in LM Studio, unloading the model there now, so it only runs when you click it.

Search the cards by name and sort them by **Best fit**, **Last used** or **Name**. **Best for** ranks the Brains for any of your models. Renders and ⭐ count most, then refines, then the Quick check, and failures count against a Brain. The same ranking puts a **Suggested for …** group at the top of the Brain menu on Create, with the reason ("3 rendered"). There are no built-in opinions about model families: suggestions come only from your runs. A newly downloaded model shows up on its own under *Brains you haven't used or checked yet*.

## Settings

Settings is a page of cards: **🖥️ Services**, **⬆ Updates**, **🔌 LM Studio**, **☁️ Cloud Brains**, **🎨 ComfyUI**, **🧠 How the Brain thinks**, **📜 Master instructions** and **✦ Assistant**. The technical ones start folded; click a header to open it. Settings also shows your data folder and the **version** you run (with the exact commit when installed with git); mention it when you report a problem.

| Setting | Default | What it does |
|---|---|---|
| **Start Prompt Maker with my computer** (Services) | On after the first start with the launcher | Keeps Prompt Maker running in the background and turns on LM Studio's server. See [Start it](#4-start-it). |
| **Start ComfyUI along with it** (Services) | Off | ComfyUI comes up with Prompt Maker. |
| **↻ Restart** (Services, on the Prompt Maker row) | — | Stops Prompt Maker and starts it again; the page waits and comes back on its own. Whatever needs a restart to take effect offers it right there: **↻ Restart now to apply** in the Privacy check card after a level change, **↻ Restart Prompt Maker** in Updates after an update. |
| **⬆ Updates** (its own card) | — | Says which version you have and how it was installed. **Check for a newer version** asks GitHub (only when you click: nothing phones home on its own). If there's a newer one, **⬆ Update to x.y.z** gets it in one click: a copy from GitHub pulls it, a .deb install downloads the new package and installs it behind the system's own password prompt; then **↻ Restart Prompt Maker**. A copy downloaded as a folder can't update itself, so the card opens the downloads page instead. |
| **LM Studio URL** | `http://127.0.0.1:1234` | Where LM Studio's server lives. Only this computer or local-network addresses are allowed. |
| **ComfyUI URL** | `http://127.0.0.1:8188` | Where ComfyUI lives (optional, for rendering). Local addresses only. |
| **Privacy level** (🔒 Privacy check card → Change the level) | Safe | Three levels, each a set of the switches below. **Safe**: deletes shred and clean the logs; your work stays in the data folder until you delete it. **Safer**: and ComfyUI's working files and the app window's own files are in memory, swap and hibernation are turned off and the screen locks on its own (it may ask for your password once); your work still stays in the data folder until you delete it. **Nothing stays**: and your work (Saved prompts, pictures, videos, renders, the assistant chat, jobs, your own looks) lives in memory for the session only, gone when Prompt Maker stops; settings, playbooks, workflows, chains, voices and what the app learned stay in the data folder. That last one takes a restart, and the card says so. The dialog also tells you whether the disk is encrypted. |
| **Privacy check** (its own card) | — | What this computer does with your files below the app: whether the system disk is encrypted (chosen when the system is installed; the card says so, it can't switch it on), whether swap is on and in the open (one click turns it off, now and for good), whether hibernation can write all of memory to disk (one click turns it off), and whether the screen locks on its own (one click turns it on, after 5 minutes away). The root steps ask for your password with the system's own prompt. Linux, GNOME for the screen lock; elsewhere the card says what to set by hand. |
| **Keep ComfyUI's working files in memory (RAM), never on disk** | Off | When Prompt Maker starts ComfyUI, its output, input and temp folders are put in memory (`/dev/shm`), so nothing it writes while it works touches the disk, and it's all gone when the computer turns off. Renders are still copied into your data folder. Takes effect the next time ComfyUI starts from here; a ComfyUI you start yourself keeps its own folders. Prompt Maker finds ComfyUI's folders from the options it runs with, so cleanup and deletes reach the ones in memory. Linux only. |
| **Clean up ComfyUI's output folder** | Off | After copying a render into your data folder, delete it from ComfyUI's output folder. Only the exact file just copied is deleted, and only when ComfyUI runs on this computer. The output folder is found automatically; set it if ComfyUI was started with `--output-directory`. Deleting from Saved prompts removes ComfyUI's copies whether this is on or not, so set the folder in that case even with this off. |
| **When I delete from Saved prompts, also clean LM Studio's and ComfyUI's logs of it** | On | On from the start, because deleting is meant to leave nothing behind, and that includes the other apps' logs. LM Studio writes every request and answer to its own server logs, so a deleted prompt would live on there. With this on, a delete replaces the card's words with "[deleted]" in LM Studio's server logs (`~/.lmstudio/server-logs`) and in ComfyUI's log (`user/comfyui.log`, which may name the files a node saved), on this computer only. Off leaves the other apps' logs alone. The assistant's `change_setting` knows it as `log_scrub`. |
| **ComfyUI folder** and **Start options** | found automatically | Where **▶ Start** in Services starts ComfyUI from, and with which options (live previews are on: `--preview-method auto`). |
| **Thinking** | Off | Reasoning effort for "thinking" models: off, low, medium, high, or the model's default. It's the default for every Brain; a Brain can have its own level on **Models → Brains**. |
| **Top P** | 0.95 | Lower is more focused. *How adventurous* (the temperature) is set for each run on the Create page. |
| **Max tokens** | 4096 | The cap on each answer. Raise it if you turn thinking on. |
| **✓ Check each prompt against your idea** (How the Brain thinks) | On | One more short Brain call per take compares it with your idea and puts back any detail the Brain changed; the take says what was put back. |
| **Master instructions** | built-in | Shared rules sent before every model's playbook (output format, faithfulness to your theme…). There's a **Reset to default** button. Until you edit them, you always get the built-in ones of the version you run. |
| **🔞 Adult content** (Master instructions) | Off | Lets the Brain write explicit prompts between adults. A fold shows exactly what it adds to the instructions. |
| **💻 Let the assistant use my computer** (Assistant) | Off | The assistant may run programs and commands and read and write files outside Prompt Maker (see [The assistant](#-the-assistant)). Only you can switch it. |
| **☁️ Cloud Brains** | none | Optional providers you add with your own API key (see [Privacy & offline](#privacy--offline)). |

**Environment variables** (optional):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5317` | Port for the web app. |
| `HOST` | `127.0.0.1` | Interface to bind. ⚠️ There's no login, so don't expose it to a network you don't trust. |
| `PROMPT_MAKER_DATA` | [per-user data folder](#your-data) | Where your settings, history, images, renders, workflows and playbooks are stored. |
| `LMS_BIN` | `~/.lmstudio/bin/lms` | Path to LM Studio's `lms` tool, used by the **▶ Start it** button. |
| `FFMPEG_BIN` / `FFPROBE_BIN` | `ffmpeg` / `ffprobe` | Optional, for motion videos: previews of videos the browser can't play, and 24 fps copies. |

## Privacy & offline

- **It runs 100% offline.** Out of the box, the app talks only to your own LM Studio, and to your own ComfyUI if you render. No cloud provider ships with it.
- **Cloud Brains are your choice.** If you add a provider in **Settings → ☁️ Cloud Brains** (OpenRouter, Anthropic, OpenAI, Google Gemini, xAI Grok, Kimi, DeepSeek, Mistral, Groq, or any OpenAI-compatible service), its models show up in the Brain menu marked ☁️. Before you switch to one, Prompt Maker asks, because what you write with it (your description, any image, the playbook and the instructions) goes to that provider. You can tell it not to ask again for a provider, and bring the questions back any time. Your API keys stay in your data folder, readable by you only, and never come back to the page. The provider list comes with the app; each provider's model list is fetched from the provider only once you've added your key.
- **It refuses anything else.** The LM Studio and ComfyUI URLs must be this computer or a local-network address; internet URLs are rejected.
- **Nothing external loads.** The page's Content-Security-Policy blocks external scripts, fonts and trackers, and the fonts are bundled.
- **Nothing else is sent anywhere.** No accounts, no telemetry, no analytics.
- **Model downloads only when you click.** **⬇ Download** (for a model file a workflow needs, see [Missing models](#missing-models)) fetches that one file from Hugging Face into ComfyUI's models folder. Nothing is downloaded otherwise, and no other site.
- **A render file doesn't give away your prompt.** ComfyUI writes its whole job into every picture and video it saves: your prompt word for word, the model, LoRA and other file names, the seed and settings. Anyone you send the file to could read it. Prompt Maker's copy keeps one thing, the name of the model that made it (a picture's "Model" text, a video's or sound's `model` tag); the pixels and frames are untouched, and the copy as ComfyUI saved it is shredded. Renders kept by an older version are cleaned the same way the first time Prompt Maker starts. Without ffmpeg on the computer, a WebM or sound file keeps ComfyUI's job, and an MP4 loses it but doesn't say the model. ComfyUI's own copy in its output folder still has it: turn on *Clean up ComfyUI's output folder* (Settings) to have it removed.
- **Your renders are private to this app.** Another website open in your browser can't fetch your renders, pictures or videos from Prompt Maker, just as it can't use the rest of the app.
- **How private is yours to choose.** **Settings → 🔒 Privacy check → Change the level** offers **Safe** or **Safer** (your work stays in the data folder until you delete it; Safer keeps ComfyUI's working files and the app window's own files in memory), or **Nothing stays** (your work in memory only, gone when the app stops). See [Settings](#settings).
- **The computer underneath, checked.** **Settings → 🔒 Privacy check** says whether the disk is encrypted, and turns off swap and hibernation and turns on the screen lock with one click each (see [Settings](#settings)). Disk encryption is the one thing it can't do: it's a checkbox in the system installer, and it's what makes a drive that leaves your hands unreadable, old deleted blocks included.
- **Its own browser window.** The launcher opens Prompt Maker as an app window with its own browser profile, so your everyday browser keeps no history of it. That window sends nothing home: the browser's own usage reports (Brave's "privacy-preserving product analytics" and daily usage ping, Chrome's and Edge's usage statistics) and its background checks are turned off before it opens. At Safer and "Nothing stays", that profile is in memory (a browser keeps old copies of what its pages showed in its own files, which a delete can't reach), and the one a lower level left on disk is shredded in the background once the window is open; at "Nothing stays", ComfyUI's console output goes to a file in memory instead of the system journal.
- **ComfyUI can work in memory.** With *Keep ComfyUI's working files in memory* on, ComfyUI's output, input and temp folders live in RAM while it runs, and vanish at shutdown.
- **Deleted means shredded.** Deleting from Saved prompts leaves nothing behind on this computer that Prompt Maker can reach: in its own data folder (the copy of Saved prompts from before the delete included), in ComfyUI (its folders on disk too, from before it worked in memory; uploads of Prompt Maker's that no card uses anymore go when it starts), in the assistant chat and jobs, or in LM Studio's server logs (see [Saved prompts](#saved-prompts)); the files are written over before they go, and renders aren't kept in the browser's cache.
- **Localhost only by default.** The web server binds to `127.0.0.1`, so other devices can't reach it.
- **Protected from websites you visit.** Requests from other websites (cross-site requests) and DNS-rebinding tricks are rejected, so a web page can't quietly drive your local Prompt Maker.

## Your data

Everything personal lives in a per-user data folder, **outside the app folder**, so none of it can end up in git, and updating or re-cloning the app never touches it:

| System | Data folder |
|---|---|
| Linux | `~/.local/share/prompt-maker` (or `$XDG_DATA_HOME/prompt-maker`) |
| macOS | `~/Library/Application Support/Prompt Maker` |
| Windows | `%APPDATA%\Prompt Maker` |

Set `PROMPT_MAKER_DATA` to use another folder. **Settings** shows the folder in use.

```
<data folder>/
├── settings.json   # your settings, including your master instructions
├── history.json    # every generation, its versions and its renders (each .json keeps a .bak copy from before its last save; a delete shreds that copy). At the "Nothing stays" level, this and images/, videos/, renders/, assistant.json, jobs.json live in memory (/dev/shm/prompt-maker-session) instead
├── images/         # images you've used (deduplicated), and the frames the Brain saw of each motion video
├── videos/         # motion videos for character animation (deduplicated), and browser previews of H.265 ones
├── renders/        # images and videos rendered with ComfyUI (move one out and it leaves the app; put it back and it returns)
├── workflows/      # ComfyUI workflows you've attached, with their setup
├── chains/         # chains you saved or edited
├── providers.json  # cloud providers you added, with your API keys (readable by you only)
├── brains.json     # what the app learned about each Brain: thinking, speed, Quick check, its own Thinking level
├── assistant.json  # the assistant conversation
├── jobs.json       # the assistant's jobs: their plan, progress and log (the newest 30)
├── render-order.json # the order you dragged 🎞 Your renders into
├── holds.json      # the pictures and videos your Create page still holds (so tidying up leaves them alone)
├── looks.json      # looks you made (step ② → ＋ Your own look…); at "Nothing stays", in memory with history.json
├── sizes.json      # sizes you typed (step ④ → ✎ Type your own size…), per model; at "Nothing stays", in memory too
├── dials.json      # step ④ as you left it, per model (shape, size, duration, length, how adventurous)
├── rendering.json  # renders sent to ComfyUI and not yet kept (ids and settings only), so a restart picks them up
├── *.json.bak      # each file as it was before its last save
└── models/         # playbooks you added or edited
```

- **The app folder is read-only to the app.** The only playbooks in it are the built-ins in `playbooks/`.
- **Back up the data folder** to keep everything.
- **A damaged file doesn't stop the app.** If a file can't be read (a power cut at the wrong moment, a full disk), Prompt Maker uses the copy from before its last save (`.bak`), so at most your last change is lost. The damaged file is kept next to it as `….damaged-…`, and nothing is tidied away while a damaged Saved prompts is set aside.
- **Upgrading from an older version?** Older versions kept data in `./data` inside the app folder. It moves to the data folder automatically the first time you start the new version; if the data folder already has a Saved prompts, the old one is added to it.

## Troubleshooting

<details>
<summary><b>"Prompt Maker's server isn't running" banner</b></summary>

The page is open but the app behind it stopped. Click **▶ Start Prompt Maker** in the banner (the first time, allow your browser to open Prompt Maker), or open Prompt Maker from your app menu. The page reconnects on its own. If neither is there, run `./start.sh` in the app folder once: it sets both up. To keep it running from now on, switch on *Start Prompt Maker with my computer* in **Settings → Services**.
</details>

<details>
<summary><b>"LM Studio's server is off" banner</b></summary>

Nothing is answering on the LM Studio URL. Click **▶ Start it** in the banner; it runs `lms server start`, which works whether the LM Studio app is open or not. The app reconnects on its own as soon as the server is back.

Keep in mind that **opening** the LM Studio app doesn't turn its server on, unless "start server on launch" is enabled in its Developer tab. **Quitting** the app turns the server off.
</details>

<details>
<summary><b>"… is text-only and can't see images"</b></summary>

The Brain you picked can't see pictures. Pick a model marked 👁 in the **Brain** menu, or remove the image.
</details>

<details>
<summary><b>"The brain ran out of room" / empty prompt</b></summary>

The model used up all its tokens, usually by thinking. Set **Thinking** to *Off* under **Settings → 🧠 How the Brain thinks**, or raise **Max tokens** there. If the message says the Brain *kept thinking even with Thinking: Off*, that model can't be stopped from thinking: raise **Max tokens**, or pick another Brain.
</details>

<details>
<summary><b>The assistant answers "LM Studio error: The number of tokens to keep … is greater than the context length"</b></summary>

The Brain was loaded in LM Studio with too little room for the assistant, which sends more along than writing a prompt does (about 12,000 tokens; small models often load with 8,192). The assistant folds earlier steps into a note before this happens, and once more when LM Studio reports it; if the message still shows, the Brain has too little room even for one turn. In LM Studio, open **My Models**, click the ⚙ next to the model and raise **Context Length** to 16,000 or more (32,000 is comfortable), then load it again. **Models → Brains** shows the room each loaded Brain has. Writing prompts works either way.
</details>

<details>
<summary><b>The Brain menu is empty right after starting LM Studio</b></summary>

LM Studio takes a few seconds to index your models after its server starts. Prompt Maker keeps checking and fills the menu in on its own.
</details>

<details>
<summary><b>Prompts come out too long or too short</b></summary>

Small models often overshoot "short". Try a bigger brain, or adjust that model's **length guide** in the Models tab. The word counter on each take shows how close you are.
</details>

<details>
<summary><b>The first prompt is slow</b></summary>

LM Studio is loading the model into memory; the take shows "Loading … into memory". After that, runs are fast. With an 8B model on a GPU, expect a few seconds per take.
</details>

<details>
<summary><b>Port 5317 is already in use</b></summary>

Another copy is probably running. Open http://127.0.0.1:5317, or start on another port with `PORT=5400 npm start` (Windows PowerShell: `$env:PORT=5400; npm start`).
</details>

<details>
<summary><b>"Can't reach ComfyUI"</b></summary>

Click **▶ Start it** next to *ComfyUI offline* (or **▶ Start** in **Settings → Services**). If Prompt Maker can't find ComfyUI, enter its folder under **Settings → ComfyUI**. Also check the URL with **Test connection**. The render bar reconnects on its own once ComfyUI answers.
</details>

<details>
<summary><b>"Your ComfyUI doesn't have a model this workflow needs"</b></summary>

The workflow loads a model file that isn't in ComfyUI's models folders. Click **⬇ Download** in step ⑤ (see [Missing models](#missing-models)). Without a download link, get the file where the workflow came from and put it in the folder step ⑤ names; the notice goes on its own.
</details>

<details>
<summary><b>"ComfyUI would skip part of this workflow"</b></summary>

ComfyUI checked the workflow and found a part it can't run (it names the node and why, often a missing model or a value it doesn't accept). It would have run the rest without the result, so Prompt Maker stopped the render instead. Fix what it names (in ComfyUI if it's in the workflow itself), then **↻ Update** the workflow in step ⑤.
</details>

<details>
<summary><b>"This workflow uses nodes your ComfyUI doesn't have"</b> (adding a workflow)</summary>

The workflow needs custom nodes that aren't installed. In ComfyUI, open **Manager → Install Missing Custom Nodes**, restart, then add the workflow again.
</details>

<details>
<summary><b>"This workflow uses a node your ComfyUI doesn't have right now"</b> / <b>"Node 'X' not found"</b></summary>

A node the workflow uses isn't in ComfyUI at the moment. Step ⑤ says which, and when the node's pack is installed but didn't load when ComfyUI started, which pack and why (from ComfyUI's log: usually a Python package that broke or an update the pack hasn't caught up with). Fix the pack in ComfyUI (**Manager → Try fix**, or install what the reason names), then **↻ Restart ComfyUI** in the notice and **↻ Check again**. If no pack has the node, install the one that does (**Manager → Install Missing Custom Nodes**) and restart. See [Missing models](#missing-models).
</details>

<details>
<summary><b>"This browser can't play that video"</b> (motion video)</summary>

Prompt Maker reads the motion video in your browser to show it and to take frames for the Brain. MP4 (H.264) and WebM always play; H.265 (HEVC) phone videos and ProRes often don't. With [ffmpeg](https://ffmpeg.org) installed, Prompt Maker makes a preview the browser can play, on its own. Without it, the video is still used for rendering, but the Brain can't see the moves: describe them in the theme, or convert the video to MP4 (H.264).
</details>

<details>
<summary><b>"This workflow needs a motion video"</b></summary>

The workflow has a *Load Video* node mapped as the motion video, but the take has none. On Create, add a motion video in step ③ (Wan Animate 2), then create again: the motion video is kept with each take.
</details>

<details>
<summary><b>A workflow doesn't convert or render quite right</b></summary>

Prompt Maker converts saved workflows itself. It handles bypassed nodes, reroutes, primitives, subgraphs and so on, and was checked against ComfyUI's own conversion on real workflows. A few exotic custom widgets can still differ. If one misbehaves, export it from ComfyUI with **Workflow → Export (API)** and upload that file instead.
</details>

<details>
<summary><b>"This workflow needs an image"</b></summary>

The workflow has a Load Image node mapped as the image input, but the take has no image. Add an image on the Create page, or pick a text-to-image/video workflow.
</details>

## Platform support

| | Linux | macOS | Windows |
|---|---|---|---|
| The app (`npm start`) | ✅ tested | ✅ should work | ✅ should work |
| Launcher and setup (app menu, start with the computer) | ✅ `./start.sh` | ⚠️ needs `open` instead of `xdg-open` | ⚠️ `start.bat`: written, not yet tried on a real PC |
| **■ Stop** ComfyUI, and **■ Stop everything** | ✅ | ⚠️ only a ComfyUI that Prompt Maker started | ⚠️ written, not yet tried on a real PC |
| **▶ Start it** (LM Studio server) | ✅ | ✅ should work | ⚠️ written, not yet tried on a real PC |
| Test suite | ✅ | ⚠️ expects Chrome as `google-chrome` | ⚠️ same |

Developed and tested on Linux with Chrome. Reports from macOS, Windows, Firefox and Safari are welcome.

## Development

No build step: edit a file and refresh the browser (restart the server after changing `server.js` or `lib/`).

```
prompt-maker/
├── server.js               # HTTP server: API, streaming, static files
├── lib/
│   ├── lmstudio.js         # LM Studio client: model list, streaming chat, start server
│   ├── cloud.js            # cloud Brains: providers you add yourself, with your own key
│   ├── brains.js           # what the app knows about each Brain: its record, and the Quick check
│   ├── prompt.js           # builds the messages sent to the Brain (master rules + playbook + request)
│   ├── assistant.js        # the assistant: its instructions, and a guide it searches, made from this README
│   ├── computer.js         # the assistant using this computer (opt-in): commands, programs, files
│   ├── folders.js          # folders of pictures on this computer, for the assistant's jobs (read-only)
│   ├── store.js            # file storage in your data folder: models, settings, history, images, renders
│   ├── comfy.js            # ComfyUI client: status, saved workflows, queue, live progress, downloads
│   ├── comfy-convert.js    # saved (editor) workflows → API format, incl. subgraphs & bypass
│   ├── workflows.js        # attached workflows: auto-mapping and building the prompt to queue
│   ├── models.js           # the model files a workflow loads: missing ones, ones in a subfolder, downloads
│   ├── videotools.js       # optional ffmpeg help for motion videos: what's in one, browser previews, 24 fps and cropped copies
│   ├── services.js         # starting and stopping LM Studio's server, ComfyUI and Prompt Maker (Settings → Services)
│   └── autostart.js        # setting up the computer: app-menu entry, Start button link, starting with the computer
├── public/                 # the web app (plain HTML/CSS/JS, bundled fonts; sw.js keeps a copy so the page opens while the server is off)
├── playbooks/              # the built-in model playbooks (read-only to the app)
├── chains/                 # the starter chains (read-only to the app)
├── workflows/              # the workflows that come with the app, one folder per model id, added to each model by itself (read-only to the app; no prompts, seeds or pictures in them)
├── tests/
│   ├── mock-lmstudio.mjs   # fake LM Studio for tests
│   ├── mock-comfyui.mjs    # fake ComfyUI (HTTP + WebSocket progress) for tests
│   └── ui.test.mjs         # end-to-end suite (headless Chrome)
├── scripts/
│   └── launch_branch       # runs Prompt Maker from a git branch in place of what runs now (scripts/launch_branch main goes back)
├── start.sh                # Linux launcher
└── start.bat               # Windows launcher (double-click)
```

### Tests

```bash
npm run test:ui
```

The suite runs the real app against a mock LM Studio and a mock ComfyUI in headless Chrome, and uses a temporary data folder so your models and history are never touched:

- **Real clicks:** it uses real mouse events, so a button hidden under something else fails.
- **Coverage:** generating, refining, versions, images, errors, stopping, Saved prompts, Models, Settings, keyboard use, ComfyUI workflows, rendering, the Gallery and security checks.
- **Strict:** it fails on any console error.
- **Layout:** it checks for sideways scrolling at six screen sizes, from 360px phones to 1920px desktops.

Screenshots go to `/tmp/prompt-maker-ui/` (or `$SHOTS`). The suite needs Node 22+ and Chrome installed as `google-chrome`.

The guide's own screenshots are retaken with `node tests/demo-shots.mjs create gallery models voices comfy-setup ask`: it builds two demo copies of the app from the mocks and the sample renders in `docs/renders/` (no prompts, no personal data), takes the shots into `/tmp/promptmaker-demo/shots/`, and stops them again.
