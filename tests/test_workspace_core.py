from __future__ import annotations

import asyncio
import os
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

from workspace_mcp.workspace_files import LocalWorkspaceService


def _run(coro):
    return asyncio.run(coro)


def _environment(root: Path, *, sync_wait: int = 5):
    return patch.dict(
        os.environ,
        {
            "WORKSPACE_ROOT": str(root / "workspaces"),
            "WORKSPACE_OPERATION_ROOT": str(root / "operations"),
            "WORKSPACE_COMMAND_SYNC_WAIT_SECONDS": str(sync_wait),
            "WORKSPACE_COMMAND_TIMEOUT_SECONDS": "10",
            "WORKSPACE_COMMAND_MAX_TIMEOUT_SECONDS": "30",
        },
        clear=False,
    )


def test_workspace_files_search_write_and_patch() -> None:
    async def scenario(root: Path) -> None:
        service = LocalWorkspaceService()
        try:
            first = await service.prepare_workspace(
                idempotency_key="workspace-core-001", workspace_id=None
            )
            second = await service.prepare_workspace(
                idempotency_key="workspace-core-001", workspace_id=None
            )
            assert first["workspace_id"] == second["workspace_id"]
            assert first["created"] is True
            assert second["created"] is False
            workspace_id = str(first["workspace_id"])

            written = await service.write_file(
                workspace_id=workspace_id,
                path="src/example.txt",
                content="alpha\nbeta\n",
                mode="create_only",
                line_ending="lf",
                expected_sha256=None,
                dry_run=False,
                max_bytes=None,
            )
            assert written["written"] is True

            read = await service.read_files(
                workspace_id=workspace_id,
                paths=["src/example.txt"],
                start_line=1,
                max_lines=10,
                max_bytes_per_file=None,
                max_bytes=None,
            )
            assert "1: alpha" in read["files"][0]["content"]

            search = await service.search(
                workspace_id=workspace_id,
                query="beta",
                regex=False,
                case_sensitive=False,
                paths=["."],
                context_lines=1,
                max_matches=10,
                max_bytes=None,
            )
            assert search["match_count"] == 1

            inspected = await service.inspect(
                workspace_id=workspace_id,
                paths=["."],
                queries=["alpha"],
                max_depth=3,
                max_tree_entries=50,
                context_lines=1,
                max_search_matches=10,
                max_read_files=5,
                max_file_lines=20,
                max_bytes_per_file=None,
                max_bytes=None,
            )
            assert any(item["path"] == "src/example.txt" for item in inspected["tree"])

            patched = await service.apply_patch(
                workspace_id=workspace_id,
                patch=(
                    "*** Begin Patch\n"
                    "*** Update File: src/example.txt\n"
                    "@@\n"
                    "-beta\n"
                    "+gamma\n"
                    "*** End Patch"
                ),
                dry_run=False,
                allow_delete=False,
                max_changed_files=None,
                max_patch_bytes=None,
            )
            assert patched["applied"] is True
            file_path = Path(os.environ["WORKSPACE_ROOT"]) / workspace_id / "src/example.txt"
            assert file_path.read_text(encoding="utf-8") == "alpha\ngamma\n"
        finally:
            await service.shutdown()

    with tempfile.TemporaryDirectory() as temp, _environment(Path(temp)):
        _run(scenario(Path(temp)))


def test_command_start_returns_terminal_logs_for_fast_command() -> None:
    async def scenario() -> None:
        service = LocalWorkspaceService()
        try:
            workspace = await service.prepare_workspace(
                idempotency_key="fast-command-001", workspace_id=None
            )
            result = await service.command_start(
                workspace_id=str(workspace["workspace_id"]),
                idempotency_key="fast-op-001",
                script="Write-Output 'hello-mcp'",
                timeout_seconds=10,
                max_output_bytes=None,
                plain_output=True,
                utf8_output=True,
                max_bytes=50_000,
            )
            assert result["operation"]["state"] == "succeeded"
            assert "hello-mcp" in result["stdout"]
            assert result["next_stdout_offset"] > 0
            assert result["stdout_eof"] is True
        finally:
            await service.shutdown()

    with tempfile.TemporaryDirectory() as temp, _environment(Path(temp), sync_wait=5):
        _run(scenario())


def test_command_get_waits_for_changes_and_returns_delta_logs_without_repeating() -> None:
    async def scenario() -> None:
        service = LocalWorkspaceService()
        try:
            workspace = await service.prepare_workspace(
                idempotency_key="follow-command-001", workspace_id=None
            )
            start = await service.command_start(
                workspace_id=str(workspace["workspace_id"]),
                idempotency_key="follow-op-001",
                script=(
                    "Write-Output 'first'; "
                    "Start-Sleep -Milliseconds 400; "
                    "Write-Output 'second'; "
                    "Start-Sleep -Milliseconds 400"
                ),
                timeout_seconds=10,
                max_output_bytes=None,
                plain_output=True,
                utf8_output=True,
                max_bytes=50_000,
            )
            operation_id = str(start["operation"]["operation_id"])
            stdout_offset = int(start["next_stdout_offset"])
            stderr_offset = int(start["next_stderr_offset"])
            pieces = [str(start["stdout"])]

            deadline = time.monotonic() + 5
            state = str(start["operation"]["state"])
            while state == "running" and time.monotonic() < deadline:
                result = await service.command_get(
                    operation_id,
                    wait_seconds=1,
                    stdout_offset=stdout_offset,
                    stderr_offset=stderr_offset,
                    max_bytes=50_000,
                )
                pieces.append(str(result["stdout"]))
                stdout_offset = int(result["next_stdout_offset"])
                stderr_offset = int(result["next_stderr_offset"])
                state = str(result["operation"]["state"])

            assert state == "succeeded"
            combined = "".join(pieces)
            assert combined.count("first") == 1
            assert combined.count("second") == 1

            replay = await service.command_logs(
                operation_id,
                stdout_offset=0,
                stderr_offset=0,
                max_bytes=50_000,
            )
            assert "first" in replay["stdout"]
            assert "second" in replay["stdout"]
        finally:
            await service.shutdown()

    with tempfile.TemporaryDirectory() as temp, _environment(Path(temp), sync_wait=0):
        _run(scenario())


def test_command_idempotency_list_cancel_and_timeout() -> None:
    async def scenario() -> None:
        service = LocalWorkspaceService()
        try:
            workspace = await service.prepare_workspace(
                idempotency_key="command-admin-001", workspace_id=None
            )
            workspace_id = str(workspace["workspace_id"])
            first = await service.command_start(
                workspace_id=workspace_id,
                idempotency_key="same-op-key",
                script="Start-Sleep -Seconds 5",
                timeout_seconds=10,
                max_output_bytes=None,
                plain_output=True,
                utf8_output=True,
                max_bytes=50_000,
            )
            duplicate = await service.command_start(
                workspace_id=workspace_id,
                idempotency_key="same-op-key",
                script="Start-Sleep -Seconds 5",
                timeout_seconds=10,
                max_output_bytes=None,
                plain_output=True,
                utf8_output=True,
                max_bytes=50_000,
            )
            assert first["operation"]["operation_id"] == duplicate["operation"]["operation_id"]
            operation_id = str(first["operation"]["operation_id"])
            listed = await service.command_list("running")
            assert any(item["operation_id"] == operation_id for item in listed)
            await service.command_cancel(operation_id)

            deadline = time.monotonic() + 5
            state = "running"
            while state == "running" and time.monotonic() < deadline:
                result = await service.command_get(
                    operation_id,
                    wait_seconds=0.2,
                    stdout_offset=0,
                    stderr_offset=0,
                    max_bytes=50_000,
                )
                state = str(result["operation"]["state"])
            assert state == "canceled"

            timed = await service.command_start(
                workspace_id=workspace_id,
                idempotency_key="timeout-op-key",
                script="Start-Sleep -Seconds 2",
                timeout_seconds=1,
                max_output_bytes=None,
                plain_output=True,
                utf8_output=True,
                max_bytes=50_000,
            )
            timed_id = str(timed["operation"]["operation_id"])
            state = str(timed["operation"]["state"])
            deadline = time.monotonic() + 4
            while state == "running" and time.monotonic() < deadline:
                result = await service.command_get(
                    timed_id,
                    wait_seconds=0.5,
                    stdout_offset=0,
                    stderr_offset=0,
                    max_bytes=50_000,
                )
                state = str(result["operation"]["state"])
            assert state == "timed_out"
        finally:
            await service.shutdown()

    with tempfile.TemporaryDirectory() as temp, _environment(Path(temp), sync_wait=0):
        _run(scenario())
