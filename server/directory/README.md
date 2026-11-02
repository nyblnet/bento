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
| `GET /v1/lookup?e=` | none | 200 (statement + fresh attestation + `state` + chain, and `rotSig` after a rotation), 410 (signed tombstone) or 404 (never existed *or* expired: the same answer). Exact address only |
| `POST /v1/delete` `{email, ts, sig}` | the key's signature over `del.…`, ±5 min | 204, leaving a signed `tomb.…`. Refused while frozen |
| `POST /v1/delete/start`, `/complete` | a mailed code, for an EXPIRED binding only | 202, then 204 |
| `POST /v1/challenge` `{email}` | none | a single-use consent challenge, audience `dir`, good for 60 seconds at that address only |
| `POST /v1/rotate/start` | see **Rotation** | 202 (a code is mailed), or 400 with a reason |
| `POST /v1/rotate/complete` `{email, code, sig}` | the code + the NEW key's signature over `cmp.…` | 200 `{state: "pending", activeAt}` |
| `POST /v1/freeze/start` `{email}` | none | **always 202**; mails a freeze link only for a live, unfrozen binding |
| `GET /freeze` | none | the confirmation page the freeze link opens. A GET changes nothing |
| `POST /v1/freeze/complete` `{email, token}` | the single-use token from the mail | 200 `{state: "frozen"}`, or a uniform 400 |
| `GET /v1/keys` | none | the directory's public keys, for diagnosis (clients trust the list in the signed release) |

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
- **Leaving frozen** takes the recovery code. That arrives with the recovery
  verifier, so for now a frozen binding stays frozen until it expires.

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

**Rotation is OFF unless `ROTATION=1`.** A pending window is safe only when a
device still holding the old key can contest it, and that request needs a
statement that kernel has not defined yet. The emailed freeze link is the only
contest until then.

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

The `kx` slot in `bind.` stays EMPTY, and a filled one is refused, until the
maintainer rules where the key-agreement key lives (kernel's `KX_MODE`).

Phase 1 accepts **ASCII addresses only** (recommended, pending the
maintainer's decision on international addresses): the platforms disagree on
internationalised domains, so one address could otherwise bind as one mailbox
and be looked up as another.

**Not here yet:**
- contest and lost-or-stolen freeze by the old key, the signed status read,
  and credential registration and removal: each needs a kernel statement
- resolving a freeze with the recovery code (the recovery verifier)
- the passkey key-blob store and the access-ledger blob
- the SES mailer

## Deploying is the maintainer's

It needs the `id.bento.page` DNS, an Amazon SES account in an EU region, and
SPF/DKIM/DMARC on a dedicated sending subdomain, all first. Then:

```sh
cd server/directory
npx wrangler secret put DIR_KEY_JWK     # the directory's ONLINE signing key; never the release key
npx wrangler secret put CHALLENGE_KEY   # 32+ random characters; seals consent challenges
npx wrangler deploy
```

## Testing

```sh
node scripts/test-directory.ts
```

It drives the real worker and Durable Object classes against an in-memory
namespace and a hand-moved clock: both proofs, the attack a link would allow,
exact lookups, the 202 rule, per-address and per-IP limits, sequence and
rebound, signed tombstones, expiry, and nothing identifying at rest.
