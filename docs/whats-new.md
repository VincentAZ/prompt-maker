# What's new in Prompt Maker

The notes that used to live in the README, newest first. Older versions are in the [releases](https://github.com/VincentAZ/prompt-maker/releases) and the git history.

## Update in 1.72.5

**Normal window controls on Linux.** Prompt Maker now uses the desktop's normal title bar and borders instead of Chrome's compressed app frame. Minimize, maximize and close are full-sized again. The preference belongs to Prompt Maker's private browser profile and does not change regular Chrome windows.

## Update in 1.72.4

**A crisp title-bar icon.** The tiny icon beside “Prompt Maker · Create” now has its own 16-pixel artwork instead of shrinking a larger desktop icon into that space. The Windows icon includes that exact size too.

## Update in 1.72.3

**Launcher icon refresh.** Prompt Maker now refreshes its window and sidebar artwork instead of reusing an old browser-profile copy. A window opened from the desktop shortcut also stays grouped under Prompt Maker's green icon in the system dock or sidebar.

## Update in 1.72.2

**Hugging Face tokens stay put.** **⬇ Model files → Connect Hugging Face** now explains the setup in two short steps, links straight to a new Read token, and has **Show** so you can check what you pasted. The token stays in the field while the model list checks files in the background. If Hugging Face rejects it, it stays selected, ready for a replacement paste.

## Update in 1.72.1

**The right icon everywhere.** Prompt Maker now uses a crisp small icon in its window and browser tab, and corrected icon sizes in the desktop, dock and window switcher. New Linux and Windows setups put a launch shortcut on the desktop too. **Settings → Services → Put a Prompt Maker shortcut on my desktop** adds or removes it in one click.

## Update in 1.72.0

**Set up LM Studio from the app, on Linux too.** When LM Studio isn't on the computer, the banner at the top, **Settings → Services** and the **Brains** page offer **⬇ Set up LM Studio**. On Linux it installs LM Studio's headless service (LM Studio's own install script, about 1 GB, into your home folder; no window, your shell left alone; the desktop app can be added later and shares the models), starts its server and fetches a Brain that can see (Qwen3-VL 8B, or 4B on a computer with less memory) through LM Studio's own downloader. On Windows it runs LM Studio's installer quietly, as the first start does. Each part has a bar, a part already there is skipped, and the **Brains** page offers **⬇ Get a Brain that can see** on its own when none of your Brains can look at pictures.

**⬇ Model files: everything each model needs, in one list.** In **Settings → Services** (the ComfyUI row), on the **Models** page, in Settings → ComfyUI's workflow check, and at the end of the ComfyUI set-up and of the Windows first start. One section per model: each file in plain words (the model, its text encoder, its VAE, a LoRA, a vision encoder), ✓ for the ones ComfyUI has, the size of the rest (asked of Hugging Face when the list opens), and **⬇ Get** for one file, **⬇ Get all for this model**, or **⬇ Get everything**, with the total. A file Hugging Face hands only to a signed-in account (FLUX 3 Klein's) gets **Connect Hugging Face**: a token pasted once (checked, kept in the data folder for you only), and those files download like the rest; one whose terms you haven't accepted yet points you to *Agree* on the model's page. A file only one variant of a model uses says so.

**⬇ Set up ffmpeg.** The video tools (previews of phone videos, 24 fps and cropped copies, cutting, joining the pieces of a long render, a spoken line on a video) used to need an ffmpeg you installed yourself. **Settings → Services** now has a **Video tools (ffmpeg)** row that says whether it's there and fetches a ready-made build into the data folder when it isn't; the motion video's notes offer the same button. A system ffmpeg is left alone. On Windows, the first start gets it as its fourth part.

## Update in 1.71.0

**Renders keep their recipe.** Every picture and video Prompt Maker keeps carries the job ComfyUI wrote into it (prompt, model, LoRAs, seed, settings), so a file you share can be made again, and **📜 Recipe inside** reads it back.

**Brain menu: 🎬 Dark scenes.** A filter and badge for Brains tuned to write horror, war and crime scenes without balking, next to Thinking, Vision and Loaded.

**Plainer words.** The writing slider is about imagination; deleting a card says what goes and gives you a few seconds to undo; Settings has one section fewer.

## Update in 1.69.1

**A newer copy on disk than the one running is said out loud.** When Prompt Maker's files are updated by hand (git pull, a replaced folder) while it runs, the page is new but the old code answers, so a setting the old code doesn't know, like prompt sets, vanished on Save. Now the page says which version is installed and which still runs, with ↻ Restart Prompt Maker right there (Settings → Updates).

**Prompt sets, seen.** The set checkboxes are in **Fine-tune → Writing** as well as under Prompt options. While the Brain writes, the take says "Writing with your … examples", so you know the sets went along; they now come before the model's own examples, so a Brain short on room drops the model's first.

## Update in 1.69.0

Create your own categories in **Settings → Instructions → Your prompt sets**. Give each set a name and example prompts, separated by blank lines, then save. There is no category-count limit. **Create → Prompt options** lists every set with a checkbox; combine any sets and your choices are remembered across restarts. Edit or remove sets in Settings. Word-for-word prompts bypass the Brain and these examples.

## Update in 1.68.0

**🎲 Surprise me looks at your picture.** Before, with a picture in, Surprise me picked a random idea from a list, so a first frame of a woman could get a surfing corgi. Now the Brain looks at the picture and at the look you picked, and suggests one idea that fits them: what happens from the first frame when you animate it (with the look's movement and mood), a new scene for the person you keep, where and from what angle for a motion video, or an idea grown from a reference. Words you typed stay in and the idea is built around them; each click differs from the last five, and a second click while it's thinking stops it. The picture is only looked at, never stored. With no picture, a Brain that can't see pictures, or LM Studio not running, the idea comes from the list as before (motion ideas when animating), and a message says why. A take written while another tab was showing now fits its text when you come back to it (1.67.1).

## Update in 1.67.0

**Windows, one installer.** `prompt-maker-<version>-setup.exe` installs Prompt Maker for your user alone (no administrator password), with its own Node.js, a Start menu entry, start with the computer and the link the page's Start button uses; it opens as its own app window and runs in the background with no console to keep open. **The first start sets up everything else from one screen**, each part with a progress bar and nothing usable behind it until it's done: ComfyUI in its own folder with its own Python 3.12 and the PyTorch build for your graphics card (CUDA for NVIDIA, XPU for Intel Arc, the processor's otherwise), LM Studio through its official installer run quietly, and a Brain that can see (Qwen3-VL 8B, or 4B on a computer with less memory). A part that's already there is skipped; a set-up that stops carries on with ↻ Try again. **Settings → ⬆ Updates** downloads a newer installer and restarts into it. The guide's [Installation](guide.md#installation) and [The first start on Windows](guide.md#the-first-start-on-windows-everything-in-one-go) have the details. The installer isn't signed, so Windows asks once (More info → Run anyway).

## Update in 1.66.4

Create's **Make** menu is now a single row of labeled task icons. Their full names appear as tooltips and accessible labels, and choosing one still recalls a suitable model. The model selector is folded underneath, so it stays out of the way until you choose to change it.

## Updates in 1.64

Create uses the available width and replaces its large introductory heading with a compact title. Task and model sit together; Shape and Size use familiar menus, and Takes sits beside **Fine-tune**. Required picture and video inputs still open when needed. The essential setup controls stay visible even if an older version remembered them folded.

**Fine-tune** moves detailed controls into a wider dialog with **Rendering**, **Look**, and **Writing** tabs. Workflow, sampler, seed and LoRAs are directly available in Rendering, without the old More options → Render → Advanced nesting. On desktop, each LoRA has its switch, name, slider and exact strength on one row; on a phone they stack. Closing the dialog keeps your changes and returns focus to its opener. In word-for-word mode, only Rendering is shown.

The results empty state explains the next step. The Assistant's welcome is shorter. **Prompt options** holds word-for-word mode and the checkboxes for your own prompt sets. Manage names and examples in Settings → Instructions.

[Implementation and verification log](ux-redesign-log.md).

## Updates in 1.63

Create keeps optional image inputs and prompt options folded. **Takes** is back, the Brain selector is wider, and names include compression codes when LM Studio provides them. Rate Brains on the **Brains** page or beside the Brain in a render’s full-screen details; the Brain name there opens its card. **Your rating** sorting and the **Thinking** filter help find Brains again. Click an active Brain sort again to reverse it: Last/First used, A–Z/Z–A, or highest/lowest star rating. Search and selected filters still combine with that order. Each take can show its model-provided thinking in a collapsed section. The render viewer browses renders across all displayed takes; closing it preserves the prompt editor’s draft and size.

**Batches → Cycle settings** varies seeds, sampler settings, size, duration, and LoRA switches/strengths directly in the app. Choose **Together** or **Every combination**, preview the render list, and save. The limit is 50 outputs. Choose one prompt to keep its words unchanged; the Brain does not run the parameter cycle. Take-level LoRA switches remain off when reopened and apply to the rendered graph. **Writing creativity** controls Brain temperature, so it is inactive for a word-for-word prompt; render variation comes from the seed and rendering settings.

Library/Your renders and Saved prompts offer **Oldest first**, **Newest first**, and **Select none**. Voices uses one playback at a time: keeping, renaming, or deleting a voice no longer replays previously heard clips. **Hear it** shows progress, and **Say a line** has a larger multiline box.

Local Brain, rendering, and speech jobs coordinate GPU use and release other idle models before switching. Voice design and speech no longer retain both speech models at once. This reduces overlapping allocations; other programs and oversized models can still exhaust available memory.

**FLUX 3 Klein Base** uses the Base defaults of 50 steps and CFG 3.5. NVFP4 requires Blackwell; current ComfyUI and matching weights are required. Its [Base license](https://huggingface.co/black-forest-labs/flux-3-image-klein-base/blob/main/LICENSE.md) has restricted terms and a conditional commercial-output exception below US$5M annual revenue, including affiliates; review its conditions before business use. [The 24-item review log](prompt-maker-updates.md) records decisions and validation limits.

## Studio layout and themes

**New in 1.59: make the studio yours.** Choose Sage, Sand, Ocean, Midnight, or Follow system from the header’s theme button or **Settings → Appearance**. Colors change instantly, your layout stays put, and your choice is remembered in this browser. Everything works offline.

The studio layout puts navigation in a sidebar and keeps your work beside a compact Create panel. **Library** holds artwork; **Saved prompts** holds your sessions. **Brains**, **Chains**, **Batches**, and **Jobs** each have their own page. Create’s **Pipeline** tab shows chain progress and lets you choose what continues; Settings groups its controls into clear sections. Existing prompts, renders, workflows, and preferences carry over. Saved prompts with a long shared opening show the words that distinguish them; hover to see the full opening.

Create’s **Your renders**, **Prompt takes**, and **Pipeline** tabs stay in place while their results scroll. In **Your renders**, the gallery is the only scrolling area on the results side, so its toolbar stays in place too.

Drag the divider between Create’s controls and results left or right to give either side more room. In the lightbox, drag the prompt box’s lower-left corner to change its width and height. Both sizes are remembered in your browser; double-click either handle to reset it. The handles also work with arrow keys.

The main button tells you what comes next: **Write prompt**, **Make image**, or **Make video**, with the total output count when making several. **Review prompt first** sits beside it and remembers your choice for each model; existing auto-render preferences carry over. Progress tells you when the prompt is being written, the artwork is being made, and the result is ready.

Choose **Shape**, **Size** and **Takes** on the main path. Size offers Small to Huge in the picked shape (HD, Full HD, 2K and 4K by name on video), starts on the model's usual size, and takes any width × height you type; prompt length and Writing creativity sit under **More options → Writing options**. **Exact ratio** opens every supported shape; the four shape tiles keep common choices close. The model guide and look choices (eleven looks, **No look**, or **your own**) open when needed. **Models** starts with what each model makes, what it needs and its local rendering readiness; **Customize** opens the existing playbook and workflow editor.

Saved prompt thumbnails show a permanent **▶ Video** badge for video previews, or **▶ Video prompt** for video prompts without a video preview. Card actions keep **Copy** and **Delete** together, with **Open** on its own full-width row so buttons stay inside narrow cards.

In Library, search stays visible on small screens, with the finer choices under **Filters** (when it was made, shape, not rated yet, spoken line, workflow, LoRA, look), an active-filter count and **Clear filters**; search also finds a seed or a size. The viewer links back to the original prompt. **Pin on the left** changes the comparison reference; stars rate the artwork. Secondary actions and panels are quieter so the work stands out.
