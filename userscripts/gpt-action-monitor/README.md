# GPT Action Monitor userscript

The installable Tampermonkey script is `userscripts/gpt-action-monitor.user.js`. It is generated from the modular source in this directory; edit `src/`, not the generated userscript.

## Source layout

- `src/main.js` — lifecycle/bootstrap only.
- `src/api/` — action-log transport and polling.
- `src/api/skill-catalog-client.js` — on-demand Skill catalog reads with in-page caching and explicit refresh.
- `src/adapters/` — ChatGPT page integration and composer insertion.
- `src/formatter/` — backend log parsing and display summaries.
- `src/profile/` — profile persistence and validation.
- `src/store/` — bounded event history.
- `src/ui/` — monitor panel, history rendering, settings UI, and styles.
- `metadata.txt` — Tampermonkey metadata header.
- `build.mjs` — bundles the modular source into the installable single-file userscript.

## Development

```bash
cd userscripts/gpt-action-monitor
npm install
npm run check
```

`npm run build` rewrites `../gpt-action-monitor.user.js`. The generated file is committed so users can install it directly from GitHub, while maintenance stays in small, responsibility-focused source files.

The expanded monitor includes a `Skills` menu. Each backend profile catalog is fetched once on demand and kept in memory for the page session, including across monitor deactivate/reactivate cycles. Only `↻` explicitly refreshes that profile catalog. Clicking a Skill inserts `loadSkills(["<skill-id>"])` at the ChatGPT composer caret without sending the message.
