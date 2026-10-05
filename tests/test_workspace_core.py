from __future__ import annotations

import asyncio
import os
import shlex
import stat
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from workspace_mcp.workspace_files import LocalWorkspaceService
from workspace_mcp.workspace_operations import _read_log
from workspace_mcp.workspace_patch import WorkspaceToolError


def _run(coro):
    return asyncio.run(coro)


def _environment(root: Path, *, sync_wait: int = 5):
    return patch.dict(
        os.environ,
        {
            "WORKSPACE_ROOT": str(root / "workspaces"),
            "WORKSPACE_OPERATION_ROOT": str(root / "operations"),
            "WORKSPACE_SHELL_PATH": "/bin/bash",
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
            assert file_path.read_bytes() == b"alpha\ngamma\n"
        finally:
            await service.shutdown()

    with tempfile.TemporaryDirectory() as temp, _environment(Path(temp)):
        _run(scenario(Path(temp)))


def test_workspace_file_tools_reject_paths_outside_root() -> None:
    async def scenario(root: Path) -> None:
        service = LocalWorkspaceService()
        try:
            prepared = await service.prepare_workspace(
                idempotency_key="workspace-boundary-001", workspace_id=None
            )
            workspace_id = str(prepared["workspace_id"])
            outside = root / "escape.txt"
            workspace_root = Path(os.environ["WORKSPACE_ROOT"]) / workspace_id

            for unsafe_path in ("../escape.txt", str(outside.resolve())):
                with pytest.raises(WorkspaceToolError) as captured:
                    await service.write_file(
                        workspace_id=workspace_id,
                        path=unsafe_path,
                        content="blocked\n",
                        mode="create_only",
                        line_ending="lf",
                        expected_sha256=None,
                        dry_run=False,
                        max_bytes=None,
                    )
                assert captured.value.code == "WORKSPACE_PATH_OUTSIDE_ROOT"
            assert not outside.exists()

            with pytest.raises(WorkspaceToolError) as captured:
                await service.read_files(
                    workspace_id=workspace_id,
                    paths=["../escape.txt"],
                    start_line=1,
                    max_lines=10,
                    max_bytes_per_file=None,
                    max_bytes=None,
                )
            assert captured.value.code == "WORKSPACE_PATH_OUTSIDE_ROOT"

            with pytest.raises(WorkspaceToolError) as captured:
                await service.search(
                    workspace_id=workspace_id,
                    query="anything",
                    regex=False,
                    case_sensitive=False,
                    paths=[".."],
                    context_lines=0,
                    max_matches=10,
                    max_bytes=None,
                )
            assert captured.value.code == "WORKSPACE_PATH_OUTSIDE_ROOT"

            with pytest.raises(WorkspaceToolError) as captured:
                await service.inspect(
                    workspace_id=workspace_id,
                    paths=[".."],
                    queries=[],
                    max_depth=2,
                    max_tree_entries=10,
                    context_lines=0,
                    max_search_matches=10,
                    max_read_files=0,
                    max_file_lines=10,
                    max_bytes_per_file=None,
                    max_bytes=None,
                )
            assert captured.value.code == "WORKSPACE_PATH_OUTSIDE_ROOT"

            with pytest.raises(WorkspaceToolError) as captured:
                await service.apply_patch(
                    workspace_id=workspace_id,
                    patch=(
                        "*** Begin Patch\n"
                        "*** Add File: ../escape-patch.txt\n"
                        "+blocked\n"
                        "*** End Patch"
                    ),
                    dry_run=False,
                    allow_delete=False,
                    max_changed_files=None,
                    max_patch_bytes=None,
                )
            assert captured.value.code == "WORKSPACE_PATH_OUTSIDE_ROOT"
            assert not (root / "escape-patch.txt").exists()

            outside_dir = root / "outside-dir"
            outside_dir.mkdir()
            link = workspace_root / "outside-link"
            try:
                link.symlink_to(outside_dir, target_is_directory=True)
            except OSError:
                pytest.skip("directory symlink creation is unavailable on this test host")

            with pytest.raises(WorkspaceToolError) as captured:
                await service.write_file(
                    workspace_id=workspace_id,
                    path="outside-link/escaped.txt",
                    content="blocked\n",
                    mode="create_only",
                    line_ending="lf",
                    expected_sha256=None,
                    dry_run=False,
                    max_bytes=None,
                )
            assert captured.value.code == "WORKSPACE_PATH_OUTSIDE_ROOT"
            assert not (outside_dir / "escaped.txt").exists()
        finally:
            await service.shutdown()

    with tempfile.TemporaryDirectory() as temp, _environment(Path(temp)):
        _run(scenario(Path(temp)))


def test_utf8_log_pagination_never_splits_code_points() -> None:
    with tempfile.TemporaryDirectory() as temp:
        path = Path(temp) / "stdout.log"
        expected = "你好🙂ASCII\n错误🚫\n"
        encoded = expected.encode("utf-8")
        path.write_bytes(encoded)

        offset = 0
        pieces: list[str] = []
        while offset < len(encoded):
            text, next_offset = _read_log(path, offset, 1)
            assert next_offset > offset
            pieces.append(text)
            offset = next_offset

        assert "".join(pieces) == expected
        assert offset == len(encoded)


@pytest.mark.skipif(os.name != "posix", reason="Linux command runner requires POSIX process groups")
def test_running_command_utf8_partial_writes_do_not_emit_replacement_characters() -> None:
    async def scenario() -> None:
        service = LocalWorkspaceService()
        try:
            workspace = await service.prepare_workspace(
                idempotency_key="utf8-live-command-001", workspace_id=None
            )
            python_code = (
                "import sys,time; s=sys.stdout.buffer; "
                "s.write(bytes([228])); s.flush(); time.sleep(0.3); "
                "s.write(bytes([189])); s.flush(); time.sleep(0.3); "
                "s.write(bytes([160])); s.flush(); time.sleep(0.3)"
            )
            script = f"{shlex.quote(sys.executable)} -c {shlex.quote(python_code)}"
            start = await service.command_start(
                workspace_id=str(workspace["workspace_id"]),
                idempotency_key="utf8-live-op-001",
                script=script,
                timeout_seconds=10,
                max_output_bytes=None,
                plain_output=True,
                utf8_output=True,
                max_bytes=1,
            )
            operation_id = str(start["operation"]["operation_id"])
            stdout_offset = int(start["next_stdout_offset"])
            stderr_offset = int(start["next_stderr_offset"])
            pieces = [str(start["stdout"])]
            state = str(start["operation"]["state"])

            deadline = time.monotonic() + 5
            while state == "running" and time.monotonic() < deadline:
                result = await service.command_get(
                    operation_id,
                    wait_seconds=1,
                    stdout_offset=stdout_offset,
                    stderr_offset=stderr_offset,
                    max_bytes=1,
                )
                pieces.append(str(result["stdout"]))
                stdout_offset = int(result["next_stdout_offset"])
                stderr_offset = int(result["next_stderr_offset"])
                state = str(result["operation"]["state"])

            assert state == "succeeded"
            combined = "".join(pieces)
            assert combined == "你"
            assert "�" not in combined
        finally:
            await service.shutdown()

    with tempfile.TemporaryDirectory() as temp, _environment(Path(temp), sync_wait=0):
        _run(scenario())


@pytest.mark.skipif(os.name != "posix", reason="Linux command runner requires POSIX process groups")
def test_plain_output_strips_ansi_sequences_split_across_live_chunks() -> None:
    async def scenario() -> None:
        service = LocalWorkspaceService()
        try:
            workspace = await service.prepare_workspace(
                idempotency_key="ansi-live-command-001", workspace_id=None
            )
            bytes_to_write = [27, 91, 51, 49, 109, 82, 69, 68, 27, 91, 48, 109]
            writes = "; ".join(
                f"s.write(bytes([{value}])); s.flush(); time.sleep(0.08)"
                for value in bytes_to_write
            )
            python_code = f"import sys,time; s=sys.stdout.buffer; {writes}"
            script = f"{shlex.quote(sys.executable)} -c {shlex.quote(python_code)}"
            start = await service.command_start(
                workspace_id=str(workspace["workspace_id"]),
                idempotency_key="ansi-live-op-001",
                script=script,
                timeout_seconds=10,
                max_output_bytes=None,
                plain_output=True,
                utf8_output=True,
                max_bytes=1,
            )
            operation_id = str(start["operation"]["operation_id"])
            stdout_offset = int(start["next_stdout_offset"])
            stderr_offset = int(start["next_stderr_offset"])
            pieces = [str(start["stdout"])]
            state = str(start["operation"]["state"])

            deadline = time.monotonic() + 5
            while state == "running" and time.monotonic() < deadline:
                result = await service.command_get(
                    operation_id,
                    wait_seconds=1,
                    stdout_offset=stdout_offset,
                    stderr_offset=stderr_offset,
                    max_bytes=1,
                )
                pieces.append(str(result["stdout"]))
                stdout_offset = int(result["next_stdout_offset"])
                stderr_offset = int(result["next_stderr_offset"])
                state = str(result["operation"]["state"])

            assert state == "succeeded"
            combined = "".join(pieces)
            assert combined == "RED"
            assert "\x1b" not in combined
        finally:
            await service.shutdown()

    with tempfile.TemporaryDirectory() as temp, _environment(Path(temp), sync_wait=0):
        _run(scenario())


@pytest.mark.skipif(os.name != "posix", reason="Linux command runner requires POSIX process groups")
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
                script="printf '%s\n' 'hello-mcp'",
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


@pytest.mark.skipif(os.name != "posix", reason="Linux command runner requires POSIX process groups")
def test_workspace_command_intentionally_has_os_account_scope_outside_workspace_root() -> None:
    async def scenario(root: Path) -> None:
        service = LocalWorkspaceService()
        try:
            workspace = await service.prepare_workspace(
                idempotency_key="os-scope-command-001", workspace_id=None
            )
            outside = root / "outside-workspace-command.txt"
            script = "printf '%s\n' 'intentional-os-account-scope' > " + shlex.quote(str(outside))
            result = await service.command_start(
                workspace_id=str(workspace["workspace_id"]),
                idempotency_key="os-scope-operation-001",
                script=script,
                timeout_seconds=10,
                max_output_bytes=None,
                plain_output=True,
                utf8_output=True,
                max_bytes=50_000,
            )
            assert result["operation"]["state"] == "succeeded"
            assert outside.is_file()
            assert "intentional-os-account-scope" in outside.read_text(encoding="utf-8")
        finally:
            await service.shutdown()

    with tempfile.TemporaryDirectory() as temp, _environment(Path(temp), sync_wait=5):
        _run(scenario(Path(temp)))


@pytest.mark.skipif(os.name != "posix", reason="Linux command runner requires POSIX process groups")
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
                script=("printf '%s\n' 'first'; sleep 0.4; printf '%s\n' 'second'; sleep 0.4"),
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


@pytest.mark.skipif(os.name != "posix", reason="Linux command runner requires POSIX process groups")
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
                script="sleep 5",
                timeout_seconds=10,
                max_output_bytes=None,
                plain_output=True,
                utf8_output=True,
                max_bytes=50_000,
            )
            duplicate = await service.command_start(
                workspace_id=workspace_id,
                idempotency_key="same-op-key",
                script="sleep 5",
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
                script="sleep 2",
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


def test_write_and_patch_preserve_existing_line_endings() -> None:
    async def scenario(root: Path) -> None:
        service = LocalWorkspaceService()
        try:
            workspace = await service.prepare_workspace(
                idempotency_key="line-ending-workspace-001", workspace_id=None
            )
            workspace_id = str(workspace["workspace_id"])
            workspace_root = Path(os.environ["WORKSPACE_ROOT"]) / workspace_id
            target = workspace_root / "windows.txt"
            target.write_bytes(b"alpha\r\nbeta\r\n")

            await service.write_file(
                workspace_id=workspace_id,
                path="windows.txt",
                content="alpha\nbeta2\n",
                mode="overwrite",
                line_ending="preserve",
                expected_sha256=None,
                dry_run=False,
                max_bytes=None,
            )
            assert target.read_bytes() == b"alpha\r\nbeta2\r\n"

            await service.apply_patch(
                workspace_id=workspace_id,
                patch=(
                    "*** Begin Patch\n"
                    "*** Update File: windows.txt\n"
                    "@@\n"
                    "-beta2\n"
                    "+gamma\n"
                    "*** End Patch"
                ),
                dry_run=False,
                allow_delete=False,
                max_changed_files=None,
                max_patch_bytes=None,
            )
            assert target.read_bytes() == b"alpha\r\ngamma\r\n"

            await service.write_file(
                workspace_id=workspace_id,
                path="new.txt",
                content="one\r\ntwo\r\n",
                mode="create_only",
                line_ending="preserve",
                expected_sha256=None,
                dry_run=False,
                max_bytes=None,
            )
            assert (workspace_root / "new.txt").read_bytes() == b"one\ntwo\n"

            await service.write_file(
                workspace_id=workspace_id,
                path="forced-crlf.txt",
                content="one\ntwo\n",
                mode="create_only",
                line_ending="crlf",
                expected_sha256=None,
                dry_run=False,
                max_bytes=None,
            )
            assert (workspace_root / "forced-crlf.txt").read_bytes() == b"one\r\ntwo\r\n"
        finally:
            await service.shutdown()

    with tempfile.TemporaryDirectory() as temp, _environment(Path(temp)):
        _run(scenario(Path(temp)))


@pytest.mark.skipif(
    os.name != "posix",
    reason="POSIX mode bits are a Linux/Unix file-system feature",
)
def test_write_and_patch_preserve_posix_mode() -> None:
    async def scenario(root: Path) -> None:
        service = LocalWorkspaceService()
        try:
            workspace = await service.prepare_workspace(
                idempotency_key="mode-workspace-001", workspace_id=None
            )
            workspace_id = str(workspace["workspace_id"])
            workspace_root = Path(os.environ["WORKSPACE_ROOT"]) / workspace_id
            target = workspace_root / "script.sh"
            target.write_bytes(b"#!/bin/bash\necho before\n")
            target.chmod(0o755)

            await service.write_file(
                workspace_id=workspace_id,
                path="script.sh",
                content="#!/bin/bash\necho after\n",
                mode="overwrite",
                line_ending="preserve",
                expected_sha256=None,
                dry_run=False,
                max_bytes=None,
            )
            assert stat.S_IMODE(target.stat().st_mode) == 0o755

            await service.apply_patch(
                workspace_id=workspace_id,
                patch=(
                    "*** Begin Patch\n"
                    "*** Update File: script.sh\n"
                    "@@\n"
                    "-echo after\n"
                    "+echo patched\n"
                    "*** End Patch"
                ),
                dry_run=False,
                allow_delete=False,
                max_changed_files=None,
                max_patch_bytes=None,
            )
            assert stat.S_IMODE(target.stat().st_mode) == 0o755

            await service.apply_patch(
                workspace_id=workspace_id,
                patch=(
                    "*** Begin Patch\n"
                    "*** Update File: script.sh\n"
                    "*** Move to: bin/script.sh\n"
                    "@@\n"
                    "-echo patched\n"
                    "+echo moved\n"
                    "*** End Patch"
                ),
                dry_run=False,
                allow_delete=False,
                max_changed_files=None,
                max_patch_bytes=None,
            )
            moved = workspace_root / "bin/script.sh"
            assert not target.exists()
            assert moved.read_bytes() == b"#!/bin/bash\necho moved\n"
            assert stat.S_IMODE(moved.stat().st_mode) == 0o755

            plain = workspace_root / "plain.txt"
            plain.write_bytes(b"before\n")
            plain.chmod(0o644)
            await service.write_file(
                workspace_id=workspace_id,
                path="plain.txt",
                content="after\n",
                mode="overwrite",
                line_ending="preserve",
                expected_sha256=None,
                dry_run=False,
                max_bytes=None,
            )
            assert stat.S_IMODE(plain.stat().st_mode) == 0o644
        finally:
            await service.shutdown()

    with tempfile.TemporaryDirectory() as temp, _environment(Path(temp)):
        _run(scenario(Path(temp)))


@pytest.mark.skipif(os.name != "posix", reason="Linux paths are case-sensitive")
def test_workspace_paths_follow_linux_case_sensitive_semantics() -> None:
    async def scenario(root: Path) -> None:
        service = LocalWorkspaceService()
        try:
            workspace = await service.prepare_workspace(
                idempotency_key="case-sensitive-workspace-001", workspace_id=None
            )
            workspace_id = str(workspace["workspace_id"])
            for path, content in (("Case.txt", "upper\n"), ("case.txt", "lower\n")):
                await service.write_file(
                    workspace_id=workspace_id,
                    path=path,
                    content=content,
                    mode="create_only",
                    line_ending="preserve",
                    expected_sha256=None,
                    dry_run=False,
                    max_bytes=None,
                )
            workspace_root = Path(os.environ["WORKSPACE_ROOT"]) / workspace_id
            assert (workspace_root / "Case.txt").read_bytes() == b"upper\n"
            assert (workspace_root / "case.txt").read_bytes() == b"lower\n"
        finally:
            await service.shutdown()

    with tempfile.TemporaryDirectory() as temp, _environment(Path(temp)):
        _run(scenario(Path(temp)))


@pytest.mark.skipif(
    os.name != "posix",
    reason="Linux user-home expansion is POSIX deployment behavior",
)
def test_user_local_storage_paths_expand_home() -> None:
    async def scenario(root: Path) -> None:
        home = root / "home"
        home.mkdir()
        with patch.dict(
            os.environ,
            {
                "HOME": str(home),
                "WORKSPACE_ROOT": "~/.local/share/workspace-mcp/workspaces",
                "WORKSPACE_OPERATION_ROOT": "~/.local/state/workspace-mcp/operations",
            },
            clear=False,
        ):
            service = LocalWorkspaceService()
            try:
                workspace = await service.prepare_workspace(
                    idempotency_key="user-local-paths-001", workspace_id=None
                )
                workspace_id = str(workspace["workspace_id"])
                assert (home / ".local/share/workspace-mcp/workspaces" / workspace_id).is_dir()
                service.command_limits()
                assert (home / ".local/state/workspace-mcp/operations").is_dir()
            finally:
                await service.shutdown()

    with tempfile.TemporaryDirectory() as temp:
        _run(scenario(Path(temp)))


@pytest.mark.skipif(os.name != "posix", reason="Backslash is a literal filename character on Linux")
def test_workspace_search_preserves_literal_backslash_in_linux_filename() -> None:
    async def scenario(root: Path) -> None:
        service = LocalWorkspaceService()
        try:
            workspace = await service.prepare_workspace(
                idempotency_key="backslash-workspace-001", workspace_id=None
            )
            workspace_id = str(workspace["workspace_id"])
            literal_path = "foo\\bar.txt"
            await service.write_file(
                workspace_id=workspace_id,
                path=literal_path,
                content="literal-backslash-needle\n",
                mode="create_only",
                line_ending="preserve",
                expected_sha256=None,
                dry_run=False,
                max_bytes=None,
            )

            search = await service.search(
                workspace_id=workspace_id,
                query="literal-backslash-needle",
                regex=False,
                case_sensitive=True,
                paths=[literal_path],
                context_lines=0,
                max_matches=10,
                max_bytes=None,
            )
            assert search["match_count"] == 1
            assert search["matches"][0]["path"] == literal_path
            assert "literal-backslash-needle" in search["matches"][0]["snippet"]

            inspected = await service.inspect(
                workspace_id=workspace_id,
                paths=[literal_path],
                queries=[],
                max_depth=2,
                max_tree_entries=20,
                context_lines=0,
                max_search_matches=10,
                max_read_files=0,
                max_file_lines=10,
                max_bytes_per_file=None,
                max_bytes=None,
            )
            assert any(item["path"] == literal_path for item in inspected["tree"])
        finally:
            await service.shutdown()

    with tempfile.TemporaryDirectory() as temp, _environment(Path(temp)):
        _run(scenario(Path(temp)))
