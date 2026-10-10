# bento relay — design

*Design document, July 2026. Status: **proposed** — nothing built. The relay
is a product in its own right, separate from `bento/vault` and with its own
release train. Today's collab relay (`server/sync-worker/`) is a narrower
ancestor of this; the two converge —
see* Relationship to the collab relay *below.*

## What it is

Rendezvous plumbing. It lets a **client** (desktop UI, phone, web app) reach a
**vault** (the personal server holding a user's documents) without either side
needing a public address, a static IP, or a forwarded port.

It is deliberately the dumbest component in the system. It never sees
plaintext, never indexes, never searches, never renders, never runs a model.
Every actual service runs on the vault.

## The relay is always in the path

Even when a homelabber runs the relay and the vault on the same box, clients
still speak to the vault *through* the relay. This is a design decision, not
an accident, and it buys four things:

1. **The vault never accepts inbound connections.** It dials out to the relay
   and keeps that channel open. No port forwarding, no DDNS, no inbound
   firewall rule, nothing exposed to the internet. This is the single biggest
   security and setup win available, and it is why the model works for
   non-experts.
2. **One client code path.** No "am I local or remote?" branching, no
   discovery fallback matrix, no separate LAN protocol. A client is configured
   with a relay URL and a vault identity; everything else is the same.
3. **One auth model**, applied in one place.
4. **Uniform testing** — the localhost deployment exercises the same protocol
   as the hosted one.

**Control plane always, data plane when necessary.** The relay always brokers
identity, discovery and session setup. Bulk data should travel *directly*
between client and vault whenever the two can reach each other (same LAN, or
after successful hole-punching), falling back to relayed ciphertext when they
cannot. Same split as Tailscale: coordination is centralised, traffic is not.

## Identity and addressing

Reuse the shipped owner→invite→member chain from `collab-design.md` rather
than inventing a second one.

- A vault has an **owner keypair** (ECDSA P-256). Its address commits to the
  public key: `v` + base64url(sha256(ownerPubRaw)). The relay can therefore
  verify trustlessly who may announce as that vault — exactly the trick the
  `w`-rooms already use.
- **Devices are members.** Each device mints its own keypair, never leaving
  the device, and is admitted by an owner-signed delegation. Pairing a new
  phone is the same operation as inviting a collaborator.
- **Revocation** is the existing owner-signed `rev.${pub}` path.

The relay verifies signatures to decide *who may connect to what*. It learns
public keys and connection metadata; it learns nothing about content.

## Wire protocol

### Capability handshake — first message, always

Vault and relay ship on **independent release trains**, and a self-hoster's
relay may be a year older than the client talking to it. There is no way to
enforce deploy order, so negotiation is mandatory from the first commit:

```
→ hello   { pv: 1, role: "vault"|"client", vault: "v<hash>", pub, sig }
← welcome { pv: 1, caps: ["rendezvous", "presence", "deaddrop"], limits: {...} }
```

- Clients **degrade, never fail**, on a missing capability. No `deaddrop`
  means "your phone reaches the vault when the vault is awake" — not an error.
- **Never remove or repurpose a field**; only add. Unknown fields are ignored,
  as everywhere else in Bento.
- The client surfaces the relay's version and capabilities in its UI, so a
  self-hoster can see *why* something is unavailable rather than filing a bug.

### Operations

| Message | From | Purpose |
|---|---|---|
| `announce` | vault | "I am online and reachable", with connection candidates |
| `resolve` | client | "Is vault V online? How do I reach it?" |
| `offer` / `answer` / `candidate` | both | Session negotiation, relayed verbatim |
| `presence` | both | Which of my devices are currently connected |
| `frame` | both | Opaque ciphertext, when a direct path could not be established |
| `drop.put` / `drop.get` | both | Encrypted dead-drop, if the capability is offered |

Everything carrying user content is ciphertext the relay cannot read. The
relay's entire job is routing envelopes and checking signatures.

### Data path

- **Direct** — preferred. Native clients (desktop agent, mobile) can hole-punch
  and speak directly to the vault. On a LAN this is trivially fast.
- **WebRTC data channels** — the only P2P option available to *browser*
  clients, since a web page cannot open arbitrary sockets. The relay acts as
  the signalling channel.
- **Relayed** — the fallback, and the only path when a symmetric NAT defeats
  hole-punching. Ciphertext only, and metered (see *Abuse*).

For v1 it is acceptable for web clients to always take the relayed path;
documents are small and the dead-drop absorbs bulk transfer.

## Wire efficiency

The shipped collab relay carries roughly **1.78× the bytes it needs to**, and
compresses nothing. Both are fixable, and the fixes belong in this design
rather than being retrofitted after a second product depends on the format.

### Where the overhead goes

Tracing an 8 MB binary asset through today's path:

| step | size | why |
|---|---|---|
| binary asset | 8.0 MB | |
| → data URI in `doc.assets` | 10.7 MB | **base64 #1** — the document is JSON inside a `<script>` block, so binary *must* be text |
| → JSON op batch | ~10.7 MB | negligible |
| → AES-GCM ciphertext | ~10.7 MB | +16-byte tag |
| → base64 for the `d` field | 14.2 MB | **base64 #2** |
| → `JSON.stringify({p:1,i,d})` | 14.2 MB | |

Two rounds of base64, each ×1.333, compounding to ×1.78.

**Base64 #1 is inherent to the document and correct** — a `.bento.html` is JSON
in a script tag. It is *not* inherent to the wire.

**Base64 #2 is pure waste.** It exists only because frames are JSON text
messages, and WebSocket has native binary frames.

### Three fixes, in priority order

**1. Compress before encrypting.** Nothing is compressed today: encrypting
first makes the payload incompressible, and `permessage-deflate` cannot help
either. Media is already compressed and won't benefit — but *ordinary editing
traffic* (typing, moving elements, style changes) is JSON that compresses
5–10×, and it is the overwhelming majority of frames in a live session. Both
primitives already exist in the codebase: `deflateRawSync` in the build
pipeline and `CompressionStream` in the browser (the shell loader already uses
`DecompressionStream`). No new dependency.

> **Documented caveat:** compress-then-encrypt leaks information through
> ciphertext length — the CRIME/BREACH class. Here the attacker must already be
> an authorised collaborator injecting chosen content and measuring frame
> sizes, which is a weak position, but this must be a recorded decision rather
> than an accident. Revisit if untrusted parties ever share a room.

**2. Binary frames.** Sending the ciphertext as an `ArrayBuffer` removes
base64 #2 — a flat **25% off every frame**, not just media. Requires: the IV
carried as a length-prefixed header (or the leading 12 bytes) instead of a
JSON field; the relay accepting non-string messages (it currently drops them
outright — `typeof data !== 'string'` → `return`) and storing `Uint8Array`
values; and signatures computed over bytes rather than `${i}.${d}`.

**3. Content-addressed blobs.** Assets leave the op log entirely: the op
carries a hash and a pointer, the encrypted blob is stored raw. This removes
base64 #1 *from the wire* and fixes three other things at once — dedupe (the
same image referenced twice is stored once), replay (a late joiner no longer
downloads every historical asset), and pruning (see below). Same primitive as
the dead-drop.

Net effect: **×1.78 → ×1.33 → ×1.00.**

### Assets are whole-value registers today

`crdt.ts` emits a single `set` op whose value is the entire data URI, so any
change re-sends the whole asset — and **every snapshot re-sends every asset**,
because `session.snapshot()` serialises the whole document. Content-addressing
is what fixes this; chunking would not.

### Chunking IS required — the binding constraint is storage, not the socket

An earlier draft of this section argued chunking was unnecessary because
Cloudflare raised the WebSocket message limit from 1 MiB to 32 MiB
(2025-10-31). **That was wrong**, and testing against the real worker under
standalone `workerd` is what caught it.

The WebSocket limit is not the binding constraint. **A Durable Object storage
value caps near 2 MB** — measured: 2 MB stores, 2.5 MB throws inside
`storage.put()`. Worse, `webSocketMessage`'s blanket `.catch(() => {})`
swallowed the throw, so frames between the old 1 MB cap and 32 MiB passed every
check and then silently disappeared. Raising `MAX_FRAME` alone doesn't widen
the pipe; it just moves where the payload is lost.

`MAX_FRAME` is therefore pinned at **1.9 MB**, chosen so that *accepted* and
*storable* mean the same thing. At the ~1.78× wire cost that carries roughly
**1.05 MB of binary** — photographs, not video.

So an 8 MB `MEDIA_EMBED_BUDGET` cannot travel as one op, and no constant will
change that. Two ways out, and they are not exclusive:

- **Content-addressed blobs (preferred).** The asset never enters the op log;
  the op carries a hash and the encrypted blob goes to a store with no 2 MB
  row limit (R2, or the dead-drop). Also fixes dedupe, replay and pruning.
- **Chunked ops.** Split an asset across ≤ 1.9 MB frames and reassemble.
  Needed if a payload must live in the op log at all, and needed *anyway* as
  resumable multipart upload once a single blob is large. The costs are real:
  reassembly state, and orphan collection for partial sets inside a relay that
  cannot read its own payloads — mitigated because the chunk count is
  plaintext envelope metadata, so the relay can GC incomplete sets on a TTL.

Sequence blobs first (it removes the need for chunking in the common case),
then chunk uploads for genuinely large single assets.

### Migration path

The wire format cannot change under shipped clients, and once self-hosters run
their own relays we cannot control deploy order at all. So:

1. Wire revisions are advertised through the **capability handshake**
   (`wire:1` text+base64, `wire:2` binary, `wire:3` binary+compressed).
   Clients negotiate down; a new client on an old relay simply sends `wire:1`.
2. **The relay accepts every past revision indefinitely.** Old frames are not
   deprecated, they are just not produced any more.
3. Compression is per-frame and self-describing, so a mixed room works: a
   `wire:3` client and a `wire:1` client can share a room, each sending what
   the other understands.
4. Ship the relay side of a revision **before** any client produces it.

## Current relay: known issues this design must fix

Recorded here because the recommendation is to grow `server/sync-worker/` into
this relay rather than start beside it.

- **`MAX_FRAME` was 1 MB and silent on overflow** — any asset over ~549 KB of
  binary produced an op dropped with a bare `return`. FIXED: frames are now
  refused with `{ ctl:'refused', code }`, and `MAX_FRAME` is 1.9 MB, pinned to
  the ~2 MB Durable Object storage ceiling rather than the 32 MiB socket
  limit (see *Chunking IS required*).
- **Silent drops become a retry loop.** The peer's version vector stays behind,
  the `need`/`vv` catch-up asks for the missing op, the sender re-sends the
  same oversized frame from its log, and the relay drops it again — forever.
  Bandwidth burned on an op that can never land.
- **Snapshots die the same way, and take pruning with them.** A snapshot
  carries the whole document, so a deck over ~750 KB exceeds the cap. Since the
  relay only prunes covered ops when a snapshot lands, **the op log then grows
  unbounded for the room's 30-day life** — the decks that cost the most storage
  are exactly the ones where pruning has silently stopped.
- **Raising `MAX_FRAME` alone would be a mistake**: it multiplies the
  worst-case abuse write by 32×. It must land together with a per-room storage
  cap and byte-based rate limiting.

## The dead-drop (optional capability)

A vault on a laptop is asleep most of the day. The dead-drop is an encrypted
blob store with a TTL that lets a phone fetch recent documents while the vault
is unreachable. It is a **cache, not a service**: the vault remains the
authority, and the relay still cannot read anything.

Self-hosters on always-on hardware do not need it, which is exactly why it is
a *capability* and not part of the core protocol.

## What the relay must never do

Search. Index. Store plaintext. Parse documents. Render. Run a model. Hold
authoritative state. Know a document's title.

The reason is structural, not ideological: if the hosted relay accretes
features, the self-hosted relay cannot match it, self-hosting silently becomes
second-class, and we lose the users this exists for. Keeping the relay tiny is
also the only thing that makes maintaining two implementations affordable.

## Two implementations

- **Hosted** — Cloudflare Worker + Durable Object (+ R2 for the dead-drop).
  Reference deployment; what `bento.page` runs, for people who will never run
  a server.
- **Portable** — a single Node or Go binary in a Docker image. One process,
  one config file, no cloud account. This is what a homelabber runs, very
  often on the same box as their vault.

Both implement this document. Any behaviour that cannot be expressed in both
does not belong in the relay.

> **Prerequisite, worth doing before writing either:** verify whether the
> existing `server/sync-worker/` actually runs under standalone `workerd`. It
> depends on Durable Object bindings, the WebSocket Hibernation API and
> SQLite-backed DO classes, and the r/selfhosted copy already claims it is
> self-hostable. That test tells us whether the portable twin is a nice-to-have
> or the only real self-host path.

## Abuse, quotas, and honesty

The hosted relay is a public service and will be abused. It needs, from day
one: per-vault and per-IP rate limits, a dead-drop size and TTL cap, relayed
bandwidth metering, and a documented policy for what happens when a limit is
hit (degrade, don't silently drop).

### Making room creation cost something

Room creation is unauthenticated by design — the token is trust-on-first-use,
and there are no accounts because "no signup" is a product property we are not
giving up. That means anyone can use the hosted relay as a free persistent
pub/sub backend. The caps above bound what *one room* costs; they do nothing
about *many rooms*.

Layers, cheapest first:

1. **Edge rate limiting** (Cloudflare WAF rule on the route, keyed by IP). No
   code, blocks volumetric abuse before it reaches a Durable Object. Blunt —
   NAT and IPv6 rotation defeat it — but it is free and stops the lazy case.
2. **Signed rooms only for new rooms.** Legacy `r`-rooms stay permissive;
   refuse to create new ones. An abuser must then generate a keypair, which is
   cheap — but the *point* is that it yields a stable pubkey to meter, ban and
   revoke against. Identity is more useful here than the crypto cost.
3. **Proof of work at room CREATION.** A Hashcash-style stamp: find a nonce
   such that `sha256(roomName || nonce)` has N leading zero bits. Bound to the
   room name so work is not reusable. Verification is a single hash — the
   asymmetry is the whole point.

**Why proof of work fits here specifically.** It buys a cost curve without
accounts, which is the one thing a CAPTCHA or a login would take away. And it
is aimed correctly: creating *a* room should be free-ish, creating a hundred
thousand should not. A normal user creates a room rarely — the cost is
invisible. Attach it to every connection instead and you have merely taxed
legitimate users and drained phone batteries.

**Adaptive difficulty is the real lever.** Advertise the current difficulty in
the capability handshake (`pow: { bits: 16 }`) and raise it under load. Normal
operation ~16 bits is imperceptible; under attack 24+ bits costs an abuser
seconds per room while a genuine user notices once.

**Honest limits.** PoW does not stop a determined, funded abuser — it prices
out bulk, not intent. It is also regressive on mobile (a phone burns battery
where a botnet does not care), which is another argument for creation-only.
And it must be a **capability, not a requirement**: a self-hosted relay serving
one household should advertise `pow: null` and skip it entirely. Rejected for
this role: Turnstile (Cloudflare-only, so it breaks the self-hosted story, and
needs a browser origin that `file://` documents do not have) and accounts (the
product does not have them and should not need them).

**Metadata leakage, stated plainly** — the hosted relay operator can see
public keys, IP addresses, connection times, blob sizes and traffic timing. It
cannot see documents, titles, or the index. This should be written in the
user-facing docs, not buried here; "we can't read your files" is true and
"we see nothing" is not.

## Relationship to the collab relay

`server/sync-worker/` already does a narrow version of this: blind ciphertext
routing between peers, with key-committed room ids and signature-verified
writes. Vault rendezvous is the same shape with a bigger job.

**Recommendation: one relay, two capabilities** — collab rooms and vault
rendezvous served by the same process, advertised through the same capability
handshake. A self-hoster then runs one box, not two, and the identity chain is
shared rather than duplicated. This argues for growing `sync-worker` into the
relay rather than starting a second service beside it.

## Sequencing

0. **Fix the shipped relay first** (see *Current relay: known issues*): raise
   `MAX_FRAME` together with a per-room storage cap and byte-based rate
   limits, and make oversize rejection loud instead of silent. This is a live
   correctness bug plus an unbounded cost exposure, and it is independent of
   everything below.
1. **Capability handshake + identity verification.** Nothing else works
   without it, and retrofitting negotiation is the expensive mistake.
2. **Announce / resolve / relayed frames.** Correct but slow: everything
   proxied. Enough to make a desktop agent reachable from a phone.
3. **Direct path** (hole-punching, then WebRTC for browsers) as an
   optimisation over a protocol that already works.
4. **Dead-drop**, for the laptop-only profile.
5. **Portable implementation** — no later than step 3, because the second
   implementation is what keeps the first honest.
