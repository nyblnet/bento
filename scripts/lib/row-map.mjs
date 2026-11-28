// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Which sections of a rig a mutant needs: the rows a mutant is judged on, found
// in the rig's own unmutated run. Used by the mutant suites that run only the
// section their mutant is judged in (test-home-web-mutants.mjs,
// test-home-web-build-mutants.mjs), as test-home-web-offline.mjs does by hand.
//
// A rig that supports this prints each section's header with its key in braces
// (`=== a title {t2}`) and runs only the keys named in its *_ONLY variable,
// refusing a key it does not have. The suite runs the rig once unmutated, all
// sections (the positive control), and maps each mutant's judged row to the
// sections that printed it. So the map is derived, never written by hand: a
// judged row no section prints is an error (the suite goes red), and a mutant
// run without the section of its row cannot show that row red (red elsewhere
// or green: the suite goes red).

/** The rows of a run: [{ key, ok, text }], `key` the section's braced key (null before any). */
export function rowsOf(output) {
  const rows = []
  let key = null
  for (const line of output.split('\n')) {
    const h = /^=== .*\{([\w-]+)\}\s*$/.exec(line)
    if (h) { key = h[1]; continue }
    if (/^=== /.test(line)) { key = null; continue }
    const r = /^\s+(ok|FAIL)\s+(.*)$/.exec(line)
    if (r) rows.push({ key, ok: r[1] === 'ok', text: r[2] })
  }
  return rows
}

/**
 * The sections whose rows contain `expect`, from the unmutated run's rows.
 * Throws when no row matches (the map would name a row that does not exist),
 * when a matching row is not passing unmutated (it proves nothing), or when a
 * matching row sits outside every keyed section.
 */
export function sectionsFor(expect, rows) {
  const hits = rows.filter((r) => r.text.includes(expect))
  if (!hits.length) throw new Error(`no row of the unmutated run matches "${expect}"`)
  const red = hits.filter((r) => !r.ok)
  if (red.length) throw new Error(`the row "${expect}" is red unmutated, so a mutant turning it red proves nothing`)
  if (hits.some((r) => r.key === null)) throw new Error(`the row "${expect}" is outside every keyed section`)
  return [...new Set(hits.map((r) => r.key))].sort()
}

/** A rig's *_ONLY variable against the keys it has: { only, unknown }. */
export function parseOnly(value, known) {
  const only = String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return { only, unknown: only.filter((k) => !known.includes(k)) }
}
