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
        jwks_url="https://auth.example.com/.well-known/jwks.json",
        allowed_subject="personal-user",
    )


def test_mcp_exposes_exact_workspace_tool_set_and_precise_input_schema() -> None:
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
            assert tool.output_schema is not None
            assert tool.meta == {
                "securitySchemes": [{"type": "oauth2", "scopes": ["workspace:execute"]}]
            }

        command = by_name["workspaceCommand"]
        assert command.input_schema["properties"]["action"]["enum"] == [
            "start",
            "get",
            "logs",
            "cancel",
            "list",
        ]
        assert "wait_seconds" in command.input_schema["properties"]
        command_properties = command.input_schema["properties"]
        assert command_properties["workspace_id"]["anyOf"][0]["pattern"] == "^ws_[0-9a-f]{16}$"
        assert command_properties["script"]["anyOf"][0]["minLength"] == 1
        assert command_properties["script"]["anyOf"][0]["maxLength"] == 20_000
        assert command_properties["max_bytes"]["minimum"] == 1
        assert command_properties["max_bytes"]["maximum"] == 500_000
        assert command_properties["wait_seconds"]["minimum"] == 0
        assert command_properties["wait_seconds"]["maximum"] == 30
        action_conditions = command.input_schema["allOf"]
        assert any(
            item.get("if", {}).get("properties", {}).get("action", {}).get("const") == "start"
            and set(item["then"]["required"]) == {"idempotency_key", "workspace_id", "script"}
            for item in action_conditions
        )
        for action in ("get", "logs", "cancel"):
            assert any(
                item.get("if", {}).get("properties", {}).get("action", {}).get("const") == action
                and item["then"]["required"] == ["operation_id"]
                for item in action_conditions
            )
        prepare_conditions = by_name["prepareWorkspace"].input_schema["allOf"]
        required_branches = prepare_conditions[0]["anyOf"]
        assert {tuple(branch["required"]) for branch in required_branches} == {
            ("workspace_id",),
            ("idempotency_key",),
        }
        write_properties = by_name["workspaceWriteFile"].input_schema["properties"]
        assert write_properties["path"]["minLength"] == 1
        assert write_properties["path"]["maxLength"] == 500
        assert write_properties["expected_sha256"]["anyOf"][0]["pattern"] == ("^[0-9a-fA-F]{64}$")
        write_conditions = by_name["workspaceWriteFile"].input_schema["allOf"]
        assert any(
            item.get("if", {}).get("properties", {}).get("mode", {}).get("const")
            == "overwrite_if_sha256_matches"
            and item["if"].get("required") == ["mode"]
            and item["then"]["required"] == ["expected_sha256"]
            for item in write_conditions
        )

        read_paths = by_name["workspaceReadFiles"].input_schema["properties"]["paths"]
        assert read_paths["items"]["minLength"] == 1
        assert read_paths["items"]["maxLength"] == 500
        inspect_properties = by_name["workspaceInspect"].input_schema["properties"]
        assert inspect_properties["paths"]["anyOf"][0]["items"]["minLength"] == 1
        assert inspect_properties["paths"]["anyOf"][0]["items"]["maxLength"] == 500
        assert inspect_properties["queries"]["anyOf"][0]["items"]["minLength"] == 1
        assert inspect_properties["queries"]["anyOf"][0]["items"]["maxLength"] == 500
        assert command.annotations is not None
        assert command.annotations.destructive_hint is True
        assert command.annotations.open_world_hint is True

        for name in ("workspaceInspect", "workspaceSearch", "workspaceReadFiles"):
            assert by_name[name].annotations is not None
            assert by_name[name].annotations.read_only_hint is True

    asyncio.run(scenario())


def test_command_schema_advertises_runtime_configured_limits() -> None:
    async def scenario(root: Path) -> None:
        with patch.dict(
            os.environ,
            {
                "WORKSPACE_ROOT": str(root / "workspaces"),
                "WORKSPACE_OPERATION_ROOT": str(root / "operations"),
                "WORKSPACE_COMMAND_MAX_TIMEOUT_SECONDS": "42",
                "WORKSPACE_COMMAND_MAX_OUTPUT_BYTES": "123456",
            },
            clear=False,
        ):
            server = create_server(_settings())
            tools = {tool.name: tool for tool in await server.list_tools()}
            properties = tools["workspaceCommand"].input_schema["properties"]
            assert properties["timeout_seconds"]["maximum"] == 42
            assert properties["max_output_bytes"]["maximum"] == 123_456

            prepared = await server.call_tool(
                "prepareWorkspace", {"idempotency_key": "dynamic-limits-workspace-001"}
            )
            workspace_id = str(prepared.structured_content["workspace_id"])
            with pytest.raises(ToolError) as timeout_limit:
                await server.call_tool(
                    "workspaceCommand",
                    {
                        "action": "start",
                        "idempotency_key": "dynamic-limits-op-001",
                        "workspace_id": workspace_id,
                        "script": "Write-Output unreachable",
                        "timeout_seconds": 43,
                    },
                )
            assert "timeout_seconds exceeds 42" in str(timeout_limit.value)

    with tempfile.TemporaryDirectory() as temp:
        asyncio.run(scenario(Path(temp)))


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
        assert len(write.content) == 1
        assert "hello\n" not in write.content[0].text

        await server.call_tool(
            "workspaceWriteFile",
            {
                "workspace_id": workspace_id,
                "path": "large.txt",
                "content": "x" * 2_000,
            },
        )
        read = await server.call_tool(
            "workspaceReadFiles",
            {"workspace_id": workspace_id, "paths": ["large.txt"]},
        )
        assert "x" * 100 in read.structured_content["files"][0]["content"]
        assert len(read.content[0].text) < 200
        assert "x" * 100 not in read.content[0].text

        with pytest.raises(ToolError) as invalid_path_item:
            await server.call_tool(
                "workspaceReadFiles",
                {"workspace_id": workspace_id, "paths": [""]},
            )
        assert "at least 1 character" in str(invalid_path_item.value)

        with pytest.raises(ToolError) as missing_hash:
            await server.call_tool(
                "workspaceWriteFile",
                {
                    "workspace_id": workspace_id,
                    "path": "hello.txt",
                    "content": "replacement\n",
                    "mode": "overwrite_if_sha256_matches",
                },
            )
        assert "expected_sha256 is required" in str(missing_hash.value)

        with pytest.raises(ToolError) as escaped:
            await server.call_tool(
                "workspaceWriteFile",
                {
                    "workspace_id": workspace_id,
                    "path": "../escape.txt",
                    "content": "blocked\n",
                },
            )
        assert "WORKSPACE_PATH_OUTSIDE_ROOT" in str(escaped.value)
        assert not (root / "workspaces" / "escape.txt").exists()

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
        assert "mcp-output" not in start.content[0].text

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
