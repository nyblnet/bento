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

There is no storage (the frame is an opaque origin and the page keeps nothing),
no file handle, no service worker, no identity and no relay. The only network is
the signed release channel: the histories bundled into the build are used
first, and the channel is asked only when a file does not verify against them,
or when the person asks for the read-only view.

Editing with saves, recents, offline and identity are later stages.

## Two sites

| | serves | protection |
|---|---|---|
| the library, `home.bento.page` | `index.html` only | hash-pinned scripts and style, Trusted Types, `connect-src` the release channel, `frame-src` the frame site, `frame-ancestors 'none'` |
| the frame site (the maintainer's to choose) | `frame.html` only | a header CSP whose `sandbox` directive makes it opaque whoever loads it, `frame-ancestors` the library, `worker-src 'none'`, one hash-pinned script plus `blob:` |

The frame's trusted script refuses to boot unless it is opaque, framed, and
handed the file by the library's origin. It turns exactly the executable
elements gate 1 reported into `blob:` scripts and writes the document in; any
other inline script stays inline and the CSP refuses it. The frame has no
`allow-downloads`: every download goes through the library. The session is a
`MessagePort` handed over at boot; after each load of the frame the library
pings it over that port, and a frame that navigated away (nothing answers) is
closed.

The frame site must serve the headers in `dist/frame/_headers` and nothing
else: no other path, never a service worker. The library must serve
`dist/library/_headers`. Both files are Cloudflare's format, one rule per exact
path, so no header is ever appended to another (two CSP headers are two
policies, both enforced).

## Build and run locally

```sh
node home/web/build.mjs --library-origin http://127.0.0.1:5310 \
  --frame-origin http://localhost:5311 --release-base http://127.0.0.1:5312/releases/
node home/web/serve.mjs --library 5310 --frame 5311 --release-port 5312
# open http://127.0.0.1:5310/
```

`127.0.0.1` and `localhost` are different sites, as the two production domains
are. `--frame-origin` has no default: the frame domain and its DNS are the
maintainer's. `--history` bundles a signed history (repeatable); without it the
build bundles the frozen slides 1.2.10 history from `home/fixtures/gate1`, which
is right for development only. `--key` is a test seam for the rigs.

Budgets: the library page without the histories it bundles is at most 32 KB,
the frame page at most 4 KB (`scripts/test-home-web.mjs`).

## Rigs

| rig | what |
|---|---|
| `scripts/test-home-web.mjs` | the library and frame in a real browser (`BENTO_BROWSER=chromium\|webkit\|firefox`): verification, network allow-list, frame-page standalone refusals, downloads, navigation |
| `scripts/test-home-web-mutants.mjs` | eleven mutants, each red on the row that guards it |
| `scripts/test-shell-standalone.mjs` | every app shell points to bento.page and never depends on it |

Chromium runs in the required `validate` check; WebKit, Firefox and the mutants
in `ci-home.yml` (`home-web-engines`).

## Not in stage 1

- Saving. ⌘S in the document is declined and the library says so. Editing with
  write-back needs a per-document store over the frame's port, a kernel
  transport.
- A security floor in the release history (a signed mark on releases with known
  script bugs): stage 1 runs any release in the history, with no storage, keys
  or handles to reach.
- The relay: a live document opens as a plain document; its live session does
  not connect here.
