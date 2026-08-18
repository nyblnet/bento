# bento-guestbook-daemon

The sustainable home of the public guestbook (see `working/guestbook-design.md`):
a Cloudflare Worker that serves the current epoch from Workers KV, archives the live
room on a cron (read-only CRDT replay), and rolls epochs with fresh credentials.
Deployed cadence today is every 30 minutes for both — see *Deployed cadence* below.

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
  `archives/` (pruned to the newest 90). The cron fires it on every run.
- **roll** — snapshot, then mint epoch N+1 with fresh room+key and a fresh
  shell fetched from the live release. Old room orphans instantly.
  Automatic cadence: set `ROLL_HOURS` in wrangler.toml (0 = manual).
- **kill** — serve a redirect to /404.html instead of the file. Un-kill by
  seeding or rolling.

## Deployed cadence

**Not the daily one this file used to describe.** The launch-phase settings in
wrangler.toml are `crons = ["*/30 * * * *"]` and `ROLL_HOURS = "0.5"`: snapshot
*and* roll every 30 minutes, so the room time-shards under load and spam clears
itself. Rolls happen at CRON GRANULARITY — the scheduled handler rolls on the
first tick where `now - lastRoll >= ROLL_HOURS` (worker.js `scheduled`), so a
value *larger* than the cron interval works fine and just rounds up to a tick;
what buys nothing is a value BELOW the interval (0.25 with a 30-min cron still
rolls every 30 min). Consequence while this is on: every roll mints a new epoch
with new owner credentials, which ORPHANS the locally held owner deck in
`working/guestbook-live/` — so People→Remove moderation is unavailable until
the cadence goes back to `ROLL_HOURS = "0"` and a v2 owner-moderated epoch is
re-armed locally (`scripts/build-guestbook.mjs` + seed).

wrangler.toml is the single source of truth for the cadence; CLAUDE.md and
`scripts/build-guestbook.mjs` point here rather than restating it, because for a
while they said "manual rolls" and the deployed worker did not.

## Notes

- The CRDT engine is bundled from `slides/src/sync/crdt.ts`; the deck
  definition is shared with the local builder via `scripts/guestbook-deck.mjs`.
  Epoch fonts carry forward from the previous epoch's embedded assets.
- The daemon holds the room key — as does everyone with the file. The
  guestbook's key is public by design; this is no privacy regression.
- `ORIGIN_FALLBACK` (the "static copy in the bento-site repo" this file used to
  promise) is DEAD as a fallback. The mirror dropped `guestbook.bento.html` in
  v1.0.12 and publish-site.mjs keeps it out of ordinary publishes, and the
  mirror's `CNAME bento.page` makes Pages 301 the fallback URL straight back to
  `bento.page/guestbook.bento.html` — this worker's own route. An empty KV is
  therefore an outage, not a degraded mode: re-seed. Details in wrangler.toml
  beside the var.
- Local dev: `npx wrangler dev --port 8788` (+ `.dev.vars` with ADMIN_KEY).
  Never pipe wrangler dev output through `head` (SIGPIPE kills it).
