# Working in this repo — agents & tools

Guidance for AI coding agents (Claude Code, Codex, Antigravity, …) and human
contributors. This file is the **tool-agnostic contract**; Claude Code also
reads `CLAUDE.md` (the deep architecture guide for `slides/`). If your tool
only reads one file, read this one, then follow the pointers.

## What this project is

Bento — office documents as single self-contained HTML files. One file = the
document + viewer + editor; it saves itself, updates itself over a signed
channel, and optionally syncs E2EE through a blind relay. `slides/` is the
shipped app (Bento Slides). Two more are starting: **Bento Spaces**
(Notion/notes-like) and **Bento Dash** (data/spreadsheet) — names provisional,
see `docs/DECISIONS.md`.

## Read before writing code

- `docs/PLATFORM.md` — invariants every Bento app must honor. Breaking these
  bricks files already shipped to users.
- `docs/PARALLEL-WORK.md` — branch/merge discipline when many agents work at
  once (you are probably one of them).
- `docs/DECISIONS.md` — settled decisions. Don't relitigate them in code;
  append new ones.
- `CLAUDE.md` — deep architecture + hard-won gotchas, authoritative for
  `slides/` internals.
- `docs/collab-design.md` — the sync/collab spec + threat model.

## Hard rules (each one has broken something before)

1. **Never let a literal `</script>` into a bundle or document block.** JSON in
   the doc block escapes `<` as `<`; builders concatenate around it.
2. **The `#bento-doc` block stays plaintext, same id, regex-extractable.**
   That's the splice contract (`docs/PLATFORM.md`) — updaters already shipped
   in old files are frozen code that depends on it.
3. **Never regenerate a document's `docId`.** It's the document's identity for
   recovery, sync, and future merge.
4. **After any change to `slides/src/sync/crdt.ts`, run
   `node scripts/test-sync.ts`.** The convergence rig has caught 15+ ordering
   bugs; a green typecheck means nothing for CRDT correctness.
5. **New UI strings go into ALL i18n catalogs** (ja, zh-Hans, zh-Hant, es, fr,
   de, it). English-string-as-key; never call `t()` in module-level consts.
6. **Never edit `site/`** — it's generated. Sources are `site-src/` and the
   `scripts/build-*.mjs` tooling. Same for `dist-single/`.
7. **No AI co-author trailers on commits** (no `Co-Authored-By: Claude` or
   similar), and no bot identities in git history.
8. **Releases are cut locally by the maintainer only.** Never touch signing
   keys (`~/.bento/release-key.json`), never attempt to release, publish, or
   deploy from an agent session unless the maintainer explicitly asks.
9. **External PRs get provenance checks** before merge (`gh api users/<login>`)
   — AI-agent/bot contributions are not merged.
10. **Verify before claiming done**: typecheck, build, and exercise the change
    in a browser when it's user-visible. Report failures honestly.

## Commands

```sh
cd slides
npm install
npm run dev            # dev server (see .claude/launch.json for ports)
npm run build:single   # → dist-single/Bento_Slides.bento.html (the product)
node_modules/.bin/tsc -b            # typecheck
node ../scripts/test-sync.ts        # CRDT convergence rig (SEEDS/STEPS/ACTORS env)
```

## Repo layout

```
slides/           Bento Slides app (src/, single-file build)
server/           Cloudflare workers: sync relay, guestbook daemon
scripts/          build, release, signing, guestbook, site tooling
site-src/         authored landing/guestbook/404 pages (site/ is generated)
docs/             architecture, platform spec, releasing, collab design
```

New apps will live beside `slides/` (working names `spaces/`, `dash/`); the
shared kernel extraction is tracked in `docs/DECISIONS.md`.
