from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

import pytest

import workspace_mcp.workspace_operations as operations_module
from workspace_mcp.workspace_files import (
    LocalWorkspaceService,
    _fit_read_files_response,
    _run_bounded_command,
)
from workspace_mcp.workspace_operations import OperationSettings, WorkspaceOperationManager
from workspace_mcp.workspace_patch import (
    PreparedFileChange,
    WorkspaceToolError,
    _rollback_committed_changes,
    commit_prepared_changes,
    describe_changes,
)


async def _wait_terminal(
    manager: WorkspaceOperationManager,
    operation_id: str,
    *,
    timeout: float = 5,
) -> dict[str, object]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        operation = await manager.get(operation_id)
        if operation["state"] != "running":
            return operation
        await asyncio.sleep(0.01)
    raise AssertionError(f"operation did not finish: {operation_id}")


def test_prepared_commit_restores_original_when_commit_step_fails() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        target = root / "alpha.txt"
        target.write_bytes(b"before\n")
        change = PreparedFileChange(
            path="alpha.txt",
            resolved_path=target,
            before=b"before\n",
            after=b"after\n",
        )
        real_replace = os.replace

        def fail_stage_replace(source: str | Path, destination: str | Path) -> None:
            if str(source).endswith(".stage"):
                raise OSError("injected stage replace failure")
            real_replace(source, destination)

        with patch("workspace_mcp.workspace_patch.os.replace", side_effect=fail_stage_replace):
            with pytest.raises(OSError, match="injected stage replace failure"):
                commit_prepared_changes(root, [change])

        assert target.read_bytes() == b"before\n"
        assert not list(root.glob(".*.stage"))
        assert not list(root.glob(".*.backup"))


def test_partial_stage_write_is_registered_and_cleaned() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp) / "workspace"
        root.mkdir()
        target = root / "alpha.txt"
        target.write_bytes(b"before\n")
        change = PreparedFileChange(
            path="alpha.txt",
            resolved_path=target,
            before=b"before\n",
            after=b"after\n",
        )
        transaction_parent = root.parent / ".workspace-mcp-transactions"
        real_write_bytes = Path.write_bytes

        def partial_then_fail(path: Path, data: bytes) -> int:
            if path.suffix == ".stage":
                with path.open("wb") as handle:
                    handle.write(data[:2])
                raise OSError("injected stage write failure")
            return real_write_bytes(path, data)

        with patch.object(Path, "write_bytes", partial_then_fail):
            with pytest.raises(OSError, match="injected stage write failure"):
                commit_prepared_changes(root, [change])

        assert target.read_bytes() == b"before\n"
        assert not transaction_parent.exists()


def test_partial_cleanup_failure_preserves_committed_change() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp) / "workspace"
        root.mkdir()
        target = root / "alpha.txt"
        target.write_bytes(b"before\n")
        change = PreparedFileChange(
            path="alpha.txt",
            resolved_path=target,
            before=b"before\n",
            after=b"after\n",
        )
        transaction_parent = root.parent / ".workspace-mcp-transactions"
        real_rmtree = shutil.rmtree

        def delete_backups_then_fail(path: str | os.PathLike[str], *args, **kwargs) -> None:
            transaction_dir = Path(path)
            backups = transaction_dir / "backups"
            if backups.exists():
                real_rmtree(backups)
            raise PermissionError("injected failure after backups were deleted")

        with patch(
            "workspace_mcp.workspace_patch.shutil.rmtree",
            side_effect=delete_backups_then_fail,
        ):
            with pytest.raises(WorkspaceToolError) as captured:
                commit_prepared_changes(root, [change])

        assert captured.value.code == "WORKSPACE_TRANSACTION_CLEANUP_FAILED"
        assert "committed files were left intact" in captured.value.message
        assert target.read_bytes() == b"after\n"
        assert transaction_parent.exists()


def test_rollback_without_backup_keeps_current_target() -> None:
    with tempfile.TemporaryDirectory() as temp:
        target = Path(temp) / "alpha.txt"
        target.write_bytes(b"committed\n")
        change = PreparedFileChange(
            path="alpha.txt",
            resolved_path=target,
            before=b"before\n",
            after=b"committed\n",
        )

        errors = _rollback_committed_changes([change], {})

        assert errors == ["alpha.txt: backup is unavailable; the current target was left intact"]
        assert target.read_bytes() == b"committed\n"


def test_long_single_line_does_not_advance_continuation() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "long.txt").write_text("abcdefghij\nsecond\n", encoding="utf-8")

        result = LocalWorkspaceService()._read_file_content(
            root,
            "long.txt",
            start_line=1,
            max_lines=2,
            max_bytes=6,
        )

        assert result["content"] == ""
        assert result["end_line"] is None
        assert result["truncated"] is True
        assert result["next_start_line"] == 1


def test_response_budget_truncation_restarts_current_file() -> None:
    response = {
        "files": [
            {
                "path": "alpha.txt",
                "start_line": 5,
                "end_line": 5,
                "total_lines": 10,
                "bytes": 5000,
                "sha256": "0" * 64,
                "content": "5: " + ("x" * 2000),
                "truncated": False,
                "next_start_line": None,
                "error": None,
            }
        ],
        "truncated": False,
    }

    fitted = _fit_read_files_response(response, 1024)

    assert fitted["files"][0]["content"] == ""
    assert fitted["files"][0]["truncated"] is True
    assert fitted["files"][0]["next_start_line"] == 5


def test_newline_only_change_has_nonzero_line_counts() -> None:
    change = PreparedFileChange(
        path="script.sh",
        resolved_path=Path("script.sh"),
        before=b"echo ok",
        after=b"echo ok\n",
    )

    changed, diff_stat = describe_changes([change])

    assert changed[0]["additions"] == 1
    assert changed[0]["deletions"] == 1
    assert "+1 -1" in diff_stat


def test_bounded_command_runner_does_not_collect_unlimited_stdout() -> None:
    async def scenario() -> None:
        with tempfile.TemporaryDirectory() as temp:
            result = await _run_bounded_command(
                [sys.executable, "-c", "import sys; sys.stdout.write('x' * 5000000)"],
                cwd=Path(temp),
                timeout_seconds=10,
                max_output_bytes=2048,
            )
            assert result["exit_code"] == 0
            assert result["truncated"] is True
            assert len(result["stdout"]) + len(result["stderr"]) <= 2048

    asyncio.run(scenario())


def test_initial_operation_state_write_failure_rolls_back_all_indexes() -> None:
    async def scenario() -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            manager = WorkspaceOperationManager(OperationSettings(root=root / "operations"))
            with patch.object(manager, "_write_record", side_effect=OSError("disk full")):
                with pytest.raises(OSError, match="disk full"):
                    await manager.start(
                        workspace_id="ws_0000000000000000",
                        workspace_root=root,
                        idempotency_key="state-write-failure",
                        script="Write-Output unreachable",
                        timeout_seconds=10,
                        max_output_bytes=20_000,
                        plain_output=True,
                        utf8_output=True,
                    )
            assert manager._records == {}
            assert manager._runtimes == {}
            assert manager._idempotency == {}

    asyncio.run(scenario())


def test_command_startup_uses_end_to_end_deadline() -> None:
    async def scenario() -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            process_started = False
            closed_jobs: list[bool] = []

            class SlowJob:
                def __init__(self) -> None:
                    time.sleep(0.25)
                    self.assigned = False

                def close(self) -> None:
                    closed_jobs.append(True)

            async def fake_create_subprocess_exec(*args, **kwargs):
                nonlocal process_started
                process_started = True
                raise AssertionError("process creation must not start after deadline")

            manager = WorkspaceOperationManager(OperationSettings(root=root / "operations"))
            started = time.monotonic()
            with (
                patch.object(operations_module, "WindowsJob", SlowJob),
                patch.object(
                    operations_module.asyncio,
                    "create_subprocess_exec",
                    fake_create_subprocess_exec,
                ),
            ):
                operation = await manager.start(
                    workspace_id="ws_0000000000000000",
                    workspace_root=root,
                    idempotency_key="startup-timeout",
                    script="Write-Output unreachable",
                    timeout_seconds=0.05,
                    max_output_bytes=20_000,
                    plain_output=True,
                    utf8_output=True,
                )
                terminal = await _wait_terminal(manager, operation["operation_id"], timeout=1)
                elapsed = time.monotonic() - started
                assert terminal["state"] == "timed_out"
                assert elapsed < 0.2
                assert process_started is False
                await asyncio.sleep(0.3)
                assert closed_jobs == [True]
                await manager.shutdown()

    asyncio.run(scenario())
