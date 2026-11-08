# Bundled release histories

`<app>.json` here is that app's signed release history, `releases/<app>/history.json`
from the site, copied in after each release. The app checks documents against it
(gate 1), and it's the anti-rollback floor for any copy fetched later.

A release build fails unless every app published in the site clone has its
current history here (`scripts/check-ios-release-history.mjs`). Debug builds
only warn.
