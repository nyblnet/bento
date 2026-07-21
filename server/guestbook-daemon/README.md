# bento-guestbook-daemon

The sustainable home of the public guestbook (see `working/guestbook-design.md`):
a Cloudflare Worker that serves the current epoch from Workers KV, archives the live
room daily (read-only CRDT replay), and rolls epochs with fresh credentials.

## One-time setup

```bash
cd server/guestbook-daemon
npx wrangler kv namespace create STORE   # paste the id into wrangler.toml
openssl rand -hex 24 | npx wrangler secret put ADMIN_KEY   # keep a copy
npx wrangler deploy
```

DNS: the `bento.page` apex record must be **proxied** (orange cloud) for the
`bento.page/guestbook.bento.html` route to shadow GitHub Pages. Until then,
the worker is still reachable on its workers.dev URL (admin + cron work).

## Arming / operating

```bash
# seed the current epoch (built locally by scripts/build-guestbook.mjs)
curl -X PUT https://bento.page/guestbook-admin/seed \
  -H "Authorization: Bearer $ADMIN_KEY" \
  --data-binary @../../working/guestbook-live/guestbook.bento.html

curl -H "Authorization: Bearer $ADMIN_KEY" https://bento.page/guestbook-admin/status
curl -X POST -H "Authorization: Bearer $ADMIN_KEY" https://bento.page/guestbook-admin/snapshot
curl -X POST -H "Authorization: Bearer $ADMIN_KEY" https://bento.page/guestbook-admin/roll
curl -X POST -H "Authorization: Bearer $ADMIN_KEY" https://bento.page/guestbook-admin/kill
```

- **snapshot** — join the room read-only, archive real content to KV
  `archives/` (pruned to the newest 90). Runs daily at 01:00 UTC via cron regardless.
- **roll** — snapshot, then mint epoch N+1 with fresh room+key and a fresh
  shell fetched from the live release. Old room orphans instantly.
  Automatic cadence: set `ROLL_HOURS` in wrangler.toml (0 = manual).
- **kill** — serve a redirect to /404.html instead of the file. Un-kill by
  seeding or rolling.

## Notes

- The CRDT engine is bundled from `slides/src/sync/crdt.ts`; the deck
  definition is shared with the local builder via `scripts/guestbook-deck.mjs`.
  Epoch fonts carry forward from the previous epoch's embedded assets.
- The daemon holds the room key — as does everyone with the file. The
  guestbook's key is public by design; this is no privacy regression.
- The static copy in the bento-site repo remains as a fallback for when KV
  is empty and as the pre-proxy path. After the route is live, the daemon's
  KV copy is authoritative.
- Local dev: `npx wrangler dev --port 8788` (+ `.dev.vars` with ADMIN_KEY).
  Never pipe wrangler dev output through `head` (SIGPIPE kills it).
