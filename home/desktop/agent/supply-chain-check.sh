#!/usr/bin/env bash
# Supply-chain checks for the SHIPPED desktop agent (security §34), each with a
# positive control so a check that silently passes everything is caught:
#   1. cargo-deny: licence allow-list + RustSec advisories + sources.
#      Control: an LGPL crate added as a normal dependency must FAIL.
#   2. The test-only authenticator (agent-testkit / OpenSK) is NOT in the
#      shipped dependency graph. Control: adding it as a normal dependency must
#      make this check FAIL.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"

cargo deny --all-features check licenses advisories sources bans
echo "cargo-deny: ok"

shipped() { cargo tree -e normal --all-features --prefix none --manifest-path "$1"; }
absent() { ! shipped "$1" | grep -E -q "^(opensk|bento-agent-testkit|sk-cbor|wasefire-store) "; }
absent Cargo.toml || { echo "FAIL: a test-only crate is in the shipped graph"; exit 1; }
echo "shipped graph: no test-only crates"

# --- positive controls, in a scratch copy -----------------------------------
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/agent" && cp -R Cargo.toml Cargo.lock deny.toml src "$tmp/agent/"
cp -R ../agent-testkit "$tmp/agent-testkit"
( cd "$tmp/agent" && cargo add -q rug@1 --no-default-features >/dev/null 2>&1 )
if ( cd "$tmp/agent" && cargo deny --all-features check licenses >/dev/null 2>&1 ); then
  echo "FAIL: control — an LGPL crate in the normal graph was NOT refused"; exit 1
fi
echo "control: an LGPL crate in the normal graph is refused"
( cd "$tmp/agent" && git -C . init -q 2>/dev/null; cargo remove -q rug >/dev/null 2>&1; cargo add -q --path ../agent-testkit >/dev/null 2>&1 )
if absent "$tmp/agent/Cargo.toml"; then
  echo "FAIL: control — the testkit as a normal dependency was NOT detected"; exit 1
fi
echo "control: the testkit as a normal dependency is detected"
