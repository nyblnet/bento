#!/usr/bin/env bash
# Security's ruling on #893: a machine locked or asleep must stop signing, and a
# host that cannot hear logind must not sign at all. Runs the REAL host (rig
# feature) with a genuine document against rig/fakelogind.py on a private system
# bus, and asserts with rig/check-lock.py. A timeout or a missing report FAILS.
#   ./rig/lock-rig.sh <out>        Needs: a display (xvfb-run), dbus-daemon, python3-gi.
set -u
cd "$(dirname "$0")/.."
OUT=${1:-/tmp/lock-rig}
rm -rf "$OUT"; mkdir -p "$OUT/hist/corpus" "$OUT/bus"
cp ../../fixtures/gate1/history.json "$OUT/hist/corpus/history.json"
BENTO_HISTORIES_DIR="$OUT/hist" cargo build -q --features rig || exit 1
BIN=target/debug/bento-home-desktop
python3 - "$OUT" <<'PY'
import sys, pathlib
t = pathlib.Path('../../fixtures/gate1/served/genuine-1.0.0.html').read_text(encoding='utf-8')
a = 'id="bento-doc">{'
assert t.count(a) == 1
pathlib.Path(sys.argv[1], 'L.bento.html').write_text(t.replace(a, a + '"docId":"rig-lock",'), encoding='utf-8')
PY
. rig/fakebus.sh
trap 'kill ${FAKE_LOGIND_PID:-} ${FAKE_BUS_PID:-} 2>/dev/null' EXIT
scenario() { # name mode timeout
  mkdir -p "$OUT/$1-data"
  BENTO_RIG_MODE=$2 BENTO_PROBE_doc0="$OUT/$1.json" BENTO_DATA_DIR="$OUT/$1-data" timeout "$3" "$BIN" "$OUT/L.bento.html" >/dev/null 2>"$OUT/$1.log"
  rc=$?; echo "$rc" >"$OUT/$1.exit"; echo "== $1 exit $rc"
}
fakebus_start "$OUT/bus"
BENTO_RIG_BUSDOWN="$OUT/busdown.json" scenario lock lock 90
fakebus_stop
fakebus_start "$OUT/bus" --locked
scenario lockstart lock-start 60
fakebus_stop
# no bus at all: the address names a socket nothing listens on
DBUS_SYSTEM_BUS_ADDRESS="unix:path=$OUT/no-such-socket" scenario nobus lock-nobus 60
python3 rig/check-lock.py "$OUT"
