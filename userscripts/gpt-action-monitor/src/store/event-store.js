import { MAX_HISTORY } from '../constants.js';

export function createEventStore() {
  let history = [];

  function trim() {
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
  }

  function add(summary) {
    history.push({ kind: 'event', summary });
    trim();
  }

  function addHint(message) {
    history.push({ kind: 'hint', message });
    trim();
  }

  function all() {
    return [...history];
  }

  function clear() {
    history = [];
  }

  return { add, addHint, all, clear };
}
