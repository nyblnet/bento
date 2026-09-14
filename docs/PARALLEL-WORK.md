# Parallel work — discipline for many agents, many tools

Bento development runs many parallel agents (Claude Code, Codex, Antigravity,
…) across multiple apps. These tools share **nothing but this repository** —
no memory, no chat context. So the repo is the coordination surface, and these
rules exist to keep N parallel workstreams from dissolving into merge hell.
(Empirically: 11 parallel PRs once produced cascading conflicts on `render.ts`,
`i18n/*`, and `CHANGELOG.md` — every rule here traces back to that.)

## 1. Ownership zones

- **App zones** — `slides/` (shipped) and `spaces/` (scaffold); `dash/` when
  it lands. Parallel work is safe *within different apps*. Agents working on
  different apps must not touch each other's app directories. Each app owns
  its own `package.json`, `vite.config.ts`, `index.html`, `src/model.ts` and
  `src/i18n.ts` facade.
- **Kernel zone — `kernel/src/`** — `save.ts` (splice + bento/enc),
  `autosave.ts`, `update.ts`, `anim.ts`, `charts.ts`, the `i18n.ts` engine,
  `app.ts`, `doc.ts`, and the whole of `sync/` — `crdt.ts` (the CRDT engine),
  `session.ts`, `online.ts` (the relay transport) and `blobs.ts`; plus
  `server/`, which is shared in effect even though it lives outside the kernel.
  See `docs/PLATFORM.md` §9.

  This entry used to add "plus the rest of `slides/src/sync/` (session,
  transport, blobs) … shared in effect even though they still live app-side".
  They no longer live app-side: the session and transport moved into
  `kernel/src/sync/` behind a small per-app `SyncHost`, and
  `slides/src/sync/*` are facades. The rule they were under has not changed —
  they were always serialized, and the parenthetical existed only to say so
  about files whose location disagreed with their status. Each app's
  `src/sync/crdt.ts` and `src/sync/session.ts` facade, which pin that app's
  document shape and its five host decisions, are APP zone.
  This zone is:
  **serialize, don't parallelize.** One coordinated change at a time, reviewed
  against the platform invariants. If your app task needs a kernel change,
  stop, make (or request) the kernel change as its own small PR, land it,
  then continue.
- **Ops zone** — `server/`, `scripts/`, `site-src/`: maintainer-coordinated;
  relay changes have deploy-order constraints (`docs/PLATFORM.md` §5).

## 2. Branch & PR discipline

- One branch = one agent = one concern. Never share a branch between agents
  or tools.
- Small, single-purpose PRs. A PR that "also fixes" something unrelated will
  conflict with the agent that was assigned that something.
- **Integrate frequently.** Long-lived branches are where conflicts breed;
  rebase/merge from `main` at least daily while a branch is open.
- `main` is branch-protected (1 review, no force-push). Merge order for a
  batch: independent zones first, then known-overlapping PRs one at a time,
  re-checking mergeability between each.
- Every PR body states: what changed, how it was verified (commands run,
  browser-tested or not), and any platform invariant it touches.

### 2.1 One worktree per session — never share a checkout

Sessions do not share a working tree. `git worktree add .worktrees/<name>
<branch>`, work there, and leave the main checkout alone.

**Worktrees live in `.worktrees/` inside the repo** (gitignored). Two reasons,
both learned the expensive way.

*The `gh` account is chosen by directory.* `~/.zshrc` exports the personal
profile only under the paths in `GH_PERSONAL_DIRS`, which is
`$HOME/devel/bento` — a worktree anywhere else silently gets the WORK account,
which cannot see this repo. The failure is badly misleading: `gh` reports
*"Failed to create release, 'workflow' scope may be required"* and tells you to
run `gh auth refresh -s workflow`. The token already has that scope. Do not
refresh it; check where you are. This cost a failed release step on 1.0.17.

*`/tmp` is reaped.* It is not a location for anything you have not pushed. On
2026-08-15 seven worktrees under `/private/tmp` were reaped in a single day —
including one holding an open PR's branch and one holding a release build — and
issue #270's uncommitted relay work appears to have gone the same way. Branches
that had been pushed survived; nothing else did.

**`git mv` stages.** It is `mv` plus `git add`, so anyone doing a refactor is
staging by default, and in a shared checkout a plain `git commit` from ANY
session — no `-a`, no `add -A` — sweeps up their half-finished work. It reports
clean to a casual reader, because `R  old -> new` looks like working-tree state
until you notice the `R` is in column ONE. **The check before committing is
`git diff --cached --stat`, not `git status`.** A session self-reported "nothing
staged" while sitting on three staged renames of kernel modules.

**A shared checkout goes stale and answers confidently.** The main checkout sat
two commits behind `origin/main` on a detached HEAD; every tool run in it gave
pre-fix answers, including `release.mjs --print-notes` printing the wrong
version's notes. If you must read state from a checkout that is not yours, read
the ref instead: `git show origin/main:path`.

**Release tooling runs from a worktree pinned to `main`**, never from a shared
or detached checkout, for exactly that reason.

## 3. Known conflict magnets (pre-empt them)

- **`CHANGELOG.md`** — every feature branch appends to `[Unreleased]`. Keep
  entries as one self-contained block. Each app has its own changelog now
  (`spaces/`, `dash/`, `type/`); the ROOT `CHANGELOG.md` is **bento/slides'**
  and has not moved to `slides/CHANGELOG.md` yet. Never append another app's
  changes to it — release notes ride inside the signed update manifest, so a
  file describing a second app tells a user about changes their document did
  not get.
- **i18n catalogs** — append-only additions at the TOP of each catalog map;
  never reorder or reformat existing entries. Every catalogue in the same PR
  as the source string — **the count is not written here**; it is `LOCALES` in
  the app's `scripts/build-*-i18n.mjs`. This line said 7 while the apps packed
  8. See hard rule 6 in `AGENTS.md`.
- **`render.ts` / shared modules** — additive features must COMPOSE (blur +
  blend + backdrop all coexist; gradient + stroke coexist). When resolving a
  conflict between two features, the answer is almost always "keep both".
- **Version/release files** (`package.json` version, manifests) — maintainer
  only, at release time.

## 4. Tool assignment

Assign tools per app, not per file: mixing three tools' edits inside one
module means reconciling three styles and three context gaps. A reasonable
split is one tool as the primary for each app + one doing cross-cutting
review. Whatever the split, record it in `docs/DECISIONS.md` so every session
of every tool can see it.

## 5. Verification bar (before any PR is opened)

- `node_modules/.bin/tsc -b` clean in the affected app
- `npm run build:single` succeeds (the single-file build IS the product)
- `node scripts/test-sync.ts` if anything under `sync/` changed
- user-visible changes exercised in a real browser (dev server), not assumed
- i18n: new strings present in all catalogs (`x-pseudo` audit catches strays)
- no edits under generated dirs (`site/`, `dist-single/`)

## 6. Picking up work without colliding

Zones stop *cross-app* collisions. Two agents inside one app will still
collide, and no tooling fixes that — it is a work-assignment question.
Practical rules for a small team running many agents:

- **One agent per app zone at a time**, unless the maintainer has explicitly
  split the work by file.
- **Push the branch early**, before the work is finished, so another agent can
  see it exists.
- **Check `gh pr list` before starting.** An open PR touching your files is
  the cheapest collision warning available.
- **Branches whose commits look unmerged may already be shipped.** `main` was
  rewritten once (to scrub a bot's commits), which orphaned older branch
  hashes. Compare *content*, not commit ids, before "rescuing" anything.
- Agents from other harnesses (Codex, Antigravity) read `AGENTS.md`, not this
  file — keep the hard rules mirrored there.

## 7. Coordination artifacts (the shared brain)

- `docs/DECISIONS.md` — append-only decision log. Before starting non-trivial
  work: read it. After settling anything another agent could contradict:
  append to it (date, decision, why, owner). Decisions live here, not in any
  one tool's chat history.
- `docs/PLATFORM.md` — the invariants; change only with maintainer sign-off.
- `AGENTS.md` / `CLAUDE.md` — behavioral contract + deep architecture.
- Work assignment lives with the maintainer (issues/task list); an agent that
  finds adjacent-but-out-of-scope work files it as a note or issue instead of
  expanding its own PR.

## 8. What agents never do

- Release, publish, deploy, or touch signing keys (maintainer-only, local).
- Rewrite history or force-push shared branches.
- Merge external contributors' PRs without provenance review.
- "Fix" another in-flight branch's code from their own branch.
- Add AI co-author trailers or bot identities to commits.
