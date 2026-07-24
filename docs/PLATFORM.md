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
- block content that is JSON with `<` escaped as `<` — it can never
  contain `</script>`;
- a file that survives `DOMParser → splice → outerHTML` round-trips, with
  balanced script tags and a v0.1.0-style *text* splice still producing a
  well-formed document.

`scripts/release.mjs` runs a conformance gate on all of this before signing.
New apps must run the same gate (or an app-specific equivalent with identical
checks) before any release.

## 3. Document identity & format

- `doc.type` names the format (`bento/slides`; provisionally `bento/spaces`,
  `bento/dash`) with an integer format version.
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

~1KB `t()` with English-string-as-key (missing key = English). Catalogs are
compiled in; new UI strings must land in **all** catalogs in the same PR.
Never call `t()` at module scope (frozen at import). `select()` localizes
display labels only — model values stay English words. Audit with
`setLocale('x-pseudo')`.

## 9. What is kernel vs what is app

Shared (extract once, evolve carefully, serialize changes — see
`docs/PARALLEL-WORK.md`):
save/splice, autosave, encryption, collab engine + relay protocol, signed
update, i18n runtime, compressed-shell build + conformance gate, and (for
Slides+Dash) the charts engine and table rendering.

Per-app (own it, don't prematurely abstract):
the document model, the renderer, the editor UX, starter documents, panels.

## 10. New-app checklist

A new Bento app is on-platform when it:

- [ ] builds to ONE self-contained HTML file passing the §2 conformance gate
- [ ] declares `doc.type` + format version; opens its own older files
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
