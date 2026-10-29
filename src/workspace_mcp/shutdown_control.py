"""Local Windows named-event control channel for a managed MCP process.

No public HTTP endpoint is exposed. The service and its launcher run under the
same Windows account; access is governed by the account's default event DACL.
"""

from __future__ import annotations

import ctypes
import os
import re
from ctypes import wintypes

_EVENT_PATTERN = re.compile(r"Local\\GitSkill-(?:MCP|Supervisor)-[a-f0-9]{32}\Z")
_EVENT_MODIFY_STATE = 0x0002
_WAIT_OBJECT_0 = 0
_WAIT_TIMEOUT = 258
_ERROR_ALREADY_EXISTS = 183


def _validate_name(name: str) -> None:
    if not isinstance(name, str) or not _EVENT_PATTERN.fullmatch(name):
        raise ValueError("Invalid local control event name.")


def _kernel32():
    if os.name != "nt":
        raise OSError("Windows control events require Windows.")
    dll = ctypes.WinDLL("kernel32", use_last_error=True)
    dll.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
    dll.CreateEventW.restype = ctypes.c_void_p
    dll.OpenEventW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
    dll.OpenEventW.restype = ctypes.c_void_p
    dll.SetEvent.argtypes = [ctypes.c_void_p]
    dll.SetEvent.restype = wintypes.BOOL
    dll.WaitForSingleObject.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    dll.WaitForSingleObject.restype = wintypes.DWORD
    dll.CloseHandle.argtypes = [ctypes.c_void_p]
    dll.CloseHandle.restype = wintypes.BOOL
    return dll


class WindowsControlEvent:
    """Own an event handle; the event is removed when the last handle closes."""

    def __init__(self, name: str) -> None:
        _validate_name(name)
        api = _kernel32()
        handle = api.CreateEventW(None, True, False, name)
        if not handle:
            raise OSError(ctypes.get_last_error(), "CreateEventW failed")
        if ctypes.get_last_error() == _ERROR_ALREADY_EXISTS:
            api.CloseHandle(handle)
            raise FileExistsError(f"Control event already exists: {name}")
        self._api = api
        self._handle = handle

    def is_set(self) -> bool:
        if self._handle is None:
            raise RuntimeError("Control event is closed.")
        result = self._api.WaitForSingleObject(self._handle, 0)
        if result == _WAIT_OBJECT_0:
            return True
        if result == _WAIT_TIMEOUT:
            return False
        raise OSError(ctypes.get_last_error(), "WaitForSingleObject failed")

    def close(self) -> None:
        if self._handle is not None:
            self._api.CloseHandle(self._handle)
            self._handle = None

    def __enter__(self) -> WindowsControlEvent:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def signal_control_event(name: str) -> bool:
    """Signal an existing event. False means the owner has not opened it yet."""
    _validate_name(name)
    api = _kernel32()
    handle = api.OpenEventW(_EVENT_MODIFY_STATE, False, name)
    if not handle:
        return False
    try:
        if not api.SetEvent(handle):
            raise OSError(ctypes.get_last_error(), "SetEvent failed")
        return True
    finally:
        api.CloseHandle(handle)
