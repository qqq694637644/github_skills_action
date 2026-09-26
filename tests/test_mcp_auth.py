from __future__ import annotations

import asyncio
import json
import time
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from mcp.server.auth.provider import AccessToken
from mcp.types import LATEST_PROTOCOL_VERSION

from workspace_mcp.auth import JWTTokenVerifier
from workspace_mcp.config import MCPSettings
from workspace_mcp.server import create_app


def _sse_json(text: str) -> dict:
    for line in text.splitlines():
        if line.startswith("data: "):
            return json.loads(line[6:])
    raise AssertionError(f"No SSE data payload found: {text[:500]}")


def _settings(*, allowed_subject: str = "personal-user") -> MCPSettings:
    return MCPSettings(
        public_url="https://workspace.example.com/mcp",
        issuer="https://auth.example.com/",
        jwks_url="https://auth.example.com/.well-known/jwks.json",
        required_scope="workspace:execute",
        allowed_subject=allowed_subject,
        allowed_algorithms=("RS256",),
    )


def _token(private_key, **overrides):
    now = int(time.time())
    payload = {
        "iss": "https://auth.example.com/",
        "aud": "https://workspace.example.com/mcp",
        "sub": "personal-user",
        "client_id": "chatgpt-client",
        "scope": "workspace:execute",
        "iat": now,
        "nbf": now - 1,
        "exp": now + 300,
    }
    payload.update(overrides)
    return jwt.encode(payload, private_key, algorithm="RS256", headers={"kid": "test-key"})


def test_jwt_verifier_checks_signature_issuer_audience_and_personal_subject() -> None:
    async def scenario() -> None:
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        verifier = JWTTokenVerifier(_settings(allowed_subject="personal-user"))
        verifier._jwks = SimpleNamespace(
            get_signing_key_from_jwt=lambda _token: SimpleNamespace(key=private_key.public_key())
        )

        valid = await verifier.verify_token(_token(private_key))
        assert valid is not None
        assert valid.subject == "personal-user"
        assert valid.resource == "https://workspace.example.com/mcp"
        assert valid.scopes == ["workspace:execute"]

        assert (
            await verifier.verify_token(_token(private_key, aud="https://other.example.com/mcp"))
            is None
        )
        assert (
            await verifier.verify_token(_token(private_key, iss="https://other.example.com/"))
            is None
        )
        assert await verifier.verify_token(_token(private_key, sub="other-user")) is None
        assert await verifier.verify_token(_token(private_key, exp=int(time.time()) - 1)) is None
        assert await verifier.verify_token(_token(private_key, nbf=int(time.time()) + 300)) is None

    asyncio.run(scenario())


def test_auth_routes_publish_protected_resource_metadata_and_challenge_unauthorized_mcp() -> None:
    async def scenario() -> None:
        settings = _settings()
        app = create_app(settings)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="https://workspace.example.com"
        ) as client:
            metadata = await client.get("/.well-known/oauth-protected-resource/mcp")
            assert metadata.status_code == 200
            body = metadata.json()
            assert body["resource"] == settings.public_url
            assert body["authorization_servers"] == [settings.issuer]
            assert "workspace:execute" in body["scopes_supported"]

            unauthorized = await client.post(
                "/mcp",
                json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
            )
            assert unauthorized.status_code == 401
            challenge = unauthorized.headers["www-authenticate"]
            assert "Bearer" in challenge
            assert "resource_metadata=" in challenge

    asyncio.run(scenario())


def test_auth_middleware_rejects_token_without_required_scope() -> None:
    class NoScopeVerifier:
        def __init__(self, settings: MCPSettings) -> None:
            self.settings = settings

        async def verify_token(self, token: str) -> AccessToken:
            return AccessToken(
                token=token,
                client_id="chatgpt-client",
                scopes=[],
                resource=self.settings.public_url,
                subject="personal-user",
            )

    async def scenario() -> None:
        settings = _settings()
        with patch("workspace_mcp.server.JWTTokenVerifier", NoScopeVerifier):
            app = create_app(settings)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="https://workspace.example.com"
        ) as client:
            response = await client.post(
                "/mcp",
                headers={"Authorization": "Bearer missing-scope"},
                json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
            )
            assert response.status_code == 403
            assert response.json()["error"] == "insufficient_scope"
            assert "workspace:execute" in response.headers["www-authenticate"]

    asyncio.run(scenario())


def test_auth_middleware_rejects_token_for_another_resource() -> None:
    class WrongResourceVerifier:
        def __init__(self, settings: MCPSettings) -> None:
            self.settings = settings

        async def verify_token(self, token: str) -> AccessToken:
            return AccessToken(
                token=token,
                client_id="chatgpt-client",
                scopes=["workspace:execute"],
                resource="https://other.example.com/mcp",
                subject="personal-user",
            )

    async def scenario() -> None:
        settings = _settings()
        with patch("workspace_mcp.server.JWTTokenVerifier", WrongResourceVerifier):
            app = create_app(settings)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="https://workspace.example.com"
        ) as client:
            response = await client.post(
                "/mcp",
                headers={"Authorization": "Bearer wrong-resource"},
                json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
            )
            assert response.status_code == 401
            assert "resource_metadata=" in response.headers["www-authenticate"]

    asyncio.run(scenario())


def test_personal_server_requires_allowed_subject() -> None:
    with pytest.raises(ValueError, match="OAUTH_ALLOWED_SUBJECT"):
        MCPSettings(
            public_url="https://workspace.example.com/mcp",
            issuer="https://auth.example.com/",
            jwks_url="https://auth.example.com/.well-known/jwks.json",
            allowed_subject="",
        )


def test_authenticated_http_initialize_accepts_public_mcp_host() -> None:
    class FullScopeVerifier:
        def __init__(self, settings: MCPSettings) -> None:
            self.settings = settings

        async def verify_token(self, token: str) -> AccessToken:
            return AccessToken(
                token=token,
                client_id="chatgpt-client",
                scopes=["workspace:execute"],
                resource=self.settings.public_url,
                subject="personal-user",
            )

    async def scenario() -> None:
        settings = _settings()
        with patch("workspace_mcp.server.JWTTokenVerifier", FullScopeVerifier):
            app = create_app(settings)
        async with app.router.lifespan_context(app):
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(
                transport=transport, base_url="https://workspace.example.com"
            ) as client:
                response = await client.post(
                    "/mcp",
                    headers={
                        "Authorization": "Bearer full-scope",
                        "Accept": "application/json, text/event-stream",
                        "Content-Type": "application/json",
                    },
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": {
                            "protocolVersion": LATEST_PROTOCOL_VERSION,
                            "capabilities": {},
                            "clientInfo": {"name": "test-client", "version": "1"},
                        },
                    },
                )
                assert response.status_code == 200
                session_id = response.headers.get("mcp-session-id")
                assert session_id
                assert response.headers["content-type"].startswith("text/event-stream")
                assert '"name":"workspace-mcp"' in response.text

                headers = {
                    "Authorization": "Bearer full-scope",
                    "Accept": "application/json, text/event-stream",
                    "Content-Type": "application/json",
                    "Mcp-Session-Id": session_id,
                }
                initialized = await client.post(
                    "/mcp",
                    headers=headers,
                    json={"jsonrpc": "2.0", "method": "notifications/initialized"},
                )
                assert initialized.status_code in {200, 202}

                listed = await client.post(
                    "/mcp",
                    headers=headers,
                    json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                )
                assert listed.status_code == 200
                payload = _sse_json(listed.text)
                tools = payload["result"]["tools"]
                assert len(tools) == 7
                for tool in tools:
                    expected = [{"type": "oauth2", "scopes": ["workspace:execute"]}]
                    assert tool["securitySchemes"] == expected
                    assert tool["_meta"]["securitySchemes"] == expected

    asyncio.run(scenario())
