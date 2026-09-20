# GPT Action Monitor userscript

The installable Tampermonkey script is `userscripts/gpt-action-monitor.user.js`. It is generated from the modular source in this directory; edit `src/`, not the generated userscript.

## Source layout

- `src/main.js` — lifecycle/bootstrap only.
- `src/api/` — action-log transport and polling.
- `src/adapters/` — ChatGPT page integration.
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
