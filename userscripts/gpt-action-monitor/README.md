# GPT Action Monitor userscript

The installable Tampermonkey script is `userscripts/gpt-action-monitor.user.js`. It is generated from the modular source in this directory; edit `src/`, not the generated userscript.

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

`npm run build` rewrites `../gpt-action-monitor.user.js`. The generated file is committed so users can install it directly from GitHub, while maintenance stays in small, responsibility-focused source files.

The expanded monitor renders structured backend activity as `NOW` and `RECENT` cells modeled after the Codex TUI: running commands update in place, inspect/search/read activity coalesces into `Explored`, command output is limited to a compact three-line preview, and file changes use aggregate `(+additions -deletions)` summaries. Completed activity history is page-session-only and capped at 100 cells.

The expanded monitor also includes a `Skills` menu. Each backend profile catalog is fetched once on demand and persisted by the userscript across ChatGPT page reloads. Only `↻` explicitly refreshes that profile catalog. Clicking a Skill inserts `loadSkills(["<skill-id>"])` at the ChatGPT composer caret without sending the message.
