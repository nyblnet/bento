# Asset blob offload — design

*Design document, July 2026. Status: **proposed** — nothing built. Companion
to `relay-design.md` ("Wire efficiency") and `collab-design.md`. The immediate
motivation is a live bug: media cannot be added during a collaboration session
at all.*

## The problem

`crdt.ts` syncs an asset as a **whole-value LWW register** — one `set` op whose
value is the entire base64 data URI. That runs into a hard ceiling:

- An asset costs **~1.78× its binary size** on the wire (base64 twice — once
  into the data URI, once over the ciphertext).
- A Durable Object storage value caps near **2 MB** (measured, not documented:
  2 MB stores, 2.5 MB throws inside `storage.put()`).
- So the practical ceiling is **~1.05 MB of binary**, against a
  `MEDIA_EMBED_BUDGET` of 8 MB.

Raising the frame limit does not help — the Cloudflare WebSocket limit is now
32 MiB, but *storage* is the binding constraint. No constant fixes this.

Two further consequences, both fixed by this design:

- **Snapshots carry every asset** (`session.snapshot()` serialises the whole
  document), so a media-heavy deck can never snapshot — and since the relay
  only prunes covered ops when a snapshot lands, its op log grows unbounded
  for the room's whole 30-day life.
- **No dedupe.** The same image referenced twice is stored twice; re-adding it
  writes it again.

## The constraint that shapes everything

**The file must stay self-contained.** A `.bento.html` carries its assets as
data URIs in `doc.assets` — that is the product. So this is a **transport
change, not a format change**. `doc.assets` keeps holding data URIs; only the
way an asset *travels between peers* changes. A receiving peer fetches the
blob, decrypts, and materialises it back into `doc.assets` exactly as if it
had arrived inline.

Get this wrong and the single-file invariant breaks (`PLATFORM.md` §1).

## Model

**The op stops carrying bytes.** Above a threshold (~64 KB — below that,
inlining is cheaper than the round trip) the differ emits a reference instead
of the value:

```
set assets.<k> = { __blob: "<storage key>", hash, size, mime }
```

A couple of hundred bytes instead of megabytes.

**Content-addressed, with a privacy wrinkle.** The natural id is
`sha256(plaintext)`, which gives dedupe for free — but if the relay sees that
id, it can tell two different rooms hold the same image. Use
**`HMAC(roomKey, sha256(plaintext))`** as the storage key instead:
deterministic *within* a room so dedupe works, opaque *across* rooms so
nothing correlates. Cheap now, awkward to retrofit.

**Blobs move over HTTP, not the WebSocket.** `PUT /b/<room>/<key>` and
`GET /b/<room>/<key>`, backed by R2. This sidesteps the 2 MB storage-value
limit entirely, gives resumable multipart upload for free, and R2 charges no
egress. It is also exactly the vault dead-drop primitive — build it once.

**Upload before you emit.** An op must never reference a blob that is not yet
fetchable. Belt and braces: a peer that receives a reference to an unknown
blob fetches on demand and renders a placeholder meanwhile, which also covers
replay and late joiners.

**Encryption** uses the existing room key, same as frames. The relay stores
ciphertext and can no more read a blob than a frame.

## The risky seam

This makes an op's meaning depend on an **external fetch**: applying an op
becomes async and failable, which breaks the CRDT's "ops are pure data"
property.

Mitigations:

- There is precedent in the engine — the `pending` buffer already defers ops
  whose target node is unknown, so *deferred until resolvable* is an existing
  shape rather than a new concept.
- Keep `crdt.ts` changes minimal: the differ and apply path should treat
  `{ __blob }` as an **opaque value**, with a separate resolution layer above
  them doing the fetching and substitution. The CRDT should not know what a
  blob is.
- Extend `scripts/test-sync.ts` to cover blob-reference ops before merging
  anything. (Note it currently only generates short strings — which is why it
  missed the large-text stack overflow fixed in #47. Assume it will miss this
  class too unless extended.)

## Failure modes, stated plainly

- **Blob upload fails, op already sent** — prevented by upload-before-emit,
  but a crash between the two is possible. The receiver renders a placeholder
  and the asset stays missing until the sender re-uploads on next connect.
- **Blob expired, peer never fetched it** — a peer holds an element
  referencing an asset nobody can produce. This is permanent divergence and it
  needs a deliberate answer: render a placeholder with an honest "asset
  unavailable" state, never a silent broken image. TTL should match the room's
  30-day expiry, which is long enough that any peer who opened the document
  and saved has the bytes in their own file.
- **Storage quota reached** — refuse loudly with a code, exactly as frames now
  do. Never drop silently; that class of bug cost us a permanent resend loop.

## Sequence

1. **Relay blob endpoints + R2.** `PUT`/`GET`, per-room namespace, TTL matched
   to room expiry, size and quota caps from the start. Independently testable
   with no client changes.
2. **Client blob layer.** Content hashing, HMAC key derivation, an
   IndexedDB-backed cache, fetch-on-demand with placeholder rendering.
3. **Wire it into the differ** above the threshold; extend the convergence rig
   in the same PR.
4. **Chunked/resumable upload** for genuinely large single blobs.

Steps 1 and 2 touch neither `crdt.ts` nor the document format, so they can
proceed while other sync work lands.

## Verify before building — do not trust these assumptions

Today's session produced three confident conclusions that measurement
overturned (the 1 MB frame limit, "chunking is unnecessary", and the RGA
stack overflow). Treat the following the same way:

- **Can a Worker stream a multi-MB blob to/from R2 without buffering it in
  memory?** The 128 MB Worker memory limit is exactly the kind of constraint
  that is not in the docs you would reason from.
- **What is R2's actual behaviour under the free/paid plan** for many small
  objects, and what do per-operation costs look like at realistic churn?
- **Does `crypto.subtle` streaming decryption work** for a blob larger than
  memory, or must it be chunked for that reason alone (independent of upload
  resumability)?

Answer these with a probe against a real deployment before the design hardens.
