// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// What the tripwire watches, where it reads the signed release list, and the
// key that list must be signed with. Constants, with no runtime override: a
// setting a page or a message could change is a way to point the tripwire at
// a list someone else signed. The browser rig swaps this FILE in its own copy
// of the extension (scripts/test-webext-tripwire-browser.mjs), and
// scripts/test-webext-tripwire.ts pins the shipped values and checks that
// manifest.json grants exactly these origins and nothing more.

export { RELEASE_KEY as KEY } from './release.js'

/** bento/home in the browser. */
export const LIBRARY_ORIGIN = 'https://home.bento.page'

/**
 * The frame site (home/web/build.mjs --frame-origin). Its domain is the
 * maintainer's to choose and is not chosen yet; until it is named here AND in
 * manifest.json (host_permissions, and the tripwire's content-script matches),
 * the frame page is not checked, and the extension's report says so.
 */
export const FRAME_ORIGINS = []

/** Published with each home/web release, on the release channel (not on home.bento.page). */
export const LIST_URL = 'https://bento.page/releases/home-web/served.json'
