# GPT Action Monitor userscript

The installable Tampermonkey script is published as the `gpt-action-monitor.user.js` asset on the latest GitHub Release. The committed `userscripts/gpt-action-monitor.user.js` is retained as a migration/development build; edit `src/`, not the generated userscript.

## Source layout

- `src/main.js` — lifecycle/bootstrap only.
- `src/activity/` — structured activity state reduction and Codex-style presentation.
- `src/api/` — workspace discovery, action-log transport, and polling.
- `src/api/skill-catalog-client.js` — on-demand Skill catalog reads with persistent backend caching and explicit refresh.
- `src/adapters/` — ChatGPT composer insertion.
- `src/formatter/` — legacy text-event parsing used only as a compatibility fallback.
- `src/profile/` — multi-endpoint persistence and validation.
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

The expanded monitor also includes a `Skills` menu. The configured backend catalog is fetched once on demand and persisted by the userscript across ChatGPT page reloads. Only `↻` explicitly refreshes that catalog. Clicking a Skill inserts `loadSkills(["<skill-id>"])` at the ChatGPT composer caret without sending the message.

The backend field is the REST API base URL and is used as-is. For example, with `https://githubaction.giize.com/mcp-app`, the monitor requests `https://githubaction.giize.com/mcp-app/v1/action-logs`. MCP transport paths are configured separately by the MCP client/server deployment.

Monitor settings keep the endpoint library and active selection as separate state. **保存配置** only persists endpoint name/backend/token data and never changes which endpoint is active. **设为全局默认** persists the default endpoint independently. **绑定当前网址** stores an endpoint override for the current ChatGPT URL, and **恢复全局默认** removes only that URL override. URL bindings persist across refreshes and revisits.

Workspace selection is stored in the same URL binding together with the endpoint identity that owns it. The Workspace picker is lazy-loaded from `/v1/action-workspaces`; no activity long-poll starts until a Workspace is selected. Once selected, `/v1/action-logs` includes that `workspace_id`, the backend filters before returning events, and the client defensively accepts only matching structured events. Switching Workspace aborts the old long-poll and clears the current activity stream. URL binding records include a modification timestamp; at most 20 are kept and the least recently modified record is evicted when the limit is exceeded. Query strings and fragments are intentionally excluded from the URL key so one conversation path has one stable binding.
