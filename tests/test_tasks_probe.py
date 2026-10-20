from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pytest

from workspace_mcp.config import MCPSettings
from workspace_mcp.logging import clear_action_events
from workspace_mcp.server import create_app
from workspace_mcp.tasks_probe import MCPTasksProbeMiddleware, summarize_tasks_request


def test_new_protocol_tasks_capability_is_detected_only_in_request_metadata() -> None:
    params = {
        "name": "workspaceCommand",
        "arguments": {"action": "start", "script": "SECRET SCRIPT"},
        "_meta": {
            "io.modelcontextprotocol/clientCapabilities": {
                "extensions": {"io.modelcontextprotocol/tasks": {}}
            },
            "authorization": "SHOULD NOT BE LOGGED",
        },
    }
    result = summarize_tasks_request("tools/call", params, "2026-07-28")
    assert result == {
        "method": "tools/call",
        "protocol_version": "2026-07-28",
        "per_request_capabilities_present": True,
        "tasks_extension_declared": True,
        "legacy_tasks_declared": False,
        "server_tasks_implemented": False,
        "tool": "workspaceCommand",
    }
    assert "SECRET SCRIPT" not in str(result)
    assert "SHOULD NOT BE LOGGED" not in str(result)


def test_absent_capability_and_legacy_tasks_are_distinguished() -> None:
    current = summarize_tasks_request("tools/call", {"name": "other"}, "2026-07-28")
    assert current["per_request_capabilities_present"] is False
    assert current["tasks_extension_declared"] is False
    assert current["tool"] == "other"

    old = summarize_tasks_request(
        "initialize", {"protocolVersion": "2025-11-25", "capabilities": {"tasks": {}}}, "unknown"
    )
    assert old["legacy_tasks_declared"] is True
    assert old["tasks_extension_declared"] is False
    assert old["protocol_version"] == "2025-11-25"


@pytest.mark.parametrize("method", ["server/discover", "tools/list", "tasks/get"])
def test_probe_logs_only_allowlisted_metadata_without_modifying_response(method: str) -> None:
    async def scenario() -> None:
        context = SimpleNamespace(
            method=method,
            protocol_version="2026-07-28",
            params={
                "taskId": "PRIVATE TASK ID",
                "authorization": "PRIVATE TOKEN",
                "_meta": {"io.modelcontextprotocol/clientCapabilities": {"extensions": {}}},
            },
        )
        result_sentinel = {"unchanged": True}

        async def next_handler(ctx: object) -> object:
            assert ctx is context
            return result_sentinel

        with patch("workspace_mcp.tasks_probe.log_action") as logger:
            result = await MCPTasksProbeMiddleware()(context, next_handler)
        assert result is result_sentinel
        args, kwargs = logger.call_args
        assert args == ("mcpTasksProbe",)
        assert kwargs["activity"]["payload"]["operation"] == "mcp_tasks_probe"
        assert kwargs["method"] == method
        assert "PRIVATE TOKEN" not in str(kwargs)
        assert "PRIVATE TASK ID" not in str(kwargs)

    asyncio.run(scenario())


def test_probe_skips_unrelated_methods() -> None:
    async def scenario() -> None:
        ctx = SimpleNamespace(method="resources/read", params=None, protocol_version="2026-07-28")
        with patch("workspace_mcp.tasks_probe.log_action") as logger:
            assert await MCPTasksProbeMiddleware()(ctx, lambda _: asyncio.sleep(0)) is None
        logger.assert_not_called()

    asyncio.run(scenario())


def test_real_mcp_http_request_publishes_copyable_probe_log() -> None:
    async def scenario() -> None:
        clear_action_events()
        app = create_app(MCPSettings(public_url="https://workspace.example.com/mcp"))
        transport = httpx.ASGITransport(app=app)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(
                transport=transport, base_url="https://workspace.example.com"
            ) as client:
                request = {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "server/discover",
                    "params": {
                        "_meta": {
                            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                            "io.modelcontextprotocol/clientInfo": {
                                "name": "tasks-probe-test",
                                "version": "1.0",
                            },
                            "io.modelcontextprotocol/clientCapabilities": {
                                "extensions": {"io.modelcontextprotocol/tasks": {}}
                            },
                            "private": "NEVER_LOG_THIS_VALUE",
                        }
                    },
                }
                result = await client.post(
                    "/mcp",
                    json=request,
                    headers={
                        "MCP-Protocol-Version": "2026-07-28",
                        "Mcp-Method": "server/discover",
                        "Accept": "application/json, text/event-stream",
                    },
                )
                assert result.status_code == 200, result.text
                logs = await client.get(
                    "/v1/action-logs",
                    params={"after": 0, "wait": 0, "operation": "mcp_tasks_probe"},
                )
                assert logs.status_code == 200
                events = logs.json()["items"]
                assert any(
                    event["event"]["payload"].get("tasks_extension_declared") is True
                    and event["event"]["payload"].get("method") == "server/discover"
                    for event in events
                ), events
                assert "NEVER_LOG_THIS_VALUE" not in str(events)

    asyncio.run(scenario())
