# SPDX-License-Identifier: MIT
# Copyright (c) 2026 The Bento authors
#
# Asserts the H2 rig reports (rig/run.sh). Every check is a verdict, never a
# printout: a missing report or an unexpected value FAILS the run.
import json, sys, pathlib, re, urllib.parse

out = pathlib.Path(sys.argv[1])
# The platform the rigs ran on. WebKitGTK serves a document at bento://<24 hex>.localhost/;
# WebView2 (wry's custom-protocol workaround) at http://bento.<24 hex>.localhost/. The identity
# agent's key store is built for Linux only: on Windows every identity call is refused by the
# host as unavailable (its key store is an explicit "not built, needs a real PC" stub).
PLATFORM = sys.argv[2] if len(sys.argv) > 2 else "linux"
WINDOWS = PLATFORM == "windows"
SCHEME = r"http://bento\." if WINDOWS else r"bento://"
fails, oks = [], []


def ok(cond, what):
    (oks if cond else fails).append(what)


def report(name):
    p = out / f"{name}.json"
    if not p.exists():
        fails.append(f"{name}: NO REPORT (a timeout is a failure)")
        return None
    return json.loads(p.read_text())


def report_quiet(name):
    p = out / f"{name}.json"
    return json.loads(p.read_text()) if p.exists() else None


def log(name):
    p = out / f"{name}.log"
    return p.read_text(errors="replace") if p.exists() else ""


def window(name, genuine, expect_heard, peer_cap_expected=True):
    r = report(name)
    if not r:
        return
    p = r["page"]
    ok(not p.get("error"), f"{name}: no error in the probe ({p.get('error')})")
    ok(p.get("armed_in_time"), f"{name}: armed after the nonce echo")
    # rig 6
    ok(p.get("cap_rotated") is True, f"{name}: rig 6 the reload rotated the capability")
    ok(p.get("rig6_old_cap") == "capability refused", f"{name}: rig 6 the previous load's capability is refused ({p.get('rig6_old_cap')})")
    ok(p.get("rig6_no_cap") == "no capability", f"{name}: rig 6 no capability is refused ({p.get('rig6_no_cap')})")
    ok(p.get("rig6_current_cap") == "only the open document is readable", f"{name}: rig 6 the current capability reaches the op ({p.get('rig6_current_cap')})")
    # the page
    ok(p.get("secure_context") is True and p.get("webcrypto") is True, f"{name}: secure context with WebCrypto")
    ok(p.get("bridge_installed") is True, f"{name}: bridge.js installed")
    ok(re.fullmatch(SCHEME + r"[0-9a-f]{24}\.localhost", p.get("origin") or "") is not None, f"{name}: a 96-bit per-document origin ({p.get('origin')})")
    for row, what in (("core_cmd", "plugin:window|title"), ("core_opener", "plugin:opener|open_url"), ("core_dialog", "plugin:dialog|message")):
        ok(str(p.get(row, "")).startswith("refused") and "not allowed" in str(p.get(row, "")), f"{name}: {what} refused to page script by the ACL ({p.get(row)})")
    # identity commands: only a GENUINE load reaches the agent (armed_genuine)
    ok(p.get("id_no_cap") == "no capability", f"{name}: identity: no capability is refused before anything else ({p.get('id_no_cap')})")
    if genuine and not WINDOWS:
        ok(p.get("id_sign") == "purpose" and p.get("id_whoami") == "no-identity", f"{name}: identity: a genuine load REACHES the agent (sign -> purpose, whoami -> no-identity) ({p.get('id_sign')}, {p.get('id_whoami')})")
    else:
        ok(p.get("id_sign") == "unavailable" and p.get("id_whoami") == "unavailable", f"{name}: identity: {'on Windows the key store is not built, so every call' if WINDOWS else 'an unknown document'} is refused by the host before the agent ({p.get('id_sign')}, {p.get('id_whoami')})")
    # CSP: pinned for genuine, none for unknown (the control)
    if genuine:
        ok(p.get("dom_inline_ran") is False, f"{name}: under the pinned CSP an added inline script does NOT run")
        ok(any(v.get("dir", "").startswith("script-src") for v in p.get("violations", [])), f"{name}: and the CSP reports the violation")
    else:
        ok(p.get("dom_inline_ran") is True, f"{name}: control: with no CSP an added inline script runs")
    # rig 8
    ok(sorted(p.get("rig8_heard") or []) == sorted(expect_heard), f"{name}: rig 8 BroadcastChannel heard exactly {expect_heard} (got {p.get('rig8_heard')})")
    # rig 8: cookies (every parent-Domain attempt included) and Origin-Agent-Cluster. Siblings
    # (distinct documents) must never see each other's cookies; a document's own host-only cookie
    # being visible is the positive control (Windows: http origin, cookies work; WebKit's bento://
    # scheme keeps no cookies, so there only the leak row stands).
    cookies = p.get("rig8_cookies")
    names = [c.split("=")[0].strip() for c in (cookies or "").split(";") if c.strip()]
    me = name.split("-")[1]
    others = [n for n in names if n.startswith("rck_") and not n.startswith(f"rck_{me}_")]
    if name.split("-")[0] in ("pair", "pairshared"):
        ok(isinstance(cookies, str) and others == [], f"{name}: rig 8 no sibling document's cookie is visible, parent-Domain attempts included (saw {names})")
        if WINDOWS: ok(f"rck_{me}_host" in names, f"{name}: rig 8 control: the document's own host-only cookie IS visible, so the cookie jar works ({names})")
    ok("rig8_oac_type" in p, f"{name}: rig 8 Origin-Agent-Cluster reported (typeof originAgentCluster = {p.get('rig8_oac_type')}, value = {p.get('rig8_oac')}; document.domain after a set attempt = {p.get('rig8_domain_after')})")
    if WINDOWS:
        ok(p.get("rig8_oac") is True, f"{name}: rig 8 window.originAgentCluster is true ({p.get('rig8_oac_type')} {p.get('rig8_oac')})")
        ok(p.get("rig8_domain_after") != "localhost", f"{name}: rig 8 document.domain cannot be relaxed to the parent domain ({p.get('rig8_domain_after')}, err {p.get('rig8_domain_err')})")
        own = p.get("rig8_domain_own") or ""
        ok(re.fullmatch(r"bento\.[0-9a-f]{24}\.localhost", own) is not None and p.get("rig8_domain_hex_after") == own and p.get("rig8_domain_hex_tried") == own[len("bento."):], f"{name}: rig 8 document.domain = {p.get('rig8_domain_hex_tried')} is a no-op under the header ({p.get('rig8_domain_hex_after')})")
    # rigs 1, 2 and the control, by the host's log for this webview
    emb = p.get("embeds") or {}
    for tag in ["rig1-key-only", "control-own-cap"] + (["rig2-peer-cap"] if peer_cap_expected else []):
        ok(isinstance(emb.get(tag), dict), f"{name}: embed {tag} reported ({emb.get(tag)})")
    # the fixture was served by US and loaded: every embed reports the fixture's own marker (a
    # fixture that never loaded reports 'no report' and fails above), from the loopback origin
    for tag, e in emb.items():
        if isinstance(e, dict): ok(e.get("page") == "rig-embed-fixture", f"{name}: embed {tag} is the locally served fixture")
    for tag, e in emb.items():
        if isinstance(e, dict) and e.get("inv"): print(f"note {name}: embed {tag} invoke() result: {e.get('inv')}")
    if WINDOWS:
        sb = emb.get("win-sandboxed")
        ok(isinstance(sb, dict) and str(sb.get("inv", "")).startswith("err:"), f"{name}: Windows: a SANDBOXED frame (origin null) is refused by Tauri's IPC itself, even holding this window's own capability ({sb.get('inv') if isinstance(sb, dict) else sb})")
    if WINDOWS:
        # the capability's origin pattern, in the running ACL: only a document with no CSP can frame
        # these, so the genuine windows see nothing load
        af = p.get("acl_frames") or {}
        scn0, me0 = name.split("-")
        L0 = log(scn0)
        for tag in ("evil", "abc"):
            e = af.get(tag)
            if genuine:
                ok(e == "no report", f"{name}: acl {tag}: the pinned CSP keeps this frame out ({e})")
            else:
                ok(isinstance(e, dict) and e.get("page") == "rig-embed-fixture" and "not allowed" in str(e.get("inv", "")), f"{name}: acl {tag}: a page at an off-pattern origin is refused by the ACL ({e.get('origin') if isinstance(e, dict) else e}: {str(e.get('inv'))[:90] if isinstance(e, dict) else ''})")
                ok(f'id="{me0}:acl-{tag}"' not in L0, f"{name}: acl {tag}: and the call never reached the host")
        e = af.get("hex")
        if genuine:
            ok(e == "no report", f"{name}: acl hex: the pinned CSP keeps this frame out ({e})")
        else:
            ok(re.search(r'IPC bento_file op="read" id="%s:acl-hex" webview=%s(?:_r\d+)? REFUSED: no capability' % (me0, me0), L0) is not None, f"{name}: control: a 24-hex origin passes the ACL and is refused by the capability, so the two above were the pattern's doing")
    # a DIFFERENT self-signed certificate for the same host is still refused (trust is per certificate)
    ok(p.get("rogue") == "no report", f"{name}: control: an embed from a DIFFERENT self-signed 127.0.0.1 certificate never loads ({p.get('rogue')})")
    oc = p.get("origin_ctl") or {}
    xo = oc.get("cross")
    ok(isinstance(xo, dict) and re.fullmatch(r"https://127\.0\.0\.1:\d+", xo.get("origin", "") or "") is not None and xo.get("origin") != p.get("origin"), f"{name}: origin control: the unsandboxed fixture is a DIFFERENT origin from the document ({xo.get('origin') if isinstance(xo, dict) else xo} vs {p.get('origin')})")
    ok(isinstance(xo, dict) and xo.get("parentRead") == "THREW", f"{name}: origin control: that cross-origin frame cannot read the document's realm ({xo.get('parentRead') if isinstance(xo, dict) else xo})")
    ok(oc.get("cross_reads") == "THREW", f"{name}: origin control: the document cannot read into the cross-origin frame ({oc.get('cross_reads')})")
    # rigs 1, 2 and the control, decided by the HOST for this webview
    scn, lbl = name.split("-")
    L = log(scn)
    def outcome(tag):
        m = re.search(r'IPC bento_file op="read" id="%s:%s" webview=%s(?:_r\d+)? (OK|REFUSED: [^\n]*)' % (lbl, tag, lbl), L)
        return m.group(1) if m else "not seen"
    ok(outcome("rig1-key-only") == "REFUSED: no capability", f"{name}: rig 1 an embed with Tauri's key only is refused ({outcome('rig1-key-only')})")
    if peer_cap_expected:
        ok(outcome("rig2-peer-cap") == "REFUSED: capability refused", f"{name}: rig 2 an embed with the PEER's capability is refused ({outcome('rig2-peer-cap')})")
    ok(outcome("control-own-cap") == "OK", f"{name}: control: an embed handed THIS window's capability reaches the IPC, so the refusals are the capability's doing ({outcome('control-own-cap')})")
    # rig 3
    ok(p.get("rig3_peer_cap_seen_here") is False, f"{name}: rig 3 the peer's capability never passed through this realm")
    # save in place, re-verified
    ok(p.get("saved") is True and p.get("save_changed") is True, f"{name}: saved in place through the bridge")
    ok(r.get("on_disk_has_marker") is True, f"{name}: the marker is on disk")
    ok(r.get("verdict_on_disk_after", "").startswith("genuine") == genuine, f"{name}: the saved file is still {'genuine' if genuine else 'unknown'} ({r.get('verdict_on_disk_after')})")
    return r


def embeds_in_log(scn, label):
    lines = [l for l in log(scn).splitlines() if l.startswith("IPC bento_file") and f"webview={label}" in l]
    return lines


# a webview fetched the fixture from our server (preflight is the first GET; WebKit caches the rest,
# so the per-embed proof is the fixture's own marker in every report, asserted per window)
srv = (out / "embed-server.log").read_text(errors="replace") if (out / "embed-server.log").exists() else ""
gets = len(re.findall(r'"GET /embed.html', srv))
rsrv = (out / "rogue-server.log").read_text(errors="replace") if (out / "rogue-server.log").exists() else ""
ok(len(re.findall(r'"GET /embed\.html HTTP', rsrv)) == 0, "the rogue-certificate server was never asked for the page (the TLS handshake was refused, not merely unreported)")
ok((out / "gate-control.exit").exists() and (out / "gate-control.exit").read_text().strip() == "0" and "FAIL the binary contains" in (out / "gate-control.txt").read_text(errors="replace"),
   "release gate positive control: gate-binary.sh REFUSES this rig build (a gate that never fires proves nothing)")
ok('GET /embed.html?rig5' in srv, "rig 5 the foreign page is the local fixture, and the server was asked for it")
ok(gets >= 2, f"the local fixture server answered the embeds ({gets} GETs)")
nd = (out / "gate-needles.txt").read_text(errors="replace").splitlines() if (out / "gate-needles.txt").exists() else []
ok(nd[:1] == ["clean passes"] and len(nd) >= 12 and not [l for l in nd[1:] if not l.startswith("caught ")], f"release gate: each needle alone is refused and a clean file passes ({len(nd) - 1} needles; {[l for l in nd if not l.startswith('caught ')]})")
ct = (out / "capabilities-test.txt").read_text(errors="replace") if (out / "capabilities-test.txt").exists() else ""
crc = (out / "capabilities-test.exit").read_text().strip() if (out / "capabilities-test.exit").exists() else "missing"
ok(crc == "0" and "2 passed" in ct, f"capability pattern: Tauri's own matcher admits 24 hex and refuses every other shape (rc {crc})")
cc = (out / "capcheck-control.exit").read_text().strip() if (out / "capcheck-control.exit").exists() else "missing"
if WINDOWS:
    ok(cc != "0" and "FAIL" in (out / "capcheck-control.txt").read_text(errors="replace"), f"release gate positive control: capcheck REFUSES a rig build's capability set (exit {cc})")
    rb = (out / "rig-binary-needles.txt").read_text(errors="replace").strip() if (out / "rig-binary-needles.txt").exists() else ""
    ok("127.0.0.1:*" in rb, f"release gate: the loopback needle really is in a binary that compiled rig-embed.json ({rb})")
else:
    ok(cc == "0", f"capcheck: no capability file in a Linux build (exit {cc})")

for scn, wins in [
    ("pair", [("pair-doc0", True, [], True), ("pair-doc1", False, [], True)]),
    # doc0 and doc2 are the SAME file: the same-document control hears each other
    # (a window also hears its OWN post on its document's sync channel: another
    # BroadcastChannel object in the same window)
    ("pairshared", [("pairshared-doc0", True, [], True), ("pairshared-doc1", False, [], True)]),
    ("tri", [("tri-doc0", True, ["rig8<-doc2", "sync<-doc0", "sync<-doc2"], True), ("tri-doc1", False, [], True), ("tri-doc2", True, ["rig8<-doc0", "sync<-doc0", "sync<-doc2"], True)]),
]:
    reps = {n: window(n, g, h, pc) for n, g, h, pc in wins}
    L = log(scn)
    ex = (out / f"{scn}.exit").read_text().strip() if (out / f"{scn}.exit").exists() else "missing"
    ok(ex == "0", f"{scn}: the host exited cleanly after every window reported (exit {ex}; 124 = timeout)")
    m = re.search(r"RIG BOUNCED-BACK (.*)", L)
    back = dict(x.split("=", 1) for x in (m.group(1).split() if m else []))
    ok(len(back) == len(wins) and all(v == "armed,saved" for v in back.values()), f"{scn}: rig 5 every window came back to its document, re-armed, and SAVED through the host ({back})")
    tail = L[L.find("BOUNCE "):] if "BOUNCE " in L else ""
    for n, *_ in wins:
        lbl = n.split("-")[1]
        ok(re.search(r'BOUNCE %s:[^\n]*\n(?:.*\n)*?IPC bento_file op="write" id=\S+ webview=%s(?:_r\d+)? OK' % (lbl, lbl), tail) is not None, f"{n}: rig 5 the save after the bounce reached the op (host log)")
    # rigs 1/2: the host refused the key-only and peer-capability embeds; the
    # control was let through to the op (proving the embed reaches the IPC)
    refused_nocap = len(re.findall(r"IPC bento_file .*REFUSED: no capability", L))
    refused_wrong = len(re.findall(r"IPC bento_file .*REFUSED: capability refused", L))
    ok(refused_nocap >= len(wins), f"{scn}: rig 1 key-only embeds refused in the host ({refused_nocap})")
    ok(refused_wrong >= len(wins), f"{scn}: rig 2 peer-capability embeds (and rig 6's old capability) refused ({refused_wrong})")
    # rig 5: the main frame sent away was bounced back, and only the document was ever armed
    ok(len(re.findall(r"^BOUNCE \S+: main frame left the document for https://127\.0\.0\.1:\d+/embed\.html\?rig5", L, re.M)) >= len(wins), f"{scn}: rig 5 a main frame sent to the local fixture was bounced back")
    pend = re.findall(r"^PENDING \S+ generation \d+ url=(\S+)$", L, re.M)
    ok(len(pend) >= 2 * len(wins) and all(re.fullmatch(SCHEME + r"[0-9a-f]{24}\.localhost/", u) for u in pend), f"{scn}: rig 5 only the document itself was ever armed ({len(pend)} armings, {sorted(set(u for u in pend if not re.match(SCHEME, u)))} foreign)")
    # §19h: one web process per document
    procs = int((out / f"{scn}.procs").read_text().strip() or 0) if (out / f"{scn}.procs").exists() else 0
    distinct = 2
    if scn == "pairshared":
        # the positive control for this scenario: the two documents REALLY ran on one profile
        L = log(scn)
        dirs = sorted(p.name for p in (out / "pairshared-data" / "web").glob("*")) if (out / "pairshared-data" / "web").exists() else []
        ok(L.count("RIG PROFILE shared") >= 2 and dirs == ["shared"], f"pairshared: the two documents shared ONE profile directory, so only the origin separates them ({dirs})")
        pdirs = sorted(p.name for p in (out / "pair-data" / "web").glob("*")) if (out / "pair-data" / "web").exists() else []
        ok(len(pdirs) == 2, f"pair: control: the normal build gives each document its own profile directory ({len(pdirs)})")
    else:
      ok(procs >= distinct, f"{scn}: §19h at least one web process per document ({procs} seen for {distinct} documents)")
    # rig 8 storage: distinct documents never share IndexedDB; the same document does
    if scn in ("pair", "pairshared"):
        a, b = reps.get(f"{scn}-doc0"), reps.get(f"{scn}-doc1")
        if a and b:
            ok(a["page"]["rig8_idb_owner"].endswith("(claimed)") and b["page"]["rig8_idb_owner"].endswith("(claimed)"), f"pair: rig 8 each document claims its own IndexedDB ({a['page']['rig8_idb_owner']}, {b['page']['rig8_idb_owner']})")
            ok(a["origin_host"] != b["origin_host"], "pair: distinct origins")
            ok(a["page"]["origin"] != b["page"]["origin"] and a["page"]["origin"].endswith(a["origin_host"]) and b["page"]["origin"].endswith(b["origin_host"]), f"pair: the BROWSER reports two distinct per-document origins, each the host's ({a['page']['origin']}, {b['page']['origin']})")
    if scn == "tri":
        b0, u, b2 = reps.get("tri-doc0"), reps.get("tri-doc1"), reps.get("tri-doc2")
        if b0 and b2 and u:
            owners = {b0["page"]["rig8_idb_owner"], b2["page"]["rig8_idb_owner"]}
            ok(any(o.endswith("(claimed)") for o in owners) and any(not o.endswith("(claimed)") for o in owners), f"tri: rig 8 control: the same document opened twice shares IndexedDB ({owners})")
            ok(u["page"]["rig8_idb_owner"].endswith("(claimed)"), "tri: the unknown document has its own IndexedDB")
            ok(b0["origin_host"] == b2["origin_host"] != u["origin_host"], "tri: same file, same origin; other file, other origin")

# rig 9: the watchdog's recreate path (security's ruling: a NEW label)
def rig9(scn, genuine):
    wd = report(f"{scn}-doc0")
    L = log(scn)
    ex = (out / f"{scn}.exit").read_text().strip() if (out / f"{scn}.exit").exists() else "missing"
    ok(ex == "0", f"{scn}: the host exited cleanly (exit {ex})")
    ok(re.search(r"RECREATE doc0 -> doc0_r1", L) is not None, f"{scn}: recreated under a NEW label (doc0 -> doc0_r1)")
    ok(re.search(r'IPC bento_file op="read" id="wd-dead-old" webview=doc0 REFUSED: unknown webview', L) is not None, f"{scn}: the dead webview's own secret is refused (unknown webview)")
    ok(re.search(r"SERVED doc0_r1 \d+ bytes, %s" % ("genuine" if genuine else "unknown"), L) is not None, f"{scn}: gate 1 re-ran on the bytes served to the new webview")
    ok(re.search(r"PENDING doc0_r1 generation 1 url=\S+\n(?:.*\n)*?ARM doc0_r1 generation 1: ARMED", L) is not None, f"{scn}: the new webview armed from PENDING at a fresh generation")
    if not wd:
        return
    W = wd["page"].get("watchdog") or {}
    ok(W.get("armed") is True and W.get("fresh_cap") is True, f"{scn}: a freshly minted secret, never the old one ({W.get('fresh_cap')})")
    ok(W.get("old_on_new") == "capability refused", f"{scn}: the OLD secret presented through the NEW label is refused ({W.get('old_on_new')})")
    ok(W.get("own_on_new") == "only the open document is readable", f"{scn}: the new webview's own secret works ({W.get('own_on_new')})")
    if genuine:
        # under the pinned CSP no fetch to the origin is even made (connect-src)
        ok(str(W.get("new_fetch", "")).startswith("blocked"), f"{scn}: under the pinned CSP a page cannot fetch its own origin at all ({W.get('new_fetch')})")
    else:
        ok(W.get("new_fetch") == "200", f"{scn}: control: the LIVE label's fetch of its document reaches the handler ({W.get('new_fetch')})")
        ok(re.search(r"PROTO REFUSED doc0 [0-9a-f]{24}\.localhost/", L) is not None, f"{scn}: the DEAD label's fetch was refused by the protocol handler (host log)")
        ok(W.get("old_fetch") in ("404", None) or str(W.get("old_fetch")).startswith("blocked"), f"{scn}: and the dead page got no document ({W.get('old_fetch')})")

rig9("watchdog", True)
rig9("watchdogu", False)

# B1 and §19e d1/d4: blocked main-frame navigations leave the document armed and saving, a live
# embed navigating touches nothing, and frames sent to plain http are held by what each engine has
def navlock():
    L = log("navlock")
    ex = (out / "navlock.exit").read_text().strip() if (out / "navlock.exit").exists() else "missing"
    ok(ex == "0", f"navlock: the host exited cleanly (exit {ex})")
    measured = {}
    for lbl, genuine in (("doc0", True), ("doc1", False)):
        name = f"navlock-{lbl}"
        r = report(name)
        if not r:
            continue
        N = r["page"].get("navlock") or {}
        ok(not N.get("error"), f"{name}: no error in the probe ({N.get('error')})")
        ok(N.get("armed") is True and N.get("first") == "saved", f"{name}: armed and saving, after a blocked navigation during its own load ({N.get('armed')}, {N.get('first')})")
        steps = list(re.finditer(r"^STEP %s\.step = (\S+)$" % lbl, L, re.M))
        def between(a, b, pat):
            sa = [m for m in steps if m.group(1) == a]; sb = [m for m in steps if m.group(1) == b]
            return len(re.findall(pat, L[sa[0].end():sb[0].start()], re.M)) if sa and sb else None
        for t in ("http", "file", "data", "mailto", "blob", "hash"):
            row = (N.get("rows") or {}).get(t) or {}
            what = "a fragment link" if t == "hash" else f"blocked {t}"
            if t != "hash": ok(row.get("hash") == "", f"{name}: {what}: the URL did not move ({row.get('hash')!r})")
            ok(row.get("same_realm") is True and row.get("same_cap") is True, f"{name}: {what}: still the same page and the same capability ({row.get('same_realm')}, {row.get('same_cap')})")
            ok(row.get("save") == "saved", f"{name}: {what}: a real save through the host still works ({row.get('save')})")
            ok(row.get("begin") == "the open document was already handed out", f"{name}: {what}: per-load state survived, so nothing re-minted ({row.get('begin')})")
            sta = between(f"blocked-{t}", f"after-{t}", r"^STARTED %s " % lbl)
            measured[f"{lbl}:{t}"] = {"finished": between(f"blocked-{t}", f"after-{t}", r"^FINISHED %s " % lbl), "on_navigation_blocked": between(f"blocked-{t}", f"after-{t}", r"^NAVIGATION BLOCKED %s " % lbl), "started": sta}
            ok(sta == 0, f"{name}: {what}: no load started ({sta})")
        ok(between("blocked-http", "after-http", r"^NAVIGATION BLOCKED %s " % lbl) == 1, f"{name}: positive control: the http navigation really reached the host's policy and was refused")
        plainlog = (out / "plain-server.log").read_text(errors="replace") if (out / "plain-server.log").exists() else ""
        # WebKitGTK decides before the request. WebView2 does not: the request goes out and only
        # the commit is cancelled (measured; a note, since which side of the cancel it lands on is
        # the engine's). The rows above are what must hold there: the page never moved.
        if WINDOWS:
            print(f"note {name}: requests that reached the server for cancelled navigations: {sorted(set(re.findall(r'[?]nl-[a-z]+', plainlog)))}")
        else:
            ok("?nl-" not in plainlog, f"{name}: and nothing was fetched: the blocked navigations never left the host")
        ok(((N.get("rows") or {}).get("hash") or {}).get("hash") == "#nl", f"{name}: a fragment link is not blocked: the page's own #nl took effect ({((N.get('rows') or {}).get('hash') or {}).get('hash')})")
        # §19e d1
        d1 = N.get("d1") or {}
        for tag in ("loaded", "src_changed", "self_navigated"):
            e = d1.get(tag)
            ok(isinstance(e, dict) and e.get("page") == "rig-embed-fixture", f"{name}: d1 the live embed {tag} ({e if not isinstance(e, dict) else e.get('tag')})")
        for what, pat in (("started", r"^STARTED %s "), ("finished", r"^FINISHED %s "), ("minted", r"^PENDING %s ")):
            n = between("d1-start", "d1-end", pat % lbl)
            ok(n == 0, f"{name}: d1 a frame's loads and navigations {what} nothing in the main frame ({n})")
        ok(d1.get("same_cap") is True and d1.get("save") == "saved", f"{name}: d1 the capability keeps working after them ({d1.get('save')})")
        # §19e d4: on_navigation reaches frames on WebKitGTK only
        d4 = N.get("d4") or {}
        asked = f"?d4-{lbl}" in plainlog
        policy = re.search(r"^NAVIGATION BLOCKED %s -> http://127\.0\.0\.1:\d+/embed\.html\?d4" % lbl, L, re.M) is not None
        ok(d4.get("save") == "saved", f"{name}: d4 still saving after the frame row ({d4.get('save')})")
        if genuine:
            ok(d4.get("plain") == "no report" and not asked, f"{name}: d4 under the pinned CSP a frame sent to plain http never loads, and its server is never asked ({d4.get('plain')}, asked={asked})")
            ok(len(d4.get("csp") or []) >= 1, f"{name}: d4 and the CSP is what refused it ({d4.get('csp')})")
            if WINDOWS:
                ok(not policy, f"{name}: d4 WebView2's on_navigation never saw the frame: for frames the CSP is the whole policy")
        elif WINDOWS:
            ok(isinstance(d4.get("plain"), dict) and asked and not policy, f"{name}: d4 MEASURED: WebView2's on_navigation does not see frames, so with no CSP a plain http frame loads ({d4.get('plain') if not isinstance(d4.get('plain'), dict) else d4['plain'].get('origin')})")
        else:
            ok(d4.get("plain") == "no report" and not asked and policy, f"{name}: d4 on WebKitGTK on_navigation refuses the frame ({d4.get('plain')}, asked={asked})")
    print("note navlock, per blocked navigation (does a cancelled navigation report Finished?):", json.dumps(measured))
    (out / "navlock-measured.json").write_text(json.dumps(measured, indent=1))
    print(f"note navlock: FINISHED lines {len(re.findall(r'^FINISHED', L, re.M))}, PENDING lines {len(re.findall(r'^PENDING', L, re.M))}, ARMED lines {len(re.findall(r'ARMED', L))}")
navlock()

# A document that moved its own fragment, then reloaded
def fragment():
    L = log("fragment")
    ex = (out / "fragment.exit").read_text().strip() if (out / "fragment.exit").exists() else "missing"
    ok(ex == "0", f"fragment: the host exited cleanly (exit {ex})")
    r = report("fragment-doc0")
    F = ((r or {}).get("page") or {}).get("fragment") or {}
    ok(F.get("link") == "#frag-link" and F.get("push") == "#p/frag", f"fragment: a link and pushState both moved the URL ({F.get('link')}, {F.get('push')})")
    ok(F.get("same_cap") is True and F.get("save") == "saved", f"fragment: same capability and a real save after both ({F.get('save')})")
    ok(F.get("after") == "#p/frag", f"fragment: precondition: the reload's URL really carried the fragment ({F.get('after')})")
    ok(F.get("armed") is True and F.get("rotated") is True and F.get("save2") == "saved", f"fragment: the reload armed under a new secret and saved through the host ({F.get('armed')}, {F.get('rotated')}, {F.get('save2')})")
    ok(re.search(r"^BOUNCE ", L, re.M) is None, "fragment: nothing bounced, so nothing went to the system browser")
    ok("NAVIGATION BLOCKED" not in L, "fragment: the policy refused nothing")
    ok(len(re.findall(r"^PENDING doc0 ", L, re.M)) >= 2 and re.search(r"^PENDING doc0 generation \d+ url=\S+#p/frag$", L, re.M) is not None, "fragment: the host minted for the reload's fragment URL")
fragment()

# B2, security's mk2.py, on both engines. The verdict comes from the host's own ARM line, since
# on Windows bento_id stops at the platform gate whatever the verdict
def races():
    won = stayed = 0
    grid = []
    for n in range(10):
        scn = f"race{n}"
        L = log(scn)
        ex = (out / f"{scn}.exit").read_text().strip() if (out / f"{scn}.exit").exists() else "missing"
        r = report_quiet(scn + "-doc0")
        rc = ((r or {}).get("page") or {}).get("race") or {}
        ok(ex == "0" or "RECREATE" in L, f"{scn}: finished, or stopped by the known reload stall with the watchdog in the log (exit {ex})")
        m = re.search(r"STEP doc0\.step = race stage=0 attacker=true armed=true id=(.*)", L)
        ok(m is not None and m.group(1) == "unavailable", f"{scn}: control: stage 0 is an armed unknown document, refused identity ({m.group(1) if m else 'no line'})")
        order = re.search(r'SERVED doc0 \d+ bytes, unknown[^\n]*\n(?:.*\n)*?IPC bento_file op="write" id="race-w" webview=doc0 OK\n(?:.*\n)*?SERVED doc0 \d+ bytes, genuine', L)
        ran = bool(rc.get("attacker")) and rc.get("stage") == "1"
        hit = ran and order is not None
        arms = re.findall(r"^ARM doc0 generation \d+: ARMED genuine=(true|false)$", L, re.M)
        won += hit
        stayed += ran
        grid.append({"scn": scn, "exit": ex, "attacker_ran": ran, "won": hit, "arms": arms, "id": rc.get("id")})
        if ran:
            ok(rc.get("id") == "unavailable", f"{scn}: the attacker's bytes running after the swap are refused identity ({rc.get('id')})")
            ok(arms[-1:] == ["false"], f"{scn}: and the host armed that load as unknown ({arms})")
    print("note race grid:", json.dumps(grid))
    ok(won >= 1, f"race: the swap really landed between the two serves at least once, or the grid proved nothing ({won} of 10; the attacker's bytes kept running in {stayed})")
    # the cost of the taint: a save that makes the file genuine, then a reload, runs the genuine
    # bytes and stays unknown to the host, and opening the file again is what arms it genuine
    L = log("resave")
    rc = ((report_quiet("resave-doc0") or {}).get("page") or {}).get("race") or {}
    arms = re.findall(r"^ARM doc0 generation \d+: ARMED genuine=(true|false)$", L, re.M)
    ok(rc.get("attacker") is False and rc.get("armed") is True, f"resave: the reload after the save runs the genuine bytes, armed ({rc})")
    ok(re.search(r"SERVED doc0 \d+ bytes, genuine", L) is not None, "resave: precondition: the reload served the genuine bytes")
    ok(arms == ["false", "false"], f"resave: unknown script ran in this webview, so the reload stays unknown ({arms})")
    ok(rc.get("id") == "unavailable", f"resave: and identity stays off ({rc.get('id')})")
    L = log("reopened")
    rc = ((report("reopened-doc0") or {}).get("page") or {}).get("race") or {}
    arms = re.findall(r"^ARM doc0 generation \d+: ARMED genuine=(true|false)$", L, re.M)
    ok(rc.get("attacker") is False and arms == ["true"], f"reopened: the same file opened again arms genuine ({rc.get('attacker')}, {arms})")
    ok(rc.get("id") == ("unavailable" if WINDOWS else "purpose"), f"reopened: identity is back on the genuine bytes ({rc.get('id')})")
races()

# A load with no document serve: an unknown document goes back through its history after
# setting up a genuine verdict (see runRestore in probe.js). `restore` has the page cache off and the
# document is served again; `restorecache` has it on, the page comes back whole, and the taint
# alone holds.
def restore(scn, how):
    L = log(scn)
    ex = (out / f"{scn}.exit").read_text().strip() if (out / f"{scn}.exit").exists() else "missing"
    ok(ex == "0", f"{scn}: the host exited cleanly (exit {ex})")
    rs = (((report(f"{scn}-doc0") or {}).get("page") or {}).get("restore")) or {}
    ok(re.search(r"STEP doc0\.step = restore stage=1 attacker=true armed=true length=[2-9]", L) is not None, f"{scn}: precondition: the attacker's second page has history to go back through")
    ok(re.search(r'SERVED doc0 \d+ bytes, unknown[^\n]*\n(?:.*\n)*?IPC bento_file op="write" id="restore-w" webview=doc0 OK\n(?:.*\n)*?SERVED doc0 \d+ bytes, genuine[^\n]*\nSTEP doc0\.step = restore-going-back', L) is not None, f"{scn}: precondition: a genuine serve was on the books when the document went back")
    ok((rs.get("hooked") or 0) >= 1, f"{scn}: precondition: the page took the secret itself, so the shim did not stand in the way ({rs.get('hooked')})")
    ok(rs.get("how") == how, f"{scn}: going back: {how} ({rs.get('how')})")
    back = L.split("STEP doc0.step = restore-going-back", 1)[-1]
    first = re.search(r"^(SERVED|STARTED) doc0", back, re.M)
    want = "SERVED" if how == "reloaded" else "STARTED"
    ok(first is not None and first.group(1) == want, f"{scn}: going back: {want} comes first ({first and first.group(1)})")
    arms = re.findall(r"^ARM doc0 generation \d+: ARMED genuine=(\w+)", L, re.M)
    ok(arms == ["false", "false", "false"], f"{scn}: nothing arms genuine in a webview that ran unknown script ({arms})")
    ok(rs.get("attacker") is (how == "restored") and rs.get("armed") is True, f"{scn}: the bytes that armed, for the file capability only ({rs.get('attacker')}, {rs.get('armed')})")
    ok(rs.get("id") == "unavailable", f"{scn}: identity stays off ({rs.get('id')})")
restore("restore", "reloaded")
if not WINDOWS:
    ok("RIG PAGE CACHE on" in log("restorecache"), "restorecache: precondition: the rig build left the page cache on")
    restore("restorecache", "restored")

# B5: a document that booked a genuine verdict and left for https. The hostile page must get no
# secret at all, on either engine, whatever URL the engine reports its finish with.
def leave(scn, tag):
    L = log(scn)
    srv = (out / "embed-server.log").read_text(errors="replace") if (out / "embed-server.log").exists() else ""
    says = [urllib.parse.unquote(v) for v in re.findall(r'"GET /' + tag + r'\?(\S*) HTTP', srv)] + re.findall(r"^STEP doc0\.step = " + tag + r" (.*)$", L, re.M)
    print(f"note {scn}: the page said {sorted(set(says))}")
    ok(re.search(r'SERVED doc0 \d+ bytes, unknown[^\n]*\n(?:.*\n)*?IPC bento_file op="write" id="leave-w" webview=doc0 OK\n(?:.*\n)*?SERVED doc0 \d+ bytes, genuine[^\n]*\nSTEP doc0\.step = leave-going', L) is not None, f"{scn}: precondition: a genuine verdict was on the books when the document left")
    ok("ran" in says, f"{scn}: precondition: the hostile page ran")
    ok("control" in says, f"{scn}: control: the page's hook catches a delivery, so catching none means something")
    ok(not [v for v in says if v not in ("ran", "control")], f"{scn}: the https page received no secret at all ({sorted(set(says))})")
    starts = dict(re.findall(r"^STARTED doc0 generation (\d+) url=(\S*)", L, re.M))
    off = {g for g, u in starts.items() if u.startswith("https://")}
    pend = set(re.findall(r"^PENDING doc0 generation (\d+) ", L, re.M))
    ok(bool(off) and not (off & pend), f"{scn}: no mint for a load that started off the document (off {sorted(off)}, minted {sorted(pend)})")
    arms = re.findall(r"^ARM doc0 generation \d+: ARMED genuine=(\w+)", L, re.M)
    ok("true" not in arms, f"{scn}: nothing armed genuine in this webview ({arms})")
    ok(re.search(r"IPC bento_id \S+ id=\S+ webview=doc0 AGENT", L) is None, f"{scn}: nothing in this webview reached the agent")
    lv = (((report(f"{scn}-doc0") or {}).get("page") or {}).get("leave")) or {}
    ok(lv.get("attacker") is False and lv.get("armed") is True, f"{scn}: the document came back, the genuine shell, armed ({lv})")
    if "RECREATE" not in L and "WATCHDOG" not in L:
        ok(lv.get("id") == "unavailable", f"{scn}: identity stays off in the webview that ran unknown script ({lv.get('id')})")
leave("leave", "b5")
leave("leavestop", "b5-stop")

# Same-document history with a verdict on the books: no load, no mint (security's n-push)
def pushback():
    L = log("pushback")
    pb = (((report("pushback-doc0") or {}).get("page") or {}).get("pushback")) or {}
    ok(re.search(r'IPC bento_file op="write" id="pushback-w" webview=doc0 OK\n(?:.*\n)*?SERVED doc0 \d+ bytes, genuine[^\n]*\nSTEP doc0\.step = pushback-going', L) is not None, "pushback: precondition: a genuine verdict was on the books when the document went back")
    ok(pb.get("hash") == "", f"pushback: precondition: it really went back ({pb.get('hash')!r})")
    after = L.split("STEP doc0.step = pushback-going", 1)[-1]
    ok(re.search(r"^(STARTED|PENDING) doc0", after, re.M) is None, "pushback: going back started no load and minted nothing")
    ok(pb.get("same_cap") is True and pb.get("id") == "unavailable", f"pushback: the same capability, still unknown ({pb})")
pushback()

# A service worker could run unknown bytes in a fresh webview: the document cannot register as one.
def swreg():
    S = (((report("swreg-doc0") or {}).get("page") or {}).get("swreg")) or {}
    print(f"note swreg: {json.dumps(S)}")
    ok(S.get("secure") is True, f"swreg: precondition: a secure context ({S.get('secure')})")
    for k in ("doc", "query"):
        ok(str(S.get(k)).startswith(("refused", "no api")), f"swreg: {k}: the document cannot register ({S.get(k)})")
    # the control: on WebView2 a real script from the same origin registers, so the refusal above
    # is the document's. WebKitGTK refuses any custom scheme, so there is nothing to control there.
    if WINDOWS:
        ok(S.get("control") == "registered", f"swreg: control: a real script at this origin registers ({S.get('control')})")
swreg()

if WINDOWS:
    # B3's negative control: the rows above can fail
    r = report("oacoff-doc0")
    if r:
        p = r["page"]
        ok(p.get("oac") is False, f"oacoff: negative control: with the header at ?0 window.originAgentCluster is false ({p.get('oac_type')} {p.get('oac')})")
        ok(p.get("rig8_domain_hex_after") == p.get("rig8_domain_hex_tried"), f"oacoff: negative control: and document.domain DOES relax to {p.get('rig8_domain_hex_tried')} ({p.get('rig8_domain_hex_after')})")
    # §19e condition f: the ACL that ships, with no rig-embed.json in the build
    caps = json.loads((out / "acl-capabilities.json").read_text()) if (out / "acl-capabilities.json").exists() else {}
    ok(sorted(caps) == ["documents", "rig"], f"acl: this build really has no rig-embed capability ({sorted(caps)})")
    nb = (out / "acl-binary-needles.txt").read_text(errors="replace").strip() if (out / "acl-binary-needles.txt").exists() else "missing"
    # the loopback origin only: every rig build carries the string rig-embed in the fixture's own
    # marker (rig-embed-fixture), which says nothing about the capability
    ok(nb != "missing" and "127.0.0.1:*" not in nb, f"acl: and the loopback origin it opens is not in the binary ({nb})")
    L = log("acl")
    ex = (out / "acl.exit").read_text().strip() if (out / "acl.exit").exists() else "missing"
    ok(ex == "0", f"acl: the host exited cleanly (exit {ex})")
    for lbl in ("doc0", "doc1"):
        r = report(f"acl-{lbl}")
        A = ((r or {}).get("page") or {}).get("acl") or {}
        e = A.get("embed")
        ok(A.get("armed") is True and A.get("save") == "saved", f"acl-{lbl}: the document itself is armed and saving under this ACL ({A.get('save')})")
        ok(isinstance(e, dict) and e.get("page") == "rig-embed-fixture" and "not allowed" in str(e.get("inv", "")), f"acl-{lbl}: an embed holding this window's OWN capability is refused by the ACL ({str(e.get('inv'))[:100] if isinstance(e, dict) else e})")
        ok(f'id="{lbl}:acl-own-cap"' not in L, f"acl-{lbl}: and the call never reached the host (with rig-embed.json it does: the control-own-cap rows)")

# the REAL release (1.2.10 from bento.page, verified with the release key)
r = report("real-doc0")
L = log("real")
ex = (out / "real.exit").read_text().strip() if (out / "real.exit").exists() else "missing"
ok(ex == "0", f"real: the host exited cleanly (exit {ex})")
ok(re.search(r"opened doc0: bento-slides \d+\.\d+\.\d+", L) is not None, "real: the published shell reads GENUINE at open (bento-slides)")
ok(re.search(r"SERVED doc0 \d+ bytes, genuine \(pinned CSP\)", L) is not None, "real: served under its release's pinned CSP")
if r:
    p = r["page"]
    ok(not p.get("error"), f"real: no error in the probe ({p.get('error')})")
    ok(p.get("booted") is True, "real: the real editor booted under the pinned CSP (window.bento)")
    ok(bool(p.get("armed_in_time")) and p.get("cap_rotated") is True, "real: armed, and a reload rotated the secret")
    ok(p.get("dom_inline_ran") is False, "real: an added inline script does not run")
    ok(p.get("saved_by_runtime") is True and p.get("save_changed") is True, "real: saved by the runtime's own serializer through the bridge")
    ok(r.get("on_disk_has_marker") is True, "real: the edit is in the saved file")
    ok(r.get("verdict_on_disk_after", "").startswith("genuine"), f"real: the SAVED deck is genuine to the host ({r.get('verdict_on_disk_after')})")
    other = [v for v in p.get("violations", []) if "__rigInline" not in str(v.get("sample", ""))]
    print(f"note real: CSP reports other than the rig's own inline script: {other}")
# The taint's cost must stop at unknown documents: a genuine document saved by its own runtime
# is served genuine, so the next load in the SAME webview arms genuine.
L = log("realsave")
ex = (out / "realsave.exit").read_text().strip() if (out / "realsave.exit").exists() else "missing"
rv = (((report("realsave-doc0") or {}).get("page") or {}).get("realsave")) or {}
ok(ex == "0", f"realsave: the host exited cleanly (exit {ex})")
ok(rv.get("title") == "desktop-rig-marker", f"realsave: precondition: the reload runs the saved deck ({rv.get('title')})")
served = re.findall(r"^SERVED doc0 (\d+) bytes, (\w+)", L, re.M)
ok(len(served) >= 2 and all(v == "genuine" for _, v in served) and served[0][0] != served[-1][0], f"realsave: both loads served genuine, and the second served the saved bytes ({served})")
arms = re.findall(r"^ARM doc0 generation \d+: ARMED genuine=(\w+)", L, re.M)
ok(arms == ["true", "true"], f"realsave: saved and reloaded in the same webview, it arms genuine ({arms})")
ok(rv.get("id") == ("unavailable" if WINDOWS else "purpose"), f"realsave: identity is still on ({rv.get('id')})")
rc = (out / "real-release-check.exit").read_text().strip() if (out / "real-release-check.exit").exists() else "missing"
txt = (out / "real-release-check.txt").read_text() if (out / "real-release-check.txt").exists() else ""
ok(rc == "0" and "R.bento.html: GENUINE" in txt and "R-flipped.bento.html: UNKNOWN" in txt, f"real: against the release key ONLY, the saved deck is GENUINE and a one-byte-changed copy UNKNOWN (exit {rc})")

# B1, security §2e (B): a routine signature is REFUSED past the idle or overall
# limit until the person re-authenticates. Every refusal row sits beside a row that
# is ACCEPTED in the same run (the agent signs, and the signature verifies).
sa, su = report("sign-doc0"), report("sign-doc1")
ok(bool(sa and su), f"sign: both probes reported ({bool(sa)}, {bool(su)})")
if sa and su and WINDOWS:
    # No Windows key store is built yet (a refusing stub until a real-PC session), so the host
    # declares no identity capability: neither document gets an agent object, and raw IPC is
    # refused by the host before the agent. The session rows need an agent and run on WebKitGTK.
    A, U = sa["page"].get("sign", {}), su["page"].get("sign", {})
    ok(not A.get("error") and not U.get("error"), f"sign: no error in either probe ({A.get('error')}, {U.get('error')})")
    ok(A.get("present") is False and U.get("present") is False, f"sign: on Windows no document has an agent object, genuine or not ({A.get('present')}, {U.get('present')})")
    ok(A.get("raw_sign_prefixed") == "unavailable" and U.get("raw_sign_prefixed") == "unavailable",
       f"sign: and raw IPC is refused by the host on both ({A.get('raw_sign_prefixed')}, {U.get('raw_sign_prefixed')})")
    print("note sign: the session-limit rows need a key store and run on WebKitGTK only")
elif sa and su:
    A, U = sa["page"].get("sign", {}), su["page"].get("sign", {})
    ok(not A.get("error") and not U.get("error"), f"sign: no error in either probe ({A.get('error')}, {U.get('error')})")
    ok(A.get("present") is True and A.get("shape") == {"data": True, "writable": False, "configurable": False, "frozen": True, "keys": ["contract", "resolve", "sign", "whoami"]},
       f"sign: the genuine document has the agent: a frozen, non-writable, non-configurable data property ({A.get('shape')})")
    ok(U.get("present") is False, f"sign: the UNKNOWN document has no agent object at all ({U.get('present')})")
    ok(A.get("raw_sign_prefixed") == "purpose", f"sign: the id.* ops reach the agent on the genuine document ({A.get('raw_sign_prefixed')})")
    ok(U.get("raw_sign_prefixed") == "unavailable", f"sign: and the unknown document is stopped by the host even by raw IPC ({U.get('raw_sign_prefixed')})")
    ok(A.get("whoami") is None and A.get("resolve") is None and A.get("resolve_email") is None, f"sign: whoami and resolve answer null: no account, no bindings ({A.get('whoami')}, {A.get('resolve')}, {A.get('resolve_email')})")
    ok(A.get("before_session") == "reauth", f"sign: with no session the agent refuses 'reauth' ({A.get('before_session')})")
    ok(A.get("first") == "ok" and A.get("sig_valid") is True and A.get("sig_binds_payload") is True, f"sign: CONTROL after authenticating: signed, the signature verifies for exactly the payload ({A.get('first')}, {A.get('sig_valid')}, {A.get('sig_binds_payload')})")
    ok(A.get("prove") == "ok" and A.get("mismatch") == "purpose", f"sign: purpose-locked: prove signs, a frame payload under 'prove' is refused 'purpose' ({A.get('prove')}, {A.get('mismatch')})")
    ok(A.get("idle_inside") == "ok", f"sign: idle: one second INSIDE the hour still signs ({A.get('idle_inside')})")
    ok(A.get("idle_past") == "reauth" and A.get("idle_past_prove") == "reauth", f"sign: idle: one second PAST the hour is refused 'reauth', for every routine purpose ({A.get('idle_past')}, {A.get('idle_past_prove')})")
    ok(A.get("idle_past_again") == "reauth" and A.get("idle_past_later") == "reauth", f"sign: idle: it stays refused (not healed by retrying or by time) ({A.get('idle_past_again')}, {A.get('idle_past_later')})")
    ok(A.get("after_reauth") == "ok", f"sign: re-authenticating restores it ({A.get('after_reauth')})")
    steps = A.get("overall_steps") or []
    ok(len(steps) == 30 and steps[:28] == ["ok"] * 28, f"sign: overall: steady use every 50 minutes keeps signing for 23h20 (idle never trips) ({steps[:28].count('ok')}/28)")
    ok(A.get("overall_first_refusal") == 29 and set(steps[28:]) == {"reauth"}, f"sign: overall: the 29th step (24h10) is the first refusal and it stays refused ({A.get('overall_first_refusal')}, {steps[28:]})")
    ok(A.get("after_overall_reauth") == "ok", f"sign: overall: re-authenticating restores it ({A.get('after_overall_reauth')})")
    ok(A.get("after_lock") == "reauth", f"sign: a lock (screen lock, sleep) refuses until re-authentication ({A.get('after_lock')})")

# B1: an unverifiable file gets the notice (placeholder wording, the maintainer's to word), a genuine one does not
for scn, notice_for, none_for in [("pair", "U.bento.html", "A.bento.html"), ("sign", "SU.bento.html", "SA.bento.html")]:
    L = log(scn)
    ok(re.search(r"NOTICE " + re.escape(notice_for) + r": Bento can't verify this file", L) is not None, f"{scn}: the UNVERIFIABLE document ({notice_for}) is told it opens without a Bento ID")
    ok("NOTICE " + none_for not in L, f"{scn}: the genuine document ({none_for}) is not shown it")

# §19h wedge isolation: a stopped web process freezes ITS document and no other
wj = out / "wedge.json"
if not wj.exists():
    fails.append("wedge: NO REPORT (a timeout is a failure)")
else:
    w = json.loads(wj.read_text())
    ok(w.get("error") is None, f"wedge: the driver ran clean ({w.get('error')})")
    ok(w.get("both_counting_before") is True, "wedge: precondition: both documents were counting heartbeats")
    pids = w.get("web_pids") or []
    ok(len(pids) >= 2, f"wedge: §19h at least two distinct web-process PIDs for two documents ({pids})")
    single = w.get("single") or {}
    frozen_sets = [tuple(v["frozen"]) for v in single.values()]
    ok(bool(single) and all(len(f) <= 1 for f in frozen_sets), f"wedge: stopping any ONE web process freezes at most one document, the other stays responsive ({frozen_sets})")
    ok(set(d for f in frozen_sets for d in f) == {"doc0", "doc1"}, f"wedge: and each document is the one frozen by some process, so each has its own ({frozen_sets})")
    ok(all(v["recovered"] for v in single.values()) and bool(single), "wedge: continuing the process restores the document")
    ok(sorted(w.get("control_all_frozen") or []) == ["doc0", "doc1"], f"wedge: NEGATIVE CONTROL: stopping every web process freezes both documents, so a frozen heartbeat is what a wedge looks like ({w.get('control_all_frozen')})")
    ok(w.get("control_recovered") is True and w.get("alive") is True, "wedge: after the control the host is alive and both documents count again")

for o in oks:
    print("ok  ", o)
for f in fails:
    print("FAIL", f)
print(f"\n{len(oks)} ok, {len(fails)} failed")
sys.exit(1 if fails else 0)
