"""MCP Apps, UI-only tools, cache hints and sanitized timing measurements."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from mcp.server.mcpserver.exceptions import ToolError
from PIL import Image

from workspace_mcp.apps_ui import IMAGE_URI, OPERATION_URI
from workspace_mcp.config import MCPSettings
from workspace_mcp.observability import (
    TIMINGS,
    MCPHttpTimingMiddleware,
    MCPRequestTimingMiddleware,
    TimingSample,
)
from workspace_mcp.server import create_app, create_server
from workspace_mcp.workspace_files import LocalWorkspaceService


def _settings() -> MCPSettings:
    return MCPSettings(public_url="https://workspace.example.com/mcp")


def _env(root: Path):
    return patch.dict(os.environ, {
        "WORKSPACE_ROOT": str(root / "workspaces"),
        "WORKSPACE_OPERATION_ROOT": str(root / "operations"),
    })


def test_apps_metadata_and_image_pixel_is_not_model_content() -> None:
    async def scenario(root: Path) -> None:
        service = LocalWorkspaceService()
        server = create_server(_settings(), service=service)
        tools = {tool.name: tool for tool in await server.list_tools()}
        assert len(tools) == 14
        assert tools["openImageViewer"].meta["ui"]["resourceUri"] == IMAGE_URI
        assert tools["openOperationViewer"].meta["ui"]["resourceUri"] == OPERATION_URI
        assert tools["getImagePreview"].meta["ui"]["visibility"] == ["app"]
        assert tools["getOperationView"].meta["ui"]["visibility"] == ["app"]
        assert tools["cancelOperationFromViewer"].meta["ui"]["visibility"] == ["app"]
        assert tools["cancelOperationFromViewer"].annotations.read_only_hint is False
        assert tools["workspaceCommand"].annotations.read_only_hint is True
        assert tools["workspaceCommand"].annotations.destructive_hint is False
        resources = await server.list_resources()
        assert {str(item.uri) for item in resources} >= {IMAGE_URI, OPERATION_URI}
        for uri in [IMAGE_URI, OPERATION_URI]:
            chunks = await server.read_resource(uri)
            text = "\n".join(str(getattr(item, "content", "")) for item in chunks)
            assert "MCP Apps" in text
            assert "Workspace" in text

        prepared = await server.call_tool(
            "prepareWorkspace", {"idempotency_key": "mcp-app-preview-test"}
        )
        wid = prepared.structured_content["workspace_id"]
        image_path = root / "workspaces" / wid / "test.png"
        Image.new("RGB", (36, 22), "blue").save(image_path)
        opened = await server.call_tool(
            "openImageViewer", {"workspace_id": wid, "path": "test.png"}
        )
        assert opened.is_error is False
        assert opened.structured_content["width"] == 36
        assert opened.structured_content["ui_resource"] == IMAGE_URI
        assert "base64" not in str(opened)

        preview = await server.call_tool(
            "getImagePreview", {"workspace_id": wid, "path": "test.png"}
        )
        assert preview.is_error is False
        assert preview.structured_content["data_url"].startswith("data:image/png;base64,")
        assert preview.structured_content["server_elapsed_ms"] >= 0
        assert len(preview.content) == 1
        assert preview.content[0].type == "text"
        assert "base64" not in preview.content[0].text
        assert len(preview.content[0].text) < 200
        with pytest.raises(ToolError, match="limits"):
            await server.call_tool(
                "getImagePreview",
                {"workspace_id": wid, "path": "test.png", "max_bytes": 100},
            )
        await service.shutdown()

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        with _env(root):
            asyncio.run(scenario(root))


def test_operation_viewer_uses_existing_manager_and_never_starts_job() -> None:
    async def scenario(root: Path) -> None:
        service = LocalWorkspaceService()
        operation = {
            "operation_id": "op_0123456789abcdef",
            "state": "running",
            "workspace_id": "ws_0123456789abcdef",
            "duration_ms": 250,
            "script_summary": "PRIVATE script should not show in UI",
        }
        fake_get = AsyncMock(return_value={
            "operation": operation.copy(), "stdout": "first\n", "stderr": "",
            "next_stdout_offset": 6, "next_stderr_offset": 0,
        })
        fake_logs = AsyncMock(return_value={
            "stdout": "history", "stderr": "",
            "next_stdout_offset": 7, "next_stderr_offset": 0,
        })
        fake_cancel = AsyncMock(return_value={**operation, "state": "canceled"})
        service.command_get = fake_get
        service.command_logs = fake_logs
        service.command_cancel = fake_cancel
        service.command_start = AsyncMock(side_effect=AssertionError("must not start"))
        server = create_server(_settings(), service=service)
        initial = await server.call_tool(
            "openOperationViewer", {"operation_id": operation["operation_id"]}
        )
        assert initial.structured_content["operation"]["state"] == "running"
        assert "PRIVATE script" not in str(initial)
        snapshot = await server.call_tool("getOperationView", {
            "operation_id": operation["operation_id"], "stdout_offset": 0,
            "stderr_offset": 0, "max_bytes": 40_000,
        })
        assert snapshot.structured_content["stdout"] == "first\n"
        assert "script_summary" not in snapshot.structured_content["operation"]
        assert snapshot.structured_content["server_elapsed_ms"] >= 0
        history = await server.call_tool("getOperationView", {
            "operation_id": operation["operation_id"], "mode": "logs",
        })
        assert history.structured_content["stdout"] == "history"
        canceled = await server.call_tool(
            "cancelOperationFromViewer", {"operation_id": operation["operation_id"]}
        )
        assert canceled.structured_content["operation"]["state"] == "canceled"
        service.command_start.assert_not_awaited()
        assert fake_get.await_count == 2
        fake_logs.assert_awaited_once()
        fake_cancel.assert_awaited_once()
        await service.shutdown()

    with tempfile.TemporaryDirectory() as directory:
        with _env(Path(directory)):
            asyncio.run(scenario(Path(directory)))


def test_mcp_middleware_measures_single_call_and_drops_sensitive_arguments() -> None:
    async def scenario() -> None:
        TIMINGS.clear()
        ctx = SimpleNamespace(
            method="tools/call", request_id=123,
            params={
                "name": "workspaceCommand",
                "arguments": {"action": "start", "script": "SENSITIVE_TOKEN_123"},
            },
        )
        middleware = MCPRequestTimingMiddleware()

        async def handler(_: object) -> dict:
            await asyncio.sleep(0.008)
            return {"structuredContent": {
                "operation": {"operation_id": "op_0123456789abcdef"},
            }}

        result = await middleware(ctx, handler)
        assert result["structuredContent"]["operation"]["operation_id"]
        report = TIMINGS.query(tool="workspaceCommand")
        assert report["mcp_handler"]["count"] == 1
        sample = report["samples"][0]
        assert sample["method"] == "tools/call"
        assert sample["operation_id"] == "op_0123456789abcdef"
        assert sample["elapsed_ms"] >= 7
        assert "SENSITIVE_TOKEN" not in str(report)
        assert "SENSITIVE_TOKEN" not in str(sample)
        await asyncio.sleep(0)

    asyncio.run(scenario())


def test_http_middleware_timing_is_not_claimed_to_be_client_rtt() -> None:
    async def run() -> None:
        TIMINGS.clear()
        received = []

        async def send(message):
            received.append(message)

        async def downstream(scope, receive, send_handler):
            await asyncio.sleep(0.003)
            await send_handler({"type": "http.response.start", "status": 200, "headers": []})
            await asyncio.sleep(0.003)
            await send_handler({
                "type": "http.response.body", "body": b"ok", "more_body": False
            })

        await MCPHttpTimingMiddleware(downstream)({
            "type": "http", "method": "POST", "path": "/mcp",
            "headers": [(b"mcp-method", b"tools/call"), (b"mcp-name", b"view_image")],
        }, None, send)
        assert len(received) == 2
        sample = TIMINGS.query()["samples"][0]
        assert sample["first_byte_ms"] >= sample["header_ms"]
        assert sample["http_status"] == 200
        assert "network RTT" in TIMINGS.query()["notes"]

    asyncio.run(run())


def test_bounded_latency_samples_and_percentiles() -> None:
    TIMINGS.clear()
    for i in range(120):
        TIMINGS.append(TimingSample(
            call_id=f"{i:016x}", kind="mcp", method="tools/call",
            tool="workspaceSearch", elapsed_ms=float(i), outcome="ok",
        ))
    report = TIMINGS.query(limit=25, tool="workspaceSearch")
    assert len(report["samples"]) == 25
    assert report["mcp_handler"]["count"] == 120
    assert report["mcp_handler"]["p95_ms"] >= 110
    assert report["samples"][0]["elapsed_ms"] == 119
    assert TIMINGS.query(limit=5, tool="view_image")["samples"] == []


def test_new_protocol_wire_apps_and_cache_hints() -> None:
    capabilities = {
        "extensions": {
            "io.modelcontextprotocol/ui": {
                "mimeTypes": ["text/html;profile=mcp-app"],
            },
        },
    }
    meta = {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": capabilities,
    }

    async def scenario(root: Path) -> None:
        app = create_app(_settings())
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="https://workspace.example.com",
            ) as client:
                headers = {
                    "accept": "application/json, text/event-stream",
                    "content-type": "application/json",
                    "MCP-Protocol-Version": "2026-07-28",
                }
                discovered = await client.post(
                    "/mcp", headers={**headers, "Mcp-Method": "server/discover"},
                    json={
                        "jsonrpc": "2.0", "id": 1, "method": "server/discover",
                        "params": {
                            "_meta": meta,
                        },
                    },
                )
                assert discovered.status_code == 200, discovered.text
                payload = _json_rpc(discovered)
                assert (
                    "io.modelcontextprotocol/ui"
                    in payload["result"]["capabilities"]["extensions"]
                )
                listed = await client.post(
                    "/mcp", headers={**headers, "Mcp-Method": "tools/list"},
                    json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {
                        "_meta": meta,
                    }},
                )
                assert listed.status_code == 200, listed.text
                result = _json_rpc(listed)["result"]
                assert result["ttlMs"] == 60_000
                assert result["cacheScope"] == "private"
                tools = {item["name"]: item for item in result["tools"]}
                assert tools["openImageViewer"]["_meta"]["ui"]["resourceUri"] == IMAGE_URI
                assert tools["openOperationViewer"]["_meta"]["ui"]["resourceUri"] == OPERATION_URI
                resource = await client.post(
                    "/mcp", headers={
                        **headers, "Mcp-Method": "resources/read", "Mcp-Name": IMAGE_URI,
                    },
                    json={"jsonrpc": "2.0", "id": 3, "method": "resources/read", "params": {
                        "uri": IMAGE_URI,
                        "_meta": meta,
                    }},
                )
                assert resource.status_code == 200, resource.text[:600]
                resource_result = _json_rpc(resource)["result"]
                assert resource_result["ttlMs"] == 300_000
                assert resource_result["cacheScope"] == "private"
                resource_item = resource_result["contents"][0]
                assert resource_item["mimeType"] == "text/html;profile=mcp-app"
                assert "Workspace 图片预览" in resource_item["text"]
                assert "UI ↔ Host ↔ MCP" in resource_item["text"]

                async def tool_call(name: str, arguments: dict, id_value: int) -> dict:
                    response = await client.post(
                        "/mcp",
                        headers={**headers, "Mcp-Method": "tools/call", "Mcp-Name": name},
                        json={
                            "jsonrpc": "2.0", "id": id_value, "method": "tools/call",
                            "params": {"name": name, "arguments": arguments, "_meta": meta},
                        },
                    )
                    assert response.status_code == 200, response.text[:500]
                    return _json_rpc(response)["result"]

                created = await tool_call(
                    "prepareWorkspace", {"idempotency_key": "apps-wire-image-workspace"}, 4
                )
                assert not created["isError"]
                wid = created["structuredContent"]["workspace_id"]
                image_file = root / "workspaces" / wid / "capture.png"
                Image.new("RGB", (24, 32), "green").save(image_file)
                opened = await tool_call(
                    "openImageViewer", {"workspace_id": wid, "path": "capture.png"}, 5
                )
                assert opened["structuredContent"]["width"] == 24
                assert "base64" not in str(opened)
                preview = await tool_call(
                    "getImagePreview", {"workspace_id": wid, "path": "capture.png"}, 6
                )
                assert preview["structuredContent"]["data_url"].startswith("data:image/png;base64,")
                assert preview["structuredContent"]["call_id"]
                assert "base64" not in preview["content"][0]["text"]
                latency = await tool_call("getMcpLatency", {"limit": 20}, 7)
                assert latency["structuredContent"]["mcp_handler"]["count"] >= 4
                records = TIMINGS.query()["samples"]
                assert any(item["kind"] == "http" for item in records)
                assert any(item["kind"] == "mcp" for item in records)
                http_ids = {item["call_id"] for item in records if item["kind"] == "http"}
                mcp_ids = {item["call_id"] for item in records if item["kind"] == "mcp"}
                assert http_ids & mcp_ids, "MCP and HTTP spans must share a call_id"

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        with _env(root):
            asyncio.run(scenario(root))


def _json_rpc(response: httpx.Response) -> dict:
    if response.headers.get("content-type", "").startswith("text/event-stream"):
        return next(
            json.loads(line[6:])
            for line in response.text.splitlines()
            if line.startswith("data: ")
        )
    return response.json()
