import { summarize } from '../formatter/action-formatter.js';

const MAX_LIVE_OUTPUT_CHARS = 24_000;

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
    entries: event.kind === 'exploration' ? explorationEntries(payload) : [],
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

export function explorationEntries(payload) {
  const entries = [];
  const operation = payload.operation;
  if (operation === 'search') {
    entries.push({
      verb: 'Search',
      label: payload.query || 'code',
      detail: Number.isInteger(payload.match_count) ? `${payload.match_count} matches` : '',
    });
  } else if (operation === 'read') {
    for (const path of payload.paths || []) entries.push({ verb: 'Read', label: path, detail: '' });
  } else if (operation === 'inspect') {
    for (const path of payload.paths || []) entries.push({ verb: 'List', label: path, detail: '' });
    const searches = (payload.searches || []).length
      ? payload.searches
      : (payload.queries || []).map((query) => ({ query }));
    for (const search of searches) {
      entries.push({
        verb: 'Search',
        label: search.query || 'code',
        detail: Number.isInteger(search.match_count) ? `${search.match_count} matches` : '',
      });
    }
    for (const path of payload.files || []) entries.push({ verb: 'Read', label: path, detail: '' });
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
    cell.entries = explorationEntries(payload);
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
    failed.entries = explorationEntries(payload);
    failed.updatedAt = event.timestamp || failed.updatedAt;
    failed.revision += activeCell ? 1 : 0;
    return addRecent(state, failed, maxHistory);
  }

  const entries = explorationEntries(payload);
  const groupIndex = state.explorationGroupId
    ? state.recent.findIndex((cell) => cell.id === state.explorationGroupId)
    : -1;
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
  cell.phase = 'completed';
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
