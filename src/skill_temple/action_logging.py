"""Concise, redacted logs for GPT Action calls."""

from __future__ import annotations

import json
import logging
import re
import threading
from collections import deque
from datetime import datetime
from typing import Any

LOGGER = logging.getLogger("uvicorn.error")
COMMAND_LOG_LIMIT = 2_400
ACTION_EVENT_LIMIT = 200

_ACTION_EVENTS: deque[dict[str, Any]] = deque(maxlen=ACTION_EVENT_LIMIT)
_ACTION_EVENTS_CONDITION = threading.Condition()
_ACTION_EVENT_ID = 0

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

    parts = [datetime.now().astimezone().strftime("[%Y-%m-%d %H:%M]"), f"ACTION {action}"]
    parts.extend(
        f"{key}={_format_value(value)}" for key, value in fields.items() if value is not None
    )
    line = " ".join(parts)
    LOGGER.info(line)

    global _ACTION_EVENT_ID
    with _ACTION_EVENTS_CONDITION:
        _ACTION_EVENT_ID += 1
        _ACTION_EVENTS.append({"id": _ACTION_EVENT_ID, "text": line})
        _ACTION_EVENTS_CONDITION.notify_all()


def wait_for_action_events(
    *, after: int = 0, timeout: float = 25.0, limit: int = 50
) -> dict[str, Any]:
    """Return action events newer than ``after``, waiting briefly when none exist."""

    def collect() -> list[dict[str, Any]]:
        return [event.copy() for event in _ACTION_EVENTS if event["id"] > after][:limit]

    with _ACTION_EVENTS_CONDITION:
        items = collect()
        if not items and timeout > 0:
            _ACTION_EVENTS_CONDITION.wait_for(
                lambda: any(event["id"] > after for event in _ACTION_EVENTS),
                timeout=timeout,
            )
            items = collect()
        last_id = items[-1]["id"] if items else _ACTION_EVENT_ID

    return {"items": items, "last_id": last_id}


def clear_action_events() -> None:
    """Clear the in-memory monitor buffer. Intended for isolated tests."""

    global _ACTION_EVENT_ID
    with _ACTION_EVENTS_CONDITION:
        _ACTION_EVENTS.clear()
        _ACTION_EVENT_ID = 0


def log_action_error(action: str, /, *, error_code: str, **fields: Any) -> None:
    """Emit one concise failed-action event."""

    log_action(action, **fields, result="error", error_code=error_code)
