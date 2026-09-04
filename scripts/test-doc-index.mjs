#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Conformance rig for the document indexer — the JS side of the contract in
// home/fixtures/. The Kotlin port runs the same corpus from
// `./gradlew :app:testDebugUnitTest`, and a Swift port will do the same.
//
//   node scripts/test-doc-index.mjs

import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, TEXT_BUDGET, SNIFF_BYTES, HEAD_BYTES } from '../home/doc-index.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'home/fixtures')
const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'))
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16)

let failed = 0
const fail = (name, what, want, got) => {
  failed++
  console.error(`  FAIL ${name}: ${what}\n    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(got)}`)
}

// The constants are part of the contract, not incidental — a port that used a
// different budget would pass every case whose text is short and diverge only
// on the large documents nobody tests by hand.
for (const [k, want] of [['textBudget', TEXT_BUDGET], ['sniffBytes', SNIFF_BYTES], ['headBytes', HEAD_BYTES]]) {
  if (expected[k] !== want) fail('constants', k, expected[k], want)
}

const cases = readdirSync(join(dir, 'cases')).sort()
const unknown = cases.filter((c) => !expected.cases[c])
if (unknown.length) fail('corpus', 'cases with no expectation (regenerate expected.json)', [], unknown)
const missing = Object.keys(expected.cases).filter((c) => !cases.includes(c))
if (missing.length) fail('corpus', 'expectations with no case file', [], missing)

for (const name of cases) {
  const want = expected.cases[name]
  if (!want) continue
  const got = describe(readFileSync(join(dir, 'cases', name), 'utf8'))

  if (got.isDocument !== want.isDocument) fail(name, 'isDocument', want.isDocument, got.isDocument)
  if (got.title !== want.title) fail(name, 'title', want.title, got.title)
  if (got.app !== want.app) fail(name, 'app', want.app, got.app)
  if (got.encrypted !== want.encrypted) fail(name, 'encrypted', want.encrypted, got.encrypted)
  if ((got.preview !== null) !== want.hasPreview) fail(name, 'hasPreview', want.hasPreview, got.preview !== null)

  const len = got.text === null ? null : got.text.length
  if (len !== want.textLength) fail(name, 'textLength', want.textLength, len)
  const digest = got.text === null ? null : sha(got.text)
  if (digest !== want.textSha256_16) fail(name, 'text digest', want.textSha256_16, digest)
  // Verbatim text is carried for the short cases so a human can read the answer
  // key; check it too, or it would rot unnoticed behind the digest.
  if (want.text !== undefined && got.text !== want.text) fail(name, 'text', want.text, got.text)
}

console.log(failed
  ? `\ndoc-index: ${failed} failure(s) across ${cases.length} cases`
  : `doc-index: ${cases.length} cases pass`)
process.exit(failed ? 1 : 0)
