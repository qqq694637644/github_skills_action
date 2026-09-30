from __future__ import annotations

import asyncio
import codecs
import hashlib
import json
import os
import re
import secrets
import signal
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal, TypeVar

from .logging import (
    command_for_log,
    log_activity,
    redact_text,
    sensitive_environment_values,
)
from .workspace_patch import WorkspaceToolError

OperationState = Literal[
    "running",
    "succeeded",
    "failed",
    "timed_out",
    "canceled",
    "interrupted",
]
T = TypeVar("T")
_TERMINAL_STATES = {"succeeded", "failed", "timed_out", "canceled", "interrupted"}
_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_ACTIVITY_OUTPUT_FLUSH_SECONDS = 0.2
_ACTIVITY_OUTPUT_CHARS = 8_000
_ACTIVITY_PREVIEW_CHARS = 16_384
_ACTIVITY_PREVIEW_LINES = 3


class _AnsiCsiStripper:
    """Strip CSI escape sequences while preserving state across stream chunks."""

    def __init__(self) -> None:
        self._pending = bytearray()
        self._intermediate = False

    def feed(self, data: bytes, *, final: bool = False) -> bytes:
        output = bytearray()
        for byte in data:
            if not self._pending:
                if byte == 0x1B:
                    self._pending.append(byte)
                else:
                    output.append(byte)
                continue

            if len(self._pending) == 1:
                if byte == 0x5B:  # ESC [
                    self._pending.append(byte)
                    self._intermediate = False
                else:
                    output.extend(self._pending)
                    self._pending.clear()
                    if byte == 0x1B:
                        self._pending.append(byte)
                    else:
                        output.append(byte)
                continue

            if 0x40 <= byte <= 0x7E:
                self._pending.clear()
                self._intermediate = False
                continue

            if not self._intermediate and 0x30 <= byte <= 0x3F:
                self._pending.append(byte)
                continue

            if 0x20 <= byte <= 0x2F:
                self._intermediate = True
                self._pending.append(byte)
                continue

            output.extend(self._pending)
            self._pending.clear()
            self._intermediate = False
            if byte == 0x1B:
                self._pending.append(byte)
            else:
                output.append(byte)

        if final and self._pending:
            output.extend(self._pending)
            self._pending.clear()
            self._intermediate = False
        return bytes(output)


@dataclass(frozen=True)
class OperationSettings:
    root: Path
    shell: str = "/bin/bash"
    sync_wait_seconds: int = 5
    default_timeout_seconds: int = 120
    max_timeout_seconds: int = 3600
    default_output_bytes: int = 1_000_000
    max_output_bytes: int = 10_000_000
    kill_grace_seconds: int = 5
    reader_grace_seconds: int = 2
    shutdown_seconds: int = 10
    operation_ttl_hours: int = 72


@dataclass(slots=True)
class OperationRuntime:
    record: dict[str, Any]
    started_monotonic: float
    deadline_monotonic: float
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    shutdown_event: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task[None] | None = None
    process: asyncio.subprocess.Process | None = None
    process_group_id: int | None = None
    stored_bytes: int = 0
    activity_command: str = ""
    activity_secrets: tuple[str, ...] = ()
    activity_output: dict[str, str] = field(
        default_factory=lambda: {"stdout": "", "stderr": ""}
    )
    activity_preview: dict[str, str] = field(
        default_factory=lambda: {"stdout": "", "stderr": ""}
    )
    activity_flush_task: asyncio.Task[None] | None = None


class OperationDeadlineExceededError(Exception):
    pass


class WorkspaceOperationManager:
    def __init__(self, settings: OperationSettings) -> None:
        self.settings = settings
        self.root = settings.root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._registry_lock = asyncio.Lock()
        self._records: dict[str, dict[str, Any]] = {}
        self._runtimes: dict[str, OperationRuntime] = {}
        self._idempotency: dict[tuple[str, str], str] = {}
        self._background_cleanup_tasks: set[asyncio.Task[Any]] = set()
        self._load_records()
        self.recover_running_operations()
        self.prune_terminal_operations()

    def _load_records(self) -> None:
        for directory in self.root.glob("op_*"):
            state_path = directory / "state.json"
            if not state_path.is_file():
                continue
            try:
                record = json.loads(state_path.read_text(encoding="utf-8"))
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                continue
            operation_id = str(record.get("operation_id") or directory.name)
            self._records[operation_id] = record
            key = record.get("idempotency_key")
            request_hash = record.get("request_hash")
            if isinstance(key, str) and isinstance(request_hash, str):
                self._idempotency[(key, request_hash)] = operation_id

    def recover_running_operations(self) -> int:
        recovered = 0
        for record in self._records.values():
            if record.get("state") != "running":
                continue
            record["state"] = "interrupted"
            record["finished_at"] = _utc_now()
            record["error_code"] = "mcp_server_restarted"
            record["error_message"] = (
                "MCP server restarted before the command reached a terminal state."
            )
            self._write_record(record)
            recovered += 1
        return recovered

    async def start(
        self,
        *,
        workspace_id: str,
        workspace_root: Path,
        idempotency_key: str,
        script: str,
        timeout_seconds: int | None,
        max_output_bytes: int | None,
        plain_output: bool,
        utf8_output: bool,
    ) -> dict[str, Any]:
        timeout = timeout_seconds or self.settings.default_timeout_seconds
        output_limit = max_output_bytes or self.settings.default_output_bytes
        if timeout > self.settings.max_timeout_seconds:
            raise WorkspaceToolError(
                "VALIDATION_ERROR",
                f"timeout_seconds exceeds {self.settings.max_timeout_seconds}.",
            )
        if output_limit > self.settings.max_output_bytes:
            raise WorkspaceToolError(
                "VALIDATION_ERROR",
                f"max_output_bytes exceeds {self.settings.max_output_bytes}.",
            )
        request_payload = {
            "workspace_id": workspace_id,
            "root": str(workspace_root),
            "script": script,
            "timeout_seconds": timeout,
            "max_output_bytes": output_limit,
            "plain_output": plain_output,
            "utf8_output": utf8_output,
        }
        request_hash = hashlib.sha256(
            json.dumps(request_payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()
        idempotency_index = (idempotency_key, request_hash)
        async with self._registry_lock:
            existing_id = self._idempotency.get(idempotency_index)
            if existing_id:
                return self._public_record(self._records[existing_id])

            operation_id = "op_" + secrets.token_hex(8)
            started_monotonic = time.monotonic()
            started_at = _utc_now()
            deadline_at = (datetime.now(UTC) + timedelta(seconds=timeout)).isoformat()
            record: dict[str, Any] = {
                "operation_id": operation_id,
                "workspace_id": workspace_id,
                "idempotency_key": idempotency_key,
                "request_hash": request_hash,
                "script_sha256": hashlib.sha256(script.encode("utf-8")).hexdigest(),
                "script_summary": _script_summary(script),
                "state": "running",
                "root_pid": None,
                "process_group_id": None,
                "started_at": started_at,
                "deadline_at": deadline_at,
                "finished_at": None,
                "duration_ms": 0,
                "exit_code": None,
                "stdout_bytes": 0,
                "stderr_bytes": 0,
                "stdout_truncated": False,
                "stderr_truncated": False,
                "error_code": None,
                "error_message": None,
                "plain_output": plain_output,
                "max_output_bytes": output_limit,
            }
            activity_secrets = sensitive_environment_values(os.environ)
            runtime = OperationRuntime(
                record=record,
                started_monotonic=started_monotonic,
                deadline_monotonic=started_monotonic + timeout,
                activity_command=redact_text(
                    command_for_log(script), extra_secrets=activity_secrets
                ),
                activity_secrets=activity_secrets,
            )
            self._records[operation_id] = record
            self._runtimes[operation_id] = runtime
            self._idempotency[idempotency_index] = operation_id
            try:
                self._write_record(record)
            except OSError:
                self._records.pop(operation_id, None)
                self._runtimes.pop(operation_id, None)
                self._idempotency.pop(idempotency_index, None)
                raise
            log_activity(
                activity_id=f"command:{operation_id}",
                kind="command",
                phase="started",
                payload={
                    "command": runtime.activity_command,
                    "workspace_id": workspace_id,
                    "operation_id": operation_id,
                    "state": "running",
                },
                legacy_action="workspaceCommand",
                legacy_fields={
                    "action": "start",
                    "workspace_id": workspace_id,
                    "command": runtime.activity_command,
                    "operation_id": operation_id,
                    "state": "running",
                },
            )
            runtime.task = asyncio.create_task(
                self._run(
                    runtime,
                    workspace_root=workspace_root,
                    script=script,
                    timeout_seconds=timeout,
                    max_output_bytes=output_limit,
                    plain_output=plain_output,
                    utf8_output=utf8_output,
                ),
                name=f"workspace-command-{operation_id}",
            )
            return self._public_record(record)

    async def get(self, operation_id: str) -> dict[str, Any]:
        return self._public_record(self._require_operation(operation_id))

    async def wait_for_terminal(self, operation_id: str, *, timeout_seconds: int) -> dict[str, Any]:
        record = self._require_operation(operation_id)
        if record.get("state") in _TERMINAL_STATES or timeout_seconds <= 0:
            return self._public_record(record)
        runtime = self._runtimes.get(operation_id)
        task = runtime.task if runtime is not None else None
        if task is None:
            return self._public_record(record)
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=timeout_seconds)
        except TimeoutError:
            pass
        return self._public_record(self._require_operation(operation_id))

    async def wait_for_change(
        self,
        operation_id: str,
        *,
        stdout_offset: int,
        stderr_offset: int,
        timeout_seconds: float,
    ) -> dict[str, Any]:
        """Wait until the operation finishes, new log bytes appear, or the wait expires."""

        record = self._require_operation(operation_id)
        if timeout_seconds <= 0:
            return self._public_record(record)
        deadline = time.monotonic() + timeout_seconds
        while True:
            record = self._require_operation(operation_id)
            terminal = record.get("state") in _TERMINAL_STATES
            if terminal:
                return self._public_record(record)
            if _log_has_decodable_progress(self._stdout_path(operation_id), stdout_offset):
                return self._public_record(record)
            if _log_has_decodable_progress(self._stderr_path(operation_id), stderr_offset):
                return self._public_record(record)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return self._public_record(record)
            await asyncio.sleep(min(0.1, remaining))

    async def list_operations(self, state: str | None = None) -> list[dict[str, Any]]:
        records = [
            self._public_record(record)
            for record in self._records.values()
            if state is None or record.get("state") == state
        ]
        records.sort(key=lambda item: str(item.get("started_at") or ""), reverse=True)
        return records

    async def logs(
        self,
        operation_id: str,
        *,
        stdout_offset: int,
        stderr_offset: int,
        max_bytes: int,
    ) -> dict[str, Any]:
        record = self._require_operation(operation_id)
        terminal = record.get("state") in _TERMINAL_STATES
        stdout, next_stdout = _read_log(
            self._stdout_path(operation_id), stdout_offset, max_bytes, final=terminal
        )
        stderr, next_stderr = _read_log(
            self._stderr_path(operation_id), stderr_offset, max_bytes, final=terminal
        )
        return {
            "stdout": stdout,
            "stderr": stderr,
            "next_stdout_offset": next_stdout,
            "next_stderr_offset": next_stderr,
            "stdout_eof": terminal and next_stdout >= _file_size(self._stdout_path(operation_id)),
            "stderr_eof": terminal and next_stderr >= _file_size(self._stderr_path(operation_id)),
        }

    async def cancel(self, operation_id: str) -> dict[str, Any]:
        record = self._require_operation(operation_id)
        if record.get("state") in _TERMINAL_STATES:
            return self._public_record(record)
        runtime = self._runtimes.get(operation_id)
        if runtime is not None:
            runtime.cancel_event.set()
        return self._public_record(record)

    async def shutdown(self) -> None:
        runtimes = list(self._runtimes.values())
        for runtime in runtimes:
            if runtime.record.get("state") == "running":
                runtime.shutdown_event.set()
        tasks = [r.task for r in runtimes if r.task is not None and not r.task.done()]
        if tasks:
            _, pending = await asyncio.wait(tasks, timeout=self.settings.shutdown_seconds)
            for task in pending:
                task.cancel()
        cleanup_tasks = [task for task in self._background_cleanup_tasks if not task.done()]
        if cleanup_tasks:
            await asyncio.wait(cleanup_tasks, timeout=self.settings.kill_grace_seconds)

    def prune_terminal_operations(self) -> int:
        cutoff = datetime.now(UTC) - timedelta(hours=self.settings.operation_ttl_hours)
        removed = 0
        for operation_id, record in list(self._records.items()):
            if record.get("state") not in _TERMINAL_STATES:
                continue
            try:
                finished = datetime.fromisoformat(str(record.get("finished_at")))
            except (TypeError, ValueError):
                continue
            if finished >= cutoff:
                continue
            try:
                import shutil

                shutil.rmtree(self.root / operation_id)
            except OSError:
                continue
            self._records.pop(operation_id, None)
            key = record.get("idempotency_key")
            request_hash = record.get("request_hash")
            if isinstance(key, str) and isinstance(request_hash, str):
                self._idempotency.pop((key, request_hash), None)
            removed += 1
        return removed

    @staticmethod
    def _remaining_seconds(runtime: OperationRuntime) -> float:
        return max(0.0, runtime.deadline_monotonic - time.monotonic())

    async def _await_before_deadline(
        self,
        runtime: OperationRuntime,
        awaitable: Awaitable[T],
        *,
        on_late_result: Callable[[asyncio.Future[T]], None] | None = None,
    ) -> T:
        future = asyncio.ensure_future(awaitable)
        try:
            remaining = self._remaining_seconds(runtime)
            if remaining > 0:
                done, _ = await asyncio.wait({future}, timeout=remaining)
                if future in done:
                    return future.result()
        except asyncio.CancelledError:
            if on_late_result is not None:
                future.add_done_callback(on_late_result)
            else:
                future.cancel()
            raise
        if on_late_result is not None:
            future.add_done_callback(on_late_result)
        else:
            future.cancel()
        raise OperationDeadlineExceededError

    def _track_cleanup_task(self, task: asyncio.Task[Any]) -> None:
        self._background_cleanup_tasks.add(task)
        task.add_done_callback(self._background_cleanup_tasks.discard)

    async def _create_process_before_deadline(
        self,
        runtime: OperationRuntime,
        *args: str,
        cwd: str,
        env: dict[str, str],
    ) -> asyncio.subprocess.Process:
        def terminate_late_process(
            future: asyncio.Future[asyncio.subprocess.Process],
        ) -> None:
            try:
                process = future.result()
            except BaseException:
                return
            cleanup = asyncio.create_task(
                _terminate_process_group(
                    process,
                    process.pid,
                    self.settings.kill_grace_seconds,
                )
            )
            self._track_cleanup_task(cleanup)

        return await self._await_before_deadline(
            runtime,
            asyncio.create_subprocess_exec(
                *args,
                cwd=cwd,
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            ),
            on_late_result=terminate_late_process,
        )

    async def _run(
        self,
        runtime: OperationRuntime,
        *,
        workspace_root: Path,
        script: str,
        timeout_seconds: int,
        max_output_bytes: int,
        plain_output: bool,
        utf8_output: bool,
    ) -> None:
        operation_id = str(runtime.record["operation_id"])
        args = [
            self.settings.shell,
            "--noprofile",
            "--norc",
            "-c",
            script,
        ]
        process_env = os.environ.copy()
        if utf8_output:
            process_env["PYTHONIOENCODING"] = "utf-8"
            process_env["PYTHONUTF8"] = "1"
        runtime.activity_secrets = sensitive_environment_values(process_env)
        try:
            proc = await self._create_process_before_deadline(
                runtime,
                *args,
                cwd=str(workspace_root),
                env=process_env,
            )
            runtime.process = proc
            runtime.process_group_id = proc.pid
            async with runtime.lock:
                runtime.record["root_pid"] = proc.pid
                runtime.record["process_group_id"] = proc.pid
            if self._remaining_seconds(runtime) <= 0:
                raise OperationDeadlineExceededError

            stdout_task = asyncio.create_task(
                self._drain_stream(
                    runtime,
                    "stdout",
                    proc.stdout,
                    self._stdout_path(operation_id),
                    max_output_bytes,
                    plain_output=plain_output,
                )
            )
            stderr_task = asyncio.create_task(
                self._drain_stream(
                    runtime,
                    "stderr",
                    proc.stderr,
                    self._stderr_path(operation_id),
                    max_output_bytes,
                    plain_output=plain_output,
                )
            )
            process_task = asyncio.create_task(_wait_for_root_process_exit(proc))
            timeout_task = asyncio.create_task(asyncio.sleep(self._remaining_seconds(runtime)))
            cancel_task = asyncio.create_task(runtime.cancel_event.wait())
            shutdown_task = asyncio.create_task(runtime.shutdown_event.wait())
            done, pending = await asyncio.wait(
                {process_task, timeout_task, cancel_task, shutdown_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if process_task in done:
                terminal_state: OperationState = "succeeded" if proc.returncode == 0 else "failed"
                error_code = None if proc.returncode == 0 else "command_failed"
                error_message = (
                    None
                    if proc.returncode == 0
                    else f"Shell command exited with code {proc.returncode}."
                )
                await _terminate_process_group(
                    proc,
                    runtime.process_group_id,
                    self.settings.kill_grace_seconds,
                )
            elif cancel_task in done and runtime.cancel_event.is_set():
                terminal_state = "canceled"
                error_code = "command_canceled"
                error_message = "Command was canceled."
                await _terminate_process_group(
                    proc,
                    runtime.process_group_id,
                    self.settings.kill_grace_seconds,
                )
            elif shutdown_task in done and runtime.shutdown_event.is_set():
                terminal_state = "interrupted"
                error_code = "mcp_server_shutdown"
                error_message = "MCP server shutdown interrupted the command."
                await _terminate_process_group(
                    proc,
                    runtime.process_group_id,
                    self.settings.kill_grace_seconds,
                )
            else:
                terminal_state = "timed_out"
                error_code = "command_timeout"
                error_message = f"Command exceeded {timeout_seconds} seconds."
                await _terminate_process_group(
                    proc,
                    runtime.process_group_id,
                    self.settings.kill_grace_seconds,
                )

            for task in pending:
                task.cancel()
            if not process_task.done():
                try:
                    await asyncio.wait_for(process_task, timeout=self.settings.kill_grace_seconds)
                except (TimeoutError, asyncio.CancelledError):
                    process_task.cancel()
            _, reader_pending = await asyncio.wait(
                {stdout_task, stderr_task}, timeout=self.settings.reader_grace_seconds
            )
            for task in reader_pending:
                task.cancel()
            await self._finish(
                runtime,
                state=terminal_state,
                exit_code=proc.returncode,
                error_code=error_code,
                error_message=error_message,
            )
        except OperationDeadlineExceededError:
            if runtime.process is not None:
                await _terminate_process_group(
                    runtime.process,
                    runtime.process_group_id,
                    self.settings.kill_grace_seconds,
                )
            await self._finish(
                runtime,
                state="timed_out",
                exit_code=runtime.process.returncode if runtime.process is not None else None,
                error_code="command_timeout",
                error_message=f"Command exceeded {timeout_seconds} seconds during startup.",
            )
        except asyncio.CancelledError:
            if runtime.process is not None:
                await _terminate_process_group(
                    runtime.process,
                    runtime.process_group_id,
                    self.settings.kill_grace_seconds,
                )
            await self._finish(
                runtime,
                state="interrupted",
                error_code="operation_task_canceled",
                error_message="Command task was interrupted.",
            )
            raise
        except Exception as exc:
            await self._finish(
                runtime,
                state="failed",
                exit_code=runtime.process.returncode if runtime.process else None,
                error_code=(
                    exc.code if isinstance(exc, WorkspaceToolError) else "command_start_failed"
                ),
                error_message=exc.message if isinstance(exc, WorkspaceToolError) else str(exc),
            )
        finally:
            if runtime.process is not None:
                await _terminate_process_group(
                    runtime.process,
                    runtime.process_group_id,
                    self.settings.kill_grace_seconds,
                )
            self._runtimes.pop(operation_id, None)

    async def _drain_stream(
        self,
        runtime: OperationRuntime,
        stream_name: Literal["stdout", "stderr"],
        stream: asyncio.StreamReader | None,
        path: Path,
        max_output_bytes: int,
        *,
        plain_output: bool,
    ) -> None:
        if stream is None:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        handle = path.open("ab")
        sanitizer = _AnsiCsiStripper() if plain_output else None

        def store(chunk: bytes) -> None:
            if not chunk:
                return
            remaining = max(0, max_output_bytes - runtime.stored_bytes)
            accepted = chunk[:remaining]
            if accepted:
                handle.write(accepted)
                handle.flush()
                runtime.stored_bytes += len(accepted)
            if len(accepted) < len(chunk):
                runtime.record[f"{stream_name}_truncated"] = True

        try:
            while True:
                chunk = await stream.read(64 * 1024)
                if not chunk:
                    if sanitizer is not None:
                        async with runtime.lock:
                            store(sanitizer.feed(b"", final=True))
                    return
                stored_chunk = sanitizer.feed(chunk) if sanitizer is not None else chunk
                async with runtime.lock:
                    byte_field = f"{stream_name}_bytes"
                    runtime.record[byte_field] = int(runtime.record.get(byte_field) or 0) + len(
                        chunk
                    )
                    store(stored_chunk)
                self._queue_activity_output(runtime, stream_name, chunk)
        finally:
            handle.close()

    def _queue_activity_output(
        self,
        runtime: OperationRuntime,
        stream_name: Literal["stdout", "stderr"],
        chunk: bytes,
    ) -> None:
        text = chunk.decode("utf-8", errors="replace")
        text = _ANSI_ESCAPE_RE.sub("", text)
        text = redact_text(text, extra_secrets=runtime.activity_secrets)
        if not text:
            return
        current = runtime.activity_output.get(stream_name, "") + text
        if len(current) > _ACTIVITY_OUTPUT_CHARS:
            current = current[-_ACTIVITY_OUTPUT_CHARS:]
        runtime.activity_output[stream_name] = current
        preview = runtime.activity_preview.get(stream_name, "") + text
        if len(preview) > _ACTIVITY_PREVIEW_CHARS:
            preview = preview[-_ACTIVITY_PREVIEW_CHARS:]
        runtime.activity_preview[stream_name] = preview
        if runtime.activity_flush_task is None or runtime.activity_flush_task.done():
            runtime.activity_flush_task = asyncio.create_task(
                self._flush_activity_output_after(runtime),
                name=f"workspace-command-activity-{runtime.record['operation_id']}",
            )

    async def _flush_activity_output_after(self, runtime: OperationRuntime) -> None:
        await asyncio.sleep(_ACTIVITY_OUTPUT_FLUSH_SECONDS)
        self._flush_activity_output(runtime)

    def _flush_activity_output(self, runtime: OperationRuntime) -> None:
        operation_id = str(runtime.record["operation_id"])
        buffered = runtime.activity_output
        runtime.activity_output = {"stdout": "", "stderr": ""}
        runtime.activity_flush_task = None
        for stream_name in ("stdout", "stderr"):
            delta = buffered.get(stream_name, "")
            if not delta:
                continue
            log_activity(
                activity_id=f"command:{operation_id}",
                kind="command",
                phase="updated",
                payload={
                    "command": runtime.activity_command,
                    "workspace_id": runtime.record.get("workspace_id"),
                    "operation_id": operation_id,
                    "stream": stream_name,
                    "delta": delta,
                },
                legacy_action="workspaceCommand",
                legacy_fields={
                    "action": "output",
                    "operation_id": operation_id,
                    "stream": stream_name,
                    "chars": len(delta),
                },
            )

    async def _finish(
        self,
        runtime: OperationRuntime,
        *,
        state: OperationState,
        exit_code: int | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> None:
        flush_task = runtime.activity_flush_task
        if flush_task is not None and not flush_task.done():
            flush_task.cancel()
        self._flush_activity_output(runtime)
        async with runtime.lock:
            if runtime.record.get("state") in _TERMINAL_STATES:
                return
            runtime.record["state"] = state
            runtime.record["finished_at"] = _utc_now()
            runtime.record["exit_code"] = exit_code
            runtime.record["duration_ms"] = round(
                (time.monotonic() - runtime.started_monotonic) * 1000
            )
            runtime.record["error_code"] = error_code
            runtime.record["error_message"] = error_message
            self._write_record(runtime.record)
            payload = {
                "command": runtime.activity_command,
                "workspace_id": runtime.record.get("workspace_id"),
                "operation_id": runtime.record.get("operation_id"),
                "state": state,
                "exit_code": exit_code,
                "duration_ms": runtime.record["duration_ms"],
                "error_code": error_code,
                "error_message": error_message,
                "stdout_preview": _tail_text_preview(runtime.activity_preview.get("stdout", "")),
                "stderr_preview": _tail_text_preview(runtime.activity_preview.get("stderr", "")),
            }
        log_activity(
            activity_id=f"command:{runtime.record['operation_id']}",
            kind="command",
            phase="completed" if state == "succeeded" else "failed",
            payload=payload,
            legacy_action="workspaceCommand",
            legacy_fields={
                "action": "complete",
                "operation_id": runtime.record["operation_id"],
                "state": state,
                "exit_code": exit_code,
                "duration_ms": runtime.record["duration_ms"],
                "error_code": error_code,
            },
        )

    def _require_operation(self, operation_id: str) -> dict[str, Any]:
        record = self._records.get(operation_id)
        if record is None:
            raise WorkspaceToolError(
                "WORKSPACE_OPERATION_NOT_FOUND",
                "Workspace command operation was not found.",
            )
        return record

    def _write_record(self, record: dict[str, Any]) -> None:
        path = self._state_path(str(record["operation_id"]))
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f"{path.name}.{secrets.token_hex(4)}.tmp")
        data = json.dumps(record, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8")
        with temporary.open("wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)

    def _state_path(self, operation_id: str) -> Path:
        return self.root / operation_id / "state.json"

    def _stdout_path(self, operation_id: str) -> Path:
        return self.root / operation_id / "stdout.log"

    def _stderr_path(self, operation_id: str) -> Path:
        return self.root / operation_id / "stderr.log"

    @staticmethod
    def _public_record(record: dict[str, Any]) -> dict[str, Any]:
        hidden = {"request_hash", "idempotency_key", "plain_output", "max_output_bytes"}
        return {key: value for key, value in record.items() if key not in hidden}


async def _terminate_process_group(
    proc: asyncio.subprocess.Process,
    process_group_id: int | None,
    grace_seconds: int,
) -> None:
    grace = max(0.0, float(grace_seconds))
    group_id = process_group_id if process_group_id and process_group_id > 0 else None
    can_signal_group = group_id is not None and group_id != os.getpgrp()

    if can_signal_group:
        try:
            os.killpg(group_id, signal.SIGTERM)
        except ProcessLookupError:
            can_signal_group = False
        except PermissionError:
            pass

    if can_signal_group:
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline:
            if not _process_group_exists(group_id):
                break
            await asyncio.sleep(0.05)
        if _process_group_exists(group_id):
            try:
                os.killpg(group_id, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        await _wait_for_process_group_exit(group_id, timeout=max(1.0, grace))

    if proc.returncode is None:
        try:
            proc.terminate()
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(
                _wait_for_root_process_exit(proc),
                timeout=max(1.0, grace),
            )
        except TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(
                    _wait_for_root_process_exit(proc),
                    timeout=max(1.0, grace),
                )
            except TimeoutError:
                pass


async def _wait_for_root_process_exit(proc: asyncio.subprocess.Process) -> int:
    """Observe the root process exit without waiting for descendant-held pipe EOF."""

    while proc.returncode is None:
        await asyncio.sleep(0.02)
    return proc.returncode


def _process_group_exists(process_group_id: int) -> bool:
    try:
        os.killpg(process_group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


async def _wait_for_process_group_exit(process_group_id: int, *, timeout: float) -> bool:
    deadline = time.monotonic() + max(0.0, timeout)
    while _process_group_exists(process_group_id):
        if time.monotonic() >= deadline:
            return False
        await asyncio.sleep(0.05)
    return True


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _script_summary(script: str) -> str:
    return " ".join(script.strip().split())[:200]


def _read_log(path: Path, offset: int, max_bytes: int, *, final: bool = True) -> tuple[str, int]:
    if not path.is_file():
        return "", offset
    with path.open("rb") as handle:
        handle.seek(offset)
        data = handle.read(max_bytes)
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        text = decoder.decode(data, final=False)
        pending, _ = decoder.getstate()
        consumed = len(data) - len(pending)

        # If the byte budget cuts the first UTF-8 code point, read only enough
        # extra bytes to finish that character so pagination always makes progress.
        while consumed == 0 and pending and len(pending) < 4:
            extra = handle.read(1)
            if not extra:
                if final:
                    text += decoder.decode(b"", final=True)
                    consumed = handle.tell() - offset
                break
            emitted = decoder.decode(extra, final=False)
            pending, _ = decoder.getstate()
            if emitted:
                text += emitted
                consumed = handle.tell() - offset - len(pending)
                break

        next_offset = offset + consumed
    return text, next_offset


def _log_has_decodable_progress(path: Path, offset: int) -> bool:
    if not path.is_file() or _file_size(path) <= offset:
        return False
    _, next_offset = _read_log(path, offset, 1, final=False)
    return next_offset > offset


def _file_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _tail_text_preview(text: str) -> list[str]:
    lines = [line.rstrip() for line in text.splitlines() if line.strip()]
    return lines[-_ACTIVITY_PREVIEW_LINES:]
