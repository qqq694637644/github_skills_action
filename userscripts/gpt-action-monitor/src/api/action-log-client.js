import { POLL_WAIT_SECONDS, RETRY_MS } from '../constants.js';
import {
  debugError,
  debugLog,
  debugWarn,
  summarizeActionItems,
} from '../debug.js';

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
      debugLog('action-log', 'abort active request');
      try { active.abort(); } catch (error) {
        debugWarn('action-log', 'abort threw', String(error));
      }
    }
  }

  function suspend() {
    debugLog('action-log', 'suspend', { cursor: getCursor(), streamId });
    requestGeneration += 1;
    clearPollTimer();
    abortRequest();
  }

  function resume() {
    debugLog('action-log', 'resume', { cursor: getCursor(), streamId });
    if (!stopped) schedulePoll(0);
  }

  function stop() {
    debugLog('action-log', 'stop', { cursor: getCursor(), streamId });
    stopped = true;
    suspend();
  }

  function start() {
    debugLog('action-log', 'start', { cursor: getCursor(), streamId });
    stopped = false;
    schedulePoll(0);
  }

  function scheduleRetry(message) {
    debugWarn('action-log', 'retry scheduled', { message, retryMs: RETRY_MS });
    onHint(message);
    onAttention?.('连接异常', '3 秒后重试');
    onStatus?.('error');
    schedulePoll(RETRY_MS);
  }

  function poll() {
    if (stopped) {
      debugLog('action-log', 'poll skipped: stopped');
      return;
    }
    if (requestHandle) {
      debugLog('action-log', 'poll skipped: request already active');
      return;
    }
    if (document.visibilityState !== 'visible' && !shouldPollWhenHidden()) {
      debugLog('action-log', 'poll skipped: hidden page');
      return;
    }
    const profile = getProfile();
    const workspaceId = getWorkspaceId?.();
    if (!profile) {
      debugWarn('action-log', 'poll skipped: no effective profile');
      return;
    }
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
    const url = `${profile.backend}/v1/action-logs?${filter}&after=${after}&wait=${wait}&limit=${priming ? 1 : 50}`;
    const startedAt = Date.now();
    debugLog('action-log', 'request', {
      backend: profile.backend,
      endpointId: profile.id,
      workspaceId: workspaceId || null,
      mode: discovery ? 'discovery' : 'workspace',
      priming,
      cursor: lastId,
      streamId,
      generation,
      url,
    });

    try {
      requestHandle = GM_xmlhttpRequest({
      method: 'GET',
      url,
      headers,
      timeout: (wait + 5) * 1000,
      onload(response) {
        if (generation !== requestGeneration) {
          debugLog('action-log', 'stale response ignored', {
            generation,
            currentGeneration: requestGeneration,
            status: response.status,
          });
          return;
        }
        requestHandle = null;
        debugLog('action-log', 'response', {
          status: response.status,
          elapsedMs: Date.now() - startedAt,
          generation,
        });
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
          const rawItems = Array.isArray(body.items) ? body.items : [];
          const nextStreamId = typeof body.stream_id === 'string' && body.stream_id
            ? body.stream_id
            : null;
          debugLog('action-log', 'payload', {
            streamId: nextStreamId,
            previousStreamId: streamId,
            lastId: body.last_id,
            rawItemCount: rawItems.length,
            items: summarizeActionItems(rawItems),
          });
          if (nextStreamId && streamId && nextStreamId !== streamId) {
            debugWarn('action-log', 'stream reset detected', {
              previousStreamId: streamId,
              nextStreamId,
            });
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
            debugLog('action-log', 'cursor primed', { lastId, streamId });
            needsCursorPrime = false;
            onStatus?.('idle');
            schedulePoll(0);
            return;
          }
          const items = rawItems
            .filter((item) => {
                if (discovery) {
                  return item?.event?.phase === 'completed'
                    && item?.event?.payload?.operation === 'prepare_workspace';
                }
                return item?.event?.workspace_id === workspaceId;
              });
          debugLog('action-log', 'filtered items', {
            rawItemCount: rawItems.length,
            acceptedItemCount: items.length,
            workspaceId: workspaceId || null,
            mode: discovery ? 'discovery' : 'workspace',
            items: summarizeActionItems(items),
          });
          onItems(items);
          schedulePoll();
        } catch (error) {
          debugError('action-log', 'response parse/processing failed', String(error));
          scheduleRetry(`响应解析失败：${String(error)}`);
        }
      },
      onerror(error) {
        debugError('action-log', 'network error', {
          elapsedMs: Date.now() - startedAt,
          generation,
          error: String(error),
        });
        if (generation === requestGeneration) {
          requestHandle = null;
          scheduleRetry('连接后端失败，3 秒后重试。');
        }
      },
      ontimeout() {
        debugWarn('action-log', 'request timeout', {
          elapsedMs: Date.now() - startedAt,
          generation,
          wait,
        });
        if (generation === requestGeneration) {
          requestHandle = null;
          schedulePoll(100);
        }
      },
      onabort() {
        debugLog('action-log', 'request aborted', {
          elapsedMs: Date.now() - startedAt,
          generation,
        });
        if (generation === requestGeneration) requestHandle = null;
      },
      });
    } catch (error) {
      requestHandle = null;
      debugError('action-log', 'GM_xmlhttpRequest threw synchronously', String(error));
      scheduleRetry(`发起请求失败：${String(error)}`);
    }
  }

  function getCursor() {
    return needsCursorPrime ? null : lastId;
  }

  return { start, stop, suspend, resume, poll, getCursor };
}
