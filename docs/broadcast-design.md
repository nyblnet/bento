# Live slide broadcast — design

*Design document, August 2026. Status: **proposed (rev 2)** — pending
sign-off; no code written. Companion to `collab-design.md` and
`relay-design.md`. The relay changes are additive control frames and a
presence count on the existing signed-room model; the broadcast copy is an
additive export. Nothing touches the CRDT, the op log, the room byte cap, or
existing file formats.*

## What it is

The owner of a `.bento.html` deck broadcasts their **current slide** to any
number of viewers in near real time, over the existing Cloudflare Worker +
Durable Object relay. Viewers need no write access, no account, and no
collaboration keys — just the broadcast copy.

**The broadcast copy is a standalone `.bento.html` built from the owner's
deck** via the Share menu ("Save broadcast copy…"). It carries the deck
content plus the room connection credentials, boots directly into a locked
present-follow mode, and is driven live by the owner's speaker view: when the
presenter changes slide, every connected copy follows — same slide, same
transitions, same morphs — because the copy runs the real renderer on its own
copy of the document.

The nav channel itself stays deliberately narrow: it carries **only a slide
number**, never content — the relay must never hold a document, and the copy
already has one. This is the "v2" from rev 1 (document-carrying viewer)
promoted to v1; the number-only standalone viewer page is dropped.

## Frame protocol

### Presenter → relay

```jsonc
{ "ctl": "nav", "n": 4, "g": "<b64url ECDSA-P256 signature>" }
```

- `n` — positive integer, the **presenter-visible slide number**:
  `visibleIndex()` in present.ts (1-based, interactive states excluded) — the
  same number the speaker view's counter shows, so the presenter reads aloud
  exactly what the audience sees. The broadcast copy maps `n` back onto its
  own copy of the same document, so indices agree by construction.
- `g` — signature over the UTF-8 bytes of `` `nav.${n}` `` (literal text, same
  shape as the existing `` `rev.${pub}` ``), produced with the room's owner
  private key via `signText()` from `sync/online.ts` — no second crypto path.

### Relay handling (worker.js, `onMessage`)

Inserted beside the `ctl:'revoke'` handler — before the `f.i`/`f.d` envelope
requirement, which would otherwise drop it:

```js
if (f.ctl === 'nav' && Number.isInteger(f.n) && f.n > 0 && f.n < 1e6 && typeof f.g === 'string') {
  const meta = ws.deserializeAttachment() || {}
  // owner-bound socket only: the socket's pinned key must BE the room's
  // committed owner key (a member/chain socket's key never hash-matches).
  if (!meta.signed || !meta.w) return
  const name = (await this.state.storage.get('name')) || ''
  if ('w' + (await sha256b64u(b64uDec(meta.w))) !== name) return
  if (!(await this.verifyWith(meta.w, f.g, `nav.${f.n}`))) return
  await this.state.storage.put('lastNav', f.n)
  const note = JSON.stringify({ ctl: 'nav', n: f.n })
  for (const peer of this.state.getWebSockets()) {
    if (peer === ws) continue
    try { peer.send(note) } catch { /* gone */ }
  }
  await this.state.storage.setAlarm(Date.now() + IDLE_TTL_MS)
  return
}
```

Notes on the exact shape:

- **No `o` (owner pub) field.** Revoke needs `o` because it names a *target
  key*; nav names nothing, so the relay verifies against the **socket's own
  pinned key** (`meta.w`, commitment-checked at connect) — and re-checks the
  commitment inline before trusting it. This is strictly stronger than a
  per-frame `o`: a member or viewer socket cannot broadcast even with a valid
  sig under their own key. Legacy shared-writer `w`-rooms are broadcast-capable
  (their pinned key *is* the room's committed key); `r`-rooms are not
  (`meta.signed` is false there — and they have no owner commitment to check
  against).
- **Validation**: `Number.isInteger` + `1 ≤ n < 1e6`. Anything else is dropped
  silently, like every other unparseable control frame.
- **Rejections are silent** — same as revoke. No `refused` echo: nav frames are
  fire-and-forget and carry no `k` id; the presenter's UI state is the
  feedback.

### Storage

`state.storage.put('lastNav', n)` — a single small value that overwrites each
time. **Not** in the op log (`op:` keys), **not** in the `bytes` accounting or
`ROOM_BYTE_CAP` (a number, not an envelope). It dies with the room after ~30
idle days, like everything else. The `setAlarm` touch keeps the room alive
while a broadcast is active.

### Fan-out

`{ ctl: 'nav', n }` — **no signature in the fanned-out copy**. Clients trust
the relay's verification, exactly like fanned-out ops (the relay already strips
the `g` from `{p:1}` fan-out) and like the `ctl:'revoked'` note. Sender is
excluded; the sender's own UI state is local.

### Rate limiting — nothing to do

The per-socket limiter (`RATE_BURST` / `RATE_WINDOW_MS` / `RATE_BYTES`) runs on
**every** message before parse, all frame types included. Nav rides it for
free — 200 frames/10 s is far above a slide-change storm, and the user asked
for no exemption. No code change.

**Known pre-existing limitation (all frame types, not introduced here)**: the
limiter's per-socket attachment does not persist between messages of a tight
same-invocation burst — 201 frames sent back-to-back can all fan out
(empirically verified against `wrangler dev`; with ≥20ms spacing the limiter
trips correctly at 200). The abuse requires the room's own owner key, so the
exposure is bounded; tracked separately from this feature.

### Replay (late joiner)

`replay()` gains, as its **first** step:

```js
const lastNav = await this.state.storage.get('lastNav')
if (Number.isInteger(lastNav)) ws.send(JSON.stringify({ ctl: 'nav', n: lastNav }))
```

**Ordering invariant**: `lastNav` is read and sent *before* the snapshot/op
reads — the first `await` in replay. A live nav fanned out mid-replay can only
interleave at a later await, so the joiner always receives the stored value
before any live one, and "apply every `ctl:'nav'` as it arrives" is
race-free: the viewer always ends on the newest slide.

**Join-time noise, accepted**: a broadcast socket connects with `since=0`,
which replays the snapshot + op log (verified in worker.js:394 — `since === 0`
means "replay everything"). In a case-1 room that is ciphertext the copy
cannot decrypt — bandwidth noise the client ignores, never a crash; case-2
rooms are quiet (nothing ever writes). Not worth a relay flag to skip; the
relay stays dumb.

## Broadcast copy (Share menu export)

**Where it lives**: the Save dropdown, beside "Save read-only copy…": **"Save
broadcast copy…"**. One click serializes the current doc with the broadcast
fields embedded and downloads a **new file** (original untouched, rollback
free — same pattern as every other export). Not part of the `slides/` bundle,
not part of `site/` generation, no hosting needed: the file *is* the viewer.

**The mode marker is additive**: the copy embeds a new sub-object
`doc.collab.broadcast = { room, tok, relay }` — nothing in the format changes
for existing files, and old shells ignore the unknown field (the copy just
boots as a normal deck there). The current shell checks for it at boot: if
present → **broadcast-viewer mode** (below), and the editor never mounts.

- `room` — the room name (e.g. `w<commit>`).
- `tok` — the connect possession proof, exactly the `?tok=` the relay
  requires on every socket. In a case-1 room it is the derived
  `b64u(sha256(key).slice(0,18))` — one-way, so the copy can connect without
  carrying the symmetric `collab.key` it would need to decrypt anything.
- `relay` — the builder's actual relay (`syncHost()`, override included), so
  the copy is zero-config anywhere.

**The owner's signing key never enters the copy.** The copy carries read
credentials only; the owner signs from `collab.ownerPriv` (case 1) or from
device-local storage (case 2, below). A leaked copy cannot impersonate the
presenter.

**Stale copy, accepted**: the copy is a build-time snapshot of the deck. If
the owner edits after building, an old copy can show an outdated deck and an
out-of-range `n` (the client clamps). Rebuild the copy after material edits.
A staleness check (embed `docContentKey`, warn the viewer on mismatch) is a
possible v1.1; not in v1.

## Presence

The user asked to see connected viewers ("We will display user connected of
course"). This needs one small relay addition — the DO already knows its
sockets.

**Relay**: on socket connect (after replay) and on `webSocketClose`, recompute
and fan to all sockets:

```js
const name = (await this.state.storage.get('name')) || ''
let viewers = 0
for (const s of this.state.getWebSockets()) {
  const m = s.deserializeAttachment() || {}
  if (m.signed && m.w && 'w' + (await sha256b64u(b64uDec(m.w))) === name) continue
  viewers++
}
const note = JSON.stringify({ ctl: 'presence', n: viewers })
for (const s of this.state.getWebSockets()) { try { s.send(note) } catch { /* gone */ } }
```

- **Definition**: viewers = connected sockets whose pinned key does *not*
  commit to the room's owner key — the owner's own broadcast socket(s) are
  excluded, so the count is the audience. Collab member sockets count as
  viewers: they are in the audience in practice.
- Connect/close events are rare; no rate concern, no storage, no persistence,
  display-only. The sender of the connect gets the note too (it is connected
  by then).

**Presenter side**: the speaker view's broadcast button shows the live count —
"N viewers" — refreshed through the existing `updateSpeakerControls()`.

**Copy side**: the status line shows "Live · N viewers" / "Connecting" /
"Waiting for presenter" / "Broadcast ended".

## Room & key model

A broadcast room **is** a signed room: name = `'w' + b64url(sha256(ownerPubRaw))`.
No new room scheme.

**Case 1 — the deck has a signed collab room and this copy can sign as the
room's owner** (v2 owner copy: `collab.ownerPriv`; legacy: `writerPriv`).
Broadcast reuses that room and that key:

- the copy embeds the collab room name + its derived tok;
- sharing on + transport connected as direct-owner → nav rides the **existing
  socket** (`OnlineTransport.sendNav`, the raw-send pattern `revokeKey` uses);
- sharing off (or transport not connected) → a **dedicated lightweight WS** to
  the same room (`?w=<ownerPub>&tok=<tok>`, `since=0`);
- works from **any** owner copy of the deck, on any machine.

**Case 2 — everything else** (no collab, legacy `r`-room, or this copy is an
invite/member that cannot sign owner frames). Building the copy mints a
**broadcast-only owner keypair** — the smallest slice of `mintCollab()`:

- `mintKeypair()` (ECDSA P-256) → room = `syncHost() + '/d/w' + sha256(pub)`;
- `mintRoomKey()` (32 random bytes) purely to derive the connect `?tok=`;
- **no** symmetric content-key role, no invites, no members, no `collab.on`
  semantics, no changes to `doc.collab` in the owner's file;
- the owner's **private key is cached in localStorage** under
  `bento-broadcast-<docId>` (the `deviceIdentity` pattern) — never in any
  file. Consequence, documented: a case-2 copy can only be driven from the
  machine that built it (a new machine mints a fresh room and old copies go
  stale). Case-1 copies have no such limit.

**Coupling rule**: broadcast never flips `collab.on`, never connects the CRDT
session, never writes an op. It works with collab on, off, or never-minted.

## Presenter client (slides/)

### Toggle

A new button in the **speaker view's** `.sv-ctrls` toolbar (the existing
`navBtn('broadcast', '📡', t('Broadcast to audience'))` pattern). **Off by
default, every show** — presenting locally must never silently broadcast. The
button's click listener is editor-context (the existing `doNav` dispatch), so
the arm logic runs where the crypto lives; its active state + viewer count
refresh through `updateSpeakerControls()`.

### Arm flow (`toggleBroadcast` in present.ts → new helpers in `sync/online.ts`)

1. Resolve case 1 vs 2 (§Room & key model). Offline mode (`bento-offline`) →
   refuse with a message, no network.
2. Connect (or reuse) the broadcast socket; send the **current** slide number
   immediately — the opening slide never fires `slidechanged` (present.ts:1008
   comment), so late joiners must get the starting position from the stored
   `lastNav`.
3. Set `broadcastOn = true`; hand the armed state + viewer count to the
   speaker window.
4. From then on, the existing `slidechanged` handler (present.ts:923) sends
   `sendNav(visibleIndex(toIdx))` — states included, because the speaker
   counter shows `visibleIndex(cur)` too; the audience number must match what
   the presenter reads.

### Teardown

Toggle off, or show exit (`exit()`): close the broadcast WS (dedicated), or
stop calling `sendNav` (reused socket — it belongs to the session), unhook the
flag, reset the button. A broadcast never outlives its show; the room and
`lastNav` persist on the relay, so a copy that reconnects mid-show (or for the
next show) lands on the right slide.

### Clipboard — why a small popup script

`navigator.clipboard.writeText` requires focus **and** user activation in the
document that calls it; the click is in the popup, so editor-context code
would be rejected. The speaker window is same-origin and already fully scripted
from the editor, so `openSpeaker` appends one small inline script (the same
mechanism the compressed shell uses to boot itself) that:

- listens for `postMessage` from the opener: `{bento:'broadcast', link|null}`
  → fills a readonly input with the link and shows/hides a Copy button;
- Copy click → `navigator.clipboard.writeText(link)` in **popup** context
  (its own activation) → success flash.

The editor owns crypto/state; the popup owns clipboard. ~20 lines, no new
patterns.

## Broadcast client (the copy's runtime)

Boot: `doc.collab.broadcast` present → **broadcast-viewer mode** — the full
present overlay (real Reveal, morphs, fx, the entire renderer) on the embedded
document, with no editor, no autosave, no collab session, no Save path.

- **Connect**: `new WebSocket(relay + '/d/' + room + '?tok=' + tok)` — **no
  `?w=`**: the existing unauthenticated-for-reads path signed rooms support.
  `since=0` (join-time noise, §2.6).
- **Apply**: every `{ctl:'nav', n}` maps `n` onto the deck's own slide order
  (the same 1-based, states-excluded numbering via `visibleIndex`) and goes
  there — the same goTo machinery the presenter uses, so transitions and
  morphs play normally. The replayed `lastNav` arrives first (§2.5) and lands
  a mid-show joiner on the current slide. Before the first nav frame (or when
  `lastNav` is absent): "Waiting for presenter".
- **Clamp**: an `n` beyond the copy's slide count (stale copy) clamps to the
  last slide instead of erroring.
- **Reconnect/backoff copied from `OnlineTransport`**: 800 ms × 1.8, cap 30 s,
  reset on open; ping every 25 s with pong check (the relay auto-pongs) so a
  half-open socket reconnects instead of hanging. Connection loss shows
  "Broadcast ended" but keeps retrying: the presenter may re-present on the
  same room.
- **Ignore everything else** — the collab ciphertext a case-1 room replays,
  unknown control frames. Presence frames update the status line.
- **UI**: dark, minimal, audience-scale: the slides, a small status line, and
  the deck title. No chrome that invites interaction — it is a viewer, not an
  editor.

## Auth model & threat model

- **Read**: the broadcast copy *is* the capability — sharing the file shares
  the feed, exactly as "Save read-only copy…" shares the document today. The
  room name commits to the owner pubkey (256-bit entropy — unguessable); the
  `tok` is the existing possession proof the relay enforces on every socket.
  In a case-1 room a holder also receives ciphertext they cannot decrypt (the
  symmetric key is not in the copy) — no stronger than the existing model.
- **Write**: impossible. Nav requires a valid owner signature — a viewer's
  frames are dropped at the commitment+signature check; op batches require
  the writer key the copy doesn't have.
- **Spoofing**: owner-signed per frame, verified inline against the room's
  committed key. A hostile copy, a link-scraper, and the relay itself can all
  fabricate nav frames — same trust position as every frame in this system,
  and the worst case is a wrong slide on one screen.
- **Leakage**: the relay learns the deck exists (room activity), the slide
  number, and the viewer count — the metadata it already sees for collab
  rooms; never a title, never content. The copy itself is a plaintext deck by
  construction: the owner chose to share it.

## Open decisions (sign-off)

1. **Copy replaces the number-only viewer** (your message — confirmed): the
   Share-menu export is the viewer; the standalone `viewer/index.html`
   deployable from rev 1 is dropped.
2. **Presence as specced**: relay fans a socket-count `{ctl:'presence', n}` on
   connect/close; the speaker view and each copy's status line both display
   it. The copy's status line showing "Live · N viewers" covers "display user
   connected" on the audience side; the presenter side gets the same count.
3. **Toggle stays per-show, off by default** (letter of the original
   requirement). If you'd rather remember "broadcast on" per deck (localStorage,
   the reduce-motion pattern) after the first explicit arm, say so.
4. **Case-2 copies are per-machine** (owner key in localStorage, never in a
   file) — a copy built on a collab-less deck can only be driven from the
   machine that built it. Accepted tradeoff for keeping the private key off
   the file.
5. **`n` = presenter-visible number** (1-based, states excluded) — matches the
   speaker counter exactly, including its state-slide quirk.

## Non-goals

No live content mirroring in v1 — the copy is a snapshot; rebuild it after
editing the deck (possible v1.1: `docContentKey` staleness warning). No nav
history persistence; no viewer write access of any kind; no changes to the
CRDT ops model, the op log, or the room byte cap; no coupling to whether
collaborative editing is active; broadcast never turns collab on.

## Verification

- **Relay**: local `npx wrangler dev --port 8787` + a smoke script
  `scripts/test-nav.mjs` (Node 24's built-in WebSocket — no new deps) that
  mints a key, connects owner + viewer sockets, and asserts: unsigned nav
  dropped, forged-signature nav dropped, member-key nav dropped, valid nav
  fanned out, `lastNav` replayed to a late joiner ahead of any live frame,
  presence count rises on viewer connect and falls on close, rate limiter
  still applies. The relay must be `wrangler deploy`d for enforcement — same
  operational rule as every relay change.
- **Client**: `tsc -b`, `npm run build:single`, and a manual two-tab session:
  build a copy → open it (boots into present-follow, "Waiting for presenter")
  → present + toggle → the copy follows slide-for-slide, transitions included
  → a second copy opened mid-show lands on the current slide → toggle off →
  copies show "Broadcast ended" and reconnect on re-arm → exit ends the
  broadcast → a stale copy (deck edited after build) clamps instead of
  crashing. New UI strings go into **all** i18n catalogs (AGENTS.md hard rule
  6). Encrypted decks: building a broadcast copy of an encrypted deck asks for
  the password once and embeds the **decrypted** deck — the copy is a
  plaintext share by definition (same tradeoff as every export); the owner's
  file stays encrypted.
- No `crdt.ts` changes → `scripts/test-sync.ts` unaffected (still run it if
  the diff touches anything it can see).

After sign-off and implementation, append a one-line entry to
`docs/DECISIONS.md` recording the nav frame, the presence frame, and the
broadcast-copy export choice.
