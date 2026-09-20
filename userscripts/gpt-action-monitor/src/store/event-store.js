import { MAX_HISTORY } from '../constants.js';

export function createEventStore() {
  let history = [];

  function trim() {
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
  }

  function add(summary) {
    history.push({ type: 'event', ...summary });
    trim();
  }

  function addHint(message) {
    history.push({ type: 'hint', message, time: new Date().toTimeString().slice(0, 8) });
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
