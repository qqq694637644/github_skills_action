# MCP Apps + PowerShell operation viewer + request latency

This change stacks on PR #23 (`gpt/view-image-monitor-activity`), not on `main`.

## What is implemented

### MCP Apps (2026 protocol)

The Python MCP SDK's `Apps` extension advertises `io.modelcontextprotocol/ui`. Two
model-facing tools bind to **versioned** `ui://` resources:

| Tool | UI resource | Result without UI support |
|---|---|---|
| `openImageViewer(workspace_id, path)` | `ui://workspace/image-viewer/v1.html` | Image metadata |
| `openOperationViewer(operation_id)` | `ui://workspace/operation-viewer/v1.html` | Operation state metadata |

Both resources are standalone HTML with the official
`@modelcontextprotocol/ext-apps@2.0.3` client bundled locally. They do not
fetch executable JavaScript from a third-party CDN. HTML is included in the
Python wheel; building UI assets is a **developer/release** operation, not a
production server startup requirement.

The image app calls `getImagePreview` with an absolute limit of 450,000 bytes,
2,000×2,000 pixels and an ordinary, workspace-relative path check.
The UI fetches the preview on demand, zooms it and shows metadata.
The image Base64 exists only in the UI helper's `structuredContent`, not in
the plain text content or action logs. It is **not proof that the LLM has vision
access to those pixels**.

The operation app uses the **existing** `WorkspaceOperationManager` through
`getOperationView`, which delegates to `command_get` or `command_logs` and
supports explicit stdout/stderr byte offsets. It shows state, duration, separate
log streams, copying, manual refresh and bounded automatic refresh while running.
`cancelOperationFromViewer` only calls the existing cancellation method after
a deliberate two-click UI confirmation; neither viewer starts PowerShell jobs.

The three UI-specific helper tools have `_meta.ui.visibility=["app"]`:
`getImagePreview`, `getOperationView`, `cancelOperationFromViewer`.
The standard `workspaceCommand` is **not** changed. Clients without MCP Apps
may invoke the two rendering tools and will get metadata rather than an iframe.
The `ui://` rendering and tool-call bridge still need to be verified in a
deployed ChatGPT connection; passing the server-side protocol tests doesn't
prove that an actual ChatGPT iframe rendered.

## Latency: what is measured and what is NOT measured

`MCPRequestTimingMiddleware` measures decoded MCP handler latency, including
schema dispatch and the tool execution, with `time.perf_counter()`. Each request
produces a redacted `ACTION mcpRequestTiming` server log:

```text
ACTION mcpRequestTiming call_id="..." method="tools/call" tool="workspaceCommand" elapsed_ms=... outcome="ok" operation_id="op_..."
```

`MCPHttpTimingMiddleware` measures each `POST /mcp` request at the ASGI
boundary (after arriving at the Python process), without logging request bodies:

```text
ACTION mcpHttpTiming call_id="..." method="tools/call" tool="workspaceCommand" status=200 header_ms=... first_byte_ms=... elapsed_ms=... response_bytes=...
```

Two logs for the same HTTP request carry the **same `call_id`**.
For SSE streaming, `elapsed_ms` can include an open stream's lifetime;
`first_byte_ms` is the first response **body chunk on the server**, not a
measured arrival at the user's browser. Reverse-proxy, TLS, Internet RTT,
browser/rendering, ChatGPT model decision and host UI delays are not observable
by the Python backend.

**In contrast**, the MCP Apps iframe uses `performance.now()` around
`app.callServerTool(...)` and shows its experienced **iframe ↔ host ↔ MCP
roundtrip**, server-side helper duration and the difference. Its P95 comes from
the latest 50 UI calls in that iframe. This is the closest view of a real user
network interaction, but even it does **not** include model reasoning time.
The UI displays a `call_id` for correlating one request to both server logs.

`getMcpLatency(limit=25, tool=null)` returns a bounded in-memory ring buffer
(last 600 MCP/HTTP samples) with timestamp, method, tool, call_id, status and
p50/p95/p99/max/mean. It does not log or return PowerShell arguments, scripts,
tokens or image Base64. Records disappear after a server restart and are
per-process; behind multiple workers configure persistent OTLP tracing.
For an individual call, look at one sample's `call_id`, rather than only the
aggregated percentile. Call `getMcpLatency` through ChatGPT after reproducing
a laggy tool action.

**Interpretation:** if handler latency is high, investigate the Python/tool
handler or operation wait. If HTTP first-byte is much higher than handler,
inspect transport, serialization, buffering or server queueing. If iframe RTT
is much higher than server-side timing, investigate network, gateway, client
host bridge and browser scheduling. These differences are diagnostic estimates,
not an exact decomposition of each network segment.

## Optional OpenTelemetry / OTLP

The MCP SDK has built-in OpenTelemetry request spans. Our middleware also adds
`workspace.mcp.request` spans with method/tool/elapsed/outcome and an
`operation_id` attribute for correlation. Local request-timing logs work
**without** OTel exporter configuration.

To export spans, install optional dependencies and configure an authorized
collector (OTLP HTTP endpoint):

```powershell
python -m pip install -e '.[observability]'
$env:WORKSPACE_OTEL_ENABLED = '1'
$env:OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318'
$env:OTEL_SERVICE_NAME = 'workspace-mcp'
python -m workspace_mcp.server
```

By default, OTLP export is **off**. When enabled, missing dependencies or
missing endpoint produce a clear startup error. Do not put credentials in
logs or tool parameters; configure exporter authentication through the
deployment's protected environment and collector.

## Cache hints

The server returns `cacheScope: private` and these `ttlMs` hints on
protocol `2026-07-28`:

| MCP result | TTL |
|---|---:|
| `tools/list` | 60,000 ms |
| `resources/list` | 60,000 ms |
| `resources/read` | 300,000 ms |
| `server/discover` | 30,000 ms |

These are **advisory**, client-dependent hints on stable listings and
versioned UI assets. No command results, operation state, image previews or
timing samples are cached. To invalidate a previously cached UI bundle after a
breaking release, bump the `ui://.../vN.html` URI and re-register the tool
metadata before deploying. ChatGPT clients may decide not to honor the hints.

## Build and test

```powershell
python -m pip install -e '.[dev]'
python -m pytest -q tests/test_mcp_apps_observability.py tests/test_view_image.py
python -m ruff check src/workspace_mcp
cd mcp-ui
npm ci
npm run check
```

Node 20+ is needed **only for rebuilding the HTML**. This writes
`src/workspace_mcp/ui/image-viewer.html` and `operation-viewer.html`;
commit both generated assets with any source changes.
The packaging includes `workspace_mcp/ui/*.html` when installing the Python
wheel. To test a wheel, run `python -m pip wheel --no-deps . -w dist` and
inspect the contents of the resulting wheel.

### Manual deployed-ChatGPT acceptance checks

1. Deploy the new branch, reconnect or refresh the Remote MCP tool registry.
   Confirm `server/discover` advertises `io.modelcontextprotocol/ui` and
   `tools/list` includes `openImageViewer` and `openOperationViewer`.
2. Create/use a Workspace, place a *small PNG* at a known relative path and
   call `openImageViewer(workspace_id="ws_...", path="screenshots/test.png")`.
   Confirm ChatGPT displays an inline iframe with pixels, zoom and image RTT.
   If it displays metadata only, record the client's `clientCapabilities`
   `io.modelcontextprotocol/ui` MIME negotiation and do not claim UI success.
3. Start an ordinary PowerShell operation with `workspaceCommand(action="start")`,
   then call `openOperationViewer(operation_id="op_...")`. Confirm that status,
   offset-based stdout/stderr updates, cancel confirmation and latency statistics
   work. The viewer must **not** start any PowerShell process by itself.
4. Reproduce one slow MCP tool call. Use `getMcpLatency(limit=30)` and look up
   `ACTION mcpRequestTiming` and `ACTION mcpHttpTiming` lines with the
   matching `call_id`. Record `elapsed_ms`, `header_ms`,
   `first_byte_ms` and iframe RTT if present. Treat reverse-proxy timings
   as a separate measurement (not directly available in this MCP server).
5. Optionally enable OTLP collector and verify the span chain and operation
   correlation. Disable it again if export is not required.

### Explicitly unchanged

- No changes to the deliberately configured PowerShell tool annotations
  (`read_only_hint=True`, `destructive_hint=False`).
- No changes to PowerShell execution policy, start/get/logs/cancel semantics,
  lifetime, idempotency or process tree cancellation.
- No MCP Tasks protocol advertisement or implementation.
