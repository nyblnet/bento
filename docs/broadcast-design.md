# Live slide broadcast — design

Status: approved (2026-08-10). Companion to `collab-design.md` and
`relay-design.md`; the hosted viewer variant extends this in
`docs/hosted-broadcast-design.md`. Nothing touches the CRDT, the op log, the
room byte cap, or existing file formats.

## What it is

The presenter of a `.bento.html` deck broadcasts their **current slide** to
any number of viewers in near real time, over the existing Cloudflare Worker +
Durable Object relay. Viewers need no write access, no account, and no
collaboration keys — just the broadcast copy.

**The broadcast copy is a standalone `.bento.html` built from the presenter's
deck** via the Share menu ("Save broadcast copy…"). It carries the deck
content plus the room connection credentials, boots directly into a locked
present-follow mode, and is driven live by the presenter's show: on slide
change, every connected copy follows — same slide, same transitions, same
morphs — because the copy runs the real renderer on its own copy of the
document.

The nav channel stays deliberately narrow: it carries **only a slide number**
(plus laser/black control), never content — the relay must never hold a
document, and the copy already has one.

## Room & key model

One room system for ALL broadcasts. The broadcast room is **derived from the
presenter's signing key** — the key this copy signs control frames with:

- owner key (`collab.ownerPriv`, an owner deck),
- per-copy invite key (`collab.invite`, a shared editor copy — each invitee's
  room is unique to their copy),
- shared writer key (legacy rooms),
- or a device-local broadcast key (`bento-broadcast-<docId>` in localStorage,
  no-collab decks).

`room = b64url(sha256(signerPub))[0:10]`, re-hashed until the name does not
start with `w` (a `w` name would be mistaken for a signed collab room by the
relay). The relay connect token is derived from the room name:
`tok = b64url(sha256(room))[0:18]` — the presenter and every viewer compute
the same value, so **URLs and files carry no tok**: the shareable link is
`<hostClient>?room=<name>` and the copy embeds `broadcast:{room,relay}`.

The presenter always opens a **dedicated BroadcastSocket** on the derived room
(the collab-socket reuse path is removed). The relay pins the presenter's
signer key per room (trust-on-first-use, like the tok) and verifies
nav/laser/black frames against it; signed collab rooms keep the owner-key
commitment check.

## Frame protocol

### Presenter → relay

```jsonc
{ "ctl": "nav",   "n": 4,            "g": "<b64url ECDSA-P256 signature>" }
{ "ctl": "laser", "p": "0.42,0.71",  "g": "…" }   // stroke point (slide fractions)
{ "ctl": "laser", "off": 1,          "g": "…" }   // stroke end
{ "ctl": "black", "on": 1,           "g": "…" }   // blackout on/off
```

- `n` — positive integer, the **presenter-visible slide number**:
  `visibleIndex()` in present.ts (1-based, interactive states excluded) — the
  same number the speaker view's counter shows. The copy maps `n` back onto
  its own copy of the same document, so indices agree by construction.
- `p` — pointer position as slide-fraction `x,y`; `off` ends the stroke.
- Signature texts: `nav.${n}`, `laser.${p}`, `laser.off`, `black.on`,
  `black.off` — literal text signed with the presenter's key via `signText()`
  from `sync/online.ts`, same shape as `rev.${pub}`.
- Laser is throttled to ~30fps client-side (33ms); the relay's per-socket rate
  budget (RATE_BURST 400/10s) covers a full stroke with nav headroom.
- **Rejections are silent** — fire-and-forget control frames, no `refused`
  echo; the presenter's UI state is the feedback.

### Relay handling (worker.js)

For non-`w` broadcast rooms: trust-on-first-use pins the first `?w=` signer
key per room (validated `/^[A-Za-z0-9_-]{80,200}$/`), 403 on mismatch.
`controlKeyOk(meta)` verifies frames: signed rooms check the name commitment
(`'w'+sha256b64u(pubRaw) === name`), broadcast rooms check `meta.w ===
pinned signerKey`. The owner's own socket is the only one whose key passes,
so member/viewer sockets cannot broadcast even with a valid sig under their
own key.

- **Storage**: `lastNav` and `lastBlack` persist as single small values (not
  in the op log, not in the byte accounting); they die with the room after
  ~30 idle days. Laser is transient by design — a mid-stroke joiner misses it.
- **Fan-out**: `{ctl:'nav',n}` / `{ctl:'laser',…}` / `{ctl:'black',…}` with no
  signature in the copy — clients trust the relay's verification, exactly like
  fanned-out ops. Sender excluded.
- **Replay**: `replay()` sends `lastNav` (and `lastBlack`) as its **first**
  step, before the snapshot/op reads — a live nav fanned out mid-replay can
  only interleave at a later await, so "apply every nav as it arrives" is
  race-free: the joiner always ends on the newest slide.
- **Presence**: on connect and on close, the relay fans
  `{ctl:'presence', n: viewers}` where viewers = connected sockets whose
  pinned key does not commit to the room's owner key (the presenter's own
  socket is excluded; collab members count as viewers).
- **Rate limiting**: control frames ride the generic per-socket limiter
  (`RATE_BURST` / `RATE_WINDOW_MS`) that runs on every message before parse —
  no exemption.

## Broadcast copy (Share menu export)

**Where it lives**: the Share panel, beside "Read-only copy…": **"Save
broadcast copy…"**. One click serializes the current doc with the broadcast
fields embedded and downloads a **new file** (original untouched, rollback
free — same pattern as every other export). The file *is* the viewer; no
hosting, no site generation.

**The mode marker is additive**: the copy embeds
`doc.collab.broadcast = { room, relay }` — nothing in the format changes for
existing files, and old shells ignore the unknown field. The current shell
checks for it at boot: if present → **broadcast-viewer mode** (below), and
the editor never mounts. The copy sets `collab.on:false` explicitly (legacy
shells treat an absent `on` as "on"), gets a **fresh docId** (a derived
artifact, not an identity-keeping copy), and carries **no private keys, no
symmetric key, no sync state**. Encrypted decks export as plaintext (the copy
is a plaintext share by definition, same tradeoff as every export); the
owner's file stays encrypted.

**Stale copy, accepted**: the copy is a build-time snapshot. If the owner
edits after building, an old copy can show an outdated deck and an
out-of-range `n` (the client clamps to the last slide). Rebuild after
material edits.

## Presenter client

- **Toggle**: a button in the speaker view's `.sv-ctrls` toolbar
  (`navBtn('broadcast', ICONS.broadcast, t('Broadcast to audience'))`), **off
  by default, every show** — presenting locally must never silently broadcast.
  Active state + viewer count refresh through `updateSpeakerControls()`.
- **Arm flow** (`toggleBroadcast` in present.ts → helpers in `sync/online.ts`):
  resolve the signing key (room derivation above) → open the dedicated
  `BroadcastSocket` → send the **current** slide immediately (the opening
  slide never fires `slidechanged`, so late joiners must get the starting
  position from the stored `lastNav`). From then on the existing
  `slidechanged` handler sends `sendNav(visibleIndex(toIdx))`.
- **Broadcast link row**: while armed, and only when `doc.meta.hostClient`
  is set, the speaker popup shows a "Broadcast link" row with the hosted
  viewer URL `<hostClient>?room=<name>` + a Copy button; a "Set hosting URL"
  button appears when the field is missing. `doc.meta.hostClient` lives in
  the About dialog's Document properties (additive format field, inherited by
  every collaborator's copy) — the broadcast popup never prompts for it.
- **Clipboard**: `navigator.clipboard.writeText` needs focus and user
  activation in the document that calls it; the click is in the popup, so
  `openSpeaker` appends one small inline script that fills a readonly input
  from `postMessage` (`{bento:'broadcast', link|null}`) and copies in popup
  context. The editor owns crypto/state; the popup owns clipboard.
- **Teardown**: toggle off, or show exit (`exit()`), closes the socket,
  unhooks the flag, resets the button and the popup row. A broadcast never
  outlives its show; `lastNav` persists on the relay, so a copy that
  reconnects mid-show (or for the next show) lands on the right slide.

## Broadcast client (the copy's runtime)

Boot: `doc.collab.broadcast` present → **broadcast-viewer mode** — the full
present overlay (real Reveal, morphs, fx, the entire renderer) on the embedded
document, with no editor, no autosave, no collab session, no Save path.

- **Connect**: `new WebSocket(relay + '/d/' + room + '?tok=' + derivedTok)`
  — no `?w=`: the unauthenticated-for-reads path. `since=0` replays the room
  (ciphertext noise the copy ignores, never a crash).
- **Apply**: every `{ctl:'nav', n}` maps `n` onto the deck's own slide order
  (the same 1-based, states-excluded numbering) and goes there via the same
  goTo machinery the presenter uses, so transitions and morphs play normally.
  The replayed `lastNav` lands a mid-show joiner on the current slide; before
  the first frame: "Waiting for presenter". Out-of-range `n` clamps to the
  last slide.
- **Status chip**: dark corner chip — "Connecting…" / "Waiting for
  presenter" / "Live · N viewers" / "Broadcast ended".
- **Reconnect/backoff** copied from `OnlineTransport`: 800ms × 1.8, cap 30s,
  reset on open; ping every 25s with pong check so a half-open socket
  reconnects instead of hanging. Connection loss shows "Broadcast ended" but
  keeps retrying — the presenter may re-present on the same room.
- **Ignore everything else** — collab ciphertext, unknown control frames.
- **Esc** exits to a minimal card (playerMode's exit pattern).

## Hosted client

A broadcast copy can be hosted ONCE on the presenter's server and re-pointed
at any presenter's room via `?room=<name>` — so a replacement presenter takes
over without re-exporting files. The hosted copy additionally joins the deck's
collab room as a live reader replica, so slide content updates in real time
as the deck is edited. Full design: `docs/hosted-broadcast-design.md`.

## Auth model & threat model

- **Read**: the broadcast copy *is* the capability — sharing the file shares
  the feed, exactly as "Save read-only copy…" shares the document today. The
  room name is a hash of the presenter's public key (256-bit entropy —
  unguessable); possession of the URL `?room=<name>` is possession of the
  room (the tok is derived from it).
- **Write**: impossible. Control frames require the presenter's signature —
  verified against the per-room pinned key; op batches require the writer key
  the copy doesn't have.
- **Spoofing**: presenter-signed per frame, verified inline by the relay. A
  hostile copy, a link-scraper, and the relay itself can all fabricate
  frames — same trust position as every frame in this system, and the worst
  case is a wrong slide on one screen.
- **Leakage**: the relay learns the deck exists (room activity), the slide
  number, the viewer count — the metadata it already sees for collab rooms;
  never a title, never content. The copy itself is a plaintext deck by
  construction: the presenter chose to share it.
- **Key rotation** changes the signer key → the pinned broadcast room refuses
  the new key until the deck is duplicated as a new deck (new docId, new
  room) — accepted limitation.

## Verification

- **Relay**: `npx wrangler dev --port 8787` + `scripts/test-nav.mjs` (Node's
  built-in WebSocket, no deps): mints a key, connects presenter + viewer
  sockets, asserts unsigned/forged/member-key frames dropped, valid frames
  fanned out, `lastNav` replayed ahead of any live frame, presence rises on
  connect and falls on close, rate limiter still applies. The relay must be
  `wrangler deploy`d for enforcement — same operational rule as every relay
  change.
- **Client**: `tsc -b` + `npm run build:single`; manual two-tab session:
  build a copy → open it (boots into present-follow, "Waiting for presenter")
  → present + arm → the copy follows slide-for-slide, transitions included →
  a second copy opened mid-show lands on the current slide → disarm → copies
  show "Broadcast ended" and reconnect on re-arm → exit ends the broadcast →
  a stale copy clamps instead of crashing.
- New UI strings go into **all** i18n catalogs (AGENTS.md hard rule 6).
- No `crdt.ts` changes → `scripts/test-sync.ts` unaffected.
