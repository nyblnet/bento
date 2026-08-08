# Live slide broadcast — implementation plan

*Plan, August 2026. Companion to `docs/broadcast-design.md` (rev 2, signed
off). Status: **for review** — no code written, no commits. Design decisions
are in the design doc; this document is the how, in dependency order, with
exact anchors verified against the current tree.*

## Process contract

- **No git commits or pushes at any point.** Everything stays in the working
  tree until the user says otherwise. No `git add/commit/push`, no branches.
- **Sub-agent driven implementation.** One writer agent per phase, sequential
  (the relay phase must land first; client phases depend on it). The
  orchestrator reviews each phase's diff before the next agent starts;
  implementation agents get fresh context and strict briefs from this plan.
- **SDD init**: `sdd-init` has never been run for this repo (verified via
  engram search) — the guard requires it before implementation agents launch.
  Step 0 delegates it silently; it caches testing capabilities and strict-TDD
  state, which the verification phases consume.
- **i18n hard rule**: every new UI string goes into **all 9 core catalogs**
  (`de, es, fr, it, ja, pt, zh-Hans, zh-Hant` — pt exists in practice beyond
  the 7 AGENTS.md lists) via `scripts/build-i18n.mjs`, validated by
  `node scripts/test-i18n-coverage.mjs`.
- **No `crdt.ts` changes** → `scripts/test-sync.ts` stays untouched; run it
  only if a diff touches what it can see (it shouldn't).

## Phase map

```
0. Relay (worker.js: nav, lastNav, replay, presence)  ─┐
    scripts/test-nav.mjs (smoke)                      ─┴─> independent, first
1. sync/online.ts: BroadcastSocket + broadcast creds
2. present.ts: speaker toggle, hook, teardown, presence, clipboard
3. editor.ts Share panel: "Broadcast copy…" export
4. main.ts: broadcastMode boot + present-follow runtime
5. scripts/build-broadcast-example.mjs → working/broadcast-demo/ (2 files)
6. Verification: tsc, build:single, i18n, smoke, manual two-tab protocol
```

Phases 1–4 are client-side and land after 0. Phase 5 produces the artifacts
the user tests against; phase 6 is the test protocol itself.

---

## Phase 0 — Relay (`server/sync-worker/src/worker.js`)

Three additions + one script. The nav handler is the security-critical piece —
the relay is the enforcement point; nothing client-side can compensate.

### 0.1 Nav handler (in `onMessage`)

Insert beside the `ctl:'revoke'` block (worker.js:453-466), **before** the
`typeof f.i !== 'string' || typeof f.d !== 'string'` envelope gate (line 467)
which would otherwise drop it:

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

Semantics (from the design doc, §2.2): verified against the socket's own
pinned key with an inline commitment re-check — strictly stronger than a
per-frame `o`; `r`-rooms rejected (`meta.signed` false); silent drops; no
`refused` echo; no rate-limit exemption (the generic limiter at lines
430-442 runs before parse).

### 0.2 `lastNav` in `replay()` (line 394)

First statement of `replay()`, before the `seq`/`snap` reads — the first
`await` in the function, so the stored value always precedes any live nav
interleaving at later awaits:

```js
const lastNav = await this.state.storage.get('lastNav')
if (Number.isInteger(lastNav)) ws.send(JSON.stringify({ ctl: 'nav', n: lastNav }))
```

### 0.3 Presence push

New private helper on the Room class (uses existing `sha256b64u`/`b64uDec`):

```js
async broadcastPresence() {
  const name = (await this.state.storage.get('name')) || ''
  let viewers = 0
  for (const s of this.state.getWebSockets()) {
    const m = s.deserializeAttachment() || {}
    if (m.signed && m.w && 'w' + (await sha256b64u(b64uDec(m.w))) === name) continue
    viewers++
  }
  const note = JSON.stringify({ ctl: 'presence', n: viewers })
  for (const s of this.state.getWebSockets()) { try { s.send(note) } catch { /* gone */ } }
}
```

Call sites:

- `fetch` connect path: after `await this.replay(server, since)` (line 380).
- `webSocketClose` (lines 389-391): **before** `ws.close()` — the closing
  socket is still in `getWebSockets()`, so the count is right.

Viewers = sockets whose pinned key does not commit to the room's owner key;
the owner's own broadcast socket(s) are excluded, collab members count.

### 0.4 `scripts/test-nav.mjs` (relay smoke)

Node 24 built-in WebSocket (`node:global` — the `.nvmrc` is v24.18.0, no `ws`
dep needed). Uses `node:crypto` `webcrypto` for ECDSA P-256 + sign/verify
(mirror the client's `signText` shape). Connects against `RELAY_URL` (default
`ws://localhost:8787`). Asserts, in order:

1. room creation via `?tok=` (TOFU) + owner `?w=` connect (direct auth);
2. **unsigned nav dropped** — no fan-out, no `lastNav` stored;
3. **forged-signature nav dropped** (wrong key signs `nav.3`);
4. **member-key nav dropped** — a chain/member socket's nav (valid sig under
   its own key) never fans out;
5. **valid owner nav fanned** to a viewer socket, sender excluded;
6. **`lastNav` replayed first** to a late joiner, ahead of any live frame
   (assert ordering of the two nav frames on the joiner socket);
7. **presence**: count rises on viewer connect, falls on close;
8. **rate limiter still applies** (burst of >200 frames → first excess frame
   dropped/refused — assert the limiter's existing behavior hasn't changed).

Exit non-zero on any failed assert with a named failure. Run:

```bash
cd server/sync-worker && npx wrangler dev --port 8787 &
node scripts/test-nav.mjs
```

**Operational note (user's call, not part of implementation)**: enforcement
only exists once the relay is `wrangler deploy`d; local testing uses the dev
worker. The plan makes no deploy.

---

## Phase 1 — Broadcast socket + creds (`slides/src/sync/online.ts`)

The exploration confirmed a second `OnlineTransport` is the wrong tool (its
constructor is bound to the CRDT session model — `onFrame`, snapshot hooks,
encrypted envelopes). New small class instead, reusing the same primitives.

### 1.1 `BroadcastSocket` class (new, same file)

```ts
class BroadcastSocket {
  // room: full URL ('wss://host/d/w<commit>'), tok: derived possession proof
  // ctor(room, tok, { onNav, onPresence, onState })
  // connect(): open WS, no ?w= (read-only), since=0
  // backoff: 800ms × 1.8, cap 30s (copy OnlineTransport's retry block, line 374-378)
  // heartbeat: ping every PING_MS 25s, pong check (lines 353-367 pattern)
  // onmessage: JSON.parse; route {ctl:'nav',n} → onNav(n); {ctl:'presence',n} → onPresence(n);
  //            everything else ignored (incl. {p:1}/{snap:1} ciphertext from case-1 rooms)
  // close()/destroy(): stop heartbeat, close WS, null refs
}
```

Also needed: OnlineTransport must not choke on the new `{ctl:'presence'}`
frames the relay now fans to every socket — verify its unknown-frame handling
and add a minimal `onCtl` passthrough hook if it drops them silently (it
should ignore, not throw; the presenter hooks presence through this).

### 1.2 Broadcast creds — `resolveBroadcastCreds(doc, docId)`

- **Case 1** (deck can sign as room owner): `collab.v===2 && collab.ownerPriv`
  or legacy `writerPriv` → reuse `collab.room` + tok derived from `collab.key`
  (`b64u.enc(sha256(key).slice(0,18))`, the same derivation as `init()` line
  267). Signer = ownerPriv/writerPriv. Works from any machine.
- **Case 2** (everything else): read `bento-broadcast-<docId>` from
  localStorage (`deviceIdentity` pattern, lines 87-96); on miss, mint the
  smallest `mintCollab()` slice — `mintKeypair()` (line 64) + room commitment
  (`syncHost() + '/d/w' + b64u(sha256(commit))`) + `mintRoomKey()` (line 37)
  purely for the tok — and cache `{ pub, priv, room, tok }`. Per-machine by
  design (the private key never leaves the device).

### 1.3 `sendNav(n)` — the revokeKey pattern (lines 614-619)

```ts
const g = await signText(ownerPriv, `nav.${n}`)
this.ws.send(JSON.stringify({ ctl: 'nav', n, g }))
```

Used in two places: on the reused collab transport (case 1, sharing on +
connected as direct owner — rides the existing socket), and on a dedicated
`BroadcastSocket` (everything else). The presenter picks which; `sendNav`
itself is a thin wrapper.

Also expose `broadcastLink(creds)` → `viewerUrl(roomName, tok, relay)` for
the export + clipboard (see Phase 3).

---

## Phase 2 — Presenter (`slides/src/present.ts`)

### 2.1 Toggle button

`openSpeaker` `.sv-ctrls` (lines 651-660): add
`navBtn('broadcast', '📡', t('Broadcast to audience'))` plus a small count
badge element (a `<span class="sv-bcast">` beside the toolbar, hidden until
armed, showing "3" viewers). `updateSpeakerControls()` (line 531) refreshes
`aria-pressed` on the button + the badge text (needs the viewer count stored
in the presenter closure).

### 2.2 Arm flow

`doNav` (line 717): add `'broadcast'` → `toggleBroadcast()`:

1. offline (`bento-offline`) → refuse with a message, no network;
2. `resolveBroadcastCreds` (Phase 1.2);
3. case 1 + sharing on + transport connected as direct owner → reuse the
   transport, hook `onCtl` for presence; else → new `BroadcastSocket`;
4. send the **current** slide immediately (`sendNav(visibleIndex(cur))` —
   the opening slide never fires `slidechanged`, line 1008 comment);
5. `broadcastOn = true`; build the link (Phase 1.3) and `postMessage` it to
   the speaker window (`{bento:'broadcast', link}`) → popup shows it;
6. `updateSpeakerControls()`.

`slidechanged` handler (lines 923-976): `if (broadcastOn) sendNav(visibleIndex(toIdx))`
— states included; the audience number matches the speaker counter.

### 2.3 Teardown

- Toggle off → close dedicated socket / stop `sendNav`, `broadcastOn=false`,
  reset badge + button.
- `exit()` (line 813): same teardown — a broadcast never outlives its show.

### 2.4 Clipboard popup script

`openSpeaker` appends one inline `<script>` (same mechanism as the compressed
shell's boot script) that: listens for `postMessage`
(`{bento:'broadcast', link|null}`) → fills a readonly input + shows a Copy
button in the popup; Copy click → `navigator.clipboard.writeText(link)` in
**popup** context (its own activation — the editor's document can't do it) →
success flash. Editor owns crypto/state; popup owns clipboard. The popup
markup (input + button row) is part of the `openSpeaker` innerHTML, hidden
until the first message.

### 2.5 i18n (all 9 catalogs)

`Broadcast to audience`, `Broadcast`, `Broadcast link`, `Copy`, `Copied`,
`N viewers`, `Broadcast refused in offline mode`, `Broadcast ended`. Run
`scripts/build-i18n.mjs` + `test-i18n-coverage.mjs`.

---

## Phase 3 — Export (`slides/src/editor/editor.ts`)

### 3.1 Menu item

Share panel (lines 1165-1170) — beside `View-only copy…` / `Present-only
file…`:

```ts
action(ICONS.broadcast, t('Broadcast copy…'), false, () => void this.saveBroadcastCopy(), ...)
```

This is the "broadcast copy in the share menu" from the requirement. (The
design doc said "Save dropdown" — the exploration showed the read-only/present
exports actually live in the Share panel; this is the share menu.)

### 3.2 `saveBroadcastCopy()`

1. `resolveBroadcastCreds(doc, docId)` (Phase 1.2) — mints + caches on miss;
2. clone the doc; strip the collab machinery, keep only the broadcast reader
   fields (the copy must carry **no private keys, no symmetric key, no sync
   state**):
   ```ts
   clone.collab = { on: false, broadcast: { room, tok, relay } }
   ```
   `on:false` explicitly — legacy shells treat a collab object without `on`
   as "on" (v0.8.0 default); the copy must stay dormant there. Fresh docId
   (the copy is a derived artifact, not an identity-keeping copy);
3. serialize **plaintext always** — even for an encrypted deck the open doc
   is already decrypted in memory; follow `savePresentationPackage`'s
   serialization (line 801), never `serializeAuto` (which re-encrypts, line
   434). The owner's file keeps encrypting on ⌘S;
4. `writeUpdatedFileAs(html, clone, { suffix: 'broadcast', keepHandle: false })`
   — `suggestedFileName` (kernel save.ts:439) gives `Title-broadcast.bento.html`;
   FSA handle never retained (share-export rule, CLAUDE.md).

### 3.3 i18n

`Broadcast copy…` + the share-item title/tooltip, all 9 catalogs.

---

## Phase 4 — Broadcast client runtime (`slides/src/main.ts` + `present.ts`)

### 4.1 Boot gate (`main.ts` `bootWith`, lines 103-106)

```ts
if (doc.collab?.broadcast) broadcastMode(doc)
else if (doc.readonly) playerMode(doc)
else editorMode(doc)
```

The mode marker is the sub-object's presence — additive, ignored by old
shells (the copy boots as a normal deck there, per the design doc).

### 4.2 `broadcastMode(doc)` — the copy's runtime

New function (main.ts or a small `broadcast.ts` module; follow `playerMode`'s
shape at line 112): mount the present overlay via the existing present
machinery (`startPresentation(doc, 0, exit)`), then attach a
`BroadcastSocket(creds.room, creds.tok, ...)`:

- `onNav(n)` → resolve `n` to a slide index: the index of the n-th non-state
  slide (`visibleIndex` inverse — same 1-based numbering both sides, so
  indices agree by construction); clamp to the last slide if out of range
  (stale copy); navigate with the same absolute-goto call the presenter's
  goFirst/goLast use.
- `onState` → status overlay: dark, minimal, corner chip —
  "Waiting for presenter" (no nav frame yet) / "Live · N viewers" /
  "Connecting" / "Broadcast ended" (socket lost — keep retrying; the
  presenter may re-present on the same room). Deck title as small caption.
- Replayed `lastNav` arrives before any live frame (relay ordering invariant,
  Phase 0.2) → mid-show joiners land on the current slide.
- Ignore everything else (case-1 ciphertext noise, unknown frames).

No editor, no autosave, no collab session, no Save path, no Save/Share UI.
Esc exits to a minimal card (playerMode's exit pattern).

### 4.3 i18n

`Waiting for presenter`, `Live · N viewers`, `Connecting…`, `Broadcast ended`,
all 9 catalogs.

---

## Phase 5 — Example project + broadcast export

New script `scripts/build-broadcast-example.mjs` (the repo's example-deck
convention — see `build-example-decks.mjs`), writing to
`working/broadcast-demo/` (gitignored):

1. **Owner deck** — `broadcast-demo.bento.html`: a simple ~6-slide deck
   (title, bullets, image, morph demo, chart, speaker notes) authored as a
   doc JSON in the script, built on the current shell (dist-single after
   Phase 4). The script mints a **real case-1 collab room** with node crypto
   (ECDSA P-256 keypair, `w`+sha256 commitment, random key, tok derivation —
   byte-identical to `mintCollab`'s math) and embeds the full owner creds
   (`collab: {room, key, on:true, v:2, owner, ownerPriv, role:'writer'}`) —
   so the demo needs **no localStorage juggling**: the owner deck signs nav
   as the room owner from the file, exactly like a real collab deck.
2. **Broadcast copy** — `broadcast-demo-live.bento.html`: same shell + doc
   JSON, `collab = { on: false, broadcast: { room, tok, relay } }`, fresh
   docId — the exact shape Phase 3's export produces.
3. `--relay` flag (default `wss://sync.bento.page`); for local testing:
   `--relay ws://localhost:8787` and the owner deck's `bento-sync-url`
   localStorage set to match.

Both files are the user's test fixtures: the real export code path in Phase 3
is verified against the script's output shape (the script IS the export, run
outside the browser).

---

## Phase 6 — Verification & user test protocol

### Automated

- `tsc -b` + `npm run build:single` (slides/) clean;
- `scripts/build-i18n.mjs` + `scripts/test-i18n-coverage.mjs` pass;
- relay smoke `scripts/test-nav.mjs` against `wrangler dev` (8 asserts,
  Phase 0.4);
- no `crdt.ts` diff → `scripts/test-sync.ts` untouched.

### Manual — the user's real-time sync test

1. `cd server/sync-worker && npx wrangler dev --port 8787` (relay) — or
   `wrangler deploy` for a hosted test;
2. serve `working/broadcast-demo/` statically (any static server);
3. tab 1: open `broadcast-demo.bento.html` → Present (fullscreen) → speaker
   view → toggle 📡 Broadcast — badge shows viewer count as copies join;
4. tab 2: open `broadcast-demo-live.bento.html` → boots straight into
   present-follow, "Waiting for presenter" → follows slide-for-slide with
   transitions/morphs the moment the presenter moves;
5. open a second copy **mid-show** → lands on the current slide (replayed
   `lastNav`);
6. toggle Broadcast off → copies show "Broadcast ended" and keep retrying;
   toggle on → they reconnect and follow again;
7. exit the show → broadcast ends; Esc on a copy → minimal card;
8. stale-copy check: edit the owner deck, rebuild the copy, old copy clamps
   instead of crashing;
9. encrypted-deck check: build a copy of a password deck → copy is plaintext,
   owner file still encrypts.

### Handoff

- Review gates: orchestrator reviews each phase's diff before the next agent
  (fresh context, adversarial on the worker.js crypto path); the user reviews
  the final artifacts and runs the protocol above.
- After user sign-off (separate step, not now): `docs/DECISIONS.md` one-liner
  + whatever commit/PR flow the user chooses. **Nothing is committed by this
  plan.**
