# bento/spaces — for AI agents

**Guide version `__APP_VERSION__`** · document format `bento/spaces` (v1).

A space (`*.bento.html`) is a self-contained HTML file holding **a tree of
pages**. The document lives in ONE plaintext block near the top:

```html
<script type="application/bento+json" id="bento-doc">
{ "format": "bento/spaces", ... }
</script>
```

Two ways to work with it:

1. **File harness** — edit the JSON inside `#bento-doc` in place. Escape every
   `<` as `<` so the block can never contain a literal `</script>`. Leave
   the rest of the file alone.
2. **In the browser** — `window.bento` (below). Prefer the patch calls over
   `loadDoc`: rewriting the whole document to append a paragraph clobbers
   concurrent edits and flattens undo to one entry.

```bash
curl -fsSL https://bento.page/releases/spaces/Bento_Spaces.bento.html -o "<Name>.bento.html"
```

The downloaded file's `#bento-doc` block is **empty**. Opened in a browser it
mints a starter space; on disk there is nothing to copy from. Write your
document into the empty block.

---

## The shape

```jsonc
{
  "format": "bento/spaces", "version": 1,
  "docId": "…",                    // minted once, NEVER regenerate it
  "title": "Team handbook",
  "home": "p-intro",               // the page a reader lands on
  "theme": { "background": "#FFFFFF", "color": "#1E2A3A", "accent": "#F7A600",
             "fontFamily": "…", "measure": 720 },
  "pages": [                       // FLAT, in pre-order
    {
      "id": "p-intro", "title": "Introduction", "icon": "👋",
      "parent": "p-parent",        // optional — omit for a root page
      "blocks": [                  // FLAT, in pre-order
        { "id": "b1", "type": "p", "html": "Hello <b>world</b>." }
      ]
    }
  ]
}
```

**Both arrays are flat and in pre-order; nesting is a `parent` field.** A child
always follows its parent, which is what lets one forward pass rebuild the
tree. Do not nest arrays inside arrays.

**Every id is unique across the WHOLE document and is never reused.** Links,
backlinks and (later) collaboration key on them. A duplicate is repaired
deterministically at load and reported — but a repaired id is a *new* id, so
anything pointing at the old one is now pointing at the wrong node. Emit
unique ids the first time.

## Block types

| `type` | fields | renders as |
|---|---|---|
| `p` | `html` | `<p>` |
| `h1` `h2` `h3` | `html` | `<h1>`…`<h3>` |
| `bullet` `number` | `html` | `<li>` inside a `<ul>`/`<ol>` — adjacent siblings group automatically |
| `todo` | `html`, `done` | `<li>` with a checkbox |
| `toggle` | `html`, `open` | a fold; blocks whose `parent` is its id are its body |
| `callout` | `html`, `tone`, `icon` | a boxed note; blocks whose `parent` is its id are inside it |
| `quote` | `html` | `<blockquote>` |
| `code` | `html` (plain text), `lang` | `<pre><code>`, syntax-coloured |
| `divider` | — | `<hr>` |
| `image` | `src` (see below), `alt`, `caption`, `width` (10–100 **%**), `w`/`h` (intrinsic px) | `<figure>` |
| `pagelink` | `page` | a card linking to another page |
| `embed` | `page`, `anchor`, `html` | a live view of another page, or one section of it — see **Embeds** |
| `link` | `url`, `title`, `desc`, `site`, `icon`, `image`, `html` | a card linking OUT of the space — see **Link cards** |
| `prop` | `key`, `value`, `html` | one field value — see **The issue tracker** |
| `view` | `layout`, `span`, `groupBy`, `html` | a board, list, table, gallery or calendar of this space's pages |
| `view` | `layout`, `groupBy`, `sort`, `source`, `filter`, `html` | a board or list of this space's issues |
| `view` | `layout`, `groupBy`, `source`, `filter`, `sort`, `html` | a board, list, table, gallery, timeline or workload chart of this space's pages |

`type` is a **string**, not a closed set: an unknown type survives a round trip
and renders its `html` as a fallback. Properties are **flat on the block** —
there is no `props` object.

### Link cards

A `link` block is a card for somewhere on the web. **Every field is stored in
the file and nothing is ever fetched** — there is no server to read a url's
OpenGraph tags with, and opening a space must never contact a third party
(PLATFORM §1). So write the card yourself:

```jsonc
{ "id": "b7", "type": "link",
  "url": "https://example.com/docs",   // https:, http: or mailto: — nothing else is made clickable
  "title": "The guide",                // absent falls back to the url
  "desc": "Everything about the thing",
  "site": "example.com",               // absent is derived from the url's host
  "icon": "📘",                        // one emoji
  "image": "asset:<key>",              // OPTIONAL, and asset:/data: only — a remote one is DROPPED
  "html": "<a href=\"https://example.com/docs\">The guide</a> — Everything about the thing" }
```

Write `html` too: it is what a build that predates this type renders, exactly
as it is for `prop`. A `javascript:` or `data:` url renders as a dead card that
keeps its title rather than as a link — `validate()` reports both that and a
remote `image`. Use `pagelink`, not this, for a page inside the space.

### Embeds

An `embed` block shows another page **live**. It stores a reference and never a
copy: the source page is the truth, and editing it changes every embed of it.

```jsonc
{ "id": "b9", "type": "embed",
  "page": "p-design",                  // the target page id, exactly as pagelink means it
  "anchor": "Rollout",                 // OPTIONAL — one heading on that page, matched by NAME
  "html": "<a href=\"#p/p-design\">Design notes</a>" }
```

Write `html` too, for the reason `link` and `prop` do: it is what a build that
predates this type renders, so an older shell shows a link to the source page
instead of a blank.

`anchor` names an `h1`/`h2`/`h3` on the target, case- and
whitespace-insensitively, and the section runs to the next heading of the same
or higher rank — so an h2 takes its h3s with it. Leave it out for the whole
page; **a name that matches nothing is reported by `validate()`, never quietly
widened back to the whole page.**

Two limits, both deliberate and both visible to the reader rather than silent:
a page cannot embed itself or anything that leads back to it (the loop renders
as a named placeholder), and an embed chain is followed at most **three** pages
deep. `validate()` reports both, plus a target that is not a page.

An embed produces a **backlink** on its target, exactly as a `pagelink` does —
it is the strongest reference in the model, since the page it names is being
shown somewhere else. In Markdown it is Obsidian's `![[Page]]` / `![[Page#Section]]`,
in both directions: a vault's embeds import as embeds and export as themselves.

### Callouts

`tone` is one of `note` `tip` `important` `warning` `caution` — GitHub's alert
names, so a callout exports as `> [!WARNING]` and reads back as the same tone.
Absent means `note`. Like `type`, it is an open string: a tone this build does
not know is kept, styled neutrally and labelled with its own word, so writing
one is lossy in appearance only.

`icon` is optional and is an **override**. Leave it out and the mark is derived
from the tone, which is what keeps every warning in a document looking alike;
set it to an emoji when the callout is not really about severity.

```jsonc
{ "id": "b7", "type": "callout", "tone": "warning",
  "html": "The key is not recoverable." },
{ "id": "b8", "type": "bullet", "parent": "b7", "html": "inside the box" }
```
A `code` block carrying `frontmatter: true` (usually `lang: "yaml"`, inside a
collapsed toggle at the top of a page) is YAML frontmatter from an imported
markdown file, kept verbatim. It is **not** a properties model — spaces has
none yet — so read it if you like, but do not invent fields from it.

## Images: embed them, don't link them

`src` takes three forms, and only two of them display without asking:

| `src` | on open |
|---|---|
| `asset:<key>` — a key in `doc.assets` | displays |
| `data:image/…;base64,…` | displays |
| `https://…`, `//host/…`, or a relative path | **placeholder** until the reader clicks "Load this image" |

A remote url is not fetched when a space is opened. Opening a document must
never tell a third party that it was opened — in a format built to be mailed,
that is a tracking pixel — and PLATFORM §1 requires that no network be needed
to open a file. The reader's consent is per-url, per-session, and never stored
in the document.

So **embed the bytes**. Put a data: URI in `doc.assets` under a key and
reference it as `asset:<key>`:

```jsonc
{
  "assets": { "img1": "data:image/webp;base64,UklGR…" },
  "pages": [{ "id": "p1", "title": "…", "blocks": [
    { "id": "b1", "type": "image", "src": "asset:img1",
      "alt": "Revenue by quarter", "w": 1200, "h": 800 }
  ] }]
}
```

Give `w`/`h` (the intrinsic pixel size) so the page does not reflow while the
image decodes, and always write `alt` — it is what a reader sees if the image
is remote and unloaded.

Keep images to 1600px on the longest edge and use WebP: that is what the
editor's own downscale does, and it is the difference between a space someone
can mail and one they cannot.

## Code blocks

`html` is the source as **plain text**, html-escaped (`&` `<` `>` only) — never
markup. Colour is applied when the page is drawn, so the document is identical
whether or not this build can highlight the language.

`lang` is a free string and is stored **exactly as you write it**. These tags
are highlighted:

`js` `ts` `py` `sh` `json` `yaml` `sql` `html` `css`

plus the aliases you would reach for anyway — `javascript` `jsx` `typescript`
`tsx` `python` `bash` `zsh` `shell` `yml` `postgres` `mysql` `xml` `svg`. Any
other tag (`rust`, `go`, …) renders plain and is preserved: it exports as its
own fence and starts highlighting by itself if a later build learns it. So tag
the block honestly — never re-tag it as something close.

```json
{ "id": "b4", "type": "code", "lang": "sh",
  "html": "curl -fsSL https://bento.page/… -o Notes.bento.html" }
```

## Rich text

`html` is **inline only**: `b i u s em strong code a span mark sub sup br`.
Block structure is `type`, never markup — a `<p>` or `<div>` inside `html` is
always a mistake and is unwrapped at load.

Links are same-document fragments:

```json
{ "id": "b7", "type": "p", "html": "see <a href=\"#p/p-intro\">the intro</a>" }
```

`href` must match `^(https?:|mailto:|#p/)`. Anything else is stripped.

## Footnotes

A footnote reference is the literal text `[^label]` inside a block's `html`,
and the notes live in one document-level table:

```json
{
  "pages": [{ "id": "p1", "title": "Coffee", "blocks": [
    { "id": "b8", "type": "p", "html": "Coffee grows in the tropics.[^1]" }
  ] }],
  "footnotes": { "1": "Between Cancer and Capricorn." }
}
```

The reference is **text, not markup** — no tag, no attribute, nothing for the
sanitizer to allow — so it survives every edit and every sanitize pass exactly
the way the word beside it does, and a build that predates footnotes shows the
sentence with `[^1]` in it and round-trips the `footnotes` key untouched.

A label is `[A-Za-z0-9_-]{1,32}`. It is an **identifier, not a number**: notes
are numbered by order of appearance and the number is derived when the page is
drawn, so inserting a reference earlier on the page renumbers everything after
it and nothing in the file changes. Never write a number into the model and
never expect `[^1]` to render as 1.

Numbering is **per page** — the page is what prints and what a reader reads.
The section at the foot of a page is derived too: it is that page's references,
in order, so there is no block to add and nothing to keep in step. A note's
value is inline `html`, under the same allowlist as a block's.

`[^label]` inside a `code` block is left alone. It is not scanned in one and
never becomes a reference.

Markdown import and export both speak `[^1]` and `[^1]: the note.`, so an
Obsidian or Pandoc vault keeps its footnotes in both directions.

## The issue tracker

**An issue is a page.** There is no issue type and no flag: a page carrying a
`status` field is an issue, and a page that loses its status is a document again
with everything else about it intact.

**A field VALUE is a `prop` block** on that page. **The SCHEMA is
document-level** — `doc.fields`, absent means the built-in seven.

```jsonc
{
  "fields": [                                   // document-level, optional
    { "key": "status", "label": "Status", "vt": "select", "def": "todo",
      "options": [
        { "id": "backlog",   "label": "Backlog",     "color": "#8B95A5", "group": "unstarted" },
        { "id": "todo",      "label": "Todo",        "color": "#5B8DEF", "group": "unstarted" },
        { "id": "doing",     "label": "In progress", "color": "#F7A600", "group": "started"   },
        { "id": "review",    "label": "In review",   "color": "#A97BE0", "group": "started"   },
        { "id": "done",      "label": "Done",        "color": "#2FA37C", "group": "done"      },
        { "id": "cancelled", "label": "Cancelled",   "color": "#98A2B3", "group": "cancelled" }
      ] },
    { "key": "priority", "label": "Priority", "vt": "select", "def": "none",
      "options": [ { "id": "urgent", "label": "Urgent" }, { "id": "high", "label": "High" },
                   { "id": "medium", "label": "Medium" }, { "id": "low", "label": "Low" },
                   { "id": "none", "label": "No priority" } ] },   // every option needs a label
    { "key": "assignee", "label": "Assignee", "vt": "person" },
    { "key": "estimate", "label": "Estimate", "vt": "number" },
    { "key": "labels",   "label": "Labels",   "vt": "labels" },
    { "key": "start",    "label": "Start",    "vt": "date"   },
    { "key": "due",      "label": "Due",      "vt": "date"   },
    { "key": "project",  "label": "Project",  "vt": "text"   }
  ],
  "pages": [{ "id": "i-42", "title": "Search drops a keystroke", "blocks": [
    { "id": "b1", "type": "prop", "key": "status",   "value": "doing", "html": "Status: In progress" },
    { "id": "b2", "type": "prop", "key": "assignee", "value": "ana",   "html": "Assignee: ana" },
    { "id": "b3", "type": "p", "html": "Only on iOS, and only when typing fast." }
  ] }]
}
```

**`value` is the option `id`; `html` is the readable form, and you write BOTH.**
`html` is what an older build, a file-manager thumbnail, a `grep` and the
markdown export see, and it is *all* they see — a value written without it is
invisible to every one of them. The form is exactly `<Label>: <shown>`, where
`shown` is the option's **label** for a select, the values joined by `, ` for
`labels`, the value as text otherwise, and `—` when it is unset. Use
`bento.setField()` and this is not something you can get wrong; hand-editing the
file, it is the thing to get right. `bento.validate()` reports a mismatch as
`prop-html-stale`.

**Fields render as a header strip by POSITION**: the `prop` blocks *before* the
first non-prop block are drawn as one row under the title. There is no flag —
put them first.

**Unknown values and unknown keys are kept, never corrected.** A status this
build cannot name is shown verbatim and grouped as `unknown`; a field key that
is in no schema keeps rendering its own `html`. That is how a document written
by a newer build survives an older one, so never "fix" one by blanking it.

A board or list is a `view` block, and it stores a **query, never a membership
list**: `{ "type": "view", "layout": "board", "groupBy": "status",
"html": "Issues by status" }`. Put it on a page of its own — a page carrying a
view is laid out wide.

`layout` is one of `list`, `table`, `gallery`, `calendar` — **or absent, which
means a board.** Never write `"layout": "board"`: absence is what every view
written before layouts existed carries, and a stored `"board"` is a byte
difference that says nothing.

A **calendar** lays the view's pages out by date, and has two shapes: a month
grid (`span` absent) and a chronological timeline (`span: "timeline"`, newest
first). Which date a page sits on is a **fixed rule, not a setting** — its
`journal` date if it has one, otherwise the first `date`-typed field in the
schema it carries a real `YYYY-MM-DD` value for. A page the rule finds no date
for is listed under "No date" rather than dropped, and a value that is
digit-shaped but not a real day (`2026-13-99`) counts as no date rather than
being rolled into some other day. Month names, weekday names and the first day
of the week come from the reader's locale at display time; nothing formatted is
ever stored.
### Narrowing a view

`filter` is optional and every key inside it is too. **Absent means everything**,
and so does an absent key — a view with no `filter` shows every row, forever.
Write no `filter` key at all rather than an empty object.

```json
{ "type": "view", "layout": "table", "filter": {
    "open": true,
    "is": { "labels": ["ui"] },
    "where": [
      { "key": "due",    "op": "in",       "v": "past" },
      { "key": ":title", "op": "contains", "v": "onboarding" }
    ]
} }
```

- `open` — only rows whose status phase is neither `done` nor `cancelled`.
- `is` — `{ fieldKey: [values] }`, membership; a row passes a key if it holds
  any of the listed values. **An empty list is no constraint**, not "nothing
  passes".
- `where` — a flat list of conditions, ANDed. Set `"any": true` alongside it to
  OR them instead; `any` reaches `where` only, and `open`/`is` always AND.
- Each condition is `{ key, op, v? }`. `key` is a field key, or `":title"` for
  the page title.

| `op` | means | `v` |
|---|---|---|
| `eq` / `ne` | exact match on the STORED value; membership for a list-valued field | string or number |
| `gt` `gte` `lt` `lte` | numeric for a `number` field, otherwise text — and a `date` field's `YYYY-MM-DD` sorts chronologically as text | string or number |
| `contains` / `notContains` | case-insensitive substring of the READABLE value (a select's label, a labels list joined) | string |
| `empty` / `notEmpty` | the value is unset — absent, `""` or `[]` | — omit `v` |
| `in` | a date within a window resolved against the READER's today | `"today"` `"week"` `"month"` `"past"` `"future"` |

Two conditions on one number make a range. `"past"` on a due date is "overdue".
Relative windows are stored as the WORD and resolved when the view is drawn, in
the reader's own timezone and week — a stored `{"op":"lt","v":"2026-09-10"}`
would be right on the day you wrote it and wrong every day after.

An operator a build cannot evaluate is **not applied and reported**, so the view
shows a superset with a banner over it rather than the wrong rows. That is the
same trade the format makes everywhere: never silently narrow.
A view's `source` says which pages it holds: `{ "has": "<fieldKey>" }`,
`{ "under": "<pageId>" }`, or `{ "tag": "<tagKey>" }`. Absent means the
backlog. The tag key is **lower-case** and reaches nested tags, so
`{"tag":"project"}` also holds the pages carrying `#project/bento`.

### Tags

Write `#tag` in a block's `html` — that is the whole storage. **There is no
`tags` field on a page and you must not invent one**: the index is derived from
the prose every time it is asked for, exactly as backlinks are, so a stored
list would be a second copy that goes wrong the first time anything edits
`html` without knowing tags exist. Nothing to maintain, nothing to keep in
step.

What is and is not a tag, since a `#` means several things:

| written | read as |
|---|---|
| `#recipe`, `#work-in-progress`, `#レシピ` | a tag |
| `#project/bento` | ONE nested tag, also counted under `project` |
| `# Title` | a Markdown heading — a tag never has a space after the hash |
| `#42`, `#404` | an issue number, not a tag |
| `#fff`, `#f7a600` | a CSS colour, not a tag |
| `C#`, `a#b` | a `#` inside a word |
| `<code>#include</code>` | code |
| `https://x.example/p#top` | a URL fragment |
| `<a href="#p/abc">…</a>` | a page link — the href is an attribute, never text |

Tags are case-folded for matching and keep the casing you typed for display.
`layout` is one of `board` (the default, and the ABSENT key — never write
`"board"`), `list`, `table`, `gallery`, `gantt` and `workload`. **A chart is a
layout here, not a block type**, so every shape reads the same four keys and a
build that predates a shape draws a board of the same pages rather than a
fallback line of text.

- **`gantt`** draws one bar per page, from its `start` date to its `due` date,
  with today marked and overdue work outlined. A page with only ONE of the two
  dates gets a **milestone diamond** at the date it has — which is what every
  issue written before `start` existed looks like, so do not add a made-up
  `start` to "fix" one. A page with neither is left out and counted.
- **`workload`** adds up the first `vt:"number"` field in the schema per bucket
  and draws a bar chart. The bucket is `groupBy`; absent, it is the first
  `vt:"person"` field. A negative or non-numeric estimate is excluded and
  reported rather than summed — do not write one expecting it to subtract.

Both honour `source` and `filter`, so "the workload for this project" is
`{ "layout": "workload", "source": { "under": "<page id>" }, "filter": { "open": true } }`
and needs no key of its own.

**Not in this format, deliberately**: teams, per-user permissions,
notifications, automation. The file is the team boundary and the capability.

## What makes a space good rather than merely correct

| When the material is… | Reach for | Why |
|---|---|---|
| more than one topic | **separate pages**, not headings in one long page | the sidebar, ⌘K and backlinks all key on pages |
| a topic that belongs *under* another | `parent` on the page | the tree is the navigation |
| a reference to another page | an inline `#p/` link | it produces a backlink on the target automatically, at no cost |
| a list of sub-pages | one `pagelink` block each | a visible card beats a bare link for a hub page |
| one page's material that belongs on another too | an `embed`, narrowed with `anchor` | the source stays the single copy — a pasted duplicate is what goes stale |
| steps someone will tick off | `todo` | state lives in the document, so it survives sharing |
| an aside, or detail most readers skip | `toggle` with its body as `parent` children | folds away, and always PRINTS expanded |
| a warning the reader must not miss | `callout` with the `tone` that fits | it is boxed, named and legible in print and without colour vision — but three per page and none of them registers |
| anything you would print | remember toggles print open and archived pages are excluded | |

| a topic that recurs across pages | an inline `#tag` in the sentence | the index, ⌘K's `#` mode, a view sourced on it and the graph all derive from it |

**The most-missed feature is backlinks.** They are derived — link to a page and
it lists the linker, with no maintenance. A space where pages only link *down*
the tree wastes the one thing this format does that a folder of files cannot.

**Give a page `aliases` when people call it more than one thing.** `aliases:
["NYC", "the Big Apple"]` on a page titled New York makes all three names reach
it from a `[[wikilink]]`, from ⌘K and from the `[[` picker — and makes prose
that says "NYC" show up as an unlinked mention on that page. It costs one array
and it is the cheapest way to make a space find things for its reader.

## `window.bento`

```js
// read
bento.doc                                  // the live document
bento.pages()                              // [{id, title, parent, archived, blocks}]
bento.getPage(id)                          // one page, with its blocks
bento.search(q)                            // [{pageId, title, blockId}]
bento.outline()                            // the whole space as a tree
bento.mentions(pageId?)                    // where a page is named but not linked
bento.validate()                           // what is wrong or suspect
bento.stats()                              // pages, blocks, words, bytes, biggest assets
bento.comments(query?)                     // review threads, flat, with a typed anchor

// write — each one is ONE undoable step
bento.fields()                             // the field schema in force
bento.issues(query?)                       // the backlog, as data

// write — each one is ONE undoable step
bento.setField(pageId, key, value)         // → {ok:true, …, warning?} | {ok:false, err}
bento.newIssue({title, ...fields})         // → {ok:true, id, blocks, warnings?}
bento.newPage(title, parent?)              // → new page id, or null
bento.insertBlocks(pageId, afterId, [...]) // → new block ids, or null
bento.updateBlock(id, patch)               // → {ok:true, id, page} | {ok:false, err}
bento.removeBlocks([ids])                  // → {ok:true, removed, missing, added}
bento.moveBlock(id, {pageId?, afterId?, beforeId?, parent?})
bento.updatePage(id, patch)                // → {ok:true, id} | {ok:false, err}
bento.removePage(id, {descendants?})       // → {ok:true, removed, rehomed, links}
bento.loadDoc(json)                        // replace everything (one undo step)

bento.serialize()                          // the whole .bento.html file
bento.undo() / bento.redo()
bento.readonly                             // true = a locked or frozen file; every write returns err:'readonly'
```

Use the patch verbs, not `loadDoc`. Rewriting the document to add a paragraph
flattens undo to one entry and overwrites anything a person typed while you
were thinking.

**A refused write changes nothing at all — including undo history.** Every verb
validates before it touches the document, so a rejected patch does not leave an
empty step for someone to undo.

### Results are tagged

The verbs added after 0.1.0 return `{ok: true, …}` or `{ok: false, err, detail}`
rather than `null`. `err` is one of `readonly`, `no-such-block`, `no-such-page`,
`no-such-field`, `bad-patch`, `immutable`, `not-serializable`, `cycle`,
`last-page`.
`insertBlocks` and `newPage` keep their original shapes (ids, or `null`),
because files and scripts already depend on them.

Nothing is ever silently ignored. Sending `id` in a patch is an error, not a
no-op; so is `blocks` in a page patch (block structure goes through the block
verbs, which keep ids, nesting and undo coherent). In a patch, `null` **deletes**
a field.

### `bento.validate()`

```js
const { ok, counts, findings } = bento.validate()
findings.filter(f => f.severity === 'error')
```

Each finding is `{code, severity, message, fix, page?, block?, path?}`. It
reports duplicate and missing ids, a page inside its own subtree (which is the
one way a page becomes unreachable), parents naming nothing, `#p/` links and
`pagelink` cards and `embed` blocks pointing at pages that do not exist
(`broken-embed`), embeds that loop back to their own page (`embed-cycle`) and
embed anchors that name no heading (`no-section`), unknown block types, block
markup inside inline `html` (and markup that is dropped whole), hrefs outside the
allowlist, images with no `alt`, no size, a missing `asset:` or a remote `src`,
a `home` naming nothing, pages with no blocks, and assets nothing references.

On footnotes it adds `dangling-footnote` (**warning**: a `[^label]` with no
note behind it — the reference still renders, numbered, into an empty note),
`orphan-footnote` (**info**: a note in `doc.footnotes` that nothing references,
so it is never numbered and never printed — it is kept, never deleted) and
`unreachable-footnote` (**warning**: a label outside the grammar above, which
no `[^label]` can ever match).

On the tracker it adds: `prop-html-stale` (a value whose readable `html` says
something else — the check worth running after any hand edit),
`unknown-field-value` and `unknown-field-key` (**info**, because that is how a
newer build's data arrives — the value is kept), `duplicate-prop` (two values
for one field on one page; a reader takes the last), `prop-no-key`, and
`bad-field-schema` for a `doc.fields` entry with no string `key` and `label`,
which is an **error**: writing a value for that field throws.

`ok` means no **errors**; warnings and info do not make a document invalid.
Severity is meant literally, so that a clean document is silent: **`validate()`
reports nothing at all on the space a fresh file opens with**, and the rig
enforces that. If you get findings, they are about your document.

It only reads. A finding is advice, never a refusal — `parseDoc` remains the
thing that decides whether a document opens at all.

Unknown *property names* are deliberately not reported: unknown fields are how
this format carries a future version's data, and how you can park your own
metadata on a block.

### `bento.outline()`

The whole space in one call instead of one `getPage` per page:

```js
bento.outline()
// { title, docId, pages, blocks, words,
//   tree: [{ id, title, depth, parent?, icon?, archived?, home?,
//            blocks, words, headings: [{id, level, text}], links: [pageId] }] }
```

In sidebar order (depth-first). Headings carry their **block id**, so what comes
back can be handed straight to `updateBlock` or `moveBlock`. `links` is what
that page points at, which is the other half of the backlinks a reader sees.

### `bento.mentions()`

```js
bento.mentions('p-abc')   // that page's unlinked mentions
bento.mentions()          // every page's, as { pageId: Mention[] }
// Mention: { pageId, fromPage, fromBlock, matched, htmlStart, htmlEnd, snippet }
```

Where a page's **title or aliases** appear as plain words in some other page
without a link. `matched` is the text as it was actually written, and
`htmlStart`/`htmlEnd` are offsets into `fromBlock`'s `html`, so a link can be
spliced in exactly where the words are rather than found again by string search
— which would hit the wrong occurrence when the name appears twice.

It never reports a name inside a code block, a code span, a link that already
exists, a URL or a mail address; nor in a block that already links to the
target; nor in the page's own text; nor as part of a longer word. Names under
three characters (two, for a name written in Han, kana or Hangul) are not
scanned for at all.

**READ ONLY on purpose.** Deciding that a sentence meant *that* page is a
judgement, and an agent that rewrote a hundred blocks on a guess would be
unreviewable. Link the ones you are sure of with `updateBlock`, and leave the
rest to the panel, where a person can see the sentence before deciding.

### `bento.stats()`

```js
bento.stats()
// { pages, archived, blocks, words, characters, blockTypes, todos,
//   assets: {count, bytes, orphans, orphanBytes},
//   bytes: {document, assets, text},
//   biggest: [{key, bytes, mime, used}] }
```

This answers "why is this file 30 MB". It is always the images: prose is free
(2,000 pages of it is about 5 MB). `used` is how many blocks reference that
asset — `0` means it is dead weight, and deleting the key is pure savings. The
app shell adds a fixed ~80 KB on top of `bytes.document`.

### `bento.comments()`

```js
bento.comments({ resolved, pageId })
// [{ id, anchor:'block'|'page', pageId, pageTitle, blockId?, url:'#p/<id>',
//    author, at, text, resolved, replies:[{id, author, at, text}] }]
```

What a person flagged, from every page, in document order. `anchor` says what
the thread is about: a `block` (and `blockId` names it) or the `page` as a
whole. `text` is **plain text** — never html, in or out. Start with
`bento.comments({ resolved: false })`: those are the ones still asking for
something.

It is **read-only, deliberately**. Acting on a remark is your job; marking it
resolved is the commenter's, and an agent that closed the thread it was asked
to address would make the record untrue. Say what you did in a block, and leave
the thread open.

### The patch verbs, exactly

```js
bento.insertBlocks(pageId, afterId, blocks)
```
Mints fresh ids — never yours — and inserts after `afterId` (`null` = the end of
the page). An `afterId` that is not on that page is an **error**; it does not
append somewhere else and report success. Blocks in one batch may nest inside
each other: give them temporary `id`s and use those as `parent`, and the
references are remapped to the minted ids.

```js
bento.updateBlock(id, {html, type, done, open, src, alt, …})
```
Changes fields on one block. `null` deletes a field. `id` is refused. `parent`
must name a block on the same page and may not be inside the block's own
subtree.

```js
bento.removeBlocks([id, …])
```
Takes the nested blocks with it — deleting a toggle deletes its body, because
leaving blocks pointing at an id that no longer exists means they reappear,
un-nested, at the next load. Ids that were not there come back in `missing`. If
this empties a page, one blank paragraph is created and returned in `added` (a
page with no blocks has nothing to put a caret in — nobody can type in it).

```js
bento.moveBlock(id, {pageId, afterId | beforeId, parent})
```
Moves a block and everything nested under it. Neither anchor = the end of the
page. Moving across pages drops a `parent` that does not exist there; pass
`parent` to re-nest deliberately, or `null` to un-nest.

```js
bento.updatePage(id, {title, icon, parent, archived, …})
```
`title` is plain text (it renders as text, so markup would show literally).
`parent` may not be one of the page's own descendants. `archived: false`
removes the key, which is what the editor writes.

```js
bento.removePage(id, {descendants: false})
```
By default the pages inside it move up a level rather than disappearing with it;
`{descendants: true}` takes the subtree. `links` in the result counts the
inbound links that just went dead. Removing every page is refused.

### The tracker verbs, exactly

```js
bento.fields()
// [{ key: 'status', label: 'Status', vt: 'select', def: 'todo',
//    options: [{ id: 'todo', label: 'Todo', color: '#5B8DEF', group: 'unstarted' }, …] },
//  { key: 'assignee', label: 'Assignee', vt: 'person' }, …]
```
Call this **first**. A value is set by option **id**, and the ids are not the
labels: `doing`, not `In progress`. The schema is the document's own
(`doc.fields`), so a space may declare fields these defaults never had.

```js
bento.setField(pageId, key, value)
// {ok:true, pageId, key, value, html, blocks:[id], created, removed, warning?}
```
Writes `value` **and** its readable `html` together, which is the only reason
this verb exists: write a `prop` block yourself through `insertBlocks` and you
will eventually get that pairing wrong, and then the file says one thing to this
build and another to every older build, every thumbnailer, every grep and the
markdown export — silently, forever.

The page need not be an issue: **setting `status` is what makes it one.** A
value for a field the page does not carry yet is created in the header strip
(`created: true`). `null` **clears** the field, block and all — clear the status
and the page is an ordinary document again, body intact.

It refuses `no-such-page`, `no-such-field` (the key is in no schema) and
`not-serializable`, and returns `err: 'readonly'` on a locked file. A value that
is not one of a select's options is **written, not refused** — the format is
permanent and additive, so a status a newer build declared has to survive this
one — but it comes back with `warning: {code:'unknown-option', options:[…]}`.
If you see that warning and you did not mean it, you typed a label where an id
belongs.

```js
bento.issues({ where, group, archived })
// [{ id, title, url:'#p/<id>', archived?, group, fields:{status, priority, …} }]
```
`where` is field equality: a value, an array for any-of, or `null` for **not
set** (which covers both an absent field and an empty one). `group` is the
status **phase** — `unstarted` `started` `done` `cancelled`, plus `unknown` for a
status no option declares, and **`open`, which means "not finished"** and is the
one you want. Archived issues are excluded unless you ask for them.

```js
bento.newIssue({ title, ...fieldValues })   // → {ok:true, id, blocks, warnings?}
```
One page, one undoable step, every value written through the same path. `title`
and `parent` are the page's; every other key is a **field key**, and one that is
not in the schema is refused rather than parked on the page (an unknown key in
an argument is a typo, not additivity). It does not navigate — make twenty and
the person's cursor stays where it was.

### Triage, worked

```js
const ids = new Set(bento.fields().find(f => f.key === 'status').options.map(o => o.id))
// → {'backlog','todo','doing','review','done','cancelled'}

// everything open and unassigned, oldest first in page order
const inbox = bento.issues({ group: 'open', where: { assignee: null } })

for (const it of inbox) {
  const body = bento.getPage(it.id).blocks.map(b => b.html).join(' ')
  if (/crash|data loss/i.test(body)) {
    bento.setField(it.id, 'priority', 'urgent')   // an id, never 'Urgent'
    bento.setField(it.id, 'assignee', 'ana')
  }
}

// a new one, complete, in one call
const { id } = bento.newIssue({
  title: 'Search drops the last keystroke on iOS',
  status: 'todo', priority: 'high', estimate: 2,
})
bento.insertBlocks(id, null, [{ type: 'p', html: 'Steps: type fast in ⌘K…' }])

bento.validate().findings.filter(f => f.code.startsWith('prop-') || f.code.includes('field'))
```

Every `setField` and `newIssue` is its own undo step, so a person watching can
take back exactly the one they disagree with. Check the `warning`/`warnings` on
what comes back before you move on: they are how you find out you set something
nothing will ever group.

### What you may write

Everything an agent writes goes through the same sanitizer the editor uses, on
the way IN: an agent cannot put into a file something this build could not have
produced. `html` is reduced to the inline allowlist (a `<script>` does not
survive), a `code` block's html is escaped text rather than markup, and a patch
value JSON cannot carry — a function, a `Date`, a `Map`, a cycle — is refused
rather than vanishing quietly at save time.

## Before you finish — self-audit

- [ ] `bento.validate()` clean of **errors**, and every warning either fixed or
      a deliberate choice you could defend?
- [ ] More than one topic? **Separate pages**, not headings in one long scroll.
- [ ] Does anything link **across** the tree, or does everything only link down?
      Backlinks are the feature a folder of files cannot have.
- [ ] Every image `alt`-texted and embedded as an `asset:`?
- [ ] **Have you opened it?** Click through the pages, fold the toggles, follow
      the links. A space nobody read is not finished.

## Gotchas

- Escape `<` as `<` when writing the file block.
- Don't invent property names — unknown keys are preserved but ignored, so a
  typo means your styling silently does nothing.
- `docId` is the document's identity. Never regenerate it when editing.
- A `parent` naming something that does not exist is dropped at load: the page
  becomes a root page, the block re-homes. Not fatal, but not what you meant.
  `validate()` names every one of them.
- **Never write a page with an empty `blocks` array.** Nothing in it can take a
  caret, so it is a page nobody can type in. Give it `[{ "type": "p", "html":
  "" }]` — `bento.newPage()` does exactly that.
- `readonly: true` marks a READING COPY: the file opens in the reader (no
  editing tools, no comment markers, a Previous/Next pair under each page) and
  `bento.readonly` is true, so every write returns `err: 'readonly'`. A
  `policy` this build does not know opens **frozen** for a different reason —
  we do not understand the file — and is likewise refused. In both cases the
  document round-trips byte-exact.
  `readonly` is INTENT, not a lock: the document block is plaintext, so anyone
  can clear the flag. What a reading copy actually guarantees is what it does
  not contain — `doc.collab` (every room credential) and every comment thread
  are removed when it is written.
- `doc.revisions` is the space's **version history, kept inside the file** —
  each entry the change from the one before it, oldest first, bounded to 128 KB.
  Treat it exactly as you treat `docId` and `assets`: carry it through
  untouched. If you rewrite a whole document rather than patching it, copy the
  field across or you delete the author's history without saying so. The patch
  verbs (`updateBlock`, `insertBlocks`, …) never touch it; only saving appends
  to it, and only the About dialog's **Clear history** removes it.
- `readonly: true` and a `policy` this build does not know both open **frozen**
  — the file round-trips byte-exact and edits are refused.
- A remote image `src` shows a placeholder until the reader asks for it. Embed
  the bytes as an `asset:` instead — see **Images** above.
- There is no collaboration yet. Two people editing two copies get two files
  and no merge.
