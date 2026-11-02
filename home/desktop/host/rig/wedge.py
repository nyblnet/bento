# SPDX-License-Identifier: MIT
# Copyright (c) 2026 The Bento authors
#
# §19h wedge isolation (rig/run.sh). Drives a running host that has two
# documents open, each counting a heartbeat through the host (probe.js, wedge
# mode). Stops web processes with SIGSTOP and watches whose counter freezes:
#   * every WebKit web process is stopped ALONE, and exactly one document may
#     freeze while the other keeps counting (the mapping is learned by effect);
#   * the NEGATIVE CONTROL stops them ALL and both must freeze, which proves a
#     frozen counter is what a wedge looks like and the isolation rows are not
#     passing on a heartbeat that never depended on the web process.
# Writes <out>/wedge.json; rig/check.py asserts it. Never raises past the
# report: a driver failure is recorded as an error and fails the check.
import json, os, pathlib, signal, subprocess, sys, time

out = pathlib.Path(sys.argv[1]); hb = out / "hb"; host_pid = int(sys.argv[2])
DOCS = ["doc0", "doc1"]
res = {"error": None}


def counter(d):
    p = hb / f"{d}.hb"
    try:
        return int(p.read_text())
    except Exception:
        return 0


def web_pids():
    # WebKitWebProcess descendants of the host (comm is cut to 15 chars)
    ps = subprocess.run(["ps", "-eo", "pid=,ppid=,comm="], capture_output=True, text=True).stdout.split("\n")
    rows = [l.split(None, 2) for l in ps if l.strip()]
    kids = {}
    for pid, ppid, comm in rows:
        kids.setdefault(int(ppid), []).append((int(pid), comm))
    seen, stack, found = set(), [host_pid], []
    while stack:
        n = stack.pop()
        for pid, comm in kids.get(n, []):
            if pid in seen: continue
            seen.add(pid); stack.append(pid)
            if comm.startswith("WebKitWebProces"): found.append(pid)
    return sorted(found)


def advancing(d, secs=1.5):
    a = counter(d); time.sleep(secs); return counter(d) > a


def frozen_after(pids_stopped, settle=0.8, window=2.5):
    for pid in pids_stopped: os.kill(pid, signal.SIGSTOP)
    time.sleep(settle)
    before = {d: counter(d) for d in DOCS}
    time.sleep(window)
    after = {d: counter(d) for d in DOCS}
    return [d for d in DOCS if after[d] == before[d]]


def cont(pids):
    for pid in pids:
        try: os.kill(pid, signal.SIGCONT)
        except ProcessLookupError: pass


try:
    for _ in range(100):  # up to 40 s for both documents to be counting
        if all(counter(d) > 2 for d in DOCS): break
        time.sleep(0.4)
    res["both_counting_before"] = all(advancing(d) for d in DOCS)
    pids = web_pids(); res["web_pids"] = pids
    res["single"] = {}
    for pid in pids:
        try:
            fr = frozen_after([pid])
        finally:
            cont([pid])
        time.sleep(1.5)
        res["single"][str(pid)] = {"frozen": fr, "recovered": all(advancing(d) for d in DOCS)}
    # negative control: stop everything, both documents must freeze
    try:
        res["control_all_frozen"] = frozen_after(pids)
    finally:
        cont(pids)
    time.sleep(1.5)
    res["control_recovered"] = all(advancing(d) for d in DOCS)
    res["alive"] = os.path.exists(f"/proc/{host_pid}")
except Exception as e:
    res["error"] = repr(e)
    cont(web_pids())
(out / "wedge.json").write_text(json.dumps(res, indent=1))
