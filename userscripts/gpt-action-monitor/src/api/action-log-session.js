export function createActionLogSessionState() {
  const cursors = new Map();
  let streamId = null;

  function getCursor(sessionKey) {
    const cursor = cursors.get(sessionKey);
    return Number.isInteger(cursor) ? cursor : null;
  }

  function setCursor(sessionKey, cursor) {
    if (!sessionKey || !Number.isInteger(cursor)) return;
    cursors.set(sessionKey, cursor);
  }

  function getStreamId() {
    return streamId;
  }

  function setStreamId(value) {
    streamId = typeof value === 'string' && value ? value : null;
  }

  function clearCursors() {
    cursors.clear();
  }

  function clearAll() {
    clearCursors();
    streamId = null;
  }

  return {
    getCursor,
    setCursor,
    getStreamId,
    setStreamId,
    clearCursors,
    clearAll,
  };
}
