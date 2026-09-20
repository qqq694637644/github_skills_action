import { POLL_WAIT_SECONDS, RETRY_MS } from '../constants.js';

export function createActionLogClient({ getProfile, onItems, onHint, onStatus, onAttention }) {
  let lastId = 0;
  let needsCursorPrime = true;
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
    needsCursorPrime = true;
    schedulePoll(0);
  }

  function scheduleRetry(message) {
    onHint(message);
    onAttention?.('连接异常', '3 秒后重试');
    onStatus?.('error');
    schedulePoll(RETRY_MS);
  }

  function poll() {
    if (stopped || requestHandle || document.visibilityState !== 'visible') return;
    const profile = getProfile();
    if (!profile) return;

    const headers = {};
    if (profile.token) headers.Authorization = `Bearer ${profile.token}`;
    const generation = ++requestGeneration;
    const priming = needsCursorPrime;
    const wait = priming ? 0 : POLL_WAIT_SECONDS;
    const after = priming ? Number.MAX_SAFE_INTEGER : lastId;

    requestHandle = GM_xmlhttpRequest({
      method: 'GET',
      url: `${profile.backend}/v1/action-logs?after=${after}&wait=${wait}&limit=${priming ? 1 : 50}`,
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
          if (Number.isInteger(body.last_id)) lastId = body.last_id;
          if (priming) {
            needsCursorPrime = false;
            onStatus?.('idle');
            schedulePoll(0);
            return;
          }
          onItems(body.items || []);
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

  return { start, stop, suspend, resume, poll };
}
