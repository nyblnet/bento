// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Under CI, a rig that reports a SKIP fails its step, unless the skip is on
// the allowlist below.
//
// WHY. A rig that skips prints a line and exits 0, so its step is green, and a
// green step reads as "checked". On main in October 2026, three rigs had
// skipped in every CI run since they were written: the encrypted-title rig
// (the #742 regression guard for shipped slides), the type preview rig and the
// type font rig. All three print "skipped: jsdom is not installed", and CI never
// installed jsdom. Nothing went red, so nothing said so. Each rig was right to
// skip on a laptop without jsdom. What was missing was a rule that CI is never
// that laptop.
//
// HOW. Every validate step runs through scripts/ci/bento-step (the `shell:` of
// every composite step, and the default shell of the ci-<zone>.yml jobs that
// run rigs), which keeps the step's output and hands it to `check` here. Any
// line that reads as a skip report fails the step, unless an allowlist entry
// below covers it.
//
// THE ALLOWLIST is a hazard and is meant to look like one, as in
// test-ci-registered.ts. Each entry names the rig, the exact skip line, and why
// CI cannot provide what the rig needs. scripts/test-ci-skips.mjs checks that
// every entry's rig still exists and still prints that line, so an entry
// can't outlive its reason quietly.

/** A line that reports a skip, in any of the shapes the rigs print. */
export function isSkipLine(raw) {
  const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim()
  // A CHECK whose subject is skipping ("ok  a lapsed folder is skipped") is a
  // pass, and a section header ("=== a SKIPPED level …") is a title.
  if (/^(ok|✓|PASS|FAIL|===)(\s|$)/.test(line)) return false
  return (
    /\bSKIP(PED)?\b/.test(line) || // "  SKIP  no real .xlsx", "tray releases: SKIPPED —", "⚠ SKIPPED —"
    /^(skip|skipped)\b/i.test(line) || // "  skip  needs Chrome …"
    /^(--|\.\.)\s+skipped\b/i.test(line) || // "  --    skipped: jsdom …", "  ..    skipped real-shell checks"
    /—\s*skipped\b/i.test(line) || // "— skipped: jsdom is not installed —"
    /\(skipped\)/i.test(line) // "0/0 checks passed (skipped)"
  )
}

const notMac = () => process.platform !== 'darwin'

/**
 * Skips CI tolerates, each with its reason. `rig` must be named by the step's
 * script; `line` must match the skip line. `when` limits an entry to the
 * platforms where it is true.
 */
export const ALLOWED_SKIPS = [
  {
    rig: 'scripts/test-dash-xlsx.ts',
    line: /SKIP\s+LibreOffice is not installed/,
    why: 'the "does Excel\'s own reader open it" interop check needs LibreOffice, which the ubuntu runner does not ship; the format checks above it still gate',
  },
  {
    rig: 'scripts/test-dash-xlsx.ts',
    line: /SKIP\s+no real \.xlsx to import/,
    why: 'needs a real Excel-made .xlsx, which the repo deliberately does not commit; the generated-workbook checks still gate',
  },
  {
    rig: 'scripts/test-dash-zip.ts',
    line: /SKIP\s+no real \.xlsx on this machine to read/,
    why: 'same: no real Excel-made .xlsx in CI; the zip reader is still checked against unzip and python3',
  },
  {
    rig: 'scripts/test-tray-releases.mjs',
    line: /tray releases: SKIPPED — no CryptoKit/,
    when: notMac,
    why: 'Swift with CryptoKit exists only on Apple platforms; on the ubuntu validate job this rig can only skip (the macOS home-ios job runs it for real, and a skip fails there)',
  },
  {
    rig: 'scripts/test-home-origin.mjs',
    line: /home origin: SKIPPED — no CryptoKit/,
    when: notMac,
    why: 'Swift with CryptoKit exists only on Apple platforms (see test-tray-releases)',
  },
  {
    rig: 'scripts/test-home-docstore-ios.mjs',
    line: /home docstore \(iOS\): SKIPPED — no Swift toolchain with the Security framework/,
    when: notMac,
    why: 'the Security framework exists only on Apple platforms (see test-tray-releases)',
  },
  ...['keys', 'statements', 'agent', 'recovery'].map((n) => ({
    rig: `scripts/test-home-id-${n}.mjs`,
    line: new RegExp(`home id ${n}: SKIPPED — needs an Apple toolchain`),
    when: notMac,
    why: 'the bento/id Swift core needs CryptoKit and Security, Apple platforms only (see test-tray-releases)',
  })),
  {
    rig: 'scripts/test-home-spotlight.mjs',
    line: /home spotlight: SKIPPED — needs an Apple toolchain/,
    when: notMac,
    why: 'the Spotlight index code is Swift against Apple frameworks, Apple platforms only (see test-tray-releases)',
  },
]

/** The rigs allowed to skip off macOS must run, unskipped, on the macOS job. */
export const MAC_JOB = '.github/workflows/ci-home-ios.yml'

/**
 * Check one step's output. `script` is the step's script text (which rigs it
 * runs); returns the skip lines, each with the allowlist entry that covers it
 * (or null).
 */
export function check(script, output, allow = ALLOWED_SKIPS) {
  const found = []
  for (const line of output.split(/\r?\n/)) {
    if (!isSkipLine(line)) continue
    const entry = allow.find((a) => script.includes(a.rig) && a.line.test(line) && (!a.when || a.when())) || null
    found.push({ line: line.trim(), entry })
  }
  return found
}
