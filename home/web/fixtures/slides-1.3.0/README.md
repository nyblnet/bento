# slides 1.3.0, as released

Frozen bytes of the published bento/slides 1.3.0 shell and the signed release
history that names it, fetched from the release channel on 2026-11-23:

- `Bento_Slides.bento.html`: sha256
  `130e97249792e3b22ef2e6fd4b645fc111e89b7a1c4b34dc140255021f7b3e8c`, the
  hash its signed manifest pins.
- `history.json`: the signed history (release key), 1.3.0 newest.

The first released shell that speaks the document store over a port
(kernel/src/docstore.ts), so a library open of it keeps a recovery copy. Used
by scripts/test-home-web-writeback.mjs. Never edit these bytes: a rig that
needs a variant builds it from them in its own scratch directory.
