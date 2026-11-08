# SPDX-License-Identifier: MIT
# Copyright (c) 2026 The Bento authors
#
# The capability set a build compiled in, asserted exactly (release-check.sh; rig/run.sh
# runs it on a rig build as the positive control, where it must fail on Windows). Windows
# ships one file with two commands; every other platform ships none. Anything added,
# widened or renamed fails here, including a rig file that reached a shipped build.
#   capcheck.py <OUT_DIR>/capabilities.json
import json, pathlib, sys

caps = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
source = json.loads(pathlib.Path(__file__).with_name("capabilities-windows").joinpath("documents.json").read_text(encoding="utf-8"))
# what must ship, restated here on purpose: an edit to the file alone fails
want = {"local": False, "windows": ["doc*"], "remote": {"urls": ["http://bento.:h([0-9a-f]{24}).localhost/"]},
        "permissions": ["allow-bento-arm", "allow-bento-file"]}
if sys.platform != "win32":
    if caps:
        sys.exit(f"FAIL this platform ships no capability file, and the build has {sorted(caps)}")
    print("ok   no capability file in this build")
    sys.exit(0)
if sorted(caps) != ["documents"]:
    sys.exit(f"FAIL the build's capabilities are {sorted(caps)}, not exactly [documents]")
for name, got in (("the build", caps["documents"]), ("documents.json", source)):
    for k, v in want.items():
        if got.get(k) != v:
            sys.exit(f"FAIL {name}: {k} is {got.get(k)!r}, not {v!r}")
    extra = set(got) - set(want) - {"$schema", "identifier", "description", "webviews", "platforms"}
    if extra or got.get("webviews") or got.get("platforms"):
        sys.exit(f"FAIL {name}: unexpected fields {sorted(extra)}, webviews {got.get('webviews')}, platforms {got.get('platforms')}")
print("ok   the build's capabilities are exactly documents.json: bento_arm and bento_file, on the document origins")
