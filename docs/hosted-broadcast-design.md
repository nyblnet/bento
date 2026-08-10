# Hosted broadcast client — design

Status: approved (2026-08-09), revised (2026-08-10: derived rooms, no tok in
URLs/files). Follows docs/broadcast-design.md; extends the broadcast feature
with a hosted, driver-switchable client.

## Problem

The broadcast copy is a file: user1 exports it, hands it to the client, presents.
When user5 must replace user1, the client needs a new copy (or a manual re-point).
For a real live broadcast the client should be hosted ONCE on the presenter's
server, and the URL should select which room drives it — so any presenter
(user5 replacing user1) can take over without re-exporting files.

## Scenario

- user1..user4 each export a broadcast client and present.
- user5 takes over for user1: user5's deck mints a link to the SAME hosted
  client with user5's room; the client opens it and follows user5.

## Decisions

1. **Same deck, new driver.** The hosted client is deck X's broadcast copy,
   served from a URL. The room param only switches WHO drives it. Deck content
   is whatever the copy carries (see decision 4 for live updates).
2. **Derived rooms, no secrets in URLs.** The broadcast room is derived from
   the PRESENTER's signing key — the key this copy signs control frames with:
   the owner key (owner deck), the per-copy invite key (a shared editor copy —
   each invitee's room is unique to their copy), the shared writer key
   (legacy), or a device-local broadcast key (no-collab decks):
   `room = b64url(sha256(signerPub))[0:10]`, re-hashed until it doesn't start
   with 'w' (a 'w' name would be mistaken for a signed collab room by the
   relay). The relay connect token is derived from the room name:
   `tok = b64url(sha256(room))[0:18]` — the presenter and every viewer compute
   the same value, so the shareable URL carries no tok and the broadcast copy
   embeds no tok: `<hostUrl>?room=<roomName>`. One room system for ALL
   broadcasts (hosted or not); the copy embeds `broadcast:{room,relay}` at
   export.
3. **Hosting URL lives in the doc.** `doc.meta.hostClient` (additive format
   field, same mechanism as author/company) is set in the About dialog's
   Document properties. Every collaborator's copy of the deck inherits it, so
   user5's deck mints hosted links automatically. The broadcast popup shows a
   "Broadcast link" row with the hosted viewer URL and Copy — only while the
   presenter is actively broadcasting, and only when the deck carries a
   hosting URL. No "Set hosting URL" prompt: the field lives in the About
   dialog.
4. **Live doc sync to the hosted client.** The hosted copy joins the deck's
   collab room as a live reader replica, so slide content updates in real time
   as the deck is edited. Re-host once; the copy converges as a fork on first
   join (stampInto + merge machinery, already verified under partition).

## Architecture

### Anatomy

The hosted copy is a broadcast copy (deck snapshot + `broadcast:{room,relay}`)
that ALSO carries the collab read cap (`collab.role:'reader'` + symmetric `key`)
and sync state (`session.stampInto`). This is exactly the existing "read-only
live viewer" export (v0.9.18) with the broadcast boot path on top.

### Boot

`broadcastMode` (present-follow overlay) plus a background reader SyncSession
joining the deck's collab room. Remote ops apply via the session's direct
state.apply+emit path (the reader-mode mechanism — no editor rewrites). The
current slide re-renders on remote doc changes.

### Sockets

- **Content**: the deck's collab room (reader replica).
- **Navigation**: the presenter's broadcast room, selected by `?room=`.
- The presenter always opens a dedicated BroadcastSocket on the derived room
  (the collab-socket reuse path is removed). The relay pins the presenter's
  signer key per room (trust-on-first-use, like the tok) and verifies
  nav/laser/black frames against it.

### Link minting

- Export: "Save broadcast copy…" embeds `broadcast:{room,relay}` (room derived
  from the presenter's signing key, relay = the deck's collab relay).
- Popup: one "Broadcast link" row showing the hosted viewer URL
  `<hostClient>?room=<roomName>` + Copy, shown only while broadcasting and
  only when `doc.meta.hostClient` is set.
- user5 arms → their deck mints the same shape with their room → client opens
  it → same copy, new driver.

### URL parsing

The hosted copy accepts `?room=<name>` overriding the embedded broadcast room
(same relay). Malformed params fall back to the embedded room. The old
`?room=&tok=` and `?b=` formats are dropped (no backward compatibility).

## Security

- The URL carries only the nav capability — the room name alone, and the tok
  is derived from it, so possession of the URL is possession of the room.
- The FILE carries the deck's symmetric key — same trust as the read-only copy
  export; the server operator can decrypt the deck. It is the presenter's own
  server.
- Relay: broadcast rooms (non-`w`) TOFU the presenter's `?w=` signer key per
  room; nav/laser/black verify against the pinned key. Signed rooms keep the
  owner-key commitment check. A rotated owner key changes the signer key →
  broadcast refused until the deck is duplicated as a new deck (new docId,
  new room) — accepted limitation.

## Scope of changes

- `slides/src/main.ts` — broadcastMode: background reader SyncSession, slide
  re-render on remote doc changes, `?room=` parsing, derived tok.
- `slides/src/editor/editor.ts` — broadcast copy embeds `{room,relay}` (no tok).
- `slides/src/sync/online.ts` — `broadcastRoom(signerPub)` /
  `broadcastTok(room)` derivation helpers, hosted-link minting (reuses
  resolveBroadcastCreds).
- `slides/src/present.ts` — popup broadcast link row (no set-host flow).
- `server/sync-worker/src/worker.js` — TOFU signerKey for non-`w` rooms +
  control-frame verification against it.
- `docs/DECISIONS.md` — entry.

## Known limits

- Switching drivers = opening the new link (no server-side redirect — the
  price of zero server code). A tiny Worker could later map short ids or
  redirect rooms server-side.
- Live content sync requires the deck to be a live deck (collab on, shared).
  A non-live deck degrades to today's snapshot broadcast.
- The hosted copy is one viewer in the count.
- Key rotation breaks the broadcast room's pinned signer key (see Security).

## Non-goals

- No server-side deck storage (no generic shell, no upload endpoint).
- No server-side room mapping / URL shortener.
- No backward compatibility with the `?room=&tok=` / `?b=` URL formats.
