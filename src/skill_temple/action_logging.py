"""Concise, redacted logs for GPT Action calls."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

LOGGER = logging.getLogger("uvicorn.error")
COMMAND_LOG_LIMIT = 2_400

_SECRET_PATTERNS = (
    re.compile(r"(?i)(\bauthorization\s*[:=]\s*bearer\s+)([^\s;]+)"),
    re.compile(
        r"(?i)((?:\$env:)?[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API[_-]?KEY)[A-Z0-9_]*"
        r"\s*[:=]\s*)(?:['\"])?([^'\"\s;]+)(?:['\"])?"
    ),
    re.compile(r"(?i)(--(?:token|password|secret|api[-_]?key)(?:=|\s+))(?:['\"])?([^'\"\s;]+)"),
)


def redact_text(value: str) -> str:
    """Redact common credential forms before values reach logs."""

    redacted = value
    for pattern in _SECRET_PATTERNS:
        redacted = pattern.sub(lambda match: f"{match.group(1)}<redacted>", redacted)
    return redacted


def command_for_log(script: str) -> str:
    """Keep the useful command text while bounding one log record."""

    compact = " ".join(part.strip() for part in script.splitlines() if part.strip())
    compact = redact_text(compact)
    if len(compact) <= COMMAND_LOG_LIMIT:
        return compact
    head = COMMAND_LOG_LIMIT - 650
    omitted = len(compact) - COMMAND_LOG_LIMIT
    return f"{compact[:head]} ... <{omitted} chars omitted> ... {compact[-600:]}"


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


def _format_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return json.dumps(_safe_value(value), ensure_ascii=False, separators=(",", ":"))


def log_action(action: str, /, **fields: Any) -> None:
    """Emit one compact action event; omit unset fields."""

    parts = [f"ACTION {action}"]
    parts.extend(
        f"{key}={_format_value(value)}" for key, value in fields.items() if value is not None
    )
    LOGGER.info(" ".join(parts))


def log_action_error(action: str, /, *, error_code: str, **fields: Any) -> None:
    """Emit one concise failed-action event."""

    log_action(action, **fields, result="error", error_code=error_code)
