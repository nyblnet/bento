#!/usr/bin/env bash
# The PRF interop rig (security §34), Linux. One virtual OpenSK key
# (agent-testkit, test-only), an independent WebAuthn client (python-fido2),
# and the agent's libfido2 layer must agree byte for byte; then each mutant
# build must FAIL that test ON THE COMPARISON.
#
# BENTO_RIG_IN_CONTAINER=1: a privileged container (mount devtmpfs, start
# udevd, run as root). Otherwise a CI VM with sudo: load uhid, run only the
# virtual key as root, and open its hidraw node to this user.
set -euo pipefail
cd "$(dirname "$0")"
if [ "${BENTO_RIG_IN_CONTAINER:-}" = 1 ]; then
  mount -t devtmpfs none /dev
  /lib/systemd/systemd-udevd --daemon >/dev/null 2>&1
  SUDO=""
else
  sudo modprobe uhid
  SUDO="sudo"
fi
# Build first (synchronously: a cold nightly build outlasts any wait).
( cd ../agent-testkit && cargo build -q )
cargo build -q --features fido --tests
$SUDO ../agent-testkit/target/debug/bento-agent-testkit 2>/tmp/kit.log &
dev=""
for i in $(seq 1 30); do
  dev=$(grep -l "HID_ID=0003:00001209:0000BE71" /sys/class/hidraw/*/device/uevent 2>/dev/null | head -1 | sed -E 's#/sys/class/hidraw/([^/]+)/.*#/dev/\1#') || true
  [ -n "$dev" ] && [ -e "$dev" ] && break; sleep 1
done
[ -n "$dev" ] && [ -e "$dev" ] || { cat /tmp/kit.log; echo "FAIL: the virtual key never appeared"; exit 1; }
[ -n "$SUDO" ] && sudo chmod a+rw "$dev"
command -v udevadm >/dev/null && udevadm trigger 2>/dev/null || true; sleep 1
# Isolated (-I): no user site-packages, no PYTHONPATH. On CI the pinned
# python-fido2 lives in a venv (BENTO_RIG_PYTHON), whose own site-packages -I
# keeps; a plain user-site install is invisible to -I (the first CI run failed
# exactly so).
"${BENTO_RIG_PYTHON:-python3}" -I ../agent-testkit/prf_client.py /tmp/rig.json
export BENTO_FIDO_RIG=/tmp/rig.json
out=$(cargo test --features fido --test fido_interop 2>&1) || { echo "$out"; exit 1; }
echo "$out" | grep -qE "test result: ok\. 1 passed" || { echo "$out"; echo "FAIL: the interop test did not run"; exit 1; }
echo "interop: PASS (agent == python-fido2)"
for m in rig-mutant-double-hash rig-mutant-raw-hash; do
  mout=$(cargo test --features "$m" --test fido_interop 2>&1) && { echo "FAIL: mutant $m was NOT caught"; exit 1; }
  echo "$mout" | grep -q "equals the independent WebAuthn client" || { echo "$mout" | tail -20; echo "FAIL: mutant $m failed for the wrong reason"; exit 1; }
  echo "mutant $m: caught on the PRF comparison"
done
