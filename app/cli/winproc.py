# -*- coding: utf-8 -*-
"""Windows process inspection with plain ctypes (no pywin32, no psutil).

Importable on every OS: nothing touches ctypes.windll at import time. Every public function
raises RuntimeError when called off Windows; callers go through dplatform, which only calls in
here when dplatform.IS_WIN is set.
"""
import json
import os
import subprocess
import time

TH32CS_SNAPPROCESS = 0x00000002
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
STILL_ACTIVE = 259
ERROR_ACCESS_DENIED = 5
CREATE_NO_WINDOW = 0x08000000
SW_RESTORE = 9
INVALID_HANDLE_VALUE = -1

_CMDLINE_TTL = 2.0
_cmdline_cache = {"at": 0.0, "rows": None}

_api = None


def _need_windows():
    if os.name != "nt":
        raise RuntimeError("winproc is only available on Windows")


def _k32():
    """Lazily bind the kernel32 / user32 functions with explicit signatures (64-bit handles)."""
    global _api
    if _api is not None:
        return _api
    _need_windows()
    import ctypes
    from ctypes import wintypes

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * 260),
        ]

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    u32 = ctypes.WinDLL("user32", use_last_error=True)
    k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    k32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    k32.Process32FirstW.restype = wintypes.BOOL
    k32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    k32.Process32NextW.restype = wintypes.BOOL
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    k32.CloseHandle.restype = wintypes.BOOL
    k32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    k32.GetExitCodeProcess.restype = wintypes.BOOL
    k32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    k32.QueryFullProcessImageNameW.restype = wintypes.BOOL
    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    u32.EnumWindows.argtypes = [WNDENUMPROC, wintypes.LPARAM]
    u32.EnumWindows.restype = wintypes.BOOL
    u32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    u32.GetWindowThreadProcessId.restype = wintypes.DWORD
    u32.IsWindowVisible.argtypes = [wintypes.HWND]
    u32.IsWindowVisible.restype = wintypes.BOOL
    u32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    u32.ShowWindow.restype = wintypes.BOOL
    u32.SetForegroundWindow.argtypes = [wintypes.HWND]
    u32.SetForegroundWindow.restype = wintypes.BOOL
    _api = {"ctypes": ctypes, "wt": wintypes, "k32": k32, "u32": u32, "PE": PROCESSENTRY32W, "ENUM": WNDENUMPROC}
    return _api


def snapshot():
    """[(pid, ppid, exe_name)] for every process, from CreateToolhelp32Snapshot."""
    a = _k32()
    ctypes, k32 = a["ctypes"], a["k32"]
    h = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not h or h == ctypes.c_void_p(INVALID_HANDLE_VALUE).value:
        return []
    out = []
    try:
        e = a["PE"]()
        e.dwSize = ctypes.sizeof(e)
        ok = k32.Process32FirstW(h, ctypes.byref(e))
        while ok:
            out.append((int(e.th32ProcessID), int(e.th32ParentProcessID), e.szExeFile))
            ok = k32.Process32NextW(h, ctypes.byref(e))
    finally:
        k32.CloseHandle(h)
    return out


def image_path(pid):
    """Full path of process `pid`'s executable, or None when it is gone or not readable."""
    a = _k32()
    ctypes, k32, wt = a["ctypes"], a["k32"], a["wt"]
    h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not h:
        return None
    try:
        size = wt.DWORD(32768)
        buf = ctypes.create_unicode_buffer(size.value)
        if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value
        return None
    finally:
        k32.CloseHandle(h)


def pid_alive(pid):
    """True while process `pid` exists (an access-denied process still counts as alive)."""
    a = _k32()
    ctypes, k32, wt = a["ctypes"], a["k32"], a["wt"]
    h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not h:
        err = ctypes.get_last_error()
        if err == ERROR_ACCESS_DENIED:
            return True
        return False
    try:
        code = wt.DWORD(0)
        if not k32.GetExitCodeProcess(h, ctypes.byref(code)):
            return True
        return code.value == STILL_ACTIVE
    finally:
        k32.CloseHandle(h)


_PS_CMD = ("Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine"
           " | ConvertTo-Json -Compress")


def parse_cim_json(text):
    """Parse the ConvertTo-Json output of _PS_CMD into {pid: {"ppid", "exe", "cmdline"}}.
    PowerShell emits a bare object instead of a list when there is a single process."""
    text = (text or "").strip().lstrip("﻿")
    if not text:
        return {}
    data = json.loads(text)
    if isinstance(data, dict):
        data = [data]
    out = {}
    for row in data or []:
        if not isinstance(row, dict):
            continue
        try:
            pid = int(row.get("ProcessId"))
        except (TypeError, ValueError):
            continue
        try:
            ppid = int(row.get("ParentProcessId") or 0)
        except (TypeError, ValueError):
            ppid = 0
        out[pid] = {"ppid": ppid, "exe": row.get("ExecutablePath") or "", "cmdline": row.get("CommandLine") or ""}
    return out


def cmdlines():
    """{pid: {"ppid", "exe", "cmdline"}} for every process via PowerShell Get-CimInstance, cached
    for 2 s (one PowerShell start costs a few hundred ms)."""
    _need_windows()
    now = time.monotonic()
    if _cmdline_cache["rows"] is not None and now - _cmdline_cache["at"] < _CMDLINE_TTL:
        return _cmdline_cache["rows"]
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
                            "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " + _PS_CMD],
                           capture_output=True, timeout=30, creationflags=CREATE_NO_WINDOW)
        rows = parse_cim_json(r.stdout.decode("utf-8", "replace"))
    except Exception:
        rows = {}
    _cmdline_cache.update(at=now, rows=rows)
    return rows


def bring_to_front(pid):
    """Restore and focus the first visible top-level window owned by `pid`. False when none was found
    or Windows refused the focus change."""
    a = _k32()
    ctypes, u32, wt = a["ctypes"], a["u32"], a["wt"]
    found = []

    def cb(hwnd, _):
        owner = wt.DWORD(0)
        u32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == int(pid) and u32.IsWindowVisible(hwnd):
            found.append(hwnd)
            return False
        return True

    try:
        u32.EnumWindows(a["ENUM"](cb), 0)
        if not found:
            return False
        u32.ShowWindow(found[0], SW_RESTORE)
        return bool(u32.SetForegroundWindow(found[0]))
    except Exception:
        return False
