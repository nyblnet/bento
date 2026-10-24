#!/usr/bin/env bash
# The H2 host rigs (security §19d–§19h, rig 8) on Linux/WebKitGTK. Builds the
# host with the "rig" feature against the gate-1 corpus history, makes its own
# fixtures from the corpus, runs two multi-window scenarios, and asserts with
# check.py. A scenario that times out or reports nothing FAILS (§19f).
# Needs: a display (xvfb-run) and a D-Bus session; network for the embeds.
set -u
cd "$(dirname "$0")/.."
OUT=${1:-/tmp/h2-rig}
rm -rf "$OUT"; mkdir -p "$OUT/fix"
# Histories: the corpus's (test key, rig builds only) and the REAL slides
# release frozen in the corpus (home/fixtures/gate1/real/slides-1.2.10, signed
# with the release key), so a real deck can be served genuine with no fetch.
# (release-check.sh is what fetches: proving the bundle CURRENT needs the live one.)
mkdir -p "$OUT/hist/corpus" "$OUT/hist/slides"
cp ../../fixtures/gate1/history.json "$OUT/hist/corpus/history.json"
cp -r ../../fixtures/gate1/real/slides-1.2.10 "$OUT/real"
cp "$OUT/real/history.json" "$OUT/hist/slides/history.json"
BENTO_HISTORIES_DIR="$OUT/hist" cargo build -q --features rig || exit 1
BIN=target/debug/bento-home-desktop
python3 - "$OUT/fix" <<'PY'
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
procs() { # max WebKit web processes seen while the scenario runs
  local max=0 n; while kill -0 "$1" 2>/dev/null; do n=$(ps -eo comm | grep -c '^WebKitWebProces'); [ "$n" -gt "$max" ] && max=$n; sleep 0.5; done; echo "$max"
}
scenario() { # name timeout files...
  local name=$1 t=$2; shift 2
  local env=() n=0
  for f in "$@"; do env+=("BENTO_PROBE_doc$n=$OUT/$name-doc$n.json"); n=$((n+1)); done
  mkdir -p "$OUT/$name-data"
  env "${env[@]}" BENTO_DATA_DIR="$OUT/$name-data" timeout "$t" "$BIN" "$@" >/dev/null 2>"$OUT/$name.log" &
  local pid=$!
  procs "$pid" > "$OUT/$name.procs"
  wait "$pid"; local rc=$?; echo "$rc" > "$OUT/$name.exit"; echo "== $name exit $rc (web processes seen: $(cat "$OUT/$name.procs"))"
}
cp "$OUT/fix/A.bento.html" "$OUT/fix/U.bento.html" "$OUT/"; cp "$OUT/fix/B.bento.html" "$OUT/B.bento.html"
cp "$OUT/fix/U.bento.html" "$OUT/U2.bento.html"
scenario pair 120 "$OUT/A.bento.html" "$OUT/U.bento.html"
scenario tri 150 "$OUT/B.bento.html" "$OUT/U2.bento.html" "$OUT/B.bento.html"
cp "$OUT/fix/A.bento.html" "$OUT/W.bento.html"
BENTO_RIG_WATCHDOG=1 scenario watchdog 90 "$OUT/W.bento.html"
# the same on an UNKNOWN document: no CSP, so a fetch can reach the protocol handler
cp "$OUT/fix/U.bento.html" "$OUT/WU.bento.html"
BENTO_RIG_WATCHDOG=1 scenario watchdogu 90 "$OUT/WU.bento.html"
# the REAL release: the published shell, served genuine, booted, saved by the
# runtime's own serializer through the bridge
cp "$OUT/real/Bento_Slides.bento.html" "$OUT/R.bento.html"
scenario real 150 "$OUT/R.bento.html"
# the saved file against the release key ONLY (hostcore's release_check), and a
# one-byte-changed copy of it
python3 - "$OUT" <<'PY'
import sys, pathlib
out = pathlib.Path(sys.argv[1]); b = bytearray((out / "R.bento.html").read_bytes())
i = b.find(b'id="bento-rt"'); j = b.find(b'>', i) + 50
b[j] = ord('B') if b[j] == ord('A') else ord('A')
(out / "R-flipped.bento.html").write_bytes(bytes(b))
PY
( cd ../hostcore && cargo run -q --example release_check -- "$OUT/real" --genuine "$OUT/R.bento.html" --unknown "$OUT/R-flipped.bento.html" ) > "$OUT/real-release-check.txt" 2>&1; echo "$?" > "$OUT/real-release-check.exit"
python3 rig/check.py "$OUT"
