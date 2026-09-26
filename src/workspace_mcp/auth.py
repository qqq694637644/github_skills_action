from __future__ import annotations

import asyncio
import logging
from typing import Any

import jwt
from jwt import PyJWKClient
from mcp.server.auth.provider import AccessToken, TokenVerifier

from .config import MCPSettings

LOGGER = logging.getLogger("workspace_mcp.auth")


class JWTTokenVerifier(TokenVerifier):
    """Validate OAuth access tokens issued by an external OIDC/OAuth provider."""

    def __init__(self, settings: MCPSettings) -> None:
        self.settings = settings
        self._jwks = PyJWKClient(settings.jwks_url, cache_keys=True)

    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            payload = await asyncio.to_thread(self._decode, token)
        except Exception as exc:  # PyJWT exposes several provider/network-specific subclasses.
            LOGGER.warning("oauth_token_rejected reason=%s", type(exc).__name__)
            return None

        subject = _string_claim(payload, "sub")
        if subject != self.settings.allowed_subject:
            LOGGER.warning("oauth_token_rejected reason=subject_not_allowed")
            return None

        scopes = _scopes(payload)
        client_id = (
            _string_claim(payload, "client_id")
            or _string_claim(payload, "azp")
            or _string_claim(payload, "appid")
            or subject
            or "oauth-client"
        )
        expires_at = payload.get("exp")
        return AccessToken(
            token=token,
            client_id=client_id,
            scopes=scopes,
            expires_at=int(expires_at) if isinstance(expires_at, (int, float)) else None,
            resource=self.settings.public_url,
            subject=subject,
            claims={
                "iss": payload.get("iss"),
                "aud": payload.get("aud"),
            },
        )

    def _decode(self, token: str) -> dict[str, Any]:
        signing_key = self._jwks.get_signing_key_from_jwt(token)
        payload = jwt.decode(
            token,
            signing_key.key,
            algorithms=list(self.settings.allowed_algorithms),
            issuer=self.settings.issuer,
            audience=self.settings.public_url,
            options={"require": ["exp", "iss", "aud"]},
        )
        if not isinstance(payload, dict):
            raise jwt.InvalidTokenError("JWT payload must be an object")
        return payload


def _string_claim(payload: dict[str, Any], name: str) -> str | None:
    value = payload.get(name)
    return value if isinstance(value, str) and value else None


def _scopes(payload: dict[str, Any]) -> list[str]:
    value = payload.get("scope")
    if isinstance(value, str):
        return [part for part in value.split() if part]
    if isinstance(value, list):
        return [str(part) for part in value if part]
    value = payload.get("scp")
    if isinstance(value, str):
        return [part for part in value.split() if part]
    if isinstance(value, list):
        return [str(part) for part in value if part]
    return []
