from __future__ import annotations

import asyncio
import base64
import json
import os
import tempfile
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import LATEST_PROTOCOL_VERSION
from PIL import Image

from workspace_mcp.config import MCPSettings
from workspace_mcp.server import create_app, create_server


def _settings() -> MCPSettings:
    return MCPSettings(
        public_url="https://workspace.example.com/mcp",
        audience="https://workspace.example.com/private-mcp",
        issuer="https://auth.example.com/",
        jwks_url="https://auth.example.com/.well-known/jwks.json",
        allowed_subject="personal-user",
    )


def _environment(root: Path):
    return patch.dict(
        os.environ,
        {
            "WORKSPACE_ROOT": str(root / "workspaces"),
            "WORKSPACE_OPERATION_ROOT": str(root / "operations"),
        },
        clear=False,
    )


async def _workspace(server, root: Path) -> tuple[str, Path]:
    prepared = await server.call_tool(
        "prepareWorkspace", {"idempotency_key": "view-image-test-workspace"}
    )
    workspace_id = prepared.structured_content["workspace_id"]
    workspace_root = root / "workspaces" / workspace_id
    return workspace_id, workspace_root


def test_view_image_schema_and_data_url_content_only() -> None:
    async def scenario(root: Path) -> None:
        server = create_server(_settings())
        tools = {tool.name: tool for tool in await server.list_tools()}
        tool = tools["view_image"]
        assert tool.annotations.read_only_hint is True
        assert tool.meta == {
            "securitySchemes": [{"type": "oauth2", "scopes": ["workspace:execute"]}]
        }
        schema = tool.input_schema
        assert schema["required"] == ["workspace_id", "path"]
        assert schema["properties"]["max_bytes"]["maximum"] == 10_485_760
        assert schema["properties"]["max_width"]["maximum"] == 10_000
        assert schema["properties"]["output"]["const"] == "data_url"
        assert "native MCP image content" in tool.description
        assert "original" in tool.output_schema["properties"]
        assert "data_url" in tool.output_schema["properties"]

        workspace_id, workspace_root = await _workspace(server, root)
        image_path = workspace_root / "sample.png"
        Image.new("RGB", (24, 18), (231, 42, 87)).save(image_path)
        original_bytes = image_path.read_bytes()

        result = await server.call_tool(
            "view_image", {"workspace_id": workspace_id, "path": "sample.png"}
        )
        assert result.is_error is False
        assert len(result.content) == 1
        assert result.content[0].type == "text"
        assert result.structured_content["data_url"].startswith("data:image/png;base64,")
        assert base64.b64decode(
            result.structured_content["data_url"].split(",", 1)[1], validate=True
        ) == original_bytes
        assert base64.b64decode(result.structured_content["base64"]) == original_bytes
        assert result.structured_content["width"] == 24
        assert result.structured_content["height"] == 18
        assert result.structured_content["resized"] is False
        assert result.structured_content["original"]["bytes"] == len(original_bytes)
        assert json.loads(result.content[0].text) == result.structured_content

        # A real MCP image block must never appear, including in wire serialization.
        wire = result.model_dump(mode="json", by_alias=True, exclude_none=True)
        assert len(wire["content"]) == 1
        assert wire["content"][0]["type"] == "text"
        assert json.loads(wire["content"][0]["text"]) == result.structured_content

        explicit = await server.call_tool(
            "view_image",
            {"workspace_id": workspace_id, "path": "sample.png", "output": "data_url"},
        )
        assert explicit.structured_content == result.structured_content
        with pytest.raises(ToolError, match="data_url"):
            await server.call_tool(
                "view_image",
                {"workspace_id": workspace_id, "path": "sample.png", "output": "mcp_image"},
            )

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        with _environment(root):
            asyncio.run(scenario(root))


@pytest.mark.parametrize(
    ("file_name", "image_format", "expected_mime"),
    [
        ("photo.jpg", "JPEG", "image/jpeg"),
        ("animated.gif", "GIF", "image/gif"),
        ("web.webp", "WEBP", "image/webp"),
    ],
)
def test_view_image_other_supported_formats(
    file_name: str, image_format: str, expected_mime: str
) -> None:
    async def scenario(root: Path) -> None:
        server = create_server(_settings())
        workspace_id, workspace_root = await _workspace(server, root)
        Image.new("RGB", (45, 31), "purple").save(
            workspace_root / file_name, format=image_format
        )
        result = await server.call_tool(
            "view_image", {"workspace_id": workspace_id, "path": file_name}
        )
        assert result.content[0].type == "text"
        assert result.structured_content["mime_type"] == expected_mime
        assert result.structured_content["data_url"].startswith(f"data:{expected_mime};base64,")
        assert result.structured_content["width"] == 45
        assert result.structured_content["height"] == 31

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        with _environment(root):
            asyncio.run(scenario(root))


def test_view_image_resizes_and_reports_final_dimensions() -> None:
    async def scenario(root: Path) -> None:
        server = create_server(_settings())
        workspace_id, workspace_root = await _workspace(server, root)

        Image.new("RGB", (2400, 1200), (37, 119, 164)).save(
            workspace_root / "large.png"
        )
        resized = await server.call_tool(
            "view_image",
            {
                "workspace_id": workspace_id,
                "path": "large.png",
                "max_width": 600,
                "max_height": 350,
            },
        )
        assert resized.content[0].type == "text"
        assert resized.structured_content["resized"] is True
        assert resized.structured_content["original"]["width"] == 2400
        assert resized.structured_content["original"]["height"] == 1200
        decoded = base64.b64decode(resized.structured_content["data_url"].split(",", 1)[1])
        with Image.open(BytesIO(decoded)) as thumb:
            assert thumb.width <= 600
            assert thumb.height <= 350
            assert resized.structured_content["width"] == thumb.width
            assert resized.structured_content["height"] == thumb.height

        # Highly detailed input should also shrink to the byte budget.
        Image.effect_noise((450, 450), 100).convert("RGB").save(
            workspace_root / "noise.png", format="PNG"
        )
        small = await server.call_tool(
            "view_image",
            {
                "workspace_id": workspace_id,
                "path": "noise.png",
                "max_bytes": 4_096,
            },
        )
        assert small.structured_content["bytes"] <= 4_096
        assert small.structured_content["resized"] is True
        with Image.open(
            BytesIO(base64.b64decode(small.structured_content["data_url"].split(",", 1)[1]))
        ) as thumb:
            assert small.structured_content["width"] == thumb.width
            assert small.structured_content["height"] == thumb.height

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        with _environment(root):
            asyncio.run(scenario(root))


def test_view_image_rejects_oversize_nonimages_and_workspace_escapes() -> None:
    async def scenario(root: Path) -> None:
        server = create_server(_settings())
        workspace_id, workspace_root = await _workspace(server, root)
        (workspace_root / "fake.png").write_text("not a PNG", encoding="utf-8")
        Image.effect_noise((128, 128), 100).convert("RGB").save(
            workspace_root / "noisy.png", format="PNG"
        )

        for path, error_code in [
            ("fake.png", "BINARY_FILE"),
            ("missing.png", "WORKSPACE_FILE_NOT_FOUND"),
            ("../outside.png", "WORKSPACE_PATH_OUTSIDE_ROOT"),
        ]:
            with pytest.raises(ToolError, match=error_code):
                await server.call_tool(
                    "view_image", {"workspace_id": workspace_id, "path": path}
                )

        with pytest.raises(ToolError, match="OUTPUT_TOO_LARGE"):
            await server.call_tool(
                "view_image",
                {
                    "workspace_id": workspace_id,
                    "path": "noisy.png",
                    "max_bytes": 1024,
                    "auto_resize": False,
                },
            )
        with pytest.raises(ToolError):
            await server.call_tool(
                "view_image",
                {"workspace_id": workspace_id, "path": "noisy.png", "max_bytes": 123},
            )

        outside = root / "outside.png"
        Image.new("RGB", (8, 8), "green").save(outside)
        symlink = workspace_root / "outside-link.png"
        try:
            symlink.symlink_to(outside)
        except (OSError, NotImplementedError):
            return
        with pytest.raises(ToolError, match="WORKSPACE_PATH_OUTSIDE_ROOT"):
            await server.call_tool(
                "view_image", {"workspace_id": workspace_id, "path": symlink.name}
            )

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        with _environment(root):
            asyncio.run(scenario(root))


def test_view_image_http_mcp_transport_contains_only_text_data_url() -> None:
    async def scenario(root: Path) -> None:
        workspace_id = "ws_0123456789abcdef"
        workspace_root = root / "workspaces" / workspace_id
        workspace_root.mkdir(parents=True)
        Image.new("RGB", (13, 17), (45, 200, 98)).save(workspace_root / "wire.png")

        settings = MCPSettings(public_url="https://workspace.example.com/mcp")
        app = create_app(settings)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="https://workspace.example.com",
            ) as client:
                headers = {
                    "Accept": "application/json, text/event-stream",
                    "Content-Type": "application/json",
                }
                initialized = await client.post(
                    "/mcp",
                    headers=headers,
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": {
                            "protocolVersion": LATEST_PROTOCOL_VERSION,
                            "capabilities": {},
                            "clientInfo": {"name": "view-image-test", "version": "1"},
                        },
                    },
                )
                assert initialized.status_code == 200
                headers["Mcp-Session-Id"] = initialized.headers["mcp-session-id"]
                ready = await client.post(
                    "/mcp",
                    headers=headers,
                    json={"jsonrpc": "2.0", "method": "notifications/initialized"},
                )
                assert ready.status_code in {200, 202}
                response = await client.post(
                    "/mcp",
                    headers=headers,
                    json={
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "tools/call",
                        "params": {
                            "name": "view_image",
                            "arguments": {
                                "workspace_id": workspace_id,
                                "path": "wire.png",
                            },
                        },
                    },
                )
                assert response.status_code == 200, response.text
                event = next(
                    json.loads(line[6:])
                    for line in response.text.splitlines()
                    if line.startswith("data: ")
                )
                result = event["result"]
                assert result["isError"] is False
                assert len(result["content"]) == 1
                assert result["content"][0]["type"] == "text"
                assert json.loads(result["content"][0]["text"]) == result["structuredContent"]
                assert result["structuredContent"]["data_url"].startswith("data:image/png;base64,")
                with Image.open(
                    BytesIO(
                        base64.b64decode(
                            result["structuredContent"]["data_url"].split(",", 1)[1],
                            validate=True,
                        )
                    )
                ) as picture:
                    assert picture.size == (13, 17)

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        with _environment(root):
            asyncio.run(scenario(root))
