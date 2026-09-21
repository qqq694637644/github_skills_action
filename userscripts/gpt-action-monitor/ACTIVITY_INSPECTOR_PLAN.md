# GPT Action Monitor → Activity Inspector implementation plan

Status: design proposal only; no runtime implementation in this PR.

## Goal

Turn the current right-side GPT Action Monitor from a raw Action log viewer into a compact agent activity inspector modeled after the OpenAI Codex TUI.

The monitor exists because ChatGPT web does not expose the Action execution process. The new UI should answer these questions at a glance:

- What is the agent doing right now?
- What did it just finish?
- What command/result mattered?
- What files were inspected or edited?
- If something failed, what was the useful failure output?

The implementation must keep the existing fixed right-side overlay. It must not inject activity into ChatGPT conversation messages or modify ChatGPT page layout.

## Product decisions already agreed

- Backend Action log protocol may change and become structured.
- Command stdout/stderr previews may be carried in monitor events.
- Keep the current fixed right-side overlay.
- Follow Codex CLI/TUI interaction and naming conventions rather than inventing a new activity vocabulary.
- Do not expose internal Action names such as `workspaceCommand` in the normal UI.
- Dedicated renderers are required for:
  - `workspaceCommand`
  - `workspaceApplyPatch`
  - `workspaceReadFiles`
  - `workspaceSearch`
  - `workspaceInspect`
  - `workspaceWriteFile`
  - `loadSkills`
  - `readSkillContent`
- History is page-session only.
- Keep at most 100 completed activity cells.
- Failure presentation should follow Codex compact command/tool rendering.
- File-change summaries should follow Codex patch/diff summary style.
- A `NOW` + `RECENT` layout is acceptable.

## Codex source reference

The design was checked against a local checkout of `openai/codex` at:

```text
774d64258260f94628cc9fc55cfabd59a668571c
```

Primary reference files:

- `codex-rs/tui/src/chatwidget.rs`
  - active cell vs committed history model
- `codex-rs/tui/src/chatwidget/command_lifecycle.rs`
  - command start/output/end lifecycle
- `codex-rs/tui/src/chatwidget/activity_groups.rs`
  - grouping related activity
- `codex-rs/tui/src/exec_cell/render.rs`
  - compact `Running` / `Ran` / `Failed` presentation
- `codex-rs/tui/src/exec_cell/live_output.rs`
  - bounded live command output
- `codex-rs/tui/src/history_cell/patches.rs`
  - patch history cell rendering
- `codex-rs/tui/src/diff_render.rs`
  - per-file and aggregate diff statistics

The intent is to copy the interaction model, not the terminal visual styling.

## Core model: activity cells, not Action log lines

The current monitor treats every backend event as an independent history line. That leaks implementation details and creates entries such as:

```text
workspaceCommand
workspaceCommand
workspaceReadFiles
workspaceSearch
```

The new monitor should maintain **activity cells**.

An activity cell has a stable id and lifecycle:

```text
started → updated zero or more times → completed/failed
```

While active it appears under `NOW` and is updated in place. Once terminal it moves to `RECENT`.

This is the key architectural change.

## Proposed structured event protocol

`/v1/action-logs` should continue to return a monotonically ordered stream, but each item should gain a structured `event` payload. Keep the existing `text` field during migration for compatibility/debugging.

Example envelope:

```json
{
  "id": 184,
  "text": "legacy/debug representation",
  "event": {
    "activity_id": "command:op_123",
    "kind": "command",
    "phase": "started",
    "timestamp": "2026-09-21T10:56:12.123Z",
    "payload": {}
  }
}
```

Required top-level event fields:

```text
activity_id   stable id used to update one activity cell
kind          presentation category
phase         started | updated | completed | failed
payload       kind-specific structured data
```

The browser must never derive lifecycle identity from display text.

## Activity kinds

### 1. command

Source Action: `workspaceCommand`

Started payload:

```json
{
  "command": "python -m pytest -q",
  "workspace_id": "ws_...",
  "operation_id": "op_..."
}
```

Output update payload:

```json
{
  "stream": "stdout",
  "delta": "49 passed in 3.8s\n"
}
```

Completed payload:

```json
{
  "command": "python -m pytest -q",
  "state": "succeeded",
  "exit_code": 0,
  "duration_ms": 3800,
  "stdout_preview": ["49 passed in 3.8s"],
  "stderr_preview": []
}
```

Failed payload uses the same shape with a nonzero exit code and bounded stderr/stdout previews.

Normal UI naming follows Codex:

```text
Running python -m pytest -q
Ran python -m pytest -q
Failed (exit 1) python -m pytest -q
```

Do not show `workspaceCommand` in the normal presentation.

### 2. exploration

Sources:

- `workspaceInspect`
- `workspaceSearch`
- `workspaceReadFiles`
- `readSkillContent`

Adjacent compatible exploration actions should be grouped into one cell, following Codex's `Exploring` / `Explored` behavior.

Example:

```text
• Exploring
  └ Search workspaceCommand
    Read workspace_actions.py
    Read runtime.py
```

Completed:

```text
• Explored
  └ Search workspaceCommand
    Read workspace_actions.py
    Read runtime.py
```

Suggested structured child records:

```json
{
  "verb": "Search",
  "label": "workspaceCommand",
  "detail": "11 matches"
}
```

```json
{
  "verb": "Read",
  "label": "workspace_actions.py",
  "detail": null
}
```

Grouping rule must be deterministic and presentation-oriented. It should not depend on DOM timing.

### 3. patch

Source: `workspaceApplyPatch`

Follow Codex diff summary conventions.

Single-file examples:

```text
Edited src/main.py (+12 -4)
Added src/new.py (+30 -0)
Deleted old.txt (+0 -12)
```

Multiple files:

```text
Edited 3 files (+42 -11)
  └ runtime.py (+8 -2)
    workspace_actions.py (+21 -4)
    tests/test_runtime.py (+13 -5)
```

The backend already has `changed_files` and `diff_stat`; extend the structured payload only if per-file stats are needed for Codex-style detail.

Failure should render like Codex's failed patch presentation, e.g.:

```text
Failed to apply patch
  └ <bounded diagnostic preview>
```

### 4. write

Source: `workspaceWriteFile`

Presentation:

```text
Wrote path/to/file
Created path/to/file
```

Use returned mode/change metadata to choose the verb where reliable. Otherwise use `Wrote`.

### 5. skill

Sources:

- `loadSkills`
- `readSkillContent`

Presentation examples:

```text
Loaded skill github-maintenance
Read skill github-maintenance / references/git-and-pr.md
```

These may remain independent compact history cells rather than participating in exploration grouping, unless later usage shows grouping is clearly better.

### 6. generic fallback

Unknown/new Actions must still appear without breaking the UI.

Generic fallback may use a humanized label and a bounded detail line, but the normal UI should avoid exposing raw argument blobs.

This protects the UI from backend/tool evolution while dedicated renderers are added deliberately.

## Command lifecycle and output

### Backend requirement

The operation runner already writes stdout/stderr to operation log files. The monitor needs lifecycle/output events without waiting for a later explicit `workspaceCommand(action="logs")` call.

The implementation should publish command activity directly from the operation lifecycle:

```text
operation start
→ command started event

stdout/stderr drain
→ coalesced output update events

process exit
→ command completed/failed event
```

### Output coalescing

Do not emit one Action event per tiny pipe read.

Coalesce output using a small time/size window, for example:

```text
flush every 100–200 ms OR after a bounded byte threshold
```

Exact values should be benchmarked during implementation rather than hard-coded from this plan.

### Bounded server-side preview

Do not persist unbounded command output in the Action event buffer.

Follow the same principle as Codex live output:

- bound bytes/lines retained for monitor use;
- preserve useful tail output;
- preserve failure diagnostics;
- pass output through existing secret redaction.

The compact browser UI should show at most **3 preview lines**, matching Codex's compact `DETAIL_PREVIEW_LINES = 3` behavior.

Full operation output continues to belong to the existing operation/log APIs; the monitor is not a replacement terminal.

## UI structure

Keep the existing fixed right-side overlay and its collapsed HUD behavior.

Expanded layout:

```text
┌────────────────────────────────────────────┐
│ GPT Actions                     Skills › − │
├────────────────────────────────────────────┤
│ NOW                                        │
│                                            │
│ • Running python -m pytest -q        3.8s │
│   └ collecting ...                        │
│                                            │
│ • Exploring                               │
│   └ Search workspaceCommand               │
│     Read workspace_actions.py             │
│                                            │
├────────────────────────────────────────────┤
│ RECENT                                     │
│                                            │
│ • Ran git status --short             1.0s │
│   └ M src/runtime.py                      │
│                                            │
│ • Edited 3 files (+42 -11)                │
│   └ runtime.py (+8 -2)                    │
│     ...                                    │
└────────────────────────────────────────────┘
```

### NOW

- Contains active activity cells only.
- Cells update in place by `activity_id`.
- No artificial progress percentages.
- Duration may tick locally while active; this must not trigger backend traffic.
- When a cell becomes terminal it leaves `NOW` and is committed to `RECENT`.

### RECENT

- Stores terminal activity cells only.
- Maximum 100 cells.
- Page-session only; no GM/localStorage persistence.
- Newest activity should remain easy to reach without constantly stealing scroll position from a user who is inspecting older entries.

### Session scope

- A full ChatGPT page/userscript reload starts with empty `NOW` and `RECENT` state.
- Temporary title/DOM churn that deactivates and reactivates the same matched profile must not erase activity history.
- Switching to a genuinely different matched profile/backend starts a new activity session and clears the previous profile's activity cells so unrelated agents are not mixed together.
- Skill catalog persistence is independent of activity history; the existing persistent Skill cache should not be cleared by this UI change.

## Compact vs expanded detail

Default compact cell:

- Codex-style verb/title
- important target (`command`, filename, query, skill id)
- duration/state when useful
- up to 3 output/diff/detail preview lines

Clicking a cell may expand locally to show its full **bounded monitor payload**. It must not trigger a backend fetch automatically.

If full command logs are desired later, that should be an explicit secondary action that uses the existing operation log API.

## Failure presentation

Follow Codex compact semantics:

Command:

```text
Failed (exit 1) python -m pytest -q
  └ AssertionError: ...
    1 failed, 48 passed
```

Patch:

```text
Failed to apply patch
  └ target context did not match
```

Transport/monitor errors remain visually distinct from tool failures. For example, a `/v1/action-logs` network failure is a monitor connectivity error, not a failed agent activity cell.

## Backend implementation outline

Primary files expected to change:

```text
src/skill_temple/action_logging.py
src/skill_temple/workspace_actions.py
src/skill_temple/workspace_operations.py
src/skill_temple/workspace_files.py
src/skill_temple/app.py
```

Expected work:

1. Introduce a typed/structured activity event representation.
2. Keep existing monotonic event ids and bounded event storage.
3. Preserve legacy `text` during migration.
4. Emit structured events for the eight dedicated Action families.
5. Add operation-runner lifecycle/output hooks for command events.
6. Redact structured string fields and output previews before publication.
7. Ensure long-polling behavior and authentication remain unchanged.

## Userscript implementation outline

Current modules should evolve rather than rebuilding the userscript around one giant renderer.

Proposed modules:

```text
src/activity/
  activity-store.js
  activity-reducer.js
  presentation.js

src/ui/activity/
  activity-panel.js
  command-cell.js
  exploration-cell.js
  patch-cell.js
  write-cell.js
  skill-cell.js
  generic-cell.js
```

Existing `formatter/action-formatter.js` should be retired from primary rendering once structured events are available. During migration it may remain as a fallback for legacy text-only events.

### activity-store.js

Responsibilities:

- active cells keyed by `activity_id`;
- completed history capped at 100;
- move terminal cells from active → recent;
- apply the session-scope rules above rather than blindly clearing on every temporary monitor deactivation.

### activity-reducer.js

Pure state transition layer:

```text
(event, state) → new state
```

It must handle duplicate/replayed event ids safely because long-poll reconnects should not duplicate visible activity.

### presentation.js

Maps structured backend data to view models and Codex-style labels. It owns human-facing naming; backend Action names must not leak into normal renderers.

## Exploration grouping policy

This requires care because over-grouping can hide causality.

Initial policy:

- group consecutive `workspaceInspect`, `workspaceSearch`, `workspaceReadFiles`, and `readSkillContent` activities while no command/patch/write boundary intervenes;
- append structured exploration children to one active `Exploring` cell;
- commit it as `Explored` when a non-exploration activity starts or when an idle timeout closes the group;
- do not use a long timeout that makes completed work appear active for seconds;
- exact timeout is an implementation detail to validate in tests and manual use.

If backend events can provide an explicit grouping/turn id reliably, prefer that over timing heuristics.

## Event compatibility and rollout

Do not perform a flag-day migration.

Phase 1 backend:

```text
/v1/action-logs item = { id, text, event? }
```

New userscript prefers `event` when present and falls back to the old formatter for text-only entries.

After the structured protocol has proven stable across `github_skills_action`, `teacher_gpt`, and `Computer-Vision---Algorithms-2nd_gpt-action`, legacy parsing can be reconsidered separately.

## Implementation phases

### Phase 1 — structured backend protocol

- event schema
- event ids/activity ids
- command lifecycle events
- bounded output preview
- dedicated structured payloads for the eight selected Action families
- backward-compatible `/v1/action-logs`
- backend tests

No major UI redesign should land before the protocol is testable.

### Phase 2 — userscript state model

- activity reducer/store
- NOW/RECENT lifecycle
- 100 completed cell limit
- command lifecycle coalescing
- exploration grouping
- legacy-event fallback
- reducer/unit tests independent of DOM

### Phase 3 — Codex-style renderers

- command
- exploration
- patch
- write
- skill
- generic fallback
- compact three-line previews
- failures and durations

### Phase 4 — integration and polish

- connect panel to activity store
- retain existing Skills menu
- retain drag/position behavior
- verify scrolling behavior
- verify ChatGPT route/profile activation/deactivation
- responsive width checks
- update generated userscript

### Phase 5 — downstream sync

Only after source implementation is accepted and stable:

- sync Action/runtime backend changes to `teacher_gpt`;
- sync Action/runtime backend changes to `Computer-Vision---Algorithms-2nd_gpt-action`;
- no userscript duplication into those repositories unless separately requested.

## Tests required before implementation PR is considered complete

### Backend

- structured event shape for each dedicated Action family;
- command started → output → completed lifecycle;
- command failed lifecycle and exit code;
- output preview bounds;
- secret redaction in structured payloads and previews;
- long-running async operation events without requiring explicit `logs` polling;
- quick sync-first command events;
- event buffer bounds and long-poll cursor behavior;
- legacy `text` still present during compatibility period.

### Userscript unit tests

- active cell updates in place rather than duplicating;
- terminal cell moves NOW → RECENT;
- repeated/replayed event does not duplicate history;
- history retains at most 100 completed cells;
- exploration actions group correctly;
- command preview is capped to three lines;
- command failure naming matches `Failed (exit N)` convention;
- patch summary formatting for add/edit/delete/multiple files;
- raw internal Action names do not appear in dedicated renderers;
- legacy text-only events still render during migration.

### Integration/manual checks

- real `workspaceCommand` quick success;
- real long command with live output;
- failing command with useful stderr preview;
- search/read/inspect sequence becomes one Exploring/Explored cell;
- apply patch shows aggregate file/diff stats;
- skill load/read presentation;
- close/reopen expanded panel without duplicate events;
- ChatGPT profile switch/deactivate/reactivate behavior;
- Skills menu still inserts `loadSkills([...])` correctly.

## Acceptance criteria

The implementation is acceptable when a user can watch a real maintenance task and understand the workflow without knowing the Action API names.

A normal sequence should read approximately like:

```text
NOW

• Running python -m pytest -q
  └ collecting ...

RECENT

• Explored
  └ Search workspaceCommand
    Read workspace_actions.py
    Read runtime.py

• Edited 3 files (+42 -11)
  └ runtime.py (+8 -2)
    ...

• Ran git status --short
  └ M src/runtime.py
```

The following presentation is explicitly considered a failure of the redesign:

```text
workspaceCommand
workspaceCommand
workspaceSearch
workspaceReadFiles
workspaceApplyPatch
```

because it exposes implementation mechanics instead of agent activity.

## Non-goals

- Do not inject tool cards into ChatGPT conversation messages.
- Do not resize or restructure the ChatGPT page.
- Do not create a full terminal emulator in the userscript.
- Do not persist activity history across page reloads.
- Do not display unbounded stdout/stderr.
- Do not invent progress percentages.
- Do not add a search UI for activity history in the first implementation.
- Do not synchronize this experimental UI into downstream repositories.

## Review focus for this plan PR

Before implementation begins, review should specifically decide whether:

1. the structured event envelope is sufficient and stable;
2. command lifecycle events should originate directly from `workspace_operations.py` as proposed;
3. exploration grouping boundaries are acceptable;
4. the three-line compact preview should match Codex exactly;
5. 100 completed activity cells is the correct page-session bound;
6. retaining legacy `text` during rollout is worth the temporary dual representation.

Implementation should not start until those protocol/state-model points are accepted, because changing them after UI work would create avoidable rework.
