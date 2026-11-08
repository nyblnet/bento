#!/usr/bin/env bash
# The shipped-build gate: exits 1 if the binary carries anything that exists only
# for the rigs. Used by release-check.sh on the release build, and by rig/run.sh as
# a POSITIVE CONTROL on the rig build (where it must fail, or the gate sees nothing).
#   ./gate-binary.sh <binary>
#   ./gate-binary.sh --needles   # one needle per line, for the rig's per-needle controls
set -u
cd "$(dirname "$0")"
# rig commands; the rig's env switches; the gate-1 corpus test key; the test-only TLS trust of
# the rig's throwaway embed certificate (webkit_web_context_allow_tls_certificate_for_host and
# the env var naming that certificate); and the rig capabilities (Windows). A leaked rig-embed
# capability brings no rig command with it, so it has needles of its own: its identifier and
# the loopback origin it opens. Security: never in a release host.
needles() {
  printf '%s\n' rig_stash rig_done rig_recreate rig_session rig_skew rig_answers rig_provision rig_counts rig_gate rig_bus BENTO_RIG_REALSTORE BENTO_RIG_SHARED_PROFILE BENTO_RIG_OAC_OFF BENTO_RIG_EMBED_CERT \
    allow_tls_certificate_for_host rig-embed allow-rig '127.0.0.1:*' \
    "$("${PY:-python3}" -c "import json;print(json.load(open('../../fixtures/gate1/test-public-key.json'))['x'])")"
}
[ "${1:-}" = "--needles" ] && { needles; exit 0; }
BIN=$1
LIST=$(needles | tr -d '\r')
# a needle that failed to build (an empty line) must not pass as "not found"
if printf '%s\n' "$LIST" | grep -q '^$'; then echo "FAIL a needle is empty"; exit 1; fi
# -F: `127.0.0.1:*` is a literal
while IFS= read -r needle; do
  if grep -a -q -F -- "$needle" "$BIN"; then echo "FAIL the binary contains ${needle:0:40}…"; exit 1; fi
done <<< "$LIST"
# and what must be there on Linux: a build without the watcher could never sign, or (if the
# gate were ever defaulted open) would go on signing through a lock
if [ "$(uname -s)" = Linux ]; then
  grep -a -q -- "org.freedesktop.login1" "$BIN" || { echo "FAIL the binary has no logind watcher"; exit 1; }
fi
echo "ok   the binary has no rig commands, no rig capability, no corpus test key and no test-only TLS trust"
