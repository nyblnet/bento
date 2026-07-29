# Contributing to Bento

Thanks for being here. Bento is "the office suite that fits in a file" — a
single self-contained HTML document that is also its own viewer, presenter, and
editor. Contributions of all sizes are welcome: bug reports, docs fixes,
templates, and code.

## Getting set up

If you are using a Node version manager like [fnm](https://github.com/Schniz/fnm), you can do:

```bash
fnm use
```
This should bring in the right version of Node.js and npm. Alternatively, you can install **Node 20+** and npm (the build uses Vite 7).
There is no backend to run and no account to create — the whole app builds to one HTML file.

```bash
git clone https://github.com/nyblnet/bento.git
cd bento/slides
npm install
npm run dev            # dev server at http://localhost:5173
```

The current app lives in `slides/`. Common commands (run from `slides/`):

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server with hot reload. |
| `npm run build:single` | Produces the shippable `dist-single/Bento_Slides.bento.html` — one file with the runtime, editor, and an empty document block. |
| `node ../scripts/test-sync.ts` | The CRDT convergence rig. Run it after **any** change to `slides/src/sync/crdt.ts`; it has caught many ordering bugs. `SEEDS`, `STEPS`, and `ACTORS` env vars tune the fuzzing. |

## Where things live

- `slides/src/model.ts` — the `bento/slides` JSON document model. **This is the
  format.**
- `slides/src/render.ts` — the single model→DOM renderer shared by the editor
  canvas, thumbnails, present mode, and print.
- `slides/src/editor/` — the vanilla-TypeScript editor (Moveable + Selecto).
- `slides/src/sync/` — the in-house CRDT and the E2EE relay transport.
- `server/sync-worker/` — the blind Cloudflare Worker relay (ciphertext only).
- `scripts/` — build, release, and gallery tooling.
- `docs/` — architecture, the `bento/slides` [format spec](docs/format.md),
  collaboration design, the AI agent guide, and releasing (index in
  [docs/README.md](docs/README.md)).

Two documents are the source of truth for how the codebase fits together, and
they go deep — **read them before a non-trivial change**:

- [CLAUDE.md](CLAUDE.md) — the architecture + development guide, module by
  module, with the hard-won gotchas that must not regress.
- [docs/architecture.md](docs/architecture.md) — the on-disk file format, the
  self-save loop, and the runtime layout.

## Coding conventions

- **Vanilla TypeScript, no framework.** The editor is hand-written DOM. Match
  the surrounding style rather than introducing new patterns or dependencies.
- **Earn every dependency.** Bento replaced GSAP, ECharts, and Yjs with small
  in-house engines shaped to its needs, because the whole runtime has to fit in
  a ~400 KB shell that travels inside every document. New runtime dependencies
  are a hard sell — bring numbers.
- **The format is additive and stable.** `bento/slides` JSON is the interchange
  contract: old files must open in newer shells, and unknown fields are
  preserved through parse → serialize. Add optional fields; never repurpose or
  remove one. Element `id`s are identity (morphs, states, and links all key off
  them) — keep them stable and deterministic.
- **Keep the document pure data.** Text HTML is sanitized and chart options are
  pure JSON (no functions) so a document can never smuggle executable code
  through the model. Don't add a path for code to ride in the format.

## The single-file build & the splice contract

`npm run build:single` inlines and compresses all JS + CSS into one HTML shell.
The document lives in a **plaintext** `<script id="bento-doc">` block near the
top of the file, and everything downstream depends on that block staying
spliceable:

- The block JSON escapes every `<` as `<`, so a literal `</script>` can
  never terminate it.
- The runtime source never contains a literal script-close tag (the one place
  that needs it builds it by string concatenation).
- On save, the app clones the pristine shell captured at boot, swaps the data
  block, and rewrites the file — so an old file always opens with its own pinned
  runtime, and outside tooling (and AI agents) can always find and edit the JSON.

If you touch the boot, save, or build path, keep these invariants intact — the
release process gates on them. The details are in
[docs/architecture.md](docs/architecture.md).

## Before you build something substantial

**Check what's already in flight, and claim it.** Bento moves fast and several
things are usually half-built at once — twice now, contributors have written
thousands of lines that duplicated work already open as a PR. That is our
fault, not theirs, so:

1. Skim [open pull requests](https://github.com/nyblnet/bento/pulls) and the
   pinned **What's in flight** issue.
2. For anything beyond a small fix, open an issue (or a
   [Discussion](https://github.com/nyblnet/bento/discussions) under *Ideas*)
   saying what you plan to do, before you write it. A maintainer will tell you
   quickly if it clashes with something unreleased or with a platform
   invariant.

That second step matters most for changes that touch
[docs/PLATFORM.md](docs/PLATFORM.md) §1–2 — the single-file promise and the
splice contract. Those are the two rules the project will not bend, and a
change that breaks them cannot be merged however good the code is.

## AI-assisted contributions

They're welcome — the maintainer uses AI on this repo too. Two conditions:

- **You have read and understood what you're submitting**, and you can answer
  questions about it. Review it as if you had written every line, because as
  far as the project is concerned, you did.
- **Commits are authored under your own name**, not a bot identity.

An AI will happily produce something locally coherent that violates a rule
stated plainly in `docs/PLATFORM.md`. Checking your change against that file is
worth more than any amount of polish.

## Pull requests

- Branch off `main` and keep PRs focused — one concern per PR is easier to
  review than a grab-bag.
- Describe **what** changed and **why**, and how you verified it. For anything
  touching the editor canvas, note that synthetic pointer events don't drive
  Moveable/Selecto — real-mouse QA is expected (see the testing notes in
  CLAUDE.md).
- Run `npm run build:single` and, for CRDT changes, `node scripts/test-sync.ts`
  before opening the PR.
- New user-facing UI strings must be added to **all** locale catalogs under
  `slides/src/i18n/` (English is the key; missing keys fall back to English).
- Please don't bump the version or cut releases in a PR — releases are signed
  and cut locally by a maintainer (see [docs/RELEASING.md](docs/RELEASING.md)).

## Questions, bugs & ideas

- **Questions and help** — [Discussions →
  Q&A](https://github.com/nyblnet/bento/discussions/categories/q-a). Answers
  there are searchable and help the next person with the same question.
- **Ideas and feature requests** — [Discussions →
  Ideas](https://github.com/nyblnet/bento/discussions/categories/ideas).
- **Bugs** — open a GitHub issue. Include your browser and OS, what you
  expected, what happened, and — when you can — a minimal `.bento.html` that
  reproduces it.

Security issues are different: please **do not** open a public issue. Follow
[SECURITY.md](SECURITY.md) instead.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
