# bento/dash

A spreadsheet where **one HTML file is the whole workbook**: the grid, the
formulas, the charts built from them, the viewer, and the editor.

## Status: in development. Not released.

**This directory is a construction site, not a product.** `bento/dash` has no
release and nothing published on [bento.page](https://bento.page). A file you
build from this source is an unsigned local build, and the document format is
still settling — formula coverage, pivots and conditional formatting are all
incomplete by design at this stage.

The shell does check `bento.page/releases/dash/` for updates, and there is
nothing there today. That is worth knowing in both directions: no local build
updates itself now, and when dash does ship, a file built today would offer the
real release to itself — the signature and version checks are the same ones
every shipped bento file uses.

Its entry in the release registry (`scripts/apps.mjs`) exists so the channel is
ready when it ships; it does not mean it has shipped. No release date. If you
want the shipped products, they are `slides/` and `spaces/`.

## Run it

```sh
cd dash
npm install
npm run dev
npm run build:single   # a local build; not a release
```

## Working here

`dash/` is this app's ownership zone. Read `AGENTS.md`, `docs/PLATFORM.md` and
`docs/PARALLEL-WORK.md` first; `kernel/` is a separate, serialized zone, and
`docs/dash-collab.md` carries this app's sync design. Correctness here is
arithmetic, not rendering: a formula or pivot change needs cases, not a
screenshot.
