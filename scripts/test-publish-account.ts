#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The gh account gate publish-site.mjs runs BEFORE mirroring the site
// (scripts/gh-account.mjs):
//
//   node scripts/test-publish-account.ts
//
// WHAT THIS PROVES. The owner is read from any GitHub remote spelling; the
// active account is read from both formats of `gh auth status` (and an
// inactive account is not mistaken for the active one); the rule refuses a
// mismatched owner, nobody, and accepts the owner or a listed collaborator
// case-insensitively; the message names the command to run from a path
// under ~/devel. And the gate sits BEFORE the rsync in publish-site.mjs —
// the whole point: the site must never go live and the release then fail.

import { readFileSync, mkdtempSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountMayRelease, activeAccount, mismatchMessage, noOwnerMessage, ownerOfRemote, repoRemote } from './gh-account.mjs'

let failures = 0, checks = 0
const ok = (cond: boolean, msg: string) => { checks++; if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`) }

console.log('\nownerOfRemote')
ok(ownerOfRemote('git@github.com:nyblnet/bento.git') === 'nyblnet', 'ssh scp form')
ok(ownerOfRemote('https://github.com/nyblnet/bento') === 'nyblnet' && ownerOfRemote('https://github.com/nyblnet/bento.git/') === 'nyblnet', 'https, with and without .git and a trailing slash')
ok(ownerOfRemote('ssh://git@github.com/Some-Org/repo.git') === 'Some-Org', 'ssh url form, dashes kept')
ok(ownerOfRemote('git@github.com-nyblnet:nyblnet/bento.git') === 'nyblnet' && ownerOfRemote('git@github.com-work:acme/x') === 'acme', 'an ssh host ALIAS for github.com (url.insteadOf per-account setups) — what the v1.2.2 gate could not read')
ok(ownerOfRemote('https://gitlab.com/x/y') === null && ownerOfRemote('') === null && ownerOfRemote(undefined) === null, 'not GitHub, empty, undefined → null')

console.log('\nactiveAccount')
const NEW = `github.com
  ✓ Logged in to github.com account work-account (keyring)
  - Active account: false
  - Git operations protocol: https
  ✓ Logged in to github.com account nyblnet (keyring)
  - Active account: true
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'`
ok(activeAccount(NEW) === 'nyblnet', 'the ACTIVE account in the multi-account format, not the first listed')
const OLD = `github.com
  ✓ Logged in to github.com as nyblnet (oauth_token)
  ✓ Git operations for github.com configured to use https protocol.`
ok(activeAccount(OLD) === 'nyblnet', 'the older single-account format')
ok(activeAccount('You are not logged into any GitHub hosts. Run gh auth login to authenticate.') === null && activeAccount('') === null, 'not logged in → null')
const WORK = `github.com
  ✓ Logged in to github.com account work-account (keyring)
  - Active account: true`
ok(activeAccount(WORK) === 'work-account', 'the work profile reads as the work account')

console.log('\naccountMayRelease')
ok(accountMayRelease('nyblnet', 'nyblnet') === true && accountMayRelease('NyblNet', 'nyblnet') === true, 'the owner may, case-insensitively')
ok(accountMayRelease('work-account', 'nyblnet') === false, 'a mismatched owner is REFUSED (the three failed releases)')
ok(accountMayRelease(null, 'nyblnet') === false && accountMayRelease('nyblnet', null) === false, 'nobody may; no owner, nobody may')
ok(accountMayRelease('helper', 'nyblnet', ['Helper']) === true && accountMayRelease('other', 'nyblnet', ['helper']) === false, 'a listed collaborator may (BENTO_RELEASE_ACCOUNTS), an unlisted one may not')

console.log('\nmismatchMessage')
const msg = mismatchMessage({ account: 'work-account', owner: 'nyblnet', repoRoot: '/Users/you/devel/bento', cmd: 'node scripts/publish-site.mjs "release v1.2.3"' })
ok(/authenticated as work-account/.test(msg) && /needs nyblnet/.test(msg), 'names what gh is and what it must be')
ok(/Nothing was published/.test(msg), 'says nothing was published')
ok(/cd \/Users\/you\/devel\/bento && node scripts\/publish-site\.mjs "release v1\.2\.3"/.test(msg), 'gives the exact command from the repo root')
ok(/gh auth switch --user nyblnet/.test(msg), 'and the switch alternative')

console.log('\nrepoRemote — from a worktree, a detached worktree, a copy')
{
  // a real repo with an origin, and two worktrees of it; git is the capture
  const tmp = mkdtempSync(join(tmpdir(), 'bento-gate-'))
  const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim()
  const capture = (cmd: string, a: string[]) => execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  const main = join(tmp, 'main')
  git('init', '-q', '-b', 'main', main)
  git('-C', main, 'config', 'user.email', 'r@x'); git('-C', main, 'config', 'user.name', 'r')
  writeFileSync(join(main, 'f'), '1'); git('-C', main, 'add', 'f'); git('-C', main, 'commit', '-q', '-m', 'one')
  git('-C', main, 'remote', 'add', 'origin', 'git@github.com:nyblnet/bento.git')
  git('-C', main, 'tag', 'v9.9.9')
  const wt = join(tmp, 'wt'); git('-C', main, 'worktree', 'add', '-q', wt, '-b', 'feature')
  const rel = join(tmp, 'rel'); git('-C', main, 'worktree', 'add', '-q', '--detach', rel, 'v9.9.9')
  ok(ownerOfRemote(repoRemote(main, capture)!.url) === 'nyblnet', 'the main checkout: origin read')
  ok(ownerOfRemote(repoRemote(wt, capture)!.url) === 'nyblnet', 'a worktree (its .git is a FILE pointing at the main gitdir): origin read')
  const r = repoRemote(rel, capture)
  ok(!!r && ownerOfRemote(r.url) === 'nyblnet', `a DETACHED release worktree (git worktree add --detach vX.Y.Z, the RELEASING.md recipe): origin read (via ${r?.via})`)
  const copy = join(tmp, 'copy'); cpSync(main, copy, { recursive: true }); git('-C', copy, 'remote', 'remove', 'origin')
  ok(repoRemote(copy, capture, {}) === null, 'a checkout with no remote at all → null (no guess)')
  ok(ownerOfRemote(repoRemote(copy, capture, { BENTO_RELEASE_OWNER: 'nyblnet' })!.url) === 'nyblnet', 'unless BENTO_RELEASE_OWNER names the owner')
  ok(/no origin remote/.test(noOwnerMessage(copy)) && /Nothing was published/.test(noOwnerMessage(copy)) && /BENTO_RELEASE_OWNER/.test(noOwnerMessage(copy)), 'the refusal names the cause and the two ways out')
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) } catch { /* temp */ }
}

console.log('\npublish-site.mjs — the gate sits before the mirror')
{
  const src = readFileSync(new URL('./publish-site.mjs', import.meta.url), 'utf8')
  const gate = src.indexOf('accountMayRelease(account, owner, allowed)')
  const mirror = src.indexOf("run('rsync'")
  const release = src.indexOf("run('gh', ['release', 'create'")
  ok(gate > 0 && mirror > 0 && gate < mirror, 'the account check runs BEFORE rsync')
  ok(release > mirror, 'and the release step stays after it (the order the check protects)')
  ok(/if \(!dry\) \{\n  const remote = repoRemote\(root,/.test(src), 'a dry run skips the check (nothing is published either way); every real publish runs it')
  ok(/die\(mismatchMessage\(/.test(src), 'a mismatch dies with the message, not a warning')
  ok(/if \(!owner\) die\(noOwnerMessage\(root\)\)/.test(src) && !/skipping the gh account check/.test(src), 'an owner that cannot be read REFUSES — the gate never skips (v1.2.2 warned and proceeded)')
  ok(/repoRemote\(root,/.test(src), 'the remote is resolved through repoRemote (worktree-aware), not a bare get-url')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
