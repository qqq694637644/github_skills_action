# GPT Action Monitor userscript

The installable Tampermonkey script is published as the `gpt-action-monitor.user.js` asset on the latest GitHub Release. The committed `userscripts/gpt-action-monitor.user.js` is retained as a migration/development build; edit `src/`, not the generated userscript.

## Source layout

- `src/main.js` — lifecycle/bootstrap only.
- `src/activity/` — structured activity state reduction and Codex-style presentation.
- `src/api/` — action-log transport and polling.
- `src/api/skill-catalog-client.js` — on-demand Skill catalog reads with persistent per-profile caching and explicit refresh.
- `src/adapters/` — ChatGPT page integration and composer insertion.
- `src/formatter/` — legacy text-event parsing used only as a compatibility fallback.
- `src/profile/` — profile persistence and validation.
- `src/ui/` — Activity Inspector, monitor shell, Skills/settings UI, and styles.
- `metadata.txt` — Tampermonkey metadata header.
- `build.mjs` — bundles the modular source into the installable single-file userscript.

## Development

```bash
cd userscripts/gpt-action-monitor
npm install
npm run check
```

`npm run build` rewrites `../gpt-action-monitor.user.js`. Release builds are created by the `Publish GPT Action Monitor` workflow instead: manually dispatch it with the source `branch` and the userscript `version`. The workflow checks out that branch, runs the tests, injects the requested version into the metadata, builds `gpt-action-monitor.user.js`, verifies it, and publishes it as a normal GitHub Release marked Latest. Versions should increase across all releases so Tampermonkey can update monotonically.

The userscript's explicit `@updateURL` and `@downloadURL` both point at `releases/latest/download/gpt-action-monitor.user.js`, so the selected release branch does not need to be `main`.

The expanded monitor renders structured backend activity as `NOW` and `RECENT` cells modeled after the Codex TUI: running commands update in place, `NOW` stays visible above independently scrollable newest-first history, inspect/search/read activity coalesces into `Explored`, command output is limited to a compact three-line preview, JSON-like command output is humanized when possible, and file changes use aggregate `(+additions -deletions)` summaries. The expanded window can be resized from the browser-native bottom-right grip or the dedicated bottom-left grip, which stays convenient when the panel is docked to the right edge. Completed activity history is page-session-only and capped at 100 cells.

The expanded monitor also includes a `Skills` menu. Each backend profile catalog is fetched once on demand and persisted by the userscript across ChatGPT page reloads. Only `↻` explicitly refreshes that profile catalog. Clicking a Skill inserts `loadSkills(["<skill-id>"])` at the ChatGPT composer caret without sending the message.
