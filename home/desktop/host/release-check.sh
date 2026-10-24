#!/usr/bin/env bash
# The desktop host's release-build check (security: the bundled history must
# verify, cover the shipped release and be the CURRENT published one; the rig
# feature must be absent from a shipped build).
#
#   ./release-check.sh            # fetch, verify, debug build, assert
#   ./release-check.sh --release  # the same with the release profile (packaging)
#
# For each app with a published history (BENTO_APPS, default "slides"), fetches
# releases/<app>/{history.json,manifest.json,<shell>} from bento.page into
# ./releases (gitignored; build.rs embeds only the *history*.json files), runs
# hostcore's release_check against them with the PINNED RELEASE KEY ONLY, then
# builds the host WITHOUT the rig feature and asserts that neither the rig
# commands nor the gate-1 corpus test key are in the binary.
set -euo pipefail
cd "$(dirname "$0")"
BASE=${BENTO_RELEASES_URL:-https://bento.page/releases}
PROFILE=debug; FLAG=""
[ "${1:-}" = "--release" ] && { PROFILE=release; FLAG="--release"; }
rm -rf releases
for a in ${BENTO_APPS:-slides}; do
  mkdir -p "releases/$a"
  curl -fsS -o "releases/$a/history.json" "$BASE/$a/history.json"
  curl -fsS -o "releases/$a/manifest.json" "$BASE/$a/manifest.json"
  shell=$(python3 -c "import json,sys;print(json.loads(json.load(open(sys.argv[1]))['payload'])['url'].rsplit('/',1)[1])" "releases/$a/manifest.json")
  curl -fsS -o "releases/$a/$shell" "$BASE/$a/$shell"
  ( cd ../hostcore && cargo run -q --example release_check -- "../host/releases/$a" )
done
env -u BENTO_HISTORIES_DIR cargo build -q $FLAG
BIN="target/$PROFILE/bento-home-desktop"
for needle in rig_stash rig_done rig_recreate "$(python3 -c "import json;print(json.load(open('../../fixtures/gate1/test-public-key.json'))['x'])")"; do
  if grep -a -q -- "$needle" "$BIN"; then echo "FAIL the shipped binary contains ${needle:0:20}…"; exit 1; fi
done
echo "ok   the $PROFILE binary has no rig commands and no corpus test key"
n=$(find releases -name 'history.json' | wc -l | tr -d ' ')
echo "release check passed: $n app history(ies) bundled into $BIN"
