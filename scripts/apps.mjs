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
    /**
     * How this app's git tag and GitHub release are named.
     *
     * Slides keeps the bare `vX.Y.Z` it has used for 23 releases; every other
     * app is PREFIXED, because apps version independently and an unprefixed
     * `v0.2.0` would sort into the middle of slides' history and claim a
     * version slides can never use again (docs/RELEASING.md).
     *
     * `label` titles the GitHub release. A page titled `v1.0.12` does not say
     * which of three apps the file below it is — the six releases cut before
     * this was automated had to be retitled by hand on 2026-07-27.
     */
    tagPrefix: '',
    label: 'bento/slides',
    /** the whole bento.page site — landing, gallery, guides — is slides-derived today */
    ownsSiteContent: true,
    /** where this app's release notes come from. The notes ride in the SIGNED
     *  manifest and are what a reader sees when offered an update, so an app
     *  reading another app's changelog would tell every one of its users about
     *  changes to a different product. */
    changelog: 'CHANGELOG.md',
    /** published at /<dir>/agents.md — the runnable half of "designed for AI" */
    agents: 'docs/agents.md',
    /** signed language packs exist for this app (docs/i18n-packs.md) */
    packs: true,
  },
  spaces: {
    appId: 'bento-spaces',
    dir: 'spaces',
    shell: 'Bento_Spaces.bento.html',
    tagPrefix: 'spaces-',
    label: 'bento/spaces',
    ownsSiteContent: false,
    // No pack catalog yet: build-i18n/sign-packs are slides-hardcoded and the
    // channel does not exist. Deferring packs is fine; deferring the CHANNEL
    // would not be (working/design/spaces-design.md §6.5).
    packs: false,
    changelog: 'spaces/CHANGELOG.md',
    agents: 'docs/spaces-agents.md',
  },
  /** REGISTERED BEFORE IT SHIPS, deliberately — dash has no release and nothing
   *  published at /releases/dash/. Being here is not a claim that it shipped:
   *  `release.mjs` defaults to `--app slides`, so cutting a dash release takes
   *  an explicit `--app dash`. What the entry buys is that
   *  `test-release-apps.mjs` proves the wiring — manifest URL, changelog shape,
   *  unique appId — on every CI run instead of at release time, which is this
   *  registry's entire reason for existing. Its status for readers is in
   *  `dash/README.md`. */
  dash: {
    appId: 'bento-dash',
    dir: 'dash',
    shell: 'Bento_Dash.bento.html',
    tagPrefix: 'dash-',
    label: 'bento/dash',
    ownsSiteContent: false,
    // Same reasoning as spaces: no pack catalog yet, and deferring the CATALOG
    // is fine where deferring the CHANNEL would not be.
    packs: false,
    changelog: 'dash/CHANGELOG.md',
  },
}

/** The git tag and GitHub release name for a version of an app. */
export const tagFor = (app, version) => `${app.tagPrefix ?? ''}v${version}`

/**
 * How a staged `site/` records WHICH app assembled it.
 *
 * publish-site.mjs has to know: it creates the GitHub release, and the tag,
 * the title, the changelog and the attached shell are all per app. Passing
 * `--app` by hand would work right up until someone forgets it, and the
 * failure is silent — the publish would look for slides' tag, find the release
 * that already exists, and report success while the app just released got no
 * GitHub release at all. So release.mjs writes this and publish-site reads it;
 * `--app` stays as an override for a publish that is not following a release.
 *
 * NEVER MIRRORED. It is local staging state, not site content — publish-site
 * excludes it from the rsync (and from the deletion inventory with it).
 */
export const RELEASE_MARKER = '.bento-release.json'
