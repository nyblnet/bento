# SPDX-License-Identifier: MIT
# Copyright (c) 2026 The Bento authors
#
# Asserts rig/lock-rig.sh's reports. A missing report or an unexpected value FAILS.
import json, pathlib, sys

out = pathlib.Path(sys.argv[1])
fails, oks = [], []


def ok(cond, what):
    (oks if cond else fails).append(what)


def rep(name):
    p = out / f"{name}.json"
    if not p.exists():
        fails.append(f"{name}: NO REPORT (a timeout is a failure)")
        return {}
    k = json.loads(p.read_text())["page"].get("lock", {})
    ok(not k.get("error"), f"{name}: the probe ran clean ({k.get('error')})")
    ok(k.get("present") is True, f"{name}: the genuine document has the agent ({k.get('present')})")
    return k


def row(k, field, want, what):
    ok(k.get(field) == want, f"{what} ({field}={k.get(field)!r})")


def opened(k, field, what):
    ok(str(k.get(field)).startswith("Open"), f"{what} ({field}={k.get(field)!r})")


K = rep("lock")
L = (out / "lock.log").read_text(errors="replace") if (out / "lock.log").exists() else ""
opened(K, "gate0", "CONTROL: the watcher reached logind and the gate opened")
ok("LOGIND watching /org/freedesktop/login1/session/_31" in L, "the watcher followed session/auto to the session's real path")
row(K, "begin0", True, "CONTROL: a session opens while unlocked")
row(K, "control", "ok", "CONTROL: it signs")
row(K, "control_again", "ok", "CONTROL: and keeps signing, nothing having happened")
row(K, "after_lock", "reauth", "Session.Lock: the next sign is refused 'reauth'")
row(K, "after_unlock", "reauth", "Session.Unlock gives nothing back")
row(K, "begin1", True, "the person re-authenticates after a lock")
row(K, "sleep_control", "ok", "CONTROL: and it signs")
row(K, "after_sleep", "reauth", "PrepareForSleep(true): the next sign is refused 'reauth'")
row(K, "after_wake", "reauth", "PrepareForSleep(false) gives nothing back")
row(K, "wake_alone", "ok", "CONTROL: PrepareForSleep(false) alone ends nothing")
row(K, "gate_locked", "Locked", "LockedHint true reaches the gate")
row(K, "after_hint", "reauth", "LockedHint: the next sign is refused 'reauth'")
row(K, "begin_locked", False, "while locked no session opens, whatever the host believes")
row(K, "locked_sign", "reauth", "while locked a sign stays refused, with a person ready to say yes")
row(K, "locked_prompts", 0, "while locked nobody is asked")
row(K, "gate_after_lie", "Locked", "a signal saying 'unlocked' is checked against logind, not believed")
opened(K, "gate_unlocked", "LockedHint false reopens the gate")
row(K, "unlocked_sign", "ok", "after the unlock the person is asked and a yes signs")
row(K, "unlocked_prompts", 1, "exactly one prompt")
row(K, "gate_invalidated", "Locked", "LockedHint announced with no value is still read")
row(K, "after_invalidated", "reauth", "and refuses the next sign")
row(K, "straddle", "reauth", "a yes given across a lock opens nothing")
row(K, "straddle_prompts", 1, "that prompt was shown")
row(K, "after_straddle", "ok", "CONTROL: asked afresh, a yes signs")
row(K, "straddle_retry_prompts", 2, "and it was a second, new prompt, with no cooldown")
row(K, "name_control", "ok", "CONTROL: signing before logind leaves")
row(K, "gate_no_name", "Unwatched", "logind leaving the bus closes the gate")
row(K, "begin_no_name", False, "no session opens without logind")
row(K, "no_name_sign", "unavailable", "and a sign is 'unavailable'")
row(K, "no_name_prompts", 0, "and nobody is asked for an answer that could not help")
opened(K, "gate_name_back", "logind coming back reopens the gate")
row(K, "name_back_sign", "reauth", "but not the session: the person is asked, and here says no")
row(K, "session_control", "ok", "CONTROL: signing before the session goes away")
row(K, "gate_session_gone", "Unwatched", "the session going away closes the gate")
row(K, "session_gone_sign", "unavailable", "and a sign is 'unavailable'")
opened(K, "gate_session_back", "a session appearing reopens the gate")
row(K, "session_back_sign", "ok", "CONTROL: by the person's yes")
D = json.loads((out / "busdown.json").read_text()) if (out / "busdown.json").exists() else {}
row(D, "gate", "Unwatched", "the bus dying closes the gate")
row(D, "begin", False, "no session opens")
row(D, "sign", "unavailable", "and a sign is 'unavailable', with a person ready to say yes")
row(D, "prompts", 0, "and nobody is asked")
ok((out / "lock.exit").exists() and (out / "lock.exit").read_text().strip() == "0", "the host outlived the bus and exited cleanly")

S = rep("lockstart")
row(S, "gate", "Locked", "started under a locked session: the gate reads the flag at start, with no signal")
row(S, "begin", False, "no session opens")
row(S, "sign", "reauth", "a sign is refused")
row(S, "prompts", 0, "nobody is asked")
opened(S, "gate_after", "the unlock opens the gate")
row(S, "sign_after", "ok", "CONTROL: then a yes signs")
row(S, "prompts_after", 1, "after one prompt")

N = rep("nobus")
row(N, "gate", "Unwatched", "no bus: the gate stays closed")
row(N, "begin", False, "no session opens")
row(N, "sign", "unavailable", "a sign is 'unavailable', with a person ready to say yes")
row(N, "prompts", 0, "nobody is asked")

for o in oks:
    print("ok  ", o)
for f in fails:
    print("FAIL", f)
print(f"\n{len(oks)} ok, {len(fails)} failed")
sys.exit(1 if fails else 0)
