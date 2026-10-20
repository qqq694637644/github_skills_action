"""Temporary, metadata-only probe for MCP Tasks client capability negotiation.

This middleware does not advertise or implement Tasks. In particular it does not
change PowerShell execution or the result shape of ``workspaceCommand``.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .logging import log_action

_TASKS_EXTENSION = "io.modelcontextprotocol/tasks"
_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities"
_OBSERVED_METHODS = {
    "initialize",
    "server/discover",
    "tools/list",
    "tools/call",
    "tasks/get",
    "tasks/update",
    "tasks/cancel",
}


def summarize_tasks_request(
    method: str, params: Mapping[str, Any] | None, protocol_version: str
) -> dict[str, Any]:
    """Keep only non-sensitive protocol facts; never copy headers or tool arguments."""

    values = params if isinstance(params, Mapping) else {}
    meta = values.get("_meta")
    meta = meta if isinstance(meta, Mapping) else {}
    capabilities = meta.get(_CLIENT_CAPABILITIES)
    extensions = capabilities.get("extensions") if isinstance(capabilities, Mapping) else None
    legacy_capabilities = values.get("capabilities") if method == "initialize" else None

    # The initializer carries the client's requested version, while the context's
    # protocol_version may still be the server's pre-negotiation default.
    version = values.get("protocolVersion") if method == "initialize" else protocol_version
    if not isinstance(version, str) or len(version) > 32:
        version = "unknown"

    result: dict[str, Any] = {
        "method": method,
        "protocol_version": version,
        "per_request_capabilities_present": isinstance(capabilities, Mapping),
        "tasks_extension_declared": isinstance(extensions, Mapping)
        and _TASKS_EXTENSION in extensions,
        "legacy_tasks_declared": isinstance(legacy_capabilities, Mapping)
        and "tasks" in legacy_capabilities,
        "server_tasks_implemented": False,
    }
    if method == "tools/call":
        # Only name the known command tool; all other names and every argument
        # are deliberately omitted from this diagnostic.
        result["tool"] = (
            "workspaceCommand" if values.get("name") == "workspaceCommand" else "other"
        )
    return result


class MCPTasksProbeMiddleware:
    """Log wire-level Tasks capability evidence for the action-log monitor."""

    async def __call__(self, ctx: Any, call_next: Any) -> Any:
        if ctx.method in _OBSERVED_METHODS:
            fields = summarize_tasks_request(ctx.method, ctx.params, ctx.protocol_version)
            log_action(
                "mcpTasksProbe",
                activity={
                    "kind": "generic",
                    "phase": "completed",
                    "payload": {"operation": "mcp_tasks_probe", **fields},
                },
                **fields,
            )
        return await call_next(ctx)
