# Hosted broadcast client — design

Status: approved (2026-08-09). Follows docs/broadcast-design.md; extends the broadcast
feature with a hosted, driver-switchable client.

## Problem

The broadcast copy is a file: user1 exports it, hands it to the client, presents.
When user5 must replace user1, the client needs a new copy (or a manual `?b=`
re-point). For a real live broadcast the client should be hosted ONCE on the
presenter's server, and the URL should select which room drives it — so any
presenter (user5 replacing user1) can take over without re-exporting files.

## Scenario

- user1..user4 each export a broadcast client and present.
- user5 takes over for user1: user5's deck mints a link to the SAME hosted
  client with user5's room; the client opens it and follows user5.

## Decisions

1. **Same deck, new driver.** The hosted client is deck X's broadcast copy,
   served from a URL. The room param only switches WHO drives it. Deck content
   is whatever the copy carries (see decision 4 for live updates).
2. **Direct `?room=&tok=` params.** The relay authenticates per-room with a
   trust-on-first-use token, so a bare room id cannot connect — the token must
   travel. The presenter's deck mints
   `<hostUrl>?room=<roomName>&tok=<tok>`. Zero server code: the copy is a
   self-contained file, any static host works. The tok in the URL carries the
   same trust as today's broadcast link.
3. **Hosting URL lives in the doc.** "Save broadcast copy…" gains an optional
   "Hosting URL" field, stored in `doc.meta` (additive format field, same
   mechanism as author/company). Every collaborator's copy of the deck inherits
   it, so user5's deck mints hosted links automatically. The broadcast popup
   shows a "Broadcast link" row with the hosted viewer URL and Copy.
4. **Live doc sync to the hosted client.** The hosted copy joins the deck's
   collab room as a live reader replica, so slide content updates in real time
   as the deck is edited. Re-host once; the copy converges as a fork on first
   join (stampInto + merge machinery, already verified under partition).

## Architecture

### Anatomy

The hosted copy is a broadcast copy (deck snapshot + `broadcast:{room,tok,relay}`)
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
- **Navigation**: the presenter's broadcast room, selected by `?room=&tok=`.
- When the owner presents, both ride the collab room — one socket. When a
  member (user5) presents, nav rides user5's device-local broadcast room via a
  second BroadcastSocket.

### Link minting

- Export: "Save broadcast copy…" → optional "Hosting URL" field → `doc.meta`.
- Popup: one "Broadcast link" row showing the hosted viewer URL
  `<hostClient>?room=<roomName>&tok=<tok>` + Copy. When `doc.meta.hostClient` is
  missing, a "Set hosting URL" button prompts the presenter and stores it; the
  deck then mints the viewer link.
- user5 arms → their deck mints the same shape with their room → client opens
  it → same copy, new driver.

### URL parsing

The hosted copy accepts `?room=&tok=` overriding the embedded broadcast creds
(same pattern as the existing `?b=`, shorter). `?b=` stays for arbitrary
takeover. Malformed params fall back to the embedded room.

## Security

- The URL carries only the nav capability — same trust as today's broadcast
  link (view-only, per-room token).
- The FILE carries the deck's symmetric key — same trust as the read-only copy
  export; the server operator can decrypt the deck. It is the presenter's own
  server.
- No relay changes: reader sockets, owner-only nav enforcement, and the
  commitment check all already exist.

## Scope of changes

Client only. No relay/worker changes, no format changes beyond `doc.meta`
(additive).

- `slides/src/main.ts` — broadcastMode: background reader SyncSession, slide
  re-render on remote doc changes, `?room=&tok=` parsing.
- `slides/src/editor/editor.ts` — export dialog "Hosting URL" field; hosted
  copy carries reader creds + sync state.
- `slides/src/sync/online.ts` — hosted-link minting helper (reuses
  resolveBroadcastCreds + viewerUrl).
- `slides/src/present.ts` — popup broadcast link row + set-host flow.
- `slides/src/i18n/*.ts` — new strings in all catalogs.
- `docs/DECISIONS.md` — entry.

## Known limits

- Switching drivers = opening the new link (no server-side redirect — the
  price of zero server code). A tiny Worker could later map short ids or
  redirect rooms server-side.
- Live content sync requires the deck to be a live deck (collab on, shared).
  A non-live deck degrades to today's snapshot broadcast.
- The hosted copy is one viewer in the count.

## Non-goals

- No server-side deck storage (no generic shell, no upload endpoint).
- No server-side room mapping / URL shortener.
- No changes to the relay or the broadcast wire format.
