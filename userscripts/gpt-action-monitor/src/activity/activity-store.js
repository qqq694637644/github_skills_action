import { MAX_HISTORY } from '../constants.js';
import { createActivityState, reduceActivityItem } from './activity-reducer.js';

const MAX_SEEN_EVENTS = 2_000;

function eventKey(item) {
  if (!Number.isInteger(item?.id)) return null;
  const event = item.event;
  if (event) {
    return `${item.id}:${event.timestamp || ''}:${event.activity_id || ''}:${event.phase || ''}`;
  }
  return `${item.id}:${item.text || ''}`;
}

export function createActivityStore() {
  let state = createActivityState();
  const listeners = new Set();
  const seen = new Set();
  const seenOrder = [];

  function snapshot() {
    return {
      active: [...state.active.values()],
      recent: [...state.recent],
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
