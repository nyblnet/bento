# SPDX-License-Identifier: MIT
# Copyright (c) 2026 The Bento authors
#
# WINDOWS ONLY helper for rig/run.sh and rig/wedge.py: the WebView2 renderer
# processes under the host (the counterpart of Linux's WebKitWebProcess), and
# suspend/resume of one process (NtSuspendProcess, the counterpart of
# SIGSTOP/SIGCONT).
#   webprocs.py count   -> prints the number of renderer processes under the host
#   webprocs.py list    -> prints their PIDs
import ctypes, json, subprocess, sys

HOST = "bento-home-desktop.exe"


def _procs():
    ps = ("Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress")
    out = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], capture_output=True, text=True).stdout
    rows = json.loads(out or "[]")
    return rows if isinstance(rows, list) else [rows]


def host_pids(rows=None):
    return [r["ProcessId"] for r in (rows or _procs()) if (r.get("Name") or "").lower() == HOST]


def renderers():
    """PIDs of msedgewebview2 renderer processes descended from the host."""
    rows = _procs()
    kids = {}
    for r in rows:
        kids.setdefault(r["ParentProcessId"], []).append(r)
    seen, stack, found = set(), host_pids(rows), []
    while stack:
        n = stack.pop()
        for r in kids.get(n, []):
            if r["ProcessId"] in seen: continue
            seen.add(r["ProcessId"]); stack.append(r["ProcessId"])
            if (r.get("Name") or "").lower() == "msedgewebview2.exe" and "--type=renderer" in (r.get("CommandLine") or ""):
                found.append(r["ProcessId"])
    return sorted(found)


def _handle(pid):
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.restype = ctypes.c_void_p
    h = k32.OpenProcess(0x0800, False, pid)  # PROCESS_SUSPEND_RESUME
    if not h: raise ProcessLookupError(pid)
    return k32, h


def _nt(fn, pid):
    k32, h = _handle(pid)
    try:
        st = getattr(ctypes.WinDLL("ntdll"), fn)(ctypes.c_void_p(h))
        if st != 0: raise OSError(f"{fn}({pid}) NTSTATUS {st:#x}")
    finally:
        k32.CloseHandle(ctypes.c_void_p(h))


def suspend(pid): _nt("NtSuspendProcess", pid)
def resume(pid): _nt("NtResumeProcess", pid)
def host_alive(): return bool(host_pids())


if __name__ == "__main__":
    pids = renderers()
    print(len(pids) if sys.argv[1] == "count" else " ".join(map(str, pids)))
