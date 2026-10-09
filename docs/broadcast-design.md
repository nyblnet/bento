# Live broadcast — design

Status: shipped shape (2026-09-13). Supersedes the 2026-08-10 design that
stood here (a separate control channel with derived rooms and a hosted
client) — see `DECISIONS.md`, "Broadcast is a special case of collaboration".
Companion to `collab-design.md`; the relay half is documented there and in the
relay's own rig (`scripts/test-relay-broadcast.ts`).

## What it is

The presenter of a `.bento.html` deck hands out an **audience copy**. Whoever
opens it lands straight in the show; while the presenter is live their slide
follows the presenter's — transitions, morphs, black screen and laser included
— and the deck itself updates as the presenter edits mid-talk. When the show
ends, the audience copy is a plain, working deck of what was shown. Between
shows it receives nothing, by construction.

## The idea: an audience member is a collaborator with a ticket

Bento already has live collaboration: an end-to-end-encrypted room on a blind
relay, a CRDT, owner-signed invites, reader and writer roles, revocation.
Broadcast reuses all of it instead of building a second channel. The one new
thing is the **ticket**:

- an owner-signed invite with role `audience` (same chain as "Invite to edit"),
  which is what the relay admits on — receive-only;
- a per-show **show key**, separate from the room's read key. An audience
  copy carries the show key **as** its `collab.key`; it never holds the room
  key.

While live, the presenter's client encrypts every outgoing op twice — under
the room key for collaborators (as always) and under the show key for the
audience — and the relay fans the second stream to audience sockets without
ever persisting it beyond the show. Nothing is encrypted under the show key
between shows, so an audience file decrypts nothing further no matter who
holds it or what the relay does. Both halves of the ticket live in the
presenter's own file (`collab.audience`) and are reused for every show;
**Issue new tickets** re-mints them, which kills every outstanding copy.

## What the audience receives is a projection

Everything the audience gets — the handout, the join snapshot the relay
serves to late joiners, and every op streamed mid-show — is built by one
module, `slides/src/audience.ts`, so the three cannot disagree:

- **Speaker notes and review comments are kept back.** On every slide,
  interactive state and custom layout; in the file, in the snapshot, and on
  the wire — a notes edit mid-show never leaves the presenter's machine
  (`projectOp`), or the next keystroke would repair a stripped snapshot.
- **Hidden slides stay.** They are reachable by link and are part of the deck.
  A presenter who wants a slide out of the handout deletes it.
- **Blobs are inlined.** Blob keys derive from `collab.key`, so a show-key copy
  could never open room-key blobs.
- No room key, no private halves, no writer invite; `role: 'audience'` so no
  reader path ever runs on it.

`scripts/test-audience-projection.ts` drives the real CRDT through every edit
that can carry a hidden field and searches the projected wire for a sentinel;
CI runs its negative control first.

## The show, as the presenter sees it

- **Live** is a toggle in the speaker view, **off on every show**. Presenting
  locally never broadcasts by itself.
- Three verbs ride the room, signed like ops: `nav` (slide **id** first, the
  visible index only as a fallback, so an insert mid-talk costs nothing),
  `black`, and `laser` (≤ 20 fps at the source; the viewer's dot glides
  between samples). Any writer in the room may drive — a co-presenter is an
  ordinary "Invite to edit".
- **Lock** holds the audience on the presenter's slide. It is a UX constraint,
  not a security one — the audience already holds the deck — and the button
  says so: *Lock keeps the audience on your slide. It does not hide the rest
  of the deck, which they already have.*
- The relay serves late joiners itself from the presenter's last checkpoint;
  the presenter's machine does no per-joiner work.
- The audience count is coarse; audience sockets receive no presence.

## The show, as the audience sees it

- The file opens into the show and waits for the presenter.
- **Follow** is the viewer's toggle: un-follow to re-read a slide, snap back.
  Under lock the toggle is disabled and says why.
- Presenter gone: after a 60 s grace the show ends; the copy keeps the deck as
  last delivered. Presenter not live yet: "waiting", with reconnection.
  Tickets re-issued: the copy says it is no longer valid.

## What this replaced, and why

The earlier design ran a separate broadcast socket with its own rooms derived
from the presenter's key, trust-on-first-use pinning, and navigation by index.
Measured against the relay it ran on the same Durable Object with the same
fan-out, so the separate channel bought no scale; its one real property —
no durable secret in the audience file — is kept by the show key. Folding
broadcast into collaboration deleted the second transport, the pinning, the
derived rooms and a document field, and added mid-show edits, co-presenters,
revocation and the follow toggle, none of which the old shape could offer.
