"""Windows service supervisor for FRPC, Caddy and Workspace MCP.

Run via git_skill/manage.py. Starts services behind a job-assigned Python
launcher gate, so even a fast child (including the venv Python redirector)
cannot escape its service's kill-on-close Job Object.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from ctypes import wintypes
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REPO = ROOT / "github_skills_action"
sys.path.insert(0, str(REPO / "src"))
from workspace_mcp.shutdown_control import WindowsControlEvent, signal_control_event  # noqa: E402

STATE = ROOT / "services.json"
RUNTIME = ROOT / ".service-runtime"
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
CREATE_NEW_PROCESS_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)


@dataclass(frozen=True)
class Service:
    name: str
    directory: Path
    exe: Path
    args: tuple[str, ...]
    env: dict[str, str]


PROXY_ENV = {
    "HTTP_PROXY": "http://127.0.0.1:10810",
    "HTTPS_PROXY": "http://127.0.0.1:10810",
    "NO_PROXY": "localhost,127.0.0.1,::1",
}
SERVICES = (
    Service(
        "FRPC",
        Path(r"C:\frp"),
        Path(r"C:\frp\frpc.exe"),
        ("-c", str(ROOT / "走代理反向代理.toml")),
        {},
    ),
    Service(
        "CADDY",
        ROOT / "caddy",
        ROOT / "caddy" / "caddy.exe",
        ("run", "--config", "Caddyfile", "--adapter", "caddyfile"),
        PROXY_ENV,
    ),
    Service(
        "MCP",
        REPO,
        REPO / ".venv" / "Scripts" / "python.exe",
        ("-u", "-c", "from workspace_mcp.server import main; main()"),
        PROXY_ENV,
    ),
)
BY_NAME = {service.name: service for service in SERVICES}


class FILETIME(ctypes.Structure):
    _fields_ = [("low", wintypes.DWORD), ("high", wintypes.DWORD)]


class JobBasicLimit(ctypes.Structure):
    _fields_ = [
        ("per_process_user_time_limit", ctypes.c_longlong),
        ("per_job_user_time_limit", ctypes.c_longlong),
        ("limit_flags", wintypes.DWORD),
        ("minimum_working_set_size", ctypes.c_size_t),
        ("maximum_working_set_size", ctypes.c_size_t),
        ("active_process_limit", wintypes.DWORD),
        ("affinity", ctypes.c_size_t),
        ("priority_class", wintypes.DWORD),
        ("scheduling_class", wintypes.DWORD),
    ]


class IoCounters(ctypes.Structure):
    _fields_ = [
        (name, ctypes.c_ulonglong)
        for name in (
            "read_ops",
            "write_ops",
            "other_ops",
            "read_bytes",
            "write_bytes",
            "other_bytes",
        )
    ]


class JobExtendedLimit(ctypes.Structure):
    _fields_ = [
        ("basic", JobBasicLimit),
        ("io", IoCounters),
        ("process_memory_limit", ctypes.c_size_t),
        ("job_memory_limit", ctypes.c_size_t),
        ("peak_process_memory_used", ctypes.c_size_t),
        ("peak_job_memory_used", ctypes.c_size_t),
    ]


def _kernel32():
    if os.name != "nt":
        raise RuntimeError("The service supervisor requires Windows.")
    dll = ctypes.WinDLL("kernel32", use_last_error=True)
    dll.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    dll.OpenProcess.restype = ctypes.c_void_p
    dll.QueryFullProcessImageNameW.argtypes = [
        ctypes.c_void_p,
        wintypes.DWORD,
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.DWORD),
    ]
    dll.QueryFullProcessImageNameW.restype = wintypes.BOOL
    dll.GetProcessTimes.argtypes = [ctypes.c_void_p] + [ctypes.POINTER(FILETIME)] * 4
    dll.GetProcessTimes.restype = wintypes.BOOL
    dll.CloseHandle.argtypes = [ctypes.c_void_p]
    dll.CloseHandle.restype = wintypes.BOOL
    dll.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    dll.CreateJobObjectW.restype = ctypes.c_void_p
    dll.OpenJobObjectW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
    dll.OpenJobObjectW.restype = ctypes.c_void_p
    dll.SetInformationJobObject.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    ]
    dll.SetInformationJobObject.restype = wintypes.BOOL
    dll.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    dll.AssignProcessToJobObject.restype = wintypes.BOOL
    dll.TerminateJobObject.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    dll.TerminateJobObject.restype = wintypes.BOOL
    return dll


API = _kernel32() if os.name == "nt" else None


def process_info(pid: int) -> dict[str, object] | None:
    """Return exact image path and creation FILETIME, or None for a dead PID."""
    assert API is not None
    if not isinstance(pid, int) or pid <= 0:
        return None
    handle = API.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return None
    try:
        size = wintypes.DWORD(32768)
        path = ctypes.create_unicode_buffer(size.value)
        if not API.QueryFullProcessImageNameW(handle, 0, path, ctypes.byref(size)):
            return None
        created, exited, kernel, user = FILETIME(), FILETIME(), FILETIME(), FILETIME()
        if not API.GetProcessTimes(
            handle,
            ctypes.byref(created),
            ctypes.byref(exited),
            ctypes.byref(kernel),
            ctypes.byref(user),
        ):
            return None
        return {
            "path": path.value,
            "created": (created.high << 32) | created.low,
        }
    finally:
        API.CloseHandle(handle)


def same_process(pid: int, path: str, created: int | None) -> bool:
    data = process_info(pid)
    if data is None:
        return False
    expected = os.path.normcase(os.path.normpath(path))
    actual = os.path.normcase(os.path.normpath(str(data["path"])))
    return actual == expected and (created is None or data["created"] == created)


class WindowsJob:
    """Named job survives a second stop.py process; kill-on-last-close on crashes."""

    def __init__(self, name: str):
        assert API is not None
        self.name = name
        self.handle = API.CreateJobObjectW(None, name)
        if not self.handle:
            raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")
        limits = JobExtendedLimit()
        limits.basic.limit_flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not API.SetInformationJobObject(
            self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)
        ):
            code = ctypes.get_last_error()
            self.close()
            raise OSError(code, "SetInformationJobObject failed")

    def assign(self, pid: int) -> None:
        assert API is not None
        handle = API.OpenProcess(0x0100 | 0x0001 | 0x0400, False, pid)
        if not handle:
            raise OSError(ctypes.get_last_error(), "OpenProcess for job assignment failed")
        try:
            if not API.AssignProcessToJobObject(self.handle, handle):
                raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject failed")
        finally:
            API.CloseHandle(handle)

    def terminate(self) -> None:
        assert API is not None
        if self.handle and not API.TerminateJobObject(self.handle, 1):
            raise OSError(ctypes.get_last_error(), "TerminateJobObject failed")

    def close(self) -> None:
        if self.handle:
            assert API is not None
            API.CloseHandle(self.handle)
            self.handle = None


def terminate_named_job(name: str) -> bool:
    """Last-resort fallback when the supervisor no longer answers."""
    assert API is not None
    handle = API.OpenJobObjectW(0x0008, False, name)  # JOB_OBJECT_TERMINATE
    if not handle:
        return False
    try:
        if not API.TerminateJobObject(handle, 1):
            raise OSError(ctypes.get_last_error(), "TerminateJobObject failed")
        return True
    finally:
        API.CloseHandle(handle)


def read_state() -> dict | list | None:
    if not STATE.exists():
        return None
    return json.loads(STATE.read_text(encoding="utf-8-sig"))


def atomic_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + f".{uuid.uuid4().hex}.tmp")
    try:
        temp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def child_info(entry: dict) -> dict | None:
    path = entry.get("info_file")
    if not path:
        return None
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (FileNotFoundError, ValueError, OSError):
        return None


def _child_alive(entry: dict) -> bool:
    info = child_info(entry)
    return bool(info and same_process(info.get("pid"), info.get("path", ""), info.get("created")))


def _live_legacy(state: list) -> list:
    return [
        entry
        for entry in state
        if isinstance(entry, dict) and same_process(entry.get("Pid"), entry.get("Path", ""), None)
    ]


def show_status() -> int:
    state = read_state()
    if state is None:
        print("No tracked services.")
        return 0
    if isinstance(state, list):
        print("Legacy PowerShell supervisor detected (no cooperative shutdown control).")
        for item in state:
            if not isinstance(item, dict):
                continue
            alive = same_process(item.get("Pid"), item.get("Path", ""), None)
            print(f"[{item.get('Name')}] {'RUNNING' if alive else 'STOPPED'} PID={item.get('Pid')}")
        return 0
    if state.get("version") != 2:
        print("Unknown services.json version; refusing to guess.")
        return 1
    manager = same_process(
        state.get("manager_pid"), state.get("manager_path", ""), state.get("manager_created")
    )
    print(f"Supervisor: {'RUNNING' if manager else 'STOPPED'} PID={state.get('manager_pid')}")
    for entry in state.get("services", []):
        launcher = same_process(
            entry.get("launcher_pid"), entry.get("launcher_path", ""), entry.get("launcher_created")
        )
        info = child_info(entry)
        print(
            f"[{entry['name']}] {'RUNNING' if launcher and _child_alive(entry) else 'STOPPED'}"
            f" launcher={entry['launcher_pid']} child={info.get('pid') if info else '?'}"
        )
    return 0


def launch_child(name: str, gate: Path, info_path: Path) -> int:
    """Wait for job assignment before launching a single service."""
    if name not in BY_NAME:
        return 2
    service = BY_NAME[name]
    deadline = time.monotonic() + 12
    while not gate.exists():
        if time.monotonic() >= deadline:
            print(f"[{name}] launcher timed out waiting for job assignment", file=sys.stderr)
            return 2
        time.sleep(0.025)
    gate.unlink(missing_ok=True)
    env = os.environ.copy()
    env.update(service.env)
    if not service.exe.is_file():
        print(f"[{name}] Missing executable: {service.exe}", file=sys.stderr)
        return 2
    process = subprocess.Popen(
        [str(service.exe), *service.args],
        cwd=service.directory,
        env=env,
        stdin=subprocess.DEVNULL,
        creationflags=CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP,
    )
    data = process_info(process.pid)
    atomic_json(
        info_path,
        {
            "pid": process.pid,
            "path": str(service.exe),
            "created": data["created"] if data else None,
        },
    )
    return process.wait()


def log_pipe(name: str, stream: str, pipe, events: queue.Queue) -> None:
    if pipe is None:
        return
    try:
        for raw in iter(pipe.readline, b""):
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            try:
                events.put_nowait(f"[{name}][{stream}] {line}")
            except queue.Full:
                pass
    finally:
        pipe.close()


def flush_logs(events: queue.Queue) -> None:
    for _ in range(200):
        try:
            print(events.get_nowait(), flush=True)
        except queue.Empty:
            return


def keyboard_q() -> bool:
    try:
        import msvcrt

        return msvcrt.kbhit() and msvcrt.getwch().lower() == "q"
    except (ImportError, OSError):
        return False


def wait_launcher(entry: dict, seconds: float) -> bool:
    process = entry["process"]
    try:
        process.wait(timeout=seconds)
        return True
    except subprocess.TimeoutExpired:
        return False


def signal_mcp(name: str, seconds: float = 3) -> bool:
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if signal_control_event(name):
            return True
        time.sleep(0.1)
    return False


def stop_service(entry: dict) -> None:
    name = entry["name"]
    process = entry["process"]
    job: WindowsJob = entry["job"]
    print(f"[{name}] requesting shutdown", flush=True)
    try:
        if name == "MCP":
            event_name = entry["mcp_event"]
            if signal_mcp(event_name):
                print("[MCP] shutdown notification delivered", flush=True)
            else:
                print("[MCP] shutdown event unavailable; using job fallback", flush=True)
            wait_seconds = 24
        elif name == "CADDY":
            service = BY_NAME[name]
            try:
                result = subprocess.run(
                    [str(service.exe), "stop"],
                    cwd=service.directory,
                    env={**os.environ, **service.env},
                    capture_output=True,
                    timeout=5,
                    check=False,
                    creationflags=CREATE_NO_WINDOW,
                )
                if result.returncode != 0:
                    print("[CADDY] admin stop unavailable; using fallback if needed")
            except (OSError, subprocess.TimeoutExpired) as exc:
                print(f"[CADDY] admin stop failed: {type(exc).__name__}")
            wait_seconds = 4
        else:
            # FRPC does not expose the MCP control channel. Best-effort
            # console break, then the supervised Job Object.
            info = child_info(entry)
            if info and _child_alive(entry):
                try:
                    os.kill(info["pid"], signal.CTRL_BREAK_EVENT)
                except (OSError, ValueError, AttributeError):
                    pass
            wait_seconds = 3
        if not wait_launcher(entry, wait_seconds):
            print(f"[{name}] grace period exceeded; terminating its Job Object", flush=True)
            job.terminate()
            wait_launcher(entry, 3)
    finally:
        # Job close also removes descendants after launcher/parent exit.
        job.close()
        if process.poll() is None:
            wait_launcher(entry, 3)
        for pipe_name in ("stdout", "stderr"):
            pipe = getattr(process, pipe_name)
            if pipe:
                pipe.close()


def tracked_entry_alive(entry: dict) -> bool:
    return _child_alive(entry) or same_process(
        entry.get("launcher_pid"),
        entry.get("launcher_path", ""),
        entry.get("launcher_created"),
    )


def stop_stack(started: list[dict], events: queue.Queue) -> bool:
    errors = []
    for entry in reversed(started):
        try:
            stop_service(entry)
        except Exception as exc:
            errors.append(f"{entry['name']}: {exc}")
            try:
                entry["job"].terminate()
            except Exception:
                pass
            entry["job"].close()
        flush_logs(events)
    for entry in started:
        if tracked_entry_alive(entry):
            errors.append(f"{entry['name']}: tracked process still running after cleanup")
    if errors:
        print("Shutdown errors: " + "; ".join(errors), file=sys.stderr)
    return not errors


def start_stack() -> int:
    existing = read_state()
    if isinstance(existing, list) and _live_legacy(existing):
        print("Legacy supervisor still running. Stop the original PowerShell session first.")
        return 2
    if isinstance(existing, dict) and existing.get("version") == 2:
        if same_process(
            existing.get("manager_pid"),
            existing.get("manager_path", ""),
            existing.get("manager_created"),
        ):
            print("Services already managed by a running Python supervisor.")
            return 2
        if any(_child_alive(entry) for entry in existing.get("services", [])):
            print("Untracked live service found; refusing to overwrite its state.")
            return 2
    if existing is not None:
        STATE.unlink(missing_ok=True)

    run_id = uuid.uuid4().hex
    run_dir = RUNTIME / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    supervisor_event = rf"Local\GitSkill-Supervisor-{run_id}"
    mcp_event = rf"Local\GitSkill-MCP-{uuid.uuid4().hex}"
    events: queue.Queue[str] = queue.Queue(maxsize=10000)
    started: list[dict] = []
    owner = process_info(os.getpid())
    state: dict = {
        "version": 2,
        "manager_pid": os.getpid(),
        "manager_path": str(Path(sys.executable).resolve()),
        "manager_created": owner["created"] if owner else None,
        "stop_event": supervisor_event,
        "services": [],
    }
    try:
        with WindowsControlEvent(supervisor_event) as stop_event:
            for service in SERVICES:
                if not service.exe.is_file():
                    raise FileNotFoundError(f"Missing executable: {service.exe}")
                gate = run_dir / f"{service.name}.ready"
                info_path = run_dir / f"{service.name}.json"
                job = WindowsJob(rf"Local\GitSkillService-{run_id}-{service.name}")
                try:
                    env = os.environ.copy()
                    if service.name == "MCP":
                        env["WORKSPACE_MCP_SHUTDOWN_EVENT"] = mcp_event
                    process = subprocess.Popen(
                        [
                            sys.executable,
                            "-u",
                            str(Path(__file__).resolve()),
                            "_launch",
                            service.name,
                            str(gate),
                            str(info_path),
                        ],
                        cwd=ROOT,
                        env=env,
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        creationflags=CREATE_NO_WINDOW,
                    )
                    job.assign(process.pid)
                except Exception:
                    job.close()
                    raise
                identity = process_info(process.pid)
                entry = {
                    "name": service.name,
                    "launcher_pid": process.pid,
                    "launcher_path": str(Path(sys.executable).resolve()),
                    "launcher_created": identity["created"] if identity else None,
                    "info_file": str(info_path),
                    "job_name": job.name,
                    "mcp_event": mcp_event if service.name == "MCP" else None,
                    "process": process,
                    "job": job,
                }
                started.append(entry)
                state["services"].append(
                    {k: v for k, v in entry.items() if k not in ("process", "job")}
                )
                atomic_json(STATE, state)
                for key in ("stdout", "stderr"):
                    threading.Thread(
                        target=log_pipe,
                        args=(service.name, key, getattr(process, key), events),
                        daemon=True,
                    ).start()
                gate.touch()
                until = time.monotonic() + 8
                while time.monotonic() < until and not info_path.exists():
                    if process.poll() is not None:
                        raise RuntimeError(f"{service.name} failed during startup")
                    flush_logs(events)
                    time.sleep(0.05)
                if not info_path.exists():
                    raise TimeoutError(f"{service.name} did not report its PID")
                print(f"[{service.name}] launched; wrapper PID={process.pid}", flush=True)
            print("Running. Press Q or Ctrl+C to request orderly shutdown.", flush=True)
            while True:
                flush_logs(events)
                if stop_event.is_set() or keyboard_q():
                    break
                if any(entry["process"].poll() is not None for entry in started):
                    print("A service exited; shutting down the remaining stack.")
                    break
                time.sleep(0.1)
        return 0
    except KeyboardInterrupt:
        print("Console interruption received.")
        return 0
    except Exception as exc:
        print(f"Supervisor failed: {exc}", file=sys.stderr, flush=True)
        return 1
    finally:
        cleaned = stop_stack(started, events)
        flush_logs(events)
        if cleaned:
            STATE.unlink(missing_ok=True)
            shutil.rmtree(run_dir, ignore_errors=True)
        else:
            # Never discard the evidence if a process may still be alive.
            print(
                "Cleanup incomplete; retaining services.json for diagnosis.",
                file=sys.stderr,
            )
            raise RuntimeError("Service shutdown left tracked processes running.")


def stop_stack_remotely() -> int:
    state = read_state()
    if state is None:
        print("No tracked services.")
        return 0
    if isinstance(state, list):
        print(
            "Legacy PowerShell instance detected. New cooperative shutdown requires a "
            "Python-managed instance; stop the original session once before migration.",
            file=sys.stderr,
        )
        return 2
    if state.get("version") != 2:
        print("Unknown services.json format, refusing unsafe stop.", file=sys.stderr)
        return 2
    manager_alive = same_process(
        state.get("manager_pid"),
        state.get("manager_path", ""),
        state.get("manager_created"),
    )
    event_name = state.get("stop_event")
    if manager_alive and event_name:
        if signal_mcp(event_name):
            print("Stop notification sent to supervisor.")
            until = time.monotonic() + 55
            while time.monotonic() < until:
                if not same_process(
                    state.get("manager_pid"),
                    state.get("manager_path", ""),
                    state.get("manager_created"),
                ):
                    if STATE.exists():
                        print(
                            "Supervisor exited but retained services.json; "
                            "check cleanup errors.",
                            file=sys.stderr,
                        )
                        return 1
                    print("Supervisor exited cleanly.")
                    return 0
                time.sleep(0.2)
        print("Supervisor did not exit within grace period; checking jobs.", file=sys.stderr)
    for entry in reversed(state.get("services", [])):
        if tracked_entry_alive(entry):
            job_name = entry.get("job_name")
            if not job_name or not terminate_named_job(job_name):
                print(f"[{entry.get('name')}] could not terminate tracked job.", file=sys.stderr)
                return 1
    return 0 if not any(tracked_entry_alive(e) for e in state.get("services", [])) else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("run", "status", "stop", "_launch"))
    parser.add_argument("details", nargs="*")
    arguments = parser.parse_args()
    if arguments.action == "_launch":
        if len(arguments.details) != 3:
            parser.error("_launch requires name, gate path and info path")
        return launch_child(
            arguments.details[0], Path(arguments.details[1]), Path(arguments.details[2])
        )
    if arguments.details:
        parser.error("Unexpected extra arguments")
    if arguments.action == "run":
        return start_stack()
    if arguments.action == "status":
        return show_status()
    return stop_stack_remotely()


if __name__ == "__main__":
    sys.exit(main())
