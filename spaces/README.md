# bento/spaces

A notes/wiki app where **one HTML file is a whole space**: a tree of pages, the
reader that displays them, and the editor that writes them. No account, no
server, no sidecar folder — you can mail it, and the person who receives it can
read and edit it with nothing installed.

Agents: `docs/spaces-agents.md` is the working guide (published at
`bento.page/spaces/agents.md`). Before changing anything here read `AGENTS.md`,
`docs/PLATFORM.md` and `docs/PARALLEL-WORK.md`. `spaces/` is this app's
ownership zone; `kernel/` is not — kernel changes are serialized.

## Run it

```sh
cd spaces
npm install
npm run dev            # dev server (port 5196 via .claude/launch.json)
npm run build:single   # → dist-single/Bento_Spaces.bento.html (the product)
```

## The format

`bento/spaces` version 1. Additive and permanent: every future version opens
files this one wrote, and unknown fields survive a round trip untouched. There
is no server to migrate a file that someone has had on a disk for three years.

```jsonc
{
  "format": "bento/spaces", "version": 1,
  "docId": "…",                     // minted once, never regenerated
  "home": "p-intro",
  "pages": [                        // FLAT, pre-order; nesting is `parent`
    { "id": "p-intro", "title": "Introduction", "icon": "…",
      "blocks": [                   // FLAT, pre-order; nesting is `parent`
        { "id": "b1", "type": "p", "html": "Hello <b>world</b>." }
      ] }
  ]
}
```

Three decisions worth knowing before editing the model:

- **Both arrays are flat and in pre-order.** A child always follows its parent,
  so one forward pass rebuilds the tree. Nested arrays would make every
  operation recursive and every CRDT node ambiguous.
- **Block properties are flat on the block** (`done`, `open`, `src`, `lang`),
  not inside a `props` object. `type` is an open string: an unrecognised type
  round-trips and falls back to rendering its `html`.
- **`html` is inline-only** — `b i u s em strong code a span mark sub sup br`.
  Block structure is `type`, never markup. `src/sanitize.ts` unwraps anything
  else at load, and matches `href` against `getAttribute('href')` rather than
  `.href`, because the resolved property hides `javascript:` behind a base URL.

A `code` block's `html` is its source as **plain text**, html-escaped. Syntax
colour is applied when the page is drawn (`src/highlight.ts` → `paintCode` in
`src/render.ts`) and never enters the document, so the same block is the same
bytes whether or not the reading build knows the language — and an unknown
`lang` is preserved verbatim rather than normalised away.

Ids are unique across the whole document and are never reused — links,
backlinks and future collaboration key on them. A duplicate is repaired
deterministically **from the bytes** (`repairId`), so two readers of one file
always agree on every id. `scripts/test-spaces-model.ts` pins that, plus the
load contract and format additivity.

## The parts

| File | What it owns |
|---|---|
| `src/model.ts` | the format, `buildIndex()` (tree, backlinks), id repair |
| `src/sanitize.ts` | the inline allowlist — the only thing between a file someone mailed you and script execution |
| `src/store.ts` | undo, and the **typing run** |
| `src/calc.ts` | magic notes — the evaluator behind a line ending in `=`. No eval, ever |
| `src/render.ts` | model → DOM, shared by the editor, reading view and print |
| `src/highlight.ts` | the code lexer — text → `{kind, a, b}` ranges, no DOM, no strings |
| `src/markdown.ts` | markdown → blocks, the folder tree → the page tree, `[[wikilinks]]` → `#p/` links. Pure and DOM-free, so the import is tested in node |
| `src/editor.ts` | topbar, sidebar, block menu, `[[` picker, ⌘K, ⌘F, archive |
| `src/agent.ts` | the agent surface — `validate()`, `outline()`, `stats()`, and the patch verbs behind `window.bento` |
| `src/assets.ts` | content-addressed images and the downscale |
| `src/about.ts` | updates, language, password, exports |
| `src/i18n/` | per-locale catalogs; `packed.ts` is generated and is what ships |

### The typing run

Slides sidesteps commit granularity because canvas text commits on blur. A
notes app may never blur — so a **run** is consecutive input in one block with
no structural op between. It takes one checkpoint at its first input and
mutates in place after that. It closes on idle, on the caret leaving the block,
on any structural change, on save, and on `replaceDoc`.

One run = one undo entry = later, one collaboration text batch. This single
policy sets undo granularity, autosave churn, the dirty flag and the future op
rate, which is why it lives in the store rather than in the editor.

### Getting notes in

Drop a folder of `.md` files on the window, or use Pages → import. Each file
becomes a page, folders become the page tree, and `[[wikilinks]]` are resolved
**after every page exists**, by file name first and page title second — a
target outside the import stays as the literal `[[Name]]` rather than silently
un-linking. The parse (`src/markdown.ts`) is pure and DOM-free; the browser
half (`editor.ts importFiles`) reads image bytes, runs `sanitizeInline` over
every block, and commits the whole import in ONE step. Frontmatter is kept
verbatim in a marked block — the reasoning is in `docs/DECISIONS.md`.

An image referenced by a relative path is resolved against the files that were
actually selected; when it is not there, the block becomes text quoting the
path, because a browser cannot open `../attachments/x.png` and a broken `<img>`
would be a lie about what is in the file.

### Links are fragments

`#p/<id>`, and navigation is `history.pushState(null, '', '#p/id')`. Measured:
from a `file://` opaque origin, `pushState` with a **fragment** is legal while
`pushState` with a **path** throws `SecurityError`. That is the whole reason
pages are one document rather than one file each.

## Platform guarantees this app honours

- **Splice contract** — `#bento-doc` stays plaintext with a stable id; the file
  survives DOMParser → splice → `outerHTML`. Gated by
  `node scripts/shell-gate.mjs spaces/dist-single/Bento_Spaces.bento.html`, the
  same check the release runs before signing.
- **No network to open, edit, read or save.** Updates are the only fetch, and
  they are opt-out.
- **Autosave + recovery** in a per-app IndexedDB database (`bento-spaces-…`);
  encrypted spaces are never snapshotted to disk in plaintext.
- **Signed self-update** against `releases/spaces/manifest.json`, with this
  app's own release notes (`spaces/CHANGELOG.md` — never another app's).
- **i18n** with English strings as keys; `scripts/build-spaces-i18n.mjs
  --check` fails the build if the packed table is stale or a core catalog is
  incomplete, because a catalog ships inside every saved file and cannot be
  corrected without a release.

## Not built yet

- **Collaboration.** No CRDT wiring. The sync engine is slides-shaped
  (composite `slideId ␟ elementId` node keys); spaces needs `pageId ␟ blockId`
  and a token RGA over `html`, which is the same shape — but genericizing it is
  its own project, and PLATFORM §10 permits shipping without collab rather than
  with a half-secure version.
- **Tables, embeds, and databases.** Deliberate: the format is permanent, so a
  block type ships when its model is right, not when its UI is ready.
