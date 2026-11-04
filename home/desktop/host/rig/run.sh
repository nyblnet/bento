#!/usr/bin/env bash
# The H2 host rigs (security §19d–§19h, rig 8) on Linux/WebKitGTK. Builds the
# host with the "rig" feature against the gate-1 corpus history, makes its own
# fixtures from the corpus, runs two multi-window scenarios, and asserts with
# check.py. A scenario that times out or reports nothing FAILS (§19f).
# Needs: a display (xvfb-run) and a D-Bus session. No network: the attacker's embed
# page is served from a loopback port of its own (see below), never a third party.
set -u
cd "$(dirname "$0")/.."
# Windows (Git Bash on a hosted windows-latest runner, WebView2): the same rigs,
# with the platform differences named here and nowhere else. WIN=1 selects them.
WIN=0; PY=python3
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) WIN=1; PY=python; export MSYS2_ARG_CONV_EXCL='*' ;; esac
export PY
OUT=${1:-/tmp/h2-rig}
[ "$WIN" = 1 ] && { mkdir -p "$OUT"; OUT=$(cygpath -m "$OUT"); }
rm -rf "$OUT"; mkdir -p "$OUT/fix"
# Histories: the corpus's (test key, rig builds only) and the REAL slides
# release frozen in the corpus (home/fixtures/gate1/real/slides-1.2.10, signed
# with the release key), so a real deck can be served genuine with no fetch.
# (release-check.sh is what fetches: proving the bundle CURRENT needs the live one.)
mkdir -p "$OUT/hist/corpus" "$OUT/hist/slides"
cp ../../fixtures/gate1/history.json "$OUT/hist/corpus/history.json"
cp -r ../../fixtures/gate1/real/slides-1.2.10 "$OUT/real"
cp "$OUT/real/history.json" "$OUT/hist/slides/history.json"
# The ATTACKER'S PAGE: rig/embed.html on its own loopback origin (https://127.0.0.1:<port>),
# served here with a throwaway certificate, so no launch-gating rig depends on a third party.
# What the host's refusals branch on is the page's capability and the main-frame arming, not
# origin or site (rig 1/2 and the control prove that); the fixture is nonetheless a true
# different origin (scheme, host and port all differ from the document's bento:// origin).
# HTTPS because the pinned CSP and the navigation policy admit only https frames. The
# certificate is trusted IN-PROCESS, for the rig webview only: the rig build calls
# webkit_web_context_allow_tls_certificate_for_host(<this exact cert>, "127.0.0.1")
# (src/rig.rs, compiled only with the "rig" feature). Nothing is installed in any
# trust store, no root or sudo is used, and no TLS-errors policy is relaxed. A SECOND
# server on another port presents a DIFFERENT self-signed certificate for 127.0.0.1;
# the webview must refuse it (the control: trusting is per certificate, not per host).
# If the webview does not trust the fixture the embeds report nothing and the rig FAILS.
mkdir -p "$OUT/embedsrv"; cp rig/embed.html "$OUT/embedsrv/embed.html"
mkcert() { # prefix
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 -subj /CN=127.0.0.1 \
    -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" -keyout "$OUT/$1.key" -out "$OUT/$1.crt" 2>/dev/null \
    || { echo "FAIL: openssl cannot make the $1 certificate" >&2; exit 1; }
}
freeport() { $PY -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }
mkcert embed; mkcert rogue
PORT=$(freeport); RPORT=$(freeport); HPORT=$(freeport)
$PY rig/embedsrv.py "$OUT/embedsrv" "$OUT/embed.crt" "$OUT/embed.key" "$PORT" >/dev/null 2>"$OUT/embed-server.log" &
EMBED_PID=$!
$PY rig/embedsrv.py "$OUT/embedsrv" "$OUT/rogue.crt" "$OUT/rogue.key" "$RPORT" >/dev/null 2>"$OUT/rogue-server.log" &
ROGUE_PID=$!
# plain http, the same fixture: the d4 row's frame, which must never load in a genuine document
$PY rig/embedsrv.py "$OUT/embedsrv" - - "$HPORT" >/dev/null 2>"$OUT/plain-server.log" &
PLAIN_PID=$!
trap 'kill $EMBED_PID $ROGUE_PID $PLAIN_PID 2>/dev/null' EXIT
export BENTO_RIG_EMBED_URL="https://127.0.0.1:$PORT/embed.html"
export BENTO_RIG_ROGUE_URL="https://127.0.0.1:$RPORT/embed.html"
export BENTO_RIG_EMBED_CERT="$OUT/embed.crt"
export BENTO_RIG_PLAIN_URL="http://127.0.0.1:$HPORT/embed.html"
CURL="curl"
if [ "$WIN" = 1 ]; then
  CURL="curl --ssl-no-revoke"
  # the rig build trusts the embed certificate in-process (src/rig.rs), as on Linux
  WV2=$(powershell -NoProfile -ExecutionPolicy Bypass -File rig/wv2version.ps1 | tr -d '\r') || exit 1
  echo "WebView2 runtime: $WV2"
fi
for i in $(seq 1 50); do $CURL -fsS --cacert "$OUT/embed.crt" -o "$OUT/embed-preflight.html" -D "$OUT/embed-preflight.hdr" "$BENTO_RIG_EMBED_URL" 2>/dev/null && break; sleep 0.2; done
if ! grep -q "rig-embed-fixture" "$OUT/embed-preflight.html" 2>/dev/null || ! grep -qi '^content-type: text/html' "$OUT/embed-preflight.hdr" 2>/dev/null; then
  echo "FAIL: the embed fixture is not being served as text/html at $BENTO_RIG_EMBED_URL" >&2; exit 1
fi
# the rogue server must be ALIVE (its own certificate verifies with its own cert), or "refused" below proves nothing
for i in $(seq 1 50); do $CURL -fsS --cacert "$OUT/rogue.crt" -o "$OUT/rogue-preflight.html" "$BENTO_RIG_ROGUE_URL?preflight" 2>/dev/null && break; sleep 0.2; done
grep -q "rig-embed-fixture" "$OUT/rogue-preflight.html" 2>/dev/null || { echo "FAIL: the rogue-certificate server is not serving at $BENTO_RIG_ROGUE_URL" >&2; exit 1; }
# the two certificates really differ
[ "$(openssl x509 -in "$OUT/embed.crt" -noout -fingerprint -sha256)" != "$(openssl x509 -in "$OUT/rogue.crt" -noout -fingerprint -sha256)" ] || { echo "FAIL: the rogue certificate is the trusted one" >&2; exit 1; }
echo "embed fixture served at $BENTO_RIG_EMBED_URL (rogue-certificate twin at $BENTO_RIG_ROGUE_URL)"
BENTO_HISTORIES_DIR="$OUT/hist" cargo build -q --features rig || exit 1
BIN=target/debug/bento-home-desktop
[ "$WIN" = 1 ] && BIN=$BIN.exe
# The Windows capability pattern under Tauri's own matcher.
BENTO_HISTORIES_DIR="$OUT/hist" cargo test -q --features rig --test capabilities >"$OUT/capabilities-test.txt" 2>&1; echo "$?" >"$OUT/capabilities-test.exit"
# POSITIVE CONTROL for the release gate: the binary just built has the test-only TLS trust
# in it, so the same check release-check.sh runs on a shipped build MUST fail here.
if ./gate-binary.sh "$BIN" >"$OUT/gate-control.txt" 2>&1; then echo "gate-control PASSED a rig build" >>"$OUT/gate-control.txt"; echo 1 >"$OUT/gate-control.exit"; else echo 0 >"$OUT/gate-control.exit"; fi
# And per needle: a file holding only that needle is refused, and a file holding none passes.
# A needle that stopped matching (a regex, a typo) would otherwise hide behind the others.
: > "$OUT/gate-needles.txt"
printf 'nothing to see\n' > "$OUT/gate-clean.bin"
if ./gate-binary.sh "$OUT/gate-clean.bin" >/dev/null 2>&1; then echo "clean passes" >> "$OUT/gate-needles.txt"; else echo "clean REFUSED" >> "$OUT/gate-needles.txt"; fi
./gate-binary.sh --needles | tr -d '\r' | while IFS= read -r n; do
  printf 'xx%sxx\n' "$n" > "$OUT/gate-one.bin"
  if ./gate-binary.sh "$OUT/gate-one.bin" >/dev/null 2>&1; then echo "MISSED ${n:0:24}" >> "$OUT/gate-needles.txt"; else echo "caught ${n:0:24}" >> "$OUT/gate-needles.txt"; fi
done
# What the rig build really compiled in (Windows: the rig capabilities too), and capcheck's positive control.
needles_in() { $PY -c "import sys;b=open(sys.argv[1],'rb').read();print([n for n in ('rig-embed','allow-rig','127.0.0.1:*') if n.encode() in b])" "$1"; }
needles_in "$BIN" > "$OUT/rig-binary-needles.txt"
cp "$(ls -t target/debug/build/bento-home-desktop-*/out/capabilities.json | head -1)" "$OUT/rig-capabilities.json"
$PY capcheck.py "$OUT/rig-capabilities.json" >"$OUT/capcheck-control.txt" 2>&1; echo "$?" >"$OUT/capcheck-control.exit"
$PY - "$OUT/fix" <<'PY'
import sys, pathlib
out = pathlib.Path(sys.argv[1]); src = pathlib.Path('../../fixtures/gate1/served')
def make(name, fixture, doc_id):
    t = (src / fixture).read_text(encoding='utf-8')
    a = 'id="bento-doc">{'
    assert t.count(a) == 1, fixture
    (out / name).write_text(t.replace(a, a + f'"docId":"{doc_id}",'), encoding='utf-8')
make('A.bento.html', 'genuine-1.0.0.html', 'rig-a')         # genuine, pinned CSP
make('B.bento.html', 'genuine-1.2.0.html', 'rig-b')         # genuine, another release
make('U.bento.html', 'extra-plain-script.html', 'rig-u')    # unknown: no CSP
PY
procs() { # max web processes seen while the scenario runs (WebKit web processes; WebView2 renderers)
  local max=0 n; while kill -0 "$1" 2>/dev/null; do
    if [ "$WIN" = 1 ]; then n=$($PY rig/webprocs.py count | tr -d '\r'); else n=$(ps -eo comm | grep -c '^WebKitWebProces'); fi
    [ "$n" -gt "$max" ] && max=$n; sleep 0.5; done; echo "$max"
}
hostgone() { [ "$WIN" = 1 ] && taskkill //F //IM bento-home-desktop.exe >/dev/null 2>&1; true; } # a scenario's host never outlives it
scenario() { # name timeout files...
  local name=$1 t=$2; shift 2
  local env=() n=0
  for f in "$@"; do env+=("BENTO_PROBE_doc$n=$OUT/$name-doc$n.json"); n=$((n+1)); done
  mkdir -p "$OUT/$name-data"
  env "${env[@]}" BENTO_DATA_DIR="$OUT/$name-data" timeout "$t" "$BIN" "$@" >/dev/null 2>"$OUT/$name.log" &
  local pid=$!
  procs "$pid" > "$OUT/$name.procs"
  wait "$pid"; local rc=$?; hostgone; echo "$rc" > "$OUT/$name.exit"; echo "== $name exit $rc (web processes seen: $(cat "$OUT/$name.procs"))"
}
cp "$OUT/fix/A.bento.html" "$OUT/fix/U.bento.html" "$OUT/"; cp "$OUT/fix/B.bento.html" "$OUT/B.bento.html"
cp "$OUT/fix/U.bento.html" "$OUT/U2.bento.html"
scenario pair 120 "$OUT/A.bento.html" "$OUT/U.bento.html"
scenario tri 150 "$OUT/B.bento.html" "$OUT/U2.bento.html" "$OUT/B.bento.html"
# The same pair on ONE shared profile: the per-document ORIGIN is then the only thing
# separating storage, cookies and channels (check.py asserts the profile really was shared).
cp "$OUT/fix/A.bento.html" "$OUT/SA.bento.html"; cp "$OUT/fix/U.bento.html" "$OUT/SU.bento.html"
BENTO_RIG_SHARED_PROFILE=1 scenario pairshared 120 "$OUT/SA.bento.html" "$OUT/SU.bento.html"
# B1, §19e d1/d4: blocked navigations, a live embed navigating, and a frame sent to plain http,
# on a genuine and an unknown document. Every row is a real save through the host.
cp "$OUT/fix/A.bento.html" "$OUT/NA.bento.html"; cp "$OUT/fix/U.bento.html" "$OUT/NU.bento.html"
BENTO_RIG_MODE=navlock BENTO_RIG_LINGER_MS=500 scenario navlock 120 "$OUT/NA.bento.html" "$OUT/NU.bento.html"
# A document that moved its own fragment, then reloads. Genuine only: the reload stall on a page
# with no CSP has no watchdog from a fragment URL (see on_navigation), and this row is about the URL.
cp "$OUT/fix/A.bento.html" "$OUT/FA.bento.html"
BENTO_RIG_MODE=fragment BENTO_RIG_LINGER_MS=200 scenario fragment 40 "$OUT/FA.bento.html"
# B2, security's mk2.py: an unknown document racing a genuine shell over its own file during its
# own reload. Each attempt is its own launch. The timing is the attacker's: each (delay, padding)
# lands the swap somewhere else, so the row is the whole grid, and check.py requires that the
# race was really won at least once or the grid proved nothing.
$PY - "$OUT" <<'PY'
import sys, pathlib
out = pathlib.Path(sys.argv[1]); u = (out / 'fix/U.bento.html').read_text(encoding='utf-8')
for mb in (0, 1, 4):
    (out / f'race-pad{mb}.html').write_text(u + '<!--' + 'p' * (mb << 20) + '-->\n', encoding='utf-8')
PY
race() { # tag mode delay padding
  cp "$OUT/race-pad$4.html" "$OUT/$1.bento.html"
  BENTO_RIG_MODE=$2 BENTO_RIG_RACE_DELAY=$3 BENTO_RIG_RACE_G="$OUT/fix/A.bento.html" BENTO_RIG_LINGER_MS=200 scenario "$1" 25 "$OUT/$1.bento.html"
}
n=0; for s in "1 0" "1 1" "2 1" "3 1" "5 1" "2 4" "5 4" "10 4" "20 4" "0 4"; do set -- $s; race "race$n" race "$1" "$2"; n=$((n+1)); done
race resave resave 0 0
# A load with no document serve: the document goes back through its history (see runRestore).
race restore restore 0 0
# B3's negative control: the same read with the header at ?0
cp "$OUT/fix/U.bento.html" "$OUT/O.bento.html"
BENTO_RIG_MODE=oac BENTO_RIG_LINGER_MS=200 BENTO_RIG_OAC_OFF=1 scenario oacoff 30 "$OUT/O.bento.html"
cp "$OUT/fix/A.bento.html" "$OUT/W.bento.html"
BENTO_RIG_WATCHDOG=1 scenario watchdog 90 "$OUT/W.bento.html"
# the same on an UNKNOWN document: no CSP, so a fetch can reach the protocol handler
cp "$OUT/fix/U.bento.html" "$OUT/WU.bento.html"
BENTO_RIG_WATCHDOG=1 scenario watchdogu 90 "$OUT/WU.bento.html"
# the REAL release: the published shell, served genuine, booted, saved by the
# runtime's own serializer through the bridge
cp "$OUT/real/Bento_Slides.bento.html" "$OUT/R.bento.html"
scenario real 150 "$OUT/R.bento.html"
# §19h wedge isolation: two documents each counting a heartbeat through the
# host; rig/wedge.py stops their web processes one at a time (exactly one
# document may freeze) and then all at once (the negative control: both freeze)
cp "$OUT/fix/A.bento.html" "$OUT/wA.bento.html"; cp "$OUT/fix/U.bento.html" "$OUT/wU.bento.html"
mkdir -p "$OUT/hb" "$OUT/wedge-data"
BENTO_RIG_WEDGE=1 BENTO_HB_DIR="$OUT/hb" BENTO_PROBE_doc0="$OUT/wedge-doc0.json" BENTO_PROBE_doc1="$OUT/wedge-doc1.json" \
  BENTO_DATA_DIR="$OUT/wedge-data" timeout 150 "$BIN" "$OUT/wA.bento.html" "$OUT/wU.bento.html" >/dev/null 2>"$OUT/wedge.log" &
WPID=$!
timeout 120 $PY rig/wedge.py "$OUT" "$WPID"
# a stopped process must never outlive the rig
[ "$WIN" = 1 ] || for c in $(ps -o pid= --ppid "$WPID" 2>/dev/null); do kill -CONT "$c" 2>/dev/null; done
kill "$WPID" 2>/dev/null; wait "$WPID" 2>/dev/null; hostgone
echo "== wedge done"
# the saved file against the release key ONLY (hostcore's release_check), and a
# one-byte-changed copy of it
$PY - "$OUT" <<'PY'
import sys, pathlib
out = pathlib.Path(sys.argv[1]); b = bytearray((out / "R.bento.html").read_bytes())
i = b.find(b'id="bento-rt"'); j = b.find(b'>', i) + 50
b[j] = ord('B') if b[j] == ord('A') else ord('A')
(out / "R-flipped.bento.html").write_bytes(bytes(b))
PY
( cd ../hostcore && cargo run -q --example release_check -- "$OUT/real" --genuine "$OUT/R.bento.html" --unknown "$OUT/R-flipped.bento.html" ) > "$OUT/real-release-check.txt" 2>&1; echo "$?" > "$OUT/real-release-check.exit"
# LAST, Windows only: the ACL that ships, on a rig build without rig-embed.json (the rig needs
# its own commands to report, but no embed is admitted). It replaces the rig binary, so nothing
# runs after it.
if [ "$WIN" = 1 ]; then
  BENTO_RIG_SHIPPED_ACL=1 BENTO_HISTORIES_DIR="$OUT/hist" cargo build -q --features rig || exit 1
  needles_in "$BIN" > "$OUT/acl-binary-needles.txt"
  cp "$(ls -t target/debug/build/bento-home-desktop-*/out/capabilities.json | head -1)" "$OUT/acl-capabilities.json"
  cp "$OUT/fix/A.bento.html" "$OUT/AC.bento.html"; cp "$OUT/fix/U.bento.html" "$OUT/AU.bento.html"
  BENTO_RIG_MODE=acl BENTO_RIG_LINGER_MS=200 scenario acl 60 "$OUT/AC.bento.html" "$OUT/AU.bento.html"
fi
$PY rig/check.py "$OUT" $([ "$WIN" = 1 ] && echo windows || echo linux)
