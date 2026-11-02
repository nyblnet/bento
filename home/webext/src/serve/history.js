// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/connect W2 — the signed release histories the extension checks a file
// against before it serves it with identity (gate 1, kernel/src/gate1.ts).
//
// Each app publishes releases/<app>/history.json on bento.page: every release
// still in the wild with its script and block pins, signed by the release key
// (the same key and envelope as the update channel: release.js verifySigned).
//
// WHEN IT IS FETCHED — never on each open (an open must not phone home, and
// must work offline):
//   · not at all, for a person who has never opened a document with identity;
//   · after that, at most once a day, at browser start;
//   · and once at an open only when NOTHING is held for any app yet.
// Offline with nothing held → no history → every file is UNKNOWN (opens
// without identity). Never a guess.
//
// WHAT IS HELD: per app, the newest history that verified, replaced only by one
// kernel's acceptHistory() accepts — append-only, so a replayed older signed
// history can't hide a release (anti-rollback).
//
// Pure: storage, fetch, time and the key come in as deps.

import { verifySigned } from '../release.js'
import { acceptHistory, historyProblems } from '../id/gen/gate1.js'

export const STORE_KEY = 'gate1History'
export const USED_KEY = 'gate1Used'
export const DAY = 86_400_000
export const BASE = 'https://bento.page/releases'

/** The apps whose histories are fetched: [{ id: 'slides', appId: 'bento-slides' }, …]. */
export async function refresh(apps, deps, { force = false } = {}) {
  const held = (await deps.get(STORE_KEY)) ?? {}
  const now = deps.now()
  const report = {}
  for (const { id, appId } of apps) {
    const mine = held[appId]
    if (!force && mine && now - mine.fetchedAt < DAY) { report[appId] = 'fresh'; continue }
    let incoming
    try {
      const r = await deps.fetch(`${BASE}/${id}/history.json`, { cache: 'no-store' })
      if (!r.ok) { report[appId] = `http ${r.status}`; continue }
      incoming = await verifySigned(await r.text(), 'release history', deps.jwk)
    } catch (e) {
      report[appId] = `refused: ${e?.message ?? e}`; continue
    }
    if (incoming?.app !== appId) { report[appId] = 'refused: history for another app'; continue }
    const problems = historyProblems(incoming)
    if (problems.length) { report[appId] = `refused: ${problems[0]}`; continue }
    const ok = acceptHistory(mine?.history ?? null, incoming, appId)
    if (!ok.ok) { report[appId] = `refused: ${ok.reason}`; continue }
    held[appId] = { history: incoming, fetchedAt: now }
    report[appId] = 'updated'
  }
  await deps.set(STORE_KEY, held)
  return report
}

/** The held histories, { appId: history }. */
export async function heldHistories(deps) {
  const held = (await deps.get(STORE_KEY)) ?? {}
  return Object.fromEntries(Object.entries(held).map(([k, v]) => [k, v.history]))
}

/** For the browser-start refresh: only for someone who has used identity opening. */
export async function refreshIfUsed(apps, deps) {
  if (!(await deps.get(USED_KEY))) return { skipped: 'never used' }
  return refresh(apps, deps)
}
