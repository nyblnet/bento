#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The app registry the release pipeline builds from.
//
// Its own module so `scripts/test-release-apps.mjs` can check it against the
// tree without running a release — a release signs, and the signing key never
// leaves the maintainer's machine (docs/RELEASING.md), so the pipeline itself
// is not CI-testable. The registry drifting from reality IS: renaming an app's
// build output would otherwise surface as a failed release, mid-release.

/**
 * The apps this site publishes. One release builds exactly ONE of them.
 *
 * `appId` must match the shell's own `configureApp({appId})` — a shipped file
 * verifies it against the manifest and refuses an update signed for another
 * app, so a mismatch ships a channel every file silently declines.
 */
export const APPS = {
  slides: {
    appId: 'bento-slides',
    dir: 'slides',
    shell: 'Bento_Slides.bento.html',
    /** the whole bento.page site — landing, gallery, guides — is slides-derived today */
    ownsSiteContent: true,
    /** signed language packs exist for this app (docs/i18n-packs.md) */
    packs: true,
  },
  spaces: {
    appId: 'bento-spaces',
    dir: 'spaces',
    shell: 'Bento_Spaces.bento.html',
    ownsSiteContent: false,
    // No pack catalog yet: build-i18n/sign-packs are slides-hardcoded and the
    // channel does not exist. Deferring packs is fine; deferring the CHANNEL
    // would not be (working/spaces-design.md §6.5).
    packs: false,
  },
  dash: {
    appId: 'bento-dash',
    dir: 'dash',
    shell: 'Bento_Dash.bento.html',
    ownsSiteContent: false,
    // Same reasoning as spaces: no pack catalog yet, and deferring the CATALOG
    // is fine where deferring the CHANNEL would not be.
    packs: false,
  },
}
