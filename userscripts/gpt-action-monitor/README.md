# GPT Action Monitor userscript

## Development

Source code lives under `src/`.

The installable Tampermonkey script remains `userscripts/gpt-action-monitor.user.js`.
Build from source:

```bash
cd userscripts/gpt-action-monitor
npm install
npm run build
```

Future refactors should split `src/` by responsibility (backend client, event store, UI, profile store) while keeping the generated userscript as the distribution artifact.
