# bento/id directory (`id.bento.page`)

Layer 1 of bento/id. It answers one question: *does this key belong to this
mailbox?* It holds **holder-published bindings**: an account key, a separate
key-agreement key, and an email address. Each binding is made with **two
proofs**:

1. a signature by the account key over the binding statement, and
2. a code mailed to the address, entered in the holder's own agent (bento/home)
   and **signed by that same key**.

Why a code and not a link: an attacker can start a binding of their own key to
someone else's address. If clicking a mailed link completed it, the victim's
click, or their mail provider's link scanner, would bind the attacker's key.
With the code entered and signed in the holder's agent, neither half works
alone.

## What it never holds

No private key, no document, no access list, no share, no "who looked up
whom". Storage is one Durable Object per address, **named by a hash of the
address**, and nothing lists or iterates them. The address exists once,
inside the signed statement the directory serves; no other copy is kept.
Per-IP limits key on a daily-salted HMAC, so no raw IP is stored and one
day's hashes can't be linked to the next.

## Routes

| route | proof | answer |
|---|---|---|
| `POST /v1/bind/start` `{stmt, sig}` | the holder's signature over `bind.…` | **always 202** once the statement is valid, whether or not a code was mailed (no existence or limit oracle) |
| `POST /v1/bind/complete` `{email, code, sig}` | the code + the key's signature over `cmp.…` | 200 with the statement and a signed `att.…`, or a uniform 400 |
| `POST /v1/bind/check` `{stmt, sig}` | any valid signature over the exact bound `bind.…` | the bind answer again, with the state in a fresh `att.…` (or `{state: "pending"}` over a holder tomb), else 404. For a host whose check of the bind answer failed: setup resumes without a second mail. Reveals nothing a lookup doesn't |
| `GET /v1/lookup?e=` | none | 200 (statement + fresh attestation + `state` + chain; after a rotation the previous key's `rot`/`rotSig` vouch, and up to 8 earlier `steps`), 410 (signed tombstone) or 404 (never existed *or* expired: the same answer). Exact address only |
| `POST /v1/delete` `{email, ts, sig}` | the key's signature over `del.…`, ±5 min | 204, leaving a signed `tomb.…`. Refused while frozen |
| `POST /v1/delete/start`, `/complete` | a mailed code, for an EXPIRED binding only | 202, then 204 |
| `POST /v1/challenge` `{email}` | none | a single-use consent challenge, audience `dir`, good for 60 seconds at that address only |
| `POST /v1/rotate/start` | see **Rotation** | 202 (a code is mailed), or 400 with a reason |
| `POST /v1/rotate/complete` `{email, code, sig}` | the code + the NEW key's signature over `cmp.…` | 200 `{state: "pending", activeAt}` |
| `POST /v1/contest` `{email, challenge, req, sig, bind?}` | a `dreq.contest` by the key the directory serves (the OLD one), only while pending, or while an email-only freeze's resolution waits; `bind` is the deleted binding's text in the holder-delete window | 200 `{state: "frozen"}` |
| `POST /v1/freeze` `{email, challenge, req, sig}` | a `dreq.freeze` by the served key, active or pending, or while an email-only freeze's resolution waits | 200 `{state: "frozen"}` |
| `POST /v1/resolve` `{stmt, sig, verifier}` | a NEW binding signed by its own key, chained to the frozen one, and the recovery verifier | a key-holder freeze: 200 (binding + attestation, `rebound: true`). An email-only freeze: 202 `{state: "frozen", resolving: true, activeAt}`, see **Resolution** |
| `POST /v1/freeze/start` `{email}` | none | **always 202**; mails a freeze link only for a live, unfrozen binding |
| `GET /freeze` | none | the confirmation page the freeze link opens. A GET changes nothing |
| `POST /v1/freeze/complete` `{email, token}` | the single-use token from the mail | 200 `{state: "frozen"}`, or a uniform 400 |
| `GET /v1/keys` | none | the directory's public keys, for diagnosis (clients trust the list in the signed release) |
| `POST /v1/link/open`, `/put`, `/get`, `/abort` `{id, tok, …}` | `tok`, derived from the link code | a short-lived mailbox; see **Device linking**. Off unless `LINKING=1` |
| `POST /v1/link/complete` `{id, tok, email, challenge, msg3}` | H's message 3 (kernel's `lnk3` text: H's `dev.`, its consent over N's `dev.`, N's `dev.`, the sealed key), on a `dir` challenge | 200, or 400 with kernel's reason; the slot is deleted on any failure |
| `POST /v1/status` `{email, req, sig, challenge}` | `dreq.status` | 200 `{state, events}`, plus `pending` while a key change waits and `contested: true` on a contested freeze. Off unless `KEYSTORE=1`, like everything below |
| `POST /v1/cred/add`, `/v1/cred/del` | `dreq.cred-add` / `dreq.cred-del` + consent (the first passkey: the setup allowance instead) | 200; see **Key store** |
| `POST /v1/cred/challenge`, `/v1/cred/get` | a WebAuthn assertion on a single-use challenge | 200 with the passkey's PRF blob |
| `POST /v1/recovery/enrol` | `dreq.rc-enrol` + consent (the first code: the setup allowance instead) | 200 |
| `POST /v1/recovery/salt`, `/start`, `/release` | the recovery verifier | the salt; a ticket and `releaseAt`; after 72 hours, the code-wrapped blob |
| `POST /v1/ledger/get`, `/put` | (needs a kernel request op) | 501 for now |

**Email never changes a LIVE binding on its own** (security §25). While a
binding is live, a new key proven by email alone is refused (start mails
nothing), and so is a mailed-code delete. Email alone may bind an address
that is absent, expired or deleted; a new key over an expired one is flagged
`rebound`, so pinners warn. What email alone CAN do to a live binding is
freeze it, which only removes power.

## Binding states

A live binding is `active`, `pending` or `frozen`. The state is inside the
signed `att.`, so a frozen answer can't be replayed as active.

- **active → pending (rotation).** The holder asks for a new key. The new
  `bind.` (seq + 1, `prev` = the live binding's hash) is signed by the NEW
  key, the OLD key signs the exact same bytes, and the request carries
  consent for it (below). A code is mailed, and the new key signs it. For 72
  hours lookups keep serving the OLD binding, as `pending`, so pins don't
  move. Then, uncontested, the new binding becomes active, and lookups carry
  `rotSig` (the old key's signature over it), so pinners follow without a
  warning.
- **→ frozen.** The rotation mail and the freeze mail carry a link to a
  confirmation page. Only a deliberate POST with its single-use token freezes
  (mail scanners pre-fetch links). A freeze ends any rotation in flight.
  While frozen, neither key is honoured: no renewal, no rotation and no
  holder delete (a delete would reopen the address to an email-only re-bind).
- **Leaving frozen** takes the recovery code (see **Resolution**); without
  one, a frozen binding stays frozen until it expires.

**Consent** for a rotation is bound to a challenge from `/v1/challenge`. The
challenge is sealed to its address, spent before anything else is checked, and
good once. Two forms are accepted:
- a `cns.` (purpose `rotate`, audience `dir`) signed by a hardware consent key
  certified in a `dev.` that the LIVE account key signed;
- for hosts without a consent key, a WebAuthn assertion whose
  `clientDataJSON.challenge` is the hash of the exact `cns.` the directory
  rebuilds from its own audience, challenge and payload. The assertion is
  checked against a credential stored for that address: RP id hash, user
  presence and verification, signature, sign count, and an exact origin
  allow-list (`src/webauthn.js`). Origins the platform does not vouch for (the
  desktop apps') are never accepted as consent. Five failures in a row lock
  the credential for 15 minutes.

**The vouch** is kernel's `rot.<sha256(new bind.)>.<sha256(live bind.)>`, signed
by the OLD key and checked with kernel's `verifyRotation`, exactly as a pinning
client checks it; the lookup serves it with the binding.

**Contest and freeze by the old key** are kernel's `dreq.` (challenge-bound,
spent first), signed by the key the directory serves: during `pending` that is
the OLD key, and a pending key signs nothing. `contest` names the pending
binding and is accepted only while pending; `freeze` is accepted active or
pending; while frozen only `status` is, with one exception below. Neither
needs consent (they only remove power). The signed status read returns the
pending binding and its vouch, which is what a device needs to show and
contest it.

**When a contest fails, the client must say so plainly and offer the email
freeze** (security ruling a). A contest can fail for reasons the holder can't
fix from that device (the window closed, the challenge expired, the request was
refused): the screen says the key change was NOT stopped, in those words, and
offers the freeze link by email (`/v1/freeze/start`), which needs no key.

**Resolution.** Only the recovery code unfreezes: the device sends a new
binding, signed by its own new key and chained to the frozen one, and the
recovery verifier (the same checks, count and lock as a recovery start: every
resolve counts against the 5-per-24-hour limit, failures lock, and each attempt
notifies). **The code is spent only when a resolution COMMITS**, at once or when
a waiting one settles; a resolution that waits leaves it live, so one that is
voided does not burn it. No old-key signature exists in this case, so pinners
WARN; that is intended, and nothing the directory says softens it.

- A **key-holder freeze** (the owner's signed freeze, or a contest) resolves at
  once, unless it is contested (below).
- An **email-only freeze** resolves after 72 hours (security ruling b): the
  recovery code and the mailbox together were an instant takeover. The answer
  is 202; the address stays frozen, a notice is mailed (`resolve-pending`), and
  lookups and the signed status read name the waiting binding (`pending`,
  `activeAt`). During those 72 hours, and only then, a `dreq.freeze` or
  `dreq.contest` (naming the waiting binding) signed by the FROZEN binding's
  key is accepted: the narrow exception to "frozen: status only" (rc-enrol,
  cred-add and cred-del stay refused). It turns the freeze into a key-holder
  freeze and voids the waiting resolution; the code stays live. Uncontested,
  the new binding becomes active at 72 hours (`rebound`, no vouch), the code is
  spent, and the event list records it. A second resolution while one waits is
  refused (`resolving`).
- A freeze that has had a resolution voided is **contested**: the code has been
  in two hands. Every later resolution of it waits 72 hours the same way and
  can be voided the same way, by the frozen key, and a contested freeze never
  resolves at once, even though the frozen key froze it. This is the
  owner-wins sequence: an owner holding the device and the code, against a
  thief holding the code and the mailbox, voids the thief's resolution,
  resolves, waits 72 hours, and wins, because the thief holds no key that can
  void it. The reverse (the thief holds the old key) is a stalemate: the
  address stays frozen while that key keeps voiding, until the binding expires.
  The signed status read says `contested: true` (so the key holder learns its
  resolution was voided and the next one will wait); the public lookup never
  shows it.

**Host conditions while frozen** (a host that does not meet them must not offer
resolution):

- On every open, a device holding the frozen key polls the signed status read.
  When it names a waiting resolution (`pending.resolve: true`), the device shows
  it prominently, with its `activeAt`, and with the ONE action that stops it:
  freeze (or contest). Nothing else on that screen competes with it.
- A device whose own resolution was voided (a 202 that later reads back frozen,
  with no `pending`) says so honestly, in these words: "A device holding your
  old key is blocking the move. Your address stays frozen while it does." It
  does not suggest that retrying will help, and does not present the freeze as
  something it can undo.

**A holder delete keeps the binding's protection** until the deleted binding's
own expiry: a DIFFERENT key re-binding the address goes `pending` for the full
72 hours, lookups keep answering the tomb (with the state and the pending
hash), and the tombstoned key may contest, bringing the deleted binding's text
(only its hash is kept). Its recovery verifier is kept for that window and
deleted when it closes, or at the deleted binding's expiry at the latest. The
same key re-binds at once; after the expiry, email alone works again and the
lookup says `rebound`. A delete is refused while pending or frozen.

**Rotation is OFF unless `ROTATION=1`**, until security has run the contest.

**Limits:**
- a code lives 20 minutes and allows 5 attempts; a freeze link lives 24 hours
- per address: one mail a minute, 3 a day, 10 a month (the mail-bombing control)
- per IP and hour: start 20, complete 60, lookup 300, delete 20, challenge 120, rotate 20

## Status

The statement formats (`bind.`, `cmp.`, `del.`, `att.`, `tomb.`, `dev.`,
`cns.`) and the address normal form are the KERNEL's
(`kernel/src/statements.ts`, `kernel/src/address.ts`), so the directory and
every agent verify with one implementation. `src/statements.js` and
`src/address.js` only add what is the directory's own: its online signing key
and the storage name. The rig runs kernel's conformance vectors
(`kernel/fixtures/identity-v1.json`) end to end through the Worker, and checks
every answer with kernel's client verifiers.

Every `bind.` must carry the account's recovery key-agreement key in its `kx`
slot (kx placement mode C, kernel's `KX_MODE`): an empty slot, a value that is
not an uncompressed P-256 point, and one equal to the account key are refused.

Phase 1 accepts **ASCII addresses only** (recommended, pending the
maintainer's decision on international addresses): the platforms disagree on
internationalised domains, so one address could otherwise bind as one mailbox
and be looked up as another.

## Device linking

One of a person's devices (H) hands the account key to a new one (N) through a
**slot**: a mailbox in its own Durable Object class (`Link`), so a bug in it
can't read an address or a credential. The slot id and `tok` are derived on the
devices from a link code the directory never sees. The sealed key is ciphertext;
message 3's certificates and consent are clear, as the directory must verify
them. They are held for at most 10 minutes, then burned.

- A slot lives 10 minutes; messages are at most 4096 bytes once decoded, and an
  oversized message 3 is refused before the slot is claimed or the challenge
  spent. Message 0 (the displayer's) comes with `open`, 1 and 2 by `put`, 3 only
  through `complete`.
- **Each message is written once.** A second write of the same number (or a
  second `open` of the same id) means another device has the code: the slot
  becomes CONTENDED, drops its messages, and both sides are told to start again.
- **A slot completes once.** `complete` claims the slot first; then the address
  spends the `dir` challenge (every attempt, a malformed one too) and runs
  kernel's `verifyLinkRelease` over H's whole message 3, one text, against the
  LIVE binding: H's `dev.` certified by that account key and carrying a consent
  key, H's consent (purpose `link`, audience `dir`, over N's `dev.` text), N's
  `dev.` naming the same account and a device other than H's, and the binding
  `active`. There is no second verifier here. Any failure, or a second attempt,
  deletes the slot. The slot stores kernel's `linkTokHash(tok)`, never `tok`.
- N receives message 3 whole and checks it with kernel's `openFinal`.
- The light tier's WebAuthn link consent is OFF: message 3 has no form for it,
  and an H without a consent key is refused (`h-no-consent`).
- N reads message 3 only while the binding is still active under the same key:
  a freeze after H's consent stops the key here.
- Every link is notified (mail + the event list).

It ships OFF (`LINKING` unset answers 404): N can only check what it receives
against a pinned directory key, and the hosts do not speak link v1 yet.

## Key store

Off unless `KEYSTORE=1` and a `PEPPER_V<n>` secret are set. One `Account`
object per address (it survives a key rotation; every record in it names the
account key it belongs to, and material for any other key is treated as gone).

- **Account-signed requests** are kernel's `dreq.`: challenge-bound, spent
  first, verified against the binding served as authoritative. `cred-add`,
  `cred-del` and `rc-enrol` also need consent for their own op.
- **The first credential.** A bind that lands `active` with both proofs arms a
  15-minute setup allowance, but only for an account key that has NEVER had a
  passkey or a recovery code (a stored flag per key, not a count, and nothing
  clears it). Inside it, one `cred-add` and one `rc-enrol` may come with no
  consent, on the account key's `dreq.` alone. It only fills an empty slot,
  it stands in only for ABSENT consent (a bad consent is refused, never rescued),
  and any freeze, contest, rotation or new bind ends it. Both ops still notify,
  and the event says `setup: true`. Running out of time means verifying the
  email again, which re-arms it while the key still has nothing.
  **For the UI:** the allowance is used when the request is authorized, so a
  registration that then fails (a bad attestation, a bad blob) uses it up. Say
  so plainly: the person asks for a new email code, which re-arms it, since a
  failed registration leaves the key with nothing.
- **A rebound** (a new key with no vouch: over an expired or deleted binding, or
  a resolved freeze) takes the old key's passkeys and recovery record with it,
  and gets no grace.
- **A passkey consents for its own key.** The `Cred` compares its account key
  with the key consent is being given for, so consent never rests on a deletion
  having succeeded.
- **The rotation grace.** After a settled VOUCHED rotation, a passkey of the
  immediately previous key may still consent to `cred-add` and `rc-enrol`, and
  to nothing else: never a rotation, a `cred-del` or a native consent. The grace
  ends at the new key's first credential, however it was added, or 30 days after
  the settle, whichever is first; any freeze ends it too. The old passkeys are
  then deleted with a notice (`cred-old-del`), and a key's code slot is left as
  it was. An account that misses it gets back in with a fresh email proof, which
  re-arms the setup allowance, as long as the new key has had nothing.
  **For the UI:** add the passkey first. A code enrolled in the grace counts as
  having had something, so if the passkey then never comes, email can't re-arm
  it and the way back is that recovery code.
- **A rekey that fails is recorded** (`rekey` in the Address object) before it is
  tried, and retried by the next signed request and hourly by the alarm. While
  one is unfinished, `cred-add`, `cred-del` and `rc-enrol` answer `rekey` with
  nothing used up: try again. Old passkeys left behind would otherwise fill the
  new key's empty slot.
- **Passkeys.** A registration is ES256 with attestation `none`, UP + UV +
  attested data, and its ceremony challenge is the `dir` challenge the request
  spent; the `dreq.` covers its exact bytes. The PRF blob is stored in the
  credential's `Cred` with BE, the attachment label and the account key. At
  most 10 per account. A fetch is one assertion on a single-use challenge that
  names no address; it is refused while frozen, and once the binding's key has
  changed (`stale`: it opens to a superseded key, grace or no grace). Every fetch
  notifies.
- **The recovery code.** The device sends a verifier (Argon2id of the code,
  its own salt) and the code-wrapped blob. The directory keeps the verifier
  only as an HMAC under a per-account pepper key, and the blob sealed under a
  second one (kernel's derivations); the pepper is a Worker secret. A right
  verifier starts a 72-hour wait and returns a ticket; after it, the ticket and
  the verifier release the blob once, and the code is spent. Five checks per
  address per 24 hours; five failures lock recovery for 24 hours; every counted
  attempt notifies, and the notice says to set a new recovery code, which
  cancels a release (a freeze does not, and blocks the new code). An address
  with nothing enrolled gets a stable fake salt.
- **Notices.** The event list records every event. Notice MAIL is capped per
  address: one per kind per hour. Recovery attempts and releases need no
  signature, so they are kept apart: one entry per kind with a count (they can
  never push a signed event out of the list), their own ceiling of four mails
  a day (they can never spend the signed kinds' mail), and a refusal past the
  day's count or while locked is counted, never mailed.
  Pepper versions upgrade on a successful check; a record under a version the
  Worker doesn't hold is refused, never tried under another.
- **The access ledger.** Stored only at bucket sizes (12.5% steps from 4 KiB,
  1 MiB at most) and only for the current key. Its routes answer 501 until
  kernel's request statement has a ledger op.
- **Deletion** takes the passkeys and the ledger with it. A holder deletion
  keeps the recovery verifier, for the deleted binding's own window; a mailbox
  deletion (expired bindings) removes it too.

**Not here yet:**
- the ledger routes (a kernel request op)
- WebAuthn (light-tier) consent for a link: refused until kernel has the
  msg3 WebAuthn variant with vectors
- refusing refreshed synced (BE=1) blobs after a lost-or-stolen removal. This
  is a HARD prerequisite: no deploy may set `ROTATION=1`, or ship freeze
  resolution together with `KEYSTORE=1`, before it exists

**`KEYSTORE=1` prerequisites**, both required: (1) the BE=1 refresh refusal
above (not built); (2) the 72-hour wait on resolving an email-only freeze
(built, see **Resolution**; it must never be removed or flagged off while the
key store is on).
- the SES mailer

## Deploying is the maintainer's

It needs the `id.bento.page` DNS, an Amazon SES account in an EU region, and
SPF/DKIM/DMARC on a dedicated sending subdomain, all first. Then:

```sh
cd server/directory
npx wrangler secret put DIR_KEY_JWK     # the directory's ONLINE signing key; never the release key
npx wrangler secret put CHALLENGE_KEY   # 32+ random characters; seals consent challenges
npx wrangler secret put PEPPER_V1       # 32 random bytes, base64url; only when the key store is turned on
npx wrangler deploy
```

## Testing

```sh
node scripts/test-directory.ts
node scripts/test-directory-keys.ts   # device linking and the key store
```

It drives the real worker and Durable Object classes against an in-memory
namespace and a hand-moved clock: both proofs, the attack a link would allow,
exact lookups, the 202 rule, per-address and per-IP limits, sequence and
rebound, signed tombstones, expiry, and nothing identifying at rest.
