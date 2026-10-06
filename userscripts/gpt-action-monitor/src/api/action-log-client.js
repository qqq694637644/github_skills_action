import { POLL_WAIT_SECONDS, RETRY_MS } from '../constants.js';

export function createActionLogClient({
  getProfile,
  getWorkspaceId,
  onItems,
  onHint,
  onStatus,
  onAttention,
  initialCursor = null,
  initialStreamId = null,
  onCursor,
  onStreamId,
  onStreamReset,
  shouldPollWhenHidden = () => false,
}) {
  let lastId = Number.isInteger(initialCursor) ? initialCursor : 0;
  let needsCursorPrime = !Number.isInteger(initialCursor);
  let streamId = typeof initialStreamId === 'string' && initialStreamId ? initialStreamId : null;
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
    if (active && typeof active.abort === 'function') {
      try { active.abort(); } catch (_) {}
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
    onAttention?.('连接异常', '3 秒后重试');
    onStatus?.('error');
    schedulePoll(RETRY_MS);
  }

  function poll() {
    if (
      stopped
      || requestHandle
      || (document.visibilityState !== 'visible' && !shouldPollWhenHidden())
    ) return;
    const profile = getProfile();
    const workspaceId = getWorkspaceId?.();
    if (!profile) return;
    const discovery = !workspaceId;

    const headers = {};
    if (profile.token) headers.Authorization = `Bearer ${profile.token}`;
    const generation = ++requestGeneration;
    const priming = needsCursorPrime;
    const wait = priming ? 0 : POLL_WAIT_SECONDS;
    const after = priming ? Number.MAX_SAFE_INTEGER : lastId;

    const filter = discovery
      ? 'operation=prepare_workspace&phase=completed'
      : `workspace_id=${encodeURIComponent(workspaceId)}`;
    requestHandle = GM_xmlhttpRequest({
      method: 'GET',
      url: `${profile.backend}/v1/action-logs?${filter}&after=${after}&wait=${wait}&limit=${priming ? 1 : 50}`,
      headers,
      timeout: (wait + 5) * 1000,
      onload(response) {
        if (generation !== requestGeneration) return;
        requestHandle = null;
        if (response.status === 401) {
          stopped = true;
          onHint('认证失败：请检查 Bearer Token。');
          onAttention?.('认证失败', '检查 Bearer Token');
          onStatus?.('error');
          return;
        }
        if (response.status < 200 || response.status >= 300) {
          scheduleRetry(`后端返回 HTTP ${response.status}，3 秒后重试。`);
          return;
        }
        try {
          const body = JSON.parse(response.responseText);
          const nextStreamId = typeof body.stream_id === 'string' && body.stream_id
            ? body.stream_id
            : null;
          if (nextStreamId && streamId && nextStreamId !== streamId) {
            streamId = nextStreamId;
            onStreamId?.(streamId);
            needsCursorPrime = false;
            lastId = 0;
            onCursor?.(lastId);
            onStreamReset?.(streamId);
            onStatus?.('idle');
            schedulePoll(0);
            return;
          }
          if (nextStreamId && nextStreamId !== streamId) {
            streamId = nextStreamId;
            onStreamId?.(streamId);
          }
          if (Number.isInteger(body.last_id)) {
            lastId = body.last_id;
            onCursor?.(lastId);
          }
          if (priming) {
            needsCursorPrime = false;
            onStatus?.('idle');
            schedulePoll(0);
            return;
          }
          const items = Array.isArray(body.items)
            ? body.items.filter((item) => {
                if (discovery) {
                  return item?.event?.phase === 'completed'
                    && item?.event?.payload?.operation === 'prepare_workspace';
                }
                return item?.event?.workspace_id === workspaceId;
              })
            : [];
          onItems(items);
          schedulePoll();
        } catch (error) {
          scheduleRetry(`响应解析失败：${String(error)}`);
        }
      },
      onerror() {
        if (generation === requestGeneration) {
          requestHandle = null;
          scheduleRetry('连接后端失败，3 秒后重试。');
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
      },
    });
  }

  function getCursor() {
    return needsCursorPrime ? null : lastId;
  }

  return { start, stop, suspend, resume, poll, getCursor };
}
