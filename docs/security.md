# Bento security, plainly

*How live collaboration is encrypted, exactly what the relay can and cannot
see, how keys live and die, and how to prove no bytes ever leave your machine.
Written for the skeptic. Everything here matches the code; links point at it.*

Bento is a slide app where **one HTML file is the whole document** — viewer,
editor, and content in a single file you own. Live collaboration is an
**optional layer beside that file**, not a cloud it depends on. This page
explains the security of that layer without hand-waving.

## The model in one line

**The file is the security boundary.** Live collaboration is an optional,
end-to-end-encrypted layer beside it, and every saved copy still opens
standalone, forever, with zero knowledge of a server. If you never turn on
sharing, nothing about your document ever touches the network.

## What the relay sees — and doesn't

When you do share live, frames travel through a relay (a single Cloudflare
Durable Object per room). It is **blind by construction**: your browser
encrypts every frame with AES-GCM *before* it leaves, using a key the relay
never receives.

**The relay SEES:**

- **Ciphertext frames only** — AES-GCM blobs it stores and fans out to the
  other people in the room. It cannot decrypt them; it has no key.
- **A hash of the room key** — the `?tok=` connection token is the first 18
  bytes of `SHA-256(roomKey)`. It proves you hold the key without revealing
  it, so the relay won't fan ciphertext to a stranger who lacks the file.
- **Unavoidable network metadata** — connection timing, frame sizes and
  counts, and your IP (as any web server sees). It enforces per-socket rate
  limits (200 frames / 10s) and expires idle rooms after ~30 days.
- **For signed rooms, the writer's public key** — public by definition, and
  already in every copy of the file (see *Signed writes* below).

**The relay does NOT see:**

- **Your slides.** Text, images, charts, notes — all inside the ciphertext.
- **Your name or presence.** Names live in encrypted frames; the relay never
  sees who is in a room, only opaque sockets.
- **The room key itself.** It is minted in your browser and never sent — only
  a one-way hash of it is.
- **Document structure or metadata of any kind.** There is no title, no
  filename, no schema on the wire — just `{i, d}` (an IV and a ciphertext).

There is **no database of your slides to breach.** The relay's storage is an
append-only list of encrypted op frames plus the latest client-produced
encrypted snapshot — ciphertext end to end, verified in
[`server/sync-worker/src/worker.js`](../server/sync-worker/src/worker.js). The
server cannot produce a snapshot itself; it literally can't read one. A
subpoena of the relay gets noise.

## Key lifecycle

**Keys are born in the file, at creation — never fetched from a server.** When
a document is created it mints two independent things
([`mintCollab`](../slides/src/sync/online.ts)):

1. **A symmetric AES-GCM content key** — the *read capability*. It lives in
   `doc.collab.key`, inside the file, and every copy carries it. This is what
   encrypts and decrypts frames.
2. **A separate ECDSA P-256 writer keypair** — the *write capability* (details
   in *Signed writes*). The public half rides in every copy; the private half
   only in writer copies.

Both are generated with WebCrypto in your browser. **Neither ever leaves the
file or your machine.** The relay only ever sees the *hash* of the content key
and the *public* half of the writer key.

- **"Rotate keys" = revocation.** It mints a fresh room and fresh keys. Every
  copy handed out before the rotation can no longer follow the new session —
  the old key opens the old file, not the live room.
- **Possession of the file is membership.** Anyone you give the file to holds
  the read key and can read the live session. That is the intended design, and
  it's stated plainly under *Limitations*.

### Password encryption is a separate layer

Independently of collaboration, a document can be **password-encrypted at
rest**: the on-disk `#bento-doc` block holds a `bento/enc` envelope —
AES-GCM-256 over the document JSON, with the key derived from your password via
**PBKDF2-SHA-256, 300,000 iterations**
([`slides/src/save.ts`](../slides/src/save.ts)). The password is held only in
memory so autosave and self-update keep writing encrypted. This protects the
file itself; it is orthogonal to the room key that protects live frames.

## Signed writes — read-only that the relay enforces (v0.9.18)

A subtle problem: if read-only were just a flag, it would be a lie. Anyone who
can *decrypt* frames holds the key, and holding the key means being able to
*encrypt and send* too. So Bento splits the single capability in two.

- The **content key** is the read capability (everyone in the room has it).
- The **ECDSA writer keypair** is the write capability. A **read-only copy is
  simply a writer copy with the private key stripped out.**

The room id **commits to the writer's public key**: the room name is
`w` + `base64url(SHA-256(writerPubRaw))`. On connect, a client presents the raw
public key as `?w=`, and the relay checks that its hash equals the room name
before pinning it — so a viewer (who legitimately holds the public key and the
room id) still **cannot substitute their own key** and promote themselves to
writer. This is trustless: no first-writer-wins, no server-side roster.

Thereafter the relay **verifies an ECDSA signature on every mutating frame**
(op batches and snapshots) over the ciphertext, and **drops any that lack a
valid signature** — no persist, no fan-out. Readers have no private key, so
their writes never land. The signature covers the *ciphertext*
(encrypt-then-sign), so the relay authorizes writes **without decrypting
anything** — still blind. Client side is in
[`online.ts`](../slides/src/sync/online.ts) (`signFrame`), enforcement in
[`worker.js`](../server/sync-worker/src/worker.js) (`verifySig`).

Read-only is therefore **cryptographic, enforced at the edge — not an
honour-system flag and not a permissions table someone can misconfigure.**

> **Legacy rooms are permissive.** Rooms created before v0.9.18 have `r`-prefixed
> ids (random, not a key commitment) and are not signature-gated — existing
> shared files keep working unchanged. Rotating keys upgrades a deck to an
> enforced `w`-room.

## Offline mode — nothing leaves this computer

An **Offline switch** (in the About dialog) hard-blocks every network touch:
the update check *and* the relay transport are refused before they open a
socket ([`joinFromDoc`](../slides/src/sync/online.ts) returns early;
same-machine tab sync over BroadcastChannel is not networking and stays on).

There is no telemetry, no analytics, no phone-home. Even with offline mode
*off*, the update check is a bare GET for a signed release manifest — it
carries **no identifier about you or your document**. Offline mode is the "no
cloud, provably" story: flip it on and you can watch the network tab stay
silent.

## Limitations, stated up front

These are deliberate design trade-offs, not oversights. Disclosing them is the
point.

- **Names are key-bound in v1.0.3 rooms; identity is per-device.** Each
  member device signs with its own key, shown as a fingerprint in the People
  list — so "Ana" is provably the same Ana as yesterday, and the owner can
  revoke one device without touching anyone else. What this is NOT yet: proof
  of legal identity (an SSO roster binding keys to directory accounts is
  roadmap). Legacy shared-key rooms keep the old claim-based names.
- **The owner's saved file is the admin capability.** `ownerPriv` lives only in
  the owner's copy: lose that file and the deck keeps working, but nobody can
  mint invites or revoke members any more (recovery = Reset access from any
  writer copy of a legacy room, or re-sharing a fresh deck). Keep a backup of
  your owner file as you would a password. Member keys need no backup — they
  are disposable by design (rejoin via the invite; the owner re-admits).
- **The room key is a read capability.** Anyone you give the file to can read
  the live session and the document. That's the model — the file *is* the
  invitation.
- **Undo under live collaboration is snapshot-based (LWW).** If two people edit
  the same property at once, last-writer-wins; an undo can revert a
  collaborator's concurrent same-property edit. They redo, and the CRDT keeps
  everyone converged — but it is not per-user isolated undo.
- **Same-machine tab sync is cooperative.** Two tabs on one computer sync over
  BroadcastChannel — same trust domain, *not* relay-enforced. Read-only is
  enforced over the network, disabled-in-UI locally.
- **The relay sees metadata.** Timing, frame sizes, counts, and IP are visible
  to the relay (and its host) even though content is not. E2EE hides *what*,
  not *that* you're collaborating or roughly how much.
- **A malicious relay can withhold or reorder** frames, or serve a stale
  snapshot. It **cannot** forge writer ops (no private key) or read content.
  Optional client-side signature verification against a hostile relay is
  additive future hardening, not required for the read-only guarantee.

## Read the source

None of the above asks for trust. The relevant code is small and public:

- [`server/sync-worker/src/worker.js`](../server/sync-worker/src/worker.js) —
  the entire relay (~300 lines): ciphertext storage, token check, signature
  verification.
- [`slides/src/sync/online.ts`](../slides/src/sync/online.ts) — client E2EE,
  key minting, frame signing.
- [`docs/collab-design.md`](collab-design.md) — the full design and threat
  model this page summarizes.

## Reporting a vulnerability

Found something? Please report it privately — see
[`SECURITY.md`](../SECURITY.md) for the disclosure process and scope. Don't
open a public issue for a security bug.
