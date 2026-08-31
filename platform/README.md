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
into a real `bento/slides` doc — no storage, pure function. The demo page
(`/`) drives it end to end: step 1 is a copy-pasteable prompt asking a chat
AI (in an existing conversation, so it already has the topic's context) to
reply with outline JSON matching this schema; step 2 pastes that reply back —
or uploads it, via the "Upload JSON file…" button (`FileReader.readAsText`
into the same textarea the paste path uses, not a separate upload endpoint),
since most chat AIs hand JSON back as a downloadable file rather than
something meant to be copy-pasted — auto-detects that it's outline shaped
(as opposed to an already-compiled `bento/slides` doc — the "advanced"
path), calls `/api/compile`, then `/api/decks`. Any direct API caller can
call `/api/compile` the same way.

Step 1's prompt is built from one of four **content patterns**
(`demo.ts`'s `PATTERNS`: General, Business review, Pitch deck, Tutorial) —
picking a pill swaps the prompt's guidance paragraph and its "Load pattern's
example" example for one tailored to that content shape, but every pattern
compiles through the exact same schema/compiler; only the *guidance given to
the AI* differs, not what the platform can build. Add a pattern by adding an
entry to that array (`id`, `label`, `blurb`, `guidance`, `example`) — no
other code changes needed.
Eight layout kinds cover `docs/agents.md`'s content-mapping table (numbers →
chart, comparisons → table, a headline figure → count-up stat,
same-thing-changing → morph): `title`, `section`, `bullets`, `stat`, `chart`, `table`, `quote`,
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

## Decks that aren't Bento at all: `kind:'html'`

Not every AI-generated deck goes through Bento's own format. Some chat AIs,
asked directly, will hand back a complete, self-running HTML slide deck —
its own JS, its own CSS, no `bento/slides` JSON involved. Step 2 of `/`
auto-detects this (pasted text that isn't JSON but starts with `<!doctype
html>`/`<html>`) alongside its existing outline/doc detection — or use the
"Upload HTML file…" button next to the paste box, which reads the file
client-side (`FileReader.readAsText`) and drops its contents into the same
textarea, so it goes through the identical detect/create path either way,
not a separate upload flow. `POST /api/decks` accepts `{html}` as an
alternative to `{doc}` (`migrations/0005_kind.sql`'s `decks.kind` column,
`'bento' | 'html'`).

An `'html'` deck is stored and served **byte-for-byte** — never parsed,
never compiled, never field-level-editable. It does have ONE edit path: a
full **re-upload**, replacing the stored bytes wholesale
(`PATCH /api/decks/:id` with `{html}` — same shape as create, and also
reachable from the sidebar's context menu as "Re-upload…", which picks a
file, reads it client-side, and PATCHes it). Re-upload re-derives the title
from the NEW file's own `<title>` tag, same rule as create — the content is
now a different file, so its default label follows it; a `{doc}` body
against an `'html'` deck (or `{html}` against a `'bento'` one) is a
kind-mismatch 400, not a silent no-op. Its title otherwise defaults to
whatever its `<title>` tag says (`index.ts`'s `extractHtmlTitle`, a plain
regex — this is a display label, not something the file's behavior depends
on). Because there's no document to grant edit access *to*, `'edit'` is
meaningless for this kind: `POST /api/decks` and the sidebar's Access
submenu both only ever offer `'private'`/`'view'` for one.

**`GET /d/:id` serves an `'html'` deck through a sandboxed `<iframe>`
wrapper, never directly at this origin — deliberately, not an oversight.**
An uploaded HTML file is arbitrary, unreviewed script the owner asked an AI
to hand them — the opposite of Bento's own doc content, which is sanitized
at render time (`slides/src/render.ts`'s `sanitizeHtml`). Serving it
directly at this Worker's own origin would let that script run with the
origin's privileges: same-site cookies attach automatically to same-origin
`fetch()`, so embedded script — even accidental, not malicious — could
silently call the platform's own `/api/decks/*` endpoints using the
**owner's own ambient session** the moment they open their own deck's link
while logged in elsewhere. `index.ts`'s `htmlDeckWrapper` sets
`sandbox="allow-scripts allow-popups allow-forms allow-modals"` —
deliberately **without** `allow-same-origin` — which gives the iframe's
content a unique opaque origin: its script still runs (the deck works),
but it has zero access to this origin's cookies, storage, or same-site
fetch credentials, sandboxed identically for the owner and for anonymous
viewers. This only wraps the *live* view — `/d/:id/download` still serves
the exact original bytes, unwrapped, so the file stays fully portable once
saved locally. Full reasoning: `docs/DECISIONS.md`.

## Sidebar: pinning, resizing, and a real preview panel

- **Pin** (`migrations/0006_pinned.sql`'s `decks.pinned`, `PATCH
  /api/decks/:id/pin`, toggled from the context menu) keeps a deck at the
  top of the sidebar regardless of how recently it was touched.
  `store.ts`'s `listDecks` orders `pinned DESC, updated_at DESC`; pinning
  deliberately does NOT bump `updated_at` (it isn't "touching" the deck's
  content, and bumping it would fight the very ordering pinning exists to
  override). The sidebar renders pinned decks under their own "Pinned"
  label, everything else under "History" — a flat list with a small icon
  buried in each row doesn't scan as fast when the point is finding
  something quickly.
- **Sidebar width is drag-resizable** (`.sidebar-resize-handle`, plain
  mousedown/mousemove/mouseup JS setting `flex-basis`/`width` inline,
  clamped 180–480px) — **deliberately session-only, no persistence**, per
  the request that added it. Reloading resets it to the CSS default
  (300px).
- **Projects** (`migrations/0007_projects.sql`'s `projects` table +
  `decks.project_id`) are a lightweight, purely organizational grouping —
  no access level, no kind, no content of its own, just an id + name to
  render the sidebar as folders. The sidebar renders (top to bottom) Pinned
  → Projects → History; **project wins section placement outright** — a
  deck filed under a project shows ONLY inside that project's folder,
  pinned or not (its pin badge still renders there — see `deckItemHtml` —
  pin just no longer moves it out of its folder). The Pinned section is
  reserved for pinned decks that aren't filed under any project. (An
  earlier version of this had it backwards — pin won, so a pinned+filed
  deck showed only under Pinned while its folder claimed to be empty,
  which read as "the assignment silently failed" rather than what it
  actually was; flipped per user feedback.) A project folder is collapsible
  (`.project-folder-row`, chevron rotates 90°; expand/collapse state is
  session-only, same as sidebar width — no persistence). **The Projects
  section always renders, even with zero projects yet** — it carries its
  own "+" button (`#addProjectBtn`, `prompt()`-based create) right there,
  rather than only being reachable from inside a deck's menu; an empty
  state ("No projects yet — use + to create one.") fills the section
  until the first one exists. A deck's own context menu has a matching
  "Project ▸" submenu (mirrors "Access ▸": "No project" / existing
  projects, checkmarked) — but that submenu is **move-only**, no inline
  "New project…" — creating one belongs to the sidebar's own "+", so
  there's exactly one place to make a project, and moving a deck never
  produces a folder nobody can find afterward. With zero projects, the
  submenu shows a disabled hint pointing back at that "+" instead. A
  project's own ⚙️ gear menu (on its folder row) is Rename / Delete.
  **Deleting a project does NOT delete its decks** — `store.ts`'s
  `deleteProject` unassigns them first (`project_id → NULL`, no
  `ON DELETE CASCADE`), so they simply fall back into plain History. API:
  `GET/POST /api/projects`, `PATCH/DELETE /api/projects/:id`,
  `PATCH /api/decks/:id/project` (body `{projectId}`, string or `null` to
  unfile).
- **Each sidebar section caps its own height and scrolls independently**
  (`.deck-section-items { max-height: 220px; overflow-y: auto }` for
  Pinned/Projects; History is the flexible last section, `flex:1` +
  `min-height:0` inside the deck-list's own flex column, so it fills
  whatever room is left and scrolls on its own too) — a sidebar full of
  pinned decks used to push Projects and History further and further down
  the page; now growth in one section never shoves the others out of
  reach, it just gets its own inner scrollbar.
- **A plain click on a sidebar deck now shows it in the main panel**
  (`#previewPanel`, a header bar + `<iframe src="/d/:id">`) instead of only
  ever opening a new tab — before this, every deck link was
  `target="_blank"`, so the main content area never displayed anything but
  the create wizard, no matter how many decks existed. A modified click
  (Ctrl/Cmd/Shift/Alt, or anything but a plain left button) is deliberately
  **not** intercepted — `preventDefault()` is only called for an
  unmodified click, so the browser's native new-tab/new-window gestures on
  the real `<a target="_blank">` still work exactly as before. The
  preview's own "Open in new tab" link (with the inline `openExternal`
  Lucide icon) is the explicit escape hatch for
  when the panel isn't enough (e.g. presenting).

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
      store.ts             — R2 + D1 access for decks/assets
      auth.ts               — single-owner auth (password hashing, sessions, cookies) +
                               deck share-password hashing/verification (same PBKDF2 machinery)
      authPages.ts           — /setup and /login page markup
      sharePage.ts            — the password gate a non-owner hits at /d/:id when a deck
                                 has a share password and no valid unlock cookie yet
      pageStyles.ts           — shared CSS (demo.ts + the auth/share pages)
      favicon.ts              — the platform's own site icon, served from GET /favicon.png
                                 (repo-root logo.png, embedded as base64 at build time)
      ids.ts                — random ids/tokens, sha256
      demo.ts               — prompt→paste→create wizard + deck history sidebar, served at `/` (owner-only)
      env.ts                — Env (binding) interface
      compile/
        schema.ts            — the outline schema + parseOutline() validator
        compile.ts            — outline → BentoDoc, built on slides/src/model.ts
      generated/shell.ts    — GENERATED, gitignored — do not hand-edit
    migrations/            — numbered, additive D1 schema files (see "Deploy" step 1)
      0001_init.sql          — decks table
      0002_auth.sql           — config (single-owner account) + sessions tables
      0003_editable.sql       — decks.is_editable (superseded same-day by 0004, unused now)
      0004_access.sql         — decks.access ('private'|'view'|'edit', per-deck access level)
      0005_kind.sql           — decks.kind ('bento'|'html', see "Decks that aren't Bento at all")
      0006_pinned.sql         — decks.pinned (sidebar pin, see "Sidebar: pinning, resizing, and a real preview panel")
      0007_projects.sql       — projects table + decks.project_id (sidebar folders, same section)
      0008_share_password.sql — decks.share_password_* (see "Share passwords" section)
    wrangler.toml          — entry point + binding POINTERS for Workers Builds (see below)
    ci-build.mjs           — Workers Builds' "Build command": produces generated/shell.ts
    build.mjs              — esbuild bundle → dist/worker.js, used by test:router (below), not by deploy
    test/
      splice.test.mjs       — splice conformance (no bindings needed)
      compile.spec.ts        — compiler assertions (TS; bundled+run by compile.test.mjs)
      compile.test.mjs       — runs compile.spec.ts
      auth.spec.ts            — auth.ts unit assertions (TS; bundled+run by auth.test.mjs)
      auth.test.mjs           — runs auth.spec.ts
      router.test.mjs       — full HTTP flow against dist/worker.js, in-memory R2/D1 mocks
```

## Authentication

Single owner, no signup, no other accounts — ever. The first time the Worker
runs with no account configured, every owner-only page redirects to `/setup`;
after that one-time form, `/setup` itself redirects to `/login` and refuses
to run again (`POST /api/setup` returns 409 if a config row already exists).
Login issues a **session** — an opaque random token stored as a row in the
`sessions` table and set as an `HttpOnly`, `Secure`, `SameSite=Lax` cookie;
validating a request is a lookup by that token, not signature verification,
so logout is just deleting the row (`auth.ts`). This is a deliberate choice
for a single-owner, low-traffic project — no signing-key management, no JWT
library, one small D1 row per active session.

Passwords are hashed with PBKDF2-SHA-256 at **100,000 iterations — the
maximum the Workers runtime allows**, not a tuning choice (`workerd` hard-
rejects anything above that: `NotSupportedError: Pbkdf2 failed: iteration
counts above 100000 are not supported`). Same PBKDF2-SHA-256 family
`kernel/src/save.ts` uses for `bento/enc` password-protected decks, but
*not* the same count — that code runs in a browser, which has no such cap,
and its 300,000 will 500 immediately if copied into a Worker (this shipped
that exact bug once; see `docs/DECISIONS.md`). **The salt is always
generated server-side** (`crypto.getRandomValues`); there is no code path
that accepts or stores a caller-supplied salt.

`GET /d/:id`, `GET /d/:id/download`, and `GET /a/:id/:key` route around this
gate entirely — what a non-owner (no valid session) gets there depends
instead on the deck's own **access level** (`PATCH /api/decks/:id/access`,
`migrations/0004_access.sql`'s `access` column, default `'edit'`; changed
anytime from the sidebar's ⚙️ dialog, or picked upfront in the create form's
dropdown — three states, one per option:

- **`'private'`** — nobody without the owner's session can reach it at all.
  `handleView`/`handleAsset` return the same 404 an unknown id would; a
  private deck's existence isn't observable, not just its content.
- **`'view'`** — anyone with the link, but read-only: `handleView` splices
  `readonly: true` into the served doc, which boots Bento straight into its
  own PLAYER mode (a "▶ Present" card, no editor chrome — the same code path
  as the editor's own "Save as presentation package…" export) instead of a
  bespoke read-only renderer.
- **`'edit'`** — the same live editor the owner sees. The default, matching
  how every deck link behaved before this column existed.

The owner's own session always gets the full editable doc/assets regardless
of `access` — the column only affects anonymous viewers.

## Share passwords: a second, optional gate for content-sensitive decks

`access` controls what the LINK grants. A **share password**
(`migrations/0008_share_password.sql`'s `decks.share_password_*` columns,
`PATCH /api/decks/:id/password`, set from the deck's context menu's
"Password…" item) is a second, independent gate layered in FRONT of that —
for a `'view'`/`'edit'` deck whose content is sensitive enough that knowing
the link shouldn't be sufficient by itself. A `'private'` deck is unaffected
either way (already unreachable by anyone but the owner); setting a password
on one isn't rejected, just moot, matching this codebase's existing "not
applicable, not invalid" treatment of e.g. `'edit'` access on an `'html'`
deck.

Same PBKDF2-SHA-256 machinery as the owner's own account password
(`auth.ts`'s `hashSharePassword`/`verifySharePassword` — one
`derivePasswordHash` implementation, two callers), stored per-deck rather
than in the single-row `config` table. When a deck has a password set,
`handleView` shows `sharePage.ts`'s small gate page to any non-owner
instead of the real content — the doc/HTML bytes are never sent to the
browser until the password is verified — and `handleAsset` 401s outright
(it's meant to be loaded by an already-unlocked page, not browsed to). The
owner's own session always bypasses the gate, same as `access`.

Unlocking is **stateless — no D1 row per unlock**, unlike sessions:
`POST /api/decks/:id/unlock` verifies the submitted password, then sets a
cookie named `bento_unlock_<deckId>` whose value is
`sha256(deckId + ':' + passwordHash)`. The hash half of that digest is
known only server-side, so the cookie is unforgeable without first
supplying the correct password once — and it's automatically invalidated
the instant the password changes, since a fresh hash makes every
previously issued cookie's digest wrong. "Rotate to revoke," the same idea
the collab feature's key rotation already uses elsewhere in this codebase;
no separate "sign everyone out" action needed. Removing a deck's password
entirely (`{password: null}`) clears all three columns and has the same
effect — any cookie earned under the old password stops matching.

Asset caching gets the same treatment private decks already get:
content-addressed asset URLs are normally `public, max-age=31536000,
immutable` (safe because the URL itself changes if the bytes do), but a
password-protected deck's assets are `private, no-store` regardless of
`access` — a shared/CDN cache can't tell "this visitor unlocked it" from
"this visitor didn't," so caching the response would leak content past the
gate to the next visitor requesting the same URL.

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
  **Console** tab and run each file in `platform/worker/migrations/` **in
  numeric order** — `0001_init.sql`, `0002_auth.sql`, `0003_editable.sql`,
  `0004_access.sql`, `0005_kind.sql`, `0006_pinned.sql`, `0007_projects.sql`,
  `0008_share_password.sql`. That's the whole migration step — no CLI, no separate
  tool. (If you already ran `0001` from an earlier version of this project
  under its old name, `schema.sql` — same file, just moved and renumbered —
  you only need to run whichever numbered files come after the one you last
  ran.)

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

Leave `name = "bento"` and `main = "src/index.ts"` alone — the Worker you
create in step 3 needs to match `name` exactly, and it's simplest to just
keep the committed value rather than change two places in sync. (In
practice, Workers Builds' CI deploy targets whatever Worker it's connected
to regardless of this field — this only actually matters if you ever run
`wrangler deploy` by hand. Keep it correct anyway: a wrong `name` here is
invisible until someone runs a manual command against it and gets "this
Worker does not exist.")

### 3. Create the Worker and connect it to this repo

- Dashboard → **Workers & Pages** → **Create** → **Worker**. Name it
  **exactly `bento`** (matching `wrangler.toml`'s `name`). Any starter
  template is fine to deploy initially; the first automated build replaces
  it entirely.
- Open the new Worker → **Settings** → **Builds** → connect a repository.
  (Some accounts offer a "Connect to Git"/"Import a repository" option right
  in the Create-Worker flow instead — that shortcut works too, as long as the
  resulting Worker still ends up named exactly `bento`.) You'll be
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
Visiting `/` with no account configured yet redirects to `/setup` — pick a
username and password there (this only works once; see "Authentication"
above) and you land back on `/`, now logged in. `/` is the prompt→paste→
create wizard — in step 2, click "Load example outline", then "Create deck
→", then open the `/d/<id>` link it prints. That link is a real, fully
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
review UI can call them, though a cross-origin caller won't be able to ride
the owner's session cookie (browsers require `Access-Control-Allow-Origin`
to be a specific origin, not `*`, for credentialed requests) — that's a
problem for whenever that app exists, not solved here.

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/setup` | GET | none | setup form; redirects to `/login` once an account exists |
| `/api/setup` | POST | none | `{username, password}` → creates the (only) account, starts a session. 409 if one already exists |
| `/login` | GET | none | login form |
| `/api/login` | POST | none | `{username, password}` → starts a session on success |
| `/api/logout` | POST | none | ends the current session |
| `/api/compile` | POST | owner session | `{outline}` → `{doc}`. Pure — nothing is stored |
| `/api/decks` | GET | owner session | `{decks: [{id, title, createdAt, updatedAt, access, kind, pinned, projectId, hasPassword}]}`, pinned first then most-recently-touched — the sidebar's data source. `hasPassword` is a plain boolean; the hash/salt are never sent to any client, owner included |
| `/api/decks` | POST | owner session | `{doc, access?}` (a `'bento'` deck) or `{html, access?}` (an `'html'` deck) → `{id, url}`. `access` is one of `'private'\|'view'\|'edit'`; defaults to `'edit'` for `doc`, coerced to `'view'` if `'edit'` for `html` (meaningless for that kind, not rejected) |
| `/api/decks/:id` | GET | owner session | `{kind:'bento', doc}` or `{kind:'html', html}` |
| `/api/decks/:id` | PATCH | owner session | `{doc}` replaces a `'bento'` deck's stored doc; `{html}` re-uploads an `'html'` deck's stored bytes wholesale, re-deriving the title from the new file's `<title>`. Sending the wrong shape for the deck's kind is a 400, not a silent no-op |
| `/api/decks/:id` | DELETE | owner session | permanently deletes the deck: D1 row + stored bytes (`doc.json` or `doc.html`) + every asset blob under its R2 namespace. 404 on an unknown id |
| `/api/decks/:id/access` | PATCH | owner session | `{access}` → `{ok, access}`. Changes what anonymous viewers get. 422 on an invalid value, 404 on an unknown id |
| `/api/decks/:id/title` | PATCH | owner session | `{title}` → `{ok}`. For a `'bento'` deck, rewrites `doc.title` itself (there's no separate cosmetic label) — same effect as editing the title in the live editor. For an `'html'` deck, updates only the D1 label; the stored bytes are untouched. 422 on a blank title, 404 on an unknown id |
| `/api/decks/:id/pin` | PATCH | owner session | `{pinned}` → `{ok, pinned}`. Keeps the deck atop the sidebar regardless of `updated_at` (pinning itself never bumps it). 422 on a non-boolean, 404 on an unknown id |
| `/api/decks/:id/project` | PATCH | owner session | `{projectId}` (a project id, or `null` to unfile) → `{ok, projectId}`. 422 on a value that's neither a string nor `null`, 404 on an unknown deck id (the project id itself is NOT validated against `projects` — an id that doesn't exist just renders unfiled, same graceful-degrade as any other dangling foreign key here) |
| `/api/decks/:id/password` | PATCH | owner session | `{password}` (a non-empty string, or `null` to remove protection) → `{ok, hasPassword}`. 422 on an empty/blank string, 404 on an unknown id |
| `/api/decks/:id/unlock` | POST | **none — public** | `{password}` → `{ok}` + sets a `bento_unlock_<id>` cookie on success. Always 401 `{error:'incorrect password'}` on a wrong password, an unknown deck, or a deck with no password set — never distinguishes which, so this route can't be used to probe whether a deck exists or is protected |
| `/api/decks/:id/assets` | POST | owner session | body = image bytes, header = `Content-Type: image/*` → `{key, path}` |
| `/api/projects` | GET | owner session | `{projects: [{id, name, createdAt, updatedAt}]}`, alphabetical |
| `/api/projects` | POST | owner session | `{name}` → `{id}`, 201. 422 on a blank name |
| `/api/projects/:id` | PATCH | owner session | `{name}` → `{ok}`. 422 on a blank name, 404 on an unknown id |
| `/api/projects/:id` | DELETE | owner session | deletes the project row only — its decks are unassigned first (`project_id → NULL`), never deleted. 404 on an unknown id |
| `/d/:id` | GET | depends on the deck's `access` | `'private'` → 404 unless it's the owner's session. For a `'bento'` deck: `'view'` (non-owner) → `readonly: true` spliced in, boots Bento's present-only PLAYER mode; `'edit'`, or any owner session → the real, live editor page. For an `'html'` deck: always the sandboxed iframe wrapper (see "Decks that aren't Bento at all"), owner included |
| `/d/:id/download` | GET | same as `/d/:id` | `'bento'`: same content rules as `/d/:id`, with `Content-Disposition: attachment`. `'html'`: the exact original bytes, unwrapped (no sandbox — see that section for why the wrapper only applies to the live view) |
| `/a/:id/:key` | GET | same as `/d/:id` | an uploaded asset's bytes; 404 for a non-owner if the deck is `'private'` |
| `/favicon.png` | GET | none — public | the platform's own site icon (`favicon.ts`), `Cache-Control: public, max-age=31536000, immutable` |

"Owner session" = the `bento_session` cookie set by `/api/login` (or
`/api/setup`, which logs you in immediately) — see "Authentication" above.
The previous per-deck capability-token model (`editToken`, `Authorization:
Bearer`) is gone; every mutation now checks the single owner's session
instead. Viewing (`/d/:id`, `/d/:id/download`, `/a/:id/:key`) never checks a
session for a `'view'` or `'edit'` deck, but a `'private'` deck's owner
session IS checked there too — it's the one thing standing between "reachable
by anyone" and "404 for everyone but you." See "Known gaps" for what's still
not covered.

## Known gaps (deliberately out of scope for this PR)

- **The deck history sidebar's right-click menu (rename, access, delete) is
  per-deck only, not a general management view.** `/` shows a ChatGPT-style
  sidebar (`GET /api/decks`, most-recently-touched first) with a "+ New deck"
  action, a clickable entry per deck, a kind badge for `'html'` decks, a
  status icon (unlock/eye/lock — inline SVG, no icon font), and a right-click
  (or ⚙️ button) menu — but there's no bulk action (no multi-select delete, no
  "show only private decks" filter), and no audit trail of who changed what
  (single-owner project, so "who" is always the one account). No pagination
  either; `listDecks` is capped at 200 rows, which is fine at this project's
  declared scale and not worth solving before it's a real problem. Deletion
  has no undo/trash — `DELETE /api/decks/:id` removes the D1 row and every R2
  object (doc + assets) immediately; the confirmation prompt (a native
  `confirm()`, naming the deck by title) is the only safety net.
- **A private deck's title still round-trips through the sidebar and the
  `/api/decks` list** — those stay owner-session-gated, so this isn't a leak,
  but it means "private" specifically means "invisible to anyone without my
  session," not "encrypted" or "hidden from me too." That's the intended
  scope (the threat model is "randoms with the link," per the request that
  added this), not an oversight.
- **`'html'` decks have no field-level edit, no version history, and no
  diffing** — re-upload (`PATCH /api/decks/:id` with `{html}`, or the
  sidebar's "Re-upload…") is a real, supported action, but it's a wholesale
  replace: the old bytes are simply gone the moment it succeeds, no
  soft-delete, no "revert to previous," same no-undo posture as
  `DELETE /api/decks/:id`. Title extraction (`extractHtmlTitle`) is a plain
  regex on `<title>`, not an HTML parser — a file whose `<title>` tag is
  unusually malformed just falls back to "Untitled deck," a cosmetic miss,
  not a correctness bug (nothing else about the deck depends on that
  extraction succeeding). The 8MB size cap matches the image-asset limit as
  a convenience, not a principled number for
  this content type — revisit if a real deck ever needs more.
- **Edits made in the live-served editor aren't saved back.** Opening `/d/:id`
  while logged in serves the full, editable Bento app, but the in-browser
  editor still only holds its state in the browser (same as opening any
  `.bento.html` locally) — nothing currently pushes those edits to R2/D1.
  That needs a small, precise event hook added to `slides/src/main.ts`
  (`window.bento` today exposes no way for an externally-injected script to
  know a doc mutation happened — verified before writing this, see
  `docs/DECISIONS.md`) plus a debounced save-back listener here. Deliberately
  its own follow-up: it's the one piece of this feature set that reaches
  into a different ownership zone (`docs/PARALLEL-WORK.md` §1) and deserves
  its own focused review.
- **No tolerant outline parser.** `demo.ts` now covers the real information
  architecture — step 1 is a copy-pasteable prompt for an existing AI
  conversation, step 2 pastes the reply back and auto-detects outline vs.
  full-doc JSON — but parsing is still a bare `JSON.parse`. If a model
  ignores the prompt's "no markdown fences" instruction, the user has to
  strip them by hand; there's no fence-stripping, no inline per-field
  validation UI (errors are a flat text list), no draft-preview iframe
  before committing. A dedicated Cloudflare Pages app with that polish is
  still a follow-up PR — `demo.ts` gets the flow right, not the finish.
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
- **No rate limiting.** Single owner, so there's no multi-tenant abuse
  surface on the mutating routes — but `/setup`/`/login` have no throttle
  either, and a 'private' deck's 404-not-403 (see "Authentication") only
  hides *existence*, not brute-force cost. Fine for "assume low usage" per
  the current brief; revisit before wider exposure. (The old "capability is
  an edit token" model this bullet used to describe is gone — see
  "Authentication" above.)
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
