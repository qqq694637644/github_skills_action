"""Service supervisor and cooperative Windows shutdown regression tests.

All tests use temporary files/processes; they never stop the real MCP server.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import queue
import subprocess
import sys
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
import uvicorn
from starlette.applications import Starlette

from workspace_mcp.server import _serve_with_shutdown_event
from workspace_mcp.shutdown_control import WindowsControlEvent, signal_control_event
from workspace_mcp.workspace_operations import OperationSettings, WorkspaceOperationManager
from workspace_mcp.workspace_patch import WorkspaceToolError

pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows lifecycle test")


def _manager_module():
    path = Path(__file__).resolve().parents[1] / "scripts" / "windows_service_manager.py"
    if not path.exists():
        pytest.skip("Repository service manager is not installed yet")
    name = "git_skill_manager_for_tests"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    import sys as _sys

    module = importlib.util.module_from_spec(spec)
    _sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_private_shutdown_event_signals_and_closes() -> None:
    name = rf"Local\GitSkill-MCP-{uuid.uuid4().hex}"
    assert signal_control_event(name) is False
    with WindowsControlEvent(name) as event:
        assert not event.is_set()
        assert signal_control_event(name)
        assert event.is_set()
    assert signal_control_event(name) is False


def test_uvicorn_watcher_sets_should_exit_without_public_http_endpoint() -> None:
    class FakeUvicorn:
        should_exit = False

        async def serve(self):
            while not self.should_exit:
                await asyncio.sleep(0.01)

    async def exercise():
        name = rf"Local\GitSkill-MCP-{uuid.uuid4().hex}"
        with WindowsControlEvent(name) as event:
            server = FakeUvicorn()
            worker = asyncio.create_task(_serve_with_shutdown_event(server, event))
            await asyncio.sleep(0.15)
            assert signal_control_event(name)
            await asyncio.wait_for(worker, timeout=3)
            assert server.should_exit

    asyncio.run(exercise())


def test_real_uvicorn_lifespan_runs_on_private_event() -> None:
    """Bind only a temporary loopback socket; no production endpoints touched."""
    lifecycle: list[str] = []

    @asynccontextmanager
    async def lifespan(_: Starlette):
        lifecycle.append("started")
        try:
            yield
        finally:
            lifecycle.append("stopped")

    async def exercise() -> None:
        app = Starlette(lifespan=lifespan)
        server = uvicorn.Server(
            uvicorn.Config(app, host="127.0.0.1", port=0, log_level="critical")
        )
        name = rf"Local\GitSkill-MCP-{uuid.uuid4().hex}"
        with WindowsControlEvent(name) as event:
            task = asyncio.create_task(_serve_with_shutdown_event(server, event))
            for _ in range(100):
                if server.started:
                    break
                await asyncio.sleep(0.02)
            assert server.started, "Temporary Uvicorn app did not start"
            assert signal_control_event(name)
            await asyncio.wait_for(task, timeout=5)
        assert lifecycle == ["started", "stopped"]

    asyncio.run(exercise())


def test_shutdown_closes_admission_gate_before_any_command_starts(tmp_path: Path) -> None:
    async def exercise():
        manager = WorkspaceOperationManager(OperationSettings(root=tmp_path / "operations"))
        await manager.shutdown()
        with pytest.raises(WorkspaceToolError, match="shutting down"):
            await manager.start(
                workspace_id="ws_0123456789abcdef",
                workspace_root=tmp_path,
                idempotency_key="test-shutdown",
                script="Write-Output 'should not run'",
                timeout_seconds=1,
                max_output_bytes=None,
                plain_output=False,
                utf8_output=True,
            )

    asyncio.run(exercise())


def test_python_supervisor_refuses_to_kill_legacy_processes(tmp_path: Path, monkeypatch) -> None:
    manager = _manager_module()
    state = tmp_path / "services.json"
    state.write_text(json.dumps([{"Name": "MCP", "Pid": 999999, "Path": "python.exe"}]))
    monkeypatch.setattr(manager, "STATE", state)
    assert manager.stop_stack_remotely() == 2
    assert state.exists()


def test_failed_cleanup_is_reported_instead_of_discarding_process_state(
    monkeypatch,
) -> None:
    manager = _manager_module()
    monkeypatch.setattr(manager, "stop_service", lambda entry: None)
    monkeypatch.setattr(manager, "tracked_entry_alive", lambda entry: True)
    assert manager.stop_stack([{"name": "TEST"}], queue.Queue()) is False


def test_windows_job_closes_all_descendants_after_launcher_exit(tmp_path: Path) -> None:
    manager = _manager_module()
    gate = tmp_path / "ready.flag"
    child_pid_file = tmp_path / "child.pid"
    python = sys.executable
    child_code = (
        "import subprocess,sys,time;"
        "from pathlib import Path;"
        f"gate=Path({str(gate)!r});"
        f"out=Path({str(child_pid_file)!r});"
        "deadline=time.monotonic()+8;"
        "\nwhile not gate.exists() and time.monotonic()<deadline: time.sleep(.02)\n"
        "assert gate.exists();"
        "child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(45)'],"
        "creationflags=0x08000000);"
        "out.write_text(str(child.pid));"
        "time.sleep(45)"
    )
    job = manager.WindowsJob(rf"Local\GitSkillService-{uuid.uuid4().hex}-TEST")
    process = None
    child_pid = None
    try:
        process = subprocess.Popen(
            [python, "-c", child_code],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=manager.CREATE_NO_WINDOW,
        )
        job.assign(process.pid)
        gate.touch()
        until = time.monotonic() + 8
        while not child_pid_file.exists() and time.monotonic() < until:
            time.sleep(0.05)
        assert child_pid_file.exists(), "The test child did not start"
        child_pid = int(child_pid_file.read_text())
        assert manager.process_info(child_pid) is not None
        job.close()
        process.wait(timeout=5)
        until = time.monotonic() + 3
        while manager.process_info(child_pid) is not None and time.monotonic() < until:
            time.sleep(0.05)
        assert manager.process_info(child_pid) is None, "A descendant escaped the Job Object"
    finally:
        job.close()
        if process and process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        if child_pid is not None and manager.process_info(child_pid) is not None:
            # Explicitly clean test-owned process only, not an unrelated service.
            subprocess.run(
                ["taskkill", "/PID", str(child_pid), "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
            )
