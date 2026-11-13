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

There is no document storage (the frame is an opaque origin and the page keeps
no document), no file handle, no identity and no relay. Since stage 3 the
library has a service worker for its OWN files, so a returning visit opens
offline, a signed kill switch, and a web app manifest (below).

What "only verified code" and "no network" cover, exactly:

- **The library** talks only to the signed release channel: once per load for
  the kill-switch status, and otherwise only when a file does not verify
  against the histories bundled into the build, or when the person asks for
  the read-only view. Its worker fetches only the library's own files.
- **The document** in the frame runs only its verified release's code, but its
  own content may still load `https:` images, media and embeds, exactly as it
  does opened from disk. Its scripts can reach only the release channel.
- **There is no security floor yet.** A file whose release has a known script
  bug runs that release, bug included, inside the opaque frame, where it has no
  storage, keys or handles to reach. A signed mark for such releases is a
  stage-2 gate.
- **A live document is shown as it was last saved.** Its session does not
  connect here, and the page says so.

Editing with saves, recents, offline and identity are later stages.

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
the frame page at most 4 KB (`scripts/test-home-web.mjs`), the worker at most
3 KB (`scripts/test-home-web-offline.mjs`).

## Stage 3: offline, the kill switch, install

**The worker** (`src/sw.ts`, built by `offline.mjs` to `/sw.js`) runs on the
library origin only. The frame site keeps `worker-src 'none'` and is never
controlled by it; the frame's policy and sandbox are unchanged.

- It precaches exactly the build's own files (`/`, the manifest, two icons),
  each checked against the sha256 the build compiled into the script; one
  mismatch and nothing is cached. The cache is named for the content hash of
  those files, and activating a new worker deletes every other cache.
- Network first: online, every listed path comes from the server as if there
  were no worker; the cache answers only when the network fails. Every other
  request (the release channel, the frame, any other path) is left alone and
  never cached. It has no message listener: nothing a page says can add a URL,
  bytes or code. No `importScripts`, `eval` or dynamic import; it is served
  with its own `default-src 'none'; connect-src 'self'` policy and
  `Cache-Control: no-cache`, and registered with `updateViaCache: 'none'`.
- The library's CSP names that one script (`worker-src <origin>/sw.js`), and
  its Trusted Types policy (`bento-sw`, the only one allowed) passes only that
  URL to `register()`.
- **Offline, a returning visit opens the library, not yet a document.** The
  frame page lives on another site, which this worker cannot serve, so a
  document opened offline gets a message saying it needs a connection, and
  nothing is left open. Running documents offline needs a decision on how the
  frame is delivered offline; it is not in this stage.

**The kill switch.** Every load fetches `<release base>home/status.json`, a
small manifest signed with the release key (`scripts/sign-home-status.mjs`
makes it):

```json
{ "app": "bento-home-status", "seq": 7, "at": "…", "withdrawn": ["<build>", …] }
```

`<build>` is the hex sha256 of the library's one script: `build.mjs` prints it
and writes it to `build.json` (`offline.build`); the served CSP's `script-src`
hash is the same digest in base64. No file opens until the check answers.

| the status | the library |
|---|---|
| unreachable, or 404 (offline; nothing published) | carries on: a returning visit must open offline |
| signed, for `bento-home-status`, `seq` not below the highest this browser has seen, this build not listed | carries on, registers its worker |
| lists this build | **stops**: unregisters every worker on its origin, deletes every cache, closes the open document and shows a fixed message |
| anything else that came back (a bad signature, another payload, an older `seq`) | **fails closed**: the same as withdrawn |

Beside its worker's cache, the library keeps one number: the highest `seq`
seen (`localStorage`), so a replayed older status cannot un-withdraw a build. The
message is fixed text: nothing from the manifest is shown. The next online load
comes from the server, whatever it serves then.

What it cannot do: stop a build that does not run this check. A hostile deploy
ships its own code and can register its own worker at a path of its choosing.
That needs the host to answer any request carrying `Service-Worker: script`
with a cleaning worker, and a reset page sending `Clear-Site-Data`: header
routing that static `_headers` cannot express, so it waits for the hosting
move.

**Install.** `manifest.webmanifest` (name, `start_url` and `scope` `/`,
standalone, 192 and 512 px icons), linked from the page and allowed by an exact
`manifest-src`. Browsers that offer install (Chromium; Safari's Add to Dock and
Home Screen) can install bento/home. File handling and share targets are not
in it yet.

## Rigs

| rig | what |
|---|---|
| `scripts/test-home-web.mjs` | the library and frame in a real browser (`BENTO_BROWSER=chromium\|webkit\|firefox`): verification, network allow-list, frame-page standalone refusals, downloads, navigation |
| `scripts/test-home-web-mutants.mjs` | fourteen mutants, each red on the row that guards it |
| `scripts/test-home-web-build.mjs` | production-build refusals, the release's `--home-web` options and history choice, a rehearsal release with `--home-web` |
| `scripts/test-home-web-build-mutants.mjs` | mutants of those refusals, each red on its row |
| `scripts/test-home-web-out.mjs` | where a release may put the build: identity containment, the macOS firmlink row and its mutant |
| `scripts/test-home-web-offline.mjs` | stage 3: the worker, offline, updates, the kill-switch drill, the status failing closed, install, the network allow-list; `--mutants` runs its own mutants |
| `scripts/test-shell-standalone.mjs` | every app shell points to bento.page and never depends on it |

Chromium and the build rig run in the required `validate` check; WebKit,
Firefox and the mutant rigs in `ci-home.yml` (`home-web-engines`,
`home-web-offline-engines`).

## Not in stage 1

- Saving. ⌘S in the document is declined and the library says so. Editing with
  write-back needs a per-document store over the frame's port, a kernel
  transport.
- A security floor in the release history (a signed mark on releases with known
  script bugs): stage 1 runs any release in the history, with no storage, keys
  or handles to reach.
- The relay: a live document opens as it was last saved, and the page says it
  is not live here.
