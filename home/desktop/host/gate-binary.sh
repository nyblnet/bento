#!/usr/bin/env bash
# The shipped-build gate: exits 1 if the binary carries anything that exists only
# for the rigs. Used by release-check.sh on the release build, and by rig/run.sh as
# a POSITIVE CONTROL on the rig build (where it must fail, or the gate sees nothing).
#   ./gate-binary.sh <binary>
set -u
cd "$(dirname "$0")"
BIN=$1
# rig commands; the gate-1 corpus test key; the test-only TLS trust of the rig's
# throwaway embed certificate (webkit_web_context_allow_tls_certificate_for_host and
# the env var naming that certificate) -- security: never in a release host
for needle in rig_stash rig_done rig_recreate rig_session rig_skew rig_answers rig_provision rig_counts rig_gate rig_bus BENTO_RIG_REALSTORE BENTO_RIG_EMBED_CERT allow_tls_certificate_for_host \
              "$(python3 -c "import json;print(json.load(open('../../fixtures/gate1/test-public-key.json'))['x'])")"; do
  if grep -a -q -- "$needle" "$BIN"; then echo "FAIL the binary contains ${needle:0:40}…"; exit 1; fi
done
# and what must be there: a build without the watcher could never sign, or (if the
# gate were ever defaulted open) would go on signing through a lock
grep -a -q -- "org.freedesktop.login1" "$BIN" || { echo "FAIL the binary has no logind watcher"; exit 1; }
echo "ok   the binary has no rig commands, no corpus test key and no test-only TLS trust"
