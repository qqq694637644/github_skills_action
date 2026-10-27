"""Server-side MCP request and HTTP timing, with bounded sanitized diagnostics.

Times captured on the server do not measure ChatGPT's client-to-server RTT.
The iframe viewer separately measures round trips with performance.now().
"""

from __future__ import annotations

import contextvars
import re
import secrets
import statistics
import threading
import time
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from opentelemetry import trace

from .logging import log_action

MAX_SAMPLES = 600
_SAFE_LABEL = re.compile(r"^[a-zA-Z0-9_-]{1,80}$")
_http_call_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "workspace_http_call_id", default=None
)


def current_call_id() -> str | None:
    """Correlation ID shared by HTTP and decoded MCP timing for this request."""
    return _http_call_id.get()


def _label(value: Any) -> str | None:
    return value if isinstance(value, str) and _SAFE_LABEL.fullmatch(value) else None


def _params_dict(raw: Any) -> dict[str, Any]:
    if isinstance(raw, Mapping):
        return dict(raw)
    if hasattr(raw, "model_dump"):
        return raw.model_dump()
    return {}


def _operation_id(value: Any) -> str | None:
    if not isinstance(value, str) or not re.fullmatch(r"op_[a-f0-9]{16}", value):
        return None
    return value


def _from_result(result: Any) -> str | None:
    if not isinstance(result, Mapping):
        return None
    structured = result.get("structuredContent") or result.get("structured_content")
    if not isinstance(structured, Mapping):
        return None
    operation = structured.get("operation")
    if isinstance(operation, Mapping):
        return _operation_id(operation.get("operation_id"))
    return _operation_id(structured.get("operation_id"))


def _percentile(values: list[float], quantile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = round((len(ordered) - 1) * quantile)
    return round(ordered[index], 2)


@dataclass(frozen=True)
class TimingSample:
    call_id: str
    kind: str
    method: str
    tool: str | None
    elapsed_ms: float
    outcome: str
    timestamp: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    operation_id: str | None = None
    http_status: int | None = None
    header_ms: float | None = None
    first_byte_ms: float | None = None
    trace_id: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {name: value for name, value in vars(self).items() if value is not None}


class TimingStore:
    def __init__(self, capacity: int = MAX_SAMPLES):
        self._samples: deque[TimingSample] = deque(maxlen=capacity)
        self._lock = threading.Lock()

    def append(self, sample: TimingSample) -> None:
        with self._lock:
            self._samples.append(sample)

    def clear(self) -> None:
        with self._lock:
            self._samples.clear()

    def query(self, *, limit: int = 25, tool: str | None = None) -> dict[str, Any]:
        bounded_limit = max(1, min(int(limit), 100))
        with self._lock:
            samples = list(self._samples)
        filtered = [item for item in samples if tool is None or item.tool == tool]
        mcp = [item.elapsed_ms for item in filtered if item.kind == "mcp"]
        http = [item.first_byte_ms for item in filtered if item.kind == "http"
                and item.first_byte_ms is not None]
        return {
            "samples": [item.as_dict() for item in reversed(filtered[-bounded_limit:])],
            "total_samples": len(filtered),
            "mcp_handler": _stats(mcp),
            "http_first_byte": _stats(http),
            "notes": (
                "mcp_handler is decoded request handler time, not network RTT. "
                "http_first_byte is server-side time to first response body chunk; "
                "streaming response lifetime is not end-to-end client latency. "
                "For actual iframe-host-server-iframe RTT, use the MCP Apps viewer's client timer."
            ),
        }


def _stats(values: list[float]) -> dict[str, float | int]:
    return {
        "count": len(values),
        "p50_ms": _percentile(values, 0.5),
        "p95_ms": _percentile(values, 0.95),
        "p99_ms": _percentile(values, 0.99),
        "max_ms": round(max(values), 2) if values else 0.0,
        "mean_ms": round(statistics.fmean(values), 2) if values else 0.0,
    }


TIMINGS = TimingStore()


class MCPRequestTimingMiddleware:
    """Observe decoded MCP messages, preserving the result and error semantics."""

    async def __call__(self, ctx: Any, call_next: Any) -> Any:
        if ctx.request_id is None:
            return await call_next(ctx)
        params = _params_dict(ctx.params)
        tool = _label(params.get("name")) if ctx.method == "tools/call" else None
        args = _params_dict(params.get("arguments")) if tool else {}
        operation = _operation_id(args.get("operation_id"))
        call_id = _http_call_id.get() or secrets.token_hex(8)
        started = time.perf_counter()
        outcome = "ok"
        result: Any = None
        tracer = trace.get_tracer("workspace_mcp.timing")
        with tracer.start_as_current_span("workspace.mcp.request") as span:
            span.set_attribute("mcp.method", ctx.method)
            if tool:
                span.set_attribute("mcp.tool.name", tool)
            try:
                result = await call_next(ctx)
                if isinstance(result, Mapping) and result.get("isError"):
                    outcome = "tool_error"
                return result
            except Exception:
                outcome = "exception"
                raise
            finally:
                elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
                operation = operation or _from_result(result)
                span.set_attribute("mcp.elapsed_ms", elapsed_ms)
                span.set_attribute("mcp.outcome", outcome)
                if operation:
                    span.set_attribute("workspace.operation_id", operation)
                context = span.get_span_context()
                trace_id = f"{context.trace_id:032x}" if context.is_valid else None
                TIMINGS.append(TimingSample(
                    call_id=call_id, kind="mcp", method=ctx.method, tool=tool,
                    elapsed_ms=elapsed_ms, outcome=outcome, operation_id=operation,
                    trace_id=trace_id,
                ))
                log_action(
                    "mcpRequestTiming",
                    publish=False,
                    call_id=call_id,
                    method=ctx.method,
                    tool=tool,
                    elapsed_ms=elapsed_ms,
                    outcome=outcome,
                    operation_id=operation,
                    trace_id=trace_id,
                )


class MCPHttpTimingMiddleware:
    """ASGI timing for MCP HTTP POST: headers, first body chunk and completion."""

    def __init__(self, app: Any):
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if (
            scope["type"] != "http"
            or scope.get("method") != "POST"
            or not scope.get("path", "").endswith("/mcp")
        ):
            await self.app(scope, receive, send)
            return
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        def header_text(key: bytes) -> str | None:
            raw = headers.get(key, b"")
            return _label(raw.decode("ascii", errors="ignore"))

        method = header_text(b"mcp-method") or "unknown"
        tool = header_text(b"mcp-name")
        call_id = secrets.token_hex(8)
        token = _http_call_id.set(call_id)
        started = time.perf_counter()
        header_ms = None
        first_byte_ms = None
        status = 500
        outcome = "ok"
        bytes_sent = 0

        async def timed_send(message: dict[str, Any]) -> None:
            nonlocal header_ms, first_byte_ms, status, bytes_sent
            if message["type"] == "http.response.start":
                header_ms = round((time.perf_counter() - started) * 1000, 2)
                status = message.get("status", 500)
            elif message["type"] == "http.response.body":
                if first_byte_ms is None:
                    first_byte_ms = round((time.perf_counter() - started) * 1000, 2)
                bytes_sent += len(message.get("body") or b"")
            await send(message)

        try:
            await self.app(scope, receive, timed_send)
        except Exception:
            outcome = "exception"
            raise
        finally:
            _http_call_id.reset(token)
            elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
            if outcome == "ok" and status >= 400:
                outcome = "http_error"
            TIMINGS.append(TimingSample(
                call_id=call_id, kind="http", method=method,
                tool=tool, elapsed_ms=elapsed_ms, outcome=outcome,
                http_status=status, header_ms=header_ms, first_byte_ms=first_byte_ms,
            ))
            log_action(
                "mcpHttpTiming", publish=False,
                call_id=call_id, method=method, tool=tool, status=status,
                header_ms=header_ms, first_byte_ms=first_byte_ms,
                elapsed_ms=elapsed_ms, response_bytes=bytes_sent, outcome=outcome,
            )


_otel_configured = False
_otel_lock = threading.Lock()


def configure_otel_from_env() -> bool:
    """Enable OTLP span export only when explicitly requested."""
    from .config import env_value

    if (env_value("WORKSPACE_OTEL_ENABLED") or "").lower() not in {"1", "true", "yes"}:
        return False
    endpoint = env_value("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        raise RuntimeError(
            "WORKSPACE_OTEL_ENABLED requires OTEL_EXPORTER_OTLP_ENDPOINT (OTLP HTTP receiver)."
        )
    global _otel_configured
    with _otel_lock:
        if _otel_configured:
            return True
        try:
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
            from opentelemetry.sdk.resources import Resource
            from opentelemetry.sdk.trace import TracerProvider
            from opentelemetry.sdk.trace.export import BatchSpanProcessor
        except ImportError as exc:
            raise RuntimeError(
                "Install observability dependencies: pip install -e '.[observability]'"
            ) from exc
        provider = TracerProvider(resource=Resource.create({
            "service.name": env_value("OTEL_SERVICE_NAME") or "workspace-mcp",
        }))
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
        trace.set_tracer_provider(provider)
        _otel_configured = True
        return True
