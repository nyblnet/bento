# Bento platform — hosting Worker (Phase 1)

Turns a small structured outline into a URL: compile → store → view →
present → download, backed by Cloudflare's free tier (Workers + R2 + D1).
This is the **backend spine** — the prompt-template page and the
tolerant-paste/review UI a chat AI's output actually lands on are follow-up
work on Cloudflare Pages; see "Known gaps" below for exactly what's deferred
and why.

**Zone discipline** (`docs/PARALLEL-WORK.md`): this directory is its own
ownership zone. It never edits `slides/`, `kernel/`, or `server/` — it only
*consumes* a built `slides/` shell as an artifact. If you're working on
`slides/`/`kernel/`, nothing here should conflict with you.

## How it works

A Bento file is one HTML shell wrapped around a single plaintext
`<script id="bento-doc">` JSON block (`docs/PLATFORM.md` §2, the "splice
contract"). Storing a deck is therefore just storing that JSON; serving one
is `HEAD + escape(json) + TAIL` string concatenation against a shell split
once at build time — no HTML parsing, no per-request template engine.

```
slides build  →  split-shell.mjs  →  SHELL_HEAD / SHELL_TAIL (generated/shell.ts)
                                              │
                        wrangler deploy bundles src/index.ts (Workers Builds, automatic)
                           — or dist/worker.js is bundled+pasted by hand (fallback)
                                              │
                    GET /d/:id  →  SHELL_HEAD + escape(doc from R2) + SHELL_TAIL
```

The escape rule (`<` → `<`) is copied verbatim from
`kernel/src/save.ts`'s `serializeBody`, and `platform/worker/test/splice.test.mjs`
re-derives `scripts/shell-gate.mjs`'s adversarial-payload checks against the
platform's own split shape (round-trip losslessness, script-tag balance, and
a negative control proving the escape is load-bearing — an unescaped hostile
payload is shown actually breaking out into live markup).

## Compiling an outline

`POST /api/compile` turns a small structured **outline** (`platform/worker/src/compile/schema.ts`)
into a real `bento/slides` doc — no storage, pure function, meant to sit
behind a review step before `POST /api/decks` commits anything. This is what
the eventual prompt-template page will ask a chat AI to fill in; for now the
demo page's step 1 (`/`) and any direct API caller can already use it. Eight
layout kinds cover `docs/agents.md`'s content-mapping table (numbers → chart,
comparisons → table, a headline figure → count-up stat, same-thing-changing
→ morph): `title`, `section`, `bullets`, `stat`, `chart`, `table`, `quote`,
`image` (a placeholder box — see "Known gaps"). Consecutive outline slides
sharing a `morphGroup` string get their heading elements paired via `morphId`
and the later slide set to `transition:'morph'`, straight out of
`docs/agents.md`'s own morph recipe.

**The compiler imports `slides/src/model.ts` directly** — real types
(`BentoDoc`, `Slide`, …) and real constructors (`defaultText`, `defaultChart`,
`builtinLayouts`, …) rather than a second, drifting copy of them. This is a
deliberate, one-directional exception to the "platform never touches other
zones" rule in `docs/PARALLEL-WORK.md` §1: *reading* a stable, zero-import,
DOM-free module is not the same as *editing* it, and it's the reuse
`CLAUDE.md` itself calls out as available. It does mean a breaking change to
`model.ts`'s constructors is a compile error in `platform/worker`, not a
silent drift — treat that as the point, not friction. See `docs/DECISIONS.md`
for the full reasoning and what would reopen it.

## Directory layout

```
platform/
  README.md              — this file
  build/
    split-shell.mjs       — slides shell → generated/shell.ts (run after every slides build)
  worker/
    src/
      index.ts            — router (all HTTP routes)
      splice.ts            — HEAD + escape(json) + TAIL
      validate.ts          — ingest validation (POST/PATCH /api/decks, compiled docs too)
      store.ts             — R2 + D1 access
      ids.ts                — random ids/tokens, sha256
      demo.ts               — compile→review→create page served at `/`
      env.ts                — Env (binding) interface
      compile/
        schema.ts            — the outline schema + parseOutline() validator
        compile.ts            — outline → BentoDoc, built on slides/src/model.ts
      generated/shell.ts    — GENERATED, gitignored — do not hand-edit
    schema.sql             — D1 table DDL
    wrangler.toml          — entry point + binding POINTERS for Workers Builds (see below)
    ci-build.mjs           — Workers Builds' "Build command": produces generated/shell.ts
    build.mjs              — esbuild bundle → dist/worker.js, for the manual fallback path
    test/
      splice.test.mjs       — splice conformance (no bindings needed)
      compile.spec.ts        — compiler assertions (TS; bundled+run by compile.test.mjs)
      compile.test.mjs       — runs compile.spec.ts
      router.test.mjs       — full HTTP flow against dist/worker.js, in-memory R2/D1 mocks
```

## Deploy

Resource **creation** is always manual, through the dashboard — R2 buckets
and D1 databases are never created by a CLI or a script here. What's
automated is the **build and deploy step**: Cloudflare Workers Builds
watches this repo and runs `wrangler deploy` on every push, so day-to-day you
never touch the dashboard again after the one-time setup below. A manual
"paste a bundle into Quick Edit" path still exists as a fallback (e.g. no
GitHub access from where you're deploying) — see the bottom of this section.

`wrangler.toml` exists **only** to tell that automated `wrangler deploy`
which pre-existing R2 bucket / D1 database to attach and where the entry
point is — it does not create anything. This mirrors the existing convention
in `server/sync-worker/wrangler.toml` and `server/guestbook-daemon/wrangler.toml`:
binding names/ids are plain config, not secrets, and are committed; anything
actually secret (an API token) would be set with `wrangler secret put`, never
put in this file.

### 1. Create the R2 bucket and D1 database (dashboard, one-time)

- Dashboard → **R2** → Create bucket. Any name (e.g. `bento-platform-docs`).
  No public access needed — the Worker reads/writes it via a binding, and
  asset bytes are served back out through the Worker's own `/a/:id/:key`
  route.
- Dashboard → **D1** → Create database. Any name (e.g. `bento-platform`).
  Open its **Console** tab, paste the contents of
  `platform/worker/schema.sql`, run it. That's the entire migration step —
  no CLI needed.

### 2. Fill in `platform/worker/wrangler.toml` and commit

Replace the three placeholders with the bucket name, database name, and
database ID from step 1 (the D1 dashboard page shows the ID). Commit and
push — these are identifiers, not secrets, safe to commit like the other two
Workers in this repo already do.

### 3. Connect the Worker to this repo (dashboard, one-time)

Dashboard → **Workers & Pages** → Create → **Worker** (name it to match
`wrangler.toml`'s `name`, or attach to an existing Worker of that name) →
**Settings** → **Builds** → connect to this GitHub repo, then set:

| Field | Value |
|---|---|
| Root directory | `platform/worker` |
| Build command | `node ci-build.mjs` |
| Deploy command | `npx wrangler deploy` (the default) |
| Branch | `main` (or whichever you push releases to) |

(Field names are from Cloudflare's Workers Builds UI at the time of writing —
verify against your dashboard, it may have moved.) Trigger the first build
manually from that screen. It will: clone the repo, `npm install` in
`platform/worker` (picking up the pinned `wrangler` devDependency), run
`ci-build.mjs` (which builds `slides/` fresh and runs `split-shell.mjs`), then
`wrangler deploy` (which bundles `src/index.ts` with its own bundler — no
`dist/worker.js` involved in this path at all).

**Binding names are load-bearing** — the code reads `env.DOCS` / `env.DB`
verbatim (`platform/worker/src/env.ts`); they must match `wrangler.toml`'s
`binding = "..."` values exactly.

### 4. Verify

Visit the Worker's `*.workers.dev` URL. `/healthz` should return
`{"ok":true,"shellVersion":"..."}`; `/` is the compile→review→create demo
page — step 1: "Load example outline", "Compile →" (fills step 2); step 2:
"Create deck", then open the `/d/<id>` link it prints. That link is a real,
fully editable `.bento.html` page, and `/d/<id>#present` starts the show
immediately (existing shell behavior, `slides/src/main.ts`).

### From here on

Every push to the configured branch rebuilds `slides/` fresh and redeploys —
decks already stored in R2 are untouched across a shell upgrade; a doc is
forward-compatible by construction (`docs/PLATFORM.md` §3, formats are
additive), so old decks keep working under a newer shell without migration.

### Fallback: manual paste (no Workers Builds, no wrangler.toml read)

```bash
# from the repo root
cd slides && npm ci && npm run build:single && cd ..
cd platform/worker && npm ci
node ../build/split-shell.mjs        # writes src/generated/shell.ts
npm run typecheck                     # tsc --noEmit
npm run build                         # writes dist/worker.js
npm test                              # splice.test.mjs + compile.test.mjs
npm run test:router                   # full HTTP flow, in-memory mocks (needs npm run build first)
```

`dist/worker.js` is one self-contained, minified ESM file (~710KB, ~520KB
gzipped). Dashboard → your Worker → **Quick Edit**, delete the default
script, paste the full contents of `dist/worker.js`, **Save and deploy**.
Bind R2/D1 exactly as in step 3 above if this Worker hasn't been bound yet.
This path never reads `wrangler.toml` and works even if Workers Builds isn't
set up at all.

## API

All `/api/*` routes are CORS-open (`*`) so a future separately-hosted paste/
review UI can call them; decks aren't secret (the URL is the share link) —
only mutation is gated, by the edit token.

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/compile` | POST | none | `{outline}` → `{doc}`. Pure — nothing is stored |
| `/api/decks` | POST | none | `{doc}` → `{id, editToken, url}`. Validates, strips `collab`, mints `docId` |
| `/api/decks/:id` | GET | `Authorization: Bearer <editToken>` | `{doc}` |
| `/api/decks/:id` | PATCH | same | `{doc}` → replaces the stored doc |
| `/api/decks/:id/assets` | POST | same | body = image bytes, header = `Content-Type: image/*` → `{key, path}` |
| `/d/:id` | GET | none | the deck spliced into the shell — a real, editable page |
| `/d/:id/download` | GET | none | same, with `Content-Disposition: attachment` |
| `/a/:id/:key` | GET | none | an uploaded asset's bytes |

The edit token is returned **once**, at creation. Losing it means losing
write access to that deck — there is no recovery flow in v1 (no accounts).

## Known gaps (deliberately out of scope for this PR)

- **No prompt-template page and no tolerant outline parser.** `/api/compile`
  expects the outline JSON to already be well-formed (reasonable — a chat
  model constrained by an explicit JSON schema in its prompt is not the
  "markdown fences and trailing prose" case a hand-typed paste would be); the
  page that shows a user the prompt to copy, and a paste/review UI in front
  of `/api/compile` (stripping fences, surfacing field errors inline, an
  iframe-the-real-draft review step), are both Cloudflare Pages work for a
  follow-up PR. `demo.ts`'s step 1 is a stand-in, not that page.
- **The outline schema is intentionally narrow.** No custom page size (every
  compiled deck is the canonical 1280×720), no per-slide background
  override, no `kicker` on `bullets` slides (no builtin layout has a slot for
  one). Each is a scope cut, not a limitation of the approach — widening the
  schema is straightforward when a real use case needs it.
- **`image` slides are placeholders, not images.** `compileImage` emits a
  server-generated SVG data URI (safe: `<img src="data:image/svg+xml">`
  decodes as raster data, embedded script does not execute — see the comment
  on `placeholderImageSrc`) tagged with a platform-only `phSlot` field. The
  upload UI that finds these slots and replaces them via
  `POST /api/decks/:id/assets` is the same follow-up PR as the paste/review
  page.
- **`svg` elements are rejected on ingest**, not sanitized. Raw author SVG
  markup has no tag/attribute allowlist anywhere in the renderer (unlike
  text/table `html`, which `slides/src/render.ts`'s `sanitizeHtml` already
  defends at render time regardless of what's stored). A real sanitizer for
  arbitrary SVG — nested `foreignObject`, `xlink:href` javascript: URIs,
  embedded `<script>` — is a genuine undertaking; Workers' `HTMLRewriter`
  could do it, but a half-built version is worse than an honest 422.
- **One doc revision.** `PATCH` overwrites in place. No version history
  (`docs/blob-offload.md`-style content-addressing is a natural fit later,
  not built here).
- **No accounts, no rate limiting.** A deck's capability is its edit token;
  losing it loses write access. Fine for "assume low usage" per the current
  brief; revisit before wider exposure.
- **No asset inlining into the download variant.** `/d/:id/download` serves
  whatever the doc already carries — if images are R2 URLs (uploaded via
  `/api/decks/:id/assets`) rather than `data:` URIs, the downloaded file
  is not fully self-contained. True single-file-forever download (inlining
  R2 assets as data URIs) is browser-side work for the upload-UI PR, not the
  Worker's job (base64-ing megabytes server-side risks the CPU budget).
- **No materialized/static serving path.** Every `/d/:id` view costs one
  Worker request. Fine at low volume; the scale valve (materialize the
  spliced HTML into R2 on publish, serve it from an R2 custom domain with
  zero Worker requests per view) is a documented future option, not built.
