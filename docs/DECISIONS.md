# Decision log

Append-only. Newest first. One entry per settled decision that a parallel
agent (or future session) might otherwise re-open or contradict. Keep entries
to a few lines: **what** was decided, **why**, and where the details live.
Reversing a decision = a new entry that supersedes the old one, not an edit.

Format:

```
## YYYY-MM-DD — Title
Decision. Why. Pointers.
```

---

## 2026-08-19 — Cross-app embedding: static render + source, never a second renderer

**Decision.** One block/element shape, `bento/embed`, shared by every app in both
directions (a Dash chart in a Type contract, a Type doc in a Spaces page, either
in a Slides deck):

```
{ kind:'embed', app:'bento/dash', doc:{…}|'asset:…', view:'<svg…>', w, h, caption? }
```

Three tiers, and the ORDER is the design. `view` — a static render — is always
present, so the embed paints in any app with zero extra code, thumbnails, and
prints. `doc` — the source — is always present, so it round-trips: open in Dash,
edit, come back. A live sandboxed iframe is OPT-IN per embed, never the default.

**Why.** Embedding the other app's renderer means shipping every renderer in
every file to cover the matrix (each is 100KB+) and living with version skew
between the embedded copy and the real app. The static render is what makes a
self-contained file self-contained; the source is what stops it being a
screenshot. A Bento file IS a runnable page, so `srcdoc` genuinely works for a
live chart — but it is opt-in because most embeds do not need it and every one
of them would cost the file a full shell.

Constraints this inherits, not new ones: format additivity (PLATFORM §3) means
an app that does not know `bento/dash` still shows the render plus an "open
in…" affordance, never a hole; the splice contract (§2) means the payload can
never carry a bare `</script>`, so it is escaped like `#bento-doc` or stored as
an asset; and since every document is untrusted input, a live iframe is
sandboxed with no same-origin. Default to data + render — embedding a 500KB
shell per chart is how a contract becomes 3MB.

**Status.** The SHAPE is settled here so the apps do not each invent one. The
shared definition belongs in the kernel and is therefore a serialized kernel
change of its own (PARALLEL-WORK §1): it has not been made. bento/type
implements the consumer side in its own app zone against this shape, so the
kernel lift is a move, not a redesign.

**Pointers.** `type/src/embed.ts`, `docs/PLATFORM.md` §2–§3.

---

## 2026-08-24 — The tree moved to `home/`, and the identifiers moved with it

**Decision.** `tray/` is now `home/`, `applicationId` and
`PRODUCT_BUNDLE_IDENTIFIER` are `page.bento.home`, and the update channel is
`https://bento.page/releases/home/manifest.json`. This supersedes the scope
paragraph and the bundle-identifier bullet in the rename entry above.

**Why the earlier decision was right when it was made, and wrong to keep.** It
was written while `tray/ios` (#315) and the Android work were both open in
`tray/`; moving the tree under them would have turned two mergeable branches
into conflict resolution. That was a real cost and a correct call at the time.
Both landed, and the reason expired.

The bundle-identifier bullet expired differently. Its argument was explicitly
conditional — changing the id "creates a different one that cannot update the
installed copy". There was no installed copy, no App Store Connect record and no
Play listing. Those three facts are what made it free, and all three stop being
true at first publish. **This was the last moment the identifiers could move.**

**What did NOT move, and why the line is there.** Rename what the outside world
sees or what becomes permanent on publish; leave what is internal and guarded:

- **The IndexedDB name stays `bento-tray`** (`home/webext/src/db.js`).
  `scripts/test-webext-background.ts` asserts it — a deliberate guard against
  silently orphaning every stored grant. Nobody outside the extension ever sees
  it, so renaming it would have meant editing a gate to let a cosmetic change
  through.
- **`bento-tray://` (iOS) and `.bento-tray.invalid` (Android)** stay. They are
  per-document origins, settled in their own entries, and invisible.

**The cost, stated.** Every path reference moved: 18 files outside the tree, 35
inside it, plus the Kotlin package `page.bento.tray` → `page.bento.home` and the
`tray-icon`/`tray-logo`/`ic_tray_mark` assets. That churn is what the original
entry warned about, and it was the price of not carrying a dead name forever.
## 2026-08-25 — The tray hosts are called `bento/home`

**Decision.** All three hosts are named **`bento/home`** — lowercase, with the
slash, set like `bento/slides`. **Never "Bento Home"**, in any casing, in any
surface a user reads. This supersedes the naming half of the 2026-07-26 entry
below, which called the iOS app `bento/tray`.

**Why `home`.** It is not a component that needs distinguishing from the brand —
it is where documents live and where new ones start, on every host. The suite
convention is `bento/<what you get>`, and what you get is your documents.

**Why the qualifier route was abandoned, so it is not tried again.** The
alternative was a distinguishing second word, and every candidate died to a live
collision: **box** → BentoBox (and "bento box" is the literal object), **desk** →
Addit's furniture line, **works** → Apple's iWork, **keep** → Google Keep. That
is four independent attempts failing the same way, which is the signal that the
premise was wrong rather than the words: the front door does not need a
qualifier, because it is not one thing among several.

**Scope: the PRODUCT is renamed, not the tree.** Directories stay `tray/ios`,
`tray/android`, `tray/webext`, and `tray/bridge.js` keeps its name. Renaming
paths would churn every import, every doc link and every open branch for no
reader's benefit — the name people see is not the name the repo files it under.

**What must NOT change, on any host:**

- **The bundle identifier.** `page.bento.tray` on iOS, and its Android
  counterpart. To the OS and the store it IS the app: changing it does not rename
  the app, it creates a different one that cannot update the installed copy.
- **`PRODUCT_NAME` / `CFBundleName`** (iOS). They name the executable and the
  bundle, not the label. `CFBundleDisplayName` is the label, and it is the only
  key the rename touches.
- **The App Store listing name.** Per 2026-07-24, `/` is a mark and never a
  stored name, and store names are stored. The listing keeps a slashless form;
  the on-device label does not. Those are separate fields — see the note on the
  2026-07-26 entry for why that pair is not a contradiction.

`bento/home` is 10 characters, which fits the iOS home-screen label without
truncation. (`bento/tray` was 10 too, so this was not at risk, but it is the
constraint any future rename has to clear.)

**Where it landed.** `tray/webext` first, in PR #360 / `50d1c40` — read that as
the precedent for which strings change. `tray/ios` in PR #315: the display name,
the search screen's lockup, and the mark's `aria-label`. `tray/android` follows.

Screen readers get the spoken form, not the mark: `aria-label` and
`accessibilityLabel` say "bento home", because a slash is read out as
punctuation. Visible text keeps the slash, and only the search screen can colour
it — the home-screen label, the browser title and the Browse folder are system
chrome drawn as plain text.

**One practical note for the listing, since it is cheap to record and expensive
to rediscover:** App Store screenshots need documents that have been **saved at
least once**. A preview is only written on save, so an unsaved document
photographs as a "Not saved yet" placeholder — a whole screenshot set can be shot
and only later found to be showing empty cards.

---

## 2026-08-23 — The web demo gates on RETURN, not on save

Someone works at `https://bento.page/slides/`, saves, comes back later and gets
a fresh starter, because a never-saved deck stays dormant by design. It reads
as lost work. It is not — the file is on disk — but nothing on screen says so,
and two things genuinely do not survive: version history and recovery live in
IndexedDB keyed to the `bento.page` ORIGIN and do not follow the file to
`file://`, and neither does the session.

**Blocking straight after the save was considered and rejected.** Once an FSA
handle exists the editor silently rewrites the real file every 2.5s
(`writeUpdatedFile`), so that tab is a working session writing to disk on every
edit; interrupting it would sever something that is functioning and lose
whatever was typed since the last write. The confusion happens on the NEXT
visit, so that is where the gate goes. **"Start a new deck anyway" is always
present** — some visitors do want a fresh one, and some cannot install
anything.

**Availability gating is required from day one, not added later.** The offer is
`hasFsAccess()` × `hostCan('write')` × *which host actually has a release*.
Hardcoding "install the extension" would tell an Android user to install a
Chrome extension. `HOST_AVAILABLE` in `kernel/src/returngate.ts` carries that,
and `scripts/test-return-gate.ts` pins both states — that the mobile rows say
"keep the file" today, and that they become real offers the day the flag flips,
so the flag is wired rather than decorative.

**Capability decides what to SAY; the platform guess decides only which LINK.**
`hasFsAccess()` is a real feature test, UA sniffing is a guess. A browser that
gains the API is handled correctly on the day it ships with no change here. For
Safari/Firefox desktop the honest answer is a different browser, not a pitch
for an extension that cannot help them.

State is viewer-scoped `localStorage`, never in the document — the same rule
locale, theme and reduced motion follow. A deck carrying it would tell everyone
you sent it to that you had once saved something.

In `kernel/`, not `slides/`: Spaces, Dash and Type have the identical problem
and would each grow their own copy. The kernel owns the remembering and the
policy; the words and the markup are the app's. Spec (gitignored):
`working/team/handoffs/handover-web-demo-return-gate.md`, from the `tray-views` session.

NOT done here, and worth weighing first: making **Download** the primary action
on the landing page (it is currently `btn primary` on "Try it in your browser")
would avoid the situation for most people and costs nothing. That is a site
change, not an app one.
## 2026-08-23 — Sharing a space is a DERIVED document, and the sharer stays the owner

bento/spaces' "Invite someone…" was `saveAs('copy')`, which serializes
`store.doc`. `collab.ownerPriv` rides in that document and is the room's ROOT
key — it signs writes and it signs revocations — so everyone invited to a space
received the power to remove the person who invited them. Measured on the
branch: the bytes that button wrote contained `ownerPriv` in full, and nothing
about the copy looked wrong.

**Every share copy is now derived, never the open document.**
`spaces/src/share.ts` is the one place that says what a copy may carry:

  invite     room + read key + owner PUBLIC key + an owner-signed INVITE
             (a delegation keypair). Revocable per device, and per invite.
  view-only  room + read key + public keys, and NO private half at all.
  anything   no `collab` block, by dropping it whole — a template, a page
  else       extract, the JSON on the clipboard.

The stripper DELETES rather than rebuilds, so a private field added to
`CollabCreds` later is covered without anyone acting. That is the same
derive-by-removing rule `docForExport` already follows, and the two are NOT the
same case: the clipboard copy must carry no capability, an invite must carry
exactly one. Do not merge them.

NO RELAY CHANGE WAS NEEDED OR MADE. v2 rooms, the owner → invite → member
chain, per-socket key pinning and `rev.${pub}` are already deployed and already
verified by the worker (docs/collab-design.md, "Phase 1 wire format"); this app
was simply not using them. A new client that DEPENDS on relay behaviour still
has to be sequenced after a relay deploy — that rule is unchanged and did not
bind here.

**Read-only is the relay's, the lock is a courtesy.** A view-only copy holds no
signing key, so its socket presents no `?w=` and the relay stores and fans out
nothing it sends. `main.ts` also opens it locked (`collab.role === 'reader'` →
`store.readOnly`) with a banner, which is a THIRD reason to lock alongside
`doc.readonly` (a sealed reading copy, no session) and `frozen` (a file this
build does not understand). Only this one keeps receiving.

**Five connection states, not two, and they must be repainted.** offline /
view-only / live / connecting / off. Measured in a browser against the live
relay: the button read "Connecting…" while the panel two inches below it read
"Live — 1 connected". Both call the same `state()`; the panel is rebuilt on
every open and the button was painted once at boot, because `onPeersChanged`
was the only thing calling `sync()` — and in a room where nobody has arrived
yet, that never fires. The transport's `onStatus` now drives it. Honest states
are worth nothing if they are painted once.

**Wording is lifted from bento/slides wherever the English string exists** —
24 of the 31 new strings, including every sharing tooltip. Two apps must not
describe one guarantee in two ways, and a reworded sentence costs eight fresh
translations to say the same thing. The seven that were adapted say "space"
where slides says "deck". (Noted in passing, not fixed here: the slides
catalogs give "Editor copy saved — recipients join live with edit access" the
translation of the ROLE word "Editor" in seven of eight locales. The spaces
catalogs carry the correct sentence for that key.)

Pinned by `scripts/test-spaces-invite.ts` — real WebCrypto keys, real
functions, asserting on the bytes: the owner private key appears nowhere in an
invite (the whole serialization is scanned, not the field), the owner's
signature over the invite verifies the way the relay verifies it, and a member
copy cannot mint invites. `scripts/test-export-secrets.ts` carries the cheap
half, so a new button cannot route around the first rig.


---

## 2026-08-22 — The starter space is a release gate, not a document somebody updates when they remember

`spaces/src/starter.ts` had been written once and left. Everything that shipped
after it — tables, clips, link cards, comments, calculating lines, daily notes,
page width, export-a-page, subtree import, the mark palette with its colours,
live collaboration and presence, the properties panel — was absent from the one
document every new user reads first, and its "Sharing & limits" page still said
live collaboration was coming, months after it arrived. A starter that silent is
not neutral: **a feature the starter does not demonstrate is a feature the
starter denies**, and the tour was denying about half the app.

So the doctrine is now ASSERTED rather than remembered. `scripts/test-spaces-agent.ts`
structurally requires the starter to carry a table, a clip, a link card, an
`asset:` picture, a page-link card, a callout, a FOLDED toggle, a calculating
line, a palette colour, a comment thread, an archived page, a journal home and a
page that sets its own width — plus determinism (two calls, byte-identical: ids
here are CRDT node keys), every parent resolving IN PRE-ORDER, every `#p/` and
pagelink target existing, no orphaned page, and assets and references agreeing.
Adding a feature and not the demonstration now fails a rig instead of shipping.

WRITING THE STARTER IS HOW THE CLAIMS GET TESTED, which is the whole argument
for the doctrine. Two defects fell straight out of writing this one. A hand-authored
table with `rows` and no fallback `html` put a working link on a page that
back-linked to nothing — `buildIndex` reads `html`, and `writeTable` is the one
writer that keeps the two in step, so the starter goes through it exactly as the
issues go through `propBlock`. And `validate()` asked every AUDIO block for
intrinsic `w`/`h`: pixels an audio player does not have, on a finding that would
have fired for every correctly-authored clip in existence.

THE ARCHIVED PAGE IS THE ⌘K DEMONSTRATION, one page doing both jobs the brief
asked for: it is out of the sidebar, so search is the way in, and "Sharing &
limits" names it by name because sending the file sends it too.

IT COST 7,000 B, measured on the stack: 5,336 B of prose and 1,664 B of the two
files it ships (`spaces/src/starterdata.ts` — a hand-written SVG drawing and a
1.2 s test tone, both chosen so that deflate reduces them to almost nothing: the
tone is exactly periodic and packs to 204 B). The ceiling moved 216 → 224 KiB in
the same commit, with the numbers in `scripts/size-budgets.json`.

THE STARTER IS NOT TRANSLATED, and that is deliberate rather than pending. The
interface follows the reader (PLATFORM §8); a document is written in a language,
and this one is written in English. Nine starters would be nine feature tours to
keep in step, and the space a user then writes in would be the only untranslated
one of the ten.

---

## 2026-08-22 — Inline marks: one canonical form, and the format's SECOND attribute

Two decisions, taken together because the second only makes sense inside the
first. Details in `spaces/src/marks.ts`; pinned in `scripts/test-spaces-model.ts`.

**A block's marks have ONE canonical spelling.** §2.3 asked for "fixed mark
nesting order, adjacent runs coalesced, no style" and only the middle third was
implemented: `canonicalize` was a fixed-point loop of `</b><b>` → `''` string
replacements, which cannot ask whether an `<i>` is inside or outside a `<b>`. So
`<b><i>x</i></b>` and `<i><b>x</b></i>` were both canonical — one visible string,
two byte spellings, and therefore a conflict in every diff and every future CRDT
merge. The order, outermost first, is

    a > mark > span > strong > em > u > s > sub > sup > code

and `b`/`i` FOLD to `strong`/`em` on parse (the markdown importer already emitted
the semantic pair; contentEditable emitted the presentational one, so files
already carry a mix). `a` is outermost because a link split in two by a bold
boundary is two links; `code` is innermost so its box hugs the text.

**The engine is a pure string function, not DOM surgery.** `document.execCommand`
is forbidden by §2.4(b) and ⌘B/I/U were calling it anyway. The replacement takes
(inline html, plain-text offsets) and returns inline html — so the hard case,
un-bolding half of a bold run, is pinned in a `node` rig instead of only in a
browser. The DOM appears in two functions at the bottom of the file that convert
a live Range to those offsets and back. `canonicalize` is now
`canonicalMarks(sanitizeInline(html))`: what is ALLOWED needs a browser, what
SHAPE it takes does not.

**Colour is a CLASS on SPAN/MARK, matched by PATTERN, and never a `style`.** The
vocabulary is Notion's — nine colours in two roles, `sp-fg-<name>` for the ink
and `sp-bg-<name>` for the band behind it — and a closed vocabulary is the whole
safety argument: the sanitizer matches a NAME instead of parsing CSS, and CSS is
a language with `url()` in it. The allowlist is `/^sp-(fg|bg)-[a-z0-9-]{1,16}$/`
and NOT an enumeration of today's nine, because of PLATFORM §3: with no server to
migrate anything, a build that strips what it does not recognise DESTROYS
documents written by a later one, so an enumeration would delete a tenth colour
added in two years, silently, on the next edit touching the block. A pattern
keeps it, round-trips it byte-for-byte, and renders it unstyled — degraded, which
is recoverable. Values live in the app's stylesheet, so they can be tuned for the
surface; an arbitrary hex in the document could not be.

**Colour survives printing, and this is deliberately the opposite of the callout
ruling.** A callout keeps its box, its rule, its tone's shape and its tone's
name, so dropping the fill costs nothing. An inline colour has no second cue:
drop it and the distinction the author drew is silently gone. `print-color-adjust:
exact`, scoped to inline marks only.

**Markdown: every mark the toolbar can apply exports, and imports back.** `mark`
→ `==x==`, which is native Obsidian syntax and a Pandoc extension, so it
round-trips outside this app too — the same standard the callout tones were held
to. `u`, `sub`, `sup` and colour → raw inline html, which GFM permits and which
is what Obsidian users fall back to as well; `_x_` for underline was rejected
outright because it re-imports as ITALIC, and a mark that comes back as a
DIFFERENT mark is worse than one that comes back as nothing. `htmlToMd` moved out
of about.ts (where it was a DOM walk and therefore untestable, and where it had
been silently dropping four marks) into marks.ts, over the same run list.

---

## 2026-08-22 — bento/spaces gets a CONTENT table, and its cells are strings

**Decision.** A `table` block: `rows` (row-major, each cell INLINE HTML), `cols`
(fractional column weights), `colAlign` (per COLUMN), `header` (absent = TRUE).
No formulas, no recalculation, no cross-document references — the line from
`working/design/spaces-design.md` §2.6. The database case is unaffected: it already
shipped as the tracker (`doc.fields` + `prop` + `view`), and this is not a
second one.

**A cell is a bare string, not slides' `{html, color, bg, bold}`.** Slides' cells
carry presentation because a canvas has no cascade; a space has a theme and a
stylesheet, and a spaces cell's content is already rich — bold in a cell is
`<b>`, through the same allowlist as every other block. So the entire `style`
object and every per-cell override go away, and the only thing left in a cell is
what someone typed. Alignment stays per COLUMN because that is exactly what a
GFM rule row can say; per-cell alignment would export as a lie on every row.

**`header` absent means TRUE**, which is the opposite of every other boolean in
the model and is deliberate: a pipe table always has a header, so the header case
is the one that should need no field, and a minimal hand-written
`{type:'table', rows:[[…]]}` is then a first-class document. A headerless table
exports with an EMPTY header row (GFM has no other way to say it) and the
importer reads that back as `header:false`, dropping the empty row — otherwise a
round trip grows a blank row each time.

**The `html` fallback is the whole of format additivity for a block type**, so it
is derived and rewritten on every table edit by the ONE writer (`writeTable`),
never authored. It is the cells' own inline html joined, not their text, so a
`#p/` link in a cell still produces a backlink (`buildIndex` reads `html`) and
still exports as a link from a build that has no table case. It costs a second
copy of the table's text in the file; a table that VANISHES in the build someone
already has is not the cheaper option.

**Shape is normalised at READ time (`tableOf`), never by repairing the file** —
the same rule as `effectiveParents`, so two readers agree without exchanging an
op and opening a space repairs nothing. Under collaboration `rows` is one
last-writer-wins register: two people editing different cells at once keep one of
the two edits. Slides' table has the identical limitation; the fix is a node per
cell, which is a format change, so it is written down rather than half-built.

**Editor chrome never goes inside an editable host.** The column grips first went
into the first row's cells and were written into the document as cell content —
and `caretToEnd` put the caret INSIDE the trailing `<button>`, so the first word
typed in a column landed in the button and was eaten by the sanitizer on blur.
They live in the wrapper now, absolutely positioned over each boundary. A cell is
`data-cell` + `data-r`/`data-c`, never `data-edit`: that name means "this
element's html IS the block's html", and the generic input handler would write
one cell over the whole table.

Details: `spaces/src/model.ts` (`tableOf`, `writeTable`, `tableFallbackHtml`),
`spaces/src/blocks.ts` (the registry entry and `tableToMd`), `spaces/src/render.ts`
(`renderTable`), `spaces/src/editor.ts` (`wireTables`, `tableKey`,
`startColResize`), `spaces/src/markdown.ts` (the pipe-table branch, which replaced
the "kept verbatim in a code block, mechanically upgradable the day a table block
ships" workaround), and the table section of `scripts/test-spaces-model.ts`.
## 2026-08-22 — spaces comments: the anchor IS where the thread is stored, and the block is why

**Two anchors, and no third.** A thread is about a BLOCK or about a PAGE. A
deck is a canvas, so slides can anchor a comment to an (x, y) and to nothing
else; a space is a tree of pages of blocks, and the block is the thing that
already has durable identity — ids are unique document-wide, never reused, and
are what links, backlinks and the CRDT key on. A text RANGE inside a block is
deliberately not an anchor: an offset pair has no meaning after the concurrent
edit that moved it, the format is permanent, and shipping the wrong answer now
would put it in every file. It is listed under "Not built yet" in
`spaces/README.md` rather than half-built.

**The anchor is expressed as STORAGE, not as a field.** `Block.comments` is a
thread about that block; `Page.comments` is a thread about the page. That is a
collaboration decision rather than a filing one. Under the shared engine
(`kernel/src/sync/crdt.ts`) every non-container property is one
last-writer-wins register per (node, key), so ONE `Page.comments` array — the
slides shape, transliterated — would make every thread on a page contend for a
single register: two people commenting on two different paragraphs in the same
moment, and one comment is gone with nothing said. Per block, that case
converges, because each block is its own CRDT node.

**The caveat that remains, stated rather than pretended away.** Two people
commenting on the SAME block concurrently, or on the same page, is still
last-writer-wins on that one array — the same limitation slides' table `rows`
carries, and for the same reason. Replies and resolve are in the array too, so
a reply that races another reply on the same thread can lose. Making that
converge means threads as their own CRDT nodes, which is an engine change, and
kernel changes are serialized (docs/PARALLEL-WORK.md). It is not shipped
blind: it is written in `model.ts` beside the type.

Storing on the block also settles two lifecycle questions for free: deleting a
block takes its threads with it (undoably, in the same step), and moving a
block to another page carries them along.

**Where the UI lives.** Not the gutter — a block already has one at the start
edge, and it holds exactly two controls because a phone reserves 44px and fits
one (2026-08-10, above); a third affordance there is a control no thumb can
reach. Not a sidebar panel — the sidebar is the page tree, the one navigation
this app has. Markers sit in the END margin, opposite the gutter, outside the
text column so they never reflow the prose they are about (measured: block
column ends at x = 1124.5, the marker sits at 1137.5). Page-level threads sit
in a row under the title. The thread itself is the editor's existing popover —
bottom sheet on a phone — so it dismisses like every other menu. The page tree
carries only a COUNT of unresolved threads, which is the one comment fact worth
knowing from another page.

**Editor-only, structurally.** `render.ts` — the single renderer behind the
editor, the reading view and print — has never heard of comments, and the
editor paints markers only when it is not in the reading view. Verified in a
real browser on the actual print tree: the whole-space print root rendered 11
pages, 0 markers, and no occurrence of the substring at all. The print
stylesheet drops them anyway, as a second line. `scripts/test-spaces-model.ts`
pins all three as source assertions.

**Comment text is PLAIN TEXT.** Not "sanitized like block html" — there is
nothing to sanitize, because nothing is ever parsed as html: the model stores a
string and the UI writes it with `textContent`. A comment arrives in a file
somebody mailed you, written by a person who is by definition not the author of
the document, and it has nothing to gain from bold. Verified in the browser: a
comment reading `plain <b>text</b> please` renders as those characters.

**The agent verb is READ-ONLY.** `bento.comments({resolved?, pageId?})` returns
every thread, flat, each stating its anchor. Acting on a remark is the agent's
job; resolving it is the commenter's — an agent that closed the thread it was
asked to address would make the record untrue. Every field is coerced to the
type the report promises, so a hand-edited file cannot make it throw halfway
through and tell the caller the first two pages are all there is.

**The name is `bento-author`**, the key the people panel already reads and
writes. Two keys would let one file disagree with itself about who you are.

**Cost.** +4,396 B on the shipped shell (166,482 → 170,878 B), inside the
existing 176,128 B ceiling (97.0%); no budget change.

## 2026-08-19 — The shells are packed with zopfli, and the format does not move

Every Bento file carries its whole runtime, so the packer's efficiency is a
property of every document anybody saves. Zopfli emits a stream in the SAME
deflate format as zlib, just searched harder — so the shipped loader is
untouched, already-saved files keep working, and an old updater splicing into a
new shell sees exactly what it saw before.

MEASURED, all four shells:

    spaces   173,598 -> 166,482    -7,116 B   4.10%
    slides   690,060 -> 663,760   -26,300 B   3.81%
    dash     169,617 -> 164,813    -4,804 B   2.83%
    type      33,899 ->  33,283      -616 B   1.82%

Verified rather than assumed, because "the format does not move" is the whole
argument. A zopfli payload handed to Chrome 148's native
`DecompressionStream('deflate-raw')` inflated to a byte-identical result
(SHA-256 matched) in 2.2 ms, and all four shells boot and render from
zopfli-packed payloads — checked in a browser, not only through the gate.

15 iterations, not 100: 100 buys 36 more bytes on spaces for three times the
time. The cost is about a second of build time per shell, paid once per
release.

THE DEPENDENCY IS PER APP, RESOLVED FROM THE CALLER. `scripts/` has no
package.json and neither does the repo root, so a bare import from
postbuild-compress.mjs would look in the wrong place — but every app runs the
script from its own directory, which is where `@gfx/zopfli` is declared. It
ships WASM embedded as JSON: no node-gyp, no compiler, no platform binaries,
140 KB, one transitive dependency. `node-zopfli` (native) would not have been
reproducible on CI.

A MISSING DEPENDENCY FAILS THE BUILD rather than falling back. Verified: exit
code 1, with a message naming the fix. A release quietly built 4% larger
because someone's node_modules was stale is a regression nobody would ever
notice. `ZOPFLI=0` is the deliberate escape hatch for a local build and says in
the same message that it is never for a release.

THE SPACES CEILING DOES NOT MOVE DOWN. 166,482 of 176,128 is 94.5%, and that
9,646 B of headroom is the point: the win is spent on the next feature rather
than banked by re-tightening the budget, which would have meant a fifth raise
the first time anything grew.

Two alternatives measured and rejected earlier, recorded so they are not
re-derived: BROTLI would save 20,580 B more but Chrome's DecompressionStream
accepts only deflate, deflate-raw and gzip, and a JS decoder costs more than it
saves; a DENSER PAYLOAD ALPHABET (basE91) would save 9,676 B but shell-gate.mjs
hard-fails any data block containing a literal `<`, and base64 is relied on for
being zero-`<` by construction against hostile payloads.

---

## 2026-08-19 — Page width has TWO settings, because it answers two questions

The per-page control shipped in #325 answered "this page needs the room". It
did not answer "I have a wide screen", and it made somebody say so on every
page in a space one page at a time. Reported as still-narrow after it shipped,
and MEASURED at a 2560px viewport: a 720px column using 31% of the area with
1,591px empty beside it.

Two settings now, and the split is the whole point:

  · `Page.width`  — DOCUMENT data. What this page needs; travels with the file.
  · `bento-sp-width` — VIEWER data, in localStorage. What this reader's SCREEN
    is; never written to the file.

Precedence: the page, then the reader, then the board default, then the
measure. A reader who sets it once gets it on every page that has not asked for
something specific, and the document is byte-unchanged — verified: four pages
at 1500px with no `width` key stored on any of them and no `"width"` anywhere
in the serialized doc.

That split is the rule locale and reduced motion already follow (PLATFORM §8):
two people opening one space on a laptop and a 27-inch monitor should each get
their own answer, and neither should write theirs into the file the other
opens.

THE BUILT-IN DEFAULT ALSO GROWS, `min(max(measure, 42vw), measure × 1.25)` —
720px on a laptop, 900px at 2560px. Capped deliberately: 720px is already ~88
characters at 16px, and past ~95 a line gets harder to read rather than easier,
so the cap is a typographic limit and not a shortage of nerve. Filling a 2560px
screen with one column of prose is not the goal; not showing a ribbon in the
middle of it is.

PRINT DOES NOT INHERIT THE READER WIDTH. Paper has a fixed width, and the size
of the monitor somebody happens to be sitting at is not a fact about the page
they are printing. Pinned in the rig.

---

## 2026-08-19 — How wide a page is belongs to the PAGE, not the theme

`theme.measure` is one number for the whole document — "text column width in px
— DOCUMENT data: the same for every reader". The right answer genuinely differs
per page, and the renderer already knew it: a page carrying a `view` block
silently jumped from 720px to 1500px, with a good comment explaining that a
board is not a line of text.

The problem was that it decided for you and offered no way to disagree. MEASURED
at a 1600px viewport: a 720px column with 631px of the page empty beside it, and
0 of the 15 blocks on the starter's Welcome page reaching the limit at all. The
line length was never the complaint — 720px at 16px is ~88 characters, already
at the upper end of comfortable. Having no say was.

`Page.width?: 'wide' | 'full'` now, offered in the page menu as Column / Wide /
Full width. It makes the board rule EXPLICIT rather than magic: a board page
with no key still gets its room, and a board page set to Column now gets to be
narrow.

THE DEFAULT IS AN ABSENT KEY, never a stored `'normal'` — the rule `editView`
already follows. A page somebody set to wide and back is byte-identical to one
never touched, and a file written before this control existed stays that way. An
unknown value from a newer build falls back to the measure rather than to no
width at all.

Not raised: `theme.measure` itself stays 720. Widening it would push past 88
characters for every page in the document to solve a complaint about empty
space, which is the wrong lever.

Measured after: column 720, wide 1500, full 1895 at a 2200px viewport; a board
page with no key still 1500. +1,128 B, no ceiling change.

---

## 2026-08-18 — The spaces topbar fits itself by measuring, not by px breakpoints

The bar folded at 820px and again at 600px. Those numbers moved once already
(720 → 820, because at 768 the save caret still ended 27px off the screen) and
they would have moved again, because a px guess cannot answer the question
being asked. The same buttons need different room at the same viewport width
depending on browser zoom, OS text scaling, live content, and — this is the one
that matters here — the reader's language.

MEASURED on the shipped shell at a 1600px viewport: the control group is 568px
in English and 618px in German. Fifty pixels the 820 threshold was never
calibrated for, in a file that ships eight catalogs so that any reader can open
it in their own language. The English-calibrated breakpoint was the only
calibration there was.

Three tiers now, applied by `fitTopbar()` stepping down while the bar still
overflows its own box: `sp-bar-compact` drops the button words, `sp-bar-tight`
drops the wordmark, `sp-bar-fold` moves whole controls into ⋯. A ResizeObserver
is the primary signal; a MutationObserver catches the content that changes
width at a fixed viewport (the people count arriving when somebody joins a
session). The observer must NOT watch `class` — fitTopbar's own tier flips are
class changes on that element.

THE SECOND COPY OF THE NUMBER IS GONE, which is the real win. `isPhone()` was
`matchMedia('(max-width: 600px)')` with a comment saying the number was
duplicated from the stylesheet on purpose; it decided what the ⋯ menu carried,
and when it disagreed with the CSS the symptom was a menu offering Undo while
Undo sat in the bar two centimetres away. It is `isFolded()` now and it reads
the tier off the bar — there is nothing left to disagree with.

The drawer breakpoint STAYS a media query (820px). Whether the page list is a
column or an overlay is a layout mode, not a question about whether things fit,
and slides keeps its own for the same reason.

Follows bento/slides #239, which settled this first.

---

## 2026-08-18 — Presence in a space is a page, shown in the tree

bento/slides paints collaborator cursors on its canvas, because a deck IS a
canvas and "where is that person" means a position on it. A space is a TREE,
and the useful question is which PAGE somebody is on — a caret position two
levels down a wiki tells a reader nothing they can act on.

So presence lives in the sidebar: a coloured initial on the page each person is
reading, three of them and then a count. It costs one span per person, it is
visible without opening anything, and it is what makes a shared space feel
inhabited rather than merely synced. `SyncHost.presence()` already reported the
page rather than the block for the same reason (a block-level cursor would
republish at typing speed).

THE BUTTON REPORTS THREE STATES, NOT TWO, and this was got wrong twice before
it was got right. Same-machine tabs sync over BroadcastChannel with no relay at
all, so "has peers" and "is online" are different facts:

  · online, with people  — Live, and how many
  · peers but no relay   — another window on this computer; NOT shared online
  · neither              — not sharing yet

The first version showed a peer count of 1 under the words "Not sharing yet",
which is a control contradicting itself in a single glance. The second fixed
the button and left the same conflation in the panel, which listed nobody while
that person's dot was visible in the tree two inches away. The panel's LIST now
follows who is here; only its ACTIONS follow the relay.

TWELVE OF THE TWENTY-FOUR NEW STRINGS WERE LIFTED WORD-FOR-WORD from the
bento/slides catalogs rather than reworded — the refusal messages, join/leave,
"Your name", "Start live session". They were already written, reviewed and
translated into eight languages; rewording them would have cost eight fresh
translations to say the same thing and let the two apps drift on the one
message a user only sees when something has gone wrong.

---

## 2026-08-18 — A shared space connects on open; a fresh one still does not

bento/spaces follows the rule bento/slides already ships: `shareEligible()` —
auto-connect on open ONLY if the document arrived carrying collab credentials
(it was saved, or somebody shared it), or if the user opted in during this
session. A never-saved starter space and a template someone is kicking the
tyres on stay dormant.

The alternative was to connect whenever credentials exist. That is the obvious
call and it is wrong here for a reason this repo has already paid for: v0.9.0
of slides connected every visitor to the anonymous demo and v0.9.1 had to undo
it. The rule is also already written down for this app — "A space does not
phone home when it is opened" (2026-08-03) — and nothing about collaboration
changes what that promise means.

Worth being honest about the wrinkle, because it is the reason to revisit
rather than close this. A space is a whole wiki, so "open the file somebody
mailed me" is a far more ordinary act than opening a deck, and that file
carries credentials by construction: the capability IS the file. Receiving a
space therefore joins its room, which is what the sender intended and may not
be what the reader expected.

TO BE REVISITED WITH bento/vault, which is where per-recipient access stops
being a property of the file and starts being something a broker can answer.
Until then the file is the capability and this rule is the whole of the
protection. Decided by the user, 2026-08-18.

---

## 2026-08-18 — The healed page's id comes from the ROOM, not from docId

The kernel's `heal()` contract is explicit that a repair does not converge by
itself: it is minted as an ordinary local op, and two replicas that heal at the
same moment mint two nodes which the CRDT faithfully keeps. It tells an
implementer to derive the id from stable document data, and it suggests
`docId`.

**bento/spaces must not use `docId`**, and the reason was already written down
next to `repairId` in model.ts before collab existed: `template: true` re-mints
`docId` on every open, so a docId-derived id gives two readers of ONE file
different ids — precisely the failure derivation exists to prevent.

`doc.collab.room` is the right seed. Every replica that can race to heal is by
definition in the same room; the value is identical for all of them by
construction; and it does not move when a template is opened. The fallback to
`docId` is safe exactly where it is reached — a document with no room has no
second replica to disagree with.

Pinned by scripts/test-sync-spaces-session.ts: two replicas with the same room
and DIFFERENT docIds still heal to one page.

Also settled while binding: "empty" for a space is ZERO PAGES, not an empty
page — and a dangling `doc.home` is NOT a repair case, because `homePage()`
already falls back to `pages[0]` on its own. Minting a page for it would
manufacture a phantom to fix something that was never broken.

---

## 2026-08-18 — 'doc' is this app's dirty signal, so a remote op must not raise it

The kernel session used to emit `'doc'` after every remote change, because that
is what bento/slides calls "something changed, repaint". In bento/spaces the
same name means something else: editor.ts binds it to `status('Edited')`, the
unsaved dot and the undo buttons. Emitting it for a colleague's keystroke would
put "Edited" in this user's chrome for someone else's work.

The kernel now takes `changeEvents` and `structureEvents` from the app. Spaces
declares `changeEvents: ['page']` and `structureEvents: ['tree']`: 'page' is
bound to paintPage + paintTree and carries no status text, so it repaints
without claiming authorship, and 'tree' covers a structural change to a page
other than the one on screen.

The first version declared `changeEvents: []`, reasoning that repaints could
ride on the structural events alone. That is wrong and the rig did not catch
it — two browser tabs did. A remote TEXT edit is not structural, so nothing
fired: `block.html` held the new sentence while the DOM still showed the old
one. Every remote change must repaint; only the authorship claim was ever the
thing to withhold.

The dot still has to move: the file on disk IS out of date, however the change
arrived. The kernel calls `store.setDirty(true)` independently of the events,
and store.ts routes that to its own `'dirty'` event, which the editor binds to
the dot alone. Two facts, two signals, instead of one signal asked to carry
both.

A REMOTE APPLY ALSO BYPASSES `commit()` — deliberately, so it never joins this
person's undo stack — which leaves `store.index` describing the document as it
was. `clampView()` therefore calls `reindex()` before anything reads the index.
This was not theoretical: measured, a block that had already arrived in
`doc.pages[0].blocks` was invisible to `store.block(id)`, and the first version
of the rig hid it by reindexing by hand.

---

## 2026-08-18 — Where a reader lands when somebody deletes what they are reading

A deck clamps an INDEX. A space navigates by page identity (`#p/<id>`), so the
only question is whether the page you are reading still exists — and when it
does not, `reindex()`'s own fallback sends you to the home page, out of the
part of the space you were working in.

`clampView()` surfaces at the nearest surviving ANCESTOR instead, falling back
to home only when the whole chain is gone. It needs `captureView()` for that:
after the apply the page is simply gone and there is nothing left to be near.

Presence reports the PAGE and never the block. A block-level cursor would
republish presence at typing speed — the typing run in store.ts exists because
a notes app may never blur — while a page changes only when somebody
navigates, which is the rate presence is worth.

---
## 2026-08-16 — Creating a document: every host VERIFIES the release it downloads

**Decision.** Starter shells are bundled in no host (settled separately the same
day: they change too often, and there are three apps with more coming), so
fetch-from-the-release-channel is the ONLY way any tray host creates a document.
That path must therefore verify, in this order, in every host:

1. fetch the manifest **as text** — it is a signed envelope, `{payload, sig}`,
   and the fields (`app`, `version`, `sha256`, `url`) are inside the payload
   STRING; there is nothing useful at the top level;
2. verify the ECDSA P-256 / SHA-256 signature over the payload's **exact UTF-8
   bytes** (no canonicalisation) against the release public key;
3. check the payload's `app` matches the channel being read — the channels are
   sibling paths on one origin, so a genuine manifest from the wrong path hands
   somebody a different application;
4. download the shell and check its sha256 against the payload's pin;
5. only then touch a file handle. A refusal writes **nothing**.

**Why.** The shell is executable HTML written to the user's own disk, which they
subsequently double-click and trust. Without the chain, whoever can answer for
the release origin — compromised host, bad CDN edge, hostile-network proxy —
chooses what code the user creates. Signature over the pin, pin over the bytes;
neither half is worth anything alone.

Step 3 is the one that is invisible to the other two, so it is the one that gets
skipped: a `bento-slides` manifest and a `bento-dash` manifest are both
genuinely signed by the same key, and the shell each points at really does hash
to what its payload pins. Serving one on the other's channel passes the
signature AND the digest — every byte authentic, just not what was asked for.
Only identity catches a swap between two REAL releases, which is exactly what
survives an origin or CDN compromise where the attacker cannot forge but can
re-serve. The check must be made against the app that was **requested**, not
against the payload's own claim about itself, and an ABSENT `app` must not read
as a match. (`tray/ios` found both native hosts missing this while reviewing
webext's rig — PR #315, PR #318.)

**Ask for BYTES: send `Accept: */*` explicitly on every release fetch.**
Measured against the live shell URL on 2026-08-17, independently by tray/ios and
tray/webext: the wildcard returns 689,316 bytes and matches the signed pin; a
browser's own `Accept: text/html,…` returns 689,675 and does not. The extra 359
bytes are a Cloudflare Web Analytics beacon the edge injects before `</body>`
into anything it reads as a page being browsed. Same URL, same `.bento.html`
extension both times, so the trigger is the header — fortunate, because a
path-keyed injection could not be avoided by any host. Most platforms already
default to the wildcard; set it anyway, because the default is the platform's
and not ours. (An earlier note that this was "fixed at the origin" was wrong and
is retracted — it is live as of this entry.)

**NO DOWNGRADES: every host keeps a per-app version floor.** Decided by Andy on
2026-08-17, after `tray/ios` implemented one and `tray/webext` held pending the
call — it is a policy trade, not a pure security win, and three hosts
half-adopting it would be worse than one landing late. A replayed OLD release
passes signature, app identity AND digest: it is genuinely signed and its shell
really does hash to its pin. Only memory catches it, because a document being
created carries no version to be monotonic against (unlike the shell's own
update, which measures from its running build). Two details that bite:

- **Raise the floor only AFTER the downloaded bytes pass their hash.** Raising
  it on a merely-verified manifest lets one forged-but-unfetchable release lock
  the host out of every real release below it — a failed attack made permanent.
- **An EQUAL version must be accepted.** Re-fetching the version already held is
  the normal case (the second document somebody creates), and refusing it breaks
  creation on its second use rather than at some exotic edge.

An unreadable store reads as NO floor: availability over protection in a case
that is not an attack. An unparsable version component sorts as 0 rather than
throwing — verified identical in `kernel/src/update.ts`, `tray/webext`'s
`compareVersions` and `Releases.swift`, since `Number('x')` is NaN and
`NaN || 0` is 0. **The accepted cost:** a deliberate maintainer rollback is
refused until the version moves past the floor. That is the same trade
`kernel/src/update.ts` already makes, so the whole system is at least
consistent.

**A 404 on a channel is an ANSWER, not a fault.** Only Slides is published
today; the app list is aspirational on every host. All three say
"<App> has not been released yet" rather than surfacing an HTTP status.

**Proving the verifier REFUSES is a separate obligation from writing it.** A
verifier only ever watched saying yes is indistinguishable from `return true`,
so each host's rig runs the real captured manifest plus deliberately bad ones.
Three cases are worth naming because each catches something the others cannot:

- **A valid signature under the WRONG key** is not the same test as a bent one.
  Bending bytes proves a non-validating signature is rejected, which almost any
  bug-free crypto call manages; a signature that validates PERFECTLY under an
  untrusted key is what catches a verifier that imported the wrong key, or that
  would trust a key travelling inside the manifest. No test seam is needed —
  sign the real payload with a throwaway key and hand it to the shipped
  verifier. (The NEGATIVE cases must never go through an injected key, or a
  verifier that trusts one passes its own tampering tests.)
- **An unsigned manifest is refused as a CATEGORY**, not as a parse error. A
  flat `{url: …}` is exactly the shape the old broken reader wanted, so
  "malformed" invites someone to add a lenient fallback for it later as a
  compatibility gap. It is not a gap.
- **An absent `app` field must not read as a match** — `undefined !== 'bento-x'`
  passes by construction, and a plausible tidy-up to `info.app && info.app !== x`
  silently turns a missing field into a pass.

**Status.** `tray/webext` done (`src/release.js`, used by `library.js
newDocument`); `tray/ios` done (`Releases.swift`, PR #315); `tray/android` in
progress.

**Pointers.** `kernel/src/update.ts` is the reference implementation
(`verifySigned` / `fetchPinned` / `verifyManifest`) and hosts should reuse it
where they can import it. The extension **cannot** — it ships as unbundled ES
modules Chrome loads from disk, and adding a bundler would mean the shipped
package is no longer the reviewed source — so `tray/webext/src/release.js` is a
deliberate line-by-line mirror, with the resulting obligation stated in the
file: *if the key or the envelope format moves in the kernel, it moves here
too.* `scripts/test-webext-release.ts` pins both ends against a REAL captured
manifest (`scripts/fixtures/release-manifest-slides.json`).

**The failure this came out of, because it generalises.** `newDocument` read
`manifest.url` off the envelope's top level, where there is no `url`, and so
threw on every invocation: the `+` button had never worked in any version. Its
rig passed, because the fixture was written to the shape the CODE expected
rather than the shape the SERVER sends. A fixture that is not the real shape
proves only that the code agrees with itself — hence the captured manifest, and
hence the same warning for android and ios.

## 2026-08-16 — iOS document search: CoreSpotlight is the surface, and the port is pinned to the LIVE reference

**Decision.** `tray/ios` implements the search settled below. Three things that
the Android port and any future host should follow or knowingly diverge from:

**1. On iOS the "native list" is a screen BESIDE the document browser, and the
system index is a first-class output.** `UIDocumentBrowserViewController` stays
the root; search is one toolbar button away from it. The extracted prose is also
donated to **CoreSpotlight**, which is what the original gap statement ("the app
contributes nothing to search — no CoreSpotlight, no `NSUserActivity`") actually
asked for, and Spotlight results are resolved back through the index rather than
by re-deriving a path. Android has no equivalent obligation; its recents list IS
its root, so it has one surface where iOS has two.

**2. TWO checks, because they catch different things.**
`scripts/test-tray-index.mjs` runs both:

- **against the shared corpus** (`tray/fixtures/`, with `tray/doc-index.mjs` as
  the reference and `expected.json` as the answer key). This proves all three
  hosts give the same frozen answers — including Kotlin, which nothing on a Mac
  running the Swift rig can execute. Budgets are checked too: a port that agreed
  on every case while carrying a different `TEXT_BUDGET` agrees by luck.
- **against the RUNNING `library.js`**, imported live — `describe()` is exported
  and takes injectable deps, so a fake file handle runs the real code path.

The second is not redundant. A frozen answer key pins each port to a SNAPSHOT:
when `library.js` moves, static expectations go stale silently and every host
stays green while drifting from the thing they are copies of. Importing the
reference means it cannot move without a rig failing. Verified 2026-08-16: the
Swift port agrees with both, on all 11 corpus cases and on 59 documents against
the live reference.

**The corpus contract is the one to conform to where they differ.** It folds
`isDocument` into the same call and returns nulls throughout for a file that is
not ours; `library.js`'s `describe()` always returns a title, falling back to the
file name, because its caller sniffs first and it never faces a non-document.
`BentoIndex.describe` follows the corpus and the LISTING supplies the file-name
fallback — which is the better seam anyway: inventing a title during extraction
reports one for a file that is not a Bento document at all.

**3. Ports must count UTF-16 code units.** The reference is JavaScript, where
every index, length and budget is UTF-16; the natural Swift/Kotlin spelling uses
graphemes or code points and disagrees on any document containing an emoji or a
CJK character — that is real documents, not pathological ones. One deviation is
allowed and is written down in `BentoIndex.swift`: the final `slice(0, 40KB)` can
land inside a surrogate pair, and where JavaScript keeps the lone half a Swift
`String` cannot hold one, so it is dropped. The rig accepts exactly that shape
and nothing looser.

**Also:** enumeration needs a folder grant the app did not previously take
(folder-mode `UIDocumentPickerViewController`, persisted as a security-scoped
bookmark). Each indexed document gets its OWN bookmark, minted inside the
folder's open scope, because a file in a granted folder is readable only while
the FOLDER is scoped and an editing session outlives the walk. Encrypted
documents are never read for text or preview, and revoking a folder deletes its
documents from CoreSpotlight — both enforced in `LibraryIndex`, not just
described. Parity table: `tray/README.md`.

## 2026-08-16 — Document search: the list stays native, the indexer is shared by FIXTURE

**Decision.** When the native hosts grow a document library, each keeps its own
**native list UI** and ports the text extraction itself; the three
implementations are held together by **one shared fixture corpus**, not by a
shared runtime. Specifically NOT by moving `tray/webext`'s `home.html` /
`library.js` into a WebView on the native hosts.

**The gap this is about.** The three surfaces are at three different levels, and
only one of them can search:

| | what "search" means there |
|---|---|
| `tray/webext` | scans every granted folder; matches title, file name, folder, **and the document's own prose** (`library.js extractText`) |
| `tray/ios` | the system document browser's search field — **the app contributes nothing to it** (no CoreSpotlight, no `NSUserActivity`) |
| `tray/android` | **none**; a recents list sorted by last-opened |

`extractText` is the valuable part: up to 40KB of prose per document, pulled out
of the `#bento-doc` block as string VALUES (`:"…"`, never keys), data URIs
stripped first. Deliberately not a JSON parse, so it is format-agnostic across
slides/spaces/dash and degrades to "finds less" rather than throwing. It is free
in I/O because the same read already produced the thumbnail. That is what lets
someone find a deck by a phrase on a slide rather than by what they named the
file.

Both platforms CAN support this — it is a "not built" gap, not a "can't" one.
Android has `ACTION_OPEN_DOCUMENT_TREE` (a persistable whole-directory grant,
near-exactly `showDirectoryPicker`); iOS has the document picker in folder mode
(a security-scoped directory URL).

**Why the shared-WebView-library option was rejected.** Three costs, in
descending order of severity:

1. **iOS would throw away `UIDocumentBrowserViewController`,** which is not a
   list but a surface: Browse into iCloud Drive, Dropbox and every File Provider
   on the device, drag-and-drop, in-place rename, favourites and tags, the
   system's own sort and view controls. An HTML grid replaces all of that with
   less, and contradicts the property `tray/README.md` claims — *on iOS the app
   is a lens onto the filesystem; on Android it is a keyring*. **Android has
   nothing to lose here**, which is the asymmetry that makes a single shared
   answer wrong.
2. **Cold start costs ~0.5s,** on the first screen of every launch. MEASURED
   2026-08-16, Pixel 7 / Android 16 emulator, both cold: native list root
   **1171ms** (1241ms on a repeat) against WebView root **1728ms**. That is an
   emulator on Apple silicon, so treat it as a FLOOR — WebView provider load is
   I/O and CPU bound and a mid-range phone widens the gap. iOS was not measured.
3. **Accessibility stops being free.** Native lists get VoiceOver/TalkBack,
   Dynamic Type and system font scaling correctly with no effort; in a WebView
   Android's font-size setting does nothing unless `WebSettings.textZoom` is
   wired, and Dynamic Type does not reach web content without explicit work.
   Predictive back and interactive dismiss are native on a native screen and
   reimplemented in a WebView. `home.html` is also a desktop-first grid with a
   sidebar and would need a real mobile design pass, not a media query.

**The reasoning that settles it: the UX cost sits entirely in the part that does
not need sharing.** What is worth sharing is the INDEXER — pure data work, no UI.
The chrome is what costs cold start, accessibility and the iOS browser, and the
chrome is exactly what should stay native.

**Why this differs from `tray/bridge.js`, which IS shared.** That file is shared
because its semantics are subtle and a divergence is catastrophic and silent —
its comments record a bug that wrote users' documents out as zero bytes. Text
extraction is string scanning with a documented budget: a divergence makes search
find less, which is visible and recoverable. So the right guarantee is weaker and
cheaper. Trading "cannot diverge" for "cannot diverge SILENTLY" is the correct
trade at this level of consequence, and it is already this repo's idiom for
exactly this problem — the splice contract has a conformance gate in
`release.mjs`, the save-purpose ids have `scripts/test-savepurpose.ts`.

**Status (2026-08-16, later): BUILT ON ANDROID; iOS still to do.** The shape
above survived contact. `tray/doc-index.mjs` is the reference, `tray/fixtures/`
is the corpus (11 cases), `scripts/test-doc-index.mjs` and a JVM unit test hold
the JS and Kotlin implementations to it, and `tray/android` indexes granted
folders and searches their prose. The iOS session has been handed the same brief.

Two things the corpus caught that reasoning had not:

- **A single string value over 400 characters is not indexed at all.** The value
  regex is capped at `{1,400}`, so a long speaker note or a wordy text element is
  invisible to search — in all three hosts, today. Pinned by `longvalue.html` so
  no port can quietly "fix" it into divergence; changing it has to be a
  deliberate change everywhere.
- **JavaScript's `\s` is Unicode-aware and Java's is not** (and Java's
  `UNICODE_CHARACTER_CLASS` still excludes U+FEFF), so a port spelling it `\s`
  leaves non-breaking and ideographic spaces in the indexed text and a phrase
  search across one silently fails. The class is written out in full;
  `whitespace.html` catches it, verified by mutation.

**Thumbnails are in, and the reasoning that nearly excluded them was wrong.**
"the preview is HTML, so a native list needs a WebView per row" conflated two
different things: a WebView per scrolling row (the design this entry rejects) and
ONE offscreen WebView at index time producing cached bitmaps (which costs nothing
at launch and leaves the list plain `ImageView`s). The second is the obvious
design and it was talked past. Details and the three ways an offscreen render
silently produces the wrong picture: `tray/README.md` § Document search.

Parity table: `tray/README.md` § Android.

## 2026-08-16 — bento/tray gets an Android host (PR #87, rearchitected)

**Decision.** `tray/android/` is a document host, written against the same two
decisions as `tray/ios`: the document is served through an origin we control,
and the app ships **file access only** — no bundled runtime, no OTA channel of
its own.

It lands as **PR #87** (savrum, opened 2026-07-26), which asked the right
question first: Android needs a native host for the same reason iOS does. The
branch keeps that original commit and builds on it. Its `native/ios` half is
superseded by `tray/ios`, which arrived in the meantime; its Gradle and keystore
scaffolding is the shape used here; and the `isElementFullscreenEnabled` flag
`tray/ios` briefly used was found there.

What did NOT survive is the **architecture**, which is the one tray deliberately
rejected:

- it BUNDLES a deck and OTA-fetches a newer one from the GitHub releases API on
  every launch. tray's whole thesis is the opposite (`tray/README.md`, "What it
  is, and what it deliberately is not"), and an unsigned OTA — which the PR's own
  README flags — contradicts `docs/PLATFORM.md` §1 as well as the signed-update
  invariant.
- every save calls `ACTION_CREATE_DOCUMENT`, so Bento's 2.5s autosave write-back
  would open a file picker on a loop. It has no in-place path at all.
- the page is loaded from `file://` (opaque origin: unreliable `localStorage`
  and IndexedDB) and the shim is injected from `onPageStarted`, which races the
  boot-time capability check.

**Three Android-specific findings worth not rediscovering.**

1. **Write access is not implied by receiving a document.** `ACTION_VIEW` from a
   file manager grants READ ONLY; only the app's own `ACTION_OPEN_DOCUMENT`
   yields a persistable read+write grant. Checked per document
   (`canWriteInPlace`), and when false every save becomes a Save-As — the
   "when in doubt, prompt" rule the whole project already follows.
2. **`androidx.webkit` is a required dependency, not a convenience.**
   `addDocumentStartJavaScript` is the only true `.atDocumentStart` equivalent,
   and `addWebMessageListener` is **origin-scoped** where `addJavascriptInterface`
   is injected into every frame — a remote iframe in an untrusted document would
   otherwise be handed a channel that writes the user's file.
3. **`fitsSystemWindows = true` REPLACES a view's padding, it does not add to
   it** — and from targetSdk 35 edge-to-edge is mandatory, so insets must be
   applied by hand. Same for `enableOnBackInvokedCallback`: it stops
   `onBackPressed` being called at all on API 33+, so an override alone compiles,
   runs, and silently does nothing.

**A host must implement the page-dialog delegate, and BOTH lacked it.** Building
the Android host surfaced a bug that had been shipping in `tray/ios` too. Neither
`WKWebView` nor Android's `WebView` shows `alert`/`confirm`/`prompt` on its own,
and without the delegate they do not merely skip them — they answer wrongly and
say nothing: `alert()` is a no-op and **`confirm()` returns `false`**. Every one
of the runtime's seven uses is shaped `if (!confirm(…)) return`, so delete a
slide, remove a collaborator, reset access, replace all slides and embed an
oversized file all silently did nothing when tapped. Fixed on both
(`WKUIDelegate`, `TrayChromeClient`) and verified on both: iOS through
"Start from scratch…", Android over CDP (`true` on OK, `false` on Cancel).
Android additionally needs `onShowFileChooser` or `<input type="file">` cannot
open at all, which is how images, media and fonts get into a deck — restored
from #87's `native/android`, which had it.

**Parity is written down, not assumed.** `tray/README.md` § Android carries a
row-per-behaviour table of iOS against Android, marking each as the same, a
platform-forced difference, or a gap. The one gap is the status bar (iOS hides it
on iPad; Android does not on tablets), left undone because it cannot be tested
without a tablet target.

**The launcher icon is GENERATED from the shared mark**
(`tray/assets/make-icons.mjs`, with `--check` for CI). Android vector drawables
have no `<rect>`, so every rounded rectangle has to be re-expressed as path data
— four opaque `M…A…V…Z` strings nobody would ever diff against the SVG, so a
change to the mark would land on iOS and silently miss Android.

**`tray/bridge.js` is now SHARED** by both native hosts (was
`tray/ios/Resources/bridge.js`). The transport is ~15 lines at the top; the rest
is `FileSystemWritableFileStream` semantics whose comments record the bug that
wrote documents out as zero bytes. Forking that file forks that bug.

Details and verification state: `tray/README.md` § Android.
## 2026-08-10 — No dark topbar for now; THEMES are the right shape for it later

**Decision.** Every Bento app keeps the shared light chrome. A dark navy topbar
was prototyped on the real slides and type builds and is NOT being adopted as a
one-off. What is wanted instead is a proper light/dark theme layer across all
apps, of which a "contrasting" navy-topbar theme would be one option.

**Why.** The prototype looked good on light content — and the accent argument is
real, `#f7a600` is a faint tint on `#f5f7fa` and a clear focal point on
`#1e2a3a`, which is the brand's own navy+orange. But it fails on its own terms
in two places: the bar's dropdown MENUS and popovers stay light, so a dark bar
with light menus hanging off it reads as unfinished; and slides' content
luminance varies (the starter deck alone runs #0D1B2E / #F2F0EA / #FF9E8A), so
on a dark deck the bar merges with the slide and destroys the separation a dark
bar exists to create. Scope was measured, not guessed: the slides topbar alone
carries 25 distinct `ed-*` control classes, and a ten-line override missed one
immediately and shipped an invisible Save button into the comparison.

**What this implies now.** App chrome must refer to TOKENS only, never literal
colours, so a theme layer is a later addition rather than a rewrite.
`type/src/styles.css` is written that way and should stay that way.

**Pointers.** Tokens are shared verbatim by `slides/src/styles.css`,
`spaces/src/styles.css` and now `type/src/styles.css`.

---

## 2026-08-10 — bento/type: the app is named, and a block stores TEXT + MARKS, not HTML

**Decision.** The word processor is `bento/type`; `doc.format` is `"bento/type"`
and, like every format id, cannot be renamed once a file exists. Its block model
is plain text plus a list of marks over character ranges
(`{ t:'b', from, to }`), NOT an HTML string and not inline nodes. HTML is what
`inline.ts toHtml()` renders; it is never what is stored.

**Why.** Four things the app already depends on need a plain-text spine, and all
four break against HTML: the redline diffs text word-by-word (against HTML a
formatting change reads as a rewritten sentence); signatures cover a canonical
form (canonicalizing HTML means ruling on attribute order, tag case, whitespace
and entity spelling — four ways two honest parties produce different bytes for
one document); the caret is a model position, forced by measurement, because
with hyphenation on the renderer inserts characters and any rendered-space
address drifts; and footnote anchors are already offsets into the same string,
so marks reuse that rule rather than adding a second concept.

The cost is mark arithmetic, in one file, pinned by `scripts/test-type-inline.ts`
(38 checks incl. a 2,000-case fuzz) — which caught two bugs no hand-written case
found: a mark silently truncated when another overlapped it, and same-kind marks
failing to re-merge after a render split them (423/2,000).

**Pointers.** `type/src/inline.ts` (the argument is in the file header),
`type/src/model.ts` (tagged `parseDoc`, following the spaces load contract:
an unreadable file must never become an empty one), `scripts/test-type-model.ts`.
Design + the measured spike behind it: `working/design/type-design.md` and
`working/type-spike/RESULTS.md` (gitignored) — Path A, continuous pagination,
Knuth–Plass viable live.

---

## 2026-08-06 — The tree is DERIVED at read time, in one function, and it cannot cycle

**Decision.** `model.ts effectiveParents(page)` is the only answer to "what is
this block nested under": `b.parent` iff that block is in the SAME page and
appears STRICTLY EARLIER. Anything else — absent, itself, later — resolves to
the root. `descendantsOf(page, id)` is built on it. Every consumer delegates.

This implements the rule settled on 2026-08-03, which until now existed as a
paragraph and four disagreeing implementations: positional in `render.ts`, a
hop-capped graph walk in `blocks.ts mdLayout`, a fixed-point sweep in
`agent.ts descendants` ("rather than trusting the order"), and an id lookup in
`editor.indent`. They agreed only because the editor keeps the array in
pre-order — which is exactly the invariant collaboration breaks.

**DERIVE, NEVER REPAIR.** Normalising the array instead would mint `ord` ops and
two replicas can ping-pong over them forever. A read-time function mutates
nothing, so two replicas that agree on the array agree on the tree without
exchanging one extra op.

**Acyclic by construction, which is the point.** A parent must be earlier, so no
document — authored, hand-edited, imported or merged — can produce a loop. That
removes a whole class of defence: no visited set, no hop cap of 32, no
fixed-point sweep. `blocks.ts` capped at 32 because the graph could cycle, and a
markdown export that silently truncated at depth 32 is a quiet wrong answer
rather than an error.

**The failure it prevents.** On a merged `parent` cycle the old sweep returned
the whole connected component INCLUDING the node itself, so `planRemoveBlocks`
deleted blocks the caller never named.

**Verified against documents the merge actually produced**, not hand-built ones:
250 merged documents, 1,695 blocks, 24.4% of them violating flat pre-order —
zero rule failures, no cycles, no self-parents, no subtree containing its own
root. `scripts/test-sync-spaces.ts` now asserts this on every merged document
forever, and the negative control (reverting to a raw graph walk) fails 13
blocks out of 405.

**`Store.tree()` gains a visited set, and surfaces what a cycle orphans.**
`buildIndex` bins pages by `parent` with no position test, so two concurrent
sidebar drags converge on A.parent=B, B.parent=A. Neither is reachable from the
root, so both pages vanished from the sidebar AND from the Markdown export while
still sitting in the file, with nothing saying so; a subtree call from inside
the cycle recursed until the stack gave out. Orphaned pages are now listed at
the root — pages you can see and re-home beat pages that quietly stopped
existing.

**Still a page-level graph sweep in `planRemovePage`**, deliberately: it
terminates, and cascading a cyclic pair is what a caller asking for descendants
gets. Named here so the next reader knows it was considered rather than missed.

## 2026-08-06 — bento/spaces will not stamp the text token history, and that is only safe if everyone is lean

**Decision.** `toJSON({ text: false })` omits `txt` from a stamped state.
bento/slides keeps stamping it — every file in the field was written that way,
and the equivalence gate compares those bytes. bento/spaces will not.

**The measurement.** The token history is one entry per character, each ~26
bytes with an id, and a deletion cannot remove one — a tombstone is how
"delete" reaches a replica that has not caught up, so the history only grows.
An emptied paragraph still carries everything ever typed into it (measured:
"hello" → 159 B; type " world" → 297 B; delete it again → **333 B**; empty the
paragraph → **363 B**).

**But the cost is EDITING, not text**, which was not obvious and changes where
it matters. Identical prose, two ways of arriving:

| | stamped state | ratio |
|---|---|---|
| pasted / imported / written by an agent | 2,978 B | ×0.2 |
| typed in ~40-character runs | 479,825 B | ×25.8 |

161× apart for byte-identical content. Text that arrives as one write never
engages the RGA at all. Slides survives this because slide text is titles and
bullets; a space IS typed prose, and the state would outweigh the document
inside the plaintext `#bento-doc` block, re-serialized on every save,
re-parsed on every open, and written to IndexedDB every 2.5s.

**Why not garbage-collect the tombstones instead** (what Yjs does by default,
and it is worth being accurate that dropping the history is NOT the industry
norm — Yjs GCs, Automerge keeps everything and pays for it with a binary
encoding). GC needs to know every replica has seen the delete. A file people
mail to each other has no closed set of peers and no moment when that becomes
true — a copy can come back out of a mailbox a year later. The causal cutoff
that makes GC safe never arrives here.

**THE PRECONDITION, and it is not a detail.** A restored state with no token
history does not fall back to whole-value sets, as first assumed: the differ
RE-SEEDS a generation from the current content, and the seed is derived from
that content plus the register stamp. Two replicas that both re-seed derive the
SAME seed and still merge per character — measured on one shared paragraph,
"Friday"→"Monday" from one side and an appended sentence from the other, both
kept, byte-identical on both sides, from a stamp 10.9× smaller.

A replica that re-seeds meeting a peer that still holds the ORIGINAL generation
is a different story. The generations duel as units and the loser's edit
disappears — measured: **the two documents do not converge.** A live session
keeps the tokens in memory, so "save, close, reopen, rejoin a room that is still
live" is exactly that case.

So a lean stamp is safe only when EVERY participant is lean. **The session layer
must treat "restored without `txt`" as needs-a-snapshot, not as resume** — rejoin
by taking a peer's snapshot through `mergeSnapshot` rather than replaying from
where the file left off. That rule does not exist yet because spaces has no
session; `scripts/test-sync-shape.ts` carries the evidence and the note so it
cannot be written without it.

---

## 2026-08-06 — A journal entry is a page with a DATE on it, and the date is never the title

**Decision.** `page.journal` holds an ISO `YYYY-MM-DD`. That field, not the
page title, is what makes a page a daily entry. The title starts as the same
ISO string and the author may rename it freely.

**Why not Logseq's model.** Logseq derives a journal from its page title,
formatted by `:journal/page-title-format`. Their own tracker carries the
consequence — "Changing journal filename format causes blank journals and data
loss" (logseq/logseq#4019) — because the moment the format changes, yesterday's
journals stop being journals. A title is display; a date is data. Three things
follow from separating them, and none are available to a title-derived design:
the FILE is locale-neutral (a space written in Tokyo shows a Lisbon reader their
own format, because the label is rendered through `Intl` at display time and
never stored, per PLATFORM §8); search, grep and the Markdown export all see
`2026-08-06`, which sorts and is unambiguous in every locale; and a build that
predates journals renders an ordinary page and round-trips the field untouched.

**Created on demand, never one page per day.** Logseq makes a journal page every
day you open the app — on a filesystem that is a cheap empty file. A space is
ONE file people mail to each other, so a page per unopened day is permanent
weight for nothing.

**Entries sort by DATE in `doc.pages`, not by creation.** Inserting each new
entry after the Journal page gives reverse-creation order, which looks sorted
until someone backfills yesterday. Found by looking at the sidebar in a browser
after the node rig was already green.

**The date arithmetic is the whole risk, and it fails on other people's
machines.** `toISOString().slice(0,10)` is UTC, so "today" is the wrong day for
hours at a time outside Greenwich; `+ 86_400_000` is not a day on the two DST
boundaries each year; `new Date('2026-08-06')` is UTC midnight by spec. A
digit-shaped non-date like `2026-13-99` must be REJECTED rather than formatted,
because every Date-based formatter silently rolls it into some other real day.
`scripts/test-spaces-journal.ts` runs in five timezones in CI, including
Australia/Lord_Howe's half-hour DST offset — a date test that runs in one
timezone has not been run.

## 2026-08-06 — One CRDT engine, two document shapes, and the shape is never on the wire

**Decision.** `kernel/src/sync/crdt.ts` takes a `DocShape` at construction: two
property names — the doc key holding the parent array, the parent key holding
the child array — plus a derived set of doc keys it must never sync.
`slides/src/sync/crdt.ts` is a facade binding `SLIDES_SHAPE` and exporting
`SyncState`; bento/spaces binds `('pages','blocks')` the same way. The engine
knows nothing else about any app's content.

**Bound at construction, never serialized, never on the wire.** A room is
single-app by construction — the room id is minted per file — so no frame has
to say which shape it came from, and a shape tag in `SyncStateJSON` would
change the bytes of every bento/slides file already on a disk.

**NO DEFAULT on the shape argument.** A default is how a spaces call site
silently ends up holding slides' shape, and a room minted that way cannot be
repaired: the files are on other people's disks.

**`skipDoc` is DERIVED, not authored.** It must contain the container key: the
container is synced structurally, per node with its own position key, so
listing it as an ordinary doc property would collapse the whole document into
ONE last-writer-wins register. Measured — a shape omitting its own container
fails six checks in `scripts/test-sync-shape.ts`.

**THE WIRE VOCABULARY IS FROZEN FOR EVERY APP.** Ops keep saying
`kind:'slide'|'element'` and carrying `sl`/`el` regardless of shape. Renaming
per app buys prettier debug output and costs a second binding on the
highest-consequence bytes in the system. Settle it before spaces collab reaches
a user; after that, spaces files carry the choice permanently.

**Parameterize, THEN move.** The engine was parameterized in place and moved to
the kernel second. Moving first would have parked `doc.slides` and
`sl.elements` inside `kernel/src/` for a PR, against kernel/README.md's own
rule that the kernel never sees an app's content shape.

**What guards it.** `scripts/test-sync-equiv.ts` proves the NEGATIVE (the
engine still mints the bytes the field was written with) against a FROZEN copy
of the engine as shipped; `scripts/test-sync-shape.ts` proves the POSITIVE (a
second shape produces an engine that works and restores as itself). Neither
suffices alone: a parameterization that quietly did nothing passes the first, a
broken one passes the second.

## 2026-08-06 — bento/spaces converges under the shared engine, and converges on documents the format calls illegal

**Measured, not argued.** `scripts/test-sync-spaces.ts`, 400 seeds × 100 steps
× 4 actors, 17,227 ops, the kernel engine bound to `('pages','blocks')`:

- **Convergence is perfect.** Every replica agrees, every seed. The engine
  serves spaces as a CRDT with no change to its algebra.
- **52.4% of merged documents violate the spaces format** (209 of 399 seeds
  whose solo document was provably legal). Worst case in one document: 5 page
  cycles, 5 dangling page parents, 3 dangling block parents, 3 pages out of
  pre-order, 1 block out of pre-order, 1 duplicated block id.

The CONTROL matters as much as the result: each seed also runs a lone replica
through the same edits, receiving nothing, and a seed whose solo document is
already illegal is EXCLUDED rather than counted. Without it every number above
could have been the generator's fault. It caught three generator bugs while
this was being written — a cross-page move that orphaned children, a page
re-parent that inserted before its new parent, a subtree walk that missed
grandchildren — and the first draft of this entry overstated the finding by 36
points.

**Why it happens, and why it is nobody's bug.** `page.blocks` is flat and in
pre-order — "a child always follows its parent, so one forward pass rebuilds
the tree" — while the engine stores order as fractional position keys and
`parent` as an ordinary LWW register. Two independent merge domains describe
one visual tree. You indent a block, I move one; both edits are legal, both
apply, every replica agrees, and no forward pass can rebuild the result.
`render.ts renderBlocks` does not crash on it — it silently renders the block
at root, un-nested.

**Three things that must be settled before a spaces file carries collab
state**, because none can be corrected once files exist on other disks:

1. **Pre-order vs `parent`.** Derive the tree at render time and tolerate any
   array order, or repair after apply. A repair that COMMITS mints `ord` ops
   and can ping-pong between replicas forever — so if it repairs, it must
   derive, not commit. The effective-parent rule (2026-08-03) is the right
   rule and is implemented in exactly one consumer (`render.ts`), while
   `blocks.ts mdLayout`, `agent.ts descendants` and `editor.indent` use graph
   semantics. One exported function, invariant asserted.
2. **Page cycles.** `Store.tree()` recurses from the root with no visited set,
   so a merged cycle makes pages vanish from the sidebar AND the markdown
   export while still being in the file. `editor.reparentPage` refuses cycles
   locally, which two concurrent drags defeat by construction.
3. **Duplicate block ids.** The engine duplicates a node on concurrent moves to
   two parents BY DESIGN (docs/collab-design.md) — in slides that is the morph
   idiom and it is correct. In spaces, block ids are unique document-wide,
   `buildIndex` keys blocks by bare id, and `#p/<page>/<block>` anchors assume
   it. Same behaviour, opposite verdict.

**Status of the rig.** It asserts convergence and the control, and REPORTS the
format violations: failing the build on them would assert an answer nobody has
chosen. `STRICT=1` turns every one into an assertion — flip it in CI the day
the three decisions land, and the rig becomes their enforcement rather than
their evidence.

## 2026-08-10 — Magic notes: the expression is stored, the answer is derived, and there is no eval

**Decision.** A line whose text ends in `=` gets an answer rendered after it.
The document stores what was written — `budget * 0.3 =` — and never the number.
`spaces/src/calc.ts` is the evaluator; `render.ts` derives per page in one
forward pass.

**Why derived and not stored.** Change `budget = 5000` to 6000 and every line
below re-answers, because nothing downstream was frozen — measured in the
browser: 750 → 1,950 and 480 → 720 from one edit, with the file still holding
only the expressions. It is the rule slides settled for dynamic fields, and it
also means the file stays plain: search, grep, the Markdown export and a build
that predates this all see `budget * 0.3 =`, which reads as prose. No new block
type, no attribute for the sanitizer to strip.

**The trailing `=` is an OPT-IN, and that is the feature.** A notes app where
every line with numbers became a calculator would be unusable — "we shipped 3
of 7" is a sentence. The parser must consume the WHOLE line or return nothing;
a partial parse is a refusal. The rig spends as many assertions on what must
NOT answer as on what must.

**NO `eval`, NO `new Function`, and it is a security boundary.** Block html
comes out of a file somebody mailed you, and sanitize.ts exists so nothing in a
document can execute. Reaching for the JS parser to evaluate `2+2` would hand
that back. A recursive-descent parser over a fixed grammar can only return a
number.

**`sum above` means the run of figures DIRECTLY above.** Summing every number
on the page was the first behaviour and it was confidently wrong: on a page
with a budget, three expenses and two other answers it reported 78,732 where
the reader means 515. A heading, a sentence, a definition or another answer
ends the run — a subtotal is where a group finishes.

**Order matters, and it is fed AFTER each block is drawn.** Feeding before
meant an answering line cleared the very run its own answer needed, and
`sum above` read 0. After means a line sees what is above it and nothing of
itself.

**Precision is a note's, not a physics paper's** — 2 decimals above 100, 4
above 1, 6 below. `584.088921 mi` is noise around `584.09`.

**Dates and times use the local calendar**, for the reasons journal.ts records:
UTC makes "today" the wrong day for hours at a time outside Greenwich, and a
day is not 86,400 seconds on the two DST boundaries. `2026-08-10` is lexed as
ONE token — as three, it parses as 2026 minus 08 minus 10 and answers 2008,
which is the worst bug this file could have.

## 2026-08-03 — Sync parameterization is gated on BYTE equivalence, not convergence

Making `slides/src/sync/` serve spaces (`doc.pages[] → page.blocks[]`) by
parameterizing it over a document-shape descriptor is the agreed approach — but
`scripts/test-sync.ts` cannot police it. It proves CONVERGENCE: replicas of the
SAME engine agree. An engine that converges beautifully with itself while
minting different ops, position keys or lamport stamps than the shipped one
sails straight through it, and then every bento/slides file in the field —
each carrying persisted `SyncStateJSON` and talking to the deployed relay —
silently splits from its own copies, unfixably.

So the gate is `scripts/test-sync-equiv.ts`: run baseline and candidate off one
seeded PRNG stream and assert the emitted BYTES are identical (op batches with
field order, `SyncStateJSON`, materialized doc), per step, per actor, plus a
scripted suite for `adopt`/`mergeSnapshot`/`fromJSON`/`missingFor`. It carries
four convergent-but-different mutant engines as a self-test, because it passes
trivially until the candidate import is repointed and a comparator that has
never failed proves nothing. **No parameterization work merges without this rig
green in LIVE mode.** Fixtures now live in `scripts/lib/sync-fixtures.ts`,
shared by both rigs, so the two never drift into different opinions of what an
edit is. Wired into CI beside the convergence rig.

## 2026-08-02 — dash budgets BYTES with consent, not rows with a refusal

**Supersedes the hard stop proposed in the dash design doc §3.2** (refuse at
1,000,000 rows or 25 MB, on the importer and every other write path). The two
guards it sat on top of are unchanged and are not optional.

**What stands, because the failure past the budget is SILENT.** Measured at a
539 MB file: the `#bento-doc` element still holds exactly one child text node,
of length **zero**. `textContent` returns `''` — a string, no throw — so the
workbook opens EMPTY, and self-save then re-splices whatever is in memory over
the user's file. Unrecoverable loss caused by a successful parse of nothing. So,
from the first commit that can save:

1. `parseDoc` returns a tagged result, never `null`. Only an **absent or empty**
   block boots the starter document.
2. **Refuse to serialize if the boot parse did not succeed** — a hard error
   surface offering "Save an untouched copy" and "Copy document JSON", with the
   editor and autosave disabled.

Those two are what prevent the data loss. The row cap was belt-and-braces on
top of them, and it costs precisely the users who know what they are doing.

**What changes:**

- **Budget in BYTES, not rows.** 1M × 12 is 65 MB; 1M × 2 is ~10 MB and
  comfortable. A row cap refuses workable files and admits unworkable ones.
  Excel's 1,048,576 is a *structural* limit users have learned; ours would be a
  proxy for a quantity we can measure directly.
- **Warn, then take informed consent — never refuse.** Past the ceiling, say
  what will actually break, in this browser, with numbers.
- **The threshold scales with `canWriteInPlace()`** (`kernel/src/save.ts:470`).
  With the File System Access API a save is an in-place write; without it —
  Safari, Firefox, every iOS browser — every ⌘S downloads the whole file to
  `~/Downloads`, so the practical ceiling is far lower. One global constant
  cannot express that.
- **Import offers an alternative, not a no**: the first N rows, an aggregate, or
  the whole thing with the warning accepted.

**The target is unchanged at 100,000 rows × ~12 columns (~6 MB)** — where the
file emails under attachment limits, downloads in a second, round-trips as JSON
per PLATFORM §7, and the 2.5 s autosave rewrites it imperceptibly. It is a
target, not a cap.

Compute is not the constraint and is not close: hand-written columnar JS over
typed arrays, zero dependencies, single-threaded, measured on **10,000,000
rows** — scan-sum 5.9 ms, filter+sum 10.6 ms, two-dimension group-by 11.5 ms.

## 2026-08-02 — `bento/dash` is settled, and it stands for DAta SHeets

**Keep `bento/dash`.** The name contracts **DA**ta **SH**eets — the two halves
of the app, the typed data model and the grid. It is not short for "dashboard";
a dashboard is something the app can produce, not what it is.

Recorded because the 2026-07-24 naming entry justifies it as "spreadsheet +
tables + dashboards", which leads with the output surface and reads as
mis-scoped. That framing is what caused the name to be re-opened and argued at
length today. Don't re-open it without a new argument.

This blocked the first commit that writes a `FORMAT` constant — PLATFORM §3
puts the string into every saved file and there is no server to migrate
anything — and it is now unblocked.

**Weighed and set aside** (collisions verified live, not recalled):

- `cells` — best suite fit, but it sounds like Ex**cel**. A replacement that
  echoes the incumbent's name reads as derivative of it.
- `views` — genuinely dual (a SQL view *and* a visual view), but it names
  *looking* when the app's own boundary rule is *reckoning* ("does it
  recalculate → dash").
- `measures` — the BI term of art, and the convergent pick of two independent
  root analyses, but "bento measures" parses as a verb clause.
- `base` — its retirement reason above has **inverted**: it was dropped partly
  for reading as "database, which this platform does not have", and dash now
  is one. Set aside as flat rather than wrong; reconsider only if `dash` ever
  proves to mis-signal in the field.
- `figures` parses as a verb clause; `grid` collides with "bento grid", an
  established UI design-trend phrase; `rows` is rows.com, a live "AI Data
  Analyst" product; `calc` is LibreOffice Calc, and is clipped besides.

**Namespace was deliberately down-weighted.** PyPI `dash` is Plotly's dataviz
framework and npm `dash` is the cryptocurrency, but the app never ships as a
bare word — it is `bento/dash`, at `bento.page/dash`, in
`Bento_Dash.bento.html`. That is the mitigation the 2026-07-24 entry already
prescribes for the crowded Bento namespace: always carry the `bento/<app>`
form and the descriptor.

## 2026-07-28 — Vault is a capability broker; identity is multi-user from commit one

**Refines the 2026-07-27 vault entry rather than superseding it.** Three
capabilities arrived separately — AI, live data, key distribution — and are one
shape: **vault brokers what a travelling file structurally cannot hold** (a
secret, a private network, an authority). That definition is the test for what
belongs in vault and what does not.

Settled:

- **Vault configuration lives in the SHELL, never the document** — a second
  plaintext `#bento-vault` block under the same splice contract. In the document
  it would travel with the content and leak an internal hostname to anyone
  emailed a deck. "Export for outside" strips it, visibly.
- **A minted shell points its update channel at the vault.** Not a choice:
  `serializeWith(shell, doc)` (`kernel/src/save.ts:322`) re-splices into a
  freshly fetched shell and discards everything else, so shell config survives an
  update only if the update comes from the vault. Needs a visible "return to
  upstream" escape so a defunct vault cannot freeze former employees' files.
- **Dual signatures.** Canonical runtime = the file minus `#bento-doc` and
  `#bento-vault`; its sha256 must match upstream's signed manifest, and the vault
  signs its config BOUND to that hash. A compromised vault can then redirect
  endpoints but cannot ship modified editor code. Build in v1 — unaddable later.
- **Documents carry a query NAME, never query text.** The vault maps names to
  parameterised statements defined by an admin. Otherwise every deck anyone opens
  is an exfiltration tool against the database.
- **A bound document always carries its last known values.** A vault connection
  refreshes data, never supplies it, or "works with no network" falls by another
  route.
- **A vault refresh is a COMMIT, not a derivation.** Linked charts derive
  identically on every replica today; a fetch does not (two replicas fetching at
  different moments get different rows). Extend `scripts/test-sync.ts` first.
- **Archival is reinstated; backup stays cut.** Different products. Copying bytes
  is solved; being able to OPEN them in ten years is not, and a Bento archive
  renders itself and stays machine-readable as plaintext JSON with no vendor in
  the loop. Vault produces the archive shape; restic moves it.

**Who it serves, re-argued and resolved.** Three of the capabilities (live data,
retention archive, private release channel) are properties of a DEPLOYMENT rather
than a person, so the org case got stronger; the case against did not weaken,
because it rests on maintenance surface — every org-shaped pillar implies
multi-user identity, and that is what a single maintainer carries indefinitely.
Resolution: this decides what we PROMISE, not what we build — broker, index and
archive serve one user and fifty identically. Ship single-user and promise
nothing organisational, **but design the identity model multi-user from the first
commit**: per-user query authorisation and spend attribution cannot be retrofitted
without migrating every deployed vault. The gate for building organisational
features is a real stated requirement, not a count of pillars.

## 2026-07-27 — Thumbnails: plain markup plus a parser-blocking remover, NOT `<noscript>`

**Supersedes the 2026-07-26 entry below** on the one point of where the preview
lives. Everything else in it still stands: written at save time, replaced never
appended, `PREVIEW_BUDGET` tiers, and above all **encrypted decks get no
preview**.

`<noscript>` renders only where scripting is DISABLED, and iOS satisfies
neither half of that. Probed with a page that is red by default, turns green
from an inline script, and carries a blue `<noscript>`, the iOS thumbnailer
renders **RED** — it runs no script AND does not render `<noscript>`. So the
feature worked in Finder and macOS QuickLook and did nothing on the platform it
was built for; every deck in Bento Tray stayed a dark box.

That same gap is the fix. A renderer that runs no script still renders ordinary
markup, and every real reader does run script — so the preview ships as a plain
`[data-bento-preview]` element with a **parser-blocking inline remover**
immediately after it. The thumbnailer keeps the preview (it never runs the
remover); the reader never sees it (the script executes before the browser
paints). Measured: at removal `document.readyState` is `"loading"` and
`performance.getEntriesByType('paint')` is EMPTY — zero frames containing the
preview were ever presented. Not a fast flash; no flash.

The 2026-07-26 entry chose `<noscript>` to avoid exactly that flash, and
accepted "a thumbnailer that does run scripts sees no preview" as the trade.
Both halves turned out to be wrong about iOS, and the replacement costs neither.

**A QLThumbnailProvider extension does not work and should not be retried.** It
registers correctly (`pluginkit` shows `SDK = com.apple.quicklook.thumbnail`)
but its process never launches: iOS uses its own generator for `public.html`
and does not consult third-party extensions for types it already handles.
Likewise `NSURLThumbnailDictionaryKey` via `UIDocument.fileAttributesToWrite`,
which is accepted and then silently dropped for local files — inspecting the
xattrs afterwards finds only `com.apple.lastuseddate`.

`previewIsSafe` is now MORE load-bearing, not less: the preview lands in the
live DOM rather than sitting inert inside `<noscript>`, so the refusal that
keeps a script tag out of it protects the page and not just the file structure.
`shell-gate.mjs` gained two source assertions — that the remover is emitted at
all, and that it sits immediately after the preview, since anything between
them is markup a browser could paint first.

---

## 2026-07-27 — bento/vault is the ORG service point, and the AI broker is what forces it

**Supersedes the 2026-07-25 "personal server" entry.** Vault is not a personal
document library. It is the **service point for a group of people and their
documents**, self-hosted on hardware that group owns.

The reframe came from subtraction. Of the five promises in the old entry, four
were met or taken while it sat unbuilt: mobile reach went to `bento/tray` plus
any existing File Provider (iCloud Drive, Dropbox), sharing went to the collab
relay (the file IS the capability), per-device version history went to
`kernel/src/autosave.ts`, and plain file sync was never ours. What survived
personally was **search alone**, and it has since been narrowed by measurement:
Spotlight indexes rendered HTML text, so the `#bento-doc` script block is
invisible to it — but the save-time preview is ORDINARY MARKUP now (the
thumbnails entry above), and markup indexes. Measured 2026-07-28 with
`mdimport -d2 -t` on a deck saved from the current shell: the whole title slide
comes back in `kMDItemTextContent`, and a token planted on slide two does not.
**Page one is already searchable for free; the unmet need is FULL TEXT.** One
real problem — now a smaller one — does not need a personal server.

**The AI broker is the pillar that makes vault necessary rather than nice.** A
self-contained document travels, so it can never carry a model credential — that
is emailing your API key to everyone you share the deck with. `localStorage` is
per-device, and under tray it is per-DOCUMENT (the origin is
`bento-tray://<sha256 of path>`, `EditorViewController.swift`), so it degenerates
into configuring a key per deck. The only place a credential can live once and
serve a whole library is a server the group runs. **In-app AI is architecturally
impossible without something vault-shaped**, and the same index serves both
search and retrieval. Points a local model (Ollama on the same box) at the
library without anything leaving the network, which is the existing README claim
made real.

**SSO gates distribution, never the file.** Once someone holds the bytes they
open them forever, offline, with no server — that is the product, not a bug. SSO
can gate access to the vault and the distribution of decryption keys (the
`bento/enc` envelope and the owner→invite→member chain already exist for this).
Revocation is therefore FORWARD-ONLY: a revoked member keeps what they already
downloaded, exactly as `collab-design.md` already documents for devices. Say this
before an enterprise security review discovers it.

**The org profile deletes most of the hard design.** NAT traversal,
hole-punching, WebRTC, the dead-drop and the portable relay twin all exist to
serve one case: a personal laptop asleep behind a home NAT. A company vault is a
box on a network with a hostname and a certificate, reached directly. So
`relay-design.md` steps 2–5 are NOT v1, and neither are the equivalent vault
steps.

Corollary worth stating plainly: the org vault **is** a custody service, and that
is correct — central custody is the point of centralising. The personal vault
explicitly was not. Those were two products wearing one name; we are building the
org one.

**New invariant — AI is additive, never load-bearing.** Every app stays fully
functional with no vault and no model, the same rule as "vault is optional". If
an AI feature ever becomes required to edit, `PLATFORM.md` §1 is gone.

**Sequencing: the org deployment is the DESTINATION, not the first build.**
Architecturally this costs nothing — a single-user vault IS the org vault with
one user: same index, same key chain, same broker. Build that, design toward
multi-user, promise neither.

**Licence:** the runtime stays MIT (`THIRD_PARTY_NOTICES.md` is embedded in every
saved file, so copyleft on the shell would attach to every document a user
emails). Vault is a separate repo with its licence chosen at commit #1. Never
relicense slides.

## 2026-07-26 — File-manager thumbnails: a `<noscript>` render of page one, written at save time

**Decided:** 2026-07-26. Kernel zone (`kernel/src/save.ts`), so it binds every
Bento app; the drawing is per-app (`slides/src/preview.ts`).

**The problem.** Thumbnailers render a document's HTML but do not run its
JavaScript, so every Bento file thumbnailed as the same dark box — correctly,
because before the runtime boots every deck *is* the same bytes plus the boot
splash. Confirmed on iOS, and confirmed that the iOS-side escape hatch does not
exist: an image attached via `UIDocument.fileAttributesToWrite` under
`NSURLThumbnailDictionaryKey` is accepted and then silently dropped for local
files (only `com.apple.lastuseddate` survives on disk). **The fix has to live
in the file.** So `serializeBody` now writes a static rendering of page one
into the shell on every save, and it fixes every platform at once with no
native extension anywhere.

**`<noscript>`, not "render it and let JS remove it".** The obvious design —
always paint the preview, have the runtime delete it at boot — flashes page one
in front of every reader on every open, for as long as the 600 KB payload takes
to inflate. `<noscript>` has exactly the semantics wanted: its contents are
rendered only when scripting is off, which is precisely the audience.
Empirically the DOM proves it, not just the spec — with scripting on the host
node has **zero element children** (its content is one raw text node) and a
bounding box of 0×0, so there is nothing to flash, nothing in layout, nothing
for print or present to exclude. The cost is that a thumbnailer which *does*
run scripts sees no preview — i.e. today's behaviour. A regression is not
possible, only an improvement.

**Scaling: `transform: scale(calc(min(100vw, <aspect>vh) / <width>px))`.**
CSS Values 4 length-over-length division yields the plain `<number>` `scale()`
needs, so the whole page scales as one unit and every inline px the renderer
emitted is left alone. **`<svg viewBox><foreignObject>` was tried first and does
not work**: Chrome renders it correctly, QuickLook's WebKit does not
(absolutely-positioned children disappeared, content scaled non-uniformly), and
QuickLook is the renderer this feature exists to serve. Verify changes here
against `qlmanage -t -s 640 -o <dir> <file>` — the real macOS thumbnailer, and
the only honest test. Chrome's `--blink-settings=scriptEnabled=false` suppresses
`--screenshot` entirely in Chrome 150; drive `Emulation.setScriptExecutionDisabled`
over CDP instead.

**Encrypted decks get NO preview — the load-bearing rule.** A plaintext
rendering of page one beside a `bento/enc` envelope hands over the title slide,
usually the most disclosive page, and does it invisibly. `previewAllowed()`
checks the in-memory password flag AND re-parses the body as an envelope,
because those fail independently. Removal of any existing preview is
UNCONDITIONAL and happens before that decision, so a deck that gains a password
loses its preview on the next save.

**Shell furniture, not format.** Nothing enters `#bento-doc`; no format field
is added; old files open unchanged; an app that registers no provider (spaces)
saves as before. The preview is replaced, never appended — `capturePristine()`
snapshots the file as loaded, so the clone already carries the previous save's
copy.

**Budget: 64 KB** (`PREVIEW_BUDGET`, slides/src/model.ts), ~10% of the shipped
shell. Measured: starter deck 25 KB (2.6% of the file); a page-one chart 11 KB;
a table 16 KB; a page with a 2.5 MB photograph degrades to 1.7 KB. Over budget,
page one re-renders with raster payloads replaced by tinted boxes; over it
again, a title card. Downscaling a hero photo instead would be
better and was NOT done: image decode is async and `serializeWith`/
`serializeFile` are synchronous (update.ts, `window.bento.serialize()`), so an
async provider is a kernel API change of its own.

Guards: `scripts/test-preview.ts` (encryption veto + the refusal to emit markup
carrying a script tag or `</noscript>`), and `scripts/shell-gate.mjs`, which
now also proves a preview-carrying file satisfies the splice contract and
asserts both rules are still wired into the save path.

## 2026-07-26 — A language pack lives in the FILE and nowhere else

No browser-local install. A "keep it on this computer" option (localStorage)
was **built and then removed**, because `localStorage` is scoped per ORIGIN
and that is fatally misaligned with how Bento is used: the download comes from
`bento.page` (an https origin) and the file is then opened from disk (a
`file://` origin). A language added on the website was therefore GONE the
moment the user saved the deck and reopened it locally — the exact journey the
product encourages, and "I added Korean and it vanished" is not a bug a user
can diagnose.

One home also matches the platform: the file *is* the software, so a language
belongs to the deck. The trade — adding a language requires saving the file —
is stated plainly in the UI ("Added when you next save") rather than hidden.
Adding is staged on click and written on the next save because on browsers
without File System Access, writing on click means silently downloading a
second copy of the user's deck.

Corollary: anything that remembers pack *content* outside the file
reintroduces this. Viewer *preferences* (locale, reduce-motion) stay
browser-local on purpose; that asymmetry is deliberate. Details:
`docs/i18n-packs.md`, `slides/src/packs.ts`.

## 2026-07-26 — The pack carrier is generic; pack POLICY is not. This is not a plugin system.

The kernel mechanism is already extension-agnostic and should stay that way:
`registerShellBlocks` / `readShellBlocks` (`kernel/src/save.ts`) carry
arbitrary typed blocks in the shell and know nothing about languages, and
`registerUpdatePrepare` (`kernel/src/update.ts`) is a generic "refresh
version-bound extras" hook. Signature verification and hash pinning are being
made generic in the kernel too (branch `claude/i18n-pack-verify`). Reuse all
of that freely.

**Do not generalize the policy.** Language packs are DATA and their worst case
is bounded — a tampered or stale pack shows wrong or English words. That bound
is why degrade-per-string, keep-on-refresh-failure, and auto-refresh on update
are the right rules *for packs*.

Anything carrying CODE is categorically different: unbounded failure (it would
hold the document, the file handle, and the collab keys), and it breaks the
property that makes self-update trustworthy — that the shell only ever runs
bytes from a signed release. Such a thing would need its own policy (pinned at
install, never auto-refreshed) and must not inherit the pack rules by reusing
the pack machinery.

So: reuse the carrier and the crypto; do not treat "we have packs" as evidence
that a plugin system is designed or wanted. It is not.

## 2026-07-26 — Side-loaded artifacts: sign the index, pin the bytes, fail closed

Language packs are fetched over the network, so they get the **same two-step
the app shell's own update already gets**: an envelope signed with the release
key (`{payload, sig}`, ECDSA P-256 / SHA-256) whose payload pins each
artifact's `sha256`, and a download that is accepted only if its bytes hash to
that pin. Signature over the pin, pin over the bytes. **No second key and no
second trust root** — `PUBLIC_KEY_JWK` in `kernel/src/update.ts` is it.

The mechanism lives in the kernel (`verifySigned`, `fetchPinned`) because it is
the same for anything side-loaded; the *policy* stays in the app
(`slides/src/packs.ts`). Keep that boundary: the kernel helpers verify BYTES,
they do not decide what is safe to use. Packs are DATA with a bounded failure
mode (wrong words on screen), which is why a pack that fails a refresh is kept
at its existing version rather than dropped. Anything side-loaded that ever
carries CODE needs stricter policy — pinned at install, never auto-refreshed —
and must not inherit the pack rules by reusing the same fetch.

**Fail closed, no legacy path.** An unsigned or unpinned index yields no
listings at all. Nothing is published yet, so there is no permissive fallback
to keep — and one added later would mean whoever answers for the channel picks
the strings in the UI.

**A pack already inside a file is NOT re-verified** (`readPacksFromShell`). It
was verified at the door, and once spliced it carries exactly the trust the
document does — anyone who can rewrite that block can rewrite the checking
code too. Re-verifying would need the network at boot, which breaks offline
use. Proof rig: `node scripts/test-packs.ts` (throwaway key, real crypto).

## 2026-07-26 — Language packs are published under a SIGNED INDEX, separate from the manifest

Amends the "Signing and release" paragraph of `docs/i18n-packs.md`, which said
the update manifest would gain a `packs` array. It does not.

`release.mjs` emits the packs and signs **one index** over all of them at
`releases/slides/packs.json` — the same `{payload, sig}` envelope, the same
offline key, and literally the same signing code as the manifest (extracted to
`scripts/sign-payload.mjs`). Each listing pins its pack's `sha256`; individual
packs are not separately signed. Clients verify the index once, then hash each
download against its signed hash.

Why not inside the manifest: shipped files ignore a manifest that is not
strictly newer than themselves (downgrade-replay protection), so pack hashes
carried there could never be corrected **between** app releases — and a fixed
translation is not a new app version. A separate index is re-issuable any day,
and `manifest.json` keeps meaning exactly one thing: here is the app shell.
Signed code and signed data stay two artifacts.

Still one key, still local-only signing, and `publish-site.mjs` now gates the
index the way it already gates the shell (indexed pack missing, hash drifted,
or packs staged with no index = refuse to publish). Details and the exact
payload shape: `docs/i18n-packs.md` §"Signing and release"; `scripts/sign-packs.mjs`.

## 2026-07-25 — i18n: a bundled core of 9 languages, everything else a signed pack

The 7 non-English catalogs cost **115,572 B** of the shell even after key-once
packing — more than any dependency, and an English-only shell is 28.8%
smaller. But we want *more* languages, not fewer. So: **bundle a core, ship
everything else as signed downloadable packs.**

- **Bundled (9):** the existing 8 (en, ja, zh-Hans, zh-Hant, es, fr, de, it)
  plus **Portuguese**. Nothing regresses for current users; Portuguese is
  added because Brazil has a real English-proficiency gap and it is in the
  cheapest cost tier.
- **Everything else:** a pack, signed with the existing release key and
  released centrally alongside each app release, fetched only on explicit user
  action and spliced into the file.

**No further languages get bundled by default** — demand declares itself
through contributions (#17 offers Korean), and a pack can be revised without
cutting an app release.

Measured facts worth not re-deriving: cost is **~14 KB per language regardless
of script** (CJK is the *cheapest* — 2.6× the bytes per character but a third
of the characters). Simplified↔Traditional conversion on the fly does **not**
pay: only 43.3% of characters match, because the difference is vocabulary
(软件/軟體) not glyph form, and deflate already recovers the genuine redundancy.
Rank candidate languages by the **English-proficiency gap in the segment that
uses this tool**, not by speaker counts — which is why Hindi is not in the core
despite 610M speakers.

Full design, risks and status: **`docs/i18n-packs.md`**. The risk that will
ship broken if ignored: **self-update must carry packs forward** — `update.ts`
re-splices the document into a *new shell*, and packs live in the shell.

## 2026-07-25 — Every PR gets human review before merging to main (for now)

At this stage of development the maintainer reviews **every** PR before it
lands on `main`, including agent-authored ones. No auto-merge. The point is
visibility into what the agents are actually producing while the multi-agent
workflow is still being shaken out — the cost is throughput, and that is
currently the right trade.

Supporting config, already in place: `main` is branch-protected with one
required approval, and CI (`validate`) is a **required status check**, so a red
build cannot merge. Admin bypass stays enabled for the maintainer.

### FUTURE ACTION — revisit when review becomes the bottleneck

When PR volume outgrows one reviewer, consider auto-merging **app-zone** PRs on
green CI. If that happens, these paths must **always** require human review
regardless, because a bad merge is either silent or catastrophic:

- **`kernel/src/`** — every app depends on it.
- **`slides/src/sync/`, above all `crdt.ts`** — convergence bugs are silent and
  corrupt documents. The rig is necessary but not sufficient: it only generates
  short strings, which is why it missed the large-text stack overflow (#47).
- **`server/`** — one bad deploy breaks live collaboration for everyone at
  once, and there is no per-user rollback.
- **`scripts/release.mjs` / `sign-release.mjs` / `keygen.mjs`** — the signing
  and release path.
- **Anything touching the `#bento-doc` splice contract or the update-manifest
  shape** (`PLATFORM.md` §2, §6) — these brick files already on users' disks.

Do not enable auto-merge without that exclusion list encoded somewhere
enforceable, not just written down here.

## 2026-07-24 — Naming: the platform is `bento`, the mark is `bento/.`, all lowercase
Settled after working through the whole namespace. **Do not reopen these** —
each rejected candidate was rejected for a specific reason, recorded below.

- **Platform: `bento`** (lowercase). Not "Bento Box", not "Bento Suite" — the
  bare word is the family, and `bento/<app>` reads as members of it.
- **Wordmark: `bento/.`** — the trailing dot stands for the platform (the apps
  complete the slash). This is a MARK, not a name: `/` is a path separator and
  is illegal in filenames, URLs, package names and social handles, and
  punctuation is disregarded for trademark purposes. Anywhere a name must be
  stored or typed, it is `bento`.
- **Casing: lowercase everywhere**, brand and machine alike. This deliberately
  collapses the usual split (`Docker` the brand / `docker` the command)
  because the lowercase form is already the file's own identity — `doc.type`
  is `bento/slides`, the MIME type is `application/bento+json`.
- **Apps:** `bento/slides` (shipped), `bento/spaces` (Notion/notes-like),
  `bento/dash` (spreadsheet + tables + dashboards — absorbs what would have
  been a separate database app), `bento/vault` (document library / personal
  storage). A word-processor app is planned; **`bento/folio` is the proposed
  name, NOT yet confirmed** (alternatives considered: draft, prose, write —
  `pages` and `docs` are unusable, being Apple's and Google's).

**Rejected, with reasons:** `box` — the natural collective noun, and Box, Inc.
is a cloud-storage company; keep it as an informal collective at most.
`base` — retired once dash absorbed tables; also reads as "database", which
this platform does not have. `bits` — generic, tonally wrong for an editorial
brand, and pushes search toward snack food. `page`/`pages` — reserved: it is
the best name for a future web-publishing app, and Apple Pages owns the
word-processor association. `shelf`/`library` — weaker than vault, and library
reads as "code library" to this audience.

**Note on the crowded namespace:** several unrelated SaaS products are called
Bento (email automation, link-in-bio, analytics, a dead FileMaker database).
The field is crowded, which weakens everyone's claim — including ours. The
practical cost is discoverability, not legal exposure. Mitigation is the
`bento/<app>` form, the `bento.page` domain, and always carrying the
descriptor. Get real clearance before commercialising; a bare wordmark would
be hard to register, a composite (mark + logo) much less so.

## 2026-07-25 — bento/vault is a personal server; the relay is a separate product
**Supersedes the "map, not the keys" entry below.** Vault is not an index and
not a sync service — it is "cloud services without a cloud": your documents
live on hardware you own (desktop / NAS / homelab) and it provides
reachability, search, cross-document references and version history without
any of it running on someone else's computer. The closer reference is
Tailscale, not Dropbox.

Vault and the **relay** are separate products with separate release trains.
The relay is dumb infrastructure — rendezvous, an optional encrypted
dead-drop, presence, nothing else — hosted on Cloudflare for the masses and
self-hosted by serious users. Every actual service runs on the personal
server; if the hosted relay ever accretes features, self-hosting becomes
second-class and we lose the audience this is for.

Consequences: the relay needs a portable
(Docker) implementation because the current Worker+DO+hibernation stack is not
realistically self-hostable; independent release trains require a versioned
capability handshake (we can no longer control deploy order); background
execution is unreliable on every platform so the protocol must be correct
after unbounded offline periods; mobile uses iOS File Provider /
Android DocumentsProvider rather than a background daemon; and the agent syncs
a FOLDER, so no Bento app needs any changes. Retained from the superseded
entry: the relay only ever sees ciphertext, and **export-to-standalone-file
always works** — that invariant is what keeps "your data is a file you own"
true while vault holds it.

## 2026-07-24 — [SUPERSEDED] bento/vault holds the map, not the keys
The document library must not become a custody service. It stores an encrypted
index of what documents exist and how they reference each other; each document
keeps its own encryption password and collab credentials. Compromising the
vault reveals *what you have*, not what is in it, and losing the vault loses an
index, not your work. This preserves the property that makes the relay
defensible — files stay authoritative, server loss is survivable — and keeps
the name an honest promise. Any sync tier is E2EE and optional (DO for
coordination + R2 for encrypted blobs; never D1/plaintext), and self-hostable.

## 2026-07-24 — Suite expansion: bento/spaces and bento/dash
Two new apps begin: **bento/spaces** (Notion/notes-like) and **bento/dash**
(spreadsheet + tables). Development fans out across parallel
agents and multiple tools (Claude Code, Codex, Antigravity) — coordination
rules in `docs/PARALLEL-WORK.md`, platform contract in `docs/PLATFORM.md`.
Planned pre-fan-out groundwork: extract the shared kernel (monorepo layout,
apps beside `slides/`), add per-PR CI validation gates (typecheck +
build:single + splice conformance + test-sync). Releases stay local/signed
regardless of CI.

## 2026-07-24 — Hold marketing-surface i18n
Don't localize the bento.page landing page or README yet: the landing page
will be rebuilt around the multi-app suite, so translations now would only
drift. App UI i18n (7 locales) is the localization that matters and already
ships. Revisit once the new landing page is stable.

## 2026-07-24 — No bot/AI-agent identities in git history
External PRs get provenance review before merge (`gh api users/<login>`);
scatter-bot/AI-agent contributions are declined. A bot's merged PR was
scrubbed from history via filter-repo + force-push, and `main` is now
branch-protected (1 required review, no force-pushes). Human contributors'
authorship is preserved normally.

## 2026-07-22 — v1.0.7 launch (Show HN) and post-launch fixes
Launched publicly (#1 on HN, ~1000 pts). Post-launch priorities were driven
by thread feedback: collab focus-steal fix, chart zero-baseline for negative
values, mobile-Safari pinch, reduce-motion mode — all shipped in v1.0.8
alongside panel UI for community format features (text gradient, text-stroke,
blur/blend, backdrop-filter). Community format features are accepted when
additive + composable (unknown fields preserved; effects compose).

## v1.0.7 — Morph identity decoupled from element id
Elements carry optional `morphId` overriding the morph pairing;
`data-flip-id = morphId || id`. `id` stays the stable identity (selection,
anchors, CRDT). Chosen over mutating ids, which would have broken comment
anchors and collab node identity. Details: CLAUDE.md (render.ts section).

## v0.9.x — Charts are in-house (ECharts removed)
ECharts was 630KB (~47% of the shell); replaced with charts-lite interpreting
the same option SHAPE (pure JSON, no functions). Exotic configs degrade
gracefully rather than crash. Don't re-add a chart dependency; extend
charts-lite instead. Details: CLAUDE.md (charts section).

## v0.9.x — Collab credentials mint-at-creation, dormant until shared
Decks are born collab-capable but never auto-connect unless the doc arrived
carrying collab or the user opted in — fresh templates/demos must never phone
home. Read-only and writer roles are enforced cryptographically at the blind
relay, not honour-system. Spec: docs/collab-design.md.

## v0.x — Releases are cut locally, never in CI
The signing key never leaves the maintainer's machine; the signed bytes are
the served bytes. CI may validate (typecheck/build/gates) but never signs,
publishes, or deploys. Runbook: docs/RELEASING.md.

## v0.x — Single-file architecture is the product
One HTML file = document + viewer + editor, working offline from file://.
The splice contract on `#bento-doc` is frozen forever (shipped updaters
depend on it). Everything else is negotiable; this isn't. See
docs/PLATFORM.md §1–2.

## 2026-07-25 — Large assets travel out-of-band; the relay stays blind

Assets over 64KB (`BLOB_INLINE_MAX`) no longer ride inside CRDT ops. They are
encrypted client-side, uploaded once to the relay's R2 bucket, and referenced
from the document by a content-addressed key; peers fetch and decrypt on
receipt. This was forced by measurement, not preference: Durable Object storage
values cap at ~2MB, so the previous inline path produced frames the relay
accepted-then-dropped, and the client re-sent forever. Details and threat model
in `docs/blob-offload.md`.

Three properties are load-bearing and must not be traded away:

- **The relay cannot read a blob.** It pipes ciphertext without buffering. The
  key is `HMAC(roomKey, sha256(plaintext))`, so identical bytes dedupe *within*
  a room and are unlinkable *across* rooms — a plain content hash would have
  let the relay confirm two rooms hold the same file.
- **R2 is optional.** Absent binding = `/b/` answers 501, clients inline small
  assets and same-origin tabs still resolve from the local cache. A
  self-hoster without a bucket degrades; they are not broken. This follows
  from the relay being dumb infrastructure (see the vault entry).
- **Failures are visible, never silent-but-wrong.** An unresolved blob leaves
  the asset absent and renders empty rather than blank-looking-fine. The whole
  change set exists because the old failure mode was invisible.

Operational consequence: the relay must be deployed **before** a client that
depends on the blob endpoints — the standing rule for this split, same as the
keepalive and access-verification changes.

## 2026-07-25 — Solo review model: PR + green CI, zero required approvals

**Amends the entry below** ("Every PR gets human review before merging"). The
intent stands — every change lands via PR and the maintainer reads it — but the
*mechanism* was wrong and was quietly defeating the CI gate.

`main` required 1 approving review. GitHub forbids approving your own PR, so on
a one-person project that requirement is unsatisfiable and **every** merge had
to use `--admin`. Admin bypass skips *all* branch protection, including the
required `validate` status check. Net effect: the CI gate was decorative, and a
red build could land on `main` with nothing to stop it.

Now: `required_approving_review_count: 0`, PRs still required, `validate` still
a required status check, force-pushes and deletions still blocked. A normal
`gh pr merge` works and genuinely cannot merge a red build. Admin bypass stays
*available* (`enforce_admins: false`) but is now an exception rather than the
daily path — if you find yourself reaching for `--admin`, that is a signal
something is actually failing.

Human review is a practice, not a GitHub setting, for as long as the team is
one person. Restore a real approval count the moment a second reviewer exists;
the future-action exclusion list in the amended entry still applies.

## RTL is two separable problems; only one of them is the document's

**Decided:** 2026-07-26. Supersedes nothing; establishes the split.

Content bidi and chrome mirroring get confused constantly, and treating them
as one feature produces the wrong answer to both.

*Content* direction is a correctness bug and belongs to the document: an
Arabic sentence puts its full stop in the wrong place without `dir="auto"`,
and it is wrong for everyone who opens the file. Cheap, uncontroversial, do it.

*Chrome* mirroring is a UI convention. Nothing is incorrect without it; the
editor merely feels foreign to an RTL reader. It was deliberately sequenced
AFTER an RTL language pack existed, because mirroring a UI whose every label
is still English is worse than not mirroring — and because the point of
shipping a pack first is to learn whether RTL users actually turn up.

The invariant that falls out of the split — **the document never mirrors** —
is recorded in `PLATFORM.md` §8 and binds every Bento app. A document that
looks different depending on the viewer's locale is a format-level bug.

Cost, measured rather than guessed: ~430 bytes in the shipped shell for the
whole chrome conversion, and **zero** for the languages themselves, because
every RTL language is a pack. Size was never the constraint here. The real
constraint is that 32 of the editor's ~36 direction-adjacent coordinate sites
live in `canvas.ts` (Moveable/Selecto), which cannot be verified by an agent —
synthetic drags on Moveable handles do not register at all. Pinning the
document surfaces LTR was sufficient to leave that math untouched, and that is
the outcome to preserve: if a future change makes chrome direction reach
`canvas.ts`, stop and reconsider rather than refactoring the coordinate code.

**No plural system.** Hebrew (and later Arabic) ship without one. Of 15
count-bearing strings only 6 take a real count; the rest are index labels
(`Axis {n}`, `slide {n}`) or abbreviated times. Six strings do not justify
changing the catalog format, the build script, the CI gate and every catalog.
Translators phrase them count-agnostically instead (`מחוברים: {n}`), which is
standard practice when a framework lacks plurals and costs nothing at runtime.
Revisit only if a language arrives where the workaround genuinely fails.

## One English word, two meanings = two keys

**Decided:** 2026-07-26. Consequence of English-string-as-key; binds every
Bento app that uses `kernel/src/i18n.ts`.

Gettext-style catalogs key on the English source string, which quietly assumes
that one English word means one thing. It often doesn't. `Loop` was the
animation loop AND the media playback toggle; `solid` was a fill style AND a
line style. Every language had to pick one word and be wrong in the other
place — Swedish wants *enfärgad* for a solid colour and *heldragen* for a
solid line, and no amount of translator care fixes that from inside the
catalog. Both were found independently by pack authors, which is the signal:
if a translator has to ask "which one is this?", the key is broken, not them.

**The rule.** When one English string reaches `t()` from two call sites that
mean different things, the more specific site takes a QUALIFIED key
(`Loop animation`, `solid colour`) and the plainer one keeps the bare word.
Do not add a context-prefix convention — the key is also what English users
read, so it has to be a sentence, not `fill.solid`.

**Model words never move.** Values like `solid`/`gradient` are format words
stored in the document. Disambiguate the LABEL only: `labeledSelect()` takes
`[value, label]` pairs precisely so the displayed string and the stored string
can diverge. A "fix" that changes what is written to `doc` is a format change
wearing an i18n costume.

**The cost, so it is paid deliberately.** Re-keying invalidates that entry in
every bundled catalog AND in every pack, silently — the string simply falls
back to English. So it happens BEFORE packs are published, in one PR, with
the affected keys listed for pack authors to pick up. After packs ship,
re-keying is a coordinated break across every language and should be weighed
against living with a slightly wrong word.

**Interpolated values are strings too.** `t('This {kind} is…', { kind })` with
a model word for `kind` puts an English noun inside a translated sentence.
Localise at the call site (`{ kind: t(kind) }`) — and check the sentence still
agrees grammatically, since a substituted noun carries gender in half the
languages we ship (French needed "Ce fichier {kind}" once `vidéo` could land
in it).

## 2026-07-26 — bento/tray: the iOS host is a suite member, and it is generic

The native iOS app is named **bento/tray** — "Bento Tray" on the App Store,
bundle id `page.bento.tray`, source in `tray/` beside `slides/` and `spaces/`.

**It runs ANY self-contained HTML document, not only Bento's.** That is not
scope creep bolted on; the Swift never parses the document and never did — it
is a courier that serves bytes into a WKWebView and polyfills the one File
System Access call the page needs to save itself. Bento decks are simply the
first documents it carries. Any single-file HTML app that saves itself works
identically, which on iOS is otherwise impossible: every browser there is
WebKit and none ship that API.

Naming notes, so this is not relitigated:

- **`bento/host` was rejected.** It names the mechanism, not the thing, and the
  suite convention is `bento/<what you get>`. "tray" keeps the food metaphor and
  says what it does — a tray carries any bento, whoever made it.
- **Plain "Bento" is unavailable** on the App Store: an unrelated Food & Drink
  app holds the exact name, and App Store names are globally unique. "Bento
  Tray" and "BentoTray" were both free at time of checking. That check reads
  published listings only — reservations in App Store Connect are invisible to
  it, so confirm there before submitting.
- The App Store name carries no slash. Per the 2026-07-24 naming entry, `/` is
  a mark, never a stored name.
- **But the ON-DEVICE name does carry it: `CFBundleDisplayName` is `bento/tray`**
  (2026-08-18). These are different fields and only one of them is a stored name.
  The App Store listing name lives in App Store Connect and stays "Bento Tray";
  the bundle display name is a LABEL — it drives the home-screen caption, the
  document browser's title ("bento/tray Recents") and the app's folder in Browse,
  and iOS never turns it into a path, because the container on disk is addressed
  by uuid. Verified on iOS 26: all three render it verbatim, nothing escaped or
  substituted. The 2026-07-24 rule scopes the ban to "filenames, URLs, package
  names and social handles… anywhere a name must be stored or typed", and a
  display label is none of those — it is exactly where the mark belongs. Recorded
  because "the App Store name carries no slash" reads at a glance as "the app is
  never called bento/tray", and someone will otherwise "fix" the plist.

**One app, not two.** A separate "generic HTML runner" listing would risk
guideline 4.3 (duplicate apps from one developer) and doubles the listing
overhead — screenshots, privacy labels, review cycles — for no gain. The
Developer Program is $99/yr per ACCOUNT, so a second app costs nothing in fees;
the cost is entirely in maintenance.

Consequence already implemented: each document gets its OWN origin
(`bento-tray://<sha256 of path>`), because a shared origin would let one
document read another's localStorage and IndexedDB — tolerable when every file
is yours, a real leak between unrelated third-party apps.

## 2026-08-02 — Agents get tools to measure and check, not a layout engine

Issue #160 was an agent authoring a deck from `agents.md` alone; #194 split out
its largest finding — that an agent cannot measure text, so every card, caption
and two-line heading is a guess, and overflow and collisions all follow from
that. The proposed remedies were `h: "auto"`, declarative layout containers,
and a `validate()` call. We shipped the checking tools and deliberately did NOT
build the layout engine.

**`h: "auto"` is impossible, not merely unwise.** `h` is a required `number`
that morph does arithmetic on — `a.h + (b.h - a.h) * p`, then `scale(h / b.h)`.
A string there yields `height: "autopx"` (invalid CSS, silently dropped) and
`scale(NaN)` in every SHIPPED copy of Bento, which is frozen code we can never
fix. Any future auto-height must be an ADDITIVE flag (`autoHeight: true`) with
`h` still holding the last resolved number, so old shells read a valid box.

**Layout containers are declined for now.** A `layout: {type, gap, cols}`
container resolved to concrete pixels would work — the file would stay
absolute-pixel, so morph, the drag handles and old shells are untouched. It is
declined because the hole it was proposed to fill is now filled: with
`window.bento.measure()` an agent can compute a row or grid directly, and
`agents.md` carries the column arithmetic pre-computed. Containers would make
correct layout DECLARATIVE, not POSSIBLE — convenience, not capability.

The cost is not the arithmetic, it is the semantics. Every element is draggable
today and the model says where it is; inside a container, dragging a child must
either be disabled (confusing, the handles are right there) or break it out
(needs UI and a rule for what "out" means). That is more design work than
`measure()` and `validate()` together were.

If containers are ever built, note the constraint that makes them safe:
resolution must be PURE GEOMETRY (gaps, weights, counts) so every replica
derives the same answer, which is what lets `syncLinkedCharts` and
`syncConnectors` derive-not-commit. The moment resolution measures text it
becomes environment-dependent — a webfont that has loaded on one replica and
not another gives different heights — and replicas LWW-fight over the geometry.
That, not the layout maths, is the reason auto-height children are the hard case.

**What shipped instead** (#193, #195, #197, #198): `measure()` sizes text from
a spec, before the element exists; `validate()` reports what the runtime
silently swallows; both go through the real renderer, and through ONE module,
so they cannot disagree about whether a box fits. The unknown-key tables are
generated from `model.ts` via the TypeScript AST and pinned in CI, because a
validator that reports a real property as unknown is worse than none — an agent
acting on that deletes working configuration.

Also settled while here: on a morph arrival the rule is PER ELEMENT and turns
on whether the element has a morph partner. With a partner it is already in
motion, so `fx.enter` and `fx.countUp` are both skipped. With no partner it is
new to the slide, has no tween to fight, and both run. Do not "simplify" this
back into a blanket morph-vs-entrance branch; that blanket rule is what made
count-ups silently dead and `slide-left` silently mean "rise 14px".

## 2026-08-02 — Publishing one app may never delete another's artifacts

`site/` is assembled for ONE app and mirrored into `bento-site` with
`rsync -a --delete`, so anything that build did not write is removed from
bento.page. Measured, not theorised: a cloned `release.mjs --app spaces`
staged a spaces site, and a publish against a copy of the real published tree
removed **47 live files** — `releases/slides/Bento_Slides.bento.html`,
`releases/slides/manifest.json`, `packs.json`, all 22 signed language packs,
`slides/index.html`, all four gallery decks, `guestbook/index.html` — with
every existing gate reporting green.

Shipped slides files check `releases/slides/manifest.json` at launch
(`slides/src/main.ts`) and their pack channel at `releases/slides/packs.json`
(`slides/src/packs.ts`). Both are frozen URLs in files already on disks, so a
deletion takes those channels offline permanently, for every copy in the
world, with no client-side repair. It is the one publish mistake with no way
back.

**Why nothing caught it: the existing gates are fail-OPEN.** The
shell-consistency gate and the pack-index gate are both
`if (existsSync(<path in site/>))` — an artifact that is *missing* skips the
check instead of tripping it, and missing is exactly the dangerous case.
PR #192's `--exclude guestbook.bento.html` is one hardcoded filename, not a
mechanism; it must not be read as evidence that protection exists.

**The gate is a deletion inventory of the DESTINATION, and it is fail-closed.**
Before mirroring, walk the published tree and refuse if any path would
disappear. If the destination cannot be inventoried at all, refuse — that is
the case where we know least about what we are about to overwrite.
Deliberate removal is `--allow-deletions`, which lists what it would drop.

Deletions are singled out from changes on purpose. A changed file is a release
doing its job; the one byte-change nobody can repair, a manifest going
backwards, already has its own monotonicity gate.

Gate on the published INVENTORY, not on `releases/*/manifest.json`. The
deletion set included `slides/index.html`, the gallery, `agents.md`,
`skills/`, `LICENSE`, `404.html`, `help/`, `q/`, `og.png`, `robots.txt` and
`sitemap.xml` — none of which a manifest-shaped gate would have seen.

Rig: `scripts/test-publish-gate.mjs`; shared logic `scripts/site-inventory.mjs`.
This is the first half of the multi-app release work
(`working/design/spaces-design.md` §6.1); per-app assembly — build one app, restore
the others byte-identically from the published tree — is the second, and
spaces cannot be released until both exist.

## 2026-08-02 — bento/home runs documents in a per-document origin, or not at all

`bento/home` is a launcher (`home/`, `working/design/home-design.md`): it holds no
document content, only `FileSystemFileHandle`s in IndexedDB, so a deck you were
working on reopens with write access after one permission click. That part is
measured and built. **How a document is actually OPENED is the hard part, and
this entry records why the obvious answers are wrong.**

**The constraint.** Opening a deck with silent save means running that file's
own code somewhere AND getting the handle to it. A blob URL inherits the
creating page's origin, so `window.open(URL.createObjectURL(file))` runs the
document on *home's* origin — with full access to home's store of writable
handles to every other deck. A file someone emailed you could rewrite all of
them. That is a real escalation over double-clicking it, where the file gets an
opaque origin and reaches nothing.

**A shared runner origin (`run.bento.page`) was considered and REJECTED.** It
fixes the wrong half. Documents could no longer read home's handles, but they
would all share one origin with each other, and a Bento document persists:

- `bento-autosave` IndexedDB — `recovery` (PLAINTEXT doc JSON, keyed by docId)
  and `versions` (a timeline of the same)
- `localStorage` `bento-member-<docId>` — the device's collab member PRIVATE KEY

So one runner origin creates a pooled store, which does not exist today, holding
the full plaintext content and version history of every document opened through
it plus the keys that authorise writing to their collab rooms. Any document on
that origin can read all of it. This is the same conclusion the 2026-07-24 tray
entry reached from the other direction ("a shared origin would let one document
read another's localStorage and IndexedDB"), and it is not a coincidence: it is
the same threat with a different host.

**`file_handlers` + `launchQueue` is NOT an isolation approach.** It delivers a
double-clicked file to the *installed PWA* — home's own origin. It answers "how
does the OS reach us", not "where does the document execute". It composes with
per-document isolation; it does not substitute for it.

**Ruled: per-document origin, or home does not open documents.** Home may
acquire a handle any way it can (picker, drop, `launchQueue` when installed) and
must hand off to an origin derived from the document's identity. Until that
exists, `home/src/launch.ts` REFUSES and says so in the UI, rather than quietly
taking the blob route. A launcher that silently widened the blast radius of
every deck you open would be worse than one that does not open them yet.

Also considered: a shared runner with storage deliberately neutered (no
autosave, no member keys, `Clear-Site-Data` per load). It removes the pool by
breaking recovery, version history and collab identity, and stays safe only for
as long as every future feature remembers not to persist anything. Per-document
origins get the same property structurally. Not adopted.

**Hosting consequence, measured 2026-08-02.** `bento.page` is GitHub Pages
behind Cloudflare (`x-github-request-id` on the apex); `sync.bento.page` is
Cloudflare-only. GitHub Pages serves one custom domain per repo and no
wildcards, so per-document origins cannot be hosted the way the rest of the site
is — the runner belongs on Cloudflare beside the relay, with its own deploy
cadence and the deploy-order care that implies (`docs/PLATFORM.md` §5).

**To confirm before building** (none of it testable in an automated browser —
permission-gated APIs report `denied` there without prompting,
`working/design/home-design.md` §3.2, a trap that already produced two wrong
conclusions):

1. Does a `FileSystemFileHandle` survive a cross-origin `postMessage` and stay
   usable? Permissions are per-origin, so the receiving origin re-prompting once
   is expected and acceptable; being unusable is not, and would sink this shape.
2. Cloudflare Universal SSL covers one label (`x.bento.page`), not two
   (`x.run.bento.page`). If so, a single hyphenated label — `<hash>-run.bento.page`
   — avoids paying for Advanced Certificate Manager. Worth checking before
   committing to a naming scheme, because it is baked into every stored origin.

**Naming.** `run`, not `slides` or `deck`. The runner never parses the format —
it executes a self-contained file that may be slides, spaces or sheets. An
app-named origin would isolate nothing extra (every deck would still share an
origin with every other deck) and app names should stay free for the apps' own
pages. The precedent is `sync.bento.page`: a subdomain marks a TRUST BOUNDARY,
not a product. An origin that executes files strangers sent your users is the
last one that should share a name with anything you want trusted.

## 2026-08-02 — MEASURED: a file handle cannot be delegated across origins

Follow-up to the entry above, which ruled that bento/home must run documents in
a per-document origin. **That is not reachable, and the measurement says so
unambiguously.**

`tray/webext/probe/` (run it with `node scripts/probe-origins.mjs`) picks a file on one
origin, grants write access there, and `postMessage`s the handle to another
origin. Chrome 150, macOS, 2026-08-02:

```
SENT     control ping → http://localhost:5302
SENT     handle       → http://localhost:5302
  [runner] CONTROL  plain object arrived — the channel works.
  [runner] MESSAGEERROR — a message arrived but could not be deserialised
```

The control object lands; the handle does not. `postMessage` **succeeds on the
sending side** — the handle serialises fine — and the receiving origin fires
`messageerror` instead of `message`, meaning deserialisation was refused. This
is why the first run of the probe looked like silence: nothing was listening for
`messageerror`, and a refusal is indistinguishable from a lost message without
it.

**The consequence is larger than "option B needs a different transport".** The
origin that acquires a handle is the only origin that can ever use it. So:

- Home cannot be a broker. It cannot hold handles for an isolated runner.
- Per-document origins cannot be reached the other way either, by having the
  document's own origin do the picking: the origin name depends on which
  document it is, and you cannot know that before reading the file, and you
  cannot move the handle after. The circularity is not incidental.

**What that leaves**, none free:

1. **Home and documents share one origin.** Rejected in the entry above and the
   reasons are unchanged: `bento-autosave` (plaintext doc JSON, version
   history) and `bento-member-<docId>` (collab private keys) pool into one
   store any document can read.
2. **Home never opens documents** — a drop target and a list, with opening left
   to the OS. Safe, and much less useful.
3. **Sandboxed iframe + save proxy.** Run the document in
   `<iframe sandbox="allow-scripts">` WITHOUT `allow-same-origin`, so it gets an
   opaque origin and can reach no storage at all — not home's, not another
   document's. Home keeps the handle and performs the write itself, with the
   document asking through a postMessage protocol.

Option 3 is the tray shape, and tray already proves the protocol half:
`tray/bridge.js` polyfills `showSaveFilePicker`, so `save.ts` needs no
host-specific code and the app does not know it is hosted. Reusing that contract
rather than inventing a second one is the point of the 2026-08-01 entry on
`tray/android/`.

**To measure before committing to option 3** (again: not testable in an
automated browser): an opaque-origin document has NO localStorage and NO
IndexedDB, so `bento-autosave`, version history, `bento-member-<docId>`,
language choice and reduce-motion all fail or degrade. Whether the runtime
survives that gracefully, and whether the degradation is acceptable, decides
whether home can open documents at all.

## 2026-08-02 — MEASURED: an opaque origin is blocked by unguarded storage, not by incapability

Third measurement in the bento/home sequence (`tray/webext/probe/sandbox.html`, Chrome
150, macOS). Same deck loaded twice from a blob: once in a plain iframe, once in
`<iframe sandbox="allow-scripts">` with no `allow-same-origin`, so the second
gets an opaque origin. The control is what makes the result readable — it
separates what the sandbox breaks from what breaks anyway.

| capability | control | sandboxed (opaque) |
|---|---|---|
| `localStorage` read/write | ok | **SecurityError** — sandboxed, lacks `allow-same-origin` |
| `indexedDB` present | object | object |
| `indexedDB.open` | ok | **SecurityError** — access denied in this context |
| `caches` | object | **SecurityError** |
| `crypto.randomUUID` / `subtle` | ok | **ok** — secure context survives |
| app boot | ✓ 17 slides | ✗ nothing |

**The interesting part is the failure mode.** Nothing reached `window.onerror`
and no promise rejected, so from outside it looked like a silent death. The
shell's own loader had caught it and printed to the page:

> This file could not start: Failed to read the 'localStorage' property from
> 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.

So the runtime does not fail because it NEEDS storage. It fails on the first
unguarded `localStorage` touch during boot — `kernel/src/i18n.ts` `resolve()`
reading `bento-lang`, which runs at module scope and therefore before anything
else. There are 39 `localStorage` call sites across `kernel/src` and
`slides/src` and no safe accessor.

**That is bounded and mechanical, not architectural.** A guarded accessor
(returns null / no-ops when storage throws) would let a document boot in an
opaque origin.

> **RESOLVED, same day (#205, `c1e8902`).** `kernel/src/storage.ts` now guards
> every one of those call sites, and the table above is out of date in its last
> row: the built shell boots in an opaque origin with **17 slides and 19
> surfaces, identical to the unsandboxed control, zero errors**. Do not re-run
> the sandbox probe expecting a failure — it passes now. What the table still
> reports correctly is the *storage* rows: `localStorage`, `indexedDB.open` and
> `caches` all throw there, and always will. Worth doing on its own merits regardless of home: the same
unguarded reads mean a deck opened with cookies-and-site-data blocked, or in
some embedded webviews, shows "this file could not start" rather than working
with default preferences.

**What it does NOT fix**, and this is the actual product decision: an opaque
origin has no persistent storage at all, so a document hosted this way loses
auto-save and crash recovery, local version history, and its collab member
identity (`bento-member-<docId>` is re-minted per session). Whether a launcher
may open documents that quietly cannot autosave is a question about what Bento
promises, not about what the browser permits.

Sequence so far: handles cannot be delegated across origins (entry above), so
the only isolation left is an opaque-origin frame with home proxying saves; an
opaque-origin frame is reachable once storage access is guarded; and what
remains is deciding whether a document with no persistence is one we are willing
to serve. Not settled here.

## 2026-08-02 — bento/home is closed; the host is a WebExtension (`tray/webext/`)

Home was a web page that would remember your decks and reopen them with write
access. Three measurements in one session closed it, and the same three point at
the successor.

**What killed it.** A `FileSystemFileHandle` cannot be delegated across origins
(entry above): `postMessage` serialises it and the receiving origin fires
`messageerror`. So the origin that ACQUIRES a handle is the only origin that can
use it — home cannot be a broker. Per-document origins are unreachable from the
other side too, because the origin name depends on which document it is, which
is unknowable before reading the file, and the handle cannot move after. What
remained was: run every document on one shared origin, where `bento-autosave`
(plaintext doc JSON, version history) and `bento-member-<docId>` (collab private
keys) pool into a store any document can read. Rejected.

A launcher that can list decks but not open them is not worth building.

**MEASURED, and it is the unlock** (Chrome 150, macOS,
`tray/webext/probe/directory.html`): a DIRECTORY grant is not per-file.

```
GRANTED  <folder>                       queryPermission: granted
  ── reload ──
RESTORED <folder>  kind=directory       queryPermission, no gesture: granted
[file 1] getFileHandle('bento-probe.txt', {create:true})
[file 1] the FILE's permission, unprompted: granted   ← never picked
[file 2] the FILE's permission, unprompted: granted
```

One folder grant survived a reload — still `granted` with no gesture, and
re-grantable with one click when it does lapse — and covered files inside it
that were never picked. So a host holding a directory handle can write ANY deck
in that folder, including one the user opened by double-clicking, which no web
page can do for itself.

**The shape.** The document stays on `file://`, which the browser treats as a
unique origin per file — per-document isolation for free, the thing three probes
failed to construct. A content script is the bridge transport; the extension
holds the directory handle and performs the write.

That is `tray`, in a browser. `tray/README.md`'s contract —
`showSaveFilePicker({suggestedName}) → { name, createWritable() }` — is
explicitly "platform-neutral; only the transport lookup and the native file
layer are not". `save.ts` needs no host-specific code and the app never learns
it is hosted.

**`tray/webext/`, not `tray/chrome/`.** Chrome, Edge, Firefox and Safari
extensions are one format with different manifests, so a browser name would be
wrong at the second target. Same reasoning as the `tray/android` entry: sharing
the name makes sharing the bridge contract the default rather than a convention
someone must remember. Note it is a PARTIAL tray — it supplies the file layer
and the transport, not the document browser or thumbnails `tray/ios` provides.

**Firefox gets nothing from this.** It implements no File System Access API at
all, and its extensions cannot write arbitrary files either; that needs native
messaging with a native helper. Firefox stays download-a-copy. Safari likewise
has no FSA, and a Safari Web Extension ships inside a native macOS app anyway —
so Safari's answer is `tray/macos`, not an extension.

**Still unverified, and the next thing to measure:** whether an MV3 service
worker can use a stored directory handle to `createWritable()` at all, or
whether the write must happen in an offscreen document or extension page. Keep
the write behind one function so the answer can move without touching the
contract.

**Kept from home:** `tray/webext/probe/` (four probes, all reusable) and
`home/src/deckmeta.ts`, which reads a deck's title without executing it — the
extension needs exactly that to label what it is about to save. The launcher UI
and the recents store are superseded by the directory grant.
## 2026-08-02 — One autosave database per app, migrated once

`kernel/src/autosave.ts` used a single `DB_NAME = 'bento-autosave'` and a single
`DB_VERSION` for every app. Two problems, and the second is the dangerous one.

Snapshots from different apps piled into one store wherever they share an
origin — `bento.page`, or any local server. bento/spaces has been writing into
bento/slides' database since its scaffold landed (`spaces/src/main.ts` calls
`putRecovery` on a 2.5s debounce).

`DB_VERSION` was shared too, and that breaks in one direction only: a new app
bumping it to 2 makes every ALREADY-SHIPPED shell of every other app throw
`VersionError` on open and lose autosave entirely. Shipped shells are frozen
code — 1.0.11 files are in the world and will go on opening version 1 forever.
There is no way to reach them.

**The name is `${appId}-autosave`.** `appId` is already `bento-slides` /
`bento-spaces`, so this reads `bento-slides-autosave` with no doubled prefix
and — deliberately — **no special case for the app that happened to be
first**. An earlier draft grandfathered `bento-autosave` for slides to avoid
orphaning data; carrying the data over is a better answer than a permanent
exception, and each app now owns its own version line.

**Migration copies, once, and never moves.** Renaming alone would silently drop
every user's recovery snapshot and their whole version timeline — a visible
feature emptying itself, which is a bug report, not a migration. It runs only
into an empty target, so a second pass cannot duplicate the timeline or
resurrect a snapshot the user deleted. The legacy database is left intact
because shells already shipped keep writing to it, and the copy of the app the
user opens next must still work; `pruneOld` ages its contents out on its own.

Everything is copied, not just the running app's rows. Nothing in a snapshot
records which app wrote it, and it does not need to: `docId` is a uuid, so
another app's rows can never match a lookup. Filtering would mean guessing.

`appConfig()` is read LAZILY inside `openDb()`. It throws before
`configureApp()` runs, and a kernel module that explodes at import time
depending on evaluation order is the trap `app.ts` exists to avoid — its header
comment named autosave as config-free and is corrected in the same change.

Rig: `scripts/test-autosave.ts`, run for both apps in CI. It fails against the
old shared-name code (7/8), which is the property that makes it a gate.

## 2026-08-02 — A release seeds from what is published, and builds one app

Second half of the multi-app release work (`working/design/spaces-design.md` §6.1).
The first half made a destructive publish impossible; this one makes a
non-destructive one possible.

`release.mjs` was slides-shaped end to end: `rmSync(site)` then stage slides.
One release builds ONE app, and `site/` is mirrored with `rsync --delete`, so
every other app's signed shell, manifest and packs — fetched by shipped files
at frozen URLs — were simply absent and would be deleted.

**A release now SEEDS `site/` from the published tree and overwrites only what
it built.** "Restore every untouched app byte-identically" becomes the default
rather than a step someone remembers. It composes with the publish-time
deletion gate: this fills the gap, that one refuses if a gap remains.

Verified in both directions against a copy of the live tree: a spaces release
leaves all 47 published files byte-identical and adds only `releases/spaces/`
and `spaces/` (`diff -r` reports nothing but "Only in"); a slides release with
spaces already published rebuilds slides and leaves spaces intact. Both report
`deletion gate: none would be removed`.

**Without a published tree, a release REFUSES** (`--allow-missing-published`
for a genuinely first release). Continuing would stage a partial site whose
publish deletes every other app; the gate would catch it, but failing here says
what to do about it.

**Site content has exactly one owner.** Landing, gallery, agent guide, skills,
`/help`, `/q`, 404 and the guestbook are slides-derived — the gallery and 404
decks literally embed the slides shell — so only a slides release rebuilds
them. A spaces release must not regenerate them from a shell it did not build.
`ownsSiteContent` says so, and the rig asserts exactly one app claims it.

**Packs stay slides-only.** `build-i18n.mjs` and `sign-packs.mjs` are
slides-hardcoded (§6.5) and spaces has no catalog, so a spaces release stages
NO packs rather than unsigned ones — `publish-site.mjs` refuses unsigned packs,
correctly.

`sign-release.mjs` gains `--app`; it hardcoded `bento-slides`. This is the
silent failure of the set: a shipped shell verifies the manifest's `app`
against its own `configureApp()` id (`kernel/src/update.ts`), so a wrong value
signs and publishes a channel every file quietly declines — nothing errors,
updates just stop.

The registry lives in `scripts/apps.mjs` with a rig, `test-release-apps.mjs`,
because a release signs and the key never reaches CI: the pipeline is not
CI-testable, but the registry drifting from the tree is. It pins `appId`
against each app's own `configureApp()` call and the manifest URL against the
path the release publishes to.

## 2026-08-05 — The board's order IS the page order, and a view's filter is two keys

**Decision.** Dragging a card between columns sets that issue's field value.
Dragging it *within* a column reorders `doc.pages`. There is **no per-view
order field**, and nobody may add one in a drag handler. A view's filter is
`filter: { is?: {key: string[]}, open?: boolean }` on the `view` block, and
absent means everything.

**Why order is the page array.** An issue IS a page, and pages are already an
ordered list — the sidebar renders it, the markdown export walks it, and a
saved file preserves it. A stored per-view order is a permanent format field
that has to answer what happens to an issue no view has ever seen, what happens
when two views disagree, and what a build that predates it does with the
orphaned key. Reordering the pages answers none of those questions because it
does not ask them. The consequence is deliberate and worth saying out loud: the
board's order and the sidebar's order are the same order. `fields.ts
reorderPages` is the whole mechanism, and it returns null when a drop changes
nothing, which is what keeps a drag that went nowhere out of the undo stack.

**Why `sort` is NOT implemented.** `sort: [...]` appears in the shape sketched
in the ruling below. It is still unimplemented, and now it is not free: a
stored sort and a hand-dragged order contradict each other, and which one wins
is a format decision, not a rendering detail. Whoever needs sort settles that
first. Until then a `sort` key round-trips untouched and is ignored.
*(SETTLED 2026-08-06 — see "A sorted board is a different question" below.)*

**Why the filter is two keys.** `is` (a field's values) and `open` (a phase).
A filter language grows without limit and can never shrink — every operator is
in files on other people's disks the moment it ships. These two answer the two
questions a tracker is actually asked. Rules: an absent filter, an absent key
and an empty value list all mean "no constraint", so every view block written
before filters keeps working and an empty stored filter is deleted rather than
kept; a value this build does not know is compared LITERALLY, so a filter a
newer build wrote still selects what it meant; `open` is derived from
`FieldOption.group` on the first field whose options declare one (never
hardcoded to `status`), and an unknown value counts as OPEN, because hiding
work this build cannot read is a loss and showing one issue too many is not; a
filter key this build cannot evaluate is kept, is not applied, and the view
SAYS SO — a count that is silently too high is the failure additivity would
otherwise trade for.

**Touch.** A phone cannot drag an HTML5 draggable, and the board is the
tracker's main screen, so every card carries a status BUTTON that opens the
same picker the issue's own header strip opens, through the same writer
(`editor.applyField` → `fields.propHtml`). There is exactly one place where
`value` and `html` are written, and there must stay exactly one.

## 2026-08-06 — A sorted board is a different question, and it never eats the hand order

**Decision.** `sort?: ViewSort[]` on the `view` block ships, where
`ViewSort = { key, dir?: 'asc'|'desc' }`. Absent means the page order. The entry
above deferred this until somebody settled which of a stored sort and a
hand-dragged order wins; this is that settlement, and it also makes `layout` and
`groupBy` reachable, which they were not.

**A sort never overwrites the manual order — it OVERRIDES it, for as long as it
is there.** The two orders live in different places: the hand order is
`doc.pages`, the sort is a key on one block. Nothing about sorting a view
touches the page array, so clearing the sort returns the board to exactly the
arrangement it had, and a second view of the same issues sorted differently
takes nothing away from the first. That is the whole reason the contradiction
dissolves rather than needing a winner: they were never competing for the same
storage. "Manual order" is the first item in the Sort menu because it is the
absence of a sort, not a sort called manual.

**A sorted board stops offering positional drops.** With a sort in force the
order within a column is computed, so a drop position would write into
`doc.pages` an order the next paint discards — a gesture that appears to do
nothing and leaves an undo step behind. The column still highlights and still
accepts the card (the value change is real); only the insertion point stops
being offered. `dropIssue` takes a null aim for exactly this.

**Ordering rules, because each one is silently wrong the other way.** A select
sorts by its DECLARED position — "Backlog, Todo, In progress, Done" is a
direction, and alphabetising it throws away the only thing the list was saying.
An UNSET value sorts last in BOTH directions: it is not the smallest value, it
is the absence of one, and flipping the direction must not promote every blank
to the top. A value a NEWER build wrote has no declared seat and sorts after
everything this build knows, rather than leading a board with a status nobody
here can read. Ties keep the page order (a stable sort), so a hand-arranged
board still reads that way within each band. A sort key naming a field this
build has no schema for is skipped and the view SAYS SO — the same honesty rule
`unknownFilterKeys` already carries.

**An ARRAY holding one entry.** The editor only ever writes one key; the format
takes a list because that is the shape already published in the ruling below,
and because a second key can be added later without touching a file, where
widening a scalar afterwards could not be done at all.

**Storing a default is storing a lie.** Choosing Board, or grouping by `status`,
or Manual order DELETES the key rather than writing what absence already means,
so a view somebody switched to a list and back is byte-identical to one that was
never touched — the same rule the filter already followed.

## 2026-08-05 — An issue is a page: the tracker format for bento/spaces

**Decision.** bento/spaces gains an opinionated, Linear-shaped issue tracker.
An ISSUE IS A PAGE. Its fields are `prop` BLOCKS. The schema those fields draw
on is `doc.fields`. A saved view is a `view` BLOCK. Nothing about this is a new
document type and nothing is a page-level key.

**Why spaces rather than a new app.** A tracker is a pile of short documents
with typed fields and a few saved queries over them. Spaces already has pages,
rich bodies, links, backlinks, search, archive, print, i18n, nine languages and
an agent surface — which is most of a tracker — and Linear's own model is
"an issue is a document with fields". A separate app would rebuild all of it,
and would land where Jira is: a tracker whose issues cannot hold a real
document. The suite's other half, bento/dash, owns typed COLUMNS over rows;
this owns typed FIELDS on documents. That is the seam.

**The format.**

    doc.fields: [                       // the schema, document-level
      { key: 'status', label: 'Status', vt: 'select', options: [
          { id: 'todo', label: 'Todo', color: '#…', group: 'unstarted' }, … ] },
      { key: 'assignee', label: 'Assignee', vt: 'person' },
      …
    ]

    // …and on an issue page, its values, as ordinary blocks:
    { id:'b1', type:'prop', key:'status', value:'todo', html:'Status: Todo' }

    // …and a board, which is also just a block:
    { id:'v1', type:'view', layout:'board', groupBy:'status',
      filter:{…}, sort:[…], html:'Board — all issues by status' }

**Why values are blocks and the schema is not.** The ruling above already
settled values: a `prop` block degrades losslessly on a build that predates it
(render.ts's `default:` branch shows its `html`), and it is found by ⌘F, ⌘K,
undo and the block registry for free, because every one of those iterates
`page.blocks`. A page-level key renders as nothing and is invisible to all of
them. But the SCHEMA is not a value: putting the status list on every issue
would copy it into every page and let two pages disagree about what "Todo"
means. Document-level is the only place it can live, and `doc.fields` is
additive — a build that predates it ignores the key and still renders every
`prop` block's `html`.

**Every `prop` block carries a human-readable `html`.** That is what makes the
format degrade rather than vanish, and it is not redundancy: it is the same
discipline as the static preview and the markdown export. An older build, a
thumbnailer, a grep, and a markdown export all see "Status: In progress"
without knowing what a field is.

**Fields render as a header strip, by CONVENTION not by a new container.**
`prop` blocks that precede the first non-prop block on a page are drawn as a
compact strip under the title; the same blocks later in the body render inline.
No format flag says "this is a header" — the position does — so an older build
shows the same information in the same order, just stacked.

**What this buys the day collaboration lands.** Nothing needs doing. The CRDT
syncs pages and blocks; properties ARE blocks, so per-field last-writer-wins
falls out of the existing per-(node,key) registers, and two people changing
status and assignee at the same time both win. Had properties been one object
on the page, that would have been one register and one of the two edits would
have been lost silently — which is the measured reason the ruling exists.

**Deliberately NOT in this format.** No teams (a file IS the team boundary), no
per-user permissions (the file is the capability, per PLATFORM §5), no
notifications, no server-side automation. Those are Buzz's problem shape — a
relay, signed events, agents as members — and Buzz is a Rust service with
Postgres behind it. The thing Bento can do that neither Linear nor Buzz can is
hand you the whole tracker as one file that opens offline, forever, with no
account. That is the feature, and it is the reason the format has to stay
small enough to keep that promise.

## 2026-08-05 — The tracker's agent surface: written, warned about, never refused

**Decision.** `window.bento` gains `fields()`, `issues(query?)`,
`setField(pageId, key, value)` and `newIssue({title, ...fields})`, and
`validate()` learns about fields. Three shapes are settled here because they are
an API other work will be built on.

**1. A value this build does not know is WRITTEN, and warned about — never
refused.** The format is permanent and additive: a status a newer build declared
has to round-trip through an older one, and a verb that refused it would make
the older build unable to edit a document the newer one wrote. But an agent
typing `'In progress'` where the option id is `'doing'` has made a mistake and
silence would leave it confident, so the result carries
`warning: {code:'unknown-option', options:[…]}` and `validate()` reports
`unknown-field-value` at **info**. Refuse the shapes JSON cannot carry, warn
about the vocabulary. The same reasoning makes `unknown-field-key` info, and
`prop-html-stale` a warning — but that check STANDS DOWN when the value names no
known option, because then the writer knew a label this build does not and its
`html` is right where ours would be a guess.

**2. An unknown key in an ARGUMENT is a typo, not additivity.** `newIssue` and
`setField` refuse a key that is in no schema (`err: 'no-such-field'`). Unknown
keys in a *document* are how a future build's data survives; unknown keys in a
*call* are how an agent believes it set a priority it did not set.

**3. "Open" means NOT FINISHED.** `issues({group:'open'})` is one predicate —
not `done`, not `cancelled` — so a status with no phase and a status this build
has never heard of both count as work, and a status naming no option reports
`group:'unknown'` rather than being folded in with the rest. An issue wrongly
shown in a backlog costs a glance; an issue wrongly hidden from one costs the
issue.

`setField` is the ONLY supported way to write a value, because it writes `value`
and `html` together through fields.ts `propHtml()` — the same call the editor's
own field picker makes, so the two cannot drift. Guarded by
`scripts/test-spaces-agent.ts`; guide in `docs/spaces-agents.md`.

## 2026-08-03 — bento/spaces: the format decisions that must precede parallel work

Five independent design reviews of bento/spaces proposed overlapping feature
sets. Most of it is schedulable in any order. These are not: each is a place
where two workstreams would otherwise invent conflicting PERMANENT shapes for
the same thing, and the format has no server and no migration. Settled here so
nobody has to guess. Nothing below ships this round except where noted.

**1. Properties, tags and table columns are BLOCKS — never keys on `Page`.**
Three reviews proposed three incompatible shapes for the same data: prefixed
keys on the page (`p:status`), a `prop` block, and `Page.tags: string[]`.
Ruling: `{ type: 'prop', key, value, vt, html }`. A `prop` block degrades
losslessly on an older build — render.ts's `default:` branch renders its html —
whereas an unknown `col:` key on a Page renders as *nothing at all* and is
invisible to search, find-and-replace, undo and the block registry, all of
which iterate `page.blocks`. Tags stay literal text in `html` with a derived
index; no `page.tags` array. A markdown importer preserves YAML front matter as
a `code` block with `lang: 'yaml'` and never invents `page.meta`.

**2. Containers are one mechanism, declared once.** Tables, callouts and
columns are all "a block that holds blocks", and three agents each generalising
`renderBlocks`' host stack would make render.ts the conflict magnet
PARALLEL-WORK names by name. The contract: `container: true` in the BlockSpec;
a container gets NO gutter and NO inline text host (inside a `<tr>` either one
fabricates a phantom cell); a child whose parent chain does not resolve renders
as a plain block, never a stray `<td>`; and list grouping resets at every
container boundary, or a bullet before a table adopts the first bullet after it.

**3. A render-time transform may never decorate EDITABLE content.** The
rendered DOM *is* the model here: editor.ts:575 writes `b.html =
host.innerHTML` on every input. So any injected decoration is captured into the
file on the next keystroke — and then the allowlist deletes it. Verified:
sanitize.ts removes an element that is in neither ALLOWED nor UNWRAP *together
with its children* (the child-lifting happens only inside the UNWRAP branch),
so a rendered `<math>` costs both the rendering and the source text. Rule:
render-time transforms are gated on `opts.editable === false`, or use the CSS
Custom Highlight API, which touches no DOM. Slides solved the same problem by
swapping the raw token back while editing; spaces has no equivalent and must
not grow one by accident. This binds tag chips, inline math, mention
highlighting and pasted-markup decoration.

**4. `#p/<page>/<block>` is a legal href, tolerated from today.** Shipped in
this round — see the commit that made `resolveAnchor` the one resolver. It
could not wait: sanitize.ts's allowlist already admits the two-segment form, so
such links can arrive in a file this build did not write, and its own comment
records why a NEW fragment form can never be added later (a stricter build
strips it on the next edit that touches the block). Addressing — actually
scrolling to the block — comes whenever it comes; tolerance had to be now.

**5. `Page.stencil`, not `Page.template`.** `SpacesDoc.template` is declared
and documented in two comments as "re-mint docId on every open", and
implemented by nothing. Page-level templates get the name `stencil` so the two
meanings can never collide, and `doc.template` must either be implemented or
have its comments deleted. A dead field with a documented meaning is more
dangerous than an undocumented one.

**6. The effective-parent rule.** A block's effective parent is `b.parent` iff
that block exists in the same page's array AND appears strictly earlier in it;
otherwise the block is a root block. Same for pages. This is total (nothing
vanishes), acyclic by construction (every effective edge points backwards in
the materialised order), orphan-free, and — the point — a pure READ-TIME
function that mutates nothing, so two replicas that agree on the array agree on
the tree. It is what makes concurrent re-parenting safe under collaboration
without restricting what anyone can drag, and `renderBlocks`' host stack
already implements a narrower version of it.

**Shell ceiling for the round: 100KB compressed** (from 73KB). Spaces is 1/8th
of slides' size and that is a feature, not an accident.

*Amended 2026-08-04, after the round landed at 105KB.* Callouts (+4), syntax
highlighting (+5), markdown import (+15) and the agent surface (+8) came in 5KB
over. Raised to **110KB** rather than trimmed, and the reasoning is recorded so
the next person can disagree with it: import is the migration path and is worth
more than its bytes; the agent surface is the "designed for AI" claim made
executable rather than asserted; and at 105KB spaces is still a fifth of
slides. What is NOT allowed is discovering the breach at release time — the
ceiling is checked per feature from here, and the next one has 5KB, not 5KB and
a shrug.

*Corrected 2026-08-04, same day.* That sentence shipped with NO MECHANISM
behind it, and a reviewer found the gap by reading the number rather than the
build failing. It is real now: `scripts/size-budgets.json` holds the ceiling,
`scripts/test-spaces-size.mjs` enforces it, and CI runs it. Raising the ceiling
is expected; raising it SILENTLY is what the check stops — the budget moves in
the commit that spends the bytes, where a reviewer can see it. Recording an
intention and calling it a rule is how the 100KB ceiling got missed at all.

*Superseded 2026-08-24 — bento/spaces has no hard ceiling.* The maintainer's
call, and the number that prompted it: 258,454 B against a 256 KiB ceiling,
98.6%, with the polish round declining worthwhile fixes over a few hundred
bytes. A find-highlight refinement was dropped for size; an `aria-current` fix
landed only because it cost 32. When a ceiling starts choosing which
accessibility fixes ship, it is costing more than it saves.

**What went, and what did not.** Only the failure. `spaces` is now
`enforce: false` with a `reference` watermark, and every run still prints its
size and the drift since that number — `track spaces 258454 B (+312 B since
reference, no ceiling)`. The original entry's point was never the block; it was
that a budget nobody measures is a wish, and that the breach must not be found
by a reviewer weeks later. Measuring survives. Move `reference` when a change
buys real bytes and say what bought them, exactly as before.

**Do not quietly put it back.** `enforce: true` restores the ceiling for any
shell, and the other apps keep theirs — this decision is about spaces only. If
a future round wants the discipline back, that is a conversation, not a
one-line edit to a config file.

## 2026-08-03 — An encrypted space is never written to disk in the clear

**Decision.** bento/spaces skips the autosave recovery snapshot while a space
is encrypted, and setting a password clears both the version timeline and the
recovery snapshot already written.

**The bug.** `main.ts` called `putRecovery(store.doc)` on a 2.5s debounce,
unconditionally. The snapshot is the document as plain JSON, so an encrypted
space wrote its full plaintext into IndexedDB every few seconds — defeating the
password completely, for the one author who has demonstrably asked for secrecy.
`about.ts` already cleared the version timeline when a password was set, which
made the gap easy to miss: half of it was handled, and the half that ran
continuously was not.

**`putRecovery` does not guard this, by design** — it is a kernel primitive and
the encryption state is app-side. That makes it a CALLER contract, and a caller
contract with no gate is a bug waiting for the next app. Slides holds the same
contract in its own autosave layer.

**Measured, on the built shell:** typing into a plaintext space put the marker
text in the `recovery` store within three seconds (correct — it is the only
backstop on iOS, where no browser can write back to a file). Setting a password
removed that row; every later edit wrote nothing; and the saved file was still
a `bento/enc` envelope with no plaintext anywhere in it.

**Guarded** by two source assertions in `scripts/test-spaces-model.ts`, both
negative-controlled. Same reasoning as the inert-parse guard above: the
behaviour needs IndexedDB and a real clock, the mistake is made at the call
site.

## 2026-08-03 — A space does not phone home when it is opened

**Decision.** bento/spaces renders a remote image `src` as a placeholder naming
the host, with a "Load this image" button. Only `asset:` and `data:` load
without asking. Consent is per-url, per-session, in memory, and never enters
the document.

**Measured.** A space carrying `<img src="https://…/pixel.png">`, opened from
`file://`, issued the request — observed via `PerformanceObserver`, one
`resource` entry, before any interaction. That is a tracking pixel: the
recipient's IP address and the moment they opened your document, delivered to
whoever authored the file. In a format whose entire premise is that you can
mail it to someone, it is the wrong default by a wide margin. It also breaks
PLATFORM §1 — no network required to open.

**Why it costs authors nothing.** The editor never writes a remote src. A
picked image is downscaled, interned by content hash, and stored as `asset:`.
Only hand- or agent-authored documents can carry a url, so the only documents
affected are exactly the ones where a reader should be asked.

**The predicate is an allowlist,** not a blocklist of `http:`. A relative path
is a real request on a static host; so are `//host/x`, `blob:`, `filesystem:`
and any scheme this build has not heard of. `isRemote()` lives in `model.ts`
(pure, testable in node) and returns false only for `asset:` and `data:`.

**Consent is VIEWER state, like locale and reduced motion.** Putting it in the
file would let the author decide whether the reader phones home, and would
carry one reader's decision to everyone the file is forwarded to. It is a plain
`Set` on the editor, it dies with the session, and the click does not commit —
so undo, the dirty flag and autosave never see it. All four verified.

**The placeholder names the host.** "Load images" with no indication of who is
being contacted is not consent. It also shows the `alt` text, which is now the
thing a reader actually reads when an image does not load — so the agent guide
tells agents to always write one, and to embed bytes rather than link them.

## 2026-08-03 — Untrusted html is parsed INERT; a detached div is not safe

**Decision.** All untrusted html in bento/spaces goes through
`sanitize.ts inertBody()`, which parses with `DOMParser` into an inert
document. `document.createElement('div').innerHTML = untrusted` is banned, and
`scripts/test-spaces-model.ts` refuses it in the source.

**Measured, in a browser, on the real shell over `file://`:**

| construction | `<img src="404" onerror="…">` |
|---|---|
| `document.createElement('div').innerHTML = …` | **FIRES** |
| `new DOMParser().parseFromString(…, 'text/html')` | inert |
| `<template>.innerHTML = …` | inert |
| `document.implementation.createHTMLDocument()` | inert |

A detached div reads as safe — nothing was inserted into the page — but the
elements it creates belong to the LIVE document, so their resources load. The
handler runs from a node that was never attached to anything.

**Why this was the worst possible instance of it.** The sanitizer has to parse
hostile markup before it can strip it, so the sanitizer was itself the vector,
and the payload ran BEFORE the strip. `sanitizeInline` is called at render time
(`render.ts`), so the trigger was *opening a space someone sent you* — no
click, no edit. Sanitizing at render rather than at load is otherwise the right
call (every path into the DOM is covered by one line); it just meant this bug
sat on the open path.

Four call sites had the shape: `sanitizeInline`, `textOf`, `render.ts`'s
code-block text extraction, and — found by the guard, not by reading —
`about.ts`'s markdown export, so "Export as Markdown" ran what it was
exporting.

**The guard is a source assertion,** like the `.href`-IDL one above it: the
behaviour needs a DOM and a failing network request, and the mistake is made in
the source. It caught the fourth site the moment it was written, which is the
argument for writing it that way.

**Verified after the fix,** on the built shell from `file://`, with the removed
construction kept in the same page as a control: only the control fired. No
`[onerror]`, no smuggled `<img>`, no `svg[onload]`, no `javascript:` href
reached the DOM; the `#p/` link survived, external links kept
`rel="noopener noreferrer"`, `<p>a</p><p>b</p>` still unwrapped to "a b", and
markdown export produced `alpha **bold** *it* \`c\` [link](#p/sd-home)`.

**One consequence to remember.** The sanitizer's host now lives in a different
document, so nodes it inserts must come from `el.ownerDocument`, not the global
`document`. DOM4 adopts implicitly, so the wrong one would work — which is
exactly why it is written explicitly and pinned by the rig.

## 2026-08-03 — Release notes, agent guides and tags are PER APP

**Decision.** `scripts/apps.mjs` gained `changelog` and `agents` per app. A
release reads its own app's changelog (`CHANGELOG.md` for slides,
`spaces/CHANGELOG.md` for spaces) and publishes its own agent guide at
`bento.page/<app>/agents.md`. Tags are prefixed for every app but slides.

**The bug this fixes.** `release.mjs` read `join(root, 'CHANGELOG.md')`
unconditionally, and that file's first line is "All notable changes to
**bento/slides**". The first spaces release would therefore have SIGNED slides'
release notes into the spaces manifest — and every shipped spaces file fetches
that manifest at launch and renders `notes` inline in the About dialog. So the
failure is not a build error; it is a correct-looking release that tells all of
one product's users about a different product's changes.

It is unrecoverable in the ordinary way. The notes are inside the signed
envelope, so fixing them means re-signing — and the updater enforces version
monotonicity, so the same version cannot be re-signed. The fix would be
burning a version number.

**Why it was invisible.** Every gate was app-scoped. The registry rig checked
`dir`, `shell` and `appId` against each app's own source of truth, and each
check passed for each app in isolation. The wrongness only exists in the PAIR:
two apps naming one file. That is now a single assertion — the set of
changelogs has the same size as the set of apps — plus, per app, "your
changelog has a section for the version being released, and that section has
bold lead-ins" (a section of pure prose signs EMPTY notes, which is the same
class of silent failure).

**`--print-notes`.** `node scripts/release.mjs --app <app> --print-notes`
prints exactly what would be signed and exits before anything is built, wiped
or signed. A one-way artifact should be readable before it is committed to;
this makes reading it a one-second step rather than an act of faith. It runs
ahead of the `site/` wipe, which is why `cmpVer` is a function declaration and
not a const arrow — the const is in the TDZ at that point in the file.

**Agent guides.** `docs/agents.md` already advertised
`bento.page/<app>/agents.md` as the convention, but only the site-root
`/agents.md` was ever written. Each app now publishes its own guide at the
advertised URL, and slides copies its own to `/agents.md` for compatibility —
the README and the harness `SKILL.md` point there, and that SKILL.md ships
inside a zip people upload to claude.ai, so the root URL is effectively frozen.
One source, two paths.

**Tags.** Slides has 23 tags in the bare `vX.Y.Z` form and is at 1.0.15;
spaces starts at 0.1.0. An unprefixed spaces tag would sort into the middle of
slides' history and permanently claim a version slides cannot reuse. Slides
keeps bare; everything else is `<app>-vX.Y.Z`.

**Reconciled with #234.** bento/dash hit the same bug independently and landed
a convention-based resolver (`<dir>/CHANGELOG.md`, else the root) while this was
in flight. Both now go through ONE `changelogPath()` in release.mjs — registry
field first, convention second, root last — used by the signing path and by
`--print-notes` alike, so what a release reports and what it reads cannot
drift. The registry states it explicitly for all three apps, and the rig
asserts each app RESOLVES to its own file, which is what keeps the root
fallback unreachable. That matters because the fallback is only harmless while
version numbers do not overlap: the day a second app reaches 1.0.x, an empty
manifest would quietly become a wrong one.

## 2026-08-03 — One bento/spaces file is one SPACE, and the reason is a save primitive

Spaces is a tree of pages in ONE `.bento.html`, with links as same-document
fragments (`#p/<pageId>`) resolved against a map built from the file's own
`#bento-doc` block. Not one file per page with a folder as the workspace —
the Obsidian shape — and not cross-file links.

Five shapes were developed and each adversarially attacked. This records why
the folder shape is **unbuildable on this platform**, rather than merely more
expensive, because that is the part nobody should have to rediscover.

**The write primitive does not exist.** Without the File System Access API —
Chrome and Edge only — a save is a *download*. The page lands in the browser's
download directory, outside the folder its relative links resolve against. So
on Safari, Firefox and every iOS browser, the FIRST save of any page ejects it
from its own workspace. No design gets around this; it is not a link problem.

**On iOS a relative link returns the wrong answer, not an error.**
`tray/ios/EditorViewController.swift` answers every request on a document's
origin with that document's own bytes, so `href="./other.bento.html"` does not
404 — it re-serves the space you are already in at a different URL. Silently
wrong is worse than broken. Filed as a tray-zone request: 404 anything but
`/index.html`.

**Fragment routing is legal exactly where path routing is illegal.** Measured
from an origin-null document: `history.pushState(s,'','#p/<id>')` succeeds,
while `history.pushState(s,'','other.bento.html')` throws `SecurityError`. The
grammar the one-file shape needs is the one the platform permits.

**The folder shape buys no free OS search here.** `mdimport` on a shipped shell
returns `kMDItemTextContent = "<<< Text content of 75 characters >>>"` —
document text lives inside a `<script>` block and Spotlight cannot see it. True
of slides today too. Cross-file discovery needs an index either way.

**Prose is not the scale ceiling.** 2,000 pages / 26,000 blocks is a 5.2 MB
file that parses in 3.4 ms. Images are the ceiling, which is a product-shaped
limit, not a format one.

What the file boundary also becomes, and this is the design rather than a side
effect: the id scope, the link scope, the sharing boundary, the `docId` scope
(hence autosave and version history), the undo scope, the encryption scope, and
the save scope — every save rewrites the whole file.

Accepted costs, unchanged: sharing is per-file so there is no per-page
permission, and two people editing offline get two files and no merge until the
CRDT is generic. The pressure valves are first-class — export a page as its own
space, export a space as a markdown folder, import either.

The library tier — many spaces, searched together — attaches at a named seam
and is `bento/vault`'s job, which is optional by its own invariants 2 and 3.
One space needs nothing installed, ever; a library is software you run, on a
laptop or a 24/7 box or a cluster, the same artifact either way.

## 2026-08-03 — tray/webext ships through the stores; unpacked stays available

Settled with the maintainer. The **app stores are the main distribution
channel** for `tray/webext` — Chrome Web Store, Edge Add-ons, and the others as
they come — with the unpacked folder in this repo remaining a supported option
for people who want it.

Two corrections to earlier reasoning in this thread, both of which had made the
extension look less viable than it is:

**Developer mode is not required.** It is needed only for "Load unpacked". A
store-installed extension needs no Developer mode, no unpacked folder and no
warning banner. An earlier note in this session treated that as an inherent
cost of the whole approach; it is a cost of one distribution method.

**Store distribution does not conflict with the signed-release model.**
`docs/RELEASING.md`'s "signed locally, the signed bytes are the served bytes"
governs the DOCUMENT SHELL and its self-update channel. The extension is not a
document, carries none, and never touches that path, so a store-distributed
extension and a locally-signed shell coexist. What a store actually costs is
review latency and a second release cadence — ordinary, not philosophical.

**What does survive a store listing** is `Allow access to file URLs`: a
per-extension user toggle, off by default, required for content scripts on
`file://`. No manifest permission grants it. It is, however, DETECTABLE via
`chrome.extension.isAllowedFileSchemeAccess()`, so the extension can turn silent
failure into a guided one-time setup step rather than a mystery. That API's MV3
behaviour is unverified — measure before building on it.

Consequences already implemented: `permissions` trimmed to `storage` (an unused
`offscreen` would draw review questions it cannot answer), and content scripts
narrowed from every `file:///*.html` to `file:///*.bento.html`, which is both
correct and far easier to justify to a reviewer.
## 2026-08-02 — No extension system: compact per-app runtimes instead

The recurring proposal is an extension mechanism — sealed, separately signed
units that bake into a file like language packs do, so a heavy optional feature
ships on its own clock instead of riding the shell release. The immediate case
was a PowerPoint exporter carrying a large vendored dependency. The wider case
was that a mechanism built once would serve `bento/spaces` and `bento/dash` too.

**Declined, for every app.** Bento ships small, self-contained runtimes per app.
A feature is either core or it is a separate artifact — not a plug-in tier in
between.

This CONFIRMS rather than supersedes *"The pack carrier is generic; pack POLICY
is not. This is not a plugin system."* (2026-07-26). That entry stands exactly
as written: the carrier stays generic and reusable, and the reason to keep it
that way is engineering hygiene, not a plugin system waiting to be finished.

**The multi-app argument is the strongest evidence against, not for.** Bytes do
not amortize across apps, they multiply: every app pays the host, the container
and the per-app i18n for the machinery. Measured against real builds, the
cheapest extension host costs more than the entire `bento/spaces` shell as it
stands (10,052 B). Only review effort and one browser matrix amortize, and that
was never the expensive half. Worse, neither unbuilt app wants it: their designs
contain no extension-shaped feature, one of them independently ruled out
shell-block work and forbids carried user code outright, and both solved their
heaviest import/export payloads with browser primitives (`CompressionStream`,
`DOMParser`) and no dependency at all. An abstraction with zero confirmed
consumers, designed against two apps that do not exist yet, is the textbook case
for not building it.

**The economics invert once you follow the bytes.** An extension bakes into the
FILE, so the user who exports pays the dependency *and* the machinery, while the
user who never exports still pays the host. For the exporter that is worse than
merging the dependency into core unchanged. The break-even against a first-party
in-shell writer needs fewer than ~13% of users to ever use the feature — and for
a PowerPoint replacement, PowerPoint interop is the adoption path, not a fringe.
The same money buys far more as core: a first-party writer prototype targeting
the same format came in roughly 35x smaller than the vendored library it would
replace, using the same `CompressionStream` technique.

**Three extension mechanisms already exist, and they are better.** The Claude
Code plugin/skill channel extends Bento by RECIPE (`plugins/bento-slides/`) at
zero shell bytes and on its own clock. The native host bridge
(`tray/ios/Resources/bridge.js`) extends capability at the host, and reaches
every file ever saved — including ones that predate it. The kernel facade
pattern (`slides/src/charts.ts`, six lines over `kernel/src/charts.ts`) shares
implementation by structural typing with no frozen surface at all. Each costs
zero platform invariants. Reach for these before inventing a fourth.

**What this does NOT decide.** Kernelizing the language-pack channel
(`packs.ts` parameterised per app) is still wanted — both future apps list it as
blocking, and it is unrelated to extensions. So are the defects found while
looking: the offline switch does not gate pack fetches although `docs/security.md`
says it does; the shell-block registry is single-slot, so a second registrant
clobbers the first; and a block that fails to parse is skipped on read and then
removed by the clear pass, which deletes it permanently on the next save. Fix
those on their own merits.

**What would reopen this.** A confirmed second consumer in a shipped app, a
feature that genuinely cannot be core (a licence that forbids bundling, or bytes
that dwarf the shell even after a first-party rewrite), or a demonstrated need
for third-party authorship. Absent those, the answer to "should this be an
extension?" is "should this be core, a separate artifact, or a skill?"

## 2026-08-03 — Callout tones are GitHub's five, and the tone is never hue alone

**Decision.** `bento/spaces` gains a `callout` block whose `tone` is one of
`note` `tip` `important` `warning` `caution` — GitHub's alert vocabulary,
spelled the way GitHub spells it. That makes markdown export the identity
function (`tone` ⇄ `> [!TONE]`) instead of a mapping table, and a mapping table
is exactly the kind of thing that can be got wrong once and then never
corrected, because the wrong tone is already in files on disks.

**Five, and no `success`.** Docusaurus's set (note/tip/info/warning/danger) and
MkDocs' thirteen were the alternatives. The format is additive, so a sixth tone
can be added later — this build renders an unknown one neutrally, labels it with
its own word and preserves the string — while removing or renaming one is
impossible. When the decision is one-way, ship the smaller set.

**The icon is DERIVED from the tone, with an optional stored override.** Storing
it always would freeze today's glyphs into every document written today and let
the tone and the mark disagree (a "warning" wearing 🎉). The override exists
because a celebration is a callout too, and it never changes what the tone
means, in the styling or in the export.

**Meaning is carried by shape and by a word, never by hue.** Each tone's mark is
a different silhouette (circle, bulb, square, triangle, octagon) and its name is
rendered beside it as real text, translated. The tints are decoration: amber,
red and green are precisely the hues most colour-blind readers cannot separate,
and print drops backgrounds by default anyway. Body text stays `--ink`, not the
tone colour — a box exists to make a sentence more readable, not less.

**Nesting is a registry fact now.** `BlockSpec.container` is `'fold'` (toggle) or
`'always'` (callout); `render.ts` opens a body element from that rather than
testing for the type name, and `mdQuoteChildren` drives the `> ` marker every
descendant line needs (a GitHub alert ends at the first line without one, and
a blank line between two blocks of one alert closes the box). ⏎ inside a callout
puts the next line INSIDE it and ⌫ on an empty line takes you out — deliberately
not extended to `toggle`, because a fold can be shut and a caret inside a shut
fold is a lost line.

Details: `spaces/src/blocks.ts` (the registry entry, `CALLOUT_TONES`,
`mdLayout`), `spaces/src/render.ts` (`toneLabel`), and the callout section of
`scripts/test-spaces-model.ts`.
## 2026-08-03 — Code highlighting is in-house, offsets-only, and render-time

**Decision.** `bento/spaces` highlights code with its own ~350-line lexer
(`spaces/src/highlight.ts`), not a library, in eight languages: JavaScript,
TypeScript, Python, Shell, JSON, YAML, SQL, HTML/XML, CSS. Everything else
renders plain, deliberately.

**Why no library.** highlight.js is ~120KB and the useful subset of Prism is
~30KB+; the whole spaces shell was 72KB compressed. Either is the largest thing
in a product whose premise is that you can mail the file. Measured after
shipping ours: the lexer + painter + chip + palette cost **4.0KB compressed**,
and all eight vocabularies together a further **1.4KB** — ~180 bytes per
language, because keyword lists are lowercase ASCII and deflate eats them. So
the machinery is the cost and languages are nearly free, which inverts the
instinct to "support fewer languages to save space". It also means the honest
reason to stop at eight is testing, not bytes.

**Which eight.** What a working notebook accumulates — shell one-liners, a
config file, a snippet from the codebase — not a survey of languages. Adding a
curly-brace language is one keyword list; resist it anyway, because a language
nobody tested renders *nearly* right, which is worse than the plain fallback.
An unknown tag is kept verbatim in `lang`, so a `rust` block round-trips,
exports as ```` ```rust ````, and lights up by itself if the lexer learns it.

**THE TOKENIZER RETURNS OFFSETS, NEVER STRINGS.** A token is `{kind, a, b}` into
the caller's text and the tokens partition `[0, len)` exactly. That is the
security property, not tidiness: code in a space is text someone mailed you, and
a highlighter that cannot produce a character cannot produce markup, whatever
the input does. The painter walks the ranges and builds nodes with
`createTextNode`; there is no constructed markup string anywhere in the path and
therefore no escaper to get wrong — which is how every other highlighter on the
web does it, and why they all need one. `scripts/test-spaces-model.ts` asserts
the partition across every language over a corpus that includes `</script>`,
`<img onerror>`, unterminated strings and lone backslashes.

**Colour never enters the document.** `Block.html` stays the html-escaped plain
text it always was, so the same block is the same bytes whether or not the
reading build can highlight it, and reading view and print get their colour from
the same `renderBlock` call the editor uses. The editor's code host is therefore
read as `textContent` (not `innerHTML`, which now contains the colour spans) and
written through `sanitize.ts escText`, which escapes `&`, `<`, `>` and *not* `"`
— matching the html serializer exactly, so an untouched block never serializes
differently from the save before it.

**Highlighting a live contenteditable: reconcile, do not replace.** The painter
diffs the token stream against the existing child nodes and mutates only what
differs. The point is that on `input` the browser has ALREADY applied the
keystroke, so re-tokenising usually yields byte-identical nodes: measured in
Chrome on the built shell, typing in the middle of a line produced **one
`characterData` mutation (the browser's own) and zero `childList` mutations**,
and the caret moved 76 → 77 — untouched rather than restored. Only a keystroke
that moves a token boundary restructures anything; typing `"` produced
`childList` records and the caret went 79 → 80, restored by character offset.
An explicit save/restore on every keystroke would have been simpler and wrong:
assigning `Text.data` is specified to collapse a live range inside it to offset
0, so the restore has to exist — it just must not be the common path. IME
composition is skipped until `compositionend`; the model keeps up regardless.

**Found while building this: every markdown trigger was dead.** A space typed at
the end of a contenteditable line is inserted as U+00A0 so it cannot collapse.
Measured: after typing `## `, `host.textContent` is `['#','#',160]`, so
`/^## $/` never matched — `# `, `- `, `1. `, `> `, `[] ` and `--- ` had never
fired since 0.1.0. `autoformat` now normalises the NBSP before testing (never in
the model). This surfaced because the ```` ```lang ```` fence needs the same
trailing space; the bare ```` ``` ```` trigger was changed to be
space-completed, both for consistency with every other rule in that table and
because there is no keystroke left to type the language into otherwise.

**A trailing newline in an edited code block is Chrome, and it is bounded.**
Measured on a bare `pre-wrap` contenteditable with no Bento code involved:
inserting multi-line text yields one trailing `\n` (the caret placeholder), and
it does not accumulate — seeded with `abc\n` and typed into, the result is
`abcy\n`, still one. Left alone; the previous `innerHTML` read produced the same
byte.
## 2026-08-03 — Imported frontmatter is kept verbatim, not turned into properties

**Decision.** `spaces/src/markdown.ts` puts a note's leading `---` YAML into a
`code` block with `lang: 'yaml'` and `frontmatter: true`, nested inside a
collapsed `toggle` at the top of the page. Nothing in it is parsed, and no key
becomes a document field. The page title comes from a leading `# Heading` or
else from the FILE NAME — never from a `title:` key.

**Why not properties.** Spaces has no properties model, and this is the first
feature that meets one. A schema invented inside an importer would be derived
from whichever keys one person's vault happens to use (`tags`, `aliases`,
`cssclass`, `publish`), and once files carry it there is no server to migrate
them: the format is permanent. That would settle a design by accident, in the
one place with the least information about it.

**Why verbatim beats dropping or hiding it.** The yaml is the author's text and
some of it is load-bearing (`aliases`, `permalink`). Kept as a code block it is
visible, searchable by ⌘K and ⌘F, printable (toggles always print open), and it
exports back out as a fenced yaml block. `frontmatter: true` is an additive
marker, which is what makes the eventual adoption a mechanical sweep — find the
marked blocks, parse them then, delete the toggle — rather than an archaeology
exercise over prose.

**Why the title ignores `title:`.** `[[wikilinks]]` resolve by FILE NAME, which
is what Obsidian, Foam and Logseq all do. A title taken from frontmatter that
disagrees with the file name produces a page nobody can link to by the name
their other 300 notes use.

**What would reopen this.** A properties model shipping. At that point these
blocks are the migration input, and the marker is what makes them findable.
## 2026-08-03 — The spaces agent surface: plans, tagged results, and a validator that stays quiet

**Decision.** `window.bento` in bento/spaces gains `validate()`, `outline()`,
`stats()` and the patch verbs `updateBlock`, `removeBlocks`, `moveBlock`,
`updatePage`, `removePage` (`spaces/src/agent.ts`). Five rules were settled
along the way, and each is the kind another agent could reasonably reverse.

**A validator earns its severities by being silent.** The bar is not "few false
positives", it is ZERO findings on the space every new file opens with —
asserted in `scripts/test-spaces-model.ts`, which is the only baseline of
"idiomatic" available. The corollary is what is NOT checked: unknown property
names. Slides warns about them because its element schema is closed; here
unknown fields are the mechanism by which a future build's data survives an
older one, so warning about them would fire on documents working exactly as
designed. An agent that gets warnings for good documents stops reading them.

**Plan, then apply.** Every write verb returns `{ok, apply}` and the wrapper in
`main.ts` runs `store.commit(apply)`. `commit` checkpoints undo BEFORE it
mutates, so validating inside the commit would leave a refused patch with an
undo entry that undoes nothing. Verified in the browser: three refusals of three
kinds, then one undo, reaches the state before the last real edit. The split
also makes the whole write path testable in node — no store, no DOM.

**Tagged results for the new verbs; the old two keep their shapes.**
`insertBlocks` (ids | null) and `newPage` (id | null) shipped in 0.1.0 and are
in a published guide, so they stay. Everything added returns
`{ok:false, err, detail}`, because "it did nothing and told you nothing" is the
failure mode this whole surface exists to remove. For the same reason a patch
naming `id` (or `blocks` on a page) is REFUSED rather than ignored.

**An agent cannot write what the app could not have written.** `html` is
sanitized on the way IN, not only on the way to the screen; a `code` block's
html is escaped text instead (the renderer shows its textContent, so sanitizing
would delete the sample being shown), and only when it carries live tags, which
keeps a replayed patch from double-escaping. Values JSON cannot carry — a
function, a Date, a Map, a cycle — are refused rather than vanishing at save.

**A page is never left with zero blocks.** MEASURED in the built shell: a page
with `blocks: []` renders 0 editable hosts, 0 gutters and 0 block nodes — the
caret, the gutter and the `/` menu all hang off a block, so nobody can ever type
in it, and the editor cannot produce one (`mergeBack` refuses at the first
block). So `newPage` mints a paragraph as `model.newPage` always did,
`removeBlocks` refills a page it empties, and `validate()` calls a zero-block
page an ERROR. The old `bento.newPage()` created exactly this page.

*Amended 2026-08-04.* That was measured against the EDITOR, which still
cannot produce one. The markdown importer landed in the same tree and produced
them freely — one per folder without a folder note, one per empty file, plus
the invented root — and then navigated to one, so the first thing a vault
import showed you was a page you could not put a caret in. An invariant proved
for one writer is not proved for the next one; `planImport` now guarantees it
too, at the single point where it returns.

**Cost.** +8,040 bytes on the shipped shell (73,787 → 81,827; compressed
payload 72KB → 79KB). Most of it is the finding messages, which are the
product: a code with no explanation is not actionable. Anyone tempted to shrink
this should shorten prose, not drop checks.

## dash: a workbook holds two kinds of sheet — spreadsheets and datasets

2026-08-11. Settles a tension that was shipping as a visual lie.

An 8-row dash sheet has no row 9. ArrowDown from the last row does not move,
pressing `=` there opens the editor on the last DATA cell, and the ruled lines
under the totals row — which look exactly like empty spreadsheet rows — are
background paint on `.dg-table`. So the most common gesture in spreadsheets,
"click below the numbers and type `=SUM(`", silently targets a cell holding
real data. The footer total is not a formula and cannot be one: it is
`sheet.totals`, a property of the column.

THE DECISION: two sheet kinds, and the difference is where the type lives.
A SPREADSHEET is typed by CELL — unbounded, sparse, `=SUM()` anywhere, a canvas
that happens to hold numbers. A DATASET is typed by COLUMN — exactly the rows
there are, columnar and dictionary-encoded, and the kind that earns column
formulas, type refusal on import, conditional formats, chart binding, pivots
and (when it lands) SQL.

Neither is a lesser version of the other, and collapsing them either way loses
something real: one type per cell destroys the column type that the columnar
kernel and every derived feature depend on; one type per column destroys the
scratchpad. The conversion BETWEEN them is the actual product — promote a range
to a dataset, or open a dataset as a flat copy for the one awkward number the
pipeline cannot express. That round trip is why people abandon BI tools for
Excel, and dash can hold both ends of it.

WIRE WORDS: `kind: 'table'` remains the dataset. Renaming it would break every
file that exists, and "Dataset" is a display label — the rule `select()`
already follows. The new kind is `kind: 'grid'`.

This is safe to add because `parseDoc` preserves an unrecognised `kind`
VERBATIM rather than coercing it to a table (PLATFORM §3 additivity, fixed
earlier and commented in model.ts). Old builds round-trip a spreadsheet sheet
without damaging it.

Consequences recorded now rather than discovered later: the CRDT keys dataset
rows by `rid` and a spreadsheet has none, so its cells are keyed by POSITION
(`g␟<sheet>␟<col>,<row>`) and a row insert MOVES cells rather than renumbering
identities — a different convergence problem needing its own rig, not a reused
one. `a1.ts` already lexes `Sheet1!A1` but nothing resolves it, and a
spreadsheet without cross-sheet refs is half a spreadsheet, so that is in scope
for the kind. `.xlsx` import should land as a SPREADSHEET rather than guessing
a column model — which is what `CellOverride.xlsxF` (the formula kept verbatim
because dash cannot place it in a column model) has been evidence of all along.

Full design: `docs/dash-sheet-kinds.md`. Not built.

## dash: one view vector, read by everything that describes the view

2026-08-11. Filtering and sorting write `store.order[sheetId]` — an index
vector, view state, no checkpoint and no op, so they never dirty the file.
Three surfaces described that view and only one read the vector.

Measured on the starter workbook, filtered to deals over £10,000: the grid drew
four rows worth £69,050, the footer said £97,050 in bold underneath them, the
chart drew a third bar for two of the removed rows, and the status bar said
"4 of 8 rows" — right, until anything else changed, because `showView()` had a
single caller inside the filter menu.

THE RULE: anything that describes the view reads the same vector. `aggregate`
(grid.ts) takes it, `optionFor` (chart.ts) takes it as a row index list, Find
walks it, and `viewStatusText` is derived from it in grid.ts because the grid
owns the view. `applyView()` is the funnel every path already goes through —
sort, filter, clear, sheet switch, structural edit — so it announces.

A SORT MUST NOT MOVE A TOTAL and a FILTER MUST. A sort permutes the vector, so
summing through it is unchanged; a filter shortens it. Both are guarded, and
the sort case is the one worth having a test for, because getting it wrong is
invisible.

Excel agrees, which was discovered afterwards and is reassuring rather than
load-bearing: a table's totals row is `SUBTOTAL(109, …)`, and `SUBTOTAL` ignores
rows a filter has hidden.

## dash: the chart is pinned to the sheet it was made from

2026-08-11. A chart is an argument about one table — `StoryStep` already
carried `sheet` beside `chart` for that reason. It does not follow the tab bar.
Reading `grid.sheet` instead left the previous sheet's chart painted beside the
new grid, and the next edit redrew it as an empty axis against columns that had
never existed on the sheet in front of the reader.

It names its sheet in the heading when that differs from the one on screen, and
offers to re-bind rather than re-binding itself: a silent re-bind changes what
the chart asserts without anyone asking, which is the same failure as
staleness. If its sheet is deleted the panel closes rather than holding numbers
about nothing.

The cause of the filter half is worth recording separately: filtering emits
`view`, never `doc`, and only `doc` was listened for. That is not a chart bug,
it is what happens when view state is invented later than the listener.

## dash: sheet tabs at the bottom, and reorder is a patch

2026-08-11. Sheets moved from a list in the left properties panel to a tab
strip along the bottom edge. The panel existed only for that list, so it is
gone and the grid is ~200px wider at every size.

Sheet order is TAB ORDER and it lives in the document, so a reorder is an
undoable patch whose inverse carries the ORIGINAL index — one undo returns a
dragged tab to where it was, not to the end. Reorder is implemented on mouse
events rather than HTML5 drag-and-drop, which is untestable without a real
mouse and dead on touch; `Move left` / `Move right` in the context menu give
touch and keyboard the same operation.

The active tab carries ONE mark: a 2px rule in the ink colour. It first shipped
with four — rounded corners, a border, a 3px amber bar and a heavier weight —
because each had been added to satisfy a contrast measurement and none was
removed afterwards. The brand amber is 2.02:1 on white and cannot carry a
non-text indicator alone, which is what forced the props. Ink is 14.51:1 light
and 13.75:1 dark, so one mark suffices. Amber stays on things about the
DOCUMENT: the unsaved dot, a filtered column header. A tab is navigation.

## dash: Find searches the file, because the grid is a window onto it

2026-08-11. About forty rows of a 5,000-row sheet exist in the DOM. Measured:
`document.body.innerText` holds 1,528 characters for 20,000 cells, and Chrome's
own `window.find('Customer 5000')` returns FALSE for a value plainly in the
file. So the browser's find is not merely unhelpful here, it is WRONG with the
browser's authority behind it, and that is what earns dash the right to take
⌘F. Where the grid is not painted — the dashboard — the key is given back,
because there the browser can see everything and taking it would be a downgrade.

Matching runs over BOTH the displayed text and the stored value, and the hit
records which matched. That is not cosmetic: `12,400` and `£` exist only in the
rendering, `12400` only in the file, and which one matched decides whether
Replace may touch the cell. A match found only in the formatted text is refused
and counted, because there is no defensible way to push a substring of a
rendering back into a number.

Hits walk the VIEW VECTOR, so a find never jumps to a row the filter is hiding,
and Replace patches are keyed by RID so a filter cannot re-target a write.


### Correction, same day: the spreadsheet kind already existed

The entry above proposed `kind: 'grid'`. Wrong — `CanvasSheet` is the
spreadsheet kind and has been in the format since commit one, deliberately:
"the classic sparse A1 map… in the format from commit one, because an escape
hatch added later is permanently second-class (PLATFORM §3)". It carries the
sparse cell map, per-cell value and formula, column widths and row heights, and
per-cell colour/background/bold/alignment — which also answers the "no cell
formatting at all" gap for that kind.

So the decision stands and the model change is nil: `table` is the dataset,
`canvas` is the spreadsheet, and the work is implementation, not format. Adding
a third kind would have left two half-built spreadsheet kinds. "Canvas" stays
the wire word; the label a reader sees is "Spreadsheet".
## 2026-08-15 — The sync engine's shape gains a text property, and children become optional

**Context.** `DocShape` described a document as two levels — `parents` holding
`children` — and hard-coded `'html'` as the property carrying collaboratively
edited text. Both shipped apps fit: a slide holds elements, a page holds
blocks, and in each the text is on the child. bento/type fits neither. Its
`body` is a flat list of blocks, a block IS the paragraph, so its text sits one
level up and there is nothing beneath it to point `children` at.

**Decision.** Two additive changes to the shape, both proven byte-identical for
existing files by `scripts/test-sync-equiv.ts`:

1. `DocShape.text` names the property that gets the token RGA. It defaults to
   `'html'` in `shape()`, so slides and spaces are untouched.
2. `DocShape.children` may be `null`, meaning a FLAT document with no element
   layer. `C()` then reads as a frozen empty array and the differ never mints
   an element op; `applyEffect` drops an element-scoped op that arrives anyway,
   because it has nowhere to land.

`shape('body', null, 'text')` is type's binding.

**Why the text property had to be named rather than inferred.** It is the one
property whose merge behaviour decides whether two people can type in the same
paragraph at once. Everything else is a last-writer-wins register, which for
prose means one author's work disappears — and disappears SILENTLY: the
document stays valid, the replicas converge, and the result simply contains one
of the two edits. There is no error to notice.

**That failure mode is why two new rigs exist.** The four existing sync rigs
stayed green through every step of this change, including through a real bug —
none of them declares text anywhere but on a child, so none of them exercised
the new path at all. Green there means "nothing broke", never "the new thing
works".

- `scripts/test-sync-parent-text.ts` isolates ONE variable: text on a parent,
  children still present. It carries a **negative control** — the same scenario
  with the RGA off must lose an edit — because a rig that has never been seen
  failing is not a gate.
- `scripts/test-sync-flat.ts` binds type's real shape. Besides convergence it
  asserts the document keeps its SHAPE: an engine that quietly wrote
  `elements: []` onto every block would converge perfectly and still corrupt
  the format, so that is checked directly rather than inferred from
  convergence.

**Two bugs found this way, both invisible to the existing suite.**

- Making `text` configurable, the CONDITIONS were rewired to `S.text` while the
  OPERANDS stayed hard-coded — `diffText(id, bp.html, ap.html)`, the
  materialize write-backs, and four register keys built as `` `${el} html` ``.
  Every one is correct while `S.text === 'html'` and wrong for any other app.
  Grepping for `.html` does not find the register keys; they are template
  strings.
- The flat-shape guard read `op.el` as "this op is element-scoped". On a `txt`
  op `el` is the NODE key, which for a flat document is the block's own id — so
  the guard dropped every collaborative keystroke type would ever send, while
  structure ops kept converging. One author's edits landed and the other's
  vanished.

**A trap for whoever tests this next.** Two fixtures here read correct
behaviour as a bug: both minted an op, never delivered it, then delivered a
later one and found it had no effect. That is the per-actor sequence guarantee
holding the second op in the gap buffer, exactly as designed. Deliver the whole
sequence.

**Not done here.** type's session/transport layer is still slides-shaped
(PLATFORM §9), so this makes type's collaboration possible, not present.

## 2026-08-15 — bento/type's sync binding, and doc-level maps become a shape field

**The binding.** `type/src/sync/crdt.ts`, a facade like the other two apps':
`shape('body', null, 'text', ['footnotes'])`. It is the first FLAT binding and
the first whose text is not on a child; both were kernel changes made earlier
the same day, not things this file works around.

**Doc-level maps are now declared by the shape.** `assets` and `blobs` were
hard-coded as per-KEY registers, with the right reason attached: two people
adding different assets concurrently must both keep theirs. Any id-keyed map
wants that, and an app could not ask for it while the names were baked in.
`DocShape.maps` now names them; `shape()` unions the caller's list with
`assets`/`blobs` so an app declaring its own cannot accidentally drop those.

type's `footnotes` (note id → note text) is such a map. As one whole-value
register, two authors each adding a footnote kept both REFERENCES — those live
on different blocks and merge independently — while one of the two BODIES was
overwritten, leaving a marker in the text pointing at nothing.

**Measured, not argued.** Over 120 seeds × 60 steps × 3 actors:

| | before | after |
|---|---|---|
| seeds with a dangling note | 34 | 5 |
| seeds with any format violation | 30.8% | 7.5% |

**What the rig reports rather than asserts.** A block's `text` merges token by
token through the RGA, while its `marks` and `notes` are CHARACTER OFFSETS into
that text and merge as ordinary registers. Two independent merge domains
describing one paragraph — the same shape of problem `parent`-versus-position is
for bento/spaces, and like that one it is a format-level decision rather than a
bug to patch inside a rig. At 400 seeds × 80 steps × 4 actors (19,016 ops),
11.8% of seeds converge on a document with at least one violation.

The rig carries a worked example, because a percentage is not an account of
what goes wrong. Both authors insert text BEFORE a bold phrase and both shift
their own marks correctly with the app's `spliceText`:

```
merged text: "Notwithstanding the above, Under clause 4, Payment is due within 30 days."
bold covers: "t is du"   (it should cover "30 days")
```

Neither replica ever held the correct offset — it is shifted by BOTH insertions
— so no register winner could have been right. `STRICT=1` turns the report into
a gate the day the decision is taken.

**Two smaller findings, named so they are not rediscovered as bugs.**

- Concurrent deletion can empty `body` entirely (4 of 400 seeds). A document
  with no blocks is not one the editor should ever present.
- The residual dangling notes are the same cross-domain split one level up: the
  REFERENCE is a block property and the BODY is a map entry, so deleting a
  footnote concurrently with editing its paragraph can keep one and not the
  other.

**Convergence itself is compared by VALUE, not by `JSON.stringify`.** A property
deleted and re-added moves to the end of its object, so replicas that applied
the same removals in a different order hold equal documents with different key
order — 288 of 400 seeds, every one spurious. Checked rather than assumed
before relying on it: canon.ts sorts keys (RFC 8785 §3.2.3), so two blocks
differing only in key order produce the same signing digest, and the redline
aligns on block id.

**Not done here.** The session and transport layer is still slides-shaped
(PLATFORM §9). type has a converging engine, not live collaboration.

## 2026-08-15 — The sync session and transport move to the kernel, behind a five-method host

**Context.** `crdt.ts` was kernelized and parameterized by document shape, but
the layer above it — the session (differ hook, shadow, presence, catch-up, gap
recovery, blobs, the fork snapshot exchange) and the online relay transport —
still lived in `slides/` and was slides-shaped. bento/dash had already responded
by PORTING `online.ts` wholesale (`dash/src/sync/online.ts` still says so in its
header). A second copy of the transport is a second thing to fix when the relay
protocol changes, and the relay is the part that must not fork.

**What actually coupled the session to slides.** Of 727 lines, FIVE places knew
what a slide was: repairing an emptied document, clamping the view, pruning a
selection, saying where a person is for presence, and recognising embedded media
in a refused batch. `online.ts` had exactly ONE: the hard no-network switch.
`blobs.ts` had none and moved untouched.

**Decision.** `kernel/src/sync/{session,online,blobs}.ts`, with apps supplying a
`SyncHost`: `heal`, `clampView`, `presence`, the store event names, a
`carriesMedia` probe, and the shape-bound engine class. `slides/src/sync/*.ts`
are facades, so `new SyncSession(store)` still works everywhere it already did.
bento/type gets one too, and needed no kernel changes to do it.

**Test first, and this time literally.** The session had NO tests. Moving
untested code across a seam is how behaviour changes silently, so
`scripts/test-sync-session.ts` was written against the implementation AS IT
SHIPPED, run to 13/13, and then run UNCHANGED after the move — same 13/13,
including the same merged string from a concurrent text edit. It drives the real
session over the real store through a real BroadcastChannel; two sessions in one
process are two tabs of one document, which is the transport that ships.

**Running app source in node needed a hook, and that was the right trade.**
`scripts/lib/ts-resolve-hooks.mjs` resolves Vite-style extensionless imports and
transpiles with esbuild — Node's built-in TypeScript is strip-only and rejects
`constructor(private store: Store)`. The alternative was editing session.ts to
drop the parameter property, which was rejected on principle: a rig that exists
to prove behaviour is unchanged cannot start by changing its subject.

**Two decisions inside the move worth keeping.**

- The offline switch is INJECTED (`setOfflineCheck`) and the kernel default is
  OFFLINE. Defaulting the other way means an app that forgot to wire it starts
  phoning home silently, which is the one failure this project should never
  ship.
- `PresenceInfo.slide` keeps its name on the wire. It now means "where this
  person is" — a block id for type — but deployed clients and the relay read
  that field, so renaming it would fork presence.

**bento/type now has live collaboration end to end**, proven through the store,
the differ, the debounce, a real channel and back:

```
two people typing in one paragraph:
  "Payment is due within sixty (60) days of invoice."   ← both edits survived
```

Its host also pins a word-processor-specific rule the kernel could not know: a
remote edit arrives through `Store.touch`, never `commit`, so it never lands on
this person's undo stack. ⌘Z means "undo what I did" — a remote paragraph
arriving as a commit would make it revert a colleague's work and redo would
bring it back as if it were yours. The rig proves a local edit DOES push a step
before claiming the remote one does not.

**Not done here, and one correction.** bento/spaces has no session binding yet;
that one IS small, a host adapter over a store that already has on/emit/commit.

bento/dash is NOT. An earlier draft of this entry said dash needed "just a host
adapter"; that was wrong, and `dash/src/sync/crdt.ts` is why. Its 2,313 lines are
not a fork of the kernel engine but a DIFFERENT one, built for spreadsheet scale
— sparse per-row state so an untouched row costs zero bytes in `collab.sync`,
run-length order lists, O(inserts) rather than O(rows), sheet-scoped column ids.
The kernel engine would put O(rows) of state in the file. Merging those is a real
design question, not a refactor, and nothing here should be read as having
settled it. `scripts/test-dash-sync.ts` (23,100 checks) exercises dash's engine,
not the kernel's.

What is plausibly shared is dash's `online.ts`, whose own header calls it "A PORT
of slides/src/sync/online.ts". That is the RELAY protocol, which is the one part
that should not fork — the deployed worker verifies signatures and the
invite/member chain against it. It already imports kernel storage and update.
Left alone pending the dash session's answer on whether it is deliberately
diverged.

## 2026-08-15 — `changeEvents`: the kernel session stops assuming one app's event names

**What was wrong.** The kernelized session fired `store.emit('doc')` after every
remote change. In bento/slides `'doc'` means "something changed, repaint", so
that read as universal. It is not. In bento/spaces the store emits four events
and `'doc'` is the DIRTY/STATUS signal — repainting goes through `'tree'` and
`'page'` — so a remote op would have labelled a colleague's edit "Edited" in this
user's chrome and moved their dirty flag. The kernel had shipped one app's habit
as a default, in the very seam built to stop that.

**Decision.** `SyncHost` names both sets:

```ts
readonly changeEvents: readonly string[]     // after EVERY remote change
readonly structureEvents: readonly string[]  // extra, on a structural one
```

slides and type declare `changeEvents: ['doc']`, so neither changed. An app that
wants no always-on event declares `[]`.

**How it was found, which is the part worth keeping.** Not by a test — by the
bento/spaces session reviewing the interface before building against it. It also
caught three things in a spaces adapter this session had drafted: a `heal()` that
minted the repair page with a random id (two replicas healing concurrently would
create two pages and the CRDT would faithfully keep both — the fix is to derive
the id from `docId`), a view clamp that fell back to the home page rather than to
the deleted page's PARENT, and a `carriesMedia()` that re-decided a question
already settled by "Large assets travel out-of-band; the relay stays blind"
(2026-07-25).

The draft was deleted and `spaces/src/sync/session.ts` left to that session,
which holds context this one did not have — including a user decision taken this
week and not yet written down: a space does not auto-connect on open. The
"obvious" call there is auto-connect, and it is the wrong one; it would reproduce
the v0.9.1 regression where every anonymous visitor to the demo phoned home.

**The general lesson.** A seam is not proven by the app that shaped it. Both
defects here were invisible from bento/slides and bento/type, because both put
their text on a child, both call their repaint event `'doc'`, and both were
written by the same session. The third app is where the assumptions show, and it
is cheaper to ask its owner than to discover it after the room exists.

**Two changes left in the spaces zone**, both offered for revert: `Store.reindex()`
is now public (a remote apply writes straight to `doc`, bypassing commit, so
nothing else rebuilds the derived index), and `SpacesDoc.collab` is typed
`CollabCreds` instead of `unknown` — it was marked RESERVED "unused until collab
ships", and it ships. That type moved to `kernel/src/sync/crdt.ts` beside
`SyncStateJSON`, so a document-format type is not reachable only through the
session: the deployed relay verifies against that shape, and a second local
description of it is how a client and the worker drift apart.

## 2026-08-15 — Known gap: the moved sync modules still hold raw network primitives

**Recorded because it is security-relevant and easy to lose.** The session/
transport lift relocated four raw network calls into `kernel/src/sync/`:

```
kernel/src/sync/online.ts   new WebSocket(...)      the relay socket
kernel/src/sync/blobs.ts    fetch() × 3            blob HEAD, upload, download
```

They are not new — `git show HEAD:slides/src/sync/blobs.ts | diff -
kernel/src/sync/blobs.ts` is IDENTICAL, and online.ts differs only in imports and
type names. The lift created none of them. What it did do is move them out from
under the paths that PR #305 targets — the fix for a privately reported advisory
(GHSA-5c3x-xqp6-g94r) where offline mode leaked from five places — so they are
now just as reachable and no longer in the diff that was under review. The bypass
is unchanged; the move made it easier to miss. That is the reason this entry
exists rather than a chat message.

**The fix, not applied here because `kernel/src/net.ts` does not exist in this
tree yet:** once #305 lands, `import { netFetch, netWebSocket } from '../net.ts'`,
swap the four call sites, and add the retry guard so a refused connection does
not spin against the switch:

```ts
} catch { if (!offlineEnabled()) this.retry(); return }
```

Writing that against an interface not yet present would have been guessing.

**A second call site that is invisible from `slides/`.** `kernel/src/sync/
online.ts` now imports `offlineEnabled` from `../update.ts` directly. (An
injection point was built for it and removed once `offlineEnabled` turned out to
already be in `kernel/src/update.ts`.) If #305's re-export from `update.ts` is
ever dropped, this breaks as a typecheck failure rather than a silent bypass —
but `scripts/test-offline.ts` would not catch it either way: that rig enforces
who may touch the PRIMITIVES, not who reads the SWITCH.

**The four above are NOT the whole defect.** #305 is broader: a single chokepoint
at `kernel/src/net.ts`, plus `render.ts` remote images (`remoteSrcBlocked`), and
dash. And the same hole was found independently from the opposite direction while
auditing the pack channel for an extensions question — `slides/src/packs.ts`
never consults `offlineEnabled` at all. Verified here rather than taken on
report: `grep -c offlineEnabled slides/src/packs.ts` → 0, against THREE reachable
network paths — `fetchPinned` (:133), a bare `fetch` HEAD probe (:141), and the
listing fetch in `fetchIndex` (:228). Meanwhile `docs/security.md:140` publishes
the claim that with offline on "you can watch the network tab stay silent". For
the pack channel that is currently false.

Scoped precisely, because an earlier draft of this entry overstated it as firing
"from the moment the listing loads": `fetchIndex` has two callers and NEITHER is
at boot — `availablePacks()` (editor.ts:1342, the Manage languages dialog) and
`refreshPacksForVersion()` (i18n.ts:76, via registerUpdatePrepare). So opening a
deck offline does not hit the network from this path. The honest statement is
"from the moment the pack UI is opened". Whether the second caller is reachable
in offline mode depends on gating in the update path that nobody has traced, and
is left as an open question rather than a claim — it is moot if everything routes
through `net.ts`, which is the argument for the chokepoint.

Two people finding the same hole from unrelated directions is some corroboration
that the advisory is real and aimed at the right place. It also means the
DECISIONS entry merged as 5eaccf8 UNDERSTATES it: that entry describes the
packs.ts symptom, not the missing chokepoint. Cite it with that in mind.

**A separate defect in the switch itself, verified while checking the above.**
`offlineEnabled()` (kernel/src/update.ts:43) reads `lsGet('bento-offline') ===
'on'`, and `lsGet` swallows its own failure and returns null. Note where the bug
actually is: `offlineEnabled` HAS a `try/catch` returning false, and it is DEAD
CODE — `lsGet` never throws, so the catch never runs and the gate fails through
`null === 'on'` instead. The defence looks present and is unreachable, which is
why reading the function alone does not reveal it. So where storage is
unavailable — Safari private browsing, a blocked file:// context, an opaque
origin — the gate answers ONLINE. The UI diverges rather than agreeing with it:
editor.ts:2871 seeds the checkbox from `offlineEnabled()` once, then :2873 calls
`setOffline(offCb.checked)`, whose write also swallows failure. Tick the box in
that context and the checkbox stays visibly ticked while the gate keeps answering
online, until something rebuilds the dialog. A security control that reads ON and
behaves OFF is worse than one that refuses to turn on. (Found by the bento/dash
session auditing against #305; confirmed here by reading both call sites.)

**FIXED by #305, merged as 759fb93 — verified rather than assumed after this
entry claimed otherwise.** The gate is now `sessionOffline ?? lsGet(...)` with the
in-memory value winning, `setOffline` RETURNS whether the write persisted, and the
dialog surfaces the failure. It still cannot persist across a reload where storage
is unavailable — `sessionOffline` is module state — but it no longer claims to,
which is the right shape for the constraint. `offlineEnabled`/`setOffline` moved
from `update.ts` into `net.ts`, with `update.ts` re-exporting them, so the
kernel's sync import keeps working.

**Why that fix is immune rather than lucky**, which is the transferable part: it
replaced the gate's SOURCE OF TRUTH, not its error handling. Hardening the
`catch` would have changed nothing, because the catch was never the path taken.
A defence that sits on the error path cannot protect a function that fails
without erroring.

This entry originally said the chokepoint would not fix it ("net.ts will
faithfully consult a gate that is lying"). That was true of the chokepoint IDEA
and false of the actual diff, which fixes both halves. The observation is still
the useful one — centralising call sites is not sufficient when the thing they
consult can lie — but it was already addressed, and recording a fixed defect as
outstanding is its own kind of error.

**Ordering, as it actually resolved.** #305 landed first (759fb93), which was the
right sequence: a security fix should not wait on a refactor. The kernel lift
takes second and applies the four swaps to the moved copies.

That integration is NOT a small apply, contrary to an early estimate from both
sides. Measured from this tree — and these numbers DRIFT, because origin/main
moves while the work sits uncommitted: they went from 13 commits and 69 upstream
files to 14 and 79 during a single conversation. Base 89b4462, 14 commits behind
origin/main, 28 uncommitted files here against 79 upstream, with six overlapping —
`.github/workflows/ci.yml` and `docs/DECISIONS.md` (append vs append),
`kernel/src/theme.ts` (another session's file, now also upstream), and the three
`slides/src/sync/*` rename-vs-modify pairs.

A shortcut was considered and rejected: writing `git show 759fb93:kernel/src/net.ts`
into the tree to unblock the swaps would produce a tree that is post-#305 in one
file and pre-#305 in sixty-eight, where the first failure is unattributable.

**The lift WILL fail CI on contact, by design.** `scripts/test-offline.ts` scans
`['kernel/src', 'slides/src', 'dash/src', 'spaces/src']`, so the four relocated
primitives are in scope the moment the integration lands — 3 in
`kernel/src/sync/blobs.ts`, 1 in `kernel/src/sync/online.ts`. That is the rig
working: the swaps are not optional cleanup, they are what makes the build green.
`netWebSocket(url)` returns a genuine `WebSocket` (not a proxy), so `binaryType`,
the four handlers and `.close(code)` are unchanged; the only behavioural
difference is that it THROWS `OfflineError` when the switch is on, which is why
the call site needs `if (!offlineEnabled()) this.retry()`.

**`type/src` was not in that scan list**, so bento/type — a fourth app with a
model, store, editor, pagination, signing and now a sync binding — was silently
exempt from the policy. It has no network path today (verified: zero matches for
all five primitives), which is precisely why it was worth raising while the fix
could not fail.

The fix taken was better than the one proposed, and the argument for it was in
the complaint. Adding `'type/src'` to the array fixes type and leaves the NEXT
app — and the next app is by definition the one nobody is thinking about. So the
list became DISCOVERY: any top-level directory containing `src/` is in scope, and
an app joins the policy by existing (slides #307). Discovery has its own failure
mode, and it is this rig's own lesson one level up — a green run over an empty
list is indistinguishable from a green run over the whole repo — so it asserts
that discovery still finds the known apps and does not sweep in non-app
directories.

The general form is worth keeping: **an exemption list is a latent violation with
a date on it.** When the answer is "add ourselves to the list", check whether the
list should exist.

**`kernel/src/theme.ts` is a shadow, not a member of this change set.** It sits
untracked in the shared checkout and shows up in every overlap measurement, which
made it look like an orphan needing an owner. It is not: it is byte-identical to
`origin/main:kernel/src/theme.ts`, shipped in #285, and imported upstream by
`slides/src/editor/editor.ts` and `slides/src/main.ts`. Nobody needs to adopt it.

It cannot simply be deleted from this tree today, because this tree's base
(89b4462) PREDATES #285 — so the untracked copy is the only copy here, and
`type/src/main.ts` imports it. Delete it now and bento/type stops building;
delete it after the rebase and nothing happens, because the tracked file takes
over. So: keep it until the rebase, drop it as part of the rebase, and do NOT
commit it — committing would add a file that already exists upstream and
manufacture a conflict out of nothing.

The general trap: an untracked file that is byte-identical to a tracked one
upstream is invisible to every tool you would reach for. It does not appear in
`git diff`, it survives `git checkout`, and it makes a file look present at a
commit where it is absent. Two separate sessions reasoned about this one wrongly
in opposite directions — one concluded it was an unowned orphan safe to remove
(it is neither), the other that a downstream app depended on it and therefore
owned it (it depends on it, but does not own it).

The actionable rule, which is narrower than the trap and is what either of us
needed: **search the REF, not the working tree.** Every observation behind the
wrong conclusions was TRUE of a checkout based at 89b4462 and FALSE of main — at
that base slides genuinely does not import the file and the file genuinely is
untracked, because the base predates #285. `git grep kernel/src/theme origin/main`
is one command and shows the two slides importers immediately. A working tree
held at an old base is not a view of the project; it is a view of the past, and
"I checked" means nothing without saying checked against WHAT.

(A matching blob is also weaker evidence than it looks: it says two commits
contain the same content, not that one came from the other. The `slides-theme`
branch shares this file's bytes and never merged; the content reached main by a
different PR.)

One trap worth recording for anyone verifying this: local `main` was 802804b and
STALE — #305 is on `origin/main`. Checking against `main` reports `kernel/src/
net.ts` as absent and the slides sync files as unchanged, i.e. that #305 never
landed. Compare against `origin/main`.

---

## 2026-08-14 — a self-update must not be the one save that interrupts

**Reported against 1.0.16**, with tray/webext installed and a folder granted:
⌘S saved with no dialog, and then "Update this file" put up a macOS save panel
for `Tray_Test.v1.0.16-backup.bento.html` into ~/Downloads.

The update itself was fine — it had rewritten the file in place, silently,
through the extension. The dialog was the ROLLBACK COPY, which `applyUpdateInPlace`
handed to `downloadFile`, and downloads prompt for anyone with Chrome's *"ask
where to save each file"* enabled. So the flow's only interruption was for a
file the author never asked for, in the middle of the one operation whose whole
selling point is that it does not interrupt.

Two things were wrong, and only the first was visible.

**A backup belongs beside what it backs up.** Even silent, ~/Downloads is the
wrong place: detached from the document, one per update, and a rollback you have
to go hunting for is a poor rollback. With a host, it now goes in the folder
already granted, next to the original. Without one it is still a download —
the alternative there is a picker, which is strictly worse than the status quo
for the majority case, and the majority case is no extension at all.

**The no-handle path was declaring the wrong intent.** `writeUpdatedFileAs`
hard-coded `share`, so a document opened by double-clicking — no handle, the
ordinary case — told every host "a new file the author will choose" about a save
that is overwriting the document on screen. The host correctly declined and the
author got a picker. Same class as the 2026-08-02 finding that produced
`pickerIdFor`: intent has to be explicit in the call, because it cannot be
recovered from anything else in it. `applyUpdateInPlace` now sends `in-place`,
and `canUpdateInPlace` stops meaning "we hold a handle" — a host needs none.

**Hosts announce capabilities, not presence** (`window.__bentoHost.ops`,
`save.ts hostCan`). Presence is not a useful question: `showSaveFilePicker`
exists in Chrome regardless, and a host that declines looks exactly like one
that is absent. A host that announced itself but did not know `bento-backup`
would have passed the request to the native picker — producing the very dialog
this removes, and only for the people who installed the thing meant to remove
it. Decks and hosts version independently in both directions.

**The new op is the only one that creates a file**, so it is the only place the
page contributes to a name. Held down from both ends: the name must be visibly
derived from the sender's own (`backupNameFor` — no separator survives, and it
may not equal the original), and an existing file is never overwritten. The
directory comes from the sender's resolved path, never the payload. Worst case
for a hostile document is one predictably-named copy of ITSELF inside a granted
folder.

**Guards.** `scripts/test-savepurpose.ts` pins the update path's purpose (both
new assertions verified to FAIL against the previous commit — a gate never seen
failing is not a gate). `scripts/test-webext-background.ts` covers the name
rules, create-only, the nested-directory case, and that every refusal applying
to a write applies to a backup. `scripts/test-webext-bridge.ts` covers the
announcement, that a page cannot forge it, and that a backup never reaches the
native picker.

*Found while fixing this:* the bridge rig stubbed `Blob` as `class {}`, which
satisfied the `instanceof` branch but has no `.text()` — so every `close()`
rejected and the half of the bridge that actually sends bytes had never been
exercised, across 24 green checks. Mocks shaped to make a test pass test the
mock.

---

## 2026-08-14 — resolve by route, not by search (and the grant lapses every restart)

**MEASURED, on the reporter's machine:** a `showDirectoryPicker` grant survives
service-worker eviction, but Chrome drops it to `prompt` when the browser
restarts. The HANDLE survives in IndexedDB — the options page still knows the
folder's name — so only the permission is gone, and `requestPermission()` on the
held handle takes it back with one confirmation. That must run on an extension
PAGE (it needs a user gesture; the worker has none), which is what the
per-folder **Renew** button is.

**That "one click per browser session is the ceiling" — WRONG, corrected the
same day.** The claim was that Chrome's persistent File System Access
permissions are scoped to installed web apps, so a pure extension could never do
better. Then the reporter screenshotted the actual dialog, on
`chrome-extension://…/src/options.html`, and it offers three buttons: *Allow
this time*, **Allow on every visit**, *Don't allow*. Persistent permission IS
offered to an extension origin.

The lesson is the one this log keeps relearning: I reasoned about a permission
UI from documentation instead of looking at it, and stated the conclusion firmly
enough that it nearly settled a distribution decision — native messaging, a
signed binary per platform — that may not be needed at all.

**MEASURED 2026-08-14, and it holds: "Allow on every visit" SURVIVES a full
browser restart** for an extension origin — quit Chrome, reopen, the folder
still saves in place with no renewing. So the grant is once and for all, and
native messaging is moot. The distribution model stands: install from the Web
Store, grant a folder, done.

What is left is not a permission problem but a DISCOVERY one, and the two failure
directions are unequal. Choosing "Allow this time" costs a re-grant every
session and never says so; choosing "Allow on every visit" costs nothing. So the
extension names the button, and the first grant is the only moment anyone should
have to think about it.

The dialog can only be raised from an extension PAGE with a user gesture —
`requestPermission` needs the gesture, and the service worker has none. A deck
is a `file://` page in another origin that cannot hold the handle at all. So
"raise it from where the user is" is not available; the best reachable is to put
the button where the user already is when it matters (the toolbar popup), and to
make a lapsed grant VISIBLE before a save fails rather than after.

**Resolution no longer searches.** A `FileSystemDirectoryHandle` knows its name
but not its path, so the host walked the granted tree matching filenames —
depth-capped at 4, declining whenever two files shared a name. But a directory's
NAME must appear in the path of every file inside it. So the name locates the
split point in the sender's path and the rest is a route: `getDirectoryHandle`
per segment, then `getFileHandle`. Measured: a file inside a 500-entry grant
resolves with ZERO directory scans.

That one change is what makes the rest possible:

- **any grant size.** A home directory costs what a decks folder costs, so
  "grant everything" stops being a performance question.
- **several grants**, since each attempt is a few lookups. The store holds a
  list (`dirs`); the old `dir` key is still read so an upgrade does not silently
  drop the folder someone already granted.
- **two documents sharing a filename stop being ambiguous** — a BEHAVIOUR
  CHANGE, and the old decline was a limitation rather than a safety property.
  Only one route leads to one file. Anyone with per-client folders hit the old
  decline on every save.

The route is checked, not guessed: a wrong split point fails at the first
missing segment, and `resolve()` re-verifies what it landed on against the
sender's path regardless. A grant covering a home directory raises the cost of a
resolution bug, so that check matters MORE now, not less.

**A file reachable through two nested grants is one file, not an ambiguity** —
`isSameEntry` decides, since it is the only thing that can tell "same file, two
routes" from "two files, same name". Two genuinely different files reachable by
the same route still decline.

**A lapsed grant is reported distinctly from a missing one**, and only when NO
grant could serve the file — with several folders, one lapsing must not mask the
others, and the two need opposite things from the user: one click, or a folder.

**Guards.** `scripts/test-webext-background.ts` (57 checks): per-grant
resolution, the lapsed-among-healthy case, nested grants, two-different-files,
and a 500-entry grant asserting `enumerations === 0` — the last is the one that
would catch a silent return to searching. Plus a source-level gate that
`background.js` and `status.js` agree on the database, store and keys: they open
IndexedDB independently and cannot be loaded into one realm, so drift would mean
the options page writes grants the worker never sees — UI green, every save
prompting, nothing reporting a fault.

*Found in passing:* the rig carried a LITERAL NUL byte in a test case, which
made `grep` treat the whole file as binary and hid it from ordinary tooling. It
is now written as a `\x00` escape.

*Amended 2026-08-16:* and then **this file caught it** — the sentence above
shipped with a literal NUL where it says `` `\x00` ``, so `grep` treated
DECISIONS.md as binary and returned nothing, silently, for every query. That is
the worst possible file to lose to this: `CLAUDE.md` tells every agent to read it
before non-trivial work, so a silent no-match reads as "no prior decision" and
invites the contradiction the log exists to prevent. Found by a `grep` for a
heading that was demonstrably present. If you are describing a control character,
escape it.

*Amended 2026-08-14, later.* Two corrections to the entry above, both from
looking rather than reasoning.

**`chrome://settings/content/filesystemwrite` does not exist.** I put it in the
options page and in STORE.md without visiting it. Chrome's documented ways to
withdraw File System Access are the address-bar icon's *Remove access* and a
per-site *File editing* list reached from it — both part of the site-settings
surface for a website origin. That surface is NOT offered for
`chrome-extension://` pages: the chip there reports only "You're viewing an
extension page". Chrome's own write-up demonstrates the feature on vscode.dev
and does not mention extension origins at all.

So there appears to be **no user-facing control to revoke File System Access
granted to an extension origin**, and reinstalling does not clear it either —
an unpacked extension's id comes from its directory path, so re-loading from the
same path returns to the same origin, still granted. A different path is a
different id and a clean slate.

**And "Remove only forgets the folder, it does not revoke" was wrong** — the
pessimistic direction, but wrong. The permission is not the capability; the
HANDLE is. With no handle stored there is no object to write through, and
another can only come from the user picking a folder. Deleting it takes the
access away for real. Chrome's remembered permission means only that re-picking
that same folder may not ask again.

Which settles where this leaves the product: **the extension's own folder list
is the only place access can be withdrawn**, so it is not a convenience — it is
the control, and it says so on the page. A reviewer will ask; STORE.md answers
it in those terms.

Three wrong claims about browser behaviour in one day (persistent permissions
scoped to installed apps; a settings URL; Remove not being a revoke), each
stated confidently from documentation or memory, each disproved by one
screenshot. The rule that keeps being relearned: a claim about a browser UI is
worth nothing until someone has looked at that UI.

---

## 2026-08-14 — "Don't allow" is a one-way door, and the prompt can be embargoed

Reported: after choosing **Don't allow** on the reconnect prompt, the folder
grant lapsed on every browser restart AND the dialog stopped appearing at all.
Read out of the Chrome profile (`Profile 1/Preferences`), two independent things
had happened, neither of them a recorded "block":

**1. The granted folders were DELETED.** `file_system_access_chooser_data` for
the extension went from two directories with paths to `"chosen-objects": []`.
The extension's stored handles survive in IndexedDB, but they now refer to a
grant Chrome no longer has, so there is nothing for `requestPermission` to
restore.

**2. The restore prompt is EMBARGOED.**

    permission_autoblocking_data → FileSystemAccessRestorePermission
      { "dismiss_count": 3, "dismissal_embargo_days": … }

Chrome's permission auto-blocker suppresses a prompt after three dismissals.
`permission_actions_history` is empty and `file_system_write_guard` holds no
BLOCK — the silence is purely the embargo. `requestPermission` returns without
showing anything, so the button appears to do nothing, permanently.

**Neither is reachable from Chrome's UI**, for the same reason the persistent
grant was not: these live in their own stores, not in the content-setting
exceptions the settings page renders.

### What this changes in the product

**A Renew button is a loaded gun.** Every prompt the user dismisses counts
toward the embargo, so a UI that encourages clicking it — a notification, say —
makes the dead end easier to reach. Three impatient dismissals and saving
silently stops working.

**Re-picking is the escape, and it is a DIFFERENT permission.**
`showDirectoryPicker` is a user-initiated chooser, not a restore prompt, so it
still works under embargo and re-creates the chosen-object. So a failed renew is
not an error to report — it is the signal to ask for the folder again. Both the
options page and the popup now detect a renew that restored nothing and say so,
rather than reloading into an unchanged list, which reads as a broken button and
invites exactly the extra dismissals that cause the embargo.

**This is the strongest argument yet against raising prompts on our own
initiative.** Nothing may open the restore prompt except an explicit user click,
and the copy has to be clear enough that the click is deliberate — because the
cost of a careless dismissal is not a retry, it is the feature.

### Still unknown

Whether the embargo expires on its own (`dismissal_embargo_days` holds what
looks like a timestamp, not a count of days) and whether re-picking clears it.
Worth knowing before the store listing claims anything about recovery.

*Amended 2026-08-14, from the Chromium source.* The embargo has numbers, and
they change how the UI must behave.

`components/permissions/permission_decision_auto_blocker.cc`:

- `kDefaultDismissalsBeforeBlock = 3`
- `kDefaultEmbargoDays = 7`
- `FILE_SYSTEM_ACCESS_RESTORE_PERMISSION` is in the auto-blocked content types

`IsUnderEmbargo` is a timestamp comparison —
`current_time < base::Time::FromInternalValue(*found) + offset` — so the stored
value is the embargo's START (microseconds since the Windows epoch) and the
duration is applied at comparison time. **It expires on its own after seven
days.** The field name `dismissal_embargo_days` describes what the number is
for, not what it holds; reading it as a duration was wrong.

**Nothing an extension can call lifts it.** `RemoveEmbargoAndResetCounts` is
C++-internal, reached from browser UI paths, and `chrome.browsingData` has no
`siteSettings` type at all — its `origins` filter covers cookies, cache and
storage only. The user-facing escapes are: wait it out, *Clear browsing data →
Site settings* (profile-wide, so it resets every site's permissions), edit
Preferences directly, or move to a different extension id.

### The cost is persistence, not delay

The restore prompt is ALSO the only place **Allow on every visit** is offered.
Picking a folder afresh grants access without offering it. So an embargo does
not merely postpone a reconnect — for seven days it removes the user's ability
to make the grant permanent at all, and the extension will lapse on every
restart with nothing on screen explaining why.

### Which makes three dismissals a budget to spend carefully

The popup's Reconnect looped over every lapsed folder calling
`requestPermission` on each, so one impatient click on a two-folder setup spent
two of the three. That is an embargo accelerator, and it is the likely reason
the reporter reached the limit within minutes of the button existing.

Now: **one prompt per click, stopping at the first refusal.** Whatever made
someone refuse the first prompt applies to the second, so continuing buys
nothing but embargo.

The same reasoning condemns anything that raises the prompt on our own
initiative. A notification that nudges toward the button is a nudge toward the
dead end, and that trade — a rare lapse made visible, against a permanent
downgrade made likelier — is not obviously worth taking. Left in for now with
the loop fixed, but it should be decided deliberately before this ships.

*Amended 2026-08-14, measured cleanly.* The entry above ran two effects
together. Reset to a clean grant, restarted, pressed **Don't allow** exactly
once:

    permission_autoblocking_data → FileSystemAccessRestorePermission
      { "dismiss_count": 1 }          ← no dismissal_embargo_days key
    file_system_access_chooser_data
      { "chosen-objects": [] }        ← already empty
    file_system_last_picked_directory   ← gone entirely

They are separate, and the ORDER matters:

**One "Don't allow" destroys the grant.** Immediately, on the first refusal —
not after three. `chosen-objects` is emptied and the last-picked directory
cleared, so every stored handle is orphaned and the folder has to be picked
again. This is the damage that actually bites people.

**The embargo is secondary.** `dismissal_embargo_days` only appears at
`dismiss_count = 3`, so three refusals are needed for the seven-day block. An
explicit "Don't allow" counts toward the DISMISSAL budget, the same as closing
the bubble with the X.

So the earlier telling — that "Don't allow" left the user embargoed — was two
findings collapsed into one. The first refusal costs the folders; the third also
costs persistence for a week.

### The dialog does not say any of this

Chrome asks *"View and edit files from the last time you visited this site"* with
*Allow this time* / *Allow on every visit* / *Don't allow*. Nothing there
suggests that refusing DELETES a grant the user already made rather than
declining for now, and the wording invites a cautious person to refuse. It
cannot be changed from an extension.

So the warning goes where we do control it — on the button that raises the
prompt, and in the status line above it. Both branches are spelled out, because
Chrome's wording gives no clue about either: *Allow this time* costs a repeat
next session, *Don't allow* costs the folder.

### And a failed renew must not offer Renew again

Retrying is the losing move: it has already failed once, and each attempt spends
one of the three dismissals, while re-picking costs nothing and always works. So
a row whose renew failed hides its Renew button and offers only **Choose
again…**. The budget is small enough that the UI must not invite people to spend
it on a repeat.

*Amended 2026-08-14, and this is the one that matters for shipping.* Several
rounds of renew-and-restart later, with successful grants in between:

    permission_autoblocking_data  [17:35:52]  { "dismiss_count": 1 }
    file_system_access_chooser_data [17:41:37]  both folders back, writable

**`dismiss_count` did not move.** Six minutes and several successful grants
after it was set, it is still 1. A grant does not refill the budget.

Confirmed in `permission_decision_auto_blocker.cc`: `RecordDismissAndEmbargo`
only increments, no path resets counts on a grant, and nothing decays them over
time. They are cleared only by `RemoveEmbargo` — which no extension can call.

### So the three-strike budget is per-origin and LIFETIME

Not per session, not self-healing. A user who refuses the dialog three times
across months of ordinary use arrives at the same seven-day embargo as one who
does it three times in a minute.

And by the shape of the code — inference, not yet watched — once the count
reaches 3 it stays ≥ 3, and the embargo is re-applied whenever the threshold is
met. After three lifetime refusals, **every** later refusal would cost another
week.

That changes how much the mitigations are worth. One prompt per click, no retry
after a failure, and a warning on the button are not polish; they are the only
things standing between an ordinary user and a permanent-feeling breakage,
because the budget never comes back.

### Also observed: allowing does not imply persisting

After all the re-granting, `file_system_access_extended_permission` is still
empty — access works, but session-scoped, so the restore prompt returns on every
restart. Persistence comes ONLY from choosing "Allow on every visit" on that
prompt. A user who keeps choosing "Allow this time" gets a working extension
that asks forever, and nothing tells them the other button exists. Which is why
the copy names it in both surfaces.

*Corrected 2026-08-14. The entry above overstated the damage, and it was
recorded as measured fact — so read this one instead.*

**"Don't allow" does not destroy the grant.** It empties `chosen-objects`
immediately, which is what the earlier reading saw. But the extension's stored
handles survive, and the restore prompt eventually returns and re-acquires
EVERY folder at once through `requestPermission`. No re-picking is required.

Confirmed by the reporter: after refusing, they clicked **Renew** and only
Renew, across at least three browser sessions, and both folders came back
together. The evidence in the profile agrees —
`file_system_last_picked_directory` is absent (picking a folder sets it) while
`chosen-objects` was rewritten with both entries in one go, which is a restore,
not two picks.

**The prompt returns on a delay of more than one restart.** Those earlier Renew
clicks displayed NOTHING — `dismiss_count` stayed at 1 throughout, and a shown
prompt that is refused increments it. So `requestPermission` was returning
silently for two or more sessions before Chrome chose to ask again. What governs
that interval is not known; it is not the embargo, which never engaged.

### What this changes

**A silent Renew is "not yet", not "never".** The UI had been rewritten to treat
it as terminal and steer to re-picking — which trades a permanent grant for a
session-scoped one, since **Allow on every visit** appears only on the very
prompt being waited for. Both surfaces now say the honest thing: it usually comes
back after a restart, sometimes a later one; re-pick only if you would rather not
wait, and know what that costs.

**Hiding Renew after a failure stays**, but only for that visit — the row is
rebuilt on reload, so nothing is permanently withheld.

### On being wrong twice about the same click

The first reading ("Don't allow empties chooser_data") was correct but partial;
the conclusion drawn from it ("re-picking is the only way back") was invented to
join it to the embargo finding, and shipped as fact in copy and in this log. The
reporter's own sequence — Renew, restart, repeat — is what disproved it. A
measurement explains what it measured, and nothing about what would have happened
next.

*2026-08-14, from the source, and the resulting strategy.*

`chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc`
gates the restore prompt on the grant being DORMANT:

    context_->GetPersistentGrantType(origin_) != PermissionDatabaseType::kDormant
    context_->IsEligibleToUpgradePermissionRequestToRestorePrompt()

So there is a state machine — no grant / active / dormant — and
`requestPermission` produces the restore dialog only when there is a dormant
grant to restore. That, not a cooldown, is why Renew returned silently for two
sessions after a refusal and then worked: the docs show no backoff or
rate limit on this prompt. The exact transition rules into dormancy are NOT
established here; the gate is quoted, the rest is not guessed at.

### The strategy: prime before the prompt

Two facts settle what can be done, and neither depends on the unresolved part:

1. **"Allow on every visit" exists only on the restore prompt.** Picking a
   folder afresh grants access without offering persistence. So that dialog is
   the single opportunity, it cannot be summoned on demand, and a wasted one
   costs at least a restart.
2. **The state is detectable.** At browser startup, before any user action,
   `queryPermission` returns `granted` when extended permission is live and
   `prompt` when the grant is session-scoped. `onStartup` already runs that
   check, so the extension knows — silently and reliably — that someone is stuck
   on "Allow this time".

Chrome's dialog is three near-identical pills, and its wording ("View and edit
files from the last time you visited this site") says nothing about what any of
them costs. "Allow this time" is the cautious-looking choice and the one that
guarantees being asked forever. Prose cannot point at a button, so both surfaces
now DRAW the dialog with the middle option marked, and only then offer to raise
it.

That is the whole lever. There is no API that grants persistence, no way to
influence which options Chrome shows, and no way to re-ask sooner. What is left
is making sure that when the one prompt appears, the user already knows which
button they came for.

**Corollary for the notification.** Its job changes: not "a folder lapsed" but
"the one prompt that can fix this permanently is available now". That is a
better reason to interrupt than the original one, and it argues for keeping it —
provided it always lands on the primed popup rather than raising the prompt
directly.

---

## 2026-08-14 — the extension is a document browser, not a permissions panel

The popup's entire content was plumbing: *local file access is on, folder:
documents*. True, and nobody wants it. `tray/ios` is a
`UIDocumentBrowserViewController` — you see your documents and tap one — and
that is the right shape here too. So the tray now lists documents with real
titles and page-one thumbnails, and permission state is one line at the bottom
that stays quiet while things work.

Four pieces, three of which reuse something that already existed.

**Clickable rows come from `locateIn` run backwards.** A directory handle knows
its name and never its path, so the extension can WRITE a document it cannot
URL. But `resolve()` holds both halves at one instant: `sender.url` is absolute
and browser-stamped, and `dir.resolve()` gives the same file's route from the
grant root. Subtract, and the grant's absolute prefix falls out; store it and
every document in that folder becomes openable. Bootstrapping costs one document
opened the ordinary way, which is the premise of the product. A folder that has
never taught us its prefix still lists — the rows just say they cannot be
opened, rather than doing nothing when clicked.

**Titles come out of the document block**, which starts ~6KB in, so a fixed
300KB head reaches it. Matching the field directly matters: an earlier metadata
reader looked for the block's CLOSING tag and therefore found nothing in any
document carrying an image, since those blocks run to megabytes. The rig pins
that case explicitly.

**Thumbnails were already written.** `preview.ts` puts a still render of page one
into every saved document so file managers can thumbnail it, and this IS a file
manager. The block is self-contained and scales itself to whatever viewport it
lands in, so it drops into a 56×32 sandboxed iframe with no work — exactly what
it was built for. Encrypted documents deliberately carry none, so those show a
lock, and a document never saved shows a page glyph rather than broken-looking
white.

**`+ New document` fetches the signed release** rather than bundling a seed.
Bundling would put a copy of Bento inside the extension, to drift from the real
release and be re-reviewed on every update — the same trap `tray/ios` avoided by
letting documents carry their own runtime. De-duplication counts on the BASE
name (`Untitled 2.bento.html`), because UIKit's own counter produces
`Untitled.bento 2.html` from a double extension and `tray/ios` had to write its
own for the same reason.

### Enumeration is allowed here, and that is not a contradiction

`background.js` went to some trouble to STOP enumerating: resolving a save must
not walk a folder, because the user is mid-⌘S and a granted home directory would
hang it. Listing is user-initiated, bounded (depth 4, 300 documents) and cached.
Same folder, different job, different rules — worth stating because the two
sit next to each other and the next reader will wonder.

### One store, one owner

`background.js` and `status.js` each opened IndexedDB with their own copies of
the database name, store name and keys, guarded by a rig comparing the two. That
gate is gone because the duplication is: `db.js` owns the store and both import
it. The rig now asserts the stronger thing — that nothing else calls
`indexedDB.open` — since a second opener is how the split-brain returns, and its
symptom is the options page writing grants the worker never reads.

### Verified by looking

The layout was rendered with a real preview extracted from a real saved deck and
screenshotted, not asserted. The library rig reads the real built shell, and a
copy of it with a document spliced in at the real offset — hand-written fixtures
would have passed the metadata bug that shipped.

Found while writing it: a PRISTINE shell has an EMPTY `#bento-doc` block
(`id="bento-doc"></script>`) because the starter document is built at runtime and
only written on first save. So a newly created document legitimately has no title
and no preview until it is saved once. The rig asserted a title and failed —
correctly, at the assertion rather than in the parse.

*2026-08-14, continued: the home page, and the bug that made the tray useless.*

**The tray listed documents and could open none.** A chicken-and-egg: a
directory handle has no path, so an absolute one is needed to open anything, and
it was learned only by subtracting during a SAVE. A fresh install had never
saved, so every row was disabled. Opening a document is the natural moment to
learn where its folder is, so `relay.js` now announces itself once on load and
the worker resolves that like a claim — no write, prefix recorded. One document
opened makes its whole folder openable. The announcement sends an op and
nothing else; the path still comes from `sender.url`.

**A full page, because a popup cannot browse.** 340px that dies on blur answers
"open the thing I just had" and nothing else. `src/home.html` adds folders,
search, sort, and thumbnails big enough to recognise a deck by. The popup stays
a launcher with a door to it, rather than a second implementation — both read
`library.js`, so they cannot disagree about what a document is.

**Thumbnails need a real viewport, not a small one.** The preview block sizes
page one to whatever viewport it lands in. Give the iframe a 56px box and it
lays the slide out for a phone; give it 1280×720 and scale the whole frame down,
and it composes exactly as it does on screen. Measured while looking at it: the
first screenshot showed blank cards because the iframes had not painted yet, not
because anything was wrong — a reminder that "I looked and it was broken" needs
a second look before it becomes a finding.

**Rename is write-then-remove, in that order, always.** The File System Access
API has no rename. If the write fails the original is untouched; if the remove
fails the worst case is two copies. Removing first would put the only copy of
somebody's document in a variable, and the rig proves the ordering by failing
the write and checking nothing was removed.

**The rename box is a filename input, so it is sanitised as one**: separators
stripped so nothing escapes the folder, the extension stripped so typing it does
not double it, and leading dots stripped — a document renamed to `.something`
would vanish from every file manager including this one.

**Duplicate copies bytes, deliberately.** A Bento document carries its own
runtime, its collaboration keys and its identity. Whether a copy should get a
fresh `docId` is the DOCUMENT's business — Bento has "Duplicate as new deck" for
exactly that — and a file manager has no standing to decide it.

**There is no Delete**, and that is a decision rather than an omission.
Destroying documents needs an undo, a trash, and a confirmation people actually
read; Finder has all three and is one keystroke away. Duplicate and rename are
recoverable, delete is not.

**Multi-app support was deferred, deliberately.** Supporting other single-file
HTML apps means widening the manifest match from `file:///*.bento.html` to all
local HTML, which injects the bridge into every local page a user opens — a much
larger thing to justify in a store listing — and replacing the `window.bento`
version gate with a generic app declaration. That gate is what stops a pre-#213
document from having its "Save a copy" treated as an overwrite, so it cannot be
dropped casually. Doing it first would have settled the home page's data model;
doing it later means the home page will need revisiting. That is the cheaper
order, because Bento's own shape is known and another app's is not.

*2026-08-14, continued: does the tray handle Spaces and Dash?*

Mostly yes, already — and the exception was a real bug nobody had noticed.

**Listing, opening, thumbnails and in-place saving were never app-specific.**
The whole family writes `.bento.html`, shares the kernel's `title` field, and
slides/spaces/dash all register a preview. So the tray shows them all, with
titles and page-one thumbnails, without knowing which app it is looking at.
(`type` does not exist on main yet.)

**But bento/dash could not save in place at all.** `page-bridge.js` refuses to
write unless the runtime is at least 1.0.15, because before `pickerIdFor` (#213)
every save sent `bento-doc` — including "Save a copy…" — and acting on that id
overwrites the open document. It read the version from
`window.bento.updates.version`, which each app assembles BY HAND: slides has it,
spaces has it, **dash never included `updates`**. So every ⌘S in Dash fell
through to a destination prompt, with a folder granted and nothing on screen
saying why. It would have looked like the extension being broken.

The bug is not that Dash forgot. It is that a contract with a host was being
satisfied by each app remembering to. So the signal moved to where it cannot be
forgotten: `configureApp` is the one call every app makes, and it now announces
`window.__bentoRuntime`. The next app inherits the fix without knowing it
exists.

The bridge reads BOTH — the announcement first, the hand-made object as a
fallback — because every already-shipped Slides and Spaces document has only the
latter, and dropping it would break in-place saving for every file already on
disk. Both are still gated at 1.0.15; an announcement is not a reason to trust a
runtime that predates the id.

Non-writable, for the same reason `__bentoHost` is: the document shares that
realm, and a document that could overstate its own version could talk a host
into overwriting it.

**Creating a document is the one operation that must ask which app**, because
there is no document yet to say. `library.js APPS` lists the three with their
own signed release channels, and `+ New document` offers them. Adding an app is
that one entry; nothing else in the extension asks.

Fetched rather than bundled, for the reason `tray/ios` does not bundle a shell:
a bundled seed drifts from the real release and drags the extension into a
review queue on every Bento update. A document created here is the build
everyone else has that day.

*2026-08-14, and this one was a design failure, not a bug.*

The tray shipped with a first run that read: every document greyed out, and a
paragraph explaining that you must go to Finder and double-click something
before the extension works. Reported, correctly, as *"this doesn't make sense
for normal users"*.

The constraint behind it is real. A `FileSystemDirectoryHandle` never exposes a
path, so the extension can read and write a folder while having no idea where it
is — and a tab needs an absolute path to open a document. The only source was a
document loading out of the folder and its content script reporting
`sender.url`. Everything followed from treating that as the only source.

**Chrome already knows.** If a document has ever been opened, its `file://` URL
is in history. One `chrome.history.search({ text: '.bento.html' })` yields the
absolute path of every Bento document the user has, which places every granted
folder at once, with no trip to Finder.

**The permission is optional, requested by a button, and handed straight back.**
"Read your browsing history" is a heavy ask and a fair thing to balk at on a
store listing, so it is not in `permissions`. It is in `optional_permissions`,
requested at the moment it is needed with the reason on screen, and
`permissions.remove`d in a `finally` — held for the length of one query.
Declining is a legitimate answer and gets the manual route, said plainly,
without asking again.

**Nothing from history is trusted.** A URL is a hint. `route.js prefixFor`
accepts a path only when the route resolves inside the grant AND `dir.resolve()`
on what it lands on agrees with the path's own tail — the same check that stops
a same-named file elsewhere from being written. The failure mode of getting this
wrong is not a broken link: it is a folder recorded at the wrong location, with
every document in it silently opening something else. Its rig is mostly refusals
for that reason.

`locateIn`/`pathFromSender` moved into `route.js` so the worker and the pages
can both place a path. Importing `background.js` into a page instead would have
registered a second `onMessage` listener there.

### What this says about the process

The chicken-and-egg was noticed and "fixed" twice — first by learning on save,
then by learning on open — and both times the fix was inside the frame that
opening a document is the only way to learn a path. Neither attempt asked
whether the frame was true. The user did not report a bug; they reported that
the result made no sense, which is the question that broke the frame.

The rigs were green throughout. They test what the code does, and the code did
what it was written to do.

*2026-08-15.* "Can't the extension just inspect files to see if they're Bento?"
Yes — and the better question was "why are there any misnamed ones?"

**The listing now decides by CONTENT.** `id="bento-doc"` is the splice contract
every Bento app honours (PLATFORM.md §2), frozen because old updaters depend on
it, and it sits ~6KB into a real shell. So an unrecognised `.html` is settled by
one 64KB read; a properly named document costs no read at all; the verdict is
cached by size and mtime, so a second listing opens no bytes; and sniffing is
capped per listing, because a granted home directory can hold thousands of
unrelated pages.

Marked in the UI rather than silently half-supported. A found-by-content
document lists and opens, but the bridge that saves in place is a content script
matching `file:///*.bento.html`, so it will still ask where to put itself. A
tray that looked like it fully supported a document it half supports is a trap.

**But the real fix was upstream, and Bento was the culprit.** `suggestedFileName`
has always produced `.bento.html` — while the PICKER accepted `.html`. So an
author who edited the name to "Q3" got `Q3.html`, and that document is a
second-class citizen everywhere the convention is what identifies us: the webext
bridge matches on the compound extension, and tray/ios matches the same way.
Bento was manufacturing the exception and then being asked to cope with it.

Both pickers now accept only `.bento.html`, so the browser appends it to a bare
name. Compound suffixes are explicitly legal (`.tar.gz` is the spec's own
example) and the limit is 16 characters against this one's 11 — checked in the
spec rather than assumed, after a day of assuming browser behaviour and being
wrong.

The cost is that typing `deck.html` yields `deck.html.bento.html`. Accepting
both extensions would remove that and also remove the whole benefit, since
`.html` would again be a valid terminal suffix and nothing would be appended.
The common case — typing a plain name — now produces the right thing, and the
odd case produces a clumsy name rather than a broken one.

**Widening the content-script match was considered and NOT done.** Making
renamed documents save in place needs `file:///*.html`, which injects the bridge
into every local page a user opens — a much heavier ask on a store listing than
the narrow match, for a case that should now be rare because the source of it is
fixed. If it is ever wanted, the pattern is the one the history search
established: an optional permission, requested with the reason on screen,
registering the broader script only when granted.

*Found while writing the rig:* its `deps` lacked a cache, so `sniff` threw
straight into a `catch { continue }` — the check reported green while proving
nothing. Then the cache assertion counted `getFile()` calls, which a cache hit
still makes (it needs size and mtime for the key); it now counts content reads.
Two rounds of a test that passed for reasons unrelated to the thing under test.

*2026-08-15.* A UX and UI pass before merging, and the diagnosis was structural
rather than cosmetic.

**Three surfaces, three design languages.** The home page had tokens and dark
mode. The popup had 21 hardcoded colours and no dark mode. The options page had
16 and no dark mode. So the surface people actually open — the popup — was the
one that turned white at midnight, and the settings page looked like a different
product reached by leaving the one you were in.

`ui.css` now owns the palette and the shared primitives; each page keeps only
its own layout. `pack-webext` fails on a literal colour anywhere but there
(`setBadgeBackgroundColor` exempt: a browser API taking a string, which CSS
variables cannot reach). Verified as a real gate by planting one.

**Settings became a VIEW, and options.html is gone.** Same shell, same sidebar,
same navigation. What was prose is now rows, because a folder is a thing with a
state and an action and a paragraph about it is neither. `options_page` points
at `home.html`, so `openOptionsPage()` still works from the popup.

**The first run is steps, not an apology.** Both things that must happen are
outside the extension's power — a folder you choose, and a Chrome switch no
extension may touch — so it shows a short list with what is already done ticked,
rather than an empty page explaining why nothing works.

**Documents say which Bento they are.** Three apps write `.bento.html`, and the
UI never said which one a document was, so a folder of decks, notes and sheets
read as one undifferentiated pile. `describe` now reports the format field and
the card carries a badge — alongside the `.html` badge for a document found by
content rather than by name. Both sit on the picture, never in the body, so they
cannot push a title around.

**The notices were essays.** Each is now a sentence and, where there is
something to do, a button. The reason a thing cannot be automated is interesting
to us and not to someone trying to save a document.

*Found by looking:* `.step b { display: block }` was unscoped, so a bolded phrase
in the middle of a note became its own line and broke the sentence around it.
Only visible in a screenshot — no rig would ever have caught it, and I had
written the markup that triggered it.

*2026-08-15.* Where the popup belongs, once the toolbar icon opens the library.

**`default_popup` and `action.onClicked` are mutually exclusive.** Declaring a
popup means the click opens it and the listener never fires. So wanting the icon
to open the full page means having no popup at all — and the question becomes
what the tray's compact form is FOR.

**Its job was always switching documents while working in one**, and a popup is
the wrong container for that: it dies the moment it loses focus, which is the
moment you click into the thing you switched to. A **side panel** does not. Same
markup, same code, better container — `sidePanel.open()` arrived in Chrome 116,
which is this extension's floor exactly.

Two surfaces, two jobs, and neither is a lesser copy of the other:

- **toolbar click → the library.** Browsing and managing: folders, search,
  rename, settings. Wants room and a tab that stays. An existing tab is FOCUSED
  rather than duplicated.
- **`Alt+B`, or right-click inside a document → the panel.** Switching while
  working. Sits beside the document instead of vanishing.

**`sidePanel.open()` must be called SYNCHRONOUSLY inside the gesture.** An
`await` before it — even a trivial one — loses the gesture and Chrome refuses,
silently. So the command handler reads nothing first; the panel decides what to
show once it is up. The rig pins this by slicing the handler and asserting no
`await` appears in it.

For the same reason the lapsed-grant notification leads to the LIBRARY rather
than the panel: it is handled after an await, so `sidePanel.open()` there would
be refused without saying so. It used to try `chrome.action.openPopup()`, which
no longer exists to try.

`window.close()` is gone from the panel. A popup closing itself after an action
is correct; a side panel doing it takes away the thing the user just used.

*Two rig lessons, both mine.* The first gate for "nothing calls openPopup"
matched the comment explaining why the call was removed — a gate that trips on
its own documentation gets deleted rather than fixed, so it now strips comments
and reads code. And it was verified by re-adding a real call and watching it
fail, which is the only way to know a source gate is a gate.

*2026-08-15.* Keeping unpacked installs current, when the browser will not.

**Store installs update themselves; an unpacked one never does.** Chrome ignores
`update_url` for a development install — it runs from a directory on disk and
nothing is going to rewrite that directory. Self-hosting a `.crx` is not a way
round it either: Chrome refuses off-store installs on Windows and macOS. So the
only move available is to TELL those users.

**Ask only the people it applies to.** `chrome.management.getSelf()` reports
`installType`, and — checked in the API docs rather than assumed — it needs **no
permission at all**, so this costs nothing on a listing. Anything but `normal`
is told: `development` is the GitHub route this exists for, and
`sideload`/`admin`/`other` also arrive outside the store's update mechanism. A
store install is never asked and never makes the request; a notice about a
version the browser has already installed is how an extension gets uninstalled.

**A GET for a static JSON file, and nothing else.** No identifiers, no query
string, no version reported upward — the comparison happens locally. The app's
own update check promises "no ids, no telemetry", and the extension must not be
quietly weaker. It can report and link; there is no mechanism for an unpacked
extension to update itself, and inventing one would mean downloading code and
asking for trust, which is precisely what a reviewer would ask about.

**Not on the badge.** The badge means "a folder lapsed, saving will prompt". A
version behind is neither urgent nor broken, so it is a notice in the library and
a row in Settings, with a manual "Check now".

**The digest is emitted, not typed.** `pack-webext` now writes
`dist/tray-release.json` beside the zip, carrying the sha256 of the bytes it just
built. A hand-copied hash goes stale in silence. Publishing it is worth
something only because the package is byte-reproducible: anyone can rebuild from
source and confirm the zip they downloaded is the one that was reviewed — the
only verification available when the browser is not the thing doing the updating.

**Startup only, plus a manual check.** A daily poll would cost the `alarms`
permission for a courtesy. A browser session is the natural granularity for
something whose remedy is "download and reload".

*Rig note:* the comparison is numeric, not textual — `1.0.10` against `1.0.9` is
the case string comparison gets backwards, and it is pinned. So is the direction
that matters most: a store install is never told, and never even asks.

*Amended, same day.* Should the check be automatic by default?

Yes, but only with a switch and a disclosure — and the argument runs both ways
inside this repo, which is why it is worth writing down.

FOR: `kernel/src/update.ts` checks a release manifest at launch by default, with
an off switch in the About dialog. The extension behaving differently would be
an inconsistency with no reasoning behind it. And an unpacked install has no
other way to find out it is behind: the browser will never tell it.

AGAINST: the v0.9.1 fix exists precisely so an anonymous visitor never phones
home without opting in, and the audience that loads an extension unpacked from
GitHub is the audience most likely to object to a silent outbound request.

The distinction that settles it: that fix was about connecting to a relay with
document data. This is a static GET with no identifiers, no query string and no
version reported upward. Different in kind — but "different in kind" is a
judgement the user is entitled to make instead of us, so the preference sits in
Settings next to what it does.

OFF means NO REQUEST, not a request whose result is hidden. The rig pins that
distinction, because the lazy implementation of a privacy switch is the one that
keeps the traffic and quietens the UI.

**Check now** works regardless: pressing a button is the consent the preference
otherwise stands in for. And an unreadable preference is treated as ON, matching
"absent means on" — a storage hiccup should not silently disable something the
user never turned off.

*Amended, same day.* What actually happens when an unpacked user acts on the
notice — and the footgun the first version of the copy walked them into.

**An unpacked extension is identified by its DIRECTORY PATH.** So the obvious
upgrade — extract the new zip somewhere convenient, "Load unpacked" from there —
produces a different extension: different id, different origin, empty
IndexedDB. No granted folders, no learned prefixes, no preferences, and the old
copy still installed beside it. The user has done the natural thing and lands on
the first-run screen wondering where everything went.

The original notice said "get it on GitHub and reload it in chrome://extensions",
which is close enough to sound complete and does not contain the one word that
matters: SAME folder. It is now three numbered steps, and step 2 says why.

**The first-run screen also carries the warning**, because "an unpacked install
with no folders" is precisely what a botched upgrade looks like from inside the
new copy — and nothing there can detect it. The data is intact under the old id,
which is still installed; the fix is to replace the files in the original folder
and reload. Saying so on the screen the mistake produces is the only place it
can be said.

Not fixable any other way: handles cannot leave their origin, so there is no
export/import that would carry grants across ids. The instruction is
load-bearing, which is why it is in the notice, the first-run screen, the README
and the store listing rather than in one of them.

*2026-08-15.* Search reached the title, the file name and the folder — which
finds a document you can already name. What people actually remember is a phrase
ON a slide, and the bytes to answer that were already being read for the
thumbnail and thrown away.

`describe` now extracts the text in the same pass. Deliberately NOT a JSON
parse: the block runs to megabytes with images inline, each app shapes it
differently (slides put prose in `element.html`, spaces in blocks, dash in
cells), and a reader that must know the format breaks when the format moves.
Pulling string VALUES — `:"…"`, never keys — is format-agnostic and degrades to
"finds less" rather than throwing. Data URIs are dropped first: one embedded
image outweighs every word in a document. Capped at 40KB, so a folder of large
documents does not quietly become a search index. Encrypted documents are never
indexed — a searchable copy of a password-protected file is the leak the
password prevents.

Measured on a real deck: 36KB of prose out of a 900KB file, finding words from
slide bodies and speaker notes.

**Onboarding, help and about are one view, not three.** They are the same three
questions — what is this, how do I use it, who made it — asked at different
moments, and three surfaces would repeat each other and drift. It shows LIVE
state rather than a leaflet: the two prerequisites tick themselves off, so the
page that explains the product is also the page to return to when something
stopped working, which is when people look for help. A fresh install is sent
here by `onInstalled` with `reason === "install"` only — an update must not
steal a tab, and reloading an unpacked extension fires that event every time.

*Found by looking, twice:* `.tour b { display: block }` turned a bolded phrase
mid-sentence into its own line — the identical mistake `.step b` had made and
which I had already fixed. An unscoped element selector inside a component is
the shape of the bug; both are now `> b`.

---

## 2026-08-10 — The spaces topbar has TWO fold tiers, and the touch gutter lives in a margin

Two mobile defects, both measured on the shipped shell at a 390×844 viewport
with a coarse pointer, neither of them a regression — they had been there since
the surfaces shipped.

**The bar folds twice, and it starts at the drawer breakpoint.** `.sp-bar` laid
out 467px wide inside 390 and Save's right edge landed at x = 426: the primary
action, 36px off the screen. The existing fold (six secondary actions → the ⋯
menu) was not enough, because what survives it is still eleven controls' worth
of 40px touch targets. So there are two tiers now:

- **≤820px** — the DRAWER breakpoint, not 720. The secondary row folds into ⋯
  and labelled controls drop their words. It was 720, and at 768 (an iPad in
  portrait) the save caret still ended 27px off the screen; 721–820 is exactly
  the band where the page list is already an overlay competing for width, so
  one number now means one thing.
- **≤600px** — a phone. It also gives up the wordmark (About is the first item
  in ⋯), the undo/redo pair (added to ⋯ with their shortcuts and their disabled
  state) and the save caret (each of its four items is in ⋯ or in About). Save
  itself never moves, at any width.

The status span leaves the flow on a phone. It is `white-space: nowrap`, so a
long message ("Reading view — press Esc or the eye to edit" measures ~250px)
would have pushed Save back off the screen for as long as it was up — and
`status()` never cleared its text, only faded it, so the width it claimed was
permanent for the session. It is cleared after the fade now, and overlaid on the
title strip below 600px.

`isPhone()` in editor.ts duplicates the 600px number, because the ⋯ menu must
not offer Undo while Undo is also sitting in the bar. The model rig pins both
numbers and the agreement between them.

**The touch gutter is absolute, in a reserved margin — never in the flow.** The
earlier fix for "there is no hover on touch" made `.sp-gutter` `position:
static`, which bought reachability with 36px of height on EVERY block: a
one-line paragraph measured 68.4px, half of it affordances. It is absolutely
positioned again, the way it is on a desktop, inside a start margin reserved
for it (26px on `.sp-page-inner`, 44px from the edge of the screen once
`.sp-main`'s own 18px is counted), visible at rest, and carrying ONE control —
the grip, whose sheet
already offers "Add below", so the ＋ was a second button for something a thumb
could already reach. Measured after: one-line paragraph 68.4 → 32.4px; the
reading column pays 26px of width for it (354 → 328 at 390px). Both directions
of that trade are deliberate: a phone has ~800px of height and 390 of width, and
the chrome was eating the scarce one.

**Cost.** +312 bytes on the shipped shell (132,102 → 132,414 B), inside the
existing 135,168 B ceiling; no budget change.

*Amended, same day.* The margin was reserved on `.sp-main` first, which is
wrong for a reason worth writing down: `.sp-main` is chrome and follows the
INTERFACE direction, while the gutter is anchored to a block and blocks follow
the DOCUMENT's (`renderPage` puts `theme.dir` on `.sp-page-inner`). On a
document carrying `theme.dir: 'rtl'` the padding therefore went left while the
gutter went right — measured at 390px, the gutter landed at x = 378…412 and the
column scrolled to 412. It is reserved on `.sp-page-inner` now, so the two flip
together; the ltr metrics are byte-identical.

## 2026-08-22 — spaces plays video and audio, and nothing in it ever autoplays

`bento/spaces` gains a `media` block: ONE type carrying `kind: 'video' |
'audio'`, mirroring `image` down to the hybrid `src` (`asset:` · `data:` ·
`https:`), the remote-consent gate and the percentage width. Two types would
have meant two registry entries, two renderer cases and two exporters kept
saying the same thing, and everything that actually differs between a clip and
a soundtrack is one branch wide.

**Autoplay is recorded and never obeyed, and that lives in a FUNCTION.** Slides
learned the shape of this the expensive way: autoplay set at render time fires
on the editing canvas and in every thumbnail, so it belongs to present mode —
the one surface that owns playback. A space has no such surface. It has an
editor, a reading view, a printout and a file-manager still, and a clip that
starts itself is wrong in all four: the reading view because a page you scrolled
past should not start talking, the still because it is a picture.

So the rule is not "the renderer happens not to set it", which is a property of
one function that the next surface would have to rediscover. `blocks.ts
mediaPlayback(b)` returns the flags a surface may apply and its `autoplay` is
typed `false` — it cannot return anything else. `Block.autoplay` still
round-trips untouched (PLATFORM §3), because a build that DOES have a
playback-owning surface may legitimately write it. Pinned three ways in
`scripts/test-spaces-model.ts`, including against a block that asks for it, plus
a source assertion that `render.ts` never sets the attribute by any spelling.

**Paper and thumbnails get a still, gated on `printing`.** That flag already
means "this output cannot be interacted with", and both surfaces pass it —
print, and `preview.ts`'s file-manager render. The still is the author's poster
frame if there is one and a labelled box if not; never nothing, because a
printed handbook that silently omits the paragraph where the demo video was is
the same class of bug as a toggle that prints shut. `preview.ts` also bans
`video,audio` outright, which is now defence in depth rather than the mechanism:
by the time it runs there is nothing to ban.

**A linked clip needs the reader's consent more than a linked image does.** A
remote `<video>` asks its host for byte ranges the moment the element is parsed,
so no autoplay is needed to make it a beacon — opening the space is the ping.
Same gate, same host named, different words ("Video from {host}" / "Load this
video"). The preview passes no `allowRemote` at all, so a still built for a file
manager can never make a request: verified, the emitted preview carries zero
`src` attributes.

**The URL box is its own gate.** `src` is not inline html, so it never passes
through `sanitize.ts` — a `javascript:` typed into "Use a link…" would be
written straight onto the element. It is an `^https?://` ALLOWLIST, never a
`javascript:` blocklist, matching the reasoning behind `HREF_OK`.

**A clip exports as a markdown LINK.** Markdown has no video. `![](clip.mp4)` is
image syntax and draws a broken-image glyph in every renderer that has ever
existed; a bare URL becomes a player on github.com and on nothing else. A link
is correct everywhere: it says what the thing is and where it is. The target is
`src` verbatim, `asset:` and `data:` included, exactly as the image exporter
already writes it — a link that does not resolve outside the space is the truth
about an embedded clip, and a truthful dead link beats a dropped block.

**Nothing is re-encoded.** `prepareImage` exists because a phone photo is 4000px
wide in a 720px column; there is no equivalent cheap win for video, and
transcoding in a browser tab means shipping an encoder and taking minutes over
it. So `MEDIA_EMBED_BUDGET` (8MB, twice the image budget, matching slides) is
the point at which the question is worth asking rather than a size we can
rescue. A browser file picker hands over bytes and never a path, so "keep it on
disk and point at it" cannot be offered — the URL field is the whole escape
hatch, and it is where a "no" lands you.

**Cost.** 166,482 → 172,722 B on the shipped shell (+6,240 B, +3.7%), and the
`scripts/size-budgets.json` ceiling moves 172 → 176 KiB. That is the zopfli
headroom being spent on a feature, which is what it was left for.
## 2026-08-22 — A link card is what the author typed; nothing is fetched, ever

**Decision.** bento/spaces gets a `link` block: a card for an address on the
web, carrying `url`, `title`, `desc`, `site`, `icon` and an optional `image`.
**Every field is stored in the file.** There is no fetch at render time, and
there is no fetch at authoring time either — not even an explicit, opt-in one.
The author fills the card in, and the dialog says so in the first line the eye
lands on: "Nothing is fetched. A card shows what you type here — opening this
space never contacts the site."

**Why not at render.** Settled already: PLATFORM §1 (no network to open, edit,
read or save) and "A space does not phone home when it is opened"
(2026-08-03). A card that fetched on open would be the tracking pixel that
decision was written about, wearing a card for a hat.

**Why not an opt-in fetch in the EDITOR either** — the interesting half, since
about.ts's update check is precedent that an explicit, documented, opt-out
network touch can be on-platform. Three reasons, in order of weight.

1. **It cannot work.** Reading a url's OpenGraph tags means reading a
   cross-origin HTML body. `fetch` gets an opaque response under `no-cors` and
   a CORS failure otherwise; from `file://` — the origin this format exists for
   — it fails outright. Notion and Slack do this on a SERVER, which is exactly
   the component Bento does not have. The only way to ship it is a proxy we
   run, i.e. a backend, i.e. off-platform. A feature that needs a server is not
   a feature this app can have a debate about.
2. **The update check is a different shape.** It contacts ONE origin we
   control, on a schedule the reader can turn off, to verify a signature
   against a key already in the file. A metadata fetch contacts an ARBITRARY
   third party named by the document — the author's choice, made with the
   editor's user's IP address. That is a category the update channel is not in.
3. **The honest v1 is the one that stays honest.** A stored card is legible in
   the JSON, diffable, works offline, and cannot rot into a request when
   someone later "just adds a refresh button".

**The url is untrusted input.** It is a block FIELD, so it never passes through
`sanitizeInline` — `sanitize.ts` exports `externalHref()` for it, the outward
half of `HREF_OK` (`https:`, `http:`, `mailto:`), tested against the RAW string
for the documented `.href` reason. An allowlist, not a blocklist: the URL
parser strips tabs, newlines and leading whitespace from a scheme, so
`ja\tvascript:` and ` javascript:` are both `javascript:` when followed and
neither starts with `https:`. A url outside the list renders as a DEAD card
that keeps its title — it degrades, it does not vanish, and it is never an `<a>`
that goes nowhere. Pinned with eleven hostile forms in the model rig.

**No remote images, and no placeholder either.** `image` is `asset:` or `data:`
and nothing else; a remote one is DROPPED by `linkCard()` rather than deferred
behind a "load this image" button. The image block's placeholder stands in for
the block's entire content, so a reader has something to consent TO; a card's
thumbnail is decoration beside a link that already works. The editor's picker
runs the same `prepareImage` → `internAsset` path an image block does, so a
picked thumbnail is embedded bytes.

**`html` is written beside the fields**, exactly as a `prop` block does it, by
ONE writer (`editor.applyLinkCard`). Format additivity is a promise about what
OLD builds do, and it is only kept if the readable fallback is written at the
same moment as the fields.

**In Markdown a link card is a link** — `[title](url) — description`, with
brackets escaped and the angle form for a url holding a space. Not a table, not
an html `<div>`: every card-shaped export stops being a link the moment it
leaves this app, and where it points is the one fact that cannot be
reconstructed. A card with no valid url exports as its plain text, so a reader
is never handed something to click that goes nowhere.

**Deliberately NOT in this change:** pasting a bare url as a card. That belongs
to the paste pipeline, which is another agent's zone right now, and a second
document-level `paste` listener would race the first. The insert paths are the
`/` menu and the Insert dropdown.

**Verified.** 514/514 in `scripts/test-spaces-model.ts` (up from 460), which
now includes the negative: `linkCard()` drops six shapes of remote image, and
`render.ts` contains no `fetch`/XHR/`new Image()` and reads its only `img.src`
from the filtered value. In Chrome, on a served copy carrying four cards —
including one whose `image` is `https://tracker.invalid/pixel.png` and one
whose url is `javascript:alert(1)` — `performance.getEntriesByType('resource')`
was EMPTY and the network panel showed one `blob:` (the shell's own inflated
module) and nothing else. Shell 166,482 → 171,074 B, inside the 176,128 ceiling;
no budget change.

## 2026-08-22 — The two portability exits for bento/spaces, and what each one refuses to carry

**Decision.** `spaces/src/portable.ts` owns both directions of "a space is never
a dead end": `extractSpace()` cuts one page (optionally its subtree) out as a
complete `bento/spaces` file, and `planGraft()` nests another space's pages
under a page of this one. Pure and DOM-free like `markdown.ts`; the browser
halves are `editor.openExportSpace` / `editor.importSpace` and one hook in
`main.ts`. Five things were settled, all of them the kind that fail silently.

**A fresh `docId`, and no `collab` whatsoever.** An extract that kept the parent
document's id is a FORK of it: `SyncSession` keys BroadcastChannel on `docId`
and the saved file IS the capability, so a three-page extract would join the
two-hundred-page space's room and sync into it. Keeping `collab` is worse than
that — `room`, `key`, `writerPriv`, `ownerPriv` and the invite chain are the
capability to read and write the WHOLE space, and handing them to someone you
sent three pages to is the leak the reader-copy paths already strip for. So the
extract mints a new id and carries no credential at all. `template` goes too (it
re-mints `docId` on every open, which would undo the identity just given);
`readonly` STAYS, because upgrading a reading copy is not the exporter's call.

**A link out of the extracted set becomes the literal `[[Page title]]`** — the
same thing an unresolvable wikilink becomes on the way IN (`resolveWikilinks`).
Text that names the page is honest, searchable, exports as correct Markdown, and
re-resolves if the halves are reunited. The alternatives are worse in both
directions: a silently unlinked label lies about what the file said, and a live
`#p/<id>` that resolves to nothing looks fine until it is clicked — and after an
import it can land on a STRANGER page that happens to hold that id.

**Only referenced assets travel.** Images are the only thing in a space with
real weight; an export carrying the whole document's assets is a copy with pages
hidden. Fonts are the exception and not really one: `doc.fonts` is named by the
theme, so every page references them.

**Ids on the way in: keep, and rename only a collision** — via model.ts's
`repairId`, now exported. Ids are unique across a document and never reused, so
pages and blocks are claimed from one namespace; keeping the ones that do not
collide means links, backlinks and future CRDT node keys survive an import that
did not have to touch them, and the derivation is FROM THE BYTES for exactly the
reason written beside `repairId` (never `Math.random`, never `docId`, which
`template: true` moves). Links inside the import follow the rename in the same
pass, so nothing arrives pre-broken. Assets merge on content addressing, with
the byte-compare and `~n` variant `internAsset` already uses — trusting a key
alone would replace the host's image with the visitor's, silently, in a file the
author then mails.

**The imported file is untrusted and gets no side door.** Its document block is
read from an inert `DOMParser` document (no browsing context: nothing runs, no
resource loads), `parseDoc` decides whether it is a space and REFUSES rather
than degrading (the load contract), an encrypted envelope is reported instead of
guessed at, and `sanitizeInline` runs over every arriving block before any of it
reaches the document. The graft is one `store.commit`, so it is one ⌘Z, like the
Markdown import.

**Guarded.** `scripts/test-spaces-model.ts` runs the whole round trip — extract a
subtree, import it into a space that collides on every id and on an asset key —
and asserts no id collision, no dangling link, no credential in the bytes, the
asset merge in both directions, and additivity through both legs. The one-undo-
step half is in `scripts/test-spaces-undo.ts`, which is bundled and has the real
Store.

**Cost.** Shell 166,482 → 175,690 B (+9,208, 5.5%); `scripts/size-budgets.json`
raised 176,128 → 184,320 in the same commit, because 438 B of headroom is inside
the packer's own cross-node-version spread and would fail CI for no reason.

## 2026-08-22 — bento/spaces: a properties panel that defaults to closed

**Decision.** bento/spaces gets a right-hand properties panel (`spaces/src/props.ts`),
structurally the page tree's mirror image — same `.sp-resizer` strip, same
chevron, same drag-to-resize and double-click-to-reset, same
`localStorage`-only state. It shows BLOCK properties for the block the caret or
the last click was in, and PAGE properties underneath, in accordion sections
whose open state is remembered per title exactly as slides' `.ed-section`
retrofit does.

**Why a panel at all.** The settings existed; the place to look for them did
not. A table's shape came from a bar above the table, a code block's language
from a hover chip, an image's width from a floating tool row, a link card's
fields from a per-block menu, and the page's own width from the PAGE menu. Each
is discoverable only by someone who already knows it is there, and none of them
answers the question in the general case. **The old surfaces stay** — the chip
on a callout is still the fastest way to change a tone, and deleting it to
justify a panel would be a worse editor with a tidier diagram.

**CLOSED BY DEFAULT, and this is the load-bearing part.** `spaces: a wide screen
gets a wide page` (aacf7e2) had just given the reading column the window's
slack, after the complaint that a 720px column on a 2560px screen used 31% of
the area. A panel holding 280px of that open on every screen forever, for
settings most people change once a month, takes the fix straight back. So:
`inspClosed = true`, and only an explicit `'0'` in `bento-sp-insp-closed`
(written when somebody opens it) makes it open — an absent key, a new browser
or a storage exception all mean closed. While closed the panel is
`flex-basis: 0` with no inline padding and no border, so `.sp-main`'s
`flex: 1 1 auto` takes the width straight back.

MEASURED, closed, against the same shell without this change: at 1280px the
reading column is 720px either way; at 2560px it is 900px either way. The whole
cost is the 5px chevron strip (main 1031 → 1026 and 2311 → 2306), which is what
buys a control on the panel's own edge instead of one in a toolbar across the
room.

**Below 820px it is an overlay, not a column** — the bargain the page list
already makes at the same breakpoint, with the same `.sp-scrim` to tap away.

**Its topbar button exists only where the chevron cannot.** Above 820px the
strip carries the control, so a second one in the bar would be the duplication
`.sp-panel-toggle` already documents avoiding. Below 820px the button leads —
until `fitTopbar` folds the bar, when it moves into ⋯ with undo/redo and the
export actions. MEASURED at 375px: leaving the 40px button in a folded bar took
the document title from 70px to 26px, which is a title nobody can read in
exchange for a control that is one row of an already-open menu.

**One control, one commit, one ⌘Z.** Every block edit goes through a single
helper wrapping one `store.commit`, and every text field commits on `change`
rather than `input` — `input` would buy an undo entry per keystroke, which is
the exact thing `store.ts`'s typing run exists to avoid.

**Which block the panel means** is tracked on `focusin` AND `mousedown`, capture
phase, on `.sp-main`. `focusin` alone answers for text and stays silent for
tables, images, clips and cards — exactly the types with settings worth a panel.
`mousedown` rather than `pointerdown` because a real click fires both while a
driven one may not, the same wall CLAUDE.md records for Gesto in slides.

**Guarded.** `scripts/test-spaces-model.ts` pins the default-closed preference,
the three properties of the closed geometry, that nothing about the panel
reaches the document, the overlay below the breakpoint, the accordion's
persistence, the one-commit rule, and that the block chips survived.

**Cost.** Shell 196,950 → 203,654 B (+6,704, 3.4%); `scripts/size-budgets.json`
raised 204,800 → 212,992 in the same commit, because 1,146 B of headroom is
inside the packer's own cross-node-version spread and would fail CI for no
reason.

## 2026-08-22 — bento/spaces goes dark, and its reading column goes with it

**The theme is a VIEWER preference and never document data.** localStorage
`bento-theme`, through `kernel/src/theme.ts`, which slides already shipped
(#285) — the same rule the interface locale and reduced motion follow, and
PLATFORM §8's. Two people opening one space are two readers in two rooms; a
theme in the file would travel to the recipient and override theirs, and it
would make a file's bytes depend on who last looked at it. `startTheme()` runs
AFTER `capturePristine()` in main.ts for exactly that reason, and the saved
`<html>` tag was measured bare: no `data-theme`, no `color-scheme`.

**WHERE THIS DIVERGES FROM SLIDES, AND WHY.** slides themes only the chrome
AROUND the deck: a slide is a bounded page on a canvas, its background is data
the author chose, and someone proofing at midnight still needs to see what will
be projected. Spaces has no such page. `--bg` is THE ONE GROUND — bar, both
panels and the reading column all sit on it with hairlines and nothing else
between them, which is what the chrome-reads-as-one-document work settled one
commit earlier. A dark interface with a white reading column would be a white
rectangle filling most of the window: not a dark interface, and a
re-introduction of the floating-card look that was deliberately removed. So in
spaces the reading surface IS chrome and it follows the reader.

`doc.theme.background/color/accent` still exist in the format and are still the
DOCUMENT's colours — but nothing in the live app paints them; the only consumer
is `preview.ts`, the static file-manager still. That surface stays the author's
in both themes, unconditionally: it renders with scripting off, so there is no
localStorage, no reader and no preference to honour — only a file manager
drawing a thumbnail. A `prefers-color-scheme` block there would be a guess made
on someone's behalf. If it ever changes it changes with the FORMAT.

**The document's own colour VOCABULARY does follow the reader**, and that is
the same ruling read from the other side. The nine `sp-fg-*`/`sp-bg-*` marks
and the five callout tones are a closed vocabulary of NAMES — the author picked
"red", not `#c0392b` — which is precisely why the value under each name can be
tuned per surface, as the palette comment has said since the marks shipped. An
ink measured to clear 4.5:1 on white is a smudge on a near-black ground, so
each `--c-*` carries a light value and a dark one. The BANDS need only one set:
they mix into `transparent` and land correctly on either.

**Callout tones are ONE HUE each, and the box derives from it.** The fill is
that hue mixed into `--bg`, the label is it mixed into `--ink` — a pale tint
with a dark label on white, a deep tint with a lifted label on near-black, from
five numbers instead of thirty. Measured both ways: labels 4.98–6.49:1 light,
6.5–8.4:1 dark.

**THREE STATES, so the dark values appear TWICE.** A reader chose light, chose
dark, or chose nothing. The choice stamps `data-theme`; the default follows the
OS. So dark is stated under `@media (prefers-color-scheme: dark)` guarded
`:not([data-theme="light"])` AND under `[data-theme="dark"]`, or the picker
only works in one direction. Verified with the attribute removed: dark OS →
dark, light OS → white, `data-theme="light"` under a dark OS → white.

**BOTH ARE @media screen, AND THAT IS HOW PAPER STAYS LIGHT.** Print matches
neither, so on paper the unconditional light block is simply what applies and
the print sheet needs no third copy of the palette. It carries one line the
media query cannot: `color-scheme: light only !important`, because theme.ts
writes `color-scheme` INLINE on `<html>` and an author `!important` is the only
thing that beats an inline style.

**An image gets a white ground in both themes.** Document content is never
inverted, dimmed or filtered — but a diagram or logo exported against a
transparent background is a shape floating in nothing on a dark page, and
black-on-transparent artwork vanishes outright. So `.sp-b-image img` paints
white behind itself and takes a hairline, in light as well, so the two themes
frame a picture the same way.

**Where the control lives.** About → Appearance, directly above Language: they
are the same kind of thing, preferences belonging to whoever opened the file.
It is built in its own `spaces/src/appearance.ts` and costs about.ts one import
and one `card.append(...)` — about.ts is a 355-line function that several
branches edit at once, and this is the smallest seam that still puts the
control in the right place.

**Guarded.** `scripts/test-spaces-model.ts` gained twelve checks: both dark
blocks exist and are byte-identical, they define every role light does and
invent none, every themed role is actually referenced by a rule, the light
palette has not forked from slides and type, no literal colour survives outside
the token blocks and the print sheet (three named exceptions), `startTheme()`
runs after `capturePristine()`, the Appearance control never touches the store,
and the still preview has no theme of its own.

**Cost.** Shell 213,434 → 215,002 B (+1,568, 0.7%). No budget raise: the
ceiling stays 221,184.

## 2026-08-22 — bento/spaces checks for updates at launch, and the About dialog says so

**Decision.** bento/spaces asks its release server for a signed manifest once at
launch, gated on the kernel's `bento-auto-check` preference, and the About
dialog carries the switch that turns it off. It was manual-only before, which
left the switch nothing to switch.

**Why this is not "phoning home."** The 2026-08-03 rule ("A space does not phone
home when it is opened") is about the DOCUMENT: an author who mails you a file
must not learn your address and the moment you opened it, which is what a remote
`<img>` in a page delivers. This is the APP asking its own release origin
whether it is current, on the reader's behalf and under the reader's switch. It
sends no id and carries nothing from the document; a remote `src` in a document
still renders as a placeholder naming the host, unchanged. The two rules answer
different questions and both still hold.

**Same preference as slides,** which has checked at launch since v0.9. One key,
`bento-auto-check`, so turning it off in one app turns it off in both — a suite
where the same switch means different things in two apps is worse than a suite
with no switch.

**The result only changes a sentence.** The check is `void`ed and its failure
swallowed: a launch with no network reads "Launch check couldn't reach the
release server (…). Check manually below." and nothing else about the app
differs. There is no badge, no banner and no automatic download; updating is
still a button somebody presses.

**Where it is stated.** In the dialog, beside the switch, in the reader's own
language: "An update check is the only network this app makes on its own. It
asks the release server for a signed manifest and sends nothing about you or
this document — no ids, no telemetry." Live collaboration is network too, but
it is network the reader started.

## 2026-08-25 — the square root: Chromium's radical join, accepted unfixed

**The symptom.** In a formula, the radical's hook does not meet its overbar —
a visible step where the two should be one stroke.

**Status: accepted, unfixed.** Formulas keep the generic `math` family. There
is a mitigation that helps on macOS and it is written down below, deliberately
not shipped. This waits for an upstream fix.

**Every font tested breaks.** Measured on the affected engine, not inferred:

| platform | what generic `math` picks | radical join |
|---|---|---|
| macOS | STIX Two Math | broken |
| Windows | Cambria Math | broken, same way |
| Windows, forced `serif` | Times New Roman | smaller break, still broken |

Three fonts, three breaks. That is what rules the font out as the cause: a
defect belonging to STIX would not follow us to Cambria Math and Times New
Roman, on another operating system, in another font family.

**It is not a version regression.** An earlier version of this entry claimed
Chromium 148 was clean and 151 broken. That table was wrong and is the reason
this entry was rewritten. The "clean" engine was an embedded browser that ships
almost no fonts, so it silently fell back to a plain serif and never rendered
STIX at all. It was not a newer engine breaking a radical; it was two engines
drawing two different fonts. STIX breaks in 148 too.

**What the mechanism appears to be.** Chromium paints the arm of the radical
from the font's glyph and then draws the overbar itself as a rule, and the
break is those two disagreeing by a fraction of a pixel. Two measurements
support this. Sweeping the radicand height from 10px to 200px, the glyph's
advance width never moves off 109.1px, so the radical stretches by a glyph
assembly rather than by wider size variants — the engine is compositing, not
picking one drawn glyph. And the size of the break tracks the font's arm
thickness rather than anything about the formula. It follows that the mismatch
is resolution-dependent, which is why Windows breaks *differently* rather than
not at all, and why zoom level can change the verdict on a given row.

**The radicand's height is not the cause, so do not try to fix this by making
formulas shorter.** Tested directly, because it is the intuitive suspect. In
the starter deck's own quadratic formula the `b²` raises the radicand from
64.4px to 84.3px, but the msqrt box stays at 113.8px — the *minimum*,
single-glyph size — exactly as it is for a flat `b − 4ac` and for four other
radicands. Same glyph, same size, same position, same bar. Only a fraction
inside the root (radicand 159.7px, box 220.3px) actually stretches it. The
radical in `√(b²−4ac)` is pixel-identical to the one in `√(b−4ac)`, so the
exponent cannot be raising the bar.

**The mitigation, documented and not shipped.** Scoping a non-maths font to the
radical only, and putting the contents back:

```css
.bento-el math msqrt { font-family: serif; }
.bento-el math msqrt * { font-family: math; }
```

The second rule is what makes it viable: it keeps the whole formula in the
maths font and swaps only the glyph that is drawn wrong. A blanket `serif` on
the formula is not an option — it collapses stretchy delimiters (a tall `(`
measured 315px in the maths font and 94px in serif) and shrinks large
operators.

Verified clean on macOS/Chrome, where it swaps STIX's radical for the serif
one. **It is not shipped because it does not hold on Windows**, where `serif`
is Times New Roman and the break is smaller but still there. It trades one
rounding mismatch for another, and a fix that only works on the author's own
machine is worse than a known defect. If a font is ever found that joins
cleanly on both platforms, this rule is the shape the fix should take — scoped
to `msqrt`, contents restored to `math`. Note also that the stack matters: on
Windows `'Cambria Math', serif` selects what generic `math` already selects, so
that variant is a no-op there.

`slides/probe/radical-join.html` is the cross-platform test rig:
one row per candidate font applying exactly the rule above, each row reporting
whether the font actually resolved, and a paste-back block carrying platform,
UA and DPR.

**If it ever becomes worth fixing on our side**, the only route that bypasses
the engine's radical painting is drawing the hook and bar ourselves — an
`<mo>√</mo>` plus a CSS rule for the bar, overlapped so the join cannot
separate at any DPI. That costs the semantic `msqrt` (accessibility, and the
morph would need the bar tagged as its own symbol), and an earlier hand-built
approximation still showed problems, so it needs verifying in the affected
engine before anyone commits to it.

**How this went wrong, which is the part worth keeping.** Six or more confident
wrong answers were reported before the right one, every one from an instrument
that lied:

- `document.fonts.check()` returns true for fonts that are NOT installed, so a
  four-font comparison was three fallbacks wearing different labels. Control: a
  nonsense font name — every fallback returns identical metrics.
- A "step size" metric compared the bar against the ink just left of it, which
  is the diagonal, not the flag. It scored a perfect radical as broken and
  returned an identical 21px for every variant.
- An SVG foreignObject rasteriser ignores `font-family` entirely, proven when
  `NoSuchFontXYZ` produced byte-identical output to STIX.
- And the one that cost the most: **every test page was judged in a browser
  that resolved the fonts differently from the one showing the bug.** Nine test
  matrices came back "all fine" for that reason alone, each one clearing a
  suspect that had never actually been rendered.

**The lesson: pin the environment before trusting any comparison, and prove the
thing under test is really on screen.** Record engine, version and *resolved*
font in the test artefact itself — a named font that silently fell back is not
a test of that font. "It looks fine here" is not evidence until "here" is
named.

## 2026-08-28 — OPEN QUESTION: the agent-facing copy of a document is not stripped

**Not a decision. A question recorded so it is not rediscovered a fourth time.**

**Where it came from.** Three apps have now shipped the same clipboard bug.
Slides put the owner private key on the clipboard; bento/spaces reintroduced it
verbatim when it grew its own "Copy document JSON"; bento/type did it again in
#384, where CI caught it (`scripts/test-export-secrets.ts`, the rig widened
from slides-only to all four apps for exactly this reason). Every UI copy path
is fixed and goes through a stripper now.

**What is still unstripped is the path we ask AI agents to use.** CLAUDE.md
tells tooling that the document is the interchange unit and points it at
`#bento-doc` and the `window.bento` API. An agent doing precisely what we
invited it to do — read the document, paste it into a chat model — hands over
`collab.ownerPriv` and the room read key. Same exposure as the button, reached
through the path we wrote the instructions for.

**The facts, measured across the four apps:**

| app | `window.bento.serialize()` | `window.bento.doc` |
|---|---|---|
| slides | `stampInto` + `serializeFile(doc)` — the whole .bento.html | raw `store.doc` |
| spaces | `serializeFile(store.doc)` | raw `store.doc` |
| dash | `serializeFile(store.doc)` | raw `store.doc` |
| type | `JSON.stringify(store.doc)` | raw `store.doc` |

**Two things that are NOT the bug, so nobody spends a day on them:**

1. **`serializeFile` carrying credentials is correct.** It produces the saved
   working file, and the file IS the capability — opening a copy auto-joins the
   room. Stripping it would break saving. The rig already records `serialize()`
   as its one legitimate caller.
2. **`window.bento.doc` is not an escalation.** Any script running in the page
   already has the document. The API grants nothing new.

**And one reason a narrow fix will not close it:** stripping `serialize()`
alone changes nothing, because the `#bento-doc` block inside the file carries
the whole document anyway. An agent reading the file gets the credentials
without touching the API.

**So the question is about defaults and documentation, not a code defect.**
Options, none chosen:

- Leave it. The file is the capability; anyone handling the file handles the
  keys, and that is already true of emailing a deck.
- Say so in the agent-facing guidance: paste a stripped document, never the raw
  one, and name the function.
- Give the platform a stripped accessor — `window.bento.docForExport()` — and
  point the tooling note at THAT, so the convenient path is the safe one. This
  is the shape that has worked everywhere else: the leak keeps recurring
  because the obvious call is the unsafe one.
- Widen the rig again. It currently inspects `about.ts`, `main.ts` and
  `editor.ts` only, so a leak in any other file of an app is invisible to it.

**Whoever settles this: it is a platform decision across four apps.** It was
raised from the bento/type branch during #384 and deliberately NOT decided
there, which was the right call — a single app's feature branch is the wrong
place to set a cross-app default.

## 2026-08-28 — bento/spaces: the `canvas` block, and where a card's position lives

**The type.** `canvas` is a bounded surface holding cards you place by hand —
a storyboard, a roadmap, a mind map. The format shape below is permanent from
the moment the type ships, because there is no server to migrate a file
somebody already has (PLATFORM §3).

### The shape

```jsonc
{ "id": "b1", "type": "canvas",
  "html": "Launch storyboard",   // the surface's NAME, and its fallback
  "ratio": 1.6                    // width ÷ height; ABSENT = 1.6
}
```

**A card is a BLOCK, not an entry in an array on the canvas.** The canvas is
`container: 'always'` in the registry, so it owns the blocks whose `parent` is
its id — exactly as a callout and a toggle do. A card adds two flat fields and
nothing else:

```jsonc
{ "id": "b2", "type": "p", "parent": "b1", "x": 29, "y": 8, "html": "Review with the team" }
```

`x` and `y` are PERCENTAGES of the surface, one decimal place, clamped to
0–100 at read time. A card with no coordinates is not an error: it takes a
deterministic slot from its index among its siblings, so two readers of one
file lay it out identically and `{"type":"canvas"}` with three bare paragraphs
under it is a hand-writable canvas.

A card's TYPE is any block type. `p` is a text card; `pagelink` is a card that
opens a page in the space, which is what lets a canvas be a map OF the space
rather than only a sketchpad. Nothing new was needed for either.

### Why cards are blocks and not an array

Three reasons, in ascending order of how permanent the mistake would have been.

1. **An array is a second place text lives.** Every word in a space is some
   block's `html` — canonicalised by one sanitizer, found by ⌘F, back-linked by
   `buildIndex` because it reads `html`, exported by one markdown pass. Text
   inside `canvas.cards[]` is none of those things, and each one would have to
   be taught about the array separately.
2. **An array degrades badly.** `renderBlocks` resolves a child against the
   OPEN CONTAINER STACK, and an unknown type opens no container — so on a build
   that has never heard of `canvas`, every card falls out to the top level and
   renders as the paragraph or page card it already is, under the canvas's own
   name. Measured against the pre-change shell: the page reads "Launch
   storyboard" followed by each card as an ordinary paragraph, and the `x`/`y`
   it cannot use round-trip untouched. Cards in an array would show as the
   canvas's `html` and nothing more — unless the html duplicated all of it,
   which is the price `table` pays and did not need to be paid again.
3. **An array loses edits under collaboration.** model.ts already states the
   rule: properties are flat because each (node, key) pair is one LWW register.
   `cards` as one array is ONE register, so two people dragging two different
   cards keep one of the two moves, silently. As blocks, each card is its own
   CRDT node and `x`/`y` are its own registers, and both drags land.
   `table.rows` has exactly this limitation and documents it; there was no
   reason to take it on again where the alternative is strictly simpler.

Because the cards are separate blocks that an old build renders on its own, the
canvas's `html` is its NAME and must never repeat them — the opposite of
`tableFallbackHtml`, which has to hold the cells' text because a table's cells
are not blocks. The markdown export follows: a canvas exports as `**name**`
and its cards arrive as their own lines.

### Why percentages, and why `ratio` is document data

Percentages, not pixels: the same file is read at 320px and at 2560px and
printed on A4, and a layout in px is a layout that is right at exactly one
width. Not an abstract 1000-unit grid either — that is a percentage with a
scale factor bolted on, and the renderer would have to know the factor forever.
A percentage needs nothing: `left: calc(var(--sp-x) * 1%)`.

`ratio` has to be in the document rather than a reader-side default, because
the cards' `y` is relative to it: a canvas laid out on a 1.6 surface and read on
a 1.0 one is a different picture. It is stored as an ABSENT key when it is the
default (the `editView` discipline), so a canvas cycled Wide→Square→Tall→Wide
is byte-identical to one nobody touched.

Below 560px the surface renders as a stacked list of its cards, positions
ignored. That is a RENDERING choice made in the stylesheet, not a change to the
file — four cards on a 360px board are four unreadable stamps, and the same
document lays out spatially again on the next screen up.

### Names reserved, so a follow-up does not have to guess

- Card SIZE is `cw`/`ch`, in the same percentage units. **Not `w`/`h`** — an
  image block already carries its intrinsic pixels in those, and an image is a
  perfectly good card.
- CONNECTORS belong on the canvas block as `links: [{ from, to }]` of card ids.
  A relation is not a property of either end.
- NESTING needs nothing: a canvas inside a canvas is a card whose type is
  `canvas`, and the container stack already supports it.

None of the three is built. All three are additive.

---

## 2026-08-28 — a graph view is a DRAWING, and derived state is never stored

Settled while building `spaces/src/graph.ts` (bento/spaces graph view). Written
down because the next app to want a picture of its own data will face the same
three forks, and because two of these are platform-shaped rather than
spaces-shaped.

**1. Derive at open; store nothing.** The graph is built from
`buildIndex().backlinks` and `Page.parent` when the overlay opens, and dropped
when it closes. There is deliberately no `doc.graph`, no saved node positions
and no second link scanner. A stored layout is meaningless to the next reader's
window size, and a second scanner is a second answer to "what links to this
page" — the one question the backlink index exists to answer. The precedent
cuts the same way as `SpaceIndex` itself: *derived, NEVER stored*.

**2. A viewer preference is read the same way in every app.** Reduced motion
here reads localStorage `bento-reduce-motion` first and the OS
`prefers-reduced-motion` second — character for character the rule
`slides/src/present.ts` set, and the rule the theme and the locale already
follow (PLATFORM §8). An app that invents its own motion preference makes the
suite two products.

**3. An animation needs a wall-clock settle guarantee, not just a rAF loop.**
`requestAnimationFrame` is throttled to ZERO in a hidden or occluded tab. The
graph's reveal interpolates from a spiral toward a settled layout while the
camera is framed against the FINAL positions, so a starved rAF does not merely
fail to animate — it leaves the picture frozen halfway and off-centre, which
reads as a broken feature. Measured in exactly that state, then fixed with a
`setTimeout` that lands the final frame regardless. slides carries the same
guarantee for entrance tweens, for the same reason, and any future app that
animates on open needs one too.

**A note on measuring this class of feature.** Nothing above was found by
looking at the screen. The overlay carries a small debug object (`__graph`:
node/edge counts, layout ms, `reduced`, `reveal`, `frames`) and the frozen-
reveal bug was identified by reading `frames: 0` beside a mid-flight `reveal` —
an instrument on the DECISION, not a sample of the result. The rig's graph
assertions were each made to fail on purpose before being trusted (twelve
deliberate mutations; two assertions were too weak and were tightened, one of
them a threshold that passed both with and without the behaviour it claimed to
test).

## 2026-08-28 — bento/spaces: a table column sorts, a title column does not

The Bases table became editable and sortable in place: a column header cycles
ascending → descending → none, and a cell opens the same picker the page's own
header strip opens.

Two things settled that another agent could otherwise contradict.

**Unsorted DELETES the key.** The header writes the view's existing `sort`
through the existing `editView`, and the third click passes `undefined` so the
key is removed rather than stored as `[]`. A view sorted and unsorted from its
header is byte-identical to one nobody ever touched. `cycleSort` in fields.ts is
where that third state lives, so it is one function rather than a rule the two
sort controls each have to remember.

**The page-title column is NOT sortable, deliberately.** A view's `sort` names a
FIELD: `sortRows` looks each key up in `doc.fields` and skips what it cannot
find, and `unknownSortKeys` reports the miss as "newer than this build". A
pseudo-key like `{key:'title'}` would therefore be a key EVERY shipped build
reports as unreadable and does not apply — and teaching `sortRows` about a
non-field key means a second ordering mechanism living beside the first, in a
format where both are permanent. One order stored in two shapes is the thing
that later disagrees with itself. The column is a plain `<th>` and does not
pretend otherwise. If title order is wanted later, the honest shape is a real
field, not a special case in the sorter.

**A cell edit can CREATE the prop block**, the way a board drop already could:
`editor.putField` is the one place a page gains a field, and it goes through
`propBlock`, so the readable `html` is written with the value. A table column
exists because SOME row carries that field; the rows that do not get an empty
cell, and editing it is how the field arrives on that page.

The picker was split from `openFieldPicker` into `fieldPicker(f, cur, anchor,
write)` — a picker over a WRITER rather than a block id, because a cell can
stand for a value that has no block yet. The header strip, the board's card chip
and a cell are now one control with three writers, not three controls.

## 2026-08-28 — two size mechanisms, and why deleting either loses a regression

**Both stay.** #279 added an advisory PR build-size comment while
`scripts/test-spaces-size.mjs` already measured shell size in CI. That looks
like duplicated measurement and it is not, so this entry exists to stop the
next person tidying one away.

**They answer different questions.**

| | the CI rig (size-budgets.json) | the PR comment (#279) |
|---|---|---|
| measured against | a committed `reference`, or a `max` ceiling | the PR's own base commit |
| horizon | absolute, persistent, across all history | relative, one PR |
| can fail a build | yes, when `enforce:true` | never, advisory only |
| catches | SLOW drift — forty merges at 300 B each | a single change's jump |
| blind to | which change caused it | accumulated drift; every PR looks fine |

The second row is the whole point. Forty merged commits costing 300 bytes each
is 12KB nobody chose, and **every one of those PRs shows a harmless +300 in its
comment**. Only a number compared against a fixed point sees it. Equally, the
rig can say a shell grew 12KB since the reference but not which PR to blame;
the comment can. Neither is redundant.

**Two real defects were found while reconciling them, both silent.**

1. **Only bento/spaces was ever registered.** `size-budgets.json` listed one
   shell, so slides and dash had NO persistent size record at all. The rig has
   always been generic — it walks every entry — it just had nothing to walk.
   Both are now registered as `enforce:false` watermarks.
2. **dash was structurally unmeasurable.** The CI step sat in the spaces
   section, *ahead of the dash build*, and the rig SKIPS a shell that is not
   built — so it printed `skip dash — not built` and moved on. A guard that
   reports "nothing to do" in a passing build is invisible. The step now runs
   after all three builds.

**Why watermarks and not ceilings for the two new entries.** Same reason spaces
gave up its own: at 98.6% of its limit it had started declining worthwhile
fixes, which is the ceiling costing more than it saves. And a ceiling picked
with no history behind it is a guess that fails somebody else's PR. Growth
still has to pass a human, because the number is printed every run.

**References come from CI, never a local build.** Most of a shell is one
deflated block and zlib's output differs across node versions — one commit
measured 130,095 B on node 26 locally against 131,246 B on CI's node 24. When
the two disagree, believe CI.

**Naming, left alone deliberately.** `test-spaces-size.mjs` now covers three
shells and the name undersells it, but it is invoked by name from
`scripts/test-spaces.mjs` and referenced in this log, and renaming it was more
churn than the overlap warranted. The file's own header says it is generic.

## 2026-08-29 — five rigs reported passes for work they were not doing

**A green rig is an instrument, and these lied.** The same family as the
"instruments that lie" list in `CLAUDE.md` — a transform read back from an
inline element, rAF in a hidden tab, a DOM sampler polling mid-animation — with
one difference that makes it worse: those instruments were consulted
deliberately by someone who suspected a problem. A rig is consulted by CI, on
every push, by people who have stopped suspecting anything.

**The findings, verified against the tree and PR #399's diff on 2026-08-29.**
Five rigs across four zones, found within one day of each other:

| rig | what it reported | what was true |
|---|---|---|
| `test-tray-bridge.ts` | **52/52 pass** | the #277 arbitrary-write fix was DELETED; its shape checks pinned the `<a download>` call site, the NEIGHBOUR of the fix, while `exportCopy`'s `safeFileName` gate and path-containment guard were read by nothing |
| `test-tray-index.mjs` | "absent, skipped", in green, **for weeks** | the tray→home rename moved the corpus and the path did not; **eleven cases** went untested |
| `test-doc-index.mjs` | never ran | unregistered in CI, and the same rename left it importing `../tray/doc-index.mjs` |
| `test-spaces.mjs` | never ran | unregistered **from the day it was written** |
| `test-slide-store.ts` | never ran | never registered |

**Two distinct failure modes, and the second is quieter.** A rig can assert the
wrong thing — pinning code adjacent to the fix rather than the fix. Or it can
assert nothing at all while still printing a pass, because its input moved or it
was never wired to CI. The second is harder to notice precisely because there is
no wrong assertion left to be wrong. #399's own comment on `test-doc-index.mjs`
puts it best: **a rig nobody runs cannot report its own import failure.**

**Presence is not the property; ordering is.** The load-bearing check added to
`exportCopy` is not that `safeFileName` and the containment guard exist — both
can exist and still run AFTER the write. It asserts
`indexOf('write(to: tmp)') > indexOf('hasPrefix(')`. This is the part that
transfers to any rig: a guard's presence is cheap to assert and frequently
means nothing.

**The check adopted, which costs two minutes:** delete the guard the rig exists
to protect, run the rig, and watch. If it still passes, the rig is reading
something adjacent to the fix. **Do it when you write the rig, not after someone
reverts it.** Measured, not assumed: `exportCopy` gained FOUR checks and THREE
of them fire on the revert that was actually run (53/56). That gap is the point
rather than an embarrassment — four independent assertions, not one assertion
spelled four ways, and the one that stayed silent did so because of how those
particular guards were stripped.

**A skip that protects nothing costs the whole check.** `test-tray-index.mjs`
skipped a missing corpus for a good reason — it arrived with the Android work,
and a rig that fails until an unrelated branch lands is a rig people learn to
ignore. The reason expired when the corpus landed and the skip did not. A path
that is SUPPOSED to exist is a failure when it does not, and a rig must
distinguish ABSENT from MOVED.

**And the practice is now enforced, not just recommended.** A two-minute habit
decays; the same PR adds the mechanical half. `scripts/test-spaces.mjs
--manifest` runs in CI and asserts the list both ways — every `test-spaces-*`
file on disk is listed in `RIGS`, and every rig in `RIGS` has a step in the
workflow — failing with **"A rig nobody runs is not a rig. Add a step for each,
or remove it from RIGS."** Read that beside the diagnosis above and the pair is
the whole entry: one line names the failure, the other refuses to let it recur.
Both halves are the point. A rig that catches this class of defect is worth more
than a paragraph asking people to remember it, and any app growing a rig suite
should copy the manifest check rather than the habit.

**Status.** PR #399 (branch `ops-rig-repairs`) is in flight as this is written;
it registers the unrun rigs, closes the two mis-asserting ones, and adds the
manifest check. The findings above are properties of the tree at `220f7e7` and
stay true whatever shape that PR lands in.

**Attribution, corrected once in the writing of this entry.** The two
`test-tray-*` findings are bento-team-home-ios's, with bento-team-home-android
hitting the same class from the other side. The three unrun rigs and both quoted
lines came through #399 and are **bento-team-ops'** — an earlier draft of this
paragraph credited the whole finding to home-ios, which was wrong. Worth
recording how it was settled, because it will come up again: `git log` cannot
answer it. Every session on this repo commits as the maintainer, so authorship
metadata resolves to one person for all of us; the zone and the branch are the
only evidence that distinguishes anybody. Cite the PR, which is checkable, over
the session, which is not.

**The `CLAUDE.md` counterpart is not discharged by this entry.** The two-minute
check belongs in the file people read BEFORE writing a rig; this log is what
they read after wondering why a standard exists. That text is queued for the
maintainer.
## 2026-08-29 — the locale list leaves the prose; docs point at LOCALES

**The rule that named the languages was wrong for a month and cost a shipped
app a language.** `AGENTS.md` rule 6 listed seven catalogues (ja, zh-Hans,
zh-Hant, es, fr, de, it) and `CLAUDE.md` said "7 locales"; Portuguese was added
2026-07-25 and the docs did not follow. PR #394 added `type/src/i18n/` with
seven catalogues and no `pt.ts`, and hard-coded the seven-locale list into its
new build script. That session followed the written rule exactly. The rule was
the defect.

**So no document states the list any more.** Rule 6 and the `CLAUDE.md` i18n
entry now name where the list lives — `LOCALES` in the app's
`scripts/build-*-i18n.mjs`, with `ls <app>/src/i18n/` as the check — and carry
the failure story, because a rule without one gets deleted by whoever finds it
inconvenient. A count in prose is verified by nothing and is the only copy that
can rot unnoticed; every other copy is load-bearing and fails visibly.

**Three copies, not one, and the number is growing.** Adding a locale touches
the catalogue file, the app's `LOCALES`, and any rig holding its own list.
Saying "point at the build script" is true and incomplete: it leaves a rig's
copy stale, which is what goes red. Measured on 2026-08-29:

| | slides | spaces | type (#394) |
|---|---|---|---|
| `LOCALES` in build script | 8 | 8 | 7 |
| catalogue files | 8 | 8 | 7 |
| extra-file guard | **yes** | no | no |
| rig with its own list | no | no | **yes** |

**Only `build-i18n.mjs` errors on a catalogue missing from `LOCALES`.** On
spaces and type, adding a catalogue without touching `LOCALES` exits 0, prints
its locale count, and silently never packs the file — a translation that ships
to nobody, announced by nothing. That is worse than a red build. Porting the
guard to the sibling scripts is queued with ops and is not done here.

**A rig must derive the list, never restate it.**
`scripts/test-i18n-coverage.mjs` already does the right thing: it parses
`PACKED_LOCALES` out of the generated `packed.ts`, so it cannot disagree with
the build. #394's `test-type-i18n.ts` hard-codes a second list instead. The
existing rig is the pattern to copy; a derived list is a copy that cannot rot.

**Not fixed, deliberately:** this log's 2026-07-24 entry says "App UI i18n
(7 locales)". It was true when written — one day before the entry that added
Portuguese — and this log is append-only. It stays. Anyone grepping for stale
counts will hit it; that is the cost of an honest record, not a defect.

**The general rule, because this is not really about locales.** A count in
prose is verified by nothing. Three files stated one today — `AGENTS.md`,
`CLAUDE.md`, `docs/PARALLEL-WORK.md` — all three were true when written, all
three went stale in silence, and one of them cost a shipped app a language.
**Name the mechanism, never its current output:** the mechanism survives edits,
the output has a half-life. That extends to this log — an append-only entry
cannot be corrected, so a number belongs in one only when it is FROZEN. The test
before writing one down: *could this change without the entry becoming wrong?*

**A number is frozen by its framing, not by its value.** "Eleven cases went
untested" is safe: it reports something that already happened and stays true
forever. The same figure asserted as a standing fact — "there are eight
catalogues" — is not, because the next locale makes it a lie nobody can edit.
The table above says 8 twice and is safe for exactly this reason: it is stamped
`Measured on 2026-08-29` and says the number is growing, so it reads as a
reading taken at a moment rather than a claim about the present. Date a
measurement and it becomes evidence; leave it undated and it becomes a fact with
an expiry nobody sees. **The rule is not "avoid numbers" — that is unusable
advice — it is "never write one that is still claiming to be current."**

This is the same failure recorded elsewhere today from the rig side — a
statement that was true when written, went stale without a sound, and had
nothing checking it. Documentation and a green test suite fail identically here,
and for the same reason: both are instruments, and an instrument nobody
calibrates is believed longest.

## 2026-08-29 — OPEN QUESTION: `pt` is two different languages in the suite

**Not a decision. A question recorded because no rig can ask it.**

**The facts, counted on 2026-08-29.** Both files are named `pt.ts` and both are
correctly named, so every mechanical check passes:

| | `arquivo` | `ficheiro` | `tela` | `guardar` | header declares |
|---|---|---|---|---|---|
| `slides/src/i18n/pt.ts` | 47 | 10 | 33 | 4 | Portuguese (**Brazilian**), explicit pt-BR terminology policy |
| `spaces/src/i18n/pt.ts` | 9 | 58 | 3 | 7 | "Portuguese", no policy |

So slides is Brazilian by declaration and spaces drifted European, under one
locale code. A user running the suite in Portuguese meets two vocabularies.
`type` followed slides while adding its catalogue and normalised the strings it
reused.

**The intent was Brazilian, but it was never written as a rule.** The
2026-07-25 bundling entry adds Portuguese "because Brazil has a real
English-proficiency gap"; `slides/src/i18n/pt.ts` states a pt-BR policy in its
header and notes that European Portuguese "deserves its own catalog later".
Neither is a suite-wide policy, and `spaces/` shows what happens without one.

**Why this cannot be a rig.** The drift is vocabulary under an identical locale
code. There is no signal to assert on short of a term blocklist per variant,
and even that is not sufficient: bento/type reports that one reused string
passed a `ficheiro`/`guardar`/`ecrã` sweep while remaining European in
construction ("cada vez que guarda", "num computador") and had to be rewritten
by hand. **A term-level sweep is not a conversion.**

**Not clean anywhere, which is why this is a question and not a cleanup.**
Slides violates its own stated policy 10 times (`ficheiro`) plus `guardar` and
`ecrã`. Settling the question means retranslating a catalogue, which is
translation work and a maintainer's call, not a documentation change.

**What is actually being asked**, so it is not rediscovered:

1. Is bundled `pt` pt-BR for the whole suite? The recorded reasoning says
   Brazil, and two of three catalogues follow it.
2. If yes, `spaces/src/i18n/pt.ts` needs converting by hand and every catalogue
   should declare its variant in its header the way slides does.
3. Does European Portuguese become a downloadable pack (`pt-PT`), which is what
   the slides header anticipates and what the pack tier exists for?

Until it is answered, **a new catalogue for a language with regional variants
should state its variant in its header** and follow the sibling app that
already declares one.

## 2026-08-29 — a green local rig run can mean half the rig never ran

*Neighbour to "five rigs reported passes for work they were not doing" above,
and a DIFFERENT failure. Those rigs were broken everywhere, CI included —
unregistered, or reading a path their corpus had moved off. This one is wired up
and runs correctly in CI; it is only on a developer's machine that it quietly
runs half of itself. If you are here because a rig lied, that entry is the one
about rigs that never ran at all.*

**`scripts/test-sanitize.ts` has two halves.** The node half imports the pure
functions — `sanitizeSvgCss`, `svgAttrAllowed`, `SVG_TAGS` — and runs anywhere.
The browser half drives real Chrome, because the parts it tests need a DOM.
Where there is no Chrome it says so and skips, and the run still ends green.

**So a pass locally does not tell you the thing you edited was tested.**
`sanitizeSvg` needs a DOM, which means it is covered ONLY by the browser half.
A change to it can pass five rigs on a laptop and be caught by CI a minute
later, which is exactly what happened to the svg `<style>` scoping change: five
rigs green locally, `✗ the svg <style> is kept` in CI.

**The rule: run the rig that covers the file you edited, and check which half of
it ran.** Not how many rigs passed — which ones, and whether the half that
covers your change was one of them. A skip that prints like a pass is an
instrument that lies, and this repo already keeps a list of those: a CSS
transform on an inline element that reads back correctly and moves nothing;
`document.fonts.check()` returning true for a font that is not installed; rAF
throttled to zero in a hidden tab; an SVG rasteriser that ignores
`font-family`. This is the same family — the instrument answers a question you
did not ask.

**The first version of this finding was wrong, and the correction is the
useful part.** It was filed as "`sanitizeSvg` has no rig coverage", which is
false — the coverage exists and it works. "Your green local run may have
skipped it" is both true and actionable; "there is no coverage" would have sent
someone to write a rig that already exists.
