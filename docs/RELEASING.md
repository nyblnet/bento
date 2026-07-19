# Releasing Bento Slides

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

1. Bump `slides/package.json` version (this becomes `APP_VERSION` in the
   shell and the manifest version — single source of truth).
2. Commit, tag: `git tag vX.Y.Z`.
3. `node scripts/release.mjs` — builds, signs, assembles `./site/`
   (CNAME, landing page, live demo, download, signed manifest).
4. Publish `./site/` to the public site repo — one step:

   ```sh
   node scripts/publish-site.mjs "release vX.Y.Z"
   ```

   This mirrors the assembled `site/` tree into `../bento-site` (or
   `$BENTO_SITE_DIR`) and pushes it. `site/` is the single source of truth: its
   **authored** files (landing `index.html`, the guestbook page, `agents.md`,
   config) are tracked in *this* repo so cross-session drift is visible in git;
   its **generated** artifacts (signed shell, manifest, gallery decks,
   `*.bento.html` demos) are gitignored here and rebuilt by `release.mjs`.
   For a content-only change (no new app version) you can regenerate the gallery
   and publish without cutting a release: `node scripts/publish-site.mjs
   "landing copy tweak" --gallery`. Preview first with `--dry`.

5. Also attach `site/releases/slides/Bento_Slides.bento.html` to a GitHub
   Release for the tag — download counts, release-watch notifications, and a
   permanent per-version archive.
6. Sanity check: open the PREVIOUS version's file, About (topbar logo) →
   Check for updates → should offer the new version, and the downloaded copy
   must boot with the document intact.

## Rules

- Never edit files on `gh-pages` by hand — the manifest signature covers the
  shell's exact bytes; any drift bricks the update check (integrity refusal).
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
