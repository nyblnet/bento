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
2. **GitHub repo + Pages**: push this repo, then Settings → Pages → deploy
   from the `gh-pages` branch (root). Set custom domain `bento.page`,
   tick *Enforce HTTPS* (mandatory for `.page` anyway).
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
4. Publish `./site/` to the `gh-pages` branch:

   ```sh
   git worktree add /tmp/bento-pages gh-pages   # first time: git worktree add --orphan -b gh-pages /tmp/bento-pages
   rm -rf /tmp/bento-pages/*
   cp -R site/* /tmp/bento-pages/
   git -C /tmp/bento-pages add -A
   git -C /tmp/bento-pages commit -m "release vX.Y.Z"
   git push origin gh-pages
   git worktree remove /tmp/bento-pages
   ```

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
