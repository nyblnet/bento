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
  The budget is spent only by a mail that is actually sent: a refused start
  (anyone can send one, for any key) costs nothing, so strangers cannot use up
  the holder's mail and keep their next code from arriving.
- per IP and hour: start 20, complete 60, lookup 300, delete 20

## Status

The statement formats (`bind.`, `cmp.`, `del.`, `att.`, `tomb.`) and the
address normal form are the KERNEL's (`kernel/src/statements.ts`,
`kernel/src/address.ts`), so the directory and every agent verify with one
implementation. `src/statements.js` and `src/address.js` only add what is the
directory's own: its online signing key and the storage name. The rig runs
kernel's conformance vectors (`kernel/fixtures/identity-v1.json`) end to end
through the Worker, and checks every answer with kernel's client verifiers.

Every `bind.` must carry the account's recovery key-agreement key in its `kx`
slot (kx placement mode C, kernel's `KX_MODE`): an empty slot, a value that is
not an uncompressed P-256 point, and one equal to the account key are refused.

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

## Licence

This directory is licensed under the GNU Affero General Public License,
version 3 only (`AGPL-3.0-only`, full text in [LICENSE](LICENSE)); the rest of
the repository is MIT. It runs as a network service, so anyone who offers a
modified copy to users over a network must offer those users its source.
Contributions to it need the contributor licence agreement in
[CLA.md](CLA.md); see [CONTRIBUTING.md](../../CONTRIBUTING.md#license).

## The passkey roster (option G)

Under option G a bento/id account is a **roster of passkeys** (the kernel's
`ros.` chain, `kernel/src/roster.ts`); no account private key exists anywhere.
`src/roster.js` keeps each address's roster in its own Durable Object
(`Roster`, named by the same address hash) and enforces the directory's half:

- **One constant** (`src/passkey.js` `PASSKEY`): rp `id.bento.page`, and the
  only accepted origin is the sign-in host `https://signin.id.bento.page`. Not
  `https://id.bento.page`, `https://home.bento.page` or `https://bento.page`.
  Native origins join as each is measured; none is listed yet.
- **Registration** is checked here (strict client data, exact challenge and
  origin, never cross-origin, exact rp hash, UP+UV, ES256 P-256 only; the
  directory relies on no attestation). **Assertions** go through the kernel
  verifier with the credential's stored signature counter.
- **A change** is asked for by an unquarantined passkey member over the exact
  new `ros.` text, which names a single-use directory challenge. One member
  added or removed; an added passkey brings its registration over the same
  challenge. It waits **72 hours on the directory's clock**; one change at a
  time. A member removing itself is immediate only while another
  unquarantined passkey stays.
- **Setup** needs a 256-bit single-use setup token, with no attempt counter.
- **Log**: every enrolment and change, with the request `Origin`, the ceremony
  origin, the opener the sign-in host reports, and the time.
- **Mail**: every roster mail names the change in words, to the second, with
  the host class, and lists the whole roster. No budget a stranger can fill
  holds one back.

| route | proof | answer |
|---|---|---|
| `POST /v1/roster/challenge` `{email}` | none | a sealed single-use challenge for that address (5 minutes) |
| `GET /v1/roster?e=` | none | the head `ros.` text and any waiting change, or 404 |
| `POST /v1/roster/setup` `{email, token, dirNonce, reg}` | the setup token + a registration over `dirNonce` | 200 with `ros.0` |
| `POST /v1/roster/request` `{email, ros, credId, assertion, reg?, rq?}` | a member's assertion over `ros` (+ the new passkey's registration for an add) | 202 queued, or 200 for an immediate self-removal |

**Not built yet**: the ripening countersign `rip.` (so no route serves a
roster a peer can verify), the setup-start route and its mailed link, the
void page, the reset, consent-key and recovery-key members, account deletion,
and the incident lever across addresses.

**What id.bento.page answers**: JSON with `nosniff`, a Permissions-Policy that
turns off WebAuthn create and get, a CSP with `default-src 'none'` and
`frame-ancestors 'none'`, and `X-Frame-Options: DENY`, on every response. It
serves no `/.well-known/webauthn`. The Permissions-Policy does not cover the
WebAuthn Signal API, so no page here may run script, except the void page
when it comes, under its own CSP.

Rigs: `node scripts/test-directory-roster.ts`, and the mutants in
`scripts/test-directory-mutants.ts`.
