// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// THE SIGNED RELEASE HISTORY (K4, security §36): every release of an app still
// in the wild, with its pins, in one cumulative payload signed by the release
// key. It is what lets a host verify a file saved by ANY genuine release, not
// only the newest, without carrying every shell it trusts.
//
//   releases/<app>/history.json = { payload: "<json>", sig }   (the release envelope)
//   payload = { app, v: 1, releases: [ { version, sha256, at, pins }, ... ] }   newest first
//
// Three rules live here, each the one a host must apply:
//   - nextHistory(): append-only. A history never loses an entry, never changes
//     one, and a new release must be newer than every release it holds.
//   - acceptHistory(): ANTI-ROLLBACK for hosts. A host keeps the newest history
//     it has verified and refuses one that lacks an entry it holds or whose
//     newest version is lower, so a replayed older signed history can't hide a
//     release.
//   - matchRelease(): a file matches a release only if ONE entry matches EVERY
//     block (rt, rt-css, loader, remover) with exactly one block per id. Two
//     releases sharing a runtime can't be confused, and anything partial is
//     UNKNOWN: restricted mode or an update offer, never a borrowed pinned CSP.

// The HOST rules (acceptHistory, matchRelease, historyProblems) are the kernel's
// gate-1 module, one implementation for every JavaScript host (K5). This file
// adds only what SIGNING needs: nextHistory().
import { acceptHistory, matchRelease, historyProblems, cmpVersion } from '../../kernel/src/gate1.ts'
export { acceptHistory, matchRelease, historyProblems, cmpVersion }

export const HISTORY_V = 1

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const entryOk = (e) => e && typeof e.version === 'string' && SEMVER.test(e.version) &&
  /^[0-9a-f]{64}$/.test(e.sha256 ?? '') && typeof e.at === 'string' && e.pins?.v === 1 && typeof e.pins.blocks === 'object'

/**
 * The next history: `held` (null for the first) plus `entry` for a new release.
 * Re-signing the SAME release (same version and sha256 and pins) is a no-op. A
 * release that isn't newer than everything held, or a changed entry for a held
 * version, is refused: a history only grows.
 */
export function nextHistory(app, held, entry) {
  if (!entryOk(entry)) throw new Error('release-history: the new entry is malformed')
  const releases = held ? held.releases : []
  if (held) {
    const problems = historyProblems(held)
    if (problems.length) throw new Error(`release-history: the held history is malformed: ${problems.join('; ')}`)
    if (held.app !== app) throw new Error(`release-history: the held history is for ${held.app}, not ${app}`)
  }
  const existing = releases.find((e) => e.version === entry.version)
  if (existing) {
    if (same(existing, entry)) return { app, v: HISTORY_V, releases }
    throw new Error(`release-history: ${entry.version} is already in the history with different bytes: a history never changes an entry`)
  }
  if (releases.length && cmpVersion(entry.version, releases[0].version) <= 0) {
    throw new Error(`release-history: ${entry.version} is not newer than ${releases[0].version}: a history only grows forward`)
  }
  return { app, v: HISTORY_V, releases: [entry, ...releases] }
}
