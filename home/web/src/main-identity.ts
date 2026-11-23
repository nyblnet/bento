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
//
// The status is asked again before every hourly check-in, so a build
// withdrawn while its tabs are open stops at the next hour, not at the next
// load. A check-in (on load or hourly) runs only when the release channel
// answered: a network that blocks bento.page and lets id.bento.page through
// cannot keep a withdrawn build checking in (security ruling 985, M2).
import { ready, onStopped } from './library.ts'
import { recheckStatus, statusAnswered } from './offline.ts'
import { startIdentity, stopIdentity } from './identity-ui.ts'

onStopped(stopIdentity)
void ready.then((go) => { if (go) startIdentity({ onLoad: statusAnswered, hourly: async () => (await recheckStatus()) === 'run' }) })
