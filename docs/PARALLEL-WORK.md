# Parallel work — discipline for many agents, many tools

Bento development runs many parallel agents (Claude Code, Codex, Antigravity,
…) across multiple apps. These tools share **nothing but this repository** —
no memory, no chat context. So the repo is the coordination surface, and these
rules exist to keep N parallel workstreams from dissolving into merge hell.
(Empirically: 11 parallel PRs once produced cascading conflicts on `render.ts`,
`i18n/*`, and `CHANGELOG.md` — every rule here traces back to that.)

## 1. Ownership zones

- **App zones** — `slides/`, and (as they land) `spaces/`, `dash/`: parallel
  work is safe *within different apps*. Agents working on different apps must
  not touch each other's app directories.
- **Kernel zone** — shared machinery (save/splice, sync engine + relay,
  update, i18n runtime, build tooling; see `docs/PLATFORM.md` §9):
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

## 3. Known conflict magnets (pre-empt them)

- **`CHANGELOG.md`** — every feature branch appends to `[Unreleased]`. Keep
  entries as one self-contained block; when apps multiply, each app gets its
  own changelog (`slides/CHANGELOG.md`, …).
- **i18n catalogs** — append-only additions at the TOP of each catalog map;
  never reorder or reformat existing entries. All 7 catalogs in the same PR
  as the source string.
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

## 6. Coordination artifacts (the shared brain)

- `docs/DECISIONS.md` — append-only decision log. Before starting non-trivial
  work: read it. After settling anything another agent could contradict:
  append to it (date, decision, why, owner). Decisions live here, not in any
  one tool's chat history.
- `docs/PLATFORM.md` — the invariants; change only with maintainer sign-off.
- `AGENTS.md` / `CLAUDE.md` — behavioral contract + deep architecture.
- Work assignment lives with the maintainer (issues/task list); an agent that
  finds adjacent-but-out-of-scope work files it as a note or issue instead of
  expanding its own PR.

## 7. What agents never do

- Release, publish, deploy, or touch signing keys (maintainer-only, local).
- Rewrite history or force-push shared branches.
- Merge external contributors' PRs without provenance review.
- "Fix" another in-flight branch's code from their own branch.
- Add AI co-author trailers or bot identities to commits.
