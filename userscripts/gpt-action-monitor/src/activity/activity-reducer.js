import { summarize } from '../formatter/action-formatter.js';

const MAX_LIVE_OUTPUT_CHARS = 24_000;
const MAX_EXPLORATION_ENTRIES_PER_GROUP = 3;

function clonePayload(payload) {
  return payload && typeof payload === 'object' ? { ...payload } : {};
}

function cloneCell(cell) {
  return {
    ...cell,
    payload: clonePayload(cell.payload),
    entries: [...(cell.entries || [])],
  };
}

function structuredCell(event) {
  const payload = clonePayload(event.payload);
  return {
    id: event.activity_id,
    kind: event.kind || 'generic',
    phase: event.phase || 'completed',
    startedAt: event.timestamp || '',
    updatedAt: event.timestamp || '',
    payload,
    liveOutput: '',
    entries: event.kind === 'exploration'
      ? explorationEntries(payload, event.timestamp || '', event.phase || 'completed')
      : [],
    revision: 1,
  };
}

function legacyCell(item) {
  const summary = summarize(item.text || '');
  return {
    id: `legacy:${item.id}`,
    kind: 'legacy',
    phase: 'completed',
    startedAt: '',
    updatedAt: '',
    payload: { summary },
    liveOutput: '',
    entries: [],
    revision: 1,
  };
}

function explorationResult(active, completedText, payload) {
  if (active) return '等待结果';
  return payload.truncated ? `${completedText} · truncated` : completedText;
}

export function explorationEntries(payload, updatedAt = '', phase = 'completed') {
  const entries = [];
  const operation = payload.operation;
  const active = phase === 'started' || phase === 'updated';
  if (operation === 'search') {
    const detail = Number.isInteger(payload.match_count) ? `${payload.match_count} matches` : '';
    entries.push({
      verb: 'Search',
      label: payload.query || 'code',
      detail,
      updatedAt,
      result: detail || explorationResult(active, 'Search completed', payload),
    });
  } else if (operation === 'read') {
    const files = Array.isArray(payload.files) ? payload.files : [];
    const requestedStart = Number.isInteger(payload.start_line) ? payload.start_line : null;
    const requestedMax = Number.isInteger(payload.max_lines) ? payload.max_lines : null;
    const items = files.length
      ? files.map((file) => ({
          path: file.path,
          startLine: file.start_line,
          endLine: file.end_line,
        }))
      : (payload.paths || []).map((path) => ({
          path,
          startLine: requestedStart,
          endLine: requestedStart && requestedMax
            ? requestedStart + requestedMax - 1
            : null,
        }));
    for (const item of items) {
      const detail = Number.isInteger(item.startLine) && Number.isInteger(item.endLine)
        ? `${item.startLine}–${item.endLine}`
        : '';
      entries.push({
        verb: 'Read',
        label: item.path,
        detail,
        updatedAt,
        result: detail
          ? `${detail}${payload.truncated ? ' · truncated' : ''}`
          : explorationResult(active, 'Read completed', payload),
      });
    }
  } else if (operation === 'inspect') {
    const listResult = Number.isInteger(payload.tree_entries)
      ? `${payload.tree_entries} tree entries`
      : explorationResult(active, 'List completed', payload);
    for (const path of payload.paths || []) {
      entries.push({
        verb: 'List',
        label: path,
        detail: '',
        updatedAt,
        result: listResult,
      });
    }
    const searches = (payload.searches || []).length
      ? payload.searches
      : (payload.queries || []).map((query) => ({ query }));
    for (const search of searches) {
      const detail = Number.isInteger(search.match_count) ? `${search.match_count} matches` : '';
      entries.push({
        verb: 'Search',
        label: search.query || 'code',
        detail,
        updatedAt,
        result: detail || explorationResult(active, 'Search completed', payload),
      });
    }
    for (const path of payload.files || []) {
      entries.push({
        verb: 'Read',
        label: path,
        detail: '',
        updatedAt,
        result: explorationResult(active, 'Read completed', payload),
      });
    }
  }
  return entries;
}

export function createActivityState() {
  return {
    active: new Map(),
    recent: [],
    explorationGroupId: null,
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

function appendExplorationEntries(state, entries, event, payload, maxHistory) {
  let remaining = [...entries];
  let latest = null;
  let chunkIndex = 0;

  while (remaining.length) {
    const groupIndex = state.explorationGroupId
      ? state.recent.findIndex((cell) => cell.id === state.explorationGroupId)
      : -1;
    const grouped = groupIndex >= 0 ? cloneCell(state.recent[groupIndex]) : null;
    const capacity = grouped
      ? Math.max(0, MAX_EXPLORATION_ENTRIES_PER_GROUP - grouped.entries.length)
      : 0;

    if (grouped && capacity > 0) {
      grouped.entries.push(...remaining.splice(0, capacity));
      grouped.updatedAt = event.timestamp || grouped.updatedAt;
      grouped.payload.truncated = Boolean(grouped.payload.truncated || payload.truncated);
      grouped.revision += 1;
      state.recent[groupIndex] = grouped;
      latest = grouped;
      if (grouped.entries.length >= MAX_EXPLORATION_ENTRIES_PER_GROUP) {
        breakExplorationGroup(state);
      }
      continue;
    }

    breakExplorationGroup(state);
    const chunk = remaining.splice(0, MAX_EXPLORATION_ENTRIES_PER_GROUP);
    const cell = structuredCell(event);
    cell.id = `${event.activity_id}:group:${chunkIndex}`;
    chunkIndex += 1;
    cell.phase = 'completed';
    cell.payload = { ...cell.payload, ...payload };
    cell.entries = chunk;
    cell.updatedAt = event.timestamp || cell.updatedAt;
    addRecent(state, cell, maxHistory);
    latest = cell;
    if (chunk.length < MAX_EXPLORATION_ENTRIES_PER_GROUP) {
      state.explorationGroupId = cell.id;
    }
  }

  return latest;
}

function reduceCommand(state, event, maxHistory) {
  const existing = state.active.get(event.activity_id);
  if (event.phase === 'started') {
    const cell = structuredCell(event);
    state.active.set(cell.id, cell);
    return cell;
  }
  if (event.phase === 'updated') {
    const cell = existing ? cloneCell(existing) : structuredCell({ ...event, phase: 'started' });
    const delta = String(event.payload?.delta || '');
    if (delta) cell.liveOutput = `${cell.liveOutput}${delta}`.slice(-MAX_LIVE_OUTPUT_CHARS);
    cell.updatedAt = event.timestamp || cell.updatedAt;
    cell.revision += 1;
    state.active.set(cell.id, cell);
    return cell;
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
  if (event.phase === 'started' || event.phase === 'updated') {
    const existing = state.active.get(event.activity_id);
    const cell = existing ? cloneCell(existing) : structuredCell(event);
    cell.phase = event.phase;
    cell.payload = { ...cell.payload, ...payload };
    cell.entries = explorationEntries(payload, event.timestamp || cell.updatedAt, event.phase);
    cell.updatedAt = event.timestamp || cell.updatedAt;
    cell.revision += existing ? 1 : 0;
    state.active.set(cell.id, cell);
    return cell;
  }

  const activeCell = state.active.get(event.activity_id);
  state.active.delete(event.activity_id);
  if (event.phase === 'failed') {
    breakExplorationGroup(state);
    const failed = activeCell ? cloneCell(activeCell) : structuredCell(event);
    failed.phase = 'failed';
    failed.payload = { ...failed.payload, ...payload };
    failed.entries = explorationEntries(payload, event.timestamp || failed.updatedAt, event.phase);
    failed.updatedAt = event.timestamp || failed.updatedAt;
    failed.revision += activeCell ? 1 : 0;
    return addRecent(state, failed, maxHistory);
  }

  const entries = explorationEntries(payload, event.timestamp || '', event.phase);
  return appendExplorationEntries(state, entries, event, payload, maxHistory);
}

function reduceGeneric(state, event, maxHistory) {
  const existing = state.active.get(event.activity_id);
  if (event.phase === 'started' || event.phase === 'updated') {
    const cell = existing ? cloneCell(existing) : structuredCell(event);
    cell.phase = event.phase;
    cell.payload = { ...cell.payload, ...clonePayload(event.payload) };
    cell.updatedAt = event.timestamp || cell.updatedAt;
    cell.revision += existing ? 1 : 0;
    state.active.set(cell.id, cell);
    return cell;
  }

  const cell = existing ? cloneCell(existing) : structuredCell(event);
  cell.phase = event.phase;
  cell.payload = { ...cell.payload, ...clonePayload(event.payload) };
  cell.updatedAt = event.timestamp || cell.updatedAt;
  cell.revision += existing ? 1 : 0;
  state.active.delete(cell.id);
  return addRecent(state, cell, maxHistory);
}

export function reduceActivityItem(previousState, item, { maxHistory = 100 } = {}) {
  const state = {
    active: new Map(previousState.active),
    recent: [...previousState.recent],
    explorationGroupId: previousState.explorationGroupId,
  };

  if (!item?.event) {
    breakExplorationGroup(state);
    return { state, latest: addRecent(state, legacyCell(item || {}), maxHistory) };
  }

  const event = item.event;
  if (!event || typeof event !== 'object' || !event.activity_id) {
    return { state, latest: null };
  }
  if (event.kind !== 'exploration') breakExplorationGroup(state);

  let latest;
  if (event.kind === 'command') latest = reduceCommand(state, event, maxHistory);
  else if (event.kind === 'exploration') latest = reduceExploration(state, event, maxHistory);
  else latest = reduceGeneric(state, event, maxHistory);
  return { state, latest };
}
