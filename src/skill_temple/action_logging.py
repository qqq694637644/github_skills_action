"""Concise, redacted logs for GPT Action calls."""

from __future__ import annotations

import json
import logging
import re
import secrets
import threading
from collections import deque
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, Literal, TypedDict

LOGGER = logging.getLogger("uvicorn.error")
COMMAND_LOG_LIMIT = 2_400
ACTION_EVENT_LIMIT = 1_000


ActivityKind = Literal["command", "exploration", "patch", "write", "skill", "generic"]
ActivityPhase = Literal["started", "updated", "completed", "failed"]


class ActivityEvent(TypedDict):
    activity_id: str
    kind: ActivityKind
    phase: ActivityPhase
    timestamp: str
    workspace_id: str | None
    payload: dict[str, Any]


class ActionEventItem(TypedDict, total=False):
    id: int
    text: str
    event: ActivityEvent


_ACTION_EVENTS: deque[ActionEventItem] = deque(maxlen=ACTION_EVENT_LIMIT)
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
_SENSITIVE_ENV_NAME = re.compile(r"(?i)(?:TOKEN|PASSWORD|SECRET|API[_-]?KEY)")


def sensitive_environment_values(environment: Mapping[str, str]) -> tuple[str, ...]:
    """Return non-trivial sensitive env values for output-only redaction."""

    values = {
        value
        for key, value in environment.items()
        if value and len(value) >= 4 and _SENSITIVE_ENV_NAME.search(key)
    }
    return tuple(sorted(values, key=len, reverse=True))


def redact_text(value: str, *, extra_secrets: tuple[str, ...] = ()) -> str:
    """Redact common credential forms before values reach logs."""

    redacted = value
    for pattern in _SECRET_PATTERNS:
        redacted = pattern.sub(lambda match: f"{match.group(1)}<redacted>", redacted)
    for secret in extra_secrets:
        redacted = redacted.replace(secret, "<redacted>")
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


def new_activity_id(kind: str) -> str:
    """Return a compact opaque id for one monitor activity lifecycle."""

    return f"{kind}:{secrets.token_hex(8)}"


def _action_line(action: str, fields: dict[str, Any]) -> str:
    parts = [datetime.now().astimezone().strftime("[%Y-%m-%d %H:%M]"), f"ACTION {action}"]
    parts.extend(
        f"{key}={_format_value(value)}" for key, value in fields.items() if value is not None
    )
    return " ".join(parts)


def _append_action_event(line: str, event: ActivityEvent | None) -> None:
    global _ACTION_EVENT_ID
    with _ACTION_EVENTS_CONDITION:
        _ACTION_EVENT_ID += 1
        item: ActionEventItem = {"id": _ACTION_EVENT_ID, "text": line}
        if event is not None:
            safe_event = _safe_value(event)
            if not safe_event.get("activity_id"):
                safe_event["activity_id"] = f"event:{_ACTION_EVENT_ID}"
            item["event"] = safe_event
        _ACTION_EVENTS.append(item)
        _ACTION_EVENTS_CONDITION.notify_all()


def _workspace_id_from_activity(
    activity: Mapping[str, Any] | None,
    fields: Mapping[str, Any] | None = None,
) -> str | None:
    if activity is not None:
        direct = activity.get("workspace_id")
        if isinstance(direct, str) and direct:
            return direct
        payload = activity.get("payload")
        if isinstance(payload, Mapping):
            nested = payload.get("workspace_id")
            if isinstance(nested, str) and nested:
                return nested
    if fields is not None:
        fallback = fields.get("workspace_id")
        if isinstance(fallback, str) and fallback:
            return fallback
    return None


def log_action(
    action: str,
    /,
    *,
    activity: dict[str, Any] | None = None,
    publish: bool = True,
    **fields: Any,
) -> None:
    """Emit one compact action event; omit unset fields."""

    line = _action_line(action, fields)
    LOGGER.info(line)
    if not publish:
        return

    event: ActivityEvent | None = None
    if activity is not None:
        event = {
            "activity_id": activity.get("activity_id"),
            "kind": activity["kind"],
            "phase": activity.get("phase", "completed"),
            "timestamp": activity.get("timestamp") or datetime.now(UTC).isoformat(),
            "workspace_id": _workspace_id_from_activity(activity, fields),
            "payload": activity.get("payload") or {},
        }
    _append_action_event(line, event)


def log_activity(
    *,
    activity_id: str,
    kind: ActivityKind,
    phase: ActivityPhase,
    payload: dict[str, Any],
    legacy_action: str,
    legacy_fields: dict[str, Any] | None = None,
) -> None:
    """Publish one structured activity event with a legacy debug text representation."""

    fields = legacy_fields or {}
    line = _action_line(legacy_action, fields)
    LOGGER.info(line)
    _append_action_event(
        line,
        {
            "activity_id": activity_id,
            "kind": kind,
            "phase": phase,
            "timestamp": datetime.now(UTC).isoformat(),
            "workspace_id": _workspace_id_from_activity({"payload": payload}, legacy_fields),
            "payload": payload,
        },
    )


def wait_for_action_events(
    *,
    after: int = 0,
    timeout: float = 25.0,
    limit: int = 50,
    workspace_id: str | None = None,
    operation: str | None = None,
    phase: ActivityPhase | None = None,
) -> dict[str, Any]:
    """Return newer events matching optional structured filters, with a global cursor."""

    def matches_filters(item: ActionEventItem) -> bool:
        if workspace_id is None and operation is None and phase is None:
            return True
        event = item.get("event")
        if event is None:
            return False
        if workspace_id is not None and event.get("workspace_id") != workspace_id:
            return False
        if phase is not None and event.get("phase") != phase:
            return False
        if operation is not None:
            payload = event.get("payload")
            if not isinstance(payload, Mapping) or payload.get("operation") != operation:
                return False
        return True

    def collect(start_after: int) -> tuple[list[dict[str, Any]], int]:
        items: list[dict[str, Any]] = []
        scanned_id = min(start_after, _ACTION_EVENT_ID)
        for item in _ACTION_EVENTS:
            if item["id"] <= start_after:
                continue
            scanned_id = item["id"]
            if matches_filters(item):
                items.append(item.copy())
                if len(items) >= limit:
                    break
        return items, scanned_id

    with _ACTION_EVENTS_CONDITION:
        items, last_id = collect(after)
        if not items and timeout > 0:
            wait_after = last_id
            _ACTION_EVENTS_CONDITION.wait_for(
                lambda: any(
                    item["id"] > wait_after and matches_filters(item)
                    for item in _ACTION_EVENTS
                ),
                timeout=timeout,
            )
            items, last_id = collect(wait_after)

    return {"items": items, "last_id": last_id}


def clear_action_events() -> None:
    """Clear the in-memory monitor buffer. Intended for isolated tests."""

    global _ACTION_EVENT_ID
    with _ACTION_EVENTS_CONDITION:
        _ACTION_EVENTS.clear()
        _ACTION_EVENT_ID = 0


def log_action_error(
    action: str,
    /,
    *,
    error_code: str,
    activity: dict[str, Any] | None = None,
    publish: bool = True,
    **fields: Any,
) -> None:
    """Emit one concise failed-action event."""

    log_action(
        action,
        activity=activity,
        publish=publish,
        **fields,
        result="error",
        error_code=error_code,
    )
