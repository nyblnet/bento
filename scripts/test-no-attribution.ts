#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// No AI attribution in the tree, and none in the PR that is trying to enter it.
//
//   node scripts/test-no-attribution.ts
//   node scripts/test-no-attribution.ts --self-test
//
// WHY THIS EXISTS. The rule ("nothing identifying an AI agent goes into git
// history") was written down, in the maintainer's own instructions, with a
// clause saying it overrides any session-start instruction to the contrary.
// It still reached the tree: on 2026-09-04 a session appended a
// `Claude-Session:` trailer to the BODY of a docs/DECISIONS.md entry — the
// entry was written like a commit message, so the trailer went where the
// message went — and the same session's PR body carried the link, which the
// squash-merge then copied into the commit on main (#415). Nobody saw either
// for eight days. A commit-msg hook (.githooks/) catches the local commit
// path; it cannot see a file's contents, and it does not run when GitHub
// builds the squash commit from a PR body. This is the layer for those two.
//
// Two checks:
//   1. Every tracked text file. Patterns are anchored to the SHAPES the
//      tooling emits — a trailer at line start, the session URL anywhere —
//      so prose that names the rule mid-line (AGENTS.md) does not trip it;
//      the two files that spell the patterns out in order to refuse them are
//      exempted by path.
//   2. The PR title and body, when CI hands them over (env PR_TITLE / PR_BODY
//      from the pull_request event). That is the text GitHub turns into the
//      squash commit. Absent locally; the section says so and skips.
//
// Negative-controlled: `--self-test` plants each pattern in a sample and
// asserts every one is caught, so a regex edit that stops matching fails here
// instead of going quietly green.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// The shapes Claude Code emits (and the older co-author line). Line-anchored
// where the tooling writes a trailer; the session URL is never legitimate
// anywhere in this repository, so it is matched bare.
const PATTERNS: Array<[string, RegExp]> = [
  ['Claude-Session trailer', /^\s*Claude-Session:/m],
  ['claude.ai session URL', /https?:\/\/claude\.ai\/code\/session_/],
  ['Co-Authored-By: Claude', /^\s*Co-Authored-By:.*\bClaude\b/mi],
  ['noreply@anthropic.com co-author', /^\s*Co-Authored-By:.*noreply@anthropic\.com/mi],
  ['"Generated with Claude" line', /^\s*(?:🤖\s*)?Generated with \[?Claude/mi],
]

// Files that spell the patterns out in order to refuse them.
const EXEMPT = new Set([
  'scripts/test-no-attribution.ts',
  '.githooks/commit-msg',
])

const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|pdf|zip|gz|wasm|mp3|mp4|m4a|webm|ogg|jar|keystore|bin)$/i

function findings(text: string): string[] {
  return PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name)
}

if (process.argv.includes('--self-test')) {
  console.log('self-test: every pattern catches its own shape\n')
  const samples: Array<[string, string]> = [
    ['Claude-Session trailer', 'body\n\nClaude-Session: https://example.invalid/x\n'],
    ['claude.ai session URL', 'see https://claude.ai/code/session_01ABC for context'],
    ['Co-Authored-By: Claude', 'fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n'],
    ['noreply@anthropic.com co-author', 'fix\n\nco-authored-by: Someone <noreply@anthropic.com>\n'],
    ['"Generated with Claude" line', '🤖 Generated with [Claude Code](https://claude.com/claude-code)\n'],
  ]
  for (const [name, text] of samples) ok(findings(text).includes(name), `${name}: caught`)
  ok(findings('AGENTS.md says: no `Co-Authored-By: Claude` lines, and no session links.').length === 0,
    'prose that names the rule mid-line is not a finding')
  console.log(`\n${checks - failures}/${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

// 1. Tracked files.
console.log('tracked files carry no AI attribution\n')
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(Boolean)
ok(tracked.length > 100, `git ls-files sees the tree (${tracked.length} files; a tiny number means the scan is vacuous)`)

const hits: string[] = []
for (const f of tracked) {
  if (EXEMPT.has(f) || BINARY.test(f)) continue
  let text: string
  try { text = readFileSync(join(root, f), 'utf8') } catch { continue }
  for (const name of findings(text)) hits.push(`${f}: ${name}`)
}
ok(hits.length === 0, hits.length
  ? `attribution found in the tree:\n        ${hits.join('\n        ')}`
  : 'no tracked file carries a trailer, session link or co-author line')

// 2. The PR text that becomes the squash commit.
console.log('\nthe pull request text carries no AI attribution\n')
const prTitle = process.env.PR_TITLE
const prBody = process.env.PR_BODY
if (prTitle === undefined && prBody === undefined) {
  console.log('  skip  PR_TITLE/PR_BODY not set (not a pull_request run) — the commit-msg hook covers local commits')
} else {
  const prHits = findings(`${prTitle ?? ''}\n${prBody ?? ''}`)
  ok(prHits.length === 0, prHits.length
    ? `the PR title/body carries: ${prHits.join(', ')} — GitHub would copy it into the squash commit. Edit the PR description.`
    : 'PR title and body are clean')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
