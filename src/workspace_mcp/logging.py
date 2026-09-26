from __future__ import annotations

import json
import logging
import re
from collections.abc import Mapping
from typing import Any

LOGGER = logging.getLogger("workspace_mcp")
COMMAND_LOG_LIMIT = 2_400

_SECRET_PATTERNS = (
    re.compile(r"(?i)(\bauthorization\s*[:=]\s*bearer\s+)([^\s;]+)"),
    re.compile(
        r"(?i)((?:\$env:)?[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API[_-]?KEY)[A-Z0-9_]*"
        r"\s*[:=]\s*)(?:['\"])?([^'\"\s;]+)(?:['\"])?"
    ),
    re.compile(r"(?i)(--(?:token|password|secret|api[-_]?key)(?:=|\s+))(?:['\"])?([^'\"\s;]+)"),
)
_SENSITIVE_ENV_NAME = re.compile(r"(?i)(?:TOKEN|PASSWORD|SECRET|API[_-]?KEY)")


def sensitive_environment_values(environment: Mapping[str, str]) -> tuple[str, ...]:
    values = {
        value
        for key, value in environment.items()
        if value and len(value) >= 4 and _SENSITIVE_ENV_NAME.search(key)
    }
    return tuple(sorted(values, key=len, reverse=True))


def redact_text(value: str, *, extra_secrets: tuple[str, ...] = ()) -> str:
    redacted = value
    for pattern in _SECRET_PATTERNS:
        redacted = pattern.sub(lambda match: f"{match.group(1)}<redacted>", redacted)
    for secret in extra_secrets:
        redacted = redacted.replace(secret, "<redacted>")
    return redacted


def command_for_log(script: str) -> str:
    compact = " ".join(part.strip() for part in script.splitlines() if part.strip())
    compact = redact_text(compact)
    if len(compact) <= COMMAND_LOG_LIMIT:
        return compact
    head = COMMAND_LOG_LIMIT - 650
    omitted = len(compact) - COMMAND_LOG_LIMIT
    return f"{compact[:head]} ... <{omitted} chars omitted> ... {compact[-600:]}"


def log_event(event: str, **fields: Any) -> None:
    safe = {key: _safe_value(value) for key, value in fields.items() if value is not None}
    LOGGER.info("%s %s", event, json.dumps(safe, ensure_ascii=False, separators=(",", ":")))


def log_error(event: str, *, error_code: str, **fields: Any) -> None:
    log_event(event, result="error", error_code=error_code, **fields)


def _safe_value(value: Any) -> Any:
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, list):
        return [_safe_value(item) for item in value]
    if isinstance(value, tuple):
        return [_safe_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _safe_value(item) for key, item in value.items()}
    return value
