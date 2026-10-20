# MCP Tasks capability probe (temporary PR)

This branch adds **observation only** to the Remote MCP server. It does not
advertise or implement `io.modelcontextprotocol/tasks`, start an MCP Task,
change the `workspaceCommand` execution flow, or change tool annotations.

## How to capture ChatGPT's actual requests

1. Deploy/restart this probe branch and reconnect or refresh the MCP connector in ChatGPT.
2. Invoke `workspaceCommand` with `action="list"` (no PowerShell script required).
   This is a safe way to generate a `tools/call` without launching a process.
3. In the existing action monitor / server logs, copy lines beginning with
   `ACTION mcpTasksProbe`, especially the `tools/call` event. Handshake and
   discovery events (`initialize`, `server/discover`, `tools/list`) are useful
   context if present. The same records are available through the **existing**
   authenticated action log endpoint:

   `GET /v1/action-logs?after=0&wait=0&limit=100&operation=mcp_tasks_probe`

   The endpoint retains its existing access-control requirements; do not paste
   any authorization header or bearer token into the conversation.

Example **synthetic** diagnostic (not a ChatGPT observation):

```text
ACTION mcpTasksProbe method="tools/call" protocol_version="2026-07-28" per_request_capabilities_present=true tasks_extension_declared=true legacy_tasks_declared=false server_tasks_implemented=false tool="workspaceCommand"
```

`tasks_extension_declared` checks for
`params._meta["io.modelcontextprotocol/clientCapabilities"].extensions["io.modelcontextprotocol/tasks"]`
on that exact request. `legacy_tasks_declared` separately tracks the old
handshake capability (it is **not** proof of 2026 Tasks extension support).
Only protocol metadata and an allowlisted tool name are logged: **no script,
tool arguments, task ID, headers, client identity, or bearer token**.

## Interpretation limits

This probe deliberately does **not** advertise Tasks support, because the
current Python SDK does not implement the extension. If
`tasks_extension_declared=true` on a real `tools/call`, the client sent that
capability. If it is `false`, the client did not declare it on that call; that
**does not prove** it cannot support Tasks on a server which implements and
advertises the extension. This observation alone does not demonstrate that
`tasks/get`, `tasks/update`, or `tasks/cancel` would work end-to-end.

Specification: https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks
