# README rewrite: plan and renders

Made on 2026-10-08 in a clean data folder (nothing from anyone's own folder), Brain: Gemma 4 26B A4B. Exported
without metadata (ComfyUI writes the prompt and workflow into each PNG; these carry none). The captions are the words
typed into Prompt Maker.

## Renders

| File | Model | The words |
|---|---|---|
| `fisherman-dock.webp` | Krea 2 RAW | an old fisherman mending a bright orange net on a wooden dock at dawn, mist over the harbor |
| `ramen-cook.webp` | Krea 2 RAW | a ramen stall in a Tokyo back alley at night, steam rising, neon reflections on wet pavement, the cook laughing with a customer |
| `desert-convertible.webp` | Krea 2 RAW | a red vintage convertible parked at an empty desert gas station at golden hour, long shadows |
| `ballet-dancer.webp` | Krea 2 RAW | a ballet dancer in her thirties tying her pointe shoes backstage before a show, soft window light, dust in the air |
| `same-person-turnaround.webp` | Krea 2 Character | 🪪 Turnaround of the fisherman above |
| `same-person-harbor-bar.webp` | Krea 2 Character | he is playing cards with old friends in a crowded harbor bar at night, laughing |
| `same-person-storm.webp` | Krea 2 Character (from the turnaround) | he steers his small fishing boat through a rough grey sea in the rain, holding the wheel |
| `ltx-fisherman.webp` / `.mp4` | LTX 2.3, Animate, from `fisherman-dock` | he pulls the orange net taut and checks a knot, gulls cry over the misty harbor, the lantern flickers |
| `minimax-ramen-cook.webp` / `.mp4` | MiniMax H3, Animate, from `ramen-cook` | the cook laughs, ladles steaming broth into a bowl and says to his customer: "Best bowl in Tokyo, I promise!" |

The .webp clips play on GitHub (no sound); each links to its .mp4 for the sound. Still to check: that the MiniMax
clip says its line clearly (it has sound; nobody has listened yet).

## Plan

1. Under the tagline: a grid of fisherman-dock, ramen-cook, desert-convertible, ballet-dancer and the LTX clip, each
   captioned with its words.
2. "What you get", in pictures: same person (fisherman-dock → turnaround → harbor-bar → storm), still → video
   (LTX clip), with a voice (MiniMax clip).
3. Install in three steps: the .deb, LM Studio, ⬇ Set up ComfyUI.
4. The manual (Using, Rendering, Settings, Troubleshooting, Development) moves to `docs/guide.md`, linked from the
   README (about 200 lines left). Settings screenshots go with it; the README keeps Create and the Gallery.
5. Then the Civitai article gets the same renders and opener.

## Added later the same day (short, vague ideas, as the app promises)

Captions here are the exact words typed (Krea 2 RAW unless noted); the Brain wrote the full prompt.

| File | The words |
|---|---|
| `woman-cafe.webp` | woman reading in a café |
| `woman-bicycle-rain.webp` | woman on a bicycle in the rain |
| `hands-dough.webp` | chef in her kitchen |
| `woman-pier.webp` | woman at the beach with a soda |
| `ltx-woman-pier.webp` / `.mp4` | LTX 2.3 from `woman-pier`: she takes a sip and looks out at the sea |

Pixabay silhouette videos (`*_medium.mp4` in this folder) are motion sources for the Wan Animate 2 clip. They are
git-excluded locally and must not ship: only the finished Wan clip does. Check Pixabay's license before shipping it.
The earlier long-prompt stills (fisherman, ramen, convertible, ballet) get no captions.
