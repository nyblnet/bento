# Stage-0 measurement probes

Small pages a person opens in real browsers to measure what the platform
does: whether a document boots in an opaque sandboxed frame, whether an
installed web app can save a file in place, whether a key kept in a browser
survives a week, what Cloudflare logs about a request, and how long and how
big a tool call to a remote MCP server can be.

**These are measurement tools, not product.** No product code depends on them
and nothing here ships in a document. Each page shows its instructions and a
**Copy results** button that puts one line on the clipboard (and on screen, for
copying by hand). The person pastes that line back; nothing is reported to any
server we run. The only probe that sends a request on purpose is P5, whose
whole job is to measure one; its page says exactly what is sent where.

**Hosting.** Every probe lives on a `*.workers.dev` address (P1's frame on a
`*.pages.dev` address, see below), never on `bento.page` or any of its
subdomains: no document code runs on bento.page's origins. None of the configs
has a route or a custom domain, and the rig fails if one appears.

**Deploying is the maintainer's.** Nothing here has been deployed. The
commands are below, each run from the folder named. `npx wrangler@4.152.0
login` once first.

| probe | measures | folder | address after deploy |
|---|---|---|---|
| P1 frame | a document booting in a cross-site opaque frame; offline; agent canaries; third-party storage; WebMCP | `p1-frame/` | top `bento-probe-top.<you>.workers.dev`, frame `bento-probe-frame.pages.dev` |
| P2 install | `file_handlers`, `launchQueue`, `share_target`, a stored file handle, in a tab and installed | `p2-install/` | `bento-probe-install.<you>.workers.dev` |
| P3 keep | non-extractable keys in IndexedDB, `persist()`, over a week | `p3-keep/` | `bento-probe-keep.<you>.workers.dev` |
| P5 log canary | what Workers Logs keeps of a request, by default, on, and off | `p5-log/` | `bento-log-probe.<you>.workers.dev` |
| P6 slow MCP | the longest tool call and biggest tool result Claude and ChatGPT accept | `p6-mcp/` | `bento-mcp-probe.<you>.workers.dev` (connector URL: add `/mcp`) |

`<you>` is the account's workers.dev subdomain (Workers & Pages → your
subdomain).

## Deploy commands

From the repository root; each line runs in its probe's folder.

```sh
# P1 frame: two deployments of the same static folder (p1-frame/public)
(cd server/stage0-probes/p1-frame/top-site && npx wrangler@4.152.0 deploy)
(cd server/stage0-probes/p1-frame/frame-site && npx wrangler@4.152.0 pages project create bento-probe-frame --production-branch main)   # once
(cd server/stage0-probes/p1-frame/frame-site && npx wrangler@4.152.0 pages deploy --branch main)

# P2 install
(cd server/stage0-probes/p2-install && npx wrangler@4.152.0 deploy)

# P3 keep (keep it deployed, unchanged, until the week of check-ins is over)
(cd server/stage0-probes/p3-keep && npx wrangler@4.152.0 deploy)

# P5 log canary: three configs of the same Worker, deployed in turn during
# the sitting (the page says when to switch)
(cd server/stage0-probes/p5-log && npx wrangler@4.152.0 deploy -c wrangler.default.toml)    # 1: no observability block
(cd server/stage0-probes/p5-log && npx wrangler@4.152.0 deploy)                             # 2: Workers Logs on
(cd server/stage0-probes/p5-log && npx wrangler@4.152.0 deploy -c wrangler.logs-off.toml)   # 3: logs off

# P6 slow MCP server
(cd server/stage0-probes/p6-mcp && npx wrangler@4.152.0 deploy)
```

Taking them down afterwards (P3 last, after the final check-in):

```sh
(cd server/stage0-probes/p1-frame/top-site && npx wrangler@4.152.0 delete)
npx wrangler@4.152.0 pages project delete bento-probe-frame
(cd server/stage0-probes/p2-install && npx wrangler@4.152.0 delete)
(cd server/stage0-probes/p5-log && npx wrangler@4.152.0 delete)
(cd server/stage0-probes/p6-mcp && npx wrangler@4.152.0 delete)
(cd server/stage0-probes/p3-keep && npx wrangler@4.152.0 delete)
```

## P1 frame

A top page that stands in for a library, and a sandboxed frame
(`allow-scripts allow-popups allow-modals allow-downloads allow-forms`, never
`allow-same-origin`, so its origin is opaque) on a **different site** that
boots the picked file's own code: the frame's script turns the file's inline
scripts into `blob:` scripts under a fixed CSP (`script-src 'self' blob:`) and
writes the document in, with a small reporter first that tells the top page
what happened (boot, CSP refusals, popup, fullscreen, copy and paste, print,
download, file input, drop). The top page reads the file on the device; the
file's bytes go to the frame by `postMessage` and nowhere else.

**Why the frame is on pages.dev.** The Public Suffix List has `workers.dev`,
not `*.workers.dev`, so two Workers on one account
(`a.<you>.workers.dev`, `b.<you>.workers.dev`) are the SAME site, and the
frame would not be cross-site. `pages.dev` is its own list entry, so
`bento-probe-frame.pages.dev` is a different site from anything on
workers.dev. Both deployments serve the same folder; `_headers` gives each
path its own headers. If the project name is taken, deploy under another and
open the top page with `?frame=https://<name>.pages.dev/frame` (remembered).
Once the test domain exists, the frame can move to a subdomain of it the same
way.

Pages: `/` (the eight steps of A1/D1/E1/G1, A2, A4, C1), `/storage` (A3),
`/webmcp` (C2). Three frame modes for A4: **cross-site** (the frame site serves
the frame), **worker-served** (the top page builds the frame from its own copy
of `frame.js` as a sandboxed `srcdoc`, pinned by hash, and its worker keeps
that copy for offline use) and **frame-site worker** (a hidden frame on the
frame site registers that site's worker first; whether that worker may then
serve the sandboxed frame offline is what the mode measures).

A `srcdoc` frame inherits the top page's CSP, so the top page's `script-src`
carries `frame.js`'s hash and `blob:`. The rig fails if the hash in `_headers`
and the file disagree; after editing `frame.js`, put its new hash
(`openssl dgst -sha256 -binary frame.js | base64`) in `_headers`.

**Canary deck (C1).** With "canary deck" ticked, the top page changes the
copy it hands the frame (never the file on disk): one text box
`CANARY-SLIDE-<run>` on slide one, and `collab` replaced by
`{ on: false, ownerPriv: "CANARY-OWNERPRIV-<run>" }`, so sharing is off and the
deck never connects anywhere. `window.bentoAgent` on the top page
(`listSlides()`, `describe()`) is built from slide text the top page already
read; it never touches `collab`. A fresh shell has an empty document block, so
use a deck that has been saved at least once.

Line: `P1 v1 | page=main | ua=… | mode=… | online=… | topsw=… | frame=… |
frame-sw=… | ready=… | served-by=… | origin=… | storage=… | csp=… | boot=… |
popup=… | fullscreen=… | copy=… | paste=… | clipboard=… | print=… |
download=… | fileinput=… | drop=… | violations=… | errors=… | canary=… |
steps=1:…,…,8:… | notes=…`. The storage page's line has `page=storage` and
`ls`, `idb`, `cookie`, `sa`; the WebMCP page's has `page=webmcp` and
`top-api`, `top-register`, `frame-api`, `frame-register`, `agent-listed`.

## P2 install

An installable app: `file_handlers` for `.html`, `launch_handler`,
`share_target` (a file, by POST, answered by the app's own worker so it works
offline), and a `FileSystemFileHandle` kept in IndexedDB so a reload can ask
to reconnect. **Edit and save** appends one line,
`<!-- stage-0 probe P2 edit <time> -->`, to the end of the file and reads it
back through the handle: use a throwaway copy of a deck. Without a handle
(Safari, Firefox, Android without the picker) it offers a download and, where
the browser can, the share sheet.

Line: `P2 v1 | ua | display | fsa | launchQueue | sw | opened | write |
stored-handle | reload-perm | request-perm | launch | launch-perm | share |
prompt | open-with | disk-changed | errors | notes`.

## P3 keep

**Make keys** creates a non-extractable ECDSA P-256 key and a non-extractable
ECDH P-256 key and keeps them in IndexedDB. The fingerprint is the first 16
hex digits of SHA-256 over the signing key's raw public key. Each load signs
and verifies a message and derives a shared secret, so "same fingerprint"
means the private keys still work, not only that a record is there. **Loading
the page never makes a key**: a lost key shows as `key=none`, never as a new
fingerprint. Each load is appended to a visit log in the same store.

Keep it deployed and unchanged for the whole week: renaming or deleting the
Worker changes the origin, which loses every browser's key by our hand.

Line: `P3 v1 | ua | display | key | fp | kxfp | created | age-days | sign |
kx | extractable | persisted | persist-answer | visits | previous-visit |
storage | notes`.

## P5 log canary

**What is sent where:** when the person runs the page's `curl` line (or presses
Send), one POST goes from their machine to this Worker's `/canary`, with
`?canary=CANARY-URL-<run>`, the header `X-Canary: CANARY-HDR-<run>` and the
body `CANARY-BODY-<run>`. The Worker answers with sizes, stores nothing, and
logs exactly one line itself, `probe-logline CANARY-LOGLINE-<run>`: the
control that tells "logs off" from "logs on but this field is not kept". It
never logs the URL, headers or body; whatever of those appears in the
dashboard, the platform kept on its own. The rig checks the Worker's logging.

Line: `P5 v1 | run | config | sent | url | header | body | logline | where |
retention | notes`, one per config.

## P6 slow MCP server

MCP over Streamable HTTP at `/mcp`, stateless (plain JSON answers, no session
id, no event stream, no sign-in), with two tools: `sleep(seconds)` (0–900,
annotated as a write tool on purpose; it changes nothing) and
`big(kilobytes)` (1–20000, exactly that many KiB between `BEGIN-<n>KB` and
`END-<n>KB total <bytes> bytes`). `initialize` answers with the client's own
protocol revision when it is date-shaped. Logs are off; it keeps nothing.

Line: `P6 v1 | product | sleep-ok | sleep-fail | big-ok | big-fail | can-add |
write-call | notes`.

## P4 passkey probe: not built yet

P4 waits for the test domain. It cannot run on workers.dev: it needs an rp
host, a sign-in page UNDER the rp and an opener OUTSIDE it, all on a domain we
control. What it will need:

- The test domain as a Cloudflare zone, and three hostnames on it:
  `home.<test>` (the opener), `signin.id.<test>` (the sign-in stand-in, popup
  and redirect variants) and `id.<test>` (the rp id). Each is a Worker with a
  custom domain on the test zone, so unlike the probes here its configs carry
  routes, on the test domain only.
- `id.<test>` serves `/.well-known/apple-app-site-association` (the iOS probe
  app's team id and bundle id, `webcredentials`) and
  `/.well-known/assetlinks.json` (the Android probe app's package name and its
  DEBUG signing certificate's SHA-256), so those values from the iOS and
  Android probe builds are inputs.
- Static pages only: challenges can be random in the page, because the probe
  parses results rather than verifying a sign-in. It parses every create/get
  result (COSE alg, the signature's S against half the curve order, extra
  `clientDataJSON` keys, origin, BE/BS/UV flags, attestation format), has
  "direct" and "after a wait" variants of each ceremony, a ×20 get tally, a
  list-and-delete page, and Signal API buttons
  (`signalAllAcceptedCredentials`, `signalUnknownCredential`,
  `signalCurrentUserDetails`).
- The same Copy-results line convention as the probes here.

## Checking the probes locally

```sh
npm run build:single --prefix slides     # P1 boots this shell
node scripts/test-stage0-probes.mjs      # Chromium, via Playwright
```

The rig serves each folder the way Cloudflare does (`_headers`, `.html`
dropped from paths), runs P5 and P6's Worker code in Node, puts P1's top page
and frame on two different sites (`localhost` and `127.0.0.1`), and checks
every probe's Copy-results line and its promises: the frame is opaque and
boots the shell in all three modes and offline, no request leaves the probe
origins, the canaries land in the frame and never in `window.bentoAgent`,
P2's worker answers the share target offline, P3 never makes a key by itself,
P5 logs only its control line, P6 answers MCP.
