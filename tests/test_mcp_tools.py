from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from mcp.server.mcpserver.exceptions import ToolError

from workspace_mcp.config import MCPSettings
from workspace_mcp.server import create_server


def _settings() -> MCPSettings:
    return MCPSettings(
        public_url="https://workspace.example.com/mcp",
        issuer="https://auth.example.com/",
        audience="https://workspace.example.com/mcp",
        jwks_url="https://auth.example.com/.well-known/jwks.json",
    )


def test_mcp_exposes_exact_workspace_tool_set_with_oauth_metadata() -> None:
    async def scenario() -> None:
        server = create_server(_settings())
        tools = await server.list_tools()
        by_name = {tool.name: tool for tool in tools}
        assert set(by_name) == {
            "prepareWorkspace",
            "workspaceInspect",
            "workspaceSearch",
            "workspaceReadFiles",
            "workspaceWriteFile",
            "workspaceApplyPatch",
            "workspaceCommand",
        }
        for tool in tools:
            assert tool.meta == {
                "securitySchemes": [{"type": "oauth2", "scopes": ["workspace:execute"]}]
            }
            assert tool.output_schema is not None

        command = by_name["workspaceCommand"]
        assert command.input_schema["properties"]["action"]["enum"] == [
            "start",
            "get",
            "logs",
            "cancel",
            "list",
        ]
        assert "wait_seconds" in command.input_schema["properties"]
        assert command.annotations is not None
        assert command.annotations.destructive_hint is True
        assert command.annotations.open_world_hint is True

        for name in ("workspaceInspect", "workspaceSearch", "workspaceReadFiles"):
            assert by_name[name].annotations is not None
            assert by_name[name].annotations.read_only_hint is True

    asyncio.run(scenario())


def test_mcp_tool_calls_return_structured_content_and_new_command_follow_shape() -> None:
    async def scenario(root: Path) -> None:
        server = create_server(_settings())
        prepared = await server.call_tool(
            "prepareWorkspace", {"idempotency_key": "mcp-tool-workspace-001"}
        )
        assert prepared.is_error is False
        workspace_id = str(prepared.structured_content["workspace_id"])

        write = await server.call_tool(
            "workspaceWriteFile",
            {
                "workspace_id": workspace_id,
                "path": "hello.txt",
                "content": "hello\n",
            },
        )
        assert write.is_error is False
        assert write.structured_content["written"] is True

        start = await server.call_tool(
            "workspaceCommand",
            {
                "action": "start",
                "idempotency_key": "mcp-tool-command-001",
                "workspace_id": workspace_id,
                "script": "Write-Output 'mcp-output'",
                "plain_output": True,
            },
        )
        assert start.is_error is False
        assert start.structured_content["operation"]["state"] == "succeeded"
        assert "mcp-output" in start.structured_content["stdout"]
        assert start.structured_content["next_stdout_offset"] > 0

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        with patch.dict(
            os.environ,
            {
                "WORKSPACE_ROOT": str(root / "workspaces"),
                "WORKSPACE_OPERATION_ROOT": str(root / "operations"),
                "WORKSPACE_COMMAND_SYNC_WAIT_SECONDS": "5",
            },
            clear=False,
        ):
            asyncio.run(scenario(root))


def test_mcp_workspace_errors_are_model_readable_tool_errors() -> None:
    async def scenario() -> None:
        server = create_server(_settings())
        with pytest.raises(ToolError) as captured:
            await server.call_tool(
                "workspaceReadFiles",
                {
                    "workspace_id": "ws_0000000000000000",
                    "paths": ["missing.txt"],
                },
            )
        text = str(captured.value)
        assert "WORKSPACE_NOT_FOUND" in text
        assert "check_workspace_request" in text

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        with patch.dict(os.environ, {"WORKSPACE_ROOT": str(root / "workspaces")}, clear=False):
            asyncio.run(scenario())
