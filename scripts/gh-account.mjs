// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Which GitHub account is `gh` speaking as, and is it the one that may
// create a release on this repo? Pure: the rule takes strings and returns a
// verdict, so scripts/test-publish-account.ts drives it without a network
// or a keyring; publish-site.mjs supplies the strings.
//
// WHY THIS EXISTS. Three releases running, publish-site.mjs mirrored and
// pushed the site and THEN `gh release create` failed: the release worktree
// lived under a temp directory outside ~/devel, where the shell's chpwd hook selects
// the WORK gh profile — a different account, no scope for this repo — and
// gh's config follows the environment the script was launched from, not the
// repo it is pointed at. Each time the lead created the release by hand from
// ~/devel/bento. The account is now checked BEFORE the rsync: a mismatch
// prints the exact command to run from a path under ~/devel and exits
// non-zero with nothing published. Publishing the site and then failing the
// release is the one order that must never happen — the update channel goes
// live while the repo shows no release.

/** The owner of a GitHub remote: git@github.com:owner/repo.git,
 *  https://github.com/owner/repo(.git), ssh://git@github.com/owner/repo —
 *  and an ssh HOST ALIAS for github.com (`git@github.com-work:owner/repo`,
 *  the per-account trick in ~/.ssh/config that `url.insteadOf` rewrites
 *  remotes to): that is what the maintainer's own remotes read as, and
 *  the reason the v1.2.2 gate "could not read the repo owner". */
export function ownerOfRemote(url) {
  const m = /github\.com[\w.-]*[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url ?? '').trim())
  return m ? m[1] : null
}

/** The active account in `gh auth status` output (either format gh has
 *  used: "Logged in to github.com account NAME (…)" with an "Active account:
 *  true" line, or the older "Logged in to github.com as NAME (…)"). */
export function activeAccount(statusText) {
  const text = String(statusText ?? '')
  const blocks = text.split(/\n(?=\s*(?:✓|X|-|\S)\s*Logged in)/)
  for (const b of blocks) {
    const m = /Logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)/.exec(b)
    if (!m) continue
    if (/Active account:\s*false/i.test(b)) continue
    return m[1]
  }
  const any = /Logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)/.exec(text)
  return any ? any[1] : null
}

/**
 * May this account create a release on this repo? The owner, or a name the
 * caller lists as a collaborator with release rights. A null account (not
 * logged in, or unparsable) never may.
 */
export function accountMayRelease(account, owner, collaborators = []) {
  if (!account || !owner) return false
  const a = account.toLowerCase()
  return a === owner.toLowerCase() || collaborators.some((c) => String(c).toLowerCase() === a)
}

/**
 * The origin remote's URL for the repo a directory belongs to — a worktree
 * included. `git remote get-url` answers from the common gitdir already, but
 * a DETACHED worktree made for a release build (`git worktree add /tmp/rel
 * vX.Y.Z --detach`, RELEASING.md) has no upstream to consult, and a `git
 * archive`/plain-copy checkout has no remote at all; v1.2.2 was built in a
 * worktree and the gate found nothing and skipped — a check that skips is a
 * check that does not exist. So: the remote from the directory, then from
 * its common gitdir, then the explicit BENTO_RELEASE_OWNER; `capture` runs
 * git and throws on failure (injected so the rig can drive this without a
 * repo).
 */
export function repoRemote(dir, capture, env = process.env) {
  const tryGit = (args) => { try { return String(capture('git', args) ?? '').trim() } catch { return '' } }
  const direct = tryGit(['-C', dir, 'remote', 'get-url', 'origin'])
  if (direct) return { url: direct, via: 'origin' }
  const common = tryGit(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (common) {
    const fromCommon = tryGit(['--git-dir', common, 'remote', 'get-url', 'origin'])
    if (fromCommon) return { url: fromCommon, via: 'common gitdir' }
    const cfg = tryGit(['config', '--file', common.replace(/\/$/, '') + '/config', '--get', 'remote.origin.url'])
    if (cfg) return { url: cfg, via: 'common config' }
  }
  if (env.BENTO_RELEASE_OWNER) return { url: `https://github.com/${env.BENTO_RELEASE_OWNER}/x`, via: 'BENTO_RELEASE_OWNER' }
  return null
}

/** The sentence when the owner cannot be read: refuse, with the way out. */
export function noOwnerMessage(dir) {
  return [
    `could not read the repository owner: ${dir} has no origin remote (a detached or copied checkout?).`,
    `  Nothing was published. The gh account check cannot run without knowing whose repo this is, and a check that skips is a check that does not exist.`,
    `  Fix: run the publish from a checkout with an origin remote (any worktree under ~/devel), or set BENTO_RELEASE_OWNER=<github owner>.`,
  ].join('\n')
}

/** The sentence publish-site prints on a mismatch: what gh is, what it must
 *  be, and the exact command — from a path the shell maps to the right
 *  profile. */
export function mismatchMessage({ account, owner, repoRoot, cmd }) {
  return [
    `gh is authenticated as ${account ?? 'nobody'}; a release on this repo needs ${owner}.`,
    `  Nothing was published (this check runs before the site is mirrored).`,
    `  The shell picks the gh profile by directory — run the publish from a path under ~/devel, not from a job or temp worktree:`,
    `    cd ${repoRoot} && ${cmd}`,
    `  (or: gh auth switch --user ${owner}, then re-run from here).`,
  ].join('\n')
}
