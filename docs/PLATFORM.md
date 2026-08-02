# The Bento platform — invariants every app must honor

Bento is growing from one app (Slides) into a suite (Spaces, Dash, …). This
document is the contract that makes them all *Bento*: the properties a file
must keep so that shipped documents — including ones saved years ago —
continue to open, save, update, and sync. **Breaking an invariant here doesn't
break the build; it bricks files that are already on users' disks.**

`slides/` is the reference implementation for everything below. When this doc
and the code disagree, the code that *shipped* wins — fix the doc.

## 1. One file is the product

A Bento document is a single self-contained HTML file carrying the document
data, the viewer, and the editor. It must work from `file://`, from a static
host, and from an email attachment — no backend, no CDN, no network required
to open, edit, present, or save. Anything that adds a runtime network
dependency to the core document lifecycle is off-platform.

Byte order of a shipped shell (postbuild-compress):
`chrome → NOTICE → tooling comment → plaintext #bento-doc → splash → compressed payloads`.
Runtime JS/CSS ship deflated in `bento/deflate-b64` script blocks with a ~1KB
loader (DecompressionStream → blob import).

## 2. The splice contract (FROZEN)

Self-save and self-update work by re-splicing the document block into a shell.
Updaters embedded in already-shipped files are frozen code, so every future
build of every app must keep:

- a `<script type="application/bento+json" id="bento-doc">` block that is
  **plaintext** (never inside the compressed payloads), same id, forever;
- block content that is JSON with `<` escaped as `\u003c` — it can never
  contain `</script>`;
- the SAME escaping on every other plaintext data block the shell carries
  (`application/bento+*`, written by `registerShellBlocks` — language packs
  today): their bodies are not authored by us, so an unescaped one could
  close its own block or forge a second `#bento-doc` opening tag for an old
  updater to splice into;
- a file that survives `DOMParser → splice → outerHTML` round-trips, with
  balanced script tags and a v0.1.0-style *text* splice still producing a
  well-formed document.

`scripts/release.mjs` runs a conformance gate on all of this before signing.
New apps must run the same gate (or an app-specific equivalent with identical
checks) before any release.

## 3. Document identity & format

- `doc.format` names the format (`bento/slides`, `bento/spaces`; `bento/dash`
  to come) with an integer format version in `doc.version`. The field is
  `format` — `slides/src/model.ts` exports `FORMAT = 'bento/slides'` and writes
  it as `format`, and every reader keys off that.
- **Formats are additive.** Every version opens files from every earlier
  version; unknown fields are preserved, not stripped. Breaking reads of old
  files is not an option — there is no server to migrate them.
- `docId` (uuid) is minted once at creation/load and never regenerated. It
  keys autosave recovery, collab identity, and future sync/merge. "Duplicate
  as new deck"-style flows mint a fresh `docId` + fresh collab creds — that is
  the *only* sanctioned way an id changes.
- Locale/language never enters the document format; i18n follows the viewer.

## 4. Save, autosave, encryption

- Self-save: capture the pristine shell at boot, swap the `#bento-doc` block,
  re-serialize. File System Access API first, download fallback.
- **Runtime-injected DOM must be marked `data-bento-transient`.** The pristine
  capture clones the LIVE document, so anything the runtime adds before it —
  the compressed shell's inflated stylesheet, first of all — would otherwise be
  written into the saved file, then re-injected on the next boot and saved
  again: unbounded growth, one copy per save (~100KB each for the CSS, which
  ships deflated for a reason). `serializeBody` strips the marked nodes from
  every serialized shell. Inject before the capture only if you mark it —
  `scripts/shell-gate.mjs` proves both halves on every CI build (the loader
  marks what it injects; the runtime still strips it) and rejects a shell that
  carries any payload's content as plaintext.
- Autosave (IndexedDB) keeps a latest-recovery snapshot + a capped version
  timeline, keyed by `docId`. Read-only players skip autosave.
- Password-protected docs use the `bento/enc` envelope (PBKDF2-SHA-256 300k →
  AES-GCM-256 over the doc JSON) *inside* the plaintext block — the splice
  contract still holds. **Encrypted docs are never snapshotted to IndexedDB in
  plaintext**, and every write-back path stays encrypted while the password is
  held in memory.

## 5. Collaboration (E2EE, blind relay)

Authoritative spec: `docs/collab-design.md`. The non-negotiables:

- The relay stores/relays **ciphertext only** (AES-GCM; key in `doc.collab.key`,
  never sent to the server). Room ids are random or key-committed — never the
  `docId`, never derived from content.
- **The saved file is the capability**: opening a copy joins the session.
  Reader copies strip private keys (`writerPriv`, `ownerPriv`, invites);
  read-only is enforced cryptographically by the relay, not honour-system.
- Credentials are minted at creation but a never-saved/never-shared doc stays
  **dormant** — a fresh template or demo must never phone home.
- Engine changes (`sync/crdt.ts`) require the convergence rig
  (`node scripts/test-sync.ts`) before merge. No exceptions.
- Relay changes require `wrangler deploy` and must stay backward-compatible
  with already-shipped clients (deploy relay before client when a handshake
  changes).

## 6. Signed self-update

- Shipped files check `https://bento.page/releases/<app>/manifest.json`
  (user-initiated or launch check) and verify: ECDSA P-256 signature over the
  manifest payload against the `PUBLIC_KEY_JWK` embedded in the shell, sha256
  of the fetched shell, and **version monotonicity**.
- Manifest shape: `{ payload: "<json string>", sig: "<b64>" }` where payload
  carries `{ app, version, sha256, url, at }`.
- The signing key lives offline (`~/.bento/release-key.json`), never in the
  repo or CI. Releases are cut locally so the signed bytes are the served
  bytes (`docs/RELEASING.md`). Updates write a NEW file or keep an explicit
  FSA handle — the original stays as rollback.
- All apps share the release channel pattern; each app gets its own manifest
  path under `releases/`.

## 7. AI round-trip

The **document JSON** is the interchange unit for AI tooling — chat models
can't emit multi-MB files. Every app exposes: copy document JSON / replace
document from JSON (undoable), plus a scripting surface on `window.bento`
(`doc`, `serialize()`, `loadDoc(json)`, …). The shell carries a tooling
comment pointing agents at `#bento-doc` and this API. Keep model JSON pure
data — template strings over functions (see charts: formatters are `{b}/{c}`
templates, never code).

## 8. i18n

~1KB `t()` with English-string-as-key (missing key = English). Never call
`t()` at module scope (frozen at import). `select()` localizes display labels
only — model values stay English words. Audit with `setLocale('x-pseudo')`.

Catalogs come in two tiers. A **bundled core** is compiled in — the per-locale
files under `slides/src/i18n/` are the authored source, packed key-once into
`packed.ts` by `scripts/build-i18n.mjs` (CI gates that it is current). New UI
strings must land in **all** core catalogs in the same PR. Every other language
is a **signed pack**, released centrally and spliced into the file on demand;
see `i18n-packs.md`. Packs are additive — a file that never fetches one behaves
exactly as before — and both tiers fall back per string to the English key,
which is what lets a stale or partial pack degrade instead of break.

Four pack rules are platform-level, not app choices:

- **A pack lives in the FILE and nowhere else.** No browser-local copy: the
  download comes from an https origin and the file is then opened from
  `file://`, so anything stored per-origin vanishes on the journey the product
  encourages. A pack rides in an `application/bento+lang` block written by
  `registerShellBlocks` (kernel `save.ts`), under the same `\u003c`-escaping
  and the same §2 splice contract as `#bento-doc` — `scripts/shell-gate.mjs`
  proves a pack-carrying shell conformant, with an adversarial pack, on every
  build.
- **Adding is staged, and written on the next save.** Writing on click means a
  silent second download of the user's deck on every browser without File
  System Access.
- **Self-update carries packs forward** and refreshes them for the incoming
  version (`registerUpdatePrepare` in kernel `update.ts`), best effort — a pack
  that cannot be re-fetched is kept, never dropped.
- **Fetched packs are verified against the signed release channel; embedded
  packs are not re-verified** — they carry the same trust as the document
  around them, and opening a file must never require the network.

### Direction (RTL) — two halves, never confuse them

**Content direction belongs to the DOCUMENT and is per element.** Text
resolves its own base direction from what the author typed (`dir="auto"` in
the renderer), so an Arabic paragraph reads RTL beside an English one in the
same file. This is data: it renders identically for every viewer, and it is
the half that fixes real bugs (misplaced sentence-final punctuation).

**Chrome direction belongs to the VIEWER and never enters the format.** The
editor flips to RTL when the viewer's locale is RTL — the same viewer-scoped
pattern as `bento-lang` and reduce-motion. `applyDirection()` runs AFTER
`capturePristine()`, so a saved file can never carry a `dir` attribute. Lay
chrome out with logical properties (`inset-inline-start`, `margin-inline-end`,
`text-align: start`) and it mirrors itself; only glyphs that encode a
direction in their SHAPE need flipping by hand.

> **INVARIANT — the document never mirrors.** Elements carry absolute x/y
> model coordinates, so a document MUST render identically regardless of who
> opens it. A document whose appearance depends on the viewer's locale is a
> format-level bug, and a worse outcome than an unmirrored UI. Every surface
> that renders document content is therefore pinned `direction: ltr`: the
> document root, thumbnails, the scroller, the present overlay, print, and any
> body-mounted overlay that reads coordinates (e.g. Moveable's control box,
> which mounts outside the document subtree and needs its own pin).
>
> An app adding a new document-rendering surface MUST pin it. The pin is also
> what keeps direction away from `scrollLeft` — the one layout API whose
> meaning genuinely changes under RTL — so coordinate math stays untouched.

## 9. What is kernel vs what is app

Shared — **`kernel/src/`**, extracted and in use (evolve carefully, serialize
changes — see `docs/PARALLEL-WORK.md`): `save.ts` (splice + bento/enc
encryption), `autosave.ts`, `update.ts`, `anim.ts`, `charts.ts`, the `i18n.ts`
engine, `app.ts` (per-app identity via `configureApp`), `doc.ts` (the
`KernelDoc` envelope). Apps import these through facades at their own paths.

Also shared but NOT yet in `kernel/`: the collab engine (`slides/src/sync/`)
and the relay (`server/`). Both are slides-shaped today and genericizing the
CRDT is its own project — treat them as kernel-zone for serialization.

Shared build tooling: `scripts/postbuild-compress.mjs` (parameterised per app
via `--generator` / `--title`) and `scripts/shell-gate.mjs`.

Per-app (own it, don't prematurely abstract):
the document model, the renderer, the editor UX, starter documents, panels.

## 10. New-app checklist

A new Bento app is on-platform when it:

- [ ] builds to ONE self-contained HTML file passing the §2 conformance gate
- [ ] declares `doc.format` + `doc.version`; opens its own older files
- [ ] mints and preserves `docId` per §3
- [ ] self-saves (FSA + download) and autosaves per §4
- [ ] supports the `bento/enc` envelope per §4 (or explicitly documents why not yet)
- [ ] ships collab dormant-by-default per §5, or ships without collab wired
      rather than with a half-secure version
- [ ] verifies signed updates per §6 with its own manifest path
- [ ] exposes the AI round-trip surface per §7
- [ ] uses the shared i18n runtime per §8
- [ ] has a starter document that demos the app honestly
- [ ] documents its model in its own CLAUDE/README section
