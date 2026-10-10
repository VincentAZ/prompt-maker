# Prompt Maker UI/UX Audit

**Date:** October 10, 2026  
**Version reviewed:** 1.36.1 (`5485715`)  
**Scope:** UI and UX only. Bugs were deliberately excluded.

## Overall assessment

Prompt Maker has a strong visual foundation and several unusually good creator-focused tools. The Gallery gives artwork room to breathe, rating is built into the review flow, comparison works well, and outputs can naturally become inputs for the next creative step.

The app is not perfect as-is. Its main weakness is the first part of the experience: creators are asked to understand models, guides, prompt generation, rendering, and optional tools before the core creative action feels simple. The best path is a focused refinement of defaults, labels, and hierarchy rather than a wholesale redesign.

The recommended product flow is:

> Choose what you want to make → Describe it or add an image → Make it or review its prompt → Compare, rate, and reuse

## Priorities

### First priority

1. Start with the creative task instead of the model.
2. Make the main button clearly state what it will produce.
3. Keep results easy to reach when the Assistant is open or the window is narrow.

### Next

4. Clearly distinguish saved prompts from rated artwork.
5. Make comparison discoverable from the Gallery selection flow.
6. Use creator language throughout the main path.
7. Make Models a useful chooser before presenting it as an editor.

### Polish

8. Reduce visual competition and improve narrow-screen filters.

## Detailed findings

### 1. Start with the creative task

**Priority:** First  
**Estimated scope:** Medium

#### Observed

A fresh Create screen presents seven model cards and an expanded model guide before the idea field. In the inspected 1440 × 1000 first-run state, the idea field began below the visible area. Krea 2 Character was selected initially, so a newcomer had to understand the models before describing what they wanted to make.

#### Why it matters

The first decision asks for technical knowledge that a creator may not have. The interface explains the machinery before offering the simplest creative action.

#### Recommended change

Lead with **“What do you want to make?”** and a visible idea field. Offer a small set of task choices such as:

- Make a picture
- Edit a picture
- Keep the same person
- Animate a picture

Recommend a compatible model after the task is chosen. Keep the selected model visible in a compact **Change model** control and remember the user’s last choice.

Reduce the initial model guide to one useful sentence. Keep the full **Good for / You need** explanation available on demand.

Use a single purposeful empty state. The first screen currently has both an empty render area and a large introductory result state competing with the creation form.

#### Preserve

Keep the practical **Good for / You need** guidance and the model-specific examples. They are useful when shown beside a chosen task rather than placed in front of it.

#### Validate

Give a new creator the task “Make a picture from an idea.” Check whether they can begin without opening model documentation. Confirm that the idea field and primary action fit in the first laptop viewport.

#### Relevant source

- `public/index.html`, Create form and model picker
- `public/app.js`, `renderModelChips()` and `renderModelGuide()`

---

### 2. Make the main button promise the actual outcome

**Priority:** First  
**Estimated scope:** Small copy change; medium workflow change

#### Observed

With the default auto-render setting off, **Generate** produces a prompt. Making the image is a second action inside the generated prompt card. Auto-render is a switch farther down in step 5.

The ordinary **Generate** label does not distinguish between writing a prompt and making a finished image or video.

#### Why it matters

A creator who wants a picture has to learn Prompt Maker’s internal distinction between writing and rendering. The primary button can produce a different kind of result depending on settings that may not be visible.

#### Recommended change

Use explicit labels based on the outcome:

- **Write prompt** when that is the next result
- **Make image** when the configured workflow will render an image
- **Make video** when the configured workflow will render a video

Place a clear **Review prompt first** choice beside the main action. Once the user chooses direct creation or prompt review, remember that preference.

During direct creation, show simple progress stages:

> Writing prompt → Making image → Ready

When takes and renders multiply, state the total output count before the user starts. For example: **Make 8 images** rather than requiring the user to calculate 4 takes × 2 renders.

#### Preserve

Keep prompt-only work as a first-class option. Preserve the ability to edit a prompt before rendering, and do not silently start resource-intensive rendering for existing users whose saved preference is prompt review.

#### Validate

Before users click the main button, ask what they expect it to produce. Test both prompt-only and ready-to-render configurations, then check whether users can identify what is happening while they wait.

#### Relevant source

- `public/app.js`, `updateGenerateLabel()`
- `public/app.js`, auto-render settings
- `public/index.html`, steps 5 and 6 and the Generate bar

---

### 3. Keep the work reachable beside the Assistant

**Priority:** First  
**Estimated scope:** Medium

#### Observed

The Assistant opens by default on sufficiently wide screens and uses a 420-pixel panel. At 1280 × 800 with the Assistant open, Create switched to a single-column layout and the results area began far below the setup form. In the inspected state it started around 1,832 pixels down, even with the model section collapsed.

At the inspected 390 × 844 width, the results grid began around 2,281 pixels down. These measurements depend on which sections are expanded, but they show the travel required between setup and results.

#### Why it matters

The helper can displace the work it is meant to discuss. On narrow layouts, creators repeatedly travel through configuration controls to judge their output.

#### Recommended change

Default to a compact Ask entry point and remember whether the user opens the full Assistant.

On laptop widths, opening the Assistant should preserve a clear route to the active result. When Create becomes a single column, provide persistent **Create / Results** switching or a visible **View results** action.

Treat the active result separately from the complete historical render grid. The current work should remain immediately reachable even if the larger Gallery sits farther down the page.

#### Preserve

Keep the resizable Assistant, sticky Generate action, persistent render grid, and full-screen review. The current collapse controls are useful, but the default layout should not depend on extensive manual collapsing.

#### Validate

At 1280 × 800 and 390 × 844, start from a result, open Ask, and return to that result without searching or scrolling through the setup form. Repeat with image and video inputs.

#### Relevant source

- `public/app.js`, initial Assistant behavior and `openAssistant()`
- `public/app.css`, Assistant and responsive Create layouts

---

### 4. Separate saved prompts from rated artwork

**Priority:** Next  
**Estimated scope:** Small to medium

#### Observed

History shows image covers with a single star that favorites the prompt. Gallery shows the same artwork with a three-star quality rating for the render.

The **Hide** control on Create removes an item from **Your renders**, while the item remains in Gallery and History. Tooltips explain the distinction, but the visible interface does not always make the object and scope obvious.

#### Why it matters

Similar images and star symbols refer to different saved objects. A creator may reasonably expect a favorite or hidden item to behave consistently across the two views.

#### Recommended change

- Rename History to **Saved prompts** or otherwise state clearly that it contains prompts and sessions.
- Use a bookmark symbol for prompt favorites.
- Reserve stars for image and video quality.
- Label the hide action **Hide from Create**.
- Confirm the hide scope in the feedback message.
- Add a clear route from a render to its original prompt.

#### Preserve

Keep both prompt history and the visual Gallery; they serve different jobs. Preserve automatic saving and render-level ratings.

#### Validate

Ask a creator to rate a render, save its prompt for reuse, and hide it from the Create grid. Before they navigate, ask where they expect each item to appear.

#### Relevant source

- `public/app.js`, `renderHistory()`
- `public/app.js`, render rating and hiding behavior
- `public/index.html`, History and Gallery sections

---

### 5. Bring comparison into the selection workflow

**Priority:** Next  
**Estimated scope:** Medium; wording change is small

#### Observed

Comparison is available after a render is opened full-screen. It pins that render and displays the next render beside it. The viewer contains many useful actions, including download, reuse, animation, comparison, and deletion.

The Gallery’s multi-selection flow currently emphasizes deletion. A creator choosing two specific, nonadjacent candidates must discover the full-screen viewer route.

The comparison control **Keep this one** changes the pinned comparison reference; it does not save or favorite a winner.

#### Why it matters

The comparison tool itself is good, but its entry point is easy to miss. The word **Keep** can also be read as saving or favoriting the winner.

#### Recommended change

Offer a visible selection mode in Gallery and show **Compare 2** when exactly two renders are selected.

Retain the existing pinned-reference browsing for comparison against larger sets. Rename its action to something explicit, such as:

- **Compare others against this**
- **Pin on the left**

Keep rating and downloading visually separate from the comparison-reference action.

#### Preserve

Keep the current large side-by-side viewer, independent ratings, keyboard browsing, and full-size previews. This is a discoverability improvement rather than a replacement of the comparison mechanism.

#### Validate

Ask someone to compare two nonadjacent images and choose a winner. Check whether they understand pinning versus rating without reading a tooltip.

#### Relevant source

- `public/app.js`, `openLightbox()`, comparison rendering, and lightbox actions
- `public/index.html`, Gallery selection toolbar

---

### 6. Use creator language on the main path

**Priority:** Next  
**Estimated scope:** Small to medium

#### Observed

The visible Krea 2 RAW description includes phrases such as **undistilled 12B open-weights base** and **full-CFG**. One model name uses **i2i**. Standard Create controls expose numeric aspect ratios, resolution, prompt length, and a numeric adventurousness value.

Other parts of the app already use approachable language such as **Pretty good**, **Very good**, and **Excellent**.

#### Why it matters

Some labels describe how the system works rather than what the creator will get. They undermine the otherwise friendly tone and make model choice feel more technical than necessary.

#### Recommended change

Describe the result first:

- **Detailed pictures from your words**
- **Edit a picture**
- **Keep the same person in a new scene**

Use **Shape** with choices such as Portrait, Square, Landscape, and Wide, while retaining exact ratios for users who want them.

Use an automatic size default and keep dimensions available under more options. Move prompt length and the precise numeric creativity control into an advanced section. Keep the number of outputs easy to reach.

Explain **Brain** once as the model that writes the prompt.

#### Preserve

Keep exact model names and technical settings available for experienced users. Preserve the manual prompt option and the good plain-language ratings.

#### Validate

Ask creators to choose a portrait format, make two alternatives, and select the appropriate model for editing a photo. Note where technical help becomes necessary.

#### Relevant source

- `playbooks/krea2-raw.json`
- `playbooks/krea-2-raw-i2i.json`
- `public/index.html`, Create dials

---

### 7. Make Models a useful chooser before an editor

**Priority:** Next  
**Estimated scope:** Medium

#### Observed

Models opens as a management interface with **New model**, **Add workflow**, editable name, kind and color, and actions for Duplicate, Export, Delete, and Save. **Use in Create** shares that editing toolbar.

The page contains strong capability descriptions and example prompts, but its first impression is configuration rather than choosing the right creative tool.

#### Why it matters

A creator arriving to answer “Which model should I use?” encounters editing controls before a clear comparison of supported tasks and readiness.

#### Recommended change

Lead with:

- What the model makes
- What input it needs
- Whether it is ready on this computer
- A primary **Use this model** action

Place playbook and workflow editing behind **Customize**.

Do not invent speed or quality rankings. Only show those comparisons when they are measured locally or described accurately by the model source.

#### Preserve

Retain import/export, editable playbooks, and workflow management for advanced users. Keep the separate Brains view and its capability filters.

#### Validate

Ask a new user to find a model for keeping the same person, identify what input it needs, and start using it without entering edit mode.

#### Relevant source

- `public/index.html`, Models layout, workflow panel, and model form

---

### 8. Reduce visual competition and improve narrow-screen filters

**Priority:** Polish  
**Estimated scope:** Small to medium

#### Observed

The interface combines colorful model accents, gradient primary actions, many emoji labels, nested rounded panels, and compact helper text. History repeats a bright **Open** button on every card.

At 390 pixels wide, Gallery filters become a horizontally scrolling row with no visible scrollbar. Search and some rating filters sit beyond the visible section of that row.

#### Why it matters

The visual identity is memorable, but utility controls can compete with the artwork. On narrow screens, there is little indication that important filtering tools continue outside the viewport.

#### Recommended change

Keep the dark stage and warm primary accent, while making secondary actions quieter. Use a consistent utility icon set and strengthen the hierarchy of essential helper text.

On narrow Gallery layouts:

- Keep search visible.
- Put secondary filters behind a labeled **Filters** control.
- Show the number of active filters.
- Increase spacing around frequently used touch actions.

#### Preserve

Keep the brand’s personality, natural image proportions, adjustable thumbnail size, and full-screen review. Do not flatten the interface into generic monochrome cards.

#### Validate

Review a populated screen at laptop width and in a real touch session. Ask users to find an excellent-rated item and clear the filters. Treat visual preferences as hypotheses rather than accessibility findings.

#### Relevant source

- `public/app.css`, visual tokens, render rating controls, and narrow Gallery filters

## What already works well

### Artwork gets a real stage

The populated Gallery preserves image proportions and offers adjustable thumbnail size. The full-screen viewer gives the work most of the window.

### Judgment is built in

Three clear quality levels, keyboard rating shortcuts, and pinned side-by-side comparison help people choose their best work. The core comparison mechanism is worth keeping.

### Outputs lead into the next creative task

**Animate this**, **Use as input image**, and **Open in Create** connect one output to another creative step. Prompt refinement suggestions translate common requests into useful actions.

### Useful guidance already exists

The selected model’s **Good for / You need** explanation is practical. The Brain picker explains vision capability. Voice setup gives the download size and offers one clear installation action.

### Advanced controls are often appropriately hidden

Seed, LoRA, and sampler controls already live under an Advanced fold. Saved panel states and the sticky main action support repeat work. This approach should be extended to the initial model choice and prompt-writing controls.

### The app has a recognizable identity

The dark stage, warm action color, and distinctive typography feel deliberate. The app does not need a new brand, a new design system, or a dashboard-style redesign.

## Suggested implementation order

### First pass

Make the Generate outcome explicit, shorten the selected model explanation, and stop opening the full Assistant by default. These are bounded changes with a clear purpose.

### Second pass

Prototype a task-based start and a persistent route to Results on narrow layouts. Validate these ideas before reorganizing the entire Create screen.

### Third pass

Separate prompt bookmarks from render ratings, add direct comparison selection, improve the Models landing view, and complete the visual polish pass.

## Validation plan

Recruit three to five creators who have not used Prompt Maker. Give them four tasks:

1. Make a picture from a short idea.
2. Animate a chosen still.
3. Compare two outputs and identify the better one.
4. Find and reuse yesterday’s preferred work.

Record:

- Their first click
- Whether they complete the task
- Backtracking
- Where they ask for help
- What they expect the main action to produce

Compare the current interface with a focused prototype. A small study will reveal major misunderstandings, but it should not be treated as statistical proof.

## Method and coverage

This was a heuristic audit against the repository’s creator-first brief:

- Results first
- Plain language
- Sensible defaults
- Easy comparison
- Easy rating and retrieval of the best work

The audit directly inspected:

- First-run Create
- Model selection and model guidance
- Prompt generation with an isolated mock Brain
- Render options and chain entry points
- Populated Gallery and History
- Full-screen review and comparison
- Assistant layout
- Brain picker
- Models management
- Voices setup
- Settings and service status

Viewports inspected:

- 1440 × 1000
- 1280 × 800
- 390 × 844

Eight sample renders from the repository’s public demonstration assets were used, followed by one mock-generated prompt. No personal data folder was used.

## Limits

- No bugs were sought or scored.
- No real GPU generation was performed.
- Voice installation and voice audition were not performed.
- Model downloads and long chain or batch runs were not performed.
- Real service latency and audio quality were not evaluated.
- Screen-reader behavior and physical touch interaction were not tested.
- This is not an accessibility certification.
- This is an expert review, not a usability study with participants.

Confidence is high in the recorded layouts, labels, and interaction structure. Confidence is medium in the predicted effect on new creators until the proposed changes are tested with them.

## Conclusion

Prompt Maker should keep its visual identity and strong review workflow. The main opportunity is to make that workflow easier to reach by reducing the knowledge required at the beginning, clearly naming the result of the primary action, and keeping active work visible across screen sizes.

No numerical UX score is assigned because a score would imply measurement that this audit did not perform.
