# PM2 design comparison

Compared the read-only PM2 prototype snapshot `aa6ae3a` (`prototype/dist/app.js`, `prototype/tests/ACCEPTANCE.md`) with production `77d6093` while preparing the 1.59 theme port. PM2 was not built, tested, or changed.

## Included in the theme port

Sage, Sand, Ocean, Midnight, and Follow system, adapted to production's markup and browser storage. The header picker and Settings → Appearance share one selection. Production components use shared palette variables; media overlays keep their own readable foregrounds.

## Presentation differences awaiting an owner decision

- **Shortcut help dialog.** PM2 has a header/Settings entry and a shortcut reference dialog (`case "shortcuts"`). Production documents shortcuts in the guide but has no equivalent dialog. Its actual shortcuts differ: Ask uses Ctrl+K, so the prototype's bindings must not be copied.
- **Look picker cards.** PM2 uses a dialog of illustrated icon cards (`case "looks"`). Production already supports built-in and custom looks through chips and an inline editor under Create.
- **Voice cards.** PM2's `renderVoices` uses a card grid and decorative waveforms. Production has a working voice list and real audio controls. A card presentation would need to preserve those controls; the simulated waveform and sample content are not production data.
- **Saved chain cards.** PM2's `renderChains` emphasizes a collection of reusable chain cards. Production has the chain editor, starter recipes, saved chains, and Pipeline progress. The collection presentation is different.
- **Batch recipe cards.** PM2's `renderBatches` uses cards with prominent counts and recipe actions. Production has editable named batches and run controls in a list.
- **Jobs overview.** PM2's `renderJobs` adds aggregate counts above job cards. Production already provides real plans, progress, logs, and job actions, with a different presentation.

These are candidates for a separate UI pass. None is included in the theme port without the owner's agreement.

## Already in production

The sidebar destinations; Create's split workspace and divider; Library selection, sorting, filtering, comparison and downloads; Saved-prompts cards; the viewer's resizable prompt box; Ask resizing and full-width mode; and dedicated Brains, Chains, Batches, Jobs, and Settings sections already have production implementations. The theme work retains those implementations.

Prototype reset/export helpers, simulated service and generation flows, and sample media/prompts are prototype scaffolding, not missing production features. No PM2 assets or sample data are included in this port.
