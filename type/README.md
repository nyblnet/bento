# bento/type

A word processor where **one HTML file is the whole document**: the text, the
pages it flows into, the reader, and the editor. Same bargain as the rest of
bento — no account, no server, no sidecar folder.

## Status: in development. Not released.

**This directory is a construction site, not a product.** `bento/type` has no
release, no version on [bento.page](https://bento.page), and no entry in the
release registry (`scripts/apps.mjs`). A file you build from this source is an
unsigned local build: its shell looks for updates at `bento.page/releases/type/`,
where nothing is published and nothing is planned yet. Pagination, styles,
citations and math are all still moving, and the document format may change in
ways that do not migrate.

It is developed in the open because the apps share one tree and one kernel, not
because it is ready. There is no release date, and issues about missing or rough
behaviour here are expected rather than useful. If you want the shipped product,
that is `slides/` — and `spaces/`.

## Run it

```sh
cd type
npm install
npm run dev
npm run build:single   # a local build; not a release
```

## Working here

`type/` is this app's ownership zone. Read `AGENTS.md`, `docs/PLATFORM.md` and
`docs/PARALLEL-WORK.md` first; `kernel/` is a separate, serialized zone. The
format is additive and permanent from the moment anything ships — until then it
is still being settled, which is the one freedom this stage buys.
