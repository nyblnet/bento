#!/bin/bash
# Build, install and launch the debug APK on a chosen device/emulator.
# Usage: ./run.sh [adb-serial]
set -e
cd "$(dirname "$0")"

[ -f app/src/main/assets/bento.html ] || ../scripts/fetch-deck.sh

JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
ADB="$HOME/Library/Android/sdk/platform-tools/adb"
APP_ID=slides.bento.app

devices=()
while IFS= read -r line; do devices+=("$line"); done < <(
    "$ADB" devices | awk 'NR>1 && $2=="device" {print $1}'
)

if [ -n "$1" ]; then
    serial="$1"
elif [ ${#devices[@]} -eq 0 ]; then
    echo "No devices/emulators connected. Start an emulator or plug in a device."
    echo "  (list: $ADB devices)"
    exit 1
elif [ ${#devices[@]} -eq 1 ]; then
    serial="${devices[0]}"
    echo "Using only connected device: $serial"
else
    echo "Connected devices:"
    select d in "${devices[@]}"; do serial="$d"; break; done
fi

JAVA_HOME="$JAVA_HOME" ./gradlew -q assembleDebug
"$ADB" -s "$serial" install -r app/build/outputs/apk/debug/app-debug.apk
"$ADB" -s "$serial" shell am start -n "$APP_ID/.MainActivity"
echo "Launched $APP_ID on $serial"
