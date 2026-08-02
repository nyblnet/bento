# Releasing bento/slides

Releases are cut **locally** — the signing key never leaves the maintainer's
machine, and the signed bytes are exactly the served bytes (no CI rebuild can
drift from the manifest hash). Shipped files check
`https://bento.page/releases/slides/manifest.json` (user-initiated only) and
verify the manifest signature against the public key embedded in every shell.

## One-time setup

1. **Signing key** (already done): `node scripts/keygen.mjs` →
   `~/.bento/release-key.json`. Keep an offline backup (password manager or
   printed). Losing it orphans the update channel for every shipped file;
   leaking it hands the update channel to an attacker. Never commit it, never
   put it in CI secrets.
2. **Two repos** (GitHub Pages needs a public repo on the free plan; source
   stays private until launch): private `nyblnet/bento` (this repo, `main`
   only) + public `nyblnet/bento-site` (the published site — a sibling clone
   at `../bento-site`, deployed by Pages from its `main` branch, root). The
   `CNAME` file in the site sets the custom domain; after the certificate is
   issued, tick *Enforce HTTPS* (mandatory for `.page` anyway). Release
   artifacts never enter the source repo's history.
3. **DNS at the registrar** for the apex `bento.page`:
   - `A` records → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - `AAAA` records → `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`
   - Optional `www` `CNAME` → `<user>.github.io`
4. **Verify the domain on GitHub** (Settings → Pages → Verified domains: add
   the `_github-pages-challenge-<user>` TXT record it gives you). This
   prevents Pages domain takeover if the site is ever unconfigured.

## Cutting a release

0. **Get the CHANGELOG right first — it is not just prose any more.** The
   first FIVE bold lead-ins of the version's section become the `notes` in the
   SIGNED manifest, which shipped files show inline in the About dialog while
   the reader decides whether to update. So:
   - lead with what the release IS (features), not the last thing merged —
     entries otherwise sit in merge order and a stray fix ends up introducing
     the release;
   - write lead-ins that carry information on their own, since in the dialog
     the lead-in is ALL the reader gets;
   - drop entries for bugs introduced AND fixed inside the same unreleased
     cycle. Check with `git merge-base --is-ancestor <fix-commit> <last-tag>`:
     if the bug never shipped, announcing it tells people about breakage they
     never had. The commit history is the record for those.

1. Bump `slides/package.json` version (this becomes `APP_VERSION` in the
   shell and the manifest version — single source of truth).
2. Land it and tag. `main` is branch-protected and requires a pull request, so
   the bump CANNOT be committed directly — open a small PR for it, merge, then
   tag the merge commit:

   ```sh
   git tag vX.Y.Z <merge-sha>
   ```

   **Build from a clean checkout of that tag**, not from whatever the main
   working tree happens to be on. Several sessions may have their own branches
   and uncommitted work there, and `git checkout <tag> -- .` in the wrong tree
   is destructive:

   ```sh
   git worktree add /tmp/rel vX.Y.Z --detach
   ```
3. **Push the tag now, before publishing.** The GitHub release is created *for*
   a tag, so the tag must exist on the remote before step 5 can run — publishing
   first leaves the site live with no release, which is what happened cutting
   v1.0.12:

   ```sh
   git push origin vX.Y.Z
   ```

   Do NOT use `git push origin main --tags`: it also pushes every local tag,
   including scratch ones (a `backup/…` tag from a history rewrite escaped this
   way and had to be deleted from the remote).

4. `node scripts/release.mjs` — builds, signs, assembles `./site/`
   (CNAME, landing page, live demo, download, signed manifest, language packs
   + their signed index).
5. Publish `./site/` to the public site repo — one step:

   ```sh
   node scripts/publish-site.mjs "release vX.Y.Z"
   ```

   **From a `/tmp` build worktree, set the destination explicitly.** The script
   resolves `../bento-site` relative to the repo root, so from `/tmp/rel` it
   looks for `/private/tmp/bento-site` and stops:

   ```sh
   BENTO_SITE_DIR=~/devel/bento-site node scripts/publish-site.mjs "release vX.Y.Z"
   ```

   This mirrors the assembled `site/` tree into `../bento-site` (or
   `$BENTO_SITE_DIR`) and pushes it. **`site/` is fully generated — never edit
   it by hand.** The authored sources are tracked in *this* repo and assembled
   into `site/` by `release.mjs`:
   - `site-src/` — the landing (`landing.html`), guestbook, 404 and QR pages.
   - `scripts/build-example-decks.mjs` + `scripts/gallery-photos/` — the gallery.

   So a content-only change is: edit `site-src/` (or the deck scripts) → rebuild
   → publish. For a copy tweak without cutting a new app version you can rebuild
   just the landing and publish in one go:

   ```sh
   node scripts/build-landing.mjs site/index.html
   node scripts/publish-site.mjs "landing: copy tweak"        # add --gallery to regen decks
   ```

   Preview any publish first with `--dry`. `publish-site.mjs` also re-seeds the
   live **guestbook daemon** onto the freshly-published shell as a best-effort
   final step (see below) — no separate command needed.

   > **Publish site-only changes from a tree whose `site/releases/` is current.**
   > `site/` is local staging, and releases are assembled from a clean checkout
   > of the tag (step 3) — so an everyday working tree can hold a months-old
   > manifest while bento.page serves something far newer. Mirroring that would
   > republish the older signed shell over the newer one and break the update
   > channel for every deck already in the world.
   >
   > `publish-site.mjs` refuses this: it compares the staged manifest version
   > against the live one and dies if the staged one is older. If you hit that,
   > you are publishing from the wrong tree — use the release checkout, or
   > refresh `site/releases/` from the live site first. `--allow-release-downgrade`
   > exists only for a deliberate rollback.

6. **The GitHub release is created for you** by `publish-site.mjs` — it makes
   the release for the tag, attaches
   `site/releases/slides/Bento_Slides.bento.html`, and takes the notes from
   this version's CHANGELOG section (so the two can't drift). It is idempotent:
   an existing release is left alone and only a missing asset is uploaded, so
   re-running publish is safe.

   It is deliberately **not** best-effort. If `gh` is unauthenticated, or the
   asset is missing afterwards, publish exits non-zero and tells you the exact
   command to run. This used to be a manual step, and it was silently missed
   for v1.0.10 — the site was live and self-updating while the repo showed no
   release at all. Documentation didn't prevent that, so the check now does.
7. **Verify against the LIVE channel, not the local build.** These are the
   things no local gate can prove, and some are only exercisable once published:

   ```sh
   curl -s https://bento.page/releases/slides/manifest.json | head -c 200
   curl -s -o /dev/null -w '%{http_code}\n' https://bento.page/releases/slides/packs.json
   gh release view vX.Y.Z --json body --jq '.body | length'
   ```

   - the served shell's sha256 matches the manifest AND the artifact you
     actually tested — re-verify rather than assuming the rebuild is identical;
   - **the language-pack channel answers 200**. It is easy to publish a release
     whose packs never made it; the channel 404s silently and "Manage
     languages…" just shows nothing to add;
   - **the GitHub release page shows the CHANGELOG entries**, not just the
     download intro. `publish-site.mjs` now dies rather than degrading to a
     bare pointer, but the release is what people arriving from the repo read,
     and v1.0.11 published with only its two-line intro while every release
     before it carried its entries — nobody noticed until a reader compared the
     two pages. A body under ~1KB means the notes are missing; recover with
     `gh release edit vX.Y.Z --notes-file <notes>`;
   - open the PREVIOUS version's file → About → Check for updates. It should
     offer the new version, show the inline notes, and the downloaded copy must
     boot with the document intact.

## Language packs

`release.mjs` also emits every non-core language pack
(`scripts/build-i18n.mjs --packs`) into `site/releases/slides/packs/` and signs
an INDEX over them at `site/releases/slides/packs.json`
(`scripts/sign-packs.mjs`) — same envelope, same offline key and the same
signing code as the manifest (`scripts/sign-payload.mjs`). The index pins each
pack's sha256; shipped files verify the index signature once and then hash each
downloaded pack against it. Design and payload shape: `docs/i18n-packs.md`.

Both steps are no-ops until a pack catalog exists, so nothing changes for a
release with no packs.

Preview what would be signed, without the key and without writing anything:

```sh
node scripts/build-i18n.mjs --packs /tmp/packs
node scripts/sign-packs.mjs /tmp/packs --dry     # prints the exact payload
```

Re-publishing packs **without cutting an app release** is supported and is the
reason the index is its own artifact (a corrected translation is not a new app
version). Re-emit, re-sign the index, publish:

```sh
node scripts/sign-packs.mjs site/releases/slides/packs \
  --out site/releases/slides/packs.json --version <app version>
node scripts/publish-site.mjs "packs: fix the Korean plural forms"
```

`publish-site.mjs` refuses to push if any published pack does not match its
signed hash, if an indexed pack is missing, or if packs are staged with no
index at all — an unsigned pack must never reach the CDN.

**Between releases, re-emit only the packs you mean to change.** Packs are keyed
on the ENGLISH SOURCE STRING, so a pack rebuilt from `main` is keyed to `main` —
not to the shell people are actually running. Rename a UI string after a release
and every rebuilt pack silently swaps the old key for the new one, while the
shipped shell still asks for the old. The pack verifies, installs, and drops
that string to English in every language at once.

This is not hypothetical: adding Turkmen on 2026-08-01 rebuilt all 22 packs, and
the diff against the published set was exactly one key per pack — `#168` had
renamed "restore earlier versions from **About** → Version history" to
"**Save** → Version history". Publishing the rebuilt set would have regressed
that string across 21 languages in exchange for adding one.

So the safe republish is surgical: copy in only the pack(s) that changed, leave
the rest byte-identical, and re-sign the index over all of them (the index pins
each pack's own sha256, so a mixed set is fine). Confirm it before pushing:

```sh
node scripts/publish-site.mjs --dry "packs: …"   # change set must be ONLY what you intend
```

Check which key the LIVE shell actually uses before assuming a rename is safe —
inflate the `bento-rt` payload of the published shell and grep for the string.
A pack added this way carries the newer key and lacks the older one, so its own
first release shows that one string in English until the shell catches up. That
is the right trade for a NEW language and the wrong one for an existing pack.

### Testing the pack UI locally

Point a shell at a local pack channel with the `bento-packs-url` localStorage
override — but the local server must be **the same origin as the page**, because
the pack fetch is a cross-origin XHR and `python -m http.server` sends no CORS
headers. Serving the shell on one port and the packs on another silently yields
"Nothing new right now" rather than an error, so it reads exactly like a working
build with nothing to install. Serve both from one directory tree:

```sh
node scripts/build-i18n.mjs --packs /tmp/site/packs
cp slides/dist-single/Bento_Slides.bento.html /tmp/site/
```

Then open the shell from that server and set the override to the same origin.

### Adding a UI string

New strings go in ALL core catalogs (`slides/src/i18n/*.ts`), and
`slides/src/i18n/packed.ts` is GENERATED — regenerate it or CI fails:

```sh
node scripts/build-i18n.mjs
```

## Rules

- Never edit files on `gh-pages` by hand — the manifest signature covers the
  shell's exact bytes; any drift bricks the update check (integrity refusal).
  The same holds for `packs.json` and everything under `packs/`.
- Version only goes up. Shipped files refuse manifests that aren't strictly
  newer than themselves (downgrade-replay protection), so a "rollback" is a
  new higher version that reverts the code.
- The update channel ships **signed code**; future sync/collab channels ship
  **inert data**. Never blur the two.

## Deploying the sync relay (one-time + on worker changes)

The relay (`server/sync-worker/`) is separate from the static site — it
lives on Cloudflare Workers and only needs redeploying when its code
changes (client releases do NOT require it):

```sh
cd server/sync-worker
npx wrangler login          # one-time, opens the browser
npx wrangler deploy         # builds + publishes; prints the workers.dev URL
```

`wrangler.toml` requests the custom domain `sync.bento.page` — with the
zone on the same Cloudflare account this is provisioned automatically at
deploy (DNS + cert). Verify with:

```sh
curl https://sync.bento.page/        # → "bento-sync relay — see https://bento.page"
```

Local development: `npx wrangler dev --port 8787` (no account needed), and
in the editor set `localStorage['bento-sync-url'] = 'ws://localhost:8787'`
before starting a share session.

The relay stores ONLY ciphertext (room-key-encrypted frames) and a hash of
the room key; there are no secrets to manage server-side. Rooms self-delete
after ~30 idle days — the file is the durable artifact.

## The guestbook daemon and the shell (why the guestbook can lag)

`bento.page/guestbook.bento.html` is **NOT served from the static site** — a
separate Cloudflare daemon (`server/guestbook-daemon/`) serves it from KV so it
can archive/roll epochs. `release.mjs` re-shells the *static*
`site/guestbook.bento.html` (only the KV-empty fallback), so a shell release does
**not** by itself update what visitors see — the daemon keeps serving the deck in
its KV until it's re-seeded. (Tell: the plain URL shows an old app-hash while
`?cb=1` — GitHub Pages — shows the new one.)

`scripts/reseed-guestbook.mjs` closes the gap and `publish-site.mjs` runs it
automatically after every push:

- It fetches the daemon's **own** current deck, so the live room + walls are
  preserved (the walls live in the relay room; the KV deck only carries the
  shell + creds), re-shells that doc onto the fresh shell, and `PUT`s it back
  through the daemon's maintainer-only admin endpoint.
- Idempotent — a no-op when the daemon already serves the current shell.
- Best-effort — needs the maintainer's local admin bearer token (kept in a
  gitignored working file, never committed); a missing token or unreachable
  daemon is a warning, never a failed publish. Run it by hand any time with
  `node scripts/reseed-guestbook.mjs` (`--dry` to preview).

An epoch **roll** (fresh room + blank walls) is a separate, deliberate
maintainer action (`build-guestbook.mjs` locally, or the daemon's admin roll
endpoint) — re-seeding never rolls.
