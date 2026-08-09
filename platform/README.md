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
    build.mjs              — esbuild bundle → dist/worker.js, used by test:router (below), not by deploy
    test/
      splice.test.mjs       — splice conformance (no bindings needed)
      compile.spec.ts        — compiler assertions (TS; bundled+run by compile.test.mjs)
      compile.test.mjs       — runs compile.spec.ts
      router.test.mjs       — full HTTP flow against dist/worker.js, in-memory R2/D1 mocks
```

## Deploy

Everything below happens **in the Cloudflare dashboard** (dash.cloudflare.com).
No terminal, no local clone — steps 1–4 are all browser clicks, including
editing the one config file.

**Before you start:**

- A Cloudflare account (the free tier is enough for everything here).
- **R2 requires a payment method on file** even on the free tier — Cloudflare
  asks you to "enable R2" the first time you open it, which includes adding a
  card. You will not be charged at this project's scale (10 GB / month
  free), but don't be surprised by the prompt.
- Nothing else — no terminal, no local clone, no Node.js. Every step below
  happens in the browser.

Cloudflare reorganizes its dashboard's navigation labels periodically —
every "Dashboard → **X** → **Y**" click-path below is accurate as of this
writing but may have moved; if a label doesn't match what you see, search
the dashboard for "R2", "D1", or "Workers" and you'll land in the right
place.

Resource **creation** is always manual, through the dashboard — R2 buckets
and D1 databases are never created by a CLI or a script here. What's
automated is the **build and deploy step**: once connected, Cloudflare
Workers Builds runs `wrangler deploy` on every push, so after the one-time
setup below you never touch the dashboard again to ship a change — push to
`main` and it redeploys itself.

`wrangler.toml` exists **only** to tell that automated `wrangler deploy`
which pre-existing R2 bucket / D1 database to attach and where the entry
point is — it does not create anything, and the values inside it are not
secrets (an API token would be, and would never go in this file — see
`server/sync-worker/wrangler.toml` for the same convention already in use
elsewhere in this repo). **If you're setting up your OWN deployment of this
project, the values currently committed in `platform/worker/wrangler.toml`
belong to whoever deployed it before you — you're about to overwrite them
with your own**, not fill in blanks.

### 1. Create the R2 bucket and D1 database

- Dashboard → **R2 Object Storage** → **Create bucket**. Any name (e.g.
  `bento-platform-docs`) — write it down. No public access needed; the
  Worker reads/writes it through a binding, and uploaded assets are served
  back out through the Worker's own `/a/:id/:key` route, not directly from
  R2.
- Dashboard → **D1** → **Create database**. Any name (e.g. `bento-platform`)
  — write it down. Open the new database's own page: near the top you'll
  see a **Database ID** (looks like `9408e034-8812-402a-ac21-42bd78f9f24f`)
  — write that down too, you need both the name and the ID. Then open its
  **Console** tab, paste the entire contents of `platform/worker/schema.sql`,
  and run it. That's the whole migration step — no CLI, no separate tool.

### 2. Edit `platform/worker/wrangler.toml` to point at YOUR resources

You can do this entirely on GitHub, no local clone needed: open
`platform/worker/wrangler.toml` in this repo on GitHub, click the pencil
("Edit this file") icon, make the three changes below, then commit directly
to `main` (or open a PR if you prefer review).

Change exactly these three values to what you wrote down in step 1 — leave
everything else in the file untouched, including `compatibility_date` (it
doesn't need to be today's date; that field is a deliberate Workers-runtime
version pin, not a timestamp to keep fresh):

| In the file | Set it to |
|---|---|
| `bucket_name` under `[[r2_buckets]]` | your R2 bucket's name |
| `database_name` under `[[d1_databases]]` | your D1 database's name |
| `database_id` under `[[d1_databases]]` | your D1 database's ID |

Leave `name = "bento-platform"` and `main = "src/index.ts"` alone — the
Worker you create in step 3 needs to match `name` exactly, and it's simplest
to just keep the committed value rather than change two places in sync.

### 3. Create the Worker and connect it to this repo

- Dashboard → **Workers & Pages** → **Create** → **Worker**. Name it
  **exactly `bento-platform`** (matching `wrangler.toml`'s `name` — this is
  what lets `wrangler deploy` find the right Worker later). Any starter
  template is fine to deploy initially; the first automated build replaces
  it entirely.
- Open the new Worker → **Settings** → **Builds** → connect a repository.
  (Some accounts offer a "Connect to Git"/"Import a repository" option right
  in the Create-Worker flow instead — that shortcut works too, as long as the
  resulting Worker still ends up named exactly `bento-platform`.) You'll be
  prompted to install/authorize Cloudflare's GitHub app — grant it access to
  this repository (or all your repos, your choice), then pick this repo.
  This is a multi-step wizard ("Select a method" → "Select a repository" →
  "Create and deploy"); the fields below are split across those steps, not
  all on one screen:

  | Field | Value | Usually shown on |
  |---|---|---|
  | Path (may be labeled "Root directory") | `platform/worker` | "Select a repository" |
  | Build command | `npm install && node ci-build.mjs` | "Select a repository" |
  | Deploy command | `npx wrangler deploy` (the default — leave it) | "Create and deploy" |
  | Branch | `main` (or whichever branch you push releases to) | either step |

  The final "Create and deploy" step also shows a **"Builds for
  non-production branches"** toggle with its own **"Non-production branch
  deploy command"** (defaults to `npx wrangler versions upload`) — this
  controls whether pushes to branches *other than* `main` get their own
  preview deployment. Leave it on its default; it doesn't affect the
  production Worker either way, and this project doesn't rely on it. You may
  also see an **API token** field, pre-filled with one Cloudflare already
  manages for you — leave whatever's already selected; you don't need to
  create one yourself.

  (Field names/layout are from Cloudflare's Workers Builds UI at the time of
  writing and **will drift** — Cloudflare reorganizes this wizard periodically.
  If a step looks different, look for these same four concepts — which
  directory to build from, what command builds it, what command deploys it,
  which branch triggers it — under whatever labels your dashboard uses.)
- Save, then trigger the first build (there's usually a "Retry"/"Trigger
  deploy" button on the Worker's Builds screen — you don't need to push a
  commit just to kick off the first one). It will: clone the repo, `npm
  install` inside `platform/worker` (picking up the pinned `wrangler`
  devDependency), run `node ci-build.mjs` (which builds `slides/` fresh from
  source and runs `split-shell.mjs`), then `wrangler deploy` (which bundles
  `src/index.ts` with its own bundler and applies the R2/D1 bindings from
  `wrangler.toml`).

You do **not** need to separately visit **Settings → Bindings** and add
anything — `wrangler.toml`'s `[[r2_buckets]]`/`[[d1_databases]]` blocks are
what create those bindings on deploy. That page will show them once the
first build succeeds; it's normal for it to look empty before that.

**Binding names are load-bearing** — the code reads `env.DOCS` / `env.DB`
verbatim (`platform/worker/src/env.ts`); they must match `wrangler.toml`'s
`binding = "..."` values exactly (they already do, in the committed file —
just don't rename `DOCS`/`DB` while editing).

### 4. Verify

If the build failed, the Builds screen shows the log — the most likely
causes are a typo in one of the three values from step 2, or the Worker's
name not matching `wrangler.toml`'s `name`.

If it succeeded: visit the Worker's `*.workers.dev` URL (shown on its
overview page). `/healthz` should return `{"ok":true,"shellVersion":"..."}`.
`/` is the compile→review→create demo page — step 1: click "Load example
outline", then "Compile →" (fills step 2 in below it); step 2: click "Create
deck", then open the `/d/<id>` link it prints. That link is a real, fully
editable `.bento.html` page, and `/d/<id>#present` starts the show
immediately (existing shell behavior, `slides/src/main.ts`).

### From here on

Every push to the configured branch rebuilds `slides/` fresh and redeploys —
decks already stored in R2 are untouched across a shell upgrade; a doc is
forward-compatible by construction (`docs/PLATFORM.md` §3, formats are
additive), so old decks keep working under a newer shell without migration.
This is the only deploy path — there is no manual/local alternative kept
around, so a broken Workers Builds connection is a dashboard problem to fix,
not something to route around.

## Local development

This is for verifying a code change before pushing it — it does not deploy
anything, and Workers Builds does not use any of it (`ci-build.mjs` is the
only thing that runs during a real deploy). Requires Node.js (see `.nvmrc`
for the version) and git locally.

```bash
# from the repo root
cd slides && npm ci && npm run build:single && cd ..
cd platform/worker && npm ci
node ../build/split-shell.mjs        # writes src/generated/shell.ts
npm run typecheck                     # tsc --noEmit
npm test                              # splice.test.mjs + compile.test.mjs
npm run build                         # writes dist/worker.js, needed by the next line
npm run test:router                   # full HTTP flow against dist/worker.js, in-memory R2/D1 mocks
```

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
