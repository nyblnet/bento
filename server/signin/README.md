# bento/id sign-in host

The only web page that runs passkey ceremonies for the bento/id relying party
`id.bento.page`. Working name **`signin.id.bento.page`**; the name is the
maintainer's to settle, and changing it means changing `wrangler.toml`, the
origin list the verifiers accept, and `check-hosting.mjs`.

| host | what it is |
|---|---|
| `id.bento.page` | the directory (`server/directory/`). It is the rp, and it never runs a ceremony |
| `signin.id.bento.page` | **this**: a few static pages, no document code, no directory key |
| `home.bento.page` | bento/home. It cannot use rp `id.bento.page` (the browser refuses), so it asks this page |

## What it does

bento/home generates a browser key `W` and a key-agreement key `kx`, opens this
page in a popup, and sends it one message. This page shows its own consent
screen, runs one passkey assertion when the person approves, hands it to the
directory, and posts the directory's answer back.

```
home  → S     window.open('https://signin.id.bento.page/')
S     → home  { t: 'ready' }                       targetOrigin 'https://home.bento.page'
home  → S     { t: 'enrol', W, kx, label }         exactly these four keys
S     → id    POST /v1/web/challenge { address }, then /v1/web/enrol { text, rq, assertion }
S     → home  { t: 'enrolled', wdev, watt }        (or { t: 'cancelled' } / { t: 'failed' })
```

`W` and `kx` are raw uncompressed P-256 points in base64url; `label` is 1–40
characters, none of them a control or format character (bidi controls
included), private-use, unassigned, a line or paragraph separator,
default-ignorable, or the braille blank.

## The rules (each has a rig row and a mutant that breaks it)

1. A request is accepted only when `event.origin === 'https://home.bento.page'`
   **and** `event.source === window.opener`; one request per window (a second
   message voids the first, also when it arrives while the first is still
   being checked); and it is exactly `{t:'enrol', W, kx, label}`.
2. Every reply goes to the literal origin `https://home.bento.page`, never `'*'`
   and never a value from a message or the URL.
3. Nothing is read from the page's own URL.
4. Opened without an opener (`noopener`), it refuses and does nothing.
5. It never makes an account change because its opener asked: no roster add or
   remove, no deletion, no sign-out, no WebAuthn Signal API call. Account
   changes start only from this host's own pages, by the person (below).
6. `rq`, the opener origin the directory logs, is `event.origin`.
7. The consent screen shows the opener's origin, the account this host has
   saved (from its own storage, never from the request: the certificate names
   the account, so with none saved the page asks for nothing and says so), and
   the label marked as chosen by bento/home. It says to approve
   only if you just asked bento/home to sign in, and it never claims the key is
   this browser's: the page cannot know that.

## The host's own pages

Everything that changes an account starts here, from the person's own button
press, never from a message. These pages answer no message and post none.

| path | what it does |
|---|---|
| `/setup#v=1&e=<address>&t=<token>` | a mailed setup link (G13): make a passkey for the address, then sign in with it once |
| `/reset#v=1&e=<address>&t=<token>` | a mailed reset link: make a new passkey; the reset waits 72 hours at the directory |
| `/account` | sign in on this host; ask for a setup or reset link; sign out every browser |

The rules (`public/account-client.js`; each has a rig row and a mutant):

1. **The fragment is the only thing read from a URL**, on the two link pages
   only, in the directory's link format (`server/directory/src/links.js`):
   exactly `v`, `e` and `t`, once each, `v=1`, a 43-character token, an ASCII
   address, and no query string. It is taken out of the address bar and the
   history entry before it is read (the browser's own history still records the
   link, so an opened, unused link stays usable from there until it expires).
   Opening a link sends nothing.
2. **`bento-id-account` is written in one place**, `signInHere()`, with the
   address the directory answered after verifying a passkey assertion made on
   this page. A setup is confirmed that way, with the passkey it just made,
   and the answer must be the link's address. Never from a URL, a message, a
   typed address or a link. A reset writes nothing: its passkey is not on the
   account until the reset takes effect.
3. **Passkeys**: rp `id.bento.page`, ES256 only, discoverable, user
   verification required, attestation `none`. The user handle is
   SHA-256(`bento-dir/1/addr\n` + address), the account's storage name at the
   directory, then 16 random bytes: a discoverable sign-in finds the account
   by it, and the random tail keeps a reset's new passkey from overwriting an
   older one on the same authenticator.
4. **A raw challenge is the directory's sealed 40-byte one**, never 32 bytes:
   a statement's WebAuthn challenge is its 32-byte SHA-256, so an assertion
   over a raw challenge cannot pass as one over a statement.
5. **Sign out everywhere** is a member's assertion over `wout.` for the
   account this host is signed in to, after a confirmation screen that names
   it.
6. **No recovery code on the web** (X7): no page makes, shows or asks for one.
   The setup page says what a browser-only account loses (X3).

## Directory routes for the pages

`public/account-client.js` is the pages' seam. The routes the directory has
are used as they are: `/v1/roster/setup/start`, `/v1/roster/reset/start`,
`/v1/roster/challenge`, `/v1/roster/setup` and `/v1/roster/reset`. Four
routes do **not exist yet**, and `scripts/lib/id-signin-directory-stub.mjs`
is their contract, check by check, which the rigs run against:

| route | request | answer |
|---|---|---|
| `POST /v1/web/signin/challenge` | `{}` | `{nonce}`, sealed, 40 bytes, audience `signin` |
| `POST /v1/web/signin` | `{nonce, assertion}` | `{address}` of the account whose live passkey made it |
| `POST /v1/web/signout/challenge` | `{address}` | `{nonce, at}`, audience `signout`, bound to that account |
| `POST /v1/web/signout` | `{text, assertion}` | `{ok: true, at}`; every browser certificate of the account is revoked |

The `wout.` text (`wout.<b64u(address)>.<at>.<nonce>`) is **provisional**:
the kernel defines the layout, and until it does the directory answers 501 at
`/v1/web/signout/challenge`, before any passkey prompt; the page then says
signing every browser out is not available yet.

## Phone approves this browser (route D): designed, not built

Route D enrols a browser key with an app's approval instead of a passkey
prompt. It runs **no ceremony, so it does not run on this host**: bento/home
generates W and kx, shows a short code, and the person types that code into
the Bento app (a native app, not a page, so G13 holds). The app reaches the
browser over link v1's slot transport, shows the label and key fingerprint,
and on approval signs the `wdev.` text with its consent key: a `cns.` of
purpose `web-add`, audience `dir`. The directory verifies it against the
account's ripened consent key, logs, mails, and countersigns `watt.`. A
hostile bento/home cannot complete it alone. It needs:

- kernel #949 merged: `cns.` purpose `web-add`, `wdev.` with `via` `cns`, and
  `verifyDevice` taking that branch;
- a directory route that verifies the `cns.` (contract to write with that
  PR) and an enrolment log entry naming the approving app;
- link v1's slot transport reachable from bento/home in a browser;
- the app's approval screen on each native host.

## Headers (set by `src/worker.js` on every response, 404s included)

- `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src https://id.bento.page; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'`
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`
- **No COOP on the sign-in host; bento/home at most `same-origin-allow-popups`.** Measured in Chromium and Chrome:
  `same-origin` **and** `same-origin-allow-popups` on this page both cut
  `window.opener`, and the protocol dies. bento/home may send at most
  `same-origin-allow-popups`. (`scripts/test-signin-host-coop.mjs`.)
- No `/.well-known/webauthn`, here or on `id.bento.page`. Only the paths in
  `src/worker.js` `FILES` exist; everything else is a 404.

## The popup's directory seam

For the popup, `public/directory-client.js` is the only file that knows the directory's API:
its origin, the two routes, the request and answer shapes, and the text the
passkey signs, which is the kernel's `wdev.` (`kernel/src/devices.ts`; the
rig compares it with the kernel's own builder):

| route | request | answer |
|---|---|---|
| `POST /v1/web/challenge` | `{address}` | `{nonce, at, rosHash}`: a single-use challenge bound to the account, the directory's time for it (the certificate's ceremony time, from which its 7-day cap counts), and the hash of the account's current roster head |
| `POST /v1/web/enrol` | `{text, rq, assertion}` | `{ok: true, wdev, watt}`, where `wdev` is exactly `text` |

The directory must allow CORS from this origin on those two routes. Bodies
are JSON sent as `text/plain`, so there is no preflight.
`scripts/lib/id-web-directory-stub.mjs` states every check the directory
makes, in order, and the rigs run against it until the directory's routes
exist.

## Deploy (the maintainer's, never CI)

The host is deployed with **its own credentials**, which can change nothing
else: not bento.page, not bento/home, not the directory. On Cloudflare,
Workers permissions are per account, so this means a separate account.
Attaching its hostname (a delegated zone for the name, or another host that can
set these headers) is a DNS decision for the maintainer.

```sh
cd server/signin
npx wrangler deploy
node check-hosting.mjs                                   # every deploy, against the live host
node check-hosting.mjs --home https://home.bento.page    # once bento/home is hosted
# then list the zone's records under id.bento.page in the DNS provider (below)
```

`check-hosting.mjs` reads headers and DNS and changes nothing. It checks a
strict CSP, `X-Frame-Options` and `nosniff` on every response; no COOP that
cuts the opener (here: none or `unsafe-none`; on bento/home: at most
`same-origin-allow-popups`); no `/.well-known/webauthn` on this host or on
`id.bento.page`; only the host's own paths; Trusted Types with no policy; and that there is no wildcard name under
`signin.id.bento.page` or `id.bento.page`. It exits non-zero on any failure.

**By hand, every deploy:** DNS cannot list explicit names (there is no zone
transfer), so the check above catches a wildcard but not, say, a forgotten
`test.id.bento.page`. Every name under `id.bento.page` can use, and wipe, the
passkeys. So the maintainer also lists the zone's records under
`id.bento.page` in the DNS provider (its dashboard or API) and confirms that
only `id.bento.page` and the sign-in host exist.

## Local

```sh
node server/signin/local.mjs              # the worker on http://127.0.0.1:8789/ (headers only)
node server/signin/check-hosting.mjs --origin http://127.0.0.1:8789 --local
```

A passkey ceremony cannot run locally: only a page on `id.bento.page` or under
it may use that rp. The browser rig routes the real names to the worker in
process instead.

## Rigs

- `node scripts/test-signin-host.mjs`: the worker, the page-source rules, and
  the hosting check (passes on the real worker, fails on each mutant).
- `node scripts/test-signin-host-browser.mjs [--chrome]`: the popup protocol,
  the consent screen, framing, COOP and the rp rows, in Playwright's headless
  shell and in Google Chrome, every WebSocket blocked, a mutant per rule.
- `node scripts/test-signin-host-engines.mjs [--chrome]`: the rows that need
  no passkey in every engine, WebKit included: back-to-back requests, the
  refusals, every label case, and the consent screen's claims.
- `node scripts/test-signin-host-coop.mjs [--chrome]`: which COOP values keep
  the protocol alive, in Chromium, Chrome and WebKit.
- `node scripts/test-signin-host-pages.mjs [--chrome | --webkit]`: the host's own
  pages against the real directory (and the stub for the routes it lacks), a
  CDP virtual authenticator in Chromium and Chrome; WebKit runs the rows that
  need no passkey.

Not covered yet: Safari on a device (popups open as tabs there; whether a
mailed link opened in Mail's in-app browser can make a passkey), real
authenticators, the redirect variant (not designed), and the directory routes
for sign-in and sign-out (stubbed).
