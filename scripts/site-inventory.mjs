#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// What is published, and what a publish would remove.
//
// Its own module so the rule is testable without running a publish:
// publish-site.mjs dies during preflight when imported, and the failure this
// guards is the one class of mistake nobody can repair afterwards — a deleted
// artifact takes shipped files' update and pack channels offline permanently.

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Every file under `dirPath`, as paths relative to it. `.git` is never walked. */
export function walk(dirPath, base = dirPath) {
  const out = []
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const full = join(dirPath, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, base))
    else out.push(full.slice(base.length + 1))
  }
  return out
}

/**
 * Published files an authoritative mirror of `staged` would remove.
 *
 * `excluded` holds the mirror's own --exclude patterns: a path the mirror does
 * not touch is not a deletion, and counting it as one would block every
 * ordinary publish that legitimately carries no guestbook deck.
 *
 * Matching is exact-or-directory-prefix, deliberately not glob: an exclusion
 * that quietly matched more than it looks like it does would re-open the hole.
 */
export function plannedDeletions(published, staged, excluded = []) {
  const have = new Set(staged)
  return published
    .filter((p) => !have.has(p))
    .filter((p) => !excluded.some((ex) => p === ex || p.startsWith(`${ex}/`)))
}

/** Deletions grouped by top-level path, so 22 packs read as one line. */
export function groupDeletions(deletions) {
  const groups = new Map()
  for (const p of deletions) {
    const top = p.includes('/') ? p.slice(0, p.indexOf('/')) : p
    groups.set(top, (groups.get(top) ?? 0) + 1)
  }
  return [...groups]
}
