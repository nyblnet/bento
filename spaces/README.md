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
| `src/journal.ts` | daily notes — the date is `page.journal`, never the title |
| `src/calc.ts` | magic notes — the evaluator behind a line ending in `=`. No eval, ever |
| `src/render.ts` | model → DOM, shared by the editor, reading view and print |
| `src/highlight.ts` | the code lexer — text → `{kind, a, b}` ranges, no DOM, no strings |
| `src/markdown.ts` | markdown → blocks, the folder tree → the page tree, `[[wikilinks]]` → `#p/` links. Pure and DOM-free, so the import is tested in node |
| `src/editor.ts` | topbar, sidebar, block menu, `[[` picker, ⌘K, ⌘F, archive |
| `src/props.ts` | the right-hand properties panel — what a block and a page can be, and the one thing it must not cost: the page's width |
| `src/collabui.ts` | who else is here — presence in the tree, the people panel, the live control |
| `src/comments.ts` | review threads — markers in the end margin, the thread popover, the tree badge |
| `src/sync/session.ts` | the five answers the kernel cannot work out: what "empty" means, where a reader lands, what presence reports |
| `src/agent.ts` | the agent surface — `validate()`, `outline()`, `stats()`, and the patch verbs behind `window.bento` |
| `src/assets.ts` | content-addressed images and clips, and the image downscale |
| `src/assets.ts` | content-addressed images and the downscale |
| `src/portable.ts` | the two exits: a page out as its own space, another space in under a page |
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

### Getting notes out again, and back in

`src/portable.ts` is both exits, pure and DOM-free like `markdown.ts`, so the
round trip is asserted in node rather than clicked through.

**Out:** `extractSpace(doc, pageId, {subtree, docId})` returns a complete
`bento/spaces` document holding one page and, if asked, its subtree. It carries
a **fresh `docId`** and **no `collab` at all** — an extract that kept either
would be a fork of the space it came from, and opening it would join that room
and sync three pages over two hundred. Only the assets those pages reference
travel (fonts excepted — the theme names them, so every page references them).
A link out of the extracted set becomes the literal `[[Page title]]`, the same
thing an unresolvable wikilink becomes on the way in, so it is honest, still
searchable, and resolves again if the two halves are ever reunited.

**In:** `planGraft(host, incoming, {under})` nests another space's pages under a
page of this one. An arriving id is KEPT when this space does not use it and
only a collision is renamed — through `repairId`, the same derivation-from-the-
bytes the load path uses, for the same reason. Links inside the import follow
the rename; a link naming a page that was not in the file becomes text rather
than a live link onto whatever host page holds that id. Assets are
content-addressed, so a shared image merges to nothing; a key holding DIFFERENT
bytes (which the store cannot produce, but a hand-written file can) mints a
`~n` variant instead of overwriting the host's image. The whole graft is ONE
`store.commit`, so it is one ⌘Z.

The imported file is UNTRUSTED and gets no side door: its document block is
read from an inert `DOMParser` document, `parseDoc` decides whether it is a
space (refusing rather than degrading), and `sanitizeInline` runs over every
arriving block before any of it reaches the document.

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

- **Fine-grained sharing.** There is a people panel, presence in the page tree
  and a live session, but no per-person roles or invite links yet — the file is
  still the capability, so anyone you send it to can edit.
- **Embeds.** Deliberate: the format is permanent, so a block type ships when
  its model is right, not when its UI is ready.

  Tables and databases DID ship, as two separate things, which is the whole of
  working/design/spaces-design.md §2.6. A **table** is content — a `table` block whose
  `rows` are inline html, with no formulas and nothing that recalculates
  (`tableOf`/`writeTable` in `src/model.ts`, the pipe-table export in
  `src/blocks.ts`). A **database** is the tracker: `doc.fields` is the schema, a
  `prop` block is a value, and a `view` block is a board or a list of them
  (`src/fields.ts`). Recalculation is bento/dash's, and cross-app data arrives
  as a snapshot with provenance, never as a nested runtime.
- **Fetched link previews.** A `link` block is a card for an address on the
  web, and every field in it is typed by the author and stored. Nothing is
  fetched — not at render and not in the editor: reading a url's OpenGraph tags
  means a cross-origin HTML body, which needs a server, which is the component
  this format does not have. See `docs/DECISIONS.md`.
- **Comments on a text RANGE.** A thread anchors to a block or to a page. A
  range inside a block needs an offset pair that survives the concurrent edit
  that moved it, and the format is permanent — so the anchor ships when its
  model is right.

- **Tables and embeds.** Deliberate: the format is permanent, so a block type
  ships when its model is right, not when its UI is ready. (Databases DID ship —
  as the tracker: `doc.fields` is the schema, a `prop` block is a value, and a
  `view` block is a board or a list of them. `src/fields.ts` is the core.)
