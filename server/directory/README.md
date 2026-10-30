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
| `GET /v1/lookup?e=` | none | 200 (statement + fresh attestation + chain), 410 (signed tombstone) or 404 (never existed *or* expired: the same answer). Exact address only |
| `POST /v1/delete` `{email, ts, sig}` | the key's signature over `del.…`, ±5 min | 204, leaving a signed `tomb.…` |
| `POST /v1/delete/start`, `/complete` | a mailed code, for an EXPIRED binding only | 202, then 204 |

**Email never changes a LIVE binding on its own** (security §25). While a
binding is live, a new key proven by email alone is refused (start mails
nothing), and so is a mailed-code delete. A live binding changes only by its
holder: a renewal, or a holder-signed delete. The 72-hour contestable
rotation, which is how a person who has lost every device moves on, arrives
with the rotation states. Email alone may bind an address that is absent,
expired or deleted; a new key over an expired one is flagged `rebound`, so
pinners warn.

**Until the rotation states land, a live binding's key cannot change at
all**, and a person who has lost every device cannot remove a live binding:
it stays until it expires (13 months at most). That includes the web
deletion page (bento.page/id/delete), which removes EXPIRED bindings only for
now. For a live one it answers as usual and mails nothing. Accepted for phase
1 by security; the 72-hour contestable path lifts it.
| `GET /v1/keys` | none | the directory's public keys, for diagnosis (clients trust the list in the signed release) |

**Limits:**
- a code lives 20 minutes and allows 5 attempts
- per address: one mail a minute, 3 a day, 10 a month (the mail-bombing control)
- per IP and hour: start 20, complete 60, lookup 300, delete 20

## Status

The statement formats (`bind.`, `cmp.`, `del.`, `att.`, `tomb.`) and the
address normal form are the KERNEL's (`kernel/src/statements.ts`,
`kernel/src/address.ts`), so the directory and every agent verify with one
implementation. `src/statements.js` and `src/address.js` only add what is the
directory's own: its online signing key and the storage name. The rig runs
kernel's conformance vectors (`kernel/fixtures/identity-v1.json`) end to end
through the Worker, and checks every answer with kernel's client verifiers.

The `kx` slot in `bind.` stays EMPTY, and a filled one is refused, until the
maintainer rules where the key-agreement key lives (kernel's `KX_MODE`).

Phase 1 accepts **ASCII addresses only** (recommended, pending the
maintainer's decision on international addresses): the platforms disagree on
internationalised domains, so one address could otherwise bind as one mailbox
and be looked up as another.

**Not here yet:**
- the chained key rotation with its pending and frozen states
- the passkey key-blob store and the access-ledger blob
- the SES mailer

## Deploying is the maintainer's

It needs the `id.bento.page` DNS, an Amazon SES account in an EU region, and
SPF/DKIM/DMARC on a dedicated sending subdomain, all first. Then:

```sh
cd server/directory
npx wrangler secret put DIR_KEY_JWK   # the directory's ONLINE signing key; never the release key
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
