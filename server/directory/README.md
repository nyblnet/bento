# bento/id directory (`id.bento.page`)

Layer 1 of bento/id. It answers one question: *does this key belong to this
mailbox?* Under option G an address's account is a **roster of passkeys**
(see "The passkey roster" below).

**The first design is retired.** It bound one account key to an address with
a typed code mailed to the address and entered, signed, in bento/home
(`bind.`), served the binding at `/v1/lookup`, and removed it with a
holder-signed `del.` or another typed code. Under option G every mailed
confirmation is a link that completes only on the sign-in host (G13), so a
typed code on this host contradicts it, and with no way to make a binding the
lookup and deletions had nothing to serve. Every one of those routes answers
**410**, and the object that held bindings is gone. The directory was never
deployed, so nothing was migrated. Account deletion returns as a mailed link
to the sign-in host or a member's assertion.

## What it never holds

No private key, no document, no access list, no share, no "who looked up
whom". Storage is one Durable Object per address, **named by a hash of the
address**, and nothing lists or iterates them. Per-IP limits key on a
daily-salted HMAC, so no raw IP is stored and one day's hashes can't be
linked to the next.

## Routes

| route | answer |
|---|---|
| `/v1/bind/start`, `/v1/bind/complete`, `/v1/lookup`, `/v1/delete`, `/v1/delete/start`, `/v1/delete/complete` | retired: **410** `{error: "gone"}` for any method and body; nothing is read, mailed or stored |
| `GET /v1/keys` | the directory's public keys, for diagnosis (clients trust the list in the signed release) |

The roster's routes and the sign-in host's are below.

Every answer, an unexpected failure included, is JSON with the full header
set: an exception is caught at the top and answered as a 500
`{error: "internal"}` that names nothing inside.

## Status

The `ros.` roster format and the address normal form are the KERNEL's
(`kernel/src/roster.ts`, `kernel/src/address.ts`), so the directory and every
agent verify with one implementation. `src/address.js` only adds the storage
name. The rig runs kernel's address vectors
(`kernel/fixtures/identity-v1.json`) through the directory's normal form.

Phase 1 accepts **ASCII addresses only** (recommended, pending the
maintainer's decision on international addresses): the platforms disagree on
internationalised domains, so one address could otherwise mean one mailbox on
one host and another elsewhere.

**Not here yet:**
- the ripening countersign `rip.`, and the online key it is signed with
- the passkey key-blob store and the access-ledger blob
- the SES mailer

## Deploying is the maintainer's

It needs the `id.bento.page` DNS, an Amazon SES account in an EU region, and
SPF/DKIM/DMARC on a dedicated sending subdomain, all first. Then:

```sh
cd server/directory
npx wrangler secret put CHALLENGE_KEY # 32+ random characters: seals the single-use challenges
npx wrangler deploy
```

(`DIR_KEY_JWK`, the directory's online signing key, joins with the countersign;
nothing signs with it yet.)

## Testing

```sh
node scripts/test-directory.ts          # the retired routes, the address normal form, limits
node scripts/test-directory-roster.ts   # the passkey roster, setup links, mail, headers
node scripts/test-directory-mutants.ts  # each rule loosened in turn must turn a rig red
```

Both rigs drive the real worker and Durable Object classes against an
in-memory namespace and a hand-moved clock.

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
  The token arrives in a **mailed link** (`src/links.js`, below) that opens on
  the sign-in host; it completes only there, in the browser that opens it,
  when that browser makes a passkey.
- **The setup budget** (one link a minute, 3 a day, 10 in 31 days per
  address) can be filled by anyone, so it may hold a link back **only while a
  link it already mailed is still live**. With the budget full and no live
  link, one link goes anyway, and that link lives **24 hours** (a link inside
  the budget lives 20 minutes). Its life is what limits mail beyond the
  budget: a stranger asking as often as they like costs the address at most
  the day's 3 plus one, about 4 setup mails a day, and the address always has
  a live link. A link the mailer refused is withdrawn and holds nothing back.
  Per IP: 10 setup starts an hour. `setup/start` answers the same bytes
  (`202 {"ok":true}`) whatever happened.
- **No other mail ever reads a stranger-fillable budget.** `src/mail.js`
  `MAIL_KINDS` classes every kind of mail: setup links alone may be
  budgeted; roster, reset, void and freeze mail never are. Sending an
  undeclared kind throws, and the rig checks that the budget is read in one
  function per object, called from one place.
- **Log**: every enrolment and change, with the FULL public key it is about
  (and the full key that asked), the request `Origin`, the ceremony origin,
  the opener the sign-in host reports, and the time. The incident lever acts
  on the exact key, so the log never stands in a fingerprint for it.
- **Mail**: every roster mail names the change in words, to the second, with
  the host class, and lists the whole roster. No budget a stranger can fill
  holds one back.
- **The waiting notice gates the wait.** That mail is how the person stops a
  change, so a change waits to take effect only once the mailer has accepted
  its notice. With the mailer down the request fails (503 `{error: "mail"}`)
  and nothing is queued. A change whose object stopped between holding the
  slot and hearing from the mailer never takes effect, and frees the slot
  after 10 minutes. A send counts as failed after 30 seconds, and what
  follows it (marking the change sent, or clearing it after a failure)
  touches the stored change only if it is still that request's: a change
  that was dropped or replaced meanwhile is never brought back (409
  `{error: "superseded"}`).
- **Spent challenges** are one storage key each (`spent:<issued>:<nonce>`),
  kept 10 minutes and swept a few at a time by later spends, and by the
  object's alarm once nobody spends. Anyone can spend a challenge without an
  account, so one growing value would let a stranger fill it to the storage
  limit and break every request on the address.

| route | proof | answer |
|---|---|---|
| `POST /v1/roster/setup/start` `{email}` | none | **always 202**; mails a setup link if the address has no roster and the setup budget allows (see above) |
| `POST /v1/roster/challenge` `{email}` | none | a sealed single-use challenge for that address (5 minutes) |
| `GET /v1/roster?e=` | none | the head `ros.` text and any waiting change, or 404 |
| `POST /v1/roster/setup` `{email, token, dirNonce, reg}` | the setup token + a registration over `dirNonce` | 200 with `ros.0` |
| `POST /v1/roster/request` `{email, ros, credId, assertion, reg?, rq?}` | a member's assertion over `ros` (+ the new passkey's registration for an add) | 202 queued, or 200 for an immediate self-removal |

**Not built yet**: the ripening countersign `rip.` (so no route serves a
roster a peer can verify), the void page, the reset and its link, consent-key
and recovery-key members, account deletion, and the incident lever across
addresses.

### Mailed links: the contract with the sign-in host

`src/links.js` is the only place a link is built, and the sign-in host
(`server/signin/`) must read exactly this format:

    <SIGNIN_ORIGIN>/setup#v=1&e=<address, percent-encoded>&t=<token>

- `SIGNIN_ORIGIN` is the sign-in host (`src/passkey.js`). Never
  `id.bento.page`, which serves no page that reads a link.
- Everything is in the fragment, which no browser sends to a server: a mail
  scanner that fetches the link gets the bare page, cannot make a passkey,
  and never sees the token. No route anywhere completes on a GET.
- `v` is `1`; `e` is the normalised address; `t` is 32 bytes, base64url
  without padding (43 characters). Any other key, a missing or repeated one,
  a query string or another path: refuse (`parseSetupLink` is the reference).
- The page clears the fragment from the address bar first, then, once the
  person makes a passkey over a fresh `POST /v1/roster/challenge` for `e`,
  sends `POST /v1/roster/setup {email: e, token: t, dirNonce, reg}`.

### The sign-in host's routes (`/v1/web/*`)

The browser-key enrolment, matching `server/signin/public/directory-client.js`.
These answer CORS to the sign-in host only (never `*`), with `Vary: Origin`;
every other header is as above.

| route | answer |
|---|---|
| `POST /v1/web/challenge` (any body) | 200 `{nonce}`: a sealed single-use challenge for the web audience, which no roster route accepts |
| `POST /v1/web/enrol` `{text, rq, assertion}` (60 an hour per IP) | 400 for a malformed request (`text` must be a `wdev.` text, `rq` must be `https://home.bento.page`, `assertion` must carry base64url `id`, `authenticatorData`, `clientDataJSON`, `signature` and an optional `userHandle`); otherwise **501** until the kernel defines the `wdev.` statement. Nothing is stored or countersigned yet. |

**What id.bento.page answers**: JSON with `nosniff`, a Permissions-Policy that
turns off WebAuthn create and get, a CSP with `default-src 'none'` and
`frame-ancestors 'none'`, and `X-Frame-Options: DENY`, on every response. It
serves no `/.well-known/webauthn`. The Permissions-Policy does not cover the
WebAuthn Signal API, so no page here may run script, except the void page
when it comes, under its own CSP.

Rigs: see Testing above.
