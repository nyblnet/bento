#!/bin/bash
# Provision the bento.html the native shells bundle as their offline fallback.
# Prefers a locally built single-file (slides/npm run build:single); falls back
# to the latest signed GitHub release. The artifact is gitignored — it is a
# build input, not source.
set -e
cd "$(dirname "$0")/../.."

LOCAL=slides/dist-single/Bento_Slides.bento.html
TARGETS=(
    native/ios/Bento/Resources/bento.html
    native/android/app/src/main/assets/bento.html
)

if [ -f "$LOCAL" ]; then
    SRC="$LOCAL"
    echo "fetch-deck: using locally built $LOCAL"
else
    SRC=$(mktemp)
    URL=$(curl -s https://api.github.com/repos/nyblnet/bento/releases/latest |
        python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(a["browser_download_url"] for a in d["assets"] if a["name"].endswith(".html")))')
    echo "fetch-deck: downloading $URL"
    curl -sL -o "$SRC" "$URL"
    head -c 4096 "$SRC" | grep -q '<!DOCTYPE html>' || {
        echo "fetch-deck: downloaded file does not look like a bento deck" >&2
        exit 1
    }
fi

for t in "${TARGETS[@]}"; do
    mkdir -p "$(dirname "$t")"
    cp "$SRC" "$t"
    echo "fetch-deck: → $t"
done
