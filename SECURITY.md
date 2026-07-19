# Security Policy

Bento takes security seriously — the whole project is built around a
local-first, keys-never-leave-your-file model. This document explains how to
report a vulnerability and summarizes the security posture so reports can be
precise.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately through **GitHub's private vulnerability reporting**: open the
repository's **Security** tab → **Report a vulnerability**. This opens a private
advisory visible only to you and the maintainers. (If you can't use that channel,
open a normal issue that says only "security — please enable private reporting"
with no details, and we'll follow up.)

When you report, please include:

- A description of the issue and the impact you believe it has.
- Steps to reproduce, ideally with a minimal `.bento.html` file or a short
  script.
- The affected version (the app version is shown in the About dialog and baked
  into every shell as `APP_VERSION`), plus your browser and OS.

What to expect:

- We aim to acknowledge a report within a few days.
- We'll work with you to confirm the issue, assess severity, and prepare a fix.
- Because updates ship as **signed releases** through the in-app update channel,
  a fix reaches existing files once the maintainer cuts and signs a new version.
- Please give us reasonable time to release a fix before any public disclosure.
  We're happy to credit reporters who want it.

## Scope

In scope:

- The Slides app and runtime (`slides/`).
- The document format and its parsing/sanitization (`slides/src/model.ts`,
  `render.ts`).
- The collaboration engine and E2EE transport (`slides/src/sync/`).
- The blind sync relay (`server/sync-worker/`).
- The signed self-update mechanism (`slides/src/update.ts`).

Out of scope: vulnerabilities in third-party browsers or operating systems,
and issues that require a user to run a `.bento.html` file they already know to
be malicious from an untrusted source (a Bento document is code-adjacent — treat
files from strangers like any other HTML you'd open).

## Security posture (for context)

These are the design guarantees a report can be measured against. The full
design and threat model live in
[docs/collab-design.md](docs/collab-design.md) and
[docs/architecture.md](docs/architecture.md).

- **End-to-end encryption, keys in the file.** Live collaboration frames are
  AES-GCM encrypted under a room key that is minted client-side and lives only
  inside the document. Possession of the file is membership; "Rotate keys" is
  revocation.
- **Blind relay.** The optional sync relay stores and forwards ciphertext only.
  It sees connection timing and a hash of the room key — never content, names,
  or document structure.
- **Signed writes / cryptographic read-only.** Rooms carry an ECDSA P-256 writer
  keypair; the private half travels only in writer copies. The room id commits
  to the public key, and the relay verifies a signature over each mutating frame
  before persisting or fanning it out — so a read-only copy (private key
  stripped) is enforced at the edge, not by client-side courtesy. The relay
  stays blind: it verifies authorship over ciphertext without decrypting.
- **Signed self-updates.** Update manifests are ECDSA P-256 signed; the app
  verifies the signature against a public key embedded in every shell, checks
  the SHA-256 of the fetched shell, and requires the version to be strictly
  newer (no downgrade replay). The signing private key is kept offline and never
  enters the repo or CI. An update writes a **new** file — the original stays as
  a rollback.
- **Pure-data documents.** Text HTML is sanitized and chart options are pure
  JSON with no functions, so a document cannot smuggle executable code through
  the model. The plaintext document block is JSON with every `<` escaped so it
  can never break out of its `<script>` container.
- **Offline by choice, provably.** An Offline switch hard-blocks every network
  touch (update checks and the relay). Update checks are otherwise a bare GET
  carrying no identifiers about you or your document.

## Known trade-offs (documented, not vulnerabilities)

These are deliberate design limits, called out so they aren't reported as bugs:

- **Presence names are claims, not proofs.** Within a shared-key room, displayed
  collaborator names are self-asserted; verified identity would require the
  (designed, not yet built) signed-identity layer.
- **LWW conflict resolution.** Two people editing the same property concurrently
  resolve last-writer-wins; undo during live collaboration is snapshot-based and
  can revert a collaborator's concurrent edit to the same property.
- **The writer file is the write capability.** Anyone holding a writer copy can
  write — that is the intended model; the file's protection is the file's
  protection.
