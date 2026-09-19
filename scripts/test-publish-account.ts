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

import { readFileSync } from 'node:fs'
import { accountMayRelease, activeAccount, mismatchMessage, ownerOfRemote } from './gh-account.mjs'

let failures = 0, checks = 0
const ok = (cond: boolean, msg: string) => { checks++; if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`) }

console.log('\nownerOfRemote')
ok(ownerOfRemote('git@github.com:nyblnet/bento.git') === 'nyblnet', 'ssh scp form')
ok(ownerOfRemote('https://github.com/nyblnet/bento') === 'nyblnet' && ownerOfRemote('https://github.com/nyblnet/bento.git/') === 'nyblnet', 'https, with and without .git and a trailing slash')
ok(ownerOfRemote('ssh://git@github.com/Some-Org/repo.git') === 'Some-Org', 'ssh url form, dashes kept')
ok(ownerOfRemote('https://gitlab.com/x/y') === null && ownerOfRemote('') === null && ownerOfRemote(undefined) === null, 'not GitHub, empty, undefined → null')

console.log('\nactiveAccount')
const NEW = `github.com
  ✓ Logged in to github.com account work-andy (keyring)
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
  ✓ Logged in to github.com account work-andy (keyring)
  - Active account: true`
ok(activeAccount(WORK) === 'work-andy', 'the work profile reads as the work account')

console.log('\naccountMayRelease')
ok(accountMayRelease('nyblnet', 'nyblnet') === true && accountMayRelease('NyblNet', 'nyblnet') === true, 'the owner may, case-insensitively')
ok(accountMayRelease('work-andy', 'nyblnet') === false, 'a mismatched owner is REFUSED (the three failed releases)')
ok(accountMayRelease(null, 'nyblnet') === false && accountMayRelease('nyblnet', null) === false, 'nobody may; no owner, nobody may')
ok(accountMayRelease('helper', 'nyblnet', ['Helper']) === true && accountMayRelease('other', 'nyblnet', ['helper']) === false, 'a listed collaborator may (BENTO_RELEASE_ACCOUNTS), an unlisted one may not')

console.log('\nmismatchMessage')
const msg = mismatchMessage({ account: 'work-andy', owner: 'nyblnet', repoRoot: '/Users/andy/devel/bento', cmd: 'node scripts/publish-site.mjs "release v1.2.3"' })
ok(/authenticated as work-andy/.test(msg) && /needs nyblnet/.test(msg), 'names what gh is and what it must be')
ok(/Nothing was published/.test(msg), 'says nothing was published')
ok(/cd \/Users\/andy\/devel\/bento && node scripts\/publish-site\.mjs "release v1\.2\.3"/.test(msg), 'gives the exact command from the repo root')
ok(/gh auth switch --user nyblnet/.test(msg), 'and the switch alternative')

console.log('\npublish-site.mjs — the gate sits before the mirror')
{
  const src = readFileSync(new URL('./publish-site.mjs', import.meta.url), 'utf8')
  const gate = src.indexOf('accountMayRelease(account, owner, allowed)')
  const mirror = src.indexOf("run('rsync'")
  const release = src.indexOf("run('gh', ['release', 'create'")
  ok(gate > 0 && mirror > 0 && gate < mirror, 'the account check runs BEFORE rsync')
  ok(release > mirror, 'and the release step stays after it (the order the check protects)')
  ok(/if \(!dry\) \{\n  const owner = ownerOfRemote/.test(src), 'a dry run skips the check (nothing is published either way); every real publish runs it')
  ok(/die\(mismatchMessage\(/.test(src), 'a mismatch dies with the message, not a warning')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
