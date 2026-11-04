# SPDX-License-Identifier: MIT
# Copyright (c) 2026 The Bento authors
#
# Every place the OS's word reaches the agent, removed one at a time: each must turn
# rig/lock-rig.sh red ON ITS OWN ROW. A mutant that stays green, or goes red for
# another reason, fails this run. Needs a clean tree (it restores with git).
#   python3 rig/lock-mutants.py <out> [name...]
import pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent  # home/desktop/host
LOGIND, MAIN = ROOT / "src/logind.rs", ROOT / "src/main.rs"
AGENT, CALLS, GATE = ROOT / "../agent/src/agent.rs", ROOT / "../agent/src/calls.rs", ROOT / "../agent/src/lockgate.rs"

SUB_LOCK = 'c.signal_subscribe(Some(LOGIND), Some(SESSION), Some("Lock"), Some(&session), None, DBusSignalFlags::NONE, move |_, _, _, _, _, _| g.lock());'
M = [
    # name, file, old, new, the row that must fail
    ("watcher-never-started", MAIN, "    logind::watch(gate.clone());\n", "    let _ = logind::watch;\n", "CONTROL: the watcher reached logind"),
    ("agent-ignores-the-gate", AGENT, "Some(s) if self.gate.state() != GateState::Open(s.epoch) => {", "Some(s) if false && s.epoch == 0 => {", "Session.Lock: the next sign is refused"),
    ("no-lock-signal", LOGIND, SUB_LOCK, "let _ = g;", "Session.Lock: the next sign is refused"),
    ("no-sleep-signal", LOGIND, "if p.child_value(0).get::<bool>() != Some(false) { g.lock() }", "let _ = (&g, p);", "PrepareForSleep(true): the next sign is refused"),
    ("wake-counts-as-sleep", LOGIND, "if p.child_value(0).get::<bool>() != Some(false) { g.lock() }", "let _ = p; g.lock()", "CONTROL: PrepareForSleep(false) alone ends nothing"),
    ("no-lockedhint-signal", LOGIND, "Ok(locked) => g.set_locked(locked),", "Ok(_) => {}", "LockedHint true reaches the gate"),
    ("lockedhint-not-read-at-start", LOGIND, "gate.watched(locked);", "let _ = locked; gate.watched(false);", "started under a locked session"),
    ("signal-believed-not-logind", LOGIND, "move |c, _, _, _, _, _| {\n            match locked_hint(c, &path) {", "move |c, _, _, _, _, p| {\n            match p.child_value(1).lookup_value(\"LockedHint\", None).and_then(|v| v.get::<bool>()).ok_or(()).or_else(|_| locked_hint(c, &path).map_err(|_| ())).map_err(|_| ()) {", "a signal saying 'unlocked' is checked"),
    ("name-owner-ignored", LOGIND, "if p.child_value(2).str().unwrap_or(\"\").is_empty() { m.quit() }", "let _ = (&m, p);", "logind leaving the bus closes the gate"),
    ("session-removed-ignored", LOGIND, "if p.child_value(1).str() == Some(path.as_str()) { m.quit() }", "let _ = (&m, &path, p);", "the session going away closes the gate"),
    ("bus-closed-ignored", LOGIND, "c.connect_closed(move |_, _, _| m.quit());", "let _ = m;", "the bus dying closes the gate"),
    ("lost-leaves-it-open", LOGIND, "                gate.lost();\n", "", "logind leaving the bus closes the gate"),
    ("gate-starts-open", GATE, "Arc::new(LockGate::default())", "Arc::new(LockGate(AtomicU64::new(WATCHED)))", "no bus: the gate stays closed"),
    ("prompt-while-locked", AGENT, "GateState::Locked => Err(Refusal::Reauth),", "GateState::Locked => Ok(0),", "while locked nobody is asked"),
    ("ticket-not-held", CALLS, "if !self.agent.begin_session_from(ticket) {", "let _ = ticket; if !self.agent.begin_session() {", "a yes given across a lock opens nothing"),
]

out = sys.argv[1]
only = set(sys.argv[2:])
if subprocess.run(["git", "diff", "--quiet"], cwd=ROOT).returncode:
    sys.exit("lock-mutants: the tree is not clean, and this restores with git")
bad = []
for name, path, old, new, row in M:
    if only and name not in only:
        continue
    src = path.read_text()
    assert src.count(old) == 1, f"{name}: the line to mutate moved ({src.count(old)} matches)"
    path.write_text(src.replace(old, new))
    try:
        r = subprocess.run(["./rig/lock-rig.sh", f"{out}/{name}"], cwd=ROOT, capture_output=True, text=True, timeout=600)
    finally:
        subprocess.run(["git", "checkout", "--", str(path)], cwd=ROOT, check=True)
    text = r.stdout + r.stderr
    fails = [l for l in text.splitlines() if l.startswith("FAIL")]
    hit = any(row in l for l in fails)
    built = (pathlib.Path(out) / name / "lock.exit").exists()
    if r.returncode != 0 and hit and built:
        print(f"red   {name}: {len(fails)} rows, including \"{row}\"", flush=True)
    else:
        bad.append(name)
        print(f"WRONG {name}: exit {r.returncode}, built {built}, own row hit {hit}\n" + text[-1500:], flush=True)
print(f"\n{len(M) if not only else len(only)} mutants, {len(bad)} wrong")
sys.exit(1 if bad else 0)
