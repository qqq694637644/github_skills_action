import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(dir, '../src/workspace_mcp/ui');
const result = await build({
  entryPoints: [path.join(dir, 'src/main.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  write: false,
  logLevel: 'warning',
});
const script = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const style = await readFile(path.join(dir, 'src/styles.css'), 'utf8');
await mkdir(outDir, { recursive: true });
const image = `
  <header><h1>Workspace 图片预览</h1><small id="image-quality">预览模式</small></header>
  <div id="filename" class="path">等待图片…</div>
  <div id="image-metadata" class="muted"></div>
  <section>
    <div class="controls">
      <button type="button" id="zoom-out" aria-label="缩小图片">−</button>
      <button type="button" id="zoom-fit">适应窗口</button>
      <button type="button" id="zoom-in" aria-label="放大图片">＋</button>
      <span id="zoom-label">100%</span>
      <button type="button" id="higher-quality">高清预览</button>
    </div>
  </section>
  <div class="preview-wrap"><img id="preview" alt="Workspace image"></div>
  <div id="image-dimensions" class="muted"></div>
`;
const operation = `
  <header><h1>PowerShell 操作 · 实时监控</h1><span class="tag" id="operation-status">unknown</span></header>
  <code id="operation-id">等待 operation_id…</code>
  <div id="operation-metadata" class="muted"></div>
  <section><div class="controls">
    <button type="button" id="refresh-now">刷新状态</button>
    <button type="button" id="read-history">从头读取日志</button>
    <button type="button" id="refresh-timing">刷新延迟</button>
    <button type="button" id="cancel-operation" class="danger">取消运行</button>
  </div></section>
  <div class="logs">
    <section><div class="log-heading"><h2>stdout</h2><button type="button" id="copy-stdout">复制</button></div><pre id="stdout">(no output)</pre></section>
    <section><div class="log-heading"><h2>stderr</h2><button type="button" id="copy-stderr">复制</button></div><pre id="stderr">(no output)</pre></section>
  </div>
  <section><div class="log-heading"><h2>最近服务端 MCP 时延</h2><small>单位毫秒</small></div>
    <div class="metrics">
      <div class="metric"><strong id="server-p95">—</strong><small>MCP handler P95</small></div>
      <div class="metric"><strong id="http-p95">—</strong><small>HTTP first body P95</small></div>
    </div>
    <pre id="timing-list" style="margin-top:8px;min-height:50px;max-height:145px">(no samples)</pre>
  </section>
`;
for (const [name, view, body] of [
  ['image-viewer.html', 'image', image],
  ['operation-viewer.html', 'operation', operation],
]) {
  const html = `<!doctype html><html lang="zh-CN" data-view="${view}">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Workspace ${view}</title><style>${style}</style></head>
  <body><main>${body}
    <section><div class="metrics">
      <div class="metric"><strong id="last-rtt">—</strong><small>UI ↔ Host ↔ MCP 往返</small></div>
      <div class="metric"><strong id="last-server">—</strong><small>服务端工具内部耗时</small></div>
      <div class="metric"><strong id="last-overhead">—</strong><small>其余耗时（含传输/调度）</small></div>
      <div class="metric"><strong id="ui-p95">—</strong><small>本 iframe 最近往返 P95</small></div>
    </div></section>
    <div id="message" class="status" role="status">正在连接 MCP Apps…</div>
    <footer>UI 计时使用 performance.now()；不包含模型决策阶段。服务端时间不等于客户端网络 RTT。</footer>
    <footer>请求关联 ID: <code id="call-id">—</code>。可在后端 mcpRequestTiming / mcpHttpTiming 中查找。</footer>
  </main><script>${script}</script></body></html>`;
  await writeFile(path.join(outDir, name), html, 'utf8');
  console.log(`${name}: ${Buffer.byteLength(html)} bytes`);
}
