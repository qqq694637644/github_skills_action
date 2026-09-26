from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import AnyHttpUrl

_DOTENV_FILE_NAME = ".env"
_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def env_value(name: str) -> str | None:
    """Read a setting from the process environment, then from the local .env file."""

    value = os.environ.get(name)
    if value is not None and value != "":
        return value
    return _read_dotenv_file(Path.cwd() / _DOTENV_FILE_NAME).get(name)


def env_int(name: str, default: int) -> int:
    value = env_value(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer.") from exc


def _read_dotenv_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}

    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        if stripped.startswith("export "):
            stripped = stripped[7:].lstrip()
        key, raw_value = stripped.split("=", 1)
        key = key.strip()
        if not _ENV_KEY_RE.fullmatch(key):
            continue
        value = raw_value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0].rstrip()
        values[key] = value
    return values


@dataclass(frozen=True)
class MCPSettings:
    public_url: str
    issuer: str
    jwks_url: str
    required_scope: str = "workspace:execute"
    allowed_subject: str = ""
    allowed_algorithms: tuple[str, ...] = ("RS256",)
    host: str = "127.0.0.1"
    port: int = 8000

    def __post_init__(self) -> None:
        public = urlsplit(self.public_url)
        if public.scheme != "https" or not public.hostname or public.path != "/mcp":
            raise ValueError("MCP_PUBLIC_URL must be an absolute HTTPS URL ending exactly in /mcp.")
        if public.query or public.fragment:
            raise ValueError("MCP_PUBLIC_URL must not contain a query string or fragment.")

        issuer_parts = urlsplit(self.issuer)
        jwks_parts = urlsplit(self.jwks_url)
        if issuer_parts.scheme != "https" or not issuer_parts.hostname:
            raise ValueError("OAUTH_ISSUER must be an absolute HTTPS URL.")
        if jwks_parts.scheme != "https" or not jwks_parts.hostname:
            raise ValueError("OAUTH_JWKS_URL must be an absolute HTTPS URL.")
        try:
            canonical_issuer = str(AnyHttpUrl(self.issuer))
            AnyHttpUrl(self.jwks_url)
        except ValueError as exc:
            raise ValueError(
                "OAUTH_ISSUER and OAUTH_JWKS_URL must be absolute HTTPS URLs."
            ) from exc
        if canonical_issuer != self.issuer:
            raise ValueError(
                "OAUTH_ISSUER must use the provider's canonical URL spelling exactly; "
                "for a host-only issuer, include its trailing slash."
            )
        if not self.required_scope.strip():
            raise ValueError("MCP_REQUIRED_SCOPE must not be empty.")
        if not self.allowed_subject.strip():
            raise ValueError(
                "OAUTH_ALLOWED_SUBJECT is required for this personal single-user server."
            )
        if not self.allowed_algorithms:
            raise ValueError("OAUTH_ALLOWED_ALGORITHMS must contain at least one algorithm.")
        if not 1 <= self.port <= 65535:
            raise ValueError("MCP_PORT must be between 1 and 65535.")

    @classmethod
    def from_env(cls) -> MCPSettings:
        public_url = _required("MCP_PUBLIC_URL")
        issuer = _required("OAUTH_ISSUER")
        jwks_url = _required("OAUTH_JWKS_URL")
        return cls(
            public_url=public_url,
            issuer=issuer,
            jwks_url=jwks_url,
            required_scope=env_value("MCP_REQUIRED_SCOPE") or "workspace:execute",
            allowed_subject=_required("OAUTH_ALLOWED_SUBJECT"),
            allowed_algorithms=tuple(
                part.strip()
                for part in (env_value("OAUTH_ALLOWED_ALGORITHMS") or "RS256").split(",")
                if part.strip()
            ),
            host=env_value("MCP_HOST") or "127.0.0.1",
            port=env_int("MCP_PORT", 8000),
        )


def _required(name: str) -> str:
    value = env_value(name)
    if not value:
        raise RuntimeError(f"{name} is required.")
    return value
