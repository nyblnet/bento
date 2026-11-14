# home/web: bento/home in your browser (stage 1)

A web page that opens a Bento document from your device, checks that its code
is a signed Bento release, and runs it in a sandbox to view and present. It is
the fourth bento/home host, beside iOS, Android and the extension, and it
follows the same rule they do: **only verified code runs.**

Stage 1 is **open and present, nothing kept**:

- pick or drop a `.bento.html` file; its bytes are read on the device and never
  uploaded;
- the file's code is checked against the signed release history with kernel
  gate 1 (`kernel/src/gate1.ts`, `verifyServedHeld`), the same served-path check
  every native host ports; the signature check is the extension's mirror of the
  kernel's (`home/webext/src/release.js`), pinned to the kernel's key by
  `scripts/test-webext-release.ts`;
- a file whose code matches exactly one release runs in **that** release (its
  own shell, never a silent upgrade), in a sandboxed frame on a separate site;
- a file whose code matches none (tampered, a fork, a release newer than the
  history) never runs. On request, its document opens read-only in the newest
  signed release of its app;
- Download gives back exactly the bytes that verified. Nothing else is written.

There is no storage of the browser's (the frame is an opaque origin), no file
handle, no service worker, no identity (unless built with `--identity`, below)
and no relay. The document gets one store
for side data (its crash-recovery copy and member key), answered by the page
over a port, kept in the page's memory while the document is open and dropped
when it closes: see "The document's store" below.

What "only verified code" and "no network" cover, exactly:

- **The library** talks only to the signed release channel: the histories
  bundled into the build are used first, and the channel is asked only when a
  file does not verify against them, or when the person asks for the read-only
  view.
- **The document** in the frame runs only its verified release's code, but its
  own content may still load `https:` images, media and embeds, exactly as it
  does opened from disk. Its scripts can reach only the release channel.
- **There is no security floor yet.** A file whose release has a known script
  bug runs that release, bug included, inside the opaque frame, where it has no
  storage, keys or handles to reach. A signed mark for such releases is a
  stage-2 gate.
- **A live document is shown as it was last saved.** Its session does not
  connect here, and the page says so.

Editing with saves, recents and offline are later stages. Identity is built
(below) but is off in the build unless asked for.

## Two sites

| | serves | protection |
|---|---|---|
| the library, `home.bento.page` | `index.html` only | hash-pinned scripts and style, Trusted Types, `connect-src` the release channel, `frame-src` the frame site, `frame-ancestors 'none'` |
| the frame site (the maintainer's to choose) | `frame.html` only | a header CSP whose `sandbox` directive makes it opaque whoever loads it, `frame-ancestors` the library, `worker-src 'none'`, one hash-pinned script plus `blob:` |

The frame's trusted script refuses to boot unless it is opaque, framed, under a
script policy (the header's: if `Function('')` runs, the header was lost, and
the library's sandbox attribute alone would leave a document's markup
handlers free), and handed the file by the library's origin. It turns exactly the executable
elements gate 1 reported into `blob:` scripts and writes the document in; any
other inline script stays inline and the CSP refuses it. The frame has no
`allow-downloads`: every download goes through the library. The session is a
`MessagePort` handed over at boot; after each load of the frame the library
pings it over that port, and a frame that navigated away (nothing answers) is
closed.

The frame site must serve the headers in `dist/frame/_headers` and nothing
else: no other path, never a service worker. The rule covers `/frame` as well
as `/frame.html`, because some hosts serve a page without its extension. The library must serve
`dist/library/_headers`. Both files are Cloudflare's format, one rule per exact
path, so no header is ever appended to another (two CSP headers are two
policies, both enforced).

## The document's store

`kernel/src/docstore.ts` keeps a document's crash-recovery copy and member key
in its host when there is one. Here the host is the library, and the channel is
a second `MessagePort` in the handshake (`kernel/src/docstoreport.ts`): the
frame offers it to the document once, as `window.__bentoDocStore.take()`, and
the library answers `get`, `set`, `list` and `delete` on it.

- **The port is the only channel.** Nothing reads a message's origin (the frame
  is opaque) and nothing is posted to a window: holding the port is the
  capability.
- **The library enforces everything**, because the document owns the frame's
  realm: a closed op and name list, an exact key set per op, rising request
  ids, bytes only as a plain `Uint8Array`, a cap per name (and per open, which
  binds only once there are more names), a cap on requests in flight and on
  the rate. Anything else is dropped unanswered
  and counted (the root element's `data-bento-store` is `served refused
  dropped`, for the rigs); too many drops close the store.
- **Each open is a new entry**, minted by the library, and the store is bound
  to the docId of the file it verified: nothing in a message names either. A
  file claiming another document's docId gets a fresh, empty entry. Only a
  body in one of the apps' plaintext formats has a docId here (an allowlist):
  an encrypted file's store answers `unavailable`, even when its envelope
  carries a docId field.
- **Closing the document closes its store**: a port the document stashed (in a
  popup, say) is answered nothing afterwards.
- **Files are not written on this channel.** Saving stays the library's (and
  will re-splice the document's data into the shell it verified).
- **A release that predates the port never reads it** and behaves as in stage
  1. Only shells built with this kernel use it.

Not yet: keeping the store past the open. Stage 2's per-entry recovery cache in
the library's own storage, cleared when a write-back succeeds, plugs into the
same `serveDocStore` through its `StoreBackend`. Before it does, two things the
in-memory store cannot show must hold, each with a rig row and a mutant:

- **A write in flight at close does not survive the clear (S2-a).** With a
  backend that awaits (as IndexedDB does), a `set` posted before the document
  closes can land after the entry was dropped, and the same race hits the clear
  after a write-back. The host re-checks that the session is open after every
  backend await, and the drop or clear runs only after in-flight requests have
  settled.
- **A session cannot overwrite a record written under another docId (S2-b).**
  The docId check guards reads today, not writes: a second session on the same
  entry with a different docId reads `null` but its `set` replaces the record.
  A persistent per-file entry would make that a way to destroy a device's
  member key by opening a different file under the same entry. Records are
  keyed by entry AND docId, or `set` refuses when the held record's docId
  differs.

## Build and run locally

```sh
node home/web/build.mjs --dev --library-origin http://127.0.0.1:5310 \
  --frame-origin http://localhost:5311 --release-base http://127.0.0.1:5312/releases/
node home/web/serve.mjs --library 5310 --frame 5311 --release-port 5312
# open http://127.0.0.1:5310/
```

`127.0.0.1` and `localhost` are different sites, as the two production domains
are. `--frame-origin` has no default: the frame domain and its DNS are the
maintainer's. `--history` bundles a signed history (repeatable, one per app).

A build without `--dev` is a production build, and it refuses, rather than
warns about, every development seam: no `--history` (a release passes the
published history of every published app), `--key` (a test key), and the
mutant hook. It also refuses any history the library would refuse at runtime:
one the release key does not verify, a tampered one, or a second one for the
same app. With `--dev` (as above) the build may bundle the frozen slides 1.2.10
history from `home/fixtures/gate1` and take `--key`, for local runs and rigs.

A release builds it with `node scripts/release.mjs --home-web --frame-origin
<url>`: the histories the release leaves in the site, for every app it
publishes, into `<site>.home-web/` (outside the site, so nothing deploys it).
Without `--home-web` a release does not touch home/web. `--frame-origin` has no
default there either; a rehearsal with a throwaway key adds `--home-web-dev`.
The published histories are checked (`build.mjs --check`, which writes
nothing) before the release signs anything. The output must be outside the
site and the published tree and contain neither (checked by folder identity,
so no symlink, case variant or firmlink gets round it, and a path through a
symlink to nothing is refused), and must be new, empty
or an earlier home/web build;
it is emptied before the other checks, so a run refused after that point leaves
no earlier build in it.

Budgets: the library page without the histories it bundles is at most 32 KB,
the frame page at most 4 KB (`scripts/test-home-web.mjs`).

## Rigs

| rig | what |
|---|---|
| `scripts/test-home-web.mjs` | the library and frame in a real browser (`BENTO_BROWSER=chromium\|webkit\|firefox`): verification, network allow-list, frame-page standalone refusals, downloads, navigation |
| `scripts/test-home-web-mutants.mjs` | nineteen mutants, each red on the row that guards it |
| `scripts/test-home-web-build.mjs` | production-build refusals, the release's `--home-web` options and history choice, a rehearsal release with `--home-web` |
| `scripts/test-home-web-build-mutants.mjs` | mutants of those refusals, each red on its row |
| `scripts/test-home-web-out.mjs` | where a release may put the build: identity containment, the macOS firmlink row and its mutant |
| `scripts/test-home-web-identity.mjs` | the bento/id agent with the real sign-in host and a CDP virtual authenticator; `--mutants`: one per rule |
| `scripts/test-shell-standalone.mjs` | every app shell points to bento.page and never depends on it |

Chromium and the build rig run in the required `validate` check; WebKit,
Firefox and both mutant rigs in `ci-home.yml` (`home-web-engines`).

## bento/id in the library (`--dev --identity`, development only)

`build.mjs --dev --identity --directory-keys <json>` adds the bento/id agent
(`src/identity.ts`, `src/identity-ui.ts`, `identity.html`). Without the flag
nothing of it is in the page, and every file it serves is byte-identical to
a build without this code. It stays a development build until the directory's keys are pinned
for release and the directory and the sign-in host are deployed. A production
build (without `--dev`) refuses `--identity` and `--directory-keys`.

- **No WebAuthn here.** The passkeys belong to rp `id.bento.page`, which this
  origin cannot use. Every ceremony runs on the sign-in host
  (`server/signin`): the library opens it in a popup, inside the person's
  click, and sends exactly `{t:'enrol', W, kx, label}` to its literal origin;
  it hears only that window at that origin, and the host answers
  `{t:'enrolled', wdev, watt}`. The library never calls the WebAuthn Signal
  API, with any list.
- **Keys.** `W` (ECDSA P-256, sign) and `kx` (ECDH P-256, deriveBits) are
  made non-extractable, fresh at every ceremony, and kept as `CryptoKey`s in
  this origin's IndexedDB (`bento-id`). A held key that can be exported is
  dropped. No account key, no PRF, no key blob, no code.
- **Verified, never believed.** The certificate must be for exactly the keys
  and label sent, and "Confirm it's you" never switches accounts. The roster
  chain (`verifyRosterChain`) and the certificate with its countersign
  (`verifyDevice`) are checked by the kernel under the directory keys the build
  pins, never keys the network offers.
- **Sign out sticks, in every tab.** Tabs share the store, so a check-in
  writes only over the record it renewed, checked and written in one
  transaction: after a sign-out or a new sign-in (in this tab or another) it
  writes nothing back and takes what the store holds. Another tab may still
  show the old state until its next check-in, but it never writes it back. A
  store that fails does not stop the hourly check-in.
- **24 hours, 7 days.** A check-in signed by `W` (`wren.`) renews the 24-hour
  countersign on load and every hour, until 7 days after the ceremony. A day
  before that the line asks "Confirm it's you": a new ceremony, new keys.
- **Incidents and revocations.** An incident record covering this key's
  ceremony (or one that cannot be read, or still open), or the directory
  saying the key is revoked, deletes the keys; only a new ceremony signs the
  browser in again.
- **Policy.** `connect-src` adds the directory (`https://id.bento.page`) and
  nothing else; Trusted Types stay required with no policy; the line is text
  only.

bento/home's routes on the directory (CORS to `https://home.bento.page` alone):

| route | request | answer |
|---|---|---|
| `POST /v1/home/challenge` | `{address}` | `{nonce}` |
| `POST /v1/home/checkin` | `{wren, sig, pin?}` | `{watt, wattSig, signer, assertion, roster, incidents}`, or 403 `{error: 'revoked' \| 'cap' \| 'unknown', incidents}` |

`scripts/lib/id-web-directory-stub.mjs` is the full contract, with every check
in order. `scripts/test-home-web-identity.mjs` drives the real library and the
real sign-in host against it (`--chrome`, and `--mutants`: a mutant per rule).

## Not in stage 1

- Saving. ⌘S in the document is declined and the library says so. The
  per-document store over the frame's port exists (above); write-back with a
  re-splice into the verified shell is next.
- A security floor in the release history (a signed mark on releases with known
  script bugs): stage 1 runs any release in the history, with no storage, keys
  or handles to reach.
- The relay: a live document opens as it was last saved, and the page says it
  is not live here.
