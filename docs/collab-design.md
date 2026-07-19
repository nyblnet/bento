# Bento collaboration — CRDT design

*Design document, July 2026. Status: **implemented** (M0–M3 shipped in
v0.8.0) — `slides/src/sync/` (engine, session, online transport),
`server/sync-worker/` (relay), `scripts/test-sync.ts` (convergence rig).
Notable deviations from the proposal, all deliberate:
share links became **the file itself** — and since v0.8.1 credentials are
minted at CREATION (random room ids, never docId), dormant behind
`collab.on`, so "send the file first, share later" works and "Rotate keys"
is revocation; a hosted `/s/` joiner page can wrap this later. Offline
forks merge TWO-WAY: saves stamp the CRDT state into `doc.collab.sync`, a
rejoining copy restores it, replay dedups by version vector, and a state
snapshot frame carries the fork's edits to peers. "Duplicate as new deck"
is the explicit identity fork (new docId + fresh credentials). Actor ids
are fresh per session instance (a reloaded tab is a new replica; the
engine skips "own" ops on apply), the relay replay bookmark is memory-only
(valid only alongside the CRDT state it was earned with), and M3 (text
RGA) shipped with the engine rather than after it.
Companion to `architecture.md` §7 (updates) and the local-first principles in
`README.md`.*

## Goals and non-goals

**Goals**

1. Multiple people edit the same deck live; everyone converges to the same
   document without a server ever being the authority.
2. Offline edits merge when connectivity returns — no locks, no "someone else
   is editing" dialogs.
3. The **file stays the source of truth at rest**: any saved copy opens
   standalone forever, with zero knowledge of collaboration. Sync is a layer
   *beside* the file, never a replacement for it.
4. Privacy by architecture: the relay can be blind (E2EE), and nothing about
   a document leaks to infrastructure a user didn't opt into.
5. Fits the Bento budget: small enough to live inside every file
   (single-file invariant — nothing is fetched at runtime).

**Non-goals (for now)**

- Google-Docs-grade concurrent editing *inside one text box* (character-level
  merge). Deck collaboration is overwhelmingly element-level; we start with
  last-writer-wins per text block and leave a clean upgrade path.
- Server-side rendering, web viewers, or hosted documents. The room is a
  conduit, not a home.

## The core decision: which CRDT

Two credible paths:

**A. Yjs** — the mature ecosystem answer. Real text CRDT, awareness protocol,
providers for websocket/IndexedDB, a decade of hardening. Costs: ~30–40KB in
the compressed shell; the whole store must be *mirrored* into Y types (every
mutation site rewritten or bridged); undo moves to Y.UndoManager; the file
gains a second, binary representation of the document (Yjs update log) that
must never diverge from the JSON — and that binary blob is opaque to the AI
tooling contract we just shipped.

**B. bento-sync (in-house, op-based, per-property LWW)** — a CRDT shaped
exactly like our document. The model is unusually CRDT-friendly: every slide
and element already has a globally unique id; properties are scalars/small
JSON; order is the only sequence problem, and fractional indexing solves it
without a sequence CRDT. Ops are plain JSON (readable by the same AI tooling
that reads the document). Estimated ~6–8KB. Costs: we own correctness — a
real responsibility — and text merges are whole-value LWW until/unless we
upgrade.

**Recommendation: B**, with A as the named fallback if property-based testing
shatters confidence. Reasons, in order: (1) the integration point below makes
B nearly free to adopt while A demands a store rewrite; (2) JSON ops preserve
the "everything legible" contract that now defines the format; (3) it matches
the project's pattern — we replaced GSAP and ECharts with engines shaped
exactly to our needs, at ~2% of the size, and the same economics apply; (4)
LWW-per-property is *the correct semantic* for slides — two people dragging
the same box should resolve by recency, not merge into a diagonal.

The convergence math for B is standard and small: a state where every
register merge is by max((lamport, actorId)) is commutative, associative and
idempotent — a textbook state-based CRDT. The risk isn't the algorithm; it's
implementation discipline, which is what the M0 test rig is for.

## The document model as a CRDT

**Identity.** Each browser session gets a persistent random `actorId`. Each
op carries a Lamport timestamp (`lamport`), bumped on every local op and
raised to `max(local, seen)+1` on every received op. `(lamport, actorId)` is
the total order used for all conflict resolution. The document's `docId`
(already shipped) is the room key.

**Node identity (v2, July 2026).** Slides key by their id, but element
nodes key by the **composite `slideId U+001F elementId`** (`elKey` in
`crdt.ts`). The bare element id is deliberately NOT unique across slides —
same-id-on-many-slides is the format's core morph idiom (`data-flip-id`
pairing; the starter deck's `sd-tile-*` cast rides through every slide) —
so v1's bare-id keying collapsed those copies into one node and replicas
diverged (one dropped a copy, the other kept it). Under composite keys
each per-slide copy is its own CRDT node; the document format is untouched
(payloads and materialized JSON carry bare ids; morph pairing happens at
render time and never sees CRDT keys). Consequences: an element node is
pinned to one slide for life, so a cross-slide move diffs as
`del(oldKey)+ins(newKey)` — concurrent moves of the same element to two
different slides duplicate it (both users keep their copy), and concurrent
moves onto the SAME slide collapse to one LWW winner (bare ids stay unique
*within* a slide — the editor invariant). The wire and saved sync state
are versioned (`SYNC_V = 2`: `pv` on frames, `v` in `SyncStateJSON`);
pre-v2 frames, room snapshots, and `doc.collab.sync` blobs are discarded
on sight — an old-scheme file simply rejoins as a never-synced adopt.

**Ops** (all JSON, ~one line each):

```jsonc
{ "a": "actor", "l": 41, "op": "set",
  "sl": "slide-id", "el": "el-id", "k": "x", "v": 640 }

{ "a": "actor", "l": 42, "op": "ins",
  "kind": "element", "sl": "slide-id", "id": "el-new",
  "ord": "a0V", "node": { /* full element JSON */ } }

{ "a": "actor", "l": 43, "op": "del", "kind": "element", "id": "el-old" }

{ "a": "actor", "l": 44, "op": "ord", "id": "slide-2", "ord": "a1" }
```

- `set` — per-(nodeId, key) LWW register. Covers every property edit:
  geometry, style, fx, text html (whole-value), notes, chart options, slide
  props, doc-level props (title, theme).
- `ins` — create with the full node payload and a fractional-index `ord`.
- `del` — tombstone. Delete beats concurrent edits (standard, predictable).
  Tombstones live in the op log, never in the document JSON.
- `ord` — LWW on a node's fractional index (slide order, element z-order).
  Since node identity v2, an element's parent slide is part of its key, so
  `ord` never re-parents — cross-slide moves are `del`+`ins`.

**Order.** Slides and elements carry fractional-index keys (short base-62
strings, jittered to avoid collisions — the Figma/Linear technique). The
JSON arrays in the saved document remain plain arrays *sorted by* these keys;
the keys themselves live in the sync layer's metadata, not the format. A
fresh (non-collaborative) document has no keys until sync first activates.

**Text.** `element.html` is a `set` register in v1. The upgrade path when
character-merge matters: per-text-element sequence CRDT behind the same op
envelope (`op: "txt"`), shippable later without changing anything else.

## Integration: the differ is the bridge

We do not instrument a hundred mutation sites. Every store mutation already
flows through `store.commit / touch`, and `checkpoint()` already snapshots
the document for undo. The sync layer hooks that same seam:

```
commit(mutate) → snapshot before/after → structural diff by id
              → emit ops (set/ins/del/ord) → broadcast
remote op     → apply directly to doc (surgical, by id)
              → store.emit(...) → UI refreshes (existing listeners)
```

The differ is mechanical: compare slides by id (skip identical by reference
or JSON-equality per slide), then elements by id, then properties shallowly.
Deck-scale documents diff in well under a millisecond for typical edits.
This means **collaboration lands with zero rewrites of editor code** — panels,
canvas, morphs, comments all keep mutating the plain JSON they already know.

**Undo under collaboration** becomes per-actor inverse ops (undoing *your*
edits, not your collaborator's) — the differ produces inverses for free
(swap before/after). Single-user undo behavior is unchanged.

## Persistence: the file is a snapshot, the room is a log

The saved `.bento.html` format changes by **one additive optional field**:

```jsonc
"collab": {
  "room": "wss://sync.bento.page/d/<docId>",
  "vv": { "actorA": 812, "actorB": 344 }   // version vector at save time
}
```

- The document JSON in the file is always the *compacted merged state* — a
  file never needs the op log to open. Every invariant we shipped
  (plaintext block, splice contract, AI round-trip, old updaters) is
  untouched.
- The op log lives in the room (server, encrypted) and in IndexedDB (local
  cache/offline queue). On open, the app catches up from `vv`.
- A file copied to a colleague *is a fork* — opening it offline just works;
  opening it online rejoins the room and converges. This is the local-first
  promise kept literally.

## Topology and transport

```
editor ⇄ BroadcastChannel (same machine, free, no server)   [M1]
editor ⇄ wss://sync.bento.page  — Cloudflare Worker + one   [M2]
          Durable Object per docId room:
          · authenticates the room token
          · fans out opaque frames to members
          · persists encrypted ops + periodic encrypted snapshot
          · assigns nothing semantic (CRDT needs no server order)
```

**E2EE.** Share links carry the room key in the URL fragment:
`https://bento.page/s/<docId>#k=<base64url-key>` — fragments never reach any
server. Frames are AES-GCM under a key derived from `k` (WebCrypto, zero
bytes of crypto code shipped). The relay stores ciphertext; a subpoena gets
noise. Possession of the link *is* the capability — appropriate for launch;
accounts/ACLs can wrap this later without changing the protocol.

**Presence** (ephemeral, never persisted): name (localStorage
`bento-author`), a color derived from actorId, current slide, selection ids,
cursor. Rendered as colored outlines + avatars chips; disappears on
disconnect. Same encrypted channel, `p:` frames.

**Offline.** Ops queue in IndexedDB keyed by docId; reconnect exchanges
version vectors both ways. Long-offline forks converge like any other pair
of replicas — that's the whole point of the CRDT.

## Server sketch (M2)

One Worker + Durable Object class, ~300 lines:

- `GET /d/<docId>` upgrade → WebSocket; token = hash(roomKey) proves link
  possession without revealing the key.
- DO state: member sockets; append-only encrypted op log (DO storage);
  encrypted snapshot every N ops (clients produce it — server can't); idle
  TTL ~30 days (the file is the durable artifact; expiry loses nothing but
  convenience).
- Rate limits per IP + per room; ops are size-capped (images travel as
  `assets` set-ops — chunked, or v1 simply discourages giant paste-ins
  mid-session).

## Failure and abuse honesty

- **LWW surprises**: two people restyle the same element simultaneously →
  one wins silently. Mitigated by presence (you see someone on your slide)
  and by the property granularity (their color change + your move both
  survive; only same-property races resolve by recency).
- **Tombstone permanence**: delete wins over concurrent edits; un-delete is
  a fresh insert (undo produces exactly that).
- **Cross-version rooms**: clients stamp ops with the app version; unknown
  op types are buffered, and a room can advertise a minimum version —
  the update channel (already automatic at launch) is the remedy.
- **Clock abuse**: Lamport clocks are logical; wall-clock never decides
  anything.

## Phasing

| Phase | Deliverable | Depends on |
|---|---|---|
| **M0** | `src/sync/` — differ, op codec, merge engine, fractional index; property-based convergence tests (random op interleavings across N simulated actors must converge byte-identical) | nothing |
| **M1** | Same-machine live collab over BroadcastChannel (two windows/tabs); presence; per-actor undo. Ships user value with **zero infrastructure** and validates the whole pipeline | M0 |
| **M2** | `sync.bento.page` Worker + DO relay; E2EE; share links (`/s/<docId>#k=…`); Share UI in the topbar; offline queue | M1 + DNS (exists) |
| **M3** | Text sequence CRDT for `element.html`; in-text cursors | proven demand |

M0+M1 are pure client work, shippable through the existing release channel.
M2 is the first Bento server code ever — small, blind, and replaceable.

## Identity (v0.8.2 posture and the enterprise path)

Identity is deliberately **self-managed and local**: a display name in the
Collaborate popover (localStorage `bento-author`, shared with comments),
shown to peers via presence — zero friction, zero accounts, consistent with
E2EE (the relay couldn't verify identities anyway; it never sees them).
Presence names are therefore *claims, not proofs* — fine for teams that
share room keys deliberately. The future enterprise path, when demand
appears: an optional identity layer where ops/presence are SIGNED by
per-user keypairs and an org roster (SSO-provisioned) maps public keys to
verified names — layered ON TOP of the existing protocol (a signature field
in frames), relay still blind, local-first files unchanged. Nothing shipped
today constrains that design.

## Signed writes — enforced read-only (v0.9.18)

The relay's only gate today is `?tok = SHA-256(key)` — possession of the room
key proves the right to *read and write*. That means "read-only" could only
ever be a client-side courtesy: a viewer must hold the key to decrypt, and
holding the key means being able to encrypt and send too. **Signed writes**
split that single capability into two, so read-only becomes something the
relay ENFORCES — while the relay stays blind to content.

### The two capabilities

- **Content key** (`collab.key`, symmetric AES-GCM, unchanged): the READ
  capability. Every copy — writers and viewers — carries it. `?tok` still
  proves possession so the relay won't even fan ciphertext to a stranger.
- **Writer keypair** (ECDSA P-256, new): the WRITE capability. Minted once
  per room at creation. `collab.writerPub` (raw SPKI, base64url) travels in
  EVERY copy; `collab.writerPriv` (PKCS#8/JWK) travels ONLY in writer copies.
  A **read-only copy is a writer copy with `writerPriv` stripped.**

### Binding the pubkey to the room (trustless, no TOFU)

The relay must know a room's writer pubkey without trusting the client that
presents it — a viewer legitimately holds the room id, so first-writer TOFU
would let a viewer pin *their own* key and become the writer. So the room id
**commits** to the pubkey:

    room name = "w" + base64url(SHA-256(writerPubRaw))      (new, signed)
    room name = "r" + base64url(random)                     (legacy, v0.8–0.9.17)

The leading char is the scheme selector. On connect a client passes
`?w=<writerPubRaw>`; the relay checks `"w"+b64url(sha256(w)) === roomName`
before pinning it. A viewer passes the same (correct) pubkey — it's public and
in the file — but cannot forge signatures without the private half.

### What is signed, and how

Only the frames that mutate what a joiner sees are signed: **op batches**
(`{p:1}`) and **snapshots** (`{snap:1}`). Ephemeral frames (hello / need /
presence / bye) pass unsigned. The signature is ECDSA-P256/SHA-256 over the
UTF-8 of `` `${i}.${d}` `` (iv + ciphertext, both base64url) and rides in a new
envelope field `g`. **Encrypt-then-sign**: the signature covers ciphertext, so
the relay verifies authorship without decrypting — blindness preserved. AES-GCM
already gives key-holders content integrity; `g` adds *authorization*.

### Relay enforcement (`w`-rooms only)

    on connect (w-room):  require ?w, verify "w"+b64url(sha256(w)) == name,
                          store `w` in DO storage (like `tok`; commitment-safe)
    on {p:1} / {snap:1}:  require valid `g` over `${i}.${d}` vs stored `w`,
                          else DROP the frame (no persist, no fan-out)
    on ephemeral frames:  unchanged
    on r-rooms:           unchanged (permissive) — legacy files keep working

### Rollout & backward-compat (the reason to ship now)

- **Client first, relay second, no breakage window.** New clients mint `w`
  rooms and sign ops. The *current* relay ignores the extra `w`/`g` fields and
  the `w` room name — so signed-scheme files work on the old relay
  (permissively) until the new relay deploys and enforcement lights up.
- **Legacy `r` rooms stay permissive forever** — existing shared files never
  break. `rotateKeys()` mints a fresh (now `w`) room, i.e. rotation upgrades a
  deck to enforced.
- **Shipping the protocol now, before the read-only UX, is the point:** every
  room created from here on is signed, so when "read-only viewer" and the
  "presentation package" rename land, they need NO protocol change and break
  NO existing session — read-only is just "save without `writerPriv`."

### Threat model / limits

- Enforcement is at the **relay**. Same-machine tab sync (BroadcastChannel)
  can't be gated there — but same machine = same trust domain, so read-only is
  cooperative locally (editing UI disabled), enforced over the network.
- A malicious *relay* could still withhold/reorder frames or serve a stale
  snapshot; it cannot forge writer ops (no private key) nor read content.
  Optional client-side `g` verification (defence against a hostile relay
  injecting old ciphertext) is a later, additive hardening — not required for
  the read-only guarantee.
- `writerPriv` in a writer file is only as protected as the file. Anyone with
  a writer copy can write — expected: the writer file *is* the write cap.

## Offline mode

A viewer-side hard switch (localStorage `bento-offline`, toggle in About)
that blocks every network touch: update checks and the relay transport.
Same-machine tab sync (BroadcastChannel) is not networking and stays on.
Documents keep their (dormant) credentials — offline mode is a property of
the VIEWER, not the file — so nothing breaks when the switch flips either
way. This is the "no cloud, provably" story for local-first purists.

## What we are explicitly protecting

The five invariants that already define the format survive untouched:
plaintext `#bento-doc`, the splice contract, ids-as-identity, pure-data
documents (ops are data too — no code ever travels the sync channel), and
"any saved file opens alone, forever."
