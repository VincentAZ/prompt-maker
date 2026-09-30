# Prompt Maker

Writes prompts for image and video generation models, tuned to each model's prompting style. It runs 100% offline: a local LLM in **LM Studio** does the writing, and the app never contacts the internet.

## Start

```bash
./start.sh        # starts LM Studio's server if needed and opens the app
# or
npm start         # just the app → http://127.0.0.1:5317
```

It needs Node 20.11+ and LM Studio with its local server on (Developer tab, or `lms server start`). There is nothing to install: the app has no dependencies.

Pick the LLM in the top bar. For image input it must be a vision model (marked 👁), e.g. Qwen3-VL 8B, Gemma 3/4 or Qwen 3.5/3.6.

## What it does

The Create page is a four-step flow: pick the model, describe the shot, add an image, and dial in the settings.

- **Theme → prompt**: type a theme (or hit 🎲 *Surprise me*), pick a target model, then hit *Generate* (or press Ctrl+Enter).
- **Image + theme → prompt**: drop, paste or browse an image, then choose how it's used:
  - 🎯 **Reference**: borrow its look (subject, light, palette, mood) and blend it with the theme.
  - 🪞 **Recreate**: describe the image so the target model can reproduce it. The theme, if any, is applied as changes.
  - 🎬 **Animate**: video models only. The image is frame one, and the prompt describes what happens next.
- **Image only**: leave the theme empty and the AI suggests a prompt from the image.
- **Settings for each model**: aspect ratio, resolution, duration (video) and prompt length. Each model remembers your last choices.
- **Temperature** (precise → wild) and **1–4 takes**. Each take deliberately goes a different way.
- **Live output**: streaming text and a word count against the model's target length. It also shows model-loading and thinking status, and progress in the browser tab title.
- **Stop** (■ or Esc): keeps any takes that already finished.
- **Refine**: type what to change ("golden hour", "add a dog") or tap a quick chip. Every version is kept, and you can page through them with ‹ ›. Hand edits are saved as versions too, never silently dropped.
- **History**: saved automatically and grouped by day. You can search, filter by model, favorite, copy, or open an entry to keep refining it.

## Models (the part you'll update)

Each target model is one JSON file in `data/models/`, edited in the **Models** tab:

| Field | Purpose |
|---|---|
| Instructions | The prompting guide the LLM follows for this model (markdown). |
| Example prompts | Gold-standard prompts the LLM imitates in style. |
| Aspect ratios / resolutions / durations | Options shown on the Create page. |
| Defaults | Starting aspect, resolution, duration, length and temperature. |
| Length guide | What short, medium and long mean for this model. |

- **New model**: **+ New model**, or **Duplicate** an existing one.
- **Draft with AI**: paste a model's official prompting docs, and your local LLM turns them into instructions in the standard format.
- **Import / Export**: share or back up models as `.json`. Importing a file with an existing ID updates that model.

The shared rules sent before every model's instructions live in **Settings → Master instructions**.

## LM Studio connection

Prompt Maker talks to whatever serves LM Studio's API at `127.0.0.1:1234`. It isn't tied to the LM Studio desktop app or to Bionic, LM Studio's makers' newer app. Keep in mind:

- **Opening the LM Studio app doesn't turn its server on**, unless "start server on launch" is enabled in its Developer tab.
- **Quitting the app turns the server off.**
- **If the server is off**, the app shows a banner with **▶ Start it**. That runs `lms server start`, which works whether the desktop app is open or not; without the app, LM Studio runs as a background service.
- **It reconnects automatically** once the server is back.

## Settings

- **Thinking**: *Off* by default. Reasoning models such as Qwen 3.5/3.6 otherwise think for thousands of tokens before writing a single word.
- **Top P / Max tokens**: standard sampling controls.
- **LM Studio URL**: only localhost or local-network addresses are accepted.

## Tests

```bash
npm run test:ui
```

This runs an end-to-end suite against the real app server, a mock LM Studio (`tests/mock-lmstudio.mjs`) and headless Chrome. It clicks through every screen with real mouse events and fails on any console error. It also checks for sideways scrolling at phone, tablet, laptop and desktop widths. Screenshots land in `/tmp/prompt-maker-ui/`, or in `$SHOTS` if set. The suite uses a temporary data folder, so your models and history are never touched.

## Data

Everything lives in `data/`:

- `models/`: target model definitions
- `history.json`: every generation and its versions
- `images/`: uploaded images, deduplicated
- `settings.json`

Back up that folder to keep everything.

## Included models (researched September 2026)

- **Krea 2 RAW** (image): dense natural-language captions, texture cues against the RAW checkpoint's airbrushed look.
- **LTX 2.3** (video + audio): one chronological paragraph, explicit camera, sound and dialogue woven in.
- **MiniMax H3 / Hailuo 03** (video + audio): MiniMax's structured shooting-script format (`integrated_multimodal_description` / `overall_soundscape` / `non_diegetic_music`), with `[Shot N]` cuts and `(S1)` dialogue tags.

Sources for each are listed in the model's editor.
