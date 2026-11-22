// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The library with bento/id (build.mjs --identity). Without that flag the
// build bundles library.ts alone, and nothing of identity is in the page.
//
// bento/id starts only once the kill switch has answered that this build may
// run ('current', or 'unreachable' offline), and stops with the page: a
// withdrawn or untrusted build, here or in another tab of the same build,
// shows no sign-in line and checks in with no one (security ruling 954, C6).
import { ready, onStopped } from './library.ts'
import { startIdentity, stopIdentity } from './identity-ui.ts'

onStopped(stopIdentity)
void ready.then((go) => { if (go) startIdentity() })
