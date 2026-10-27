"""MCP Apps image and operation viewers with app-only data tools.

All access goes through the normal authenticated MCP tools/call route, not a
public image URL or an unauthenticated HTTP endpoint.
"""

from __future__ import annotations

import base64
import json
import re
import time
from importlib.resources import files
from typing import Any

from mcp.server.apps import Apps
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import CallToolResult, TextContent, ToolAnnotations

from .image_tool import read_workspace_image
from .models import OperationId, WorkspaceId, WorkspacePath
from .observability import TIMINGS, current_call_id
from .workspace_files import LocalWorkspaceService
from .workspace_patch import WorkspaceToolError

IMAGE_URI = "ui://workspace/image-viewer/v1.html"
OPERATION_URI = "ui://workspace/operation-viewer/v1.html"
_APP_READ_ONLY = ToolAnnotations(
    read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False
)
_APP_ACTION = ToolAnnotations(
    read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=False
)
_UI_ONLY = {"ui": {"visibility": ["app"]}}
_OPERATION_RE = re.compile(r"^op_[0-9a-f]{16}$")


def _tool_error(exc: WorkspaceToolError) -> ToolError:
    return ToolError(json.dumps({
        "error": {
            "code": exc.code,
            "message": exc.message,
            "suggested_next_action": "check_workspace_request",
        },
    }))


def _summary(operation: dict[str, Any]) -> dict[str, Any]:
    """Avoid leaking the script or credentials in UI and diagnostics."""
    keys = (
        "operation_id", "workspace_id", "state", "root_pid", "job_assigned",
        "started_at", "finished_at", "deadline_at", "duration_ms",
        "exit_code", "stdout_bytes", "stderr_bytes", "stdout_truncated",
        "stderr_truncated", "error_code", "error_message",
    )
    return {key: operation.get(key) for key in keys if key in operation}


def configure_apps(service: LocalWorkspaceService) -> Apps:
    """Register model-facing renderer tools before MCPServer consumes the extension."""
    apps = Apps()
    ui_dir = files("workspace_mcp").joinpath("ui")
    apps.add_html_resource(
        IMAGE_URI, ui_dir.joinpath("image-viewer.html").read_text(encoding="utf-8"),
        title="Workspace image preview",
        description="Interactive preview, zoom and image metadata",
    )
    apps.add_html_resource(
        OPERATION_URI, ui_dir.joinpath("operation-viewer.html").read_text(encoding="utf-8"),
        title="Workspace operation and latency dashboard",
        description="PowerShell status, stdout/stderr logs, latency and cancellation",
    )

    @apps.tool(
        name="openImageViewer",
        title="Show workspace image preview",
        resource_uri=IMAGE_URI,
        description=(
            "Display a workspace-relative PNG, JPEG, GIF or WebP in an MCP Apps image viewer. "
            "Returns file metadata; a compatible host renders the image widget, which requests "
            "a bounded preview separately. Without MCP Apps support, returns metadata only."
        ),
        annotations=_APP_READ_ONLY,
    )
    async def open_image_viewer(workspace_id: WorkspaceId, path: WorkspacePath) -> dict[str, Any]:
        try:
            image = read_workspace_image(
                service.root(workspace_id), path,
                max_width=16, max_height=16, max_bytes=32_000,
            )
        except WorkspaceToolError as exc:
            raise _tool_error(exc) from exc
        return {
            "workspace_id": workspace_id,
            "path": image.path,
            "mime_type": image.original["mime_type"],
            "width": image.original["width"],
            "height": image.original["height"],
            "bytes": image.original["bytes"],
            "ui_resource": IMAGE_URI,
            "note": "Preview pixels are retrieved by an app-only tool after the UI opens.",
        }

    @apps.tool(
        name="openOperationViewer",
        title="Show PowerShell operation and log viewer",
        resource_uri=OPERATION_URI,
        description=(
            "Show an existing PowerShell operation by operation_id in a live MCP Apps dashboard: "
            "status, stdout/stderr logs, cancellation, and MCP/HTTP timing. Does not start a "
            "new process. Compatible hosts show the UI; other hosts receive status metadata."
        ),
        annotations=_APP_READ_ONLY,
    )
    async def open_operation_viewer(operation_id: OperationId) -> dict[str, Any]:
        try:
            result = await service.command_get(
                operation_id, stdout_offset=0, stderr_offset=0,
                max_bytes=1024, wait_seconds=0,
            )
        except WorkspaceToolError as exc:
            raise _tool_error(exc) from exc
        return {
            "operation_id": operation_id,
            "operation": _summary(result["operation"]),
            "ui_resource": OPERATION_URI,
            "note": (
                "Status and logs are fetched by app-only tools using the same operation manager."
            ),
        }

    return apps


def register_ui_data_tools(server: Any, service: LocalWorkspaceService) -> None:
    """UI-only helpers; no dedicated REST endpoints and no process creation."""

    @server.tool(
        name="getImagePreview",
        title="Fetch bounded image preview for MCP App",
        description="UI-only bounded PNG/JPEG/GIF/WebP preview. Base64 remains in tool response.",
        annotations=_APP_READ_ONLY,
        meta=_UI_ONLY,
    )
    async def get_image_preview(
        workspace_id: WorkspaceId,
        path: WorkspacePath,
        max_width: int = 1024,
        max_height: int = 1024,
        max_bytes: int = 350_000,
    ) -> CallToolResult:
        if not (64 <= max_width <= 2000 and 64 <= max_height <= 2000
                and 32_000 <= max_bytes <= 450_000):
            raise ToolError("Preview limits: 64-2000 pixels and 32000-450000 bytes.")
        started = time.perf_counter()
        try:
            image = read_workspace_image(
                service.root(workspace_id), path, max_width=max_width,
                max_height=max_height, max_bytes=max_bytes,
            )
        except WorkspaceToolError as exc:
            raise _tool_error(exc) from exc
        payload = {
            "path": image.path,
            "mime_type": image.mime_type,
            "width": image.width,
            "height": image.height,
            "resized": image.resized,
            "data_url": (
                f"data:{image.mime_type};base64,{base64.b64encode(image.data).decode('ascii')}"
            ),
            "server_elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
            "call_id": current_call_id(),
        }
        return CallToolResult(
            content=[TextContent(type="text", text="Image preview returned to MCP App.")],
            structuredContent=payload,
        )

    @server.tool(
        name="getOperationView",
        title="Read bounded PowerShell operation status and log offsets for MCP App",
        description="UI-only incremental operation status/stdout/stderr lookup; no process start.",
        annotations=_APP_READ_ONLY,
        meta=_UI_ONLY,
    )
    async def get_operation_view(
        operation_id: OperationId,
        stdout_offset: int = 0,
        stderr_offset: int = 0,
        max_bytes: int = 40_000,
        mode: str = "get",
    ) -> dict[str, Any]:
        if (not _OPERATION_RE.fullmatch(operation_id)
                or not 0 <= stdout_offset <= 1_000_000_000
                or not 0 <= stderr_offset <= 1_000_000_000
                or not 1 <= max_bytes <= 50_000
                or mode not in {"get", "logs"}):
            raise ToolError("Invalid operation viewer paging parameters.")
        started = time.perf_counter()
        try:
            if mode == "logs":
                data = await service.command_logs(
                    operation_id, stdout_offset=stdout_offset,
                    stderr_offset=stderr_offset, max_bytes=max_bytes,
                )
            else:
                data = await service.command_get(
                    operation_id, stdout_offset=stdout_offset,
                    stderr_offset=stderr_offset, max_bytes=max_bytes, wait_seconds=0,
                )
        except WorkspaceToolError as exc:
            raise _tool_error(exc) from exc
        if isinstance(data.get("operation"), dict):
            data["operation"] = _summary(data["operation"])
        data["server_elapsed_ms"] = round((time.perf_counter() - started) * 1000, 2)
        data["call_id"] = current_call_id()
        return data

    @server.tool(
        name="cancelOperationFromViewer",
        title="Cancel PowerShell operation from MCP App",
        description="UI-only user-initiated cancellation of an existing operation.",
        annotations=_APP_ACTION,
        meta=_UI_ONLY,
    )
    async def cancel_operation_from_viewer(operation_id: OperationId) -> dict[str, Any]:
        try:
            operation = await service.command_cancel(operation_id)
        except WorkspaceToolError as exc:
            raise _tool_error(exc) from exc
        return {"operation": _summary(operation)}

    @server.tool(
        name="getMcpLatency",
        title="Inspect recent per-request MCP and HTTP latency",
        description=(
            "Return bounded sanitized timing samples and p50/p95/p99 aggregates measured at "
            "this server for recent MCP messages and HTTP responses. MCP handler times and "
            "server-side first-byte times do NOT include client network RTT. Supports optional "
            "tool filtering. Useful for diagnosing slow individual tool calls without scripts."
        ),
        annotations=_APP_READ_ONLY,
    )
    async def get_mcp_latency(limit: int = 25, tool: str | None = None) -> dict[str, Any]:
        if not 1 <= limit <= 100 or (
            tool is not None and not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", tool)
        ):
            raise ToolError("limit must be 1-100 and tool must be a simple tool name.")
        return TIMINGS.query(limit=limit, tool=tool)
