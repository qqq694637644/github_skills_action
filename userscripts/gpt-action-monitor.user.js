// ==UserScript==
// @name         GPT Action Monitor
// @namespace    https://github.com/qqq694637644/github_skills_action
// @version      0.7.5
// @description  Show Codex-style github_skills_action activity on ChatGPT without changing the page layout.
// @updateURL    https://github.com/qqq694637644/github_skills_action/releases/latest/download/gpt-action-monitor.user.js
// @downloadURL  https://github.com/qqq694637644/github_skills_action/releases/latest/download/gpt-action-monitor.user.js
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      *
// ==/UserScript==
(() => {
  // src/constants.js
  var PROFILES_KEY = "gptActionMonitorProfiles";
  var POSITION_KEY = "gptActionMonitorPosition";
  var GPT_TITLE_SELECTOR = 'div[type="button"][aria-haspopup="menu"]';
  var POLL_WAIT_SECONDS = 55;
  var RETRY_MS = 3e3;
  var ACTIVITY_VISIBLE_MS = 4e3;
  var UI_COALESCE_MS = 200;
  var MAX_HISTORY = 100;
  var COMPACT_WIDTH = 30;

  // src/formatter/action-formatter.js
  function parseField(text, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(
      new RegExp(`(?:^|\\s)${escaped}=("(?:\\\\.|[^"\\\\])*"|\\[[^\\]]*\\]|[^\\s]+)`)
    );
    if (!match) return null;
    const raw = match[1];
    try {
      return JSON.parse(raw);
    } catch (_) {
      return raw;
    }
  }
  function baseName(path) {
    if (!path || typeof path !== "string") return "";
    const parts = path.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || path;
  }
  function compactList(value, max = 2) {
    if (!Array.isArray(value) || !value.length) return "";
    const names = value.slice(0, max).map((item) => baseName(String(item)));
    return value.length > max ? `${names.join(", ")} +${value.length - max}` : names.join(", ");
  }
  function shorten(value, limit = 72) {
    if (value === null || value === void 0) return "";
    const oneLine = String(value).replace(/\s+/g, " ").trim();
    return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}\u2026` : oneLine;
  }
  function summarize(text) {
    const action = text.match(/\bACTION\s+([\w-]+)/)?.[1] || "Action";
    const time = text.match(/^\[\d{4}-\d{2}-\d{2}\s+(\d{2}:\d{2})\]/)?.[1] || "";
    let detail = "";
    if (action === "loadSkills") detail = compactList(parseField(text, "skill_ids"));
    else if (action === "readSkillContent") detail = baseName(parseField(text, "path"));
    else if (action === "workspaceReadFiles") detail = compactList(parseField(text, "paths")) || `${parseField(text, "files") || ""} files`;
    else if (action === "workspaceSearch") detail = shorten(parseField(text, "query"));
    else if (action === "workspaceInspect") detail = compactList(parseField(text, "paths"));
    else if (action === "workspaceWriteFile") detail = baseName(parseField(text, "path"));
    else if (action === "workspaceApplyPatch") {
      const files = parseField(text, "changed_files");
      detail = Array.isArray(files) ? `${files.length} files \xB7 ${compactList(files)}` : "";
    } else if (action === "workspaceCommand") {
      const commandAction = parseField(text, "action");
      const command = parseField(text, "command");
      const state = parseField(text, "state");
      const exitCode = parseField(text, "exit_code");
      if (command) {
        const status = [commandAction, state].filter(Boolean).join(" \xB7 ");
        const exit = state === "failed" && exitCode !== null ? ` \xB7 exit ${exitCode}` : "";
        detail = `${status}${exit}${status ? " \xB7 " : ""}${shorten(command, 48)}`;
      } else if (state && commandAction) detail = `${commandAction} \xB7 ${state}`;
      else detail = shorten(state || commandAction || "");
    } else {
      detail = shorten(parseField(text, "path") || parseField(text, "query") || compactList(parseField(text, "paths")) || parseField(text, "state") || "");
    }
    return { action, detail: detail || "completed", time, raw: text };
  }

  // src/activity/activity-reducer.js
  var MAX_LIVE_OUTPUT_CHARS = 24e3;
  function clonePayload(payload) {
    return payload && typeof payload === "object" ? { ...payload } : {};
  }
  function cloneCell(cell) {
    return {
      ...cell,
      payload: clonePayload(cell.payload),
      entries: [...cell.entries || []]
    };
  }
  function structuredCell(event) {
    const payload = clonePayload(event.payload);
    return {
      id: event.activity_id,
      kind: event.kind || "generic",
      phase: event.phase || "completed",
      startedAt: event.timestamp || "",
      updatedAt: event.timestamp || "",
      payload,
      liveOutput: "",
      entries: event.kind === "exploration" ? explorationEntries(payload) : [],
      revision: 1
    };
  }
  function legacyCell(item) {
    const summary = summarize(item.text || "");
    return {
      id: `legacy:${item.id}`,
      kind: "legacy",
      phase: "completed",
      startedAt: "",
      updatedAt: "",
      payload: { summary },
      liveOutput: "",
      entries: [],
      revision: 1
    };
  }
  function explorationEntries(payload) {
    const entries = [];
    const operation = payload.operation;
    if (operation === "search") {
      entries.push({
        verb: "Search",
        label: payload.query || "code",
        detail: Number.isInteger(payload.match_count) ? `${payload.match_count} matches` : ""
      });
    } else if (operation === "read") {
      for (const path of payload.paths || []) entries.push({ verb: "Read", label: path, detail: "" });
    } else if (operation === "inspect") {
      for (const path of payload.paths || []) entries.push({ verb: "List", label: path, detail: "" });
      const searches = (payload.searches || []).length ? payload.searches : (payload.queries || []).map((query) => ({ query }));
      for (const search of searches) {
        entries.push({
          verb: "Search",
          label: search.query || "code",
          detail: Number.isInteger(search.match_count) ? `${search.match_count} matches` : ""
        });
      }
      for (const path of payload.files || []) entries.push({ verb: "Read", label: path, detail: "" });
    }
    return entries;
  }
  function createActivityState() {
    return {
      active: /* @__PURE__ */ new Map(),
      recent: [],
      explorationGroupId: null
    };
  }
  function addRecent(state, cell, maxHistory) {
    state.recent.unshift(cell);
    if (state.recent.length > maxHistory) state.recent = state.recent.slice(0, maxHistory);
    return cell;
  }
  function breakExplorationGroup(state) {
    state.explorationGroupId = null;
  }
  function reduceCommand(state, event, maxHistory) {
    const existing = state.active.get(event.activity_id);
    if (event.phase === "started") {
      const cell2 = structuredCell(event);
      state.active.set(cell2.id, cell2);
      return cell2;
    }
    if (event.phase === "updated") {
      const cell2 = existing ? cloneCell(existing) : structuredCell({ ...event, phase: "started" });
      const delta = String(event.payload?.delta || "");
      if (delta) cell2.liveOutput = `${cell2.liveOutput}${delta}`.slice(-MAX_LIVE_OUTPUT_CHARS);
      cell2.updatedAt = event.timestamp || cell2.updatedAt;
      cell2.revision += 1;
      state.active.set(cell2.id, cell2);
      return cell2;
    }
    const cell = existing ? cloneCell(existing) : structuredCell(event);
    cell.phase = event.phase;
    cell.updatedAt = event.timestamp || cell.updatedAt;
    cell.payload = { ...cell.payload, ...clonePayload(event.payload) };
    cell.revision += 1;
    state.active.delete(cell.id);
    return addRecent(state, cell, maxHistory);
  }
  function reduceExploration(state, event, maxHistory) {
    const payload = clonePayload(event.payload);
    if (event.phase === "started" || event.phase === "updated") {
      const existing = state.active.get(event.activity_id);
      const cell2 = existing ? cloneCell(existing) : structuredCell(event);
      cell2.phase = event.phase;
      cell2.payload = { ...cell2.payload, ...payload };
      cell2.entries = explorationEntries(payload);
      cell2.updatedAt = event.timestamp || cell2.updatedAt;
      cell2.revision += existing ? 1 : 0;
      state.active.set(cell2.id, cell2);
      return cell2;
    }
    const activeCell = state.active.get(event.activity_id);
    state.active.delete(event.activity_id);
    if (event.phase === "failed") {
      breakExplorationGroup(state);
      const failed = activeCell ? cloneCell(activeCell) : structuredCell(event);
      failed.phase = "failed";
      failed.payload = { ...failed.payload, ...payload };
      failed.entries = explorationEntries(payload);
      failed.updatedAt = event.timestamp || failed.updatedAt;
      failed.revision += activeCell ? 1 : 0;
      return addRecent(state, failed, maxHistory);
    }
    const entries = explorationEntries(payload);
    const groupIndex = state.explorationGroupId ? state.recent.findIndex((cell2) => cell2.id === state.explorationGroupId) : -1;
    if (groupIndex >= 0) {
      const grouped = cloneCell(state.recent[groupIndex]);
      grouped.entries.push(...entries);
      grouped.updatedAt = event.timestamp || grouped.updatedAt;
      grouped.payload.truncated = Boolean(grouped.payload.truncated || payload.truncated);
      grouped.revision += 1;
      state.recent[groupIndex] = grouped;
      return grouped;
    }
    const cell = activeCell ? cloneCell(activeCell) : structuredCell(event);
    cell.id = event.activity_id;
    cell.phase = "completed";
    cell.payload = { ...cell.payload, ...payload };
    cell.entries = entries;
    cell.updatedAt = event.timestamp || cell.updatedAt;
    cell.revision += activeCell ? 1 : 0;
    addRecent(state, cell, maxHistory);
    state.explorationGroupId = cell.id;
    return cell;
  }
  function reduceGeneric(state, event, maxHistory) {
    const existing = state.active.get(event.activity_id);
    if (event.phase === "started" || event.phase === "updated") {
      const cell2 = existing ? cloneCell(existing) : structuredCell(event);
      cell2.phase = event.phase;
      cell2.payload = { ...cell2.payload, ...clonePayload(event.payload) };
      cell2.updatedAt = event.timestamp || cell2.updatedAt;
      cell2.revision += existing ? 1 : 0;
      state.active.set(cell2.id, cell2);
      return cell2;
    }
    const cell = existing ? cloneCell(existing) : structuredCell(event);
    cell.phase = event.phase;
    cell.payload = { ...cell.payload, ...clonePayload(event.payload) };
    cell.updatedAt = event.timestamp || cell.updatedAt;
    cell.revision += existing ? 1 : 0;
    state.active.delete(cell.id);
    return addRecent(state, cell, maxHistory);
  }
  function reduceActivityItem(previousState, item, { maxHistory = 100 } = {}) {
    const state = {
      active: new Map(previousState.active),
      recent: [...previousState.recent],
      explorationGroupId: previousState.explorationGroupId
    };
    if (!item?.event) {
      breakExplorationGroup(state);
      return { state, latest: addRecent(state, legacyCell(item || {}), maxHistory) };
    }
    const event = item.event;
    if (!event || typeof event !== "object" || !event.activity_id) {
      return { state, latest: null };
    }
    if (event.kind !== "exploration") breakExplorationGroup(state);
    let latest;
    if (event.kind === "command") latest = reduceCommand(state, event, maxHistory);
    else if (event.kind === "exploration") latest = reduceExploration(state, event, maxHistory);
    else latest = reduceGeneric(state, event, maxHistory);
    return { state, latest };
  }

  // src/activity/activity-store.js
  var MAX_SEEN_EVENTS = 2e3;
  function eventKey(item) {
    if (!Number.isInteger(item?.id)) return null;
    const event = item.event;
    if (event) {
      return `${item.id}:${event.timestamp || ""}:${event.activity_id || ""}:${event.phase || ""}`;
    }
    return `${item.id}:${item.text || ""}`;
  }
  function createActivityStore() {
    let state = createActivityState();
    const listeners = /* @__PURE__ */ new Set();
    const seen = /* @__PURE__ */ new Set();
    const seenOrder = [];
    function snapshot() {
      const active = [...state.active.values()].sort((left, right) => {
        const leftTime = left.updatedAt || left.startedAt || "";
        const rightTime = right.updatedAt || right.startedAt || "";
        return rightTime.localeCompare(leftTime);
      });
      return {
        active,
        recent: [...state.recent]
      };
    }
    function notify() {
      const value = snapshot();
      for (const listener of listeners) listener(value);
    }
    function rememberEvent(item) {
      const key = eventKey(item);
      if (key === null) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      seenOrder.push(key);
      while (seenOrder.length > MAX_SEEN_EVENTS) seen.delete(seenOrder.shift());
      return true;
    }
    function ingest(items) {
      let latest = null;
      let changed = false;
      for (const item of items || []) {
        if (!rememberEvent(item)) continue;
        const reduced = reduceActivityItem(state, item, { maxHistory: MAX_HISTORY });
        state = reduced.state;
        if (reduced.latest) {
          latest = reduced.latest;
          changed = true;
        }
      }
      if (changed) notify();
      return latest;
    }
    function clear() {
      state = createActivityState();
      seen.clear();
      seenOrder.length = 0;
      notify();
    }
    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
    return { ingest, snapshot, clear, subscribe };
  }

  // src/activity/presentation.js
  var PREVIEW_LINES = 3;
  var JSON_DIAGNOSTIC_LIMIT = 100;
  var jsonDiagnostics = /* @__PURE__ */ new Set();
  function rememberJsonDiagnostic(key) {
    if (jsonDiagnostics.has(key)) return false;
    jsonDiagnostics.add(key);
    if (jsonDiagnostics.size > JSON_DIAGNOSTIC_LIMIT) {
      const oldest = jsonDiagnostics.values().next().value;
      jsonDiagnostics.delete(oldest);
    }
    return true;
  }
  function reportJsonDiagnostic(cell, raw, outcome, formatted = "") {
    const rawPreview = String(raw || "").slice(0, 800);
    const key = `${cell.id}:${cell.revision}:${outcome}:${rawPreview}`;
    if (!rememberJsonDiagnostic(key)) return;
    console.debug("[GPT Action Monitor][Activity JSON]", {
      activityId: cell.id,
      phase: cell.phase,
      command: cell.payload?.command || "",
      outcome,
      raw: rawPreview,
      formatted: String(formatted || "").slice(0, 800)
    });
  }
  function scalarText(value) {
    if (value === null) return "null";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) return `${value.length} items`;
    if (value && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length === 1) return scalarText(entries[0][1]);
      return `${entries.length} fields`;
    }
    return String(value ?? "");
  }
  function summarizeJson(value) {
    if (Array.isArray(value)) return `${value.length} items`;
    if (!value || typeof value !== "object") return scalarText(value);
    const entries = Object.entries(value);
    const priority = [
      "state",
      "number",
      "title",
      "nameWithOwner",
      "defaultBranchRef",
      "baseRefName",
      "headRefName",
      "url"
    ];
    entries.sort(([left], [right]) => {
      const leftRank = priority.indexOf(left);
      const rightRank = priority.indexOf(right);
      if (leftRank < 0 && rightRank < 0) return 0;
      if (leftRank < 0) return 1;
      if (rightRank < 0) return -1;
      return leftRank - rightRank;
    });
    const parts = entries.slice(0, 3).map(([key, nested]) => `${key}: ${scalarText(nested)}`);
    if (entries.length > 3) parts.push("\u2026");
    return parts.join(" \xB7 ");
  }
  function readableOutputLine(cell, line) {
    const trimmed = String(line || "").trim();
    if (!trimmed) return "";
    if (/^[\[\]{}],?$/.test(trimmed)) {
      reportJsonDiagnostic(cell, trimmed, "json-syntax-hidden");
      return "";
    }
    const looksLikeJsonContainer = trimmed.startsWith("{") || /^\[\s*(?:[\]{"\d\-tfn])/.test(trimmed);
    if (looksLikeJsonContainer) {
      try {
        const formatted = summarizeJson(JSON.parse(trimmed));
        reportJsonDiagnostic(cell, trimmed, "json-parsed", formatted);
        return formatted;
      } catch {
        reportJsonDiagnostic(cell, trimmed, "json-parse-failed");
      }
    }
    const fragment = trimmed.match(/^"([^"\\]+)"\s*:\s*(.+?),?$/);
    if (fragment) {
      let value = fragment[2].trim();
      try {
        value = scalarText(JSON.parse(value.replace(/,$/, "")));
      } catch {
        value = value.replace(/,$/, "").replace(/^"|"$/g, "");
      }
      const formatted = `${fragment[1]}: ${value}`;
      reportJsonDiagnostic(cell, trimmed, "json-fragment", formatted);
      return formatted;
    }
    return trimmed;
  }
  function readableOutputLines(cell, lines) {
    return compactLines((lines || []).map((line) => readableOutputLine(cell, line)).filter(Boolean));
  }
  function compactLines(lines) {
    return (lines || []).map((line) => String(line || "").trimEnd()).filter((line) => line.trim()).slice(-PREVIEW_LINES);
  }
  function leadingLines(lines) {
    return (lines || []).map((line) => String(line || "").trimEnd()).filter((line) => line.trim()).slice(0, PREVIEW_LINES);
  }
  function outputLines(cell) {
    if (cell.phase === "started" || cell.phase === "updated") {
      return readableOutputLines(cell, String(cell.liveOutput || "").split(/\r?\n/));
    }
    const payload = cell.payload || {};
    const preferred = cell.phase === "failed" ? [...payload.stdout_preview || [], ...payload.stderr_preview || []] : [...payload.stderr_preview || [], ...payload.stdout_preview || []];
    return readableOutputLines(cell, preferred);
  }
  function commandPresentation(cell) {
    const payload = cell.payload || {};
    const command = payload.command || "command";
    if (cell.phase === "started" || cell.phase === "updated") {
      return {
        status: "active",
        title: `Running ${command}`,
        lines: outputLines(cell),
        detail: outputLines(cell).at(-1) || command
      };
    }
    if (cell.phase === "failed") {
      const terminalTitles = {
        canceled: "Canceled",
        timed_out: "Timed out",
        interrupted: "Interrupted"
      };
      const terminalTitle = terminalTitles[payload.state];
      const exit = Number.isInteger(payload.exit_code) ? ` (exit ${payload.exit_code})` : "";
      const lines2 = outputLines(cell);
      if (!lines2.length && payload.error_message) lines2.push(payload.error_message);
      return {
        status: "failed",
        title: terminalTitle ? `${terminalTitle} ${command}` : `Failed${exit} ${command}`,
        lines: compactLines(lines2),
        detail: compactLines(lines2).at(-1) || command
      };
    }
    const lines = outputLines(cell);
    if (!lines.length) lines.push("(no output)");
    return {
      status: "completed",
      title: `Ran ${command}`,
      lines,
      detail: lines.at(-1) || command
    };
  }
  function explorationPresentation(cell) {
    if (cell.phase === "failed") {
      const payload = cell.payload || {};
      return {
        status: "failed",
        title: "Failed to explore",
        lines: compactLines([payload.diagnostic || payload.error_code || "Exploration failed"]),
        detail: payload.diagnostic || payload.error_code || "Exploration failed"
      };
    }
    const lines = (cell.entries || []).map((entry) => {
      const detail = entry.detail ? ` \xB7 ${entry.detail}` : "";
      return `${entry.verb} ${entry.label}${detail}`;
    });
    return {
      status: cell.phase === "started" || cell.phase === "updated" ? "active" : "completed",
      title: cell.phase === "started" || cell.phase === "updated" ? "Exploring" : "Explored",
      lines: compactLines(lines),
      detail: lines.at(-1) || "Explored workspace"
    };
  }
  function fileStat(change) {
    const additions = Number(change?.additions || 0);
    const deletions = Number(change?.deletions || 0);
    return `(+${additions} -${deletions})`;
  }
  function patchPresentation(cell) {
    const payload = cell.payload || {};
    if (cell.phase === "started" || cell.phase === "updated") {
      return {
        status: "active",
        title: payload.dry_run ? "Checking patch" : "Applying patch",
        lines: [],
        detail: payload.dry_run ? "Checking patch" : "Applying patch"
      };
    }
    if (cell.phase === "failed") {
      return {
        status: "failed",
        marker: "\u2718",
        title: "Failed to apply patch",
        lines: compactLines([payload.diagnostic || payload.error_code || "Patch failed"]),
        detail: payload.diagnostic || payload.error_code || "Patch failed"
      };
    }
    const changes = payload.changed_files || [];
    const additions = changes.reduce((sum, item) => sum + Number(item.additions || 0), 0);
    const deletions = changes.reduce((sum, item) => sum + Number(item.deletions || 0), 0);
    let title = `${payload.dry_run ? "Checked" : "Edited"} ${changes.length} files (+${additions} -${deletions})`;
    if (changes.length === 1) {
      const change = changes[0];
      const verb = payload.dry_run ? "Checked" : change.operation === "added" ? "Added" : change.operation === "deleted" ? "Deleted" : "Edited";
      title = `${verb} ${change.path} ${fileStat(change)}`;
    }
    return {
      status: "completed",
      title,
      lines: leadingLines(changes.map((change) => `${change.path} ${fileStat(change)}`)),
      detail: payload.diff_stat || title
    };
  }
  function writePresentation(cell) {
    const payload = cell.payload || {};
    if (cell.phase === "started" || cell.phase === "updated") {
      const title = `${payload.dry_run ? "Checking" : "Writing"} ${payload.path || "file"}`;
      return { status: "active", title, lines: [], detail: payload.path || "file" };
    }
    if (cell.phase === "failed") {
      return {
        status: "failed",
        title: `Failed to write ${payload.path || "file"}`,
        lines: compactLines([payload.diagnostic || payload.error_code || "Write failed"]),
        detail: payload.diagnostic || payload.error_code || "Write failed"
      };
    }
    const verb = payload.dry_run || payload.operation === "unchanged" ? "Checked" : payload.operation === "added" ? "Created" : "Wrote";
    const changes = payload.changed_files || [];
    return {
      status: "completed",
      title: `${verb} ${payload.path || "file"}`,
      lines: compactLines(changes.map((change) => `${change.path} ${fileStat(change)}`)),
      detail: payload.diff_stat || payload.path || "file"
    };
  }
  function skillPresentation(cell) {
    const payload = cell.payload || {};
    const active = cell.phase === "started" || cell.phase === "updated";
    if (payload.operation === "read") {
      const label2 = [payload.skill_id, payload.path].filter(Boolean).join(" / ");
      return {
        status: cell.phase === "failed" ? "failed" : active ? "active" : "completed",
        title: cell.phase === "failed" ? `Failed to read skill ${label2}` : active ? `Reading skill ${label2}` : `Read skill ${label2}`,
        lines: compactLines([cell.phase === "failed" ? payload.diagnostic : payload.returned_lines]),
        detail: label2
      };
    }
    const ids = payload.skill_ids || [];
    const label = ids.join(", ") || "skill";
    return {
      status: cell.phase === "failed" ? "failed" : active ? "active" : "completed",
      title: cell.phase === "failed" ? `Failed to load skill ${label}` : active ? `Loading skill ${label}` : `Loaded skill ${label}`,
      lines: compactLines([cell.phase === "failed" ? payload.diagnostic : ""]),
      detail: label
    };
  }
  function legacyPresentation(cell) {
    const summary = cell.payload?.summary || {};
    const action = summary.action;
    const detail = summary.detail || "";
    const titles = {
      prepareWorkspace: "Prepared workspace",
      workspaceCommand: "Ran command",
      workspaceInspect: "Explored",
      workspaceSearch: "Explored",
      workspaceReadFiles: "Explored",
      workspaceApplyPatch: "Edited files",
      workspaceWriteFile: "Wrote file",
      loadSkills: "Loaded skill",
      readSkillContent: "Read skill",
      gptGetSectionLocator: "Got section locator",
      gptGetExerciseLocator: "Got exercise locator",
      gptListChapterExercises: "Listed chapter exercises"
    };
    return {
      status: "completed",
      title: titles[action] || "Completed action",
      lines: compactLines([detail]),
      detail: detail || titles[action] || "Completed action"
    };
  }
  function locatorPresentation(cell) {
    const payload = cell.payload || {};
    const active = cell.phase === "started" || cell.phase === "updated";
    const status = cell.phase === "failed" ? "failed" : active ? "active" : "completed";
    const pageLabel = payload.printed_page_start && payload.printed_page_end ? payload.printed_page_start === payload.printed_page_end ? `Page ${payload.printed_page_start}` : `Pages ${payload.printed_page_start}\u2013${payload.printed_page_end}` : "";
    const referenceLabel = Number.isInteger(payload.reference_count) ? `${payload.reference_count} ${payload.reference_count === 1 ? "reference" : "references"}` : "";
    const definitions = {
      get_section_locator: {
        active: `Getting section locator ${payload.section_id || ""}`.trim(),
        completed: `Got section locator ${payload.section_id || ""}`.trim(),
        failed: `Failed to get section locator ${payload.section_id || ""}`.trim(),
        lines: [
          payload.title,
          pageLabel
        ],
        detail: payload.section_id || "section locator"
      },
      get_exercise_locator: {
        active: `Getting exercise locator ${payload.exercise_id || ""}`.trim(),
        completed: `Got exercise locator ${payload.exercise_id || ""}`.trim(),
        failed: `Failed to get exercise locator ${payload.exercise_id || ""}`.trim(),
        lines: [
          pageLabel,
          referenceLabel
        ],
        detail: payload.exercise_id || "exercise locator"
      },
      list_chapter_exercises: {
        active: `Listing chapter ${payload.chapter_id || ""} exercises`.trim(),
        completed: `Listed chapter ${payload.chapter_id || ""} exercises`.trim(),
        failed: `Failed to list chapter ${payload.chapter_id || ""} exercises`.trim(),
        lines: [
          Number.isInteger(payload.exercise_count) ? `${payload.exercise_count} exercises` : "",
          payload.first_exercise && payload.last_exercise ? `${payload.first_exercise}\u2013${payload.last_exercise}` : ""
        ],
        detail: payload.chapter_id ? `chapter ${payload.chapter_id}` : "chapter exercises"
      }
    };
    const definition = definitions[payload.operation];
    if (!definition) return null;
    const lines = [...definition.lines];
    if (cell.phase === "failed") lines.push(payload.diagnostic || payload.error_code || "Action failed");
    return {
      status,
      title: definition[status],
      lines: compactLines(lines),
      detail: definition.detail
    };
  }
  function genericPresentation(cell) {
    const payload = cell.payload || {};
    const active = cell.phase === "started" || cell.phase === "updated";
    const locator = locatorPresentation(cell);
    if (locator) return locator;
    if (payload.operation === "prepare_workspace") {
      const title2 = cell.phase === "failed" ? "Failed to prepare workspace" : active ? "Preparing workspace" : "Prepared workspace";
      return {
        status: cell.phase === "failed" ? "failed" : active ? "active" : "completed",
        title: title2,
        lines: compactLines([payload.diagnostic || payload.workspace_id]),
        detail: payload.workspace_id || title2
      };
    }
    const status = cell.phase === "failed" ? "failed" : active ? "active" : "completed";
    const title = status === "failed" ? "Failed action" : status === "active" ? "Running action" : "Completed action";
    const detail = payload.diagnostic || (status === "failed" ? "Action failed" : status === "active" ? "Action in progress" : "Action completed");
    return {
      status,
      title,
      lines: compactLines([payload.diagnostic || ""]),
      detail
    };
  }
  function presentActivity(cell) {
    if (!cell) return { status: "completed", marker: "\u2022", title: "GPT Actions", lines: [], detail: "" };
    if (cell.kind === "command") return commandPresentation(cell);
    if (cell.kind === "exploration") return explorationPresentation(cell);
    if (cell.kind === "patch") return patchPresentation(cell);
    if (cell.kind === "write") return writePresentation(cell);
    if (cell.kind === "skill") return skillPresentation(cell);
    if (cell.kind === "legacy") return legacyPresentation(cell);
    return genericPresentation(cell);
  }
  function compactActivity(cell) {
    const presentation = presentActivity(cell);
    return {
      action: presentation.title,
      detail: presentation.detail || presentation.lines.at(-1) || "",
      status: presentation.status
    };
  }

  // src/api/action-log-client.js
  function createActionLogClient({
    getProfile,
    onItems,
    onHint,
    onStatus,
    onAttention,
    initialCursor = null,
    onCursor
  }) {
    let lastId = Number.isInteger(initialCursor) ? initialCursor : 0;
    let needsCursorPrime = !Number.isInteger(initialCursor);
    let stopped = false;
    let requestHandle = null;
    let requestGeneration = 0;
    let pollTimer = null;
    function clearPollTimer() {
      if (pollTimer !== null) {
        window.clearTimeout(pollTimer);
        pollTimer = null;
      }
    }
    function schedulePoll(delay = 30) {
      clearPollTimer();
      pollTimer = window.setTimeout(() => {
        pollTimer = null;
        poll();
      }, delay);
    }
    function abortRequest() {
      const active = requestHandle;
      requestHandle = null;
      if (active && typeof active.abort === "function") {
        try {
          active.abort();
        } catch (_) {
        }
      }
    }
    function suspend() {
      requestGeneration += 1;
      clearPollTimer();
      abortRequest();
    }
    function resume() {
      if (!stopped) schedulePoll(0);
    }
    function stop() {
      stopped = true;
      suspend();
    }
    function start() {
      stopped = false;
      schedulePoll(0);
    }
    function scheduleRetry(message) {
      onHint(message);
      onAttention?.("\u8FDE\u63A5\u5F02\u5E38", "3 \u79D2\u540E\u91CD\u8BD5");
      onStatus?.("error");
      schedulePoll(RETRY_MS);
    }
    function poll() {
      if (stopped || requestHandle || document.visibilityState !== "visible") return;
      const profile = getProfile();
      if (!profile) return;
      const headers = {};
      if (profile.token) headers.Authorization = `Bearer ${profile.token}`;
      const generation = ++requestGeneration;
      const priming = needsCursorPrime;
      const wait = priming ? 0 : POLL_WAIT_SECONDS;
      const after = priming ? Number.MAX_SAFE_INTEGER : lastId;
      requestHandle = GM_xmlhttpRequest({
        method: "GET",
        url: `${profile.backend}/v1/action-logs?after=${after}&wait=${wait}&limit=${priming ? 1 : 50}`,
        headers,
        timeout: (wait + 5) * 1e3,
        onload(response) {
          if (generation !== requestGeneration) return;
          requestHandle = null;
          if (response.status === 401) {
            stopped = true;
            onHint("\u8BA4\u8BC1\u5931\u8D25\uFF1A\u8BF7\u68C0\u67E5 Bearer Token\u3002");
            onAttention?.("\u8BA4\u8BC1\u5931\u8D25", "\u68C0\u67E5 Bearer Token");
            onStatus?.("error");
            return;
          }
          if (response.status < 200 || response.status >= 300) {
            scheduleRetry(`\u540E\u7AEF\u8FD4\u56DE HTTP ${response.status}\uFF0C3 \u79D2\u540E\u91CD\u8BD5\u3002`);
            return;
          }
          try {
            const body = JSON.parse(response.responseText);
            if (Number.isInteger(body.last_id)) {
              lastId = body.last_id;
              onCursor?.(lastId);
            }
            if (priming) {
              needsCursorPrime = false;
              onStatus?.("idle");
              schedulePoll(0);
              return;
            }
            onItems(body.items || []);
            schedulePoll();
          } catch (error) {
            scheduleRetry(`\u54CD\u5E94\u89E3\u6790\u5931\u8D25\uFF1A${String(error)}`);
          }
        },
        onerror() {
          if (generation === requestGeneration) {
            requestHandle = null;
            scheduleRetry("\u8FDE\u63A5\u540E\u7AEF\u5931\u8D25\uFF0C3 \u79D2\u540E\u91CD\u8BD5\u3002");
          }
        },
        ontimeout() {
          if (generation === requestGeneration) {
            requestHandle = null;
            schedulePoll(100);
          }
        },
        onabort() {
          if (generation === requestGeneration) requestHandle = null;
        }
      });
    }
    function getCursor() {
      return needsCursorPrime ? null : lastId;
    }
    return { start, stop, suspend, resume, poll, getCursor };
  }

  // src/api/skill-catalog-client.js
  function createSkillCatalogClient({ getProfile }) {
    const cache = /* @__PURE__ */ new Map();
    const pending = /* @__PURE__ */ new Map();
    const storagePrefix = "gptActionMonitorSkillCatalog:";
    function profileKey(profile) {
      return `${profile.id || ""}\0${profile.backend}`;
    }
    function requestCatalog(profile, key) {
      const headers = {};
      if (profile.token) headers.Authorization = `Bearer ${profile.token}`;
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "GET",
          url: `${profile.backend}/v1/skills`,
          headers,
          timeout: 7e3,
          onload(response) {
            if (response.status === 401) {
              reject(new Error("\u8BA4\u8BC1\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5 Bearer Token\u3002"));
              return;
            }
            if (response.status < 200 || response.status >= 300) {
              reject(new Error(`\u540E\u7AEF\u8FD4\u56DE HTTP ${response.status}\u3002`));
              return;
            }
            try {
              const body = JSON.parse(response.responseText);
              const skills = Array.isArray(body.skills) ? body.skills : [];
              const normalized = skills.filter((skill) => skill && typeof skill.skill_id === "string").map((skill) => ({
                skill_id: skill.skill_id,
                name: typeof skill.name === "string" ? skill.name : skill.skill_id,
                description: typeof skill.description === "string" ? skill.description : ""
              }));
              cache.set(key, normalized);
              GM_setValue(`${storagePrefix}${key}`, normalized);
              resolve(normalized);
            } catch (error) {
              reject(new Error(`Skill \u5217\u8868\u89E3\u6790\u5931\u8D25\uFF1A${String(error)}`));
            }
          },
          onerror() {
            reject(new Error("\u65E0\u6CD5\u8FDE\u63A5\u540E\u7AEF\u3002"));
          },
          ontimeout() {
            reject(new Error("\u8BFB\u53D6 Skill \u5217\u8868\u8D85\u65F6\u3002"));
          }
        });
      });
    }
    async function list({ refresh = false } = {}) {
      const profile = getProfile();
      if (!profile) throw new Error("\u6CA1\u6709\u6D3B\u52A8\u7684\u540E\u7AEF\u914D\u7F6E\u3002");
      const key = profileKey(profile);
      if (!refresh && cache.has(key)) {
        return cache.get(key);
      }
      if (!refresh) {
        const stored = GM_getValue(`${storagePrefix}${key}`, null);
        if (Array.isArray(stored)) {
          cache.set(key, stored);
          return stored;
        }
      }
      if (pending.has(key)) {
        return pending.get(key);
      }
      const request = requestCatalog(profile, key).finally(() => {
        if (pending.get(key) === request) pending.delete(key);
      });
      pending.set(key, request);
      return request;
    }
    return { list };
  }

  // src/adapters/chatgpt.js
  function createChatGPTAdapter({ getProfiles, onActivate, onDeactivate }) {
    let observer = null;
    let activeTitleElement = null;
    let activeProfileId = null;
    function titleName(element) {
      if (!element) return "";
      const directText = [...element.childNodes || []].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent || "").join(" ").replace(/\s+/g, " ").trim();
      if (directText) return directText;
      return (element.textContent || "").replace(/\s+/g, " ").trim();
    }
    function matchingProfile(element) {
      if (!element || element.nodeType !== Node.ELEMENT_NODE || !element.matches(GPT_TITLE_SELECTOR)) return null;
      return getProfiles().find((profile) => profile.enabled && profile.gptName === titleName(element)) || null;
    }
    function findTargetTitle(root = document) {
      if (root.nodeType === Node.ELEMENT_NODE) {
        const profile = matchingProfile(root);
        if (profile) return { element: root, profile };
      }
      if (typeof root.querySelectorAll !== "function") return null;
      for (const element of root.querySelectorAll(GPT_TITLE_SELECTOR)) {
        const profile = matchingProfile(element);
        if (profile) return { element, profile };
      }
      return null;
    }
    function evaluateActivation() {
      const target = findTargetTitle(document);
      if (target) activate(target.element, target.profile);
      else deactivate();
    }
    function activate(element, profile) {
      activeTitleElement = element;
      activeProfileId = profile.id;
      onActivate(element, profile);
    }
    function deactivate() {
      activeTitleElement = null;
      activeProfileId = null;
      onDeactivate();
    }
    function targetFromMutation(mutation) {
      const mutationElement = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
      const containingTitle = mutationElement?.closest?.(GPT_TITLE_SELECTOR);
      const containingProfile = matchingProfile(containingTitle);
      if (containingProfile) return { element: containingTitle, profile: containingProfile };
      for (const node of mutation.addedNodes) {
        const target = findTargetTitle(node);
        if (target) return target;
      }
      return null;
    }
    function start() {
      if (observer || !document.body) return;
      observer = new MutationObserver((mutations) => {
        if (activeProfileId) {
          const currentProfile = activeTitleElement?.isConnected ? matchingProfile(activeTitleElement) : null;
          if (currentProfile?.id === activeProfileId) return;
          evaluateActivation();
          return;
        }
        for (const mutation of mutations) {
          const target = targetFromMutation(mutation);
          if (target) {
            activate(target.element, target.profile);
            return;
          }
        }
      });
      observer.observe(document.body, { childList: true, characterData: true, subtree: true });
      evaluateActivation();
    }
    function stop() {
      observer?.disconnect();
      observer = null;
    }
    return { start, stop, evaluateActivation };
  }

  // src/adapters/composer.js
  var CONTENTEDITABLE_SELECTOR = '[data-composer-body] #prompt-textarea[contenteditable="true"], #prompt-textarea[contenteditable="true"]';
  var TEXTAREA_SELECTOR = '[data-composer-body] textarea[name="prompt-textarea"], textarea[name="prompt-textarea"]';
  function containsNode(root, node) {
    if (!root || !node) return false;
    if (root === node) return true;
    return typeof root.contains === "function" ? root.contains(node) : false;
  }
  function createComposerAdapter() {
    let savedRange = null;
    let savedTextareaSelection = null;
    function findContenteditable() {
      return document.querySelector(CONTENTEDITABLE_SELECTOR);
    }
    function findTextarea() {
      const textarea = document.querySelector(TEXTAREA_SELECTOR);
      return textarea && textarea.offsetParent !== null ? textarea : null;
    }
    function captureSelection() {
      savedRange = null;
      savedTextareaSelection = null;
      const textarea = findTextarea();
      if (textarea && document.activeElement === textarea) {
        savedTextareaSelection = {
          element: textarea,
          start: textarea.selectionStart,
          end: textarea.selectionEnd
        };
        return true;
      }
      const editor = findContenteditable();
      const selection = window.getSelection?.();
      if (!editor || !selection || selection.rangeCount === 0) return false;
      const range = selection.getRangeAt(0);
      if (!containsNode(editor, range.commonAncestorContainer)) return false;
      savedRange = range.cloneRange();
      return true;
    }
    function placeCaretAtEnd(editor) {
      const selection = window.getSelection?.();
      if (!selection || typeof document.createRange !== "function") return false;
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }
    function restoreRange(editor) {
      if (!savedRange || !containsNode(editor, savedRange.commonAncestorContainer)) {
        return placeCaretAtEnd(editor);
      }
      const selection = window.getSelection?.();
      if (!selection) return false;
      selection.removeAllRanges();
      selection.addRange(savedRange);
      return true;
    }
    function insertIntoTextarea(textarea, text) {
      const saved = savedTextareaSelection?.element === textarea ? savedTextareaSelection : null;
      const start = saved?.start ?? textarea.selectionStart ?? textarea.value.length;
      const end = saved?.end ?? textarea.selectionEnd ?? start;
      textarea.focus({ preventScroll: true });
      textarea.setRangeText(text, start, end, "end");
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      return true;
    }
    function insertText(text) {
      const textarea = findTextarea();
      if (textarea) {
        const inserted2 = insertIntoTextarea(textarea, text);
        savedTextareaSelection = null;
        savedRange = null;
        return inserted2;
      }
      const editor = findContenteditable();
      if (!editor) return false;
      editor.focus({ preventScroll: true });
      restoreRange(editor);
      const inserted = typeof document.execCommand === "function" ? document.execCommand("insertText", false, text) : false;
      savedRange = null;
      savedTextareaSelection = null;
      return Boolean(inserted);
    }
    return { captureSelection, insertText };
  }
  function loadSkillsCall(skillId) {
    return `loadSkills(${JSON.stringify([skillId])})`;
  }

  // src/profile/profile-store.js
  function createProfileId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `profile-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
  function normalizeBackend(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }
  function normalizeProfile(profile) {
    return {
      id: String(profile?.id || createProfileId()),
      gptName: String(profile?.gptName || "").trim(),
      backend: normalizeBackend(profile?.backend),
      token: String(profile?.token || "").trim(),
      enabled: profile?.enabled !== false
    };
  }
  function loadProfiles() {
    const stored = GM_getValue(PROFILES_KEY, null);
    if (!Array.isArray(stored)) return [];
    return stored.map(normalizeProfile).filter((profile) => profile.gptName && profile.backend);
  }
  function saveProfiles(profiles) {
    const normalized = profiles.map(normalizeProfile);
    GM_setValue(PROFILES_KEY, normalized);
    return normalized;
  }
  function validateBackend(value) {
    const backend = normalizeBackend(value);
    let parsed;
    try {
      parsed = new URL(backend);
    } catch (_) {
      return { ok: false, message: "\u8BF7\u8F93\u5165\u6709\u6548\u7684\u540E\u7AEF URL\u3002" };
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { ok: false, message: "\u540E\u7AEF\u5730\u5740\u4EC5\u652F\u6301 http:// \u6216 https://\u3002" };
    }
    return { ok: true, backend };
  }

  // src/ui/styles.js
  var MONITOR_CSS = `
    #gpt-action-monitor {
      position: fixed;
      right: 0;
      top: 36vh;
      width: 30px;
      height: 40px;
      z-index: 2147483647;
      color: CanvasText;
      color-scheme: light dark;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 12px;
      line-height: 1.35;
    }
    #gpt-action-monitor button { font: inherit; }
    #gpt-action-monitor .gam-compact {
      position: relative;
      width: 30px;
      height: 40px;
    }
    #gpt-action-monitor .gam-handle {
      box-sizing: border-box;
      width: 30px;
      height: 40px;
      display: grid;
      place-items: center;
      padding: 0;
      border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
      border-right: 0;
      border-radius: 13px 0 0 13px;
      background: color-mix(in srgb, Canvas 97%, CanvasText 3%);
      color: CanvasText;
      box-shadow: 0 3px 10px rgba(0, 0, 0, .08);
      cursor: grab;
      touch-action: none;
    }
    #gpt-action-monitor.gam-detached .gam-handle {
      border-right: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
      border-radius: 13px;
    }
    #gpt-action-monitor .gam-handle:hover,
    #gpt-action-monitor .gam-handle:focus-visible {
      background: color-mix(in srgb, Canvas 92%, CanvasText 8%);
    }
    #gpt-action-monitor .gam-dot {
      width: 8px;
      height: 8px;
      display: inline-block;
      flex: 0 0 8px;
      border-radius: 50%;
      background: #8b8b8b;
    }
    #gpt-action-monitor[data-status="active"] .gam-dot { background: #22a35a; }
    #gpt-action-monitor[data-status="error"] .gam-dot { background: #d84a4a; }
    #gpt-action-monitor .gam-chip {
      position: absolute;
      right: 36px;
      top: 2px;
      width: min(250px, calc(100vw - 54px));
      height: 36px;
      box-sizing: border-box;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: 7px;
      padding: 0 11px;
      overflow: hidden;
      border: 1px solid color-mix(in srgb, CanvasText 13%, transparent);
      border-radius: 18px;
      background: color-mix(in srgb, Canvas 97%, CanvasText 3%);
      box-shadow: 0 3px 12px rgba(0, 0, 0, .08);
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transform: translateX(6px);
      transition: opacity .12s ease, transform .12s ease;
    }
    #gpt-action-monitor.gam-chip-right .gam-chip {
      right: auto;
      left: 36px;
      transform: translateX(-6px);
    }
    #gpt-action-monitor.gam-chip-visible .gam-chip,
    #gpt-action-monitor .gam-compact:hover .gam-chip,
    #gpt-action-monitor .gam-compact:focus-within .gam-chip {
      opacity: 1;
      transform: translateX(0);
    }
    #gpt-action-monitor .gam-current-action {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      font-weight: 600;
    }
    #gpt-action-monitor .gam-current-detail {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      opacity: .62;
    }
    #gpt-action-monitor.gam-dragging .gam-chip { opacity: 0; }
    #gpt-action-monitor.gam-dragging .gam-handle,
    #gpt-action-monitor.gam-dragging .gam-header { cursor: grabbing; }
    #gpt-action-monitor .gam-resize-handle {
      position: absolute;
      left: 0;
      bottom: 0;
      width: 22px;
      height: 22px;
      z-index: 2;
      padding: 0;
      border: 0;
      border-radius: 0 8px 0 10px;
      background: transparent;
      color: color-mix(in srgb, CanvasText 44%, transparent);
      cursor: nesw-resize;
      touch-action: none;
    }
    #gpt-action-monitor .gam-resize-handle::before {
      content: "";
      position: absolute;
      left: 5px;
      bottom: 5px;
      width: 10px;
      height: 10px;
      background: repeating-linear-gradient(
        45deg,
        transparent 0 3px,
        currentColor 3px 4px
      );
      clip-path: polygon(0 0, 0 100%, 100% 100%);
      opacity: .72;
      pointer-events: none;
    }
    #gpt-action-monitor .gam-resize-handle:hover,
    #gpt-action-monitor .gam-resize-handle:focus-visible {
      color: color-mix(in srgb, CanvasText 72%, transparent);
      background: color-mix(in srgb, CanvasText 5%, transparent);
      outline: none;
    }
    #gpt-action-monitor .gam-resize-handle:focus-visible {
      box-shadow: inset 0 0 0 1px color-mix(in srgb, CanvasText 30%, transparent);
    }
    #gpt-action-monitor.gam-resizing .gam-resize-handle { cursor: nesw-resize; }
    #gpt-action-monitor .gam-expanded { display: none; }
    #gpt-action-monitor.gam-open {
      width: auto;
      height: auto;
    }
    #gpt-action-monitor.gam-open .gam-compact { display: none; }
    #gpt-action-monitor.gam-open .gam-expanded {
      position: relative;
      width: min(380px, calc(100vw - 16px));
      height: min(420px, 62vh);
      min-width: min(280px, calc(100vw - 16px));
      min-height: min(220px, calc(100vh - 16px));
      max-width: calc(100vw - 16px);
      max-height: calc(100vh - 16px);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      resize: both;
      box-sizing: border-box;
      border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
      border-radius: 12px;
      background: color-mix(in srgb, Canvas 98%, CanvasText 2%);
      color: CanvasText;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .12);
    }
    #gpt-action-monitor .gam-header {
      height: 38px;
      flex: 0 0 38px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 10px 0 12px;
      border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
      font-size: 12px;
      font-weight: 600;
      cursor: grab;
      user-select: none;
      touch-action: none;
    }
    #gpt-action-monitor .gam-header > span {
      display: flex;
      align-items: center;
      gap: 7px;
    }
    #gpt-action-monitor .gam-header-controls {
      display: flex;
      align-items: center;
      gap: 3px;
    }
    #gpt-action-monitor .gam-skills-button,
    #gpt-action-monitor .gam-skills-refresh {
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: inherit;
      cursor: pointer;
    }
    #gpt-action-monitor .gam-skills-button {
      height: 28px;
      padding: 0 7px;
      font-size: 11px;
      font-weight: 600;
    }
    #gpt-action-monitor .gam-skills-button:hover,
    #gpt-action-monitor .gam-skills-button:focus-visible,
    #gpt-action-monitor .gam-skills-refresh:hover,
    #gpt-action-monitor .gam-skills-refresh:focus-visible {
      background: color-mix(in srgb, CanvasText 7%, transparent);
    }
    #gpt-action-monitor .gam-close {
      width: 28px;
      height: 28px;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font-size: 17px;
      line-height: 1;
    }
    #gpt-action-monitor .gam-close:hover { background: color-mix(in srgb, CanvasText 7%, transparent); }
    #gpt-action-monitor .gam-activity-root {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      padding: 6px 8px 8px;
    }
    #gpt-action-monitor .gam-monitor-hint {
      margin: 4px 2px 8px;
      padding: 7px 9px;
      border-radius: 8px;
      background: color-mix(in srgb, #d84a4a 9%, transparent);
      color: color-mix(in srgb, CanvasText 76%, transparent);
      font-size: 11px;
    }
    #gpt-action-monitor .gam-monitor-hint[hidden],
    #gpt-action-monitor .gam-activity-section[hidden] { display: none; }
    #gpt-action-monitor .gam-activity-section + .gam-activity-section {
      margin-top: 9px;
      padding-top: 8px;
      border-top: 1px solid color-mix(in srgb, CanvasText 8%, transparent);
    }
    #gpt-action-monitor .gam-now-section {
      flex: 0 1 auto;
      max-height: 45%;
      overflow-y: auto;
      scrollbar-width: thin;
    }
    #gpt-action-monitor .gam-recent-section {
      min-height: 0;
      flex: 1 1 auto;
      overflow-y: auto;
      scrollbar-width: thin;
    }
    #gpt-action-monitor .gam-activity-section-label {
      padding: 2px 8px 5px;
      color: color-mix(in srgb, CanvasText 44%, transparent);
      font: 600 10px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: .08em;
    }
    #gpt-action-monitor .gam-activity-cell {
      padding: 7px 8px 8px;
      border-radius: 8px;
    }
    #gpt-action-monitor .gam-activity-cell:hover {
      background: color-mix(in srgb, CanvasText 4%, transparent);
    }
    #gpt-action-monitor .gam-activity-title {
      display: flex;
      align-items: flex-start;
      gap: 7px;
      min-width: 0;
    }
    #gpt-action-monitor .gam-activity-marker {
      width: 12px;
      flex: 0 0 12px;
      text-align: center;
      opacity: .62;
      font-weight: 700;
    }
    #gpt-action-monitor .gam-activity-cell[data-status="active"] .gam-activity-marker {
      color: #22a35a;
      opacity: 1;
    }
    #gpt-action-monitor .gam-activity-cell[data-status="failed"] .gam-activity-marker {
      color: #d84a4a;
      opacity: 1;
    }
    #gpt-action-monitor .gam-activity-cell[data-kind="patch"][data-status="failed"] .gam-activity-marker {
      color: #a855c7;
    }
    #gpt-action-monitor .gam-activity-label {
      min-width: 0;
      overflow: hidden;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 3;
      overflow-wrap: anywhere;
      white-space: normal;
      font-weight: 590;
    }
    #gpt-action-monitor .gam-activity-details {
      margin: 3px 0 0 19px;
      color: color-mix(in srgb, CanvasText 62%, transparent);
      font: 11px/1.42 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    #gpt-action-monitor .gam-activity-detail-line {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #gpt-action-monitor .gam-activity-detail-line::before {
      content: "  ";
      opacity: .48;
    }
    #gpt-action-monitor .gam-activity-detail-line:first-child::before { content: "\u2514 "; }
    #gpt-action-monitor .gam-skills-picker {
      position: absolute;
      top: 34px;
      right: 8px;
      width: 220px;
      z-index: 3;
      max-height: 240px;
      overflow-y: auto;
      background: color-mix(in srgb, Canvas 98%, CanvasText 2%);
      border: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
      border-radius: 10px;
      box-shadow: 0 8px 24px color-mix(in srgb, CanvasText 12%, transparent);
    }
    #gpt-action-monitor .gam-skills-picker[hidden] { display: none; }
    #gpt-action-monitor .gam-skills-picker-header {
      height: 34px;
      flex: 0 0 34px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 7px 0 10px;
      border-bottom: 1px solid color-mix(in srgb, CanvasText 8%, transparent);
      font-size: 11px;
    }
    #gpt-action-monitor .gam-skills-refresh {
      width: 26px;
      height: 26px;
      padding: 0;
      font-size: 16px;
      line-height: 1;
      opacity: .55;
    }
    #gpt-action-monitor .gam-skills-list {
      min-height: 0;
      overflow-y: auto;
      padding: 5px;
      scrollbar-width: thin;
    }
    #gpt-action-monitor .gam-skill-item {
      width: 100%;
      min-height: 32px;
      display: grid;
      align-items: center;
      padding: 8px 9px;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      text-align: left;
    }
    #gpt-action-monitor .gam-skill-item:hover,
    #gpt-action-monitor .gam-skill-item:focus-visible {
      background: color-mix(in srgb, CanvasText 7%, transparent);
      outline: none;
    }
    #gpt-action-monitor .gam-skill-id {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }
    #gpt-action-monitor .gam-skills-state {
      padding: 12px 10px;
      color: color-mix(in srgb, CanvasText 58%, transparent);
      font-size: 11px;
    }
    @media (prefers-reduced-motion: reduce) {
      #gpt-action-monitor .gam-chip { transition: none; }
    }
  `;
  var SETTINGS_CSS = `
      #gam-settings-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: grid;
        place-items: center;
        padding: 20px;
        box-sizing: border-box;
        background: rgba(0, 0, 0, .28);
        color-scheme: light dark;
        font: 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #gam-settings-overlay * { box-sizing: border-box; }
      #gam-settings-overlay .gam-settings-card {
        width: min(620px, 100%);
        max-height: min(720px, calc(100vh - 40px));
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
        border-radius: 14px;
        background: Canvas;
        color: CanvasText;
        box-shadow: 0 18px 48px rgba(0, 0, 0, .22);
      }
      #gam-settings-overlay .gam-settings-header {
        height: 52px;
        flex: 0 0 52px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 14px 0 18px;
        border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
      }
      #gam-settings-overlay .gam-settings-title { font-size: 15px; font-weight: 650; }
      #gam-settings-overlay button,
      #gam-settings-overlay input { font: inherit; }
      #gam-settings-overlay button { color: inherit; }
      #gam-settings-overlay .gam-icon-button {
        width: 30px;
        height: 30px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        cursor: pointer;
        font-size: 19px;
      }
      #gam-settings-overlay .gam-icon-button:hover { background: color-mix(in srgb, CanvasText 7%, transparent); }
      #gam-settings-overlay .gam-settings-body {
        min-height: 0;
        overflow-y: auto;
        padding: 14px 16px 16px;
      }
      #gam-settings-overlay .gam-settings-note {
        margin: 0 0 12px;
        color: color-mix(in srgb, CanvasText 62%, transparent);
        font-size: 12px;
      }
      #gam-settings-overlay .gam-profile-list { display: grid; gap: 8px; }
      #gam-settings-overlay .gam-profile-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        align-items: center;
        min-height: 58px;
        padding: 9px 10px 9px 12px;
        border: 1px solid color-mix(in srgb, CanvasText 11%, transparent);
        border-radius: 10px;
      }
      #gam-settings-overlay .gam-profile-main { min-width: 0; }
      #gam-settings-overlay .gam-profile-name-line {
        display: flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
      }
      #gam-settings-overlay .gam-profile-state {
        width: 7px;
        height: 7px;
        flex: 0 0 7px;
        border-radius: 50%;
        background: #22a35a;
      }
      #gam-settings-overlay .gam-profile-row[data-enabled="false"] .gam-profile-state { background: #8b8b8b; }
      #gam-settings-overlay .gam-profile-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-weight: 620;
      }
      #gam-settings-overlay .gam-profile-backend {
        margin: 3px 0 0 14px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: color-mix(in srgb, CanvasText 58%, transparent);
        font-size: 12px;
      }
      #gam-settings-overlay .gam-button {
        min-height: 32px;
        padding: 5px 11px;
        border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
        border-radius: 8px;
        background: color-mix(in srgb, Canvas 96%, CanvasText 4%);
        cursor: pointer;
      }
      #gam-settings-overlay .gam-button:hover { background: color-mix(in srgb, Canvas 91%, CanvasText 9%); }
      #gam-settings-overlay .gam-button:disabled { cursor: default; opacity: .5; }
      #gam-settings-overlay .gam-button-primary {
        border-color: #2f7d4b;
        background: #237a42;
        color: white;
      }
      #gam-settings-overlay .gam-button-primary:hover { background: #1d6938; }
      #gam-settings-overlay .gam-list-footer {
        display: flex;
        justify-content: flex-start;
        margin-top: 12px;
      }
      #gam-settings-overlay .gam-empty {
        padding: 34px 18px;
        border: 1px dashed color-mix(in srgb, CanvasText 18%, transparent);
        border-radius: 10px;
        text-align: center;
        color: color-mix(in srgb, CanvasText 58%, transparent);
      }
      #gam-settings-overlay .gam-editor { display: grid; gap: 13px; }
      #gam-settings-overlay .gam-editor[hidden],
      #gam-settings-overlay .gam-list-view[hidden] { display: none; }
      #gam-settings-overlay .gam-field { display: grid; gap: 6px; }
      #gam-settings-overlay .gam-field > span { font-weight: 600; }
      #gam-settings-overlay .gam-input {
        width: 100%;
        height: 36px;
        padding: 0 10px;
        border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
        border-radius: 8px;
        background: Canvas;
        color: CanvasText;
        outline: none;
      }
      #gam-settings-overlay .gam-input:focus { border-color: #4f8e68; box-shadow: 0 0 0 2px rgba(35, 122, 66, .12); }
      #gam-settings-overlay .gam-token-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 7px; }
      #gam-settings-overlay .gam-check-row { display: flex; gap: 8px; align-items: center; }
      #gam-settings-overlay .gam-form-message { min-height: 19px; font-size: 12px; }
      #gam-settings-overlay .gam-form-message[data-state="error"] { color: #c53e3e; }
      #gam-settings-overlay .gam-form-message[data-state="success"] { color: #238349; }
      #gam-settings-overlay .gam-form-message[data-state="pending"] { color: color-mix(in srgb, CanvasText 60%, transparent); }
      #gam-settings-overlay .gam-editor-footer {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-top: 2px;
      }
      #gam-settings-overlay .gam-editor-footer .gam-spacer { flex: 1; }
      #gam-settings-overlay .gam-delete { color: #b63c3c; }
      @media (max-width: 520px) {
        #gam-settings-overlay { padding: 8px; }
        #gam-settings-overlay .gam-settings-card { max-height: calc(100vh - 16px); }
        #gam-settings-overlay .gam-editor-footer { flex-wrap: wrap; }
      }
    `;

  // src/ui/activity-panel.js
  function createCellNode() {
    const node = document.createElement("div");
    node.className = "gam-activity-cell";
    const title = document.createElement("div");
    title.className = "gam-activity-title";
    const marker = document.createElement("span");
    marker.className = "gam-activity-marker";
    const label = document.createElement("span");
    label.className = "gam-activity-label";
    title.append(marker, label);
    const details = document.createElement("div");
    details.className = "gam-activity-details";
    node.append(title, details);
    node._gam = { marker, label, details, signature: "" };
    return node;
  }
  function updateCellNode(node, cell) {
    const presentation = presentActivity(cell);
    const signature = JSON.stringify([
      cell.revision,
      cell.phase,
      presentation.status,
      presentation.marker,
      presentation.title,
      presentation.lines
    ]);
    if (node._gam.signature === signature) return;
    node._gam.signature = signature;
    node.dataset.status = presentation.status;
    node.dataset.kind = cell.kind;
    node._gam.marker.textContent = presentation.marker || "\u2022";
    node._gam.label.textContent = presentation.title;
    node.title = presentation.title;
    node._gam.details.replaceChildren();
    for (const line of presentation.lines) {
      const detail = document.createElement("div");
      detail.className = "gam-activity-detail-line";
      detail.textContent = line;
      node._gam.details.appendChild(detail);
    }
  }
  function syncList(container, cells, nodes) {
    const liveIds = new Set(cells.map((cell) => cell.id));
    for (const [id, node] of nodes) {
      if (!liveIds.has(id)) {
        node.remove();
        nodes.delete(id);
      }
    }
    for (const cell of cells) {
      let node = nodes.get(cell.id);
      if (!node) {
        node = createCellNode();
        nodes.set(cell.id, node);
      }
      updateCellNode(node, cell);
      container.appendChild(node);
    }
  }
  function createActivityPanel({ root }) {
    root.innerHTML = `
    <div class="gam-monitor-hint" hidden></div>
    <section class="gam-activity-section gam-now-section">
      <div class="gam-activity-section-label">NOW</div>
      <div class="gam-now-list"></div>
    </section>
    <section class="gam-activity-section gam-recent-section">
      <div class="gam-activity-section-label">RECENT</div>
      <div class="gam-recent-list"></div>
    </section>
  `;
    const hint = root.querySelector(".gam-monitor-hint");
    const nowSection = root.querySelector(".gam-now-section");
    const recentSection = root.querySelector(".gam-recent-section");
    const nowList = root.querySelector(".gam-now-list");
    const recentList = root.querySelector(".gam-recent-list");
    const nowNodes = /* @__PURE__ */ new Map();
    const recentNodes = /* @__PURE__ */ new Map();
    function render(snapshot) {
      syncList(nowList, snapshot.active || [], nowNodes);
      syncList(recentList, snapshot.recent || [], recentNodes);
      nowSection.hidden = !(snapshot.active || []).length;
      recentSection.hidden = !(snapshot.recent || []).length;
    }
    function setHint(message) {
      hint.textContent = message || "";
      hint.hidden = !message;
    }
    function clear() {
      nowNodes.clear();
      recentNodes.clear();
      nowList.replaceChildren();
      recentList.replaceChildren();
      nowSection.hidden = true;
      recentSection.hidden = true;
    }
    return { render, setHint, clear };
  }

  // src/ui/monitor-panel.js
  function createMonitorPanel({ activityStore, isActive, skillsMenu = null }) {
    const panel = document.createElement("div");
    panel.id = "gpt-action-monitor";
    panel.dataset.status = "idle";
    panel.innerHTML = `
    <div class="gam-compact">
      <div class="gam-chip" role="status" aria-live="polite" aria-atomic="true">
        <strong class="gam-current-action">GPT Actions</strong>
        <span class="gam-current-detail">\u7B49\u5F85 Action</span>
      </div>
      <button class="gam-handle" type="button" title="\u62D6\u52A8\u79FB\u52A8 \xB7 \u70B9\u51FB\u5C55\u5F00" aria-label="\u5C55\u5F00 GPT Activity">
        <span class="gam-dot"></span>
      </button>
    </div>
    <section class="gam-expanded" aria-label="GPT Activity">
      <div class="gam-header">
        <span><span class="gam-dot gam-header-dot"></span>GPT Actions</span>
        <div class="gam-header-controls">
          <button class="gam-skills-button" type="button" aria-haspopup="menu" aria-label="\u6253\u5F00 Skills">Skills \u203A</button>
          <button class="gam-close" type="button" title="\u6536\u8D77" aria-label="\u6536\u8D77 GPT Activity">\u2212</button>
        </div>
      </div>
      <div class="gam-activity-root" role="log" aria-label="Agent activity"></div>
      <button class="gam-resize-handle" type="button" title="\u62D6\u52A8\u6216\u4F7F\u7528\u65B9\u5411\u952E\u8C03\u6574\u5927\u5C0F" aria-label="\u4ECE\u5DE6\u4E0B\u89D2\u8C03\u6574 GPT Activity \u5927\u5C0F"></button>
    </section>
  `;
    const style = document.createElement("style");
    style.textContent = MONITOR_CSS;
    const handle = panel.querySelector(".gam-handle");
    const close = panel.querySelector(".gam-close");
    const skillsButton = panel.querySelector(".gam-skills-button");
    const header = panel.querySelector(".gam-header");
    const expanded = panel.querySelector(".gam-expanded");
    const resizeHandle = panel.querySelector(".gam-resize-handle");
    const activityRoot = panel.querySelector(".gam-activity-root");
    const currentAction = panel.querySelector(".gam-current-action");
    const currentDetail = panel.querySelector(".gam-current-detail");
    const activityPanel = createActivityPanel({ root: activityRoot });
    if (skillsMenu?.element) panel.querySelector(".gam-expanded").appendChild(skillsMenu.element);
    skillsMenu?.bindTrigger?.(skillsButton);
    let manualOpen = false;
    let suppressHandleClick = false;
    let activityTimer = null;
    let uiTimer = null;
    let pendingLatest = null;
    let lastHint = "";
    activityStore.subscribe((snapshot) => {
      if (manualOpen) activityPanel.render(snapshot);
    });
    function setStatus(state) {
      panel.dataset.status = state;
    }
    function getStatus() {
      return panel.dataset.status;
    }
    function updateChipSide() {
      if (panel.classList.contains("gam-open")) return;
      const rect = panel.getBoundingClientRect();
      panel.classList.toggle("gam-chip-right", rect.left < 275);
    }
    function savePosition() {
      const rect = panel.getBoundingClientRect();
      const docked = !panel.classList.contains("gam-detached");
      const compactLeft = panel.classList.contains("gam-open") ? rect.right - COMPACT_WIDTH : rect.left;
      GM_setValue(POSITION_KEY, {
        top: Math.round(rect.top),
        left: docked ? null : Math.round(compactLeft),
        docked
      });
    }
    function keepInViewport() {
      if (!panel.isConnected) return;
      const rect = panel.getBoundingClientRect();
      const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
      panel.style.top = `${Math.round(Math.min(Math.max(rect.top, 8), maxTop))}px`;
      if (panel.classList.contains("gam-detached")) {
        const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
        panel.style.left = `${Math.round(Math.min(Math.max(rect.left, 8), maxLeft))}px`;
        panel.style.right = "auto";
      } else {
        panel.style.left = "auto";
        panel.style.right = "0";
      }
      updateChipSide();
    }
    function restorePosition() {
      const saved = GM_getValue(POSITION_KEY, null);
      if (!saved || typeof saved !== "object") {
        updateChipSide();
        return;
      }
      if (Number.isFinite(saved.top)) panel.style.top = `${saved.top}px`;
      if (saved.docked === false && Number.isFinite(saved.left)) {
        panel.classList.add("gam-detached");
        panel.style.left = `${saved.left}px`;
        panel.style.right = "auto";
      }
      keepInViewport();
    }
    function makeDraggable(dragHandle, { suppressClick = false } = {}) {
      dragHandle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.target.closest(".gam-close, .gam-skills-button, .gam-skills-menu")) return;
        const startRect = panel.getBoundingClientRect();
        const startX = event.clientX;
        const startY = event.clientY;
        let dragging = false;
        panel.classList.add("gam-dragging");
        dragHandle.setPointerCapture(event.pointerId);
        const onMove = (moveEvent) => {
          const dx = moveEvent.clientX - startX;
          const dy = moveEvent.clientY - startY;
          if (!dragging && Math.hypot(dx, dy) < 4) return;
          if (!dragging) {
            dragging = true;
            panel.classList.add("gam-detached");
            panel.style.left = `${Math.round(startRect.left)}px`;
            panel.style.right = "auto";
          }
          const width = panel.getBoundingClientRect().width;
          const height = panel.getBoundingClientRect().height;
          const left = Math.min(Math.max(startRect.left + dx, 8), Math.max(8, window.innerWidth - width - 8));
          const top = Math.min(Math.max(startRect.top + dy, 8), Math.max(8, window.innerHeight - height - 8));
          panel.style.left = `${Math.round(left)}px`;
          panel.style.top = `${Math.round(top)}px`;
          updateChipSide();
        };
        const onEnd = () => {
          dragHandle.removeEventListener("pointermove", onMove);
          dragHandle.removeEventListener("pointerup", onEnd);
          dragHandle.removeEventListener("pointercancel", onEnd);
          panel.classList.remove("gam-dragging");
          if (!dragging) return;
          const rect = panel.getBoundingClientRect();
          if (window.innerWidth - rect.right < 28) {
            panel.classList.remove("gam-detached");
            panel.style.left = "auto";
            panel.style.right = "0";
          }
          keepInViewport();
          savePosition();
          if (suppressClick) suppressHandleClick = true;
        };
        dragHandle.addEventListener("pointermove", onMove);
        dragHandle.addEventListener("pointerup", onEnd);
        dragHandle.addEventListener("pointercancel", onEnd);
      });
    }
    function makeResizableFromBottomLeft(resizeTarget) {
      const applyResize = (startRect, dx, dy) => {
        const minWidth = Math.min(280, Math.max(1, window.innerWidth - 16));
        const minHeight = Math.min(220, Math.max(1, window.innerHeight - 16));
        const maxViewportWidth = Math.max(minWidth, window.innerWidth - 16);
        const maxWidth = panel.classList.contains("gam-detached") ? Math.max(minWidth, Math.min(maxViewportWidth, startRect.right - 8)) : maxViewportWidth;
        const maxHeight = Math.max(
          minHeight,
          Math.min(window.innerHeight - 16, window.innerHeight - startRect.top - 8)
        );
        const width = Math.min(Math.max(startRect.width - dx, minWidth), maxWidth);
        const height = Math.min(Math.max(startRect.height + dy, minHeight), maxHeight);
        expanded.style.width = `${Math.round(width)}px`;
        expanded.style.height = `${Math.round(height)}px`;
        if (panel.classList.contains("gam-detached")) {
          panel.style.left = `${Math.round(startRect.right - width)}px`;
          panel.style.right = "auto";
        }
      };
      resizeTarget.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const startRect = expanded.getBoundingClientRect();
        const startX = event.clientX;
        const startY = event.clientY;
        panel.classList.add("gam-resizing");
        resizeTarget.setPointerCapture(event.pointerId);
        const onMove = (moveEvent) => {
          applyResize(startRect, moveEvent.clientX - startX, moveEvent.clientY - startY);
        };
        const onEnd = () => {
          resizeTarget.removeEventListener("pointermove", onMove);
          resizeTarget.removeEventListener("pointerup", onEnd);
          resizeTarget.removeEventListener("pointercancel", onEnd);
          panel.classList.remove("gam-resizing");
          keepInViewport();
          savePosition();
        };
        resizeTarget.addEventListener("pointermove", onMove);
        resizeTarget.addEventListener("pointerup", onEnd);
        resizeTarget.addEventListener("pointercancel", onEnd);
      });
      resizeTarget.addEventListener("keydown", (event) => {
        const step = event.shiftKey ? 24 : 8;
        const delta = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step]
        }[event.key];
        if (!delta) return;
        event.preventDefault();
        applyResize(expanded.getBoundingClientRect(), delta[0], delta[1]);
        keepInViewport();
        savePosition();
      });
    }
    function openHistory() {
      if (suppressHandleClick) {
        suppressHandleClick = false;
        return;
      }
      const compactRect = panel.getBoundingClientRect();
      const rightEdge = compactRect.right;
      manualOpen = true;
      panel.classList.remove("gam-chip-visible");
      panel.classList.add("gam-open");
      if (panel.classList.contains("gam-detached")) {
        const width = panel.getBoundingClientRect().width;
        panel.style.left = `${Math.round(rightEdge - width)}px`;
      }
      keepInViewport();
      activityPanel.render(activityStore.snapshot());
    }
    function closeHistory() {
      const openRect = panel.getBoundingClientRect();
      const rightEdge = openRect.right;
      manualOpen = false;
      skillsMenu?.close();
      panel.classList.remove("gam-open");
      if (panel.classList.contains("gam-detached")) {
        panel.style.left = `${Math.round(rightEdge - COMPACT_WIDTH)}px`;
      }
      activityPanel.clear();
      keepInViewport();
      savePosition();
      handle.focus();
    }
    function hideActivity() {
      panel.classList.remove("gam-chip-visible");
      if (panel.dataset.status === "active") setStatus("idle");
    }
    function flushActivity() {
      uiTimer = null;
      if (!pendingLatest) return;
      const summary = pendingLatest;
      pendingLatest = null;
      currentAction.textContent = summary.action;
      currentDetail.textContent = summary.detail;
      setStatus(summary.status === "failed" ? "error" : "active");
      if (!manualOpen) panel.classList.add("gam-chip-visible");
      window.clearTimeout(activityTimer);
      activityTimer = null;
      if (summary.status !== "active") {
        activityTimer = window.setTimeout(hideActivity, ACTIVITY_VISIBLE_MS);
      }
    }
    function queueActivity(summary) {
      pendingLatest = summary;
      if (!isActive() || uiTimer !== null || document.visibilityState !== "visible") return;
      uiTimer = window.setTimeout(flushActivity, UI_COALESCE_MS);
    }
    function showAttention(action, detail) {
      pendingLatest = null;
      if (uiTimer !== null) {
        window.clearTimeout(uiTimer);
        uiTimer = null;
      }
      window.clearTimeout(activityTimer);
      currentAction.textContent = action;
      currentDetail.textContent = detail;
      setStatus("error");
      if (!manualOpen) panel.classList.add("gam-chip-visible");
    }
    function clearAttention() {
      panel.classList.remove("gam-chip-visible");
      if (panel.dataset.status === "error") setStatus("idle");
    }
    function resetSession() {
      pendingLatest = null;
      if (uiTimer !== null) {
        window.clearTimeout(uiTimer);
        uiTimer = null;
      }
      if (activityTimer !== null) {
        window.clearTimeout(activityTimer);
        activityTimer = null;
      }
      clearHint();
    }
    function recordHint(message) {
      if (!message || message === lastHint) return;
      lastHint = message;
      activityPanel.setHint(message);
    }
    function clearHint() {
      lastHint = "";
      activityPanel.setHint("");
    }
    function suspendActivity() {
      if (uiTimer !== null) {
        window.clearTimeout(uiTimer);
        uiTimer = null;
      }
      window.clearTimeout(activityTimer);
      activityTimer = null;
      panel.classList.remove("gam-chip-visible");
      if (panel.dataset.status === "active") setStatus("idle");
    }
    function resumeActivity() {
      if (pendingLatest) queueActivity(pendingLatest);
    }
    function mount() {
      if (!style.isConnected) document.documentElement.appendChild(style);
      if (!panel.isConnected) document.body.appendChild(panel);
      restorePosition();
    }
    function unmount() {
      if (panel.isConnected) savePosition();
      resetSession();
      panel.classList.remove("gam-chip-visible");
      if (panel.dataset.status === "active") setStatus("idle");
      panel.classList.remove("gam-open", "gam-chip-visible", "gam-dragging");
      manualOpen = false;
      skillsMenu?.close();
      activityPanel.clear();
      panel.remove();
      style.remove();
    }
    makeDraggable(handle, { suppressClick: true });
    makeDraggable(header);
    makeResizableFromBottomLeft(resizeHandle);
    handle.addEventListener("click", openHistory);
    skillsButton.addEventListener("pointerdown", (event) => {
      if (event.button === 0) event.preventDefault();
    });
    skillsButton.addEventListener("click", () => skillsMenu?.toggle());
    close.addEventListener("click", closeHistory);
    expanded.addEventListener("pointerup", () => {
      if (!manualOpen) return;
      keepInViewport();
      savePosition();
    });
    return {
      mount,
      unmount,
      keepInViewport,
      setStatus,
      getStatus,
      recordHint,
      clearHint,
      queueActivity,
      showAttention,
      clearAttention,
      resetSession,
      suspendActivity,
      resumeActivity
    };
  }

  // src/ui/settings-panel.js
  function backendLabel(backend) {
    try {
      const parsed = new URL(backend);
      return parsed.host + (parsed.pathname === "/" ? "" : parsed.pathname);
    } catch (_) {
      return backend;
    }
  }
  function testProfileConnection(profile, statusElement, button) {
    const validation = validateBackend(profile.backend);
    if (!validation.ok) {
      statusElement.textContent = validation.message;
      statusElement.dataset.state = "error";
      return;
    }
    button.disabled = true;
    statusElement.textContent = "\u6B63\u5728\u6D4B\u8BD5\u8FDE\u63A5\u2026";
    statusElement.dataset.state = "pending";
    const headers = {};
    if (profile.token) headers.Authorization = `Bearer ${profile.token}`;
    GM_xmlhttpRequest({
      method: "GET",
      url: `${validation.backend}/v1/action-logs?after=${Number.MAX_SAFE_INTEGER}&wait=0&limit=1`,
      headers,
      timeout: 7e3,
      onload(response) {
        button.disabled = false;
        if (response.status >= 200 && response.status < 300) {
          statusElement.textContent = "\u2713 \u8FDE\u63A5\u6210\u529F";
          statusElement.dataset.state = "success";
        } else if (response.status === 401) {
          statusElement.textContent = "\u8BA4\u8BC1\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5 Bearer Token\u3002";
          statusElement.dataset.state = "error";
        } else {
          statusElement.textContent = `\u540E\u7AEF\u8FD4\u56DE HTTP ${response.status}\u3002`;
          statusElement.dataset.state = "error";
        }
      },
      onerror() {
        button.disabled = false;
        statusElement.textContent = "\u65E0\u6CD5\u8FDE\u63A5\u540E\u7AEF\u3002";
        statusElement.dataset.state = "error";
      },
      ontimeout() {
        button.disabled = false;
        statusElement.textContent = "\u8FDE\u63A5\u8D85\u65F6\u3002";
        statusElement.dataset.state = "error";
      }
    });
  }
  function createSettingsPanel({ getProfiles, onApplyProfiles }) {
    let overlay = null;
    let style = null;
    function close() {
      overlay?.remove();
      style?.remove();
      overlay = null;
      style = null;
    }
    function open() {
      if (overlay?.isConnected) return;
      style = document.createElement("style");
      style.textContent = SETTINGS_CSS;
      overlay = document.createElement("div");
      overlay.id = "gam-settings-overlay";
      overlay.innerHTML = `
      <div class="gam-settings-card" role="dialog" aria-modal="true" aria-labelledby="gam-settings-title">
        <div class="gam-settings-header">
          <div class="gam-settings-title" id="gam-settings-title">Action Monitor \u914D\u7F6E</div>
          <button class="gam-icon-button gam-settings-close" type="button" aria-label="\u5173\u95ED\u914D\u7F6E">\xD7</button>
        </div>
        <div class="gam-settings-body">
          <section class="gam-list-view">
            <p class="gam-settings-note">\u5F53\u524D GPT \u540D\u79F0\u4F1A\u7CBE\u786E\u5339\u914D\u4E00\u6761\u5DF2\u542F\u7528\u914D\u7F6E\uFF1B\u6CA1\u6709\u5339\u914D\u65F6\u76D1\u63A7\u4E0D\u4F1A\u8FD0\u884C\u3002</p>
            <div class="gam-profile-list"></div>
            <div class="gam-list-footer">
              <button class="gam-button gam-add-profile" type="button">\uFF0B \u6DFB\u52A0\u76D1\u63A7\u76EE\u6807</button>
            </div>
          </section>
          <form class="gam-editor" hidden>
            <label class="gam-field">
              <span>GPT \u540D\u79F0</span>
              <input class="gam-input gam-gpt-name" type="text" autocomplete="off" placeholder="\u4F8B\u5982 github_skill" required>
            </label>
            <label class="gam-field">
              <span>\u540E\u7AEF\u5730\u5740</span>
              <input class="gam-input gam-backend" type="url" autocomplete="off" placeholder="https://skills.example.com" required>
            </label>
            <label class="gam-field">
              <span>Bearer Token</span>
              <div class="gam-token-row">
                <input class="gam-input gam-token" type="password" autocomplete="off" placeholder="\u672A\u542F\u7528\u8BA4\u8BC1\u53EF\u7559\u7A7A">
                <button class="gam-button gam-token-toggle" type="button">\u663E\u793A</button>
              </div>
            </label>
            <label class="gam-check-row">
              <input class="gam-enabled" type="checkbox" checked>
              <span>\u542F\u7528\u6B64\u76D1\u63A7</span>
            </label>
            <div class="gam-form-message" aria-live="polite"></div>
            <div class="gam-editor-footer">
              <button class="gam-button gam-delete" type="button">\u5220\u9664</button>
              <span class="gam-spacer"></span>
              <button class="gam-button gam-test" type="button">\u6D4B\u8BD5\u8FDE\u63A5</button>
              <button class="gam-button gam-cancel-edit" type="button">\u53D6\u6D88</button>
              <button class="gam-button gam-button-primary gam-save" type="submit">\u4FDD\u5B58</button>
            </div>
          </form>
        </div>
      </div>
    `;
      document.documentElement.appendChild(style);
      document.body.appendChild(overlay);
      const listView = overlay.querySelector(".gam-list-view");
      const list = overlay.querySelector(".gam-profile-list");
      const editor = overlay.querySelector(".gam-editor");
      const gptNameInput = overlay.querySelector(".gam-gpt-name");
      const backendInput = overlay.querySelector(".gam-backend");
      const tokenInput = overlay.querySelector(".gam-token");
      const enabledInput = overlay.querySelector(".gam-enabled");
      const formMessage = overlay.querySelector(".gam-form-message");
      const deleteButton = overlay.querySelector(".gam-delete");
      const testButton = overlay.querySelector(".gam-test");
      let editingId = null;
      function profiles() {
        return getProfiles();
      }
      function renderList() {
        list.replaceChildren();
        if (!profiles().length) {
          const empty = document.createElement("div");
          empty.className = "gam-empty";
          empty.textContent = "\u8FD8\u6CA1\u6709\u76D1\u63A7\u914D\u7F6E\u3002\u6DFB\u52A0\u4E00\u7EC4 GPT\u3001\u540E\u7AEF\u5730\u5740\u548C Bearer Token\u3002";
          list.appendChild(empty);
          return;
        }
        for (const profile of profiles()) {
          const row = document.createElement("div");
          row.className = "gam-profile-row";
          row.dataset.enabled = String(profile.enabled);
          const main = document.createElement("div");
          main.className = "gam-profile-main";
          const nameLine = document.createElement("div");
          nameLine.className = "gam-profile-name-line";
          const dot = document.createElement("span");
          dot.className = "gam-profile-state";
          const name = document.createElement("span");
          name.className = "gam-profile-name";
          name.textContent = profile.gptName;
          const backend = document.createElement("div");
          backend.className = "gam-profile-backend";
          backend.textContent = `${profile.enabled ? "\u5DF2\u542F\u7528" : "\u5DF2\u505C\u7528"} \xB7 ${backendLabel(profile.backend)}`;
          nameLine.append(dot, name);
          main.append(nameLine, backend);
          const edit = document.createElement("button");
          edit.className = "gam-button";
          edit.type = "button";
          edit.textContent = "\u7F16\u8F91";
          edit.addEventListener("click", () => showEditor(profile));
          row.append(main, edit);
          list.appendChild(row);
        }
      }
      function clearMessage() {
        formMessage.textContent = "";
        delete formMessage.dataset.state;
      }
      function showEditor(profile = null) {
        editingId = profile?.id || null;
        gptNameInput.value = profile?.gptName || "";
        backendInput.value = profile?.backend || "";
        tokenInput.value = profile?.token || "";
        tokenInput.type = "password";
        overlay.querySelector(".gam-token-toggle").textContent = "\u663E\u793A";
        enabledInput.checked = profile?.enabled !== false;
        deleteButton.hidden = !profile;
        clearMessage();
        listView.hidden = true;
        editor.hidden = false;
        window.setTimeout(() => gptNameInput.focus(), 0);
      }
      function showList() {
        editor.hidden = true;
        listView.hidden = false;
        editingId = null;
        renderList();
      }
      function formProfile() {
        return {
          id: editingId || createProfileId(),
          gptName: gptNameInput.value.trim(),
          backend: normalizeBackend(backendInput.value),
          token: tokenInput.value.trim(),
          enabled: enabledInput.checked
        };
      }
      function validateProfile(profile) {
        if (!profile.gptName) return "\u8BF7\u8F93\u5165 GPT \u540D\u79F0\u3002";
        const duplicate = profiles().find(
          (item) => item.id !== editingId && item.gptName === profile.gptName
        );
        if (duplicate) return `GPT \u540D\u79F0 \u201C${profile.gptName}\u201D \u5DF2\u5B58\u5728\u3002`;
        const backendValidation = validateBackend(profile.backend);
        if (!backendValidation.ok) return backendValidation.message;
        profile.backend = backendValidation.backend;
        return "";
      }
      overlay.querySelector(".gam-settings-close").addEventListener("click", close);
      overlay.querySelector(".gam-add-profile").addEventListener("click", () => showEditor());
      overlay.querySelector(".gam-cancel-edit").addEventListener("click", showList);
      overlay.querySelector(".gam-token-toggle").addEventListener("click", (event) => {
        const visible = tokenInput.type === "text";
        tokenInput.type = visible ? "password" : "text";
        event.currentTarget.textContent = visible ? "\u663E\u793A" : "\u9690\u85CF";
      });
      testButton.addEventListener("click", () => {
        const profile = formProfile();
        clearMessage();
        testProfileConnection(profile, formMessage, testButton);
      });
      deleteButton.addEventListener("click", () => {
        if (!editingId) return;
        const profile = profiles().find((item) => item.id === editingId);
        if (!profile || !confirm(`\u5220\u9664 \u201C${profile.gptName}\u201D \u7684\u76D1\u63A7\u914D\u7F6E\uFF1F`)) return;
        onApplyProfiles(profiles().filter((item) => item.id !== editingId));
        showList();
      });
      editor.addEventListener("submit", (event) => {
        event.preventDefault();
        const profile = formProfile();
        const error = validateProfile(profile);
        if (error) {
          formMessage.textContent = error;
          formMessage.dataset.state = "error";
          return;
        }
        const next = editingId ? profiles().map((item) => item.id === editingId ? profile : item) : [...profiles(), profile];
        onApplyProfiles(next);
        showList();
      });
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) close();
      });
      overlay.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          if (!editor.hidden) showList();
          else close();
        }
      });
      renderList();
      overlay.querySelector(".gam-settings-close").focus();
    }
    return { open, close };
  }

  // src/ui/skills-menu.js
  function createSkillsMenu({ loadSkills, onBeforeOpen, onSelect }) {
    const root = document.createElement("div");
    root.className = "gam-skills-picker";
    root.hidden = true;
    root.innerHTML = `
    <div class="gam-skills-picker-header">
      <strong>Skills</strong>
      <button class="gam-skills-refresh" type="button" title="\u5237\u65B0 Skill \u5217\u8868" aria-label="\u5237\u65B0 Skill \u5217\u8868">\u21BB</button>
    </div>
    <div class="gam-skills-state" hidden></div>
    <div class="gam-skills-list" role="menu" aria-label="Skills"></div>
  `;
    const refreshButton = root.querySelector(".gam-skills-refresh");
    const state = root.querySelector(".gam-skills-state");
    const list = root.querySelector(".gam-skills-list");
    let open = false;
    let hasRendered = false;
    let requestGeneration = 0;
    let triggerElement = null;
    function preserveFocus(event) {
      if (event.button === 0) event.preventDefault();
    }
    function setState(message) {
      state.textContent = message;
      state.hidden = false;
    }
    function clearState() {
      state.hidden = true;
      state.textContent = "";
    }
    function render(skills) {
      list.replaceChildren();
      clearState();
      if (!skills.length) {
        setState("\u6CA1\u6709\u53EF\u7528 Skill\u3002");
        return;
      }
      for (const skill of skills) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "gam-skill-item";
        item.setAttribute("role", "menuitem");
        item.textContent = skill.skill_id;
        item.title = skill.description || skill.skill_id;
        item.addEventListener("pointerdown", preserveFocus);
        item.addEventListener("click", () => {
          if (onSelect(skill) !== false) close();
        });
        list.appendChild(item);
      }
      hasRendered = true;
    }
    async function refresh({ force = false } = {}) {
      const generation = ++requestGeneration;
      if (force) setState("\u5237\u65B0\u4E2D\u2026");
      else if (!hasRendered) setState("\u52A0\u8F7D Skills\u2026");
      try {
        const skills = await loadSkills({ refresh: force });
        if (!open || generation !== requestGeneration) return;
        render(skills);
      } catch (error) {
        if (!open || generation !== requestGeneration) return;
        setState(error instanceof Error ? error.message : String(error));
      }
    }
    function close() {
      if (!open) return;
      open = false;
      requestGeneration += 1;
      root.hidden = true;
      document.removeEventListener("pointerdown", outsidePointer, true);
      document.removeEventListener("keydown", escapeKey, true);
    }
    function outsidePointer(event) {
      if (root.contains(event.target) || triggerElement?.contains?.(event.target)) return;
      close();
    }
    function escapeKey(event) {
      if (event.key === "Escape") close();
    }
    function openMenu() {
      if (open) return;
      onBeforeOpen?.();
      open = true;
      root.hidden = false;
      document.addEventListener("pointerdown", outsidePointer, true);
      document.addEventListener("keydown", escapeKey, true);
      refresh();
    }
    function toggle() {
      if (open) close();
      else openMenu();
    }
    function bindTrigger(element) {
      triggerElement = element;
    }
    refreshButton.addEventListener("pointerdown", preserveFocus);
    refreshButton.addEventListener("click", () => refresh({ force: true }));
    return { element: root, open: openMenu, close, toggle, bindTrigger };
  }

  // src/main.js
  (function() {
    "use strict";
    let profiles = loadProfiles();
    let monitorActive = false;
    let activeProfile = null;
    let actionLogClient = null;
    let chatAdapter = null;
    let activitySessionKey = null;
    let activitySessionCursor = null;
    const composerAdapter = createComposerAdapter();
    const skillCatalogClient = createSkillCatalogClient({
      getProfile: () => activeProfile
    });
    const activityStore = createActivityStore();
    let monitorUi = null;
    const skillsMenu = createSkillsMenu({
      loadSkills: (options) => skillCatalogClient.list(options),
      onBeforeOpen: () => composerAdapter.captureSelection(),
      onSelect(skill) {
        const inserted = composerAdapter.insertText(loadSkillsCall(skill.skill_id));
        if (!inserted) {
          monitorUi?.showAttention("\u63D2\u5165\u5931\u8D25", "\u672A\u627E\u5230 ChatGPT \u8F93\u5165\u6846");
        }
        return inserted;
      }
    });
    monitorUi = createMonitorPanel({
      activityStore,
      isActive: () => monitorActive,
      skillsMenu
    });
    function deactivateMonitor() {
      if (!monitorActive) return;
      const cursor = actionLogClient?.getCursor?.();
      if (Number.isInteger(cursor)) activitySessionCursor = cursor;
      monitorActive = false;
      activeProfile = null;
      actionLogClient?.stop();
      actionLogClient = null;
      skillsMenu.close();
      monitorUi.unmount();
    }
    function applyProfiles(nextProfiles) {
      profiles = saveProfiles(nextProfiles);
      deactivateMonitor();
      if (document.visibilityState === "visible") chatAdapter?.evaluateActivation();
    }
    const settingsPanel = createSettingsPanel({
      getProfiles: () => profiles,
      onApplyProfiles: applyProfiles
    });
    function activateMonitor(_titleElement, profile) {
      if (monitorActive && activeProfile?.id === profile.id) {
        activeProfile = profile;
        return;
      }
      if (monitorActive) deactivateMonitor();
      monitorActive = true;
      activeProfile = profile;
      const nextSessionKey = `${profile.id}\0${profile.backend}`;
      if (activitySessionKey !== nextSessionKey) {
        activityStore.clear();
        activitySessionKey = nextSessionKey;
        activitySessionCursor = null;
      }
      monitorUi.mount();
      monitorUi.setStatus("idle");
      actionLogClient = createActionLogClient({
        getProfile: () => activeProfile,
        initialCursor: activitySessionCursor,
        onCursor: (cursor) => {
          activitySessionCursor = cursor;
        },
        onItems(items) {
          const newest = activityStore.ingest(items);
          if (newest) {
            monitorUi.clearHint();
            monitorUi.queueActivity(compactActivity(newest));
          } else if (monitorUi.getStatus() === "error") monitorUi.clearAttention();
        },
        onHint: (message) => monitorUi.recordHint(message),
        onAttention: (action, detail) => monitorUi.showAttention(action, detail),
        onStatus(status) {
          monitorUi.setStatus(status);
        }
      });
      if (document.visibilityState === "visible") actionLogClient.start();
    }
    chatAdapter = createChatGPTAdapter({
      getProfiles: () => profiles,
      onActivate: activateMonitor,
      onDeactivate: deactivateMonitor
    });
    function suspend() {
      actionLogClient?.suspend();
      monitorUi.suspendActivity();
    }
    function resume() {
      if (!monitorActive) return;
      monitorUi.resumeActivity();
      const active = activityStore.snapshot().active.at(0);
      if (active) monitorUi.queueActivity(compactActivity(active));
      actionLogClient?.resume();
    }
    GM_registerMenuCommand("\u2699 \u76D1\u63A7\u914D\u7F6E...", settingsPanel.open);
    window.addEventListener("resize", () => {
      if (monitorActive) monitorUi.keepInViewport();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        chatAdapter.start();
        resume();
      } else {
        chatAdapter.stop();
        suspend();
      }
    });
    if (document.visibilityState === "visible") chatAdapter.start();
  })();
})();
