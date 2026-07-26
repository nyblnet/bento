#!/bin/bash
# Build, install and launch on a chosen simulator or physical device.
# Usage: ./run.sh [udid]           (TEAM=YOURTEAMID required for physical devices)
set -e
cd "$(dirname "$0")"

[ -f Bento/Resources/bento.html ] || ../scripts/fetch-deck.sh

APP_ID=slides.bento.app
PROJECT=Bento.xcodeproj
TARGET=Bento

# Collect targets as "kind|udid|label" — booted simulators first, then physical devices.
entries=()
while IFS= read -r line; do [ -n "$line" ] && entries+=("$line"); done < <(
    xcrun simctl list devices available --json | python3 -c '
import json, sys
data = json.load(sys.stdin)
rows = []
for runtime, devs in data["devices"].items():
    ver = runtime.rsplit(".", 1)[-1].replace("iOS-", "iOS ").replace("-", ".")
    for d in devs:
        if "iPhone" in d["name"] or "iPad" in d["name"]:
            booted = d["state"] == "Booted"
            rows.append((not booted, "sim|%s|%s (%s)%s" % (
                d["udid"], d["name"], ver, " [booted]" if booted else "")))
rows.sort()
print("\n".join(r[1] for r in rows))'

    tmp=$(mktemp)
    if xcrun devicectl list devices --json-output "$tmp" >/dev/null 2>&1; then
        python3 -c '
import json, sys
data = json.load(open(sys.argv[1]))
for d in data.get("result", {}).get("devices", []):
    name = d.get("deviceProperties", {}).get("name", "device")
    udid = d.get("identifier")
    if udid:
        print("dev|%s|%s [physical]" % (udid, name))' "$tmp"
    fi
    rm -f "$tmp"
)

if [ ${#entries[@]} -eq 0 ]; then
    echo "No simulators or devices found."
    exit 1
fi

if [ -n "$1" ]; then
    choice=""
    for e in "${entries[@]}"; do
        case "$e" in *"|$1|"*) choice="$e" ;; esac
    done
    if [ -z "$choice" ]; then echo "UDID $1 not found."; exit 1; fi
else
    echo "Available targets:"
    labels=()
    for e in "${entries[@]}"; do labels+=("${e#*|*|}"); done
    select l in "${labels[@]}"; do choice="${entries[$((REPLY-1))]}"; break; done
fi

kind="${choice%%|*}"; rest="${choice#*|}"; udid="${rest%%|*}"; label="${rest#*|}"
echo "Target: $label ($udid)"

if [ "$kind" = "sim" ]; then
    xcodebuild -project "$PROJECT" -target "$TARGET" -configuration Debug \
        -sdk iphonesimulator build CODE_SIGNING_ALLOWED=NO -quiet
    xcrun simctl boot "$udid" 2>/dev/null || true
    open -a Simulator
    xcrun simctl install "$udid" "build/Debug-iphonesimulator/$TARGET.app"
    xcrun simctl launch "$udid" "$APP_ID"
else
    if [ -z "$TEAM" ]; then
        echo "Physical device needs a signing team: make run TEAM=YOURTEAMID"
        exit 1
    fi
    xcodebuild -project "$PROJECT" -target "$TARGET" -configuration Debug \
        -destination "id=$udid" -allowProvisioningUpdates \
        DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic build -quiet
    xcrun devicectl device install app --device "$udid" "build/Debug-iphoneos/$TARGET.app"
    xcrun devicectl device process launch --device "$udid" "$APP_ID"
fi
echo "Launched $APP_ID on $label"
