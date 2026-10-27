import { App } from '@modelcontextprotocol/ext-apps';

const mode = document.documentElement.dataset.view;
const app = new App({ name: 'Workspace Inspector', version: '1.0.0' }, {}, { autoResize: true });
const $ = (id) => document.getElementById(id);
const now = () => performance.now();
const ms = (value) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)} ms` : '—';
const limited = (value, max = 200_000) => String(value ?? '').slice(-max);
const terminal = new Set(['succeeded', 'failed', 'canceled', 'timed_out', 'interrupted']);
let connectDone = false;
let pendingToolResult = null;
let target = null;
let pollHandle = null;
let inFlight = false;
let canceledArm = false;
let stdoutOffset = 0;
let stderrOffset = 0;
let stdout = '';
let stderr = '';
let refreshCount = 0;
const uiRtts = [];

function setStatus(message, error = false) {
  const el = $('message');
  el.textContent = message;
  el.classList.toggle('error', error);
}

function data(result) {
  if (result?.isError) {
    const text = result?.content?.filter((part) => part.type === 'text').map((part) => part.text).join(' ') || 'Tool returned error';
    throw new Error(limited(text, 2000));
  }
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  const text = result?.content?.find((part) => part.type === 'text')?.text;
  if (text) {
    try { return JSON.parse(text); } catch { return { message: text }; }
  }
  return {};
}

async function call(name, args) {
  if (!connectDone) throw new Error('MCP Apps host bridge not connected');
  const start = now();
  const result = data(await app.callServerTool({ name, arguments: args }));
  const rtt = Math.round((now() - start) * 100) / 100;
  return { result, rtt };
}

function showLatency(rtt, server, callId = null) {
  const bridge = Number.isFinite(Number(server))
    ? Math.max(0, rtt - Number(server)) : null;
  $('last-rtt').textContent = ms(rtt);
  $('last-server').textContent = ms(server);
  $('last-overhead').textContent = bridge === null ? '—' : ms(bridge);
  uiRtts.push(rtt);
  if (uiRtts.length > 50) uiRtts.shift();
  const sorted = [...uiRtts].sort((a, b) => a - b);
  $('ui-p95').textContent = ms(sorted[Math.ceil(sorted.length * .95) - 1]);
  if (callId) $('call-id').textContent = callId;
}

async function startImage(initial) {
  if (!initial?.workspace_id || !initial?.path) return;
  target = { workspace_id: initial.workspace_id, path: initial.path };
  $('filename').textContent = initial.path;
  const label = [
    initial.mime_type, initial.width && initial.height ? `${initial.width}×${initial.height}` : null,
    initial.bytes ? `${(initial.bytes / 1024).toFixed(1)} KiB` : null,
  ].filter(Boolean).join(' · ');
  $('image-metadata').textContent = label;
  await loadImage('preview');
}

async function loadImage(quality) {
  if (inFlight || !target) return;
  inFlight = true;
  setStatus('正在获取图片…');
  $('image-quality').textContent = quality === 'hd' ? '高清模式 (限制 2000px / 450KB)' : '预览模式 (1024px / 350KB)';
  try {
    const args = quality === 'hd'
      ? { ...target, max_width: 2000, max_height: 2000, max_bytes: 450_000 }
      : { ...target, max_width: 1024, max_height: 1024, max_bytes: 350_000 };
    const { result, rtt } = await call('getImagePreview', args);
    if (!result.data_url?.startsWith('data:image/')) throw new Error('No image was returned');
    const img = $('preview');
    img.src = result.data_url;
    img.alt = target.path;
    $('image-dimensions').textContent = `${result.width} × ${result.height} ${result.resized ? '· compressed' : ''}`;
    showLatency(rtt, result.server_elapsed_ms, result.call_id);
    setStatus('图片已加载（此处看到的是 iframe 预览，不代表模型获得了图片像素）');
  } catch (error) {
    setStatus(`图片读取失败：${error.message}`, true);
  } finally { inFlight = false; }
}

let zoom = 1;
function setZoom(value) {
  zoom = Math.min(5, Math.max(.25, value));
  $('preview').style.width = `${Math.round(zoom * 100)}%`;
  $('zoom-label').textContent = `${Math.round(zoom * 100)}%`;
}
function bindImage() {
  $('zoom-in').addEventListener('click', () => setZoom(zoom * 1.25));
  $('zoom-out').addEventListener('click', () => setZoom(zoom / 1.25));
  $('zoom-fit').addEventListener('click', () => setZoom(1));
  $('higher-quality').addEventListener('click', () => loadImage('hd'));
}

function paintOperation(operation) {
  if (!operation) return;
  $('operation-status').textContent = operation.state || 'unknown';
  $('operation-status').dataset.state = operation.state || 'unknown';
  const pieces = [
    operation.started_at ? `started ${operation.started_at}` : null,
    Number.isInteger(operation.exit_code) ? `exit ${operation.exit_code}` : null,
    Number.isFinite(Number(operation.duration_ms)) ? `elapsed ${(operation.duration_ms / 1000).toFixed(1)}s` : null,
  ].filter(Boolean);
  $('operation-metadata').textContent = pieces.join(' · ');
  const stopped = terminal.has(operation.state);
  $('cancel-operation').disabled = stopped;
  if (stopped && pollHandle) {
    clearTimeout(pollHandle);
    pollHandle = null;
  }
}

function appendLog(id, value) {
  const el = $(id);
  el.textContent = value || '(no output)';
  el.scrollTop = el.scrollHeight;
}

async function refreshOperation() {
  if (!target?.operation_id || inFlight) return;
  inFlight = true;
  try {
    const { result, rtt } = await call('getOperationView', {
      operation_id: target.operation_id,
      stdout_offset: stdoutOffset,
      stderr_offset: stderrOffset,
      max_bytes: 40_000,
      mode: 'get',
    });
    // Next offsets are authoritative byte cursors, not string lengths.
    stdoutOffset = Number(result.next_stdout_offset ?? stdoutOffset);
    stderrOffset = Number(result.next_stderr_offset ?? stderrOffset);
    stdout = limited(stdout + (result.stdout || ''));
    stderr = limited(stderr + (result.stderr || ''));
    appendLog('stdout', stdout);
    appendLog('stderr', stderr);
    paintOperation(result.operation);
    showLatency(rtt, result.server_elapsed_ms, result.call_id);
    refreshCount += 1;
    setStatus(`最新查询完成 · UI 往返 ${ms(rtt)} · #${refreshCount}`);
    if (!terminal.has(result.operation?.state)) {
      pollHandle = setTimeout(refreshOperation, 1800);
    }
  } catch (error) {
    setStatus(`状态读取失败：${error.message}`, true);
  } finally { inFlight = false; }
}

async function loadHistory() {
  if (!target?.operation_id || inFlight) return;
  inFlight = true;
  try {
    const { result, rtt } = await call('getOperationView', {
      operation_id: target.operation_id, stdout_offset: 0,
      stderr_offset: 0, max_bytes: 50_000, mode: 'logs',
    });
    stdout = limited(result.stdout || '');
    stderr = limited(result.stderr || '');
    stdoutOffset = Number(result.next_stdout_offset || 0);
    stderrOffset = Number(result.next_stderr_offset || 0);
    appendLog('stdout', stdout);
    appendLog('stderr', stderr);
    showLatency(rtt, result.server_elapsed_ms, result.call_id);
    setStatus('已从日志起点重新读取（单次上限 50KB；更多由自动刷新追加）');
  } catch (error) { setStatus(`日志读取失败：${error.message}`, true); }
  finally { inFlight = false; }
}

async function cancelOperation() {
  if (!target || inFlight) return;
  if (!canceledArm) {
    canceledArm = true;
    $('cancel-operation').textContent = '确认取消操作';
    setStatus('请再次点击取消按钮确认（不会启动新进程）');
    return;
  }
  canceledArm = false;
  $('cancel-operation').textContent = '取消运行';
  inFlight = true;
  try {
    const { result, rtt } = await call('cancelOperationFromViewer', target);
    paintOperation(result.operation);
    showLatency(rtt, null);
    setStatus('取消请求已提交；最终状态以服务端返回为准');
  } catch (error) { setStatus(`取消失败：${error.message}`, true); }
  finally { inFlight = false; }
}

async function loadTiming() {
  try {
    const { result, rtt } = await call('getMcpLatency', { limit: 40 });
    const mcp = result.mcp_handler || {};
    const http = result.http_first_byte || {};
    $('server-p95').textContent = ms(mcp.p95_ms);
    $('http-p95').textContent = ms(http.p95_ms);
    const recent = (result.samples || []).filter((sample) => sample.kind === 'mcp').slice(0, 12);
    const lines = recent.map((sample) => `${sample.method} ${sample.tool || ''}: ${ms(sample.elapsed_ms)} · ${sample.outcome}`);
    $('timing-list').textContent = lines.join('\n') || '(no samples yet)';
    setStatus(`最近服务端测量已更新 · 查询 RTT ${ms(rtt)}`);
  } catch (error) { setStatus(`延迟列表读取失败：${error.message}`, true); }
}

async function startOperation(initial) {
  if (!initial?.operation_id) return;
  target = { operation_id: initial.operation_id };
  $('operation-id').textContent = initial.operation_id;
  paintOperation(initial.operation);
  await refreshOperation();
  await loadTiming();
}

function bindOperation() {
  $('refresh-now').addEventListener('click', () => {
    if (pollHandle) clearTimeout(pollHandle);
    pollHandle = null;
    refreshOperation();
  });
  $('read-history').addEventListener('click', loadHistory);
  $('refresh-timing').addEventListener('click', loadTiming);
  $('cancel-operation').addEventListener('click', cancelOperation);
  $('copy-stdout').addEventListener('click', () => copy(stdout, 'stdout'));
  $('copy-stderr').addEventListener('click', () => copy(stderr, 'stderr'));
}

async function copy(text, name) {
  try { await navigator.clipboard.writeText(text); setStatus(`已复制 ${name}`); }
  catch { setStatus('Clipboard API unavailable in this host', true); }
}

async function acceptResult(result) {
  try {
    const initial = data(result);
    if (mode === 'image') await startImage(initial);
    else await startOperation(initial);
  } catch (error) { setStatus(`初始化失败：${error.message}`, true); }
}

if (mode === 'image') bindImage(); else bindOperation();
app.ontoolinput = (input) => {
  if (mode === 'image' && input.arguments?.path) {
    $('filename').textContent = input.arguments.path;
  }
  if (mode === 'operation' && input.arguments?.operation_id) {
    $('operation-id').textContent = input.arguments.operation_id;
  }
};
app.ontoolresult = (result) => {
  if (!connectDone) {
    pendingToolResult = result;
    return;
  }
  void acceptResult(result);
};
app.onteardown = async () => {
  if (pollHandle) clearTimeout(pollHandle);
  return {};
};
app.connect().then(() => {
  connectDone = true;
  if (pendingToolResult) {
    const result = pendingToolResult;
    pendingToolResult = null;
    void acceptResult(result);
  } else {
    setStatus('MCP Apps 已连接；等待工具结果…');
  }
}).catch((error) => {
  setStatus(`当前客户端未能初始化 MCP Apps：${error.message}`, true);
});
