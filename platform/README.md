# Bento platform — hosting Worker (Phase 1)

Turns a `bento/slides` document into a URL: paste JSON in, get back a live,
editable, presentable page backed by Cloudflare's free tier (Workers + R2 +
D1). This is the **backend spine** — create → store → view → present →
download — that the rest of the platform (prompt template page, tolerant
paste/review flow, placeholder image upload UI) builds on top of. Those
pieces are follow-up PRs; see "Known gaps" below for exactly what's deferred
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
      validate.ts          — ingest validation (POST/PATCH /api/decks)
      store.ts             — R2 + D1 access
      ids.ts                — random ids/tokens, sha256
      demo.ts               — paste-and-create page served at `/`
      env.ts                — Env (binding) interface
      generated/shell.ts    — GENERATED, gitignored — do not hand-edit
    schema.sql             — D1 table DDL
    wrangler.toml          — entry point + binding POINTERS for Workers Builds (see below)
    ci-build.mjs           — Workers Builds' "Build command": produces generated/shell.ts
    build.mjs              — esbuild bundle → dist/worker.js, for the manual fallback path
    test/
      splice.test.mjs       — splice conformance (no bindings needed)
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
`{"ok":true,"shellVersion":"..."}`; `/` is the paste-and-create demo page —
click "Load example", "Create deck", then open the `/d/<id>` link it prints.
That link is a real, fully editable `.bento.html` page, and `/d/<id>#present`
starts the show immediately (existing shell behavior, `slides/src/main.ts`).

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
npm test                              # splice.test.mjs
node build.mjs && node test/router.test.mjs   # full HTTP flow, in-memory mocks
```

`dist/worker.js` is one self-contained, minified ESM file (~690KB, ~515KB
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

- **No outline-schema compiler.** `POST /api/decks` accepts a complete
  `bento/slides` doc JSON directly — the "paste full Bento JSON, advanced"
  escape hatch from the platform plan. The small outline schema + compiler
  that turns a chat AI's structured answer into good Bento (morph pairs,
  charts, count-ups — see `docs/agents.md`'s content-mapping table) is real,
  separate work and lands as its own PR.
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
