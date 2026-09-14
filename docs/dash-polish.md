# bento/dash — polish sweep

A hands-on pass through the surfaces the rigs cannot see: charts, pivots,
dashboards, stories, 3D, comments, find/replace, the save menu, print, sharing,
the help card, empty states and the responsive ladder.

Method: `dash/dist-single/sweep-a1.html` served on 127.0.0.1:5189, driven in the
browser pane at 1440x900 unless a width is named. Every number below was
measured in the running app (`getBoundingClientRect`, `getComputedStyle`,
`elementFromPoint`) or read out of the built shell, not estimated from a
screenshot.

**Instrument caveats, so nothing here is mistaken for one.** The pane denies
File System Access, clipboard and notifications, so nothing that ends in a real
`Save`/download was exercised. Synthetic key events reach `document` listeners
fine (Escape, cmd+F both worked) but the pane's `key: "Right"` is not
`ArrowRight`, so a "→ did nothing" observation was discarded after checking
`story.ts:774` — the binding is correct. Screenshots come back scaled 1440→800,
so all clicks were placed from measured page coordinates, not from the image; an
early "Chart does nothing" note was a mis-scaled click and is not in this list.
"Ada" appearing as a comment author is a `bento-author` value left in this
browser profile by earlier testing, not a shipped default.

Three findings the brief already owns are excluded except where noted at the
end: the About dialog's height, the properties panel's spacing, and the
dataset grid's empty lower two thirds.

---

## 1. A live session cannot be stopped below 900px wide

**Did:** clicked **Start live session** at 1440 wide, then narrowed the window
to 880x800.

**Happened:** `window.bento.doc.collab.on === true` and the room is
`wss://sync.bento.page/d/…`. At 880px the **Stop sharing** button computes to
`display: none` and the string "Stop sharing" appears nowhere in the document.
The only remaining trace is an 8px green dot. There is no menu fallback — unlike
slides, which demotes crowded controls into `⋯`, dash simply removes this one.
The About dialog offers no way out either; its nearest control is "Offline mode
— block every network feature", which also kills update checks.

**Expected:** a control that puts a document on a network relay is reachable
from every width the app renders at, or at minimum survives into a menu.

`dash/src/sync.css:125` — `@media (max-width: 900px) { .dx-bar .dx-people-toggle { display: none; } }`,
and again at `:132` for ≤700px. The rung above it (`:124`) only hides a *label*;
this one hides the control.

## 2. Going live takes one click, asks nothing, and shows nothing

**Did:** clicked **Start live session** once.

**Happened:** no dialog, no confirmation, no room link, no "here is how someone
joins". The label swapped to "Stop sharing" and a green dot appeared. The
presence list that would say "You · Nobody else is in this workbook" is rendered
into the DOM and then given zero width by `sync.css:112-121`, whose comment says
"the full list belongs in a panel, not a strip" — but no such panel exists in
this build; I could find no route to one.

**Expected:** for a product whose whole pitch is that the file is the document
and nothing phones home, the one action that starts talking to a relay is the
action that deserves a confirmation, and certainly deserves a result. Right now
the most consequential button in the toolbar is also the quietest.

`dash/src/sync.css:112`, and the tooltip at `main.ts` ("Put this workbook on the
relay so people you send a copy to edit it live with you") — 81 characters, and
"the relay" is our word, not the reader's.

## 3. Dashboard bars are dead — and the dashboard tells you to click them

**Did:** opened the Dashboard, read its own instruction line ("Click a bar, a
slice or a row to filter every tile."), clicked the North bar in "Value by
region".

**Happened:** nothing. `elementFromPoint(130, 378)` returns
`<rect class="dbx-bar">` with `cursor: pointer` and `pointer-events: auto`.
Clicking 88px higher — the empty air above the same bar — filters the whole
dashboard correctly.

**Cause:** the pickable band `<rect class="dbx-hit" data-tile=… data-cat=…>` is
pushed in the category loop (`dashboard.ts:815`), and the bars are pushed in the
series loop *after* it (`dashboard.ts:854`). SVG hit-tests the topmost painted
element, so the bar sits over its own hit target — and the bar carries no pick
attributes, so `onClick`'s `closest('[data-tile]')` (`dashboard.ts:1021`) finds
nothing. `.dbx-dot` (`:835`, line and scatter points) has the same shape.
Slices (`:891`), legend keys (`:910`) and table rows (`:1136`) all carry
`pickAttr` and do work.

**Expected:** the biggest, most obviously clickable object on the page is the
one that responds. `dashboard.css:176` promises this with
`.dbx-bar, .dbx-slice, .dbx-dot, .dbx-key { cursor: pointer; }`.

*One-line fix:* `pointer-events: none` on `.dbx-bar, .dbx-dot`, or add
`${pickAttr(pick, td.cats[i])}` to both rects.

## 4. A filter that matches nothing produces the app's worst screen

**Did:** column menu on Region → Condition "equal to" → `zzz` → Apply filter.

**Happened:** a header row over nothing. No message in the grid body at all. The
totals row still reports `sum £0`, `avg 0%`, `sum £0`. The only statement of what
happened is "0 of 8 rows" in 12px `--muted`, measured at (12, 879) — the bottom
left corner of a 900px-tall window, as far from the reader's eye as the layout
permits. The filter menu stays open over the result.

**Expected:** the empty region should say why it is empty, next to where the
rows would be. And the totals must not assert a number. The codebase already
knows this: `chart.ts:249` — *"an empty bar chart reads as ZERO, which is a
number, which is a lie"* — and there is already a string for the partial case,
`t('Totals cover the {n} row(s) the filter leaves showing, not all {all}.')`,
which does not fire when n is 0. Zero rows is the case where the totals row
lies hardest and says least.

## 5. A chart cannot be configured, and does not survive the file

**Did:** ＋ Chart on the Pipeline dataset; looked for a way to choose what it
plots.

**Happened:** there is none. `binding` is a module-local `let` in
`main.ts:776`, written only by `defaultBinding(sheet)` (`main.ts:868`), which
hard-codes "first text column against the first up-to-3 numeric columns". There
is no x picker, no series picker, no aggregate control. There is no `chart` field
on the workbook model (`model.ts` has one only on *dashboard tiles*), so the
chart is gone the moment you close the panel or reopen the file.

The one control the panel does have — the kind button — is a blind cycler.
Clicking it eight times gave `Line → Pie → Scatter → Bar → …`; it has no
`title` and no `aria-label`, and its label names the *current* state while
behaving as a command, so pressing "Bar" gives you Line.

**Expected:** a chart is a thing a person makes, adjusts and keeps. This one is
a preview you cannot steer and cannot save.

## 6. The presentation shows the audience "This step has no chart binding."

**Did:** Story → Capture current view → Present.

**Happened:** a full-screen black stage, 1376x768, whose entire content is a
14px `--muted` sentence reading *"This step has no chart binding."* — centred, on
its own, in front of an audience. Step 2 has that and nothing else at all: no
caption, no data, one grey line on a black screen.

The step it is describing was captured by pressing the app's own primary button
while a dashboard filter (Region: North, 3 of 8 rows) was active and a pivot was
open. What got stored was `{id, sheet: "sheet-pipeline", caption}` — neither the
filter nor the pivot. The button says "Capture current view"; it captured the
sheet id.

**Expected:** "binding" is an internal word and this is the least appropriate
place in the product to use it. If a step has nothing to draw, presenting it
should say so to the *author*, in the editor, before the room is dark.

Also measured in the presenter chrome: `‹` sits at x=16 and `›` at x=1280 —
1236px apart on a 1440px screen, at opposite ends of the bar. Neither ever
disables, at either end of the deck. The `ds-dots` progress strip is 1216px wide
holding two 8px dots. And `⏸` — which every viewer will read as *pause the
slideshow* — is titled "Reduced motion (M)".

## 7. The story editor never re-renders, so it disagrees with the document

**Did:** captured two steps, clicked the ✕ on step 2, then clicked the toolbar
**Undo** button.

**Happened:** `document.querySelectorAll('.ds-step').length === 1` while
`window.bento.doc.story.steps.length === 2`. Undo silently restored the step to
the document and the editor kept showing it gone. Reached from the other side,
deleting the only step and undoing leaves the panel showing its empty state
("Filter, sort and chart the sheet, then capture it as the first step.") with
**Present** disabled, over a document that has a step. Pressing Present after a
different sequence opened a presentation reading "1 / 2" while the editor beside
it listed one step.

**Expected:** the panel listens for `doc`. Everything else in the app does.
`dash/src/story.ts`.

## 8. The pivot panel clips its own last column, and captions it 596px away

**Did:** ＋ Pivot on the Pipeline dataset.

**Happened:** the pivot table measures 412px inside a 402px body whose
`overflow-x` computes to `visible` — no scroller. The Grand total column is cut
off mid-value (`£50,75`, `£97,05` on screen) with no way to reach it. Below,
"8 source rows" is pinned to the bottom of the panel at y=823 while the table it
annotates ends at y=227.

**Also:** the chart-kind button stays in the pivot's header showing whatever
chart kind was last used ("Pie"), fully enabled at 35px wide, and clicking it
changes nothing at all — `main.ts:853` returns early when there is no chart
binding. A visibly live control that is a no-op.

**And:** ＋ Pivot silently adds a `Pipeline — pivot` tab to the sheet strip that
**cannot be opened**. Left-clicking it opens a menu headed "pivot table — open it
from ＋ Pivot". Its `.dx-tab-off` styling is `opacity: 0.62` over `#1e2a3a`,
which lands *darker* than a normal tab's `#5b6472`, so it does not read as
unavailable either.

## 9. The first choice a new user makes is explained at half length

**Did:** clicked ＋ in the sheet strip.

**Happened:** two items, each 210px wide, needing 342px and 417px. The reader
sees "Typed columns — for …" and "Typed cells — for…". The full strings are
"Typed columns — for volume, joins and charts" and "Typed cells — for a scratch
pad, and =SUM anywhere".

**Expected:** Dataset-vs-Spreadsheet is *the* concept in this product, this menu
is where it gets taught, and the teaching is cut in half. Either widen the menu
or shorten the copy — the current state does neither.

## 10. At 1280 wide every feature loses its label; the sharing button keeps its

**Did:** resized to 1280x800 — the default window on a 13" MacBook.

**Happened:** Formula, Chart, 3D, Pivot, Dashboard and Story all collapse to
bare 35px icons with empty `innerText` — six unlabelled 15px line glyphs in a
row, in a product where nobody yet knows what "3D" or "Story" means. In the same
bar, **Start live session** keeps all 121px of its text. At 1024 the six fold
entirely into an unlabelled `＋ ▾`.

**Expected:** the ladder sheds the least important thing first. It currently
sheds the entire feature set before it sheds a sharing button.

`dash/src/styles.css:580` onward documents the ladder carefully; the ordering
inside a rung is what is wrong, not the mechanism.

## 11. Nothing in the grid has a tooltip, so clipped content is unreadable

**Did:** typed a 78-character value into A1 via the formula bar, and gave the
column a 65-character name.

**Happened:** the cell renders 119px of 479px of content and the header 119px of
a name needing 401px. Neither carries `title` nor `aria-label` — measured on
every gridcell and every columnheader in the sheet. To read a clipped value you
must select the cell and look at the formula bar; to read a clipped column name
you must open the properties panel.

**Expected:** hover reveals what does not fit. This is table stakes in every
grid the reader has used.

## 12. A long column name distorts the properties panel

**Did:** same 65-character name.

**Happened:** the read-only "Selection" row grew from ~18px to **90px** tall —
the name wraps to five lines inside a 110px value cell and pushes everything
below it down. The row number ends up orphaned on a line of its own, so the field
reads "…FY26 restatement) 1". The Name input holds 401px of text in 110px.

Filed separately from the panel-spacing work already in flight, because this is
an edge-state layout failure rather than a rhythm problem — the panel is stable
until a name is long, then it is not.

## 13. Charts misdescribe and mis-format what they draw

- **Pie names series it does not draw.** With the default binding the heading
  reads "Region · Value, Weighted" in every kind. A pie renders one series;
  `chartHeading` (`chart.ts:223-229`) joins all of `bind.series` unconditionally.
  The heading asserts two measures on a chart showing one.
- **Money loses its currency.** The Pipeline totals row says `SUM £97,050`; the
  chart of the same column, on the same screen, labels its axis `50,000`,
  `60,000`. The column's `£#,##0.00` format is not carried into the axis.
- The pie also draws leader-line labels *and* a legend for the same three
  slices, and no value or percentage on any slice.

## 14. The 3D plot is unreadable and disagrees with the dashboard beside it

**Did:** ＋ 3D with the dashboard open and filtered to Region: North.

**Happened:** the panel body contains exactly one `<canvas>` and no other
element — no axis labels, no ticks, no legend, no hover readout anywhere in the
DOM. The title "3D scatter · Value / Probability / Weighted" is the only text
on the surface, and it does not tell you which axis is which. Sphere size varies
and encodes nothing that is named. Meanwhile it draws all 8 rows while the
dashboard 400px to its left reports "3 of 8 rows".

**Expected:** at minimum, named axes and a hover readout. As shipped it is
decoration you cannot read a number from, and it contradicts the chart next to
it.

## 15. The keyboard-shortcuts card is taller than the screen it opens on

**Did:** pressed `?` at 1440x900.

**Happened:** `.dx-help` measures **1003px tall** in a 900px viewport, opening
at y=45 — so it ends 148px below the fold and its own **Close** button sits at
y=1001, entirely off-screen at open. Reaching it means scrolling the backdrop
(scrollHeight 1109). Escape does close it, but focus lands on `BODY` rather than
returning to the `?` button.

The card lists 43 shortcuts and omits two the app advertises elsewhere:
`⌘⌥M` (wired at `comments.ts:570`, named in the comment pill's own tooltip) and
`⌘P` (wired at `print.ts:1071`, named in the Data menu). A shortcuts card that
is missing shortcuts is worse than no card.

Also measured in the topbar: the `?` button is 27px tall at y=9 while every
other `.dx-btn` is 29px at y=8 — one control 2px short and 1px low in a row of
fourteen.

## 16. The Save menu explains itself in "identity"

Five items, all beginning with "Save", 320px of menu, 84 words of description at
11.5px:

- "Save a copy… — A second file you carry on working in — **same workbook, same
  identity**."
- "Save as new workbook… — A separate workbook — same data, **new identity**.
  Nothing links it back to this one."
- "Save as template… — every open of it becomes **a fresh workbook of its own**."

Three of five items turn on a word the reader has never met, and the difference
that actually matters to them — *this copy keeps collaborating with the
original; that one doesn't* — is never said in those terms. Titles are 13px/400
against 11.5px/400 descriptions: differentiated by size and grey alone, no
weight, so the whole menu reads as one block of small text.

## 17. Popovers sit flush against the window edge

`.dx-pop` for comments measures x=1120, **right=1440** — zero margin against the
viewport. The promote popover measures x=1180, right=1440. The story editor, by
contrast, ends at ~1427. Two of three floating surfaces touch the glass.

The comments popover also opens *over* the properties panel, covering the Type /
Format / Formula / Width rows while it is up.

## 18. "(s)" is the app's pluralisation strategy — in 17 strings

`grep` over `dash/src` finds **17 distinct English strings** using the `(s)`
form, 515 occurrences once the eight locale catalogs are counted. They are not
in obscure places:

- the About dialog's opening sentence: "2 sheet(s), 8 row(s), 7 column(s)"
- the print job estimate: "8 row(s) across 1 sheet(s) · about 1 page(s)"
- a sheet tab's tooltip: "spreadsheet, 14 cell(s) used"

Every one of these has the count in hand at render time. "(s)" is the most
reliable single signal in a UI that nobody has finished it, and it is also
untranslatable — the catalogs carry the parenthesis into Japanese and German.

## 19. The comment composer

- Placeholder: **"What is wrong with this number?"** (`comments.ts:760`),
  hard-coded. I anchored the first comment on cell A1, whose value is the text
  "North". The prompt is literally inaccurate there, and it presumes every
  comment is a complaint — not a question, a note, or a hand-off.
- The primary button is not primary: `.dxc-primary` computes to a **white**
  background at `font-weight: 400`, identical to Cancel except for a purple
  border.
- Comments introduce `--cmt: #7c3aed` (`comments.css:24`), the only purple in an
  amber-and-blue app.
- The header reads "Comment on Region · row 1 · A1" — the same location three
  ways — followed by "reads North", which is terse to the point of cryptic.

## 20. Story step delete shares a column with the panel close

Measured: the editor's **Close** ✕ at x=1379, y=734; the step's **Remove step** ✕
at x=1379, y=791 — same glyph, same `ds-btn` class, same 32x25 box, same column,
32px of clear space between them. One dismisses a panel; the other destroys
work. (Delete *is* undoable — I verified the round trip — but see finding 7 for
what undo then does to this panel.) The step's ↑ and ↓ are enabled and inert on
a single-step story.

## 21. At phone width the workbook has no name

At 377px the title input measures **36px wide holding 141px of text** — "Untitled
workbook" renders as "Un". In the same 375px formula bar, "Open as a spreadsheet"
is given 280px, so a secondary action outweighs the cell reference and value it
sits beside.

## 22. Smaller things, worth a pass

- **"Open as a spreadsheet" does not open anything.** It opens a popover whose
  own button reads "Make spreadsheet copy" and whose body has to walk the label
  back: "A COPY, as the dataset is right now." Its `title` is a 107-character
  sentence. The label should describe the action.
- **Promote is offered on an empty sheet.** On a brand-new spreadsheet, "Make
  A1:A1 a dataset" is enabled, its popover is fully enabled, and only after
  pressing "Make dataset" does the app say "Every cell in A1:A1 is empty, so
  there is nothing to make a dataset of." — good sentence, two steps too late.
- **Replace all leaves the formula bar stale.** Replaced "North"→"Northern" (3
  cells, correctly reported as "3 replaced"); cell A1 became "Northern" in the
  document while the formula bar still displayed "North".
- **Find's ↑/↓ never disable**, including while the bar reads "No matches".
- **The print dialog has no preview.** Six layout decisions — paper, orientation,
  wide-sheet behaviour, margins, header, sheet scope — and the only way to see
  the result is to commit to the browser's dialog. The dialog carries
  `role="dialog"` and `aria-modal="true"` but no accessible name.
- **Import/export arrows read backwards in a browser.** `ICON.imp` is a
  down-arrow-into-tray and `ICON.exp` an up-arrow-out-of-tray (`main.ts:142-143`).
  In this app Export *downloads a file* and Import *reads one off your disk*, so
  both glyphs point the opposite way from what the row does. The tray metaphor
  is defensible in isolation; next to the word "Export" it is not.
- **No toolbar toggle carries `aria-pressed`.** Dashboard on/off is communicated
  by background colour alone.
- **The "(Select all)" checkbox stays live over an empty list** when a column
  filter's value search matches nothing.

## Known items, confirmed not worse

- **About dialog**: 1368px of content against an 800px viewport, 1.71 screens at
  880x800. Consistent with the 3.2-screens figure at a narrower width; nothing
  new to add beyond the "(s)" in its first sentence and "3 KB of a 25.0 MB
  budget" / "Document id doc-9ce9356a", which are our vocabulary, not the
  reader's.
- **Properties panel spacing** and **the dataset grid's empty lower two thirds**:
  seen, not re-filed. Finding 12 is the long-name case, which is a different
  failure.

## What I did not reach

Import CSV / Import Excel / Export via the real file pickers (pane denies FSA),
an actual `⌘S`, the update check, password encryption, and a second live peer.
Anything depending on those is untested rather than passing.

---

## Three judgements

### What most makes this feel unfinished

**The app tells you to do things it cannot do, and does things it does not tell
you about.** It is one fault with two faces and it is everywhere:

- the dashboard prints "Click a bar … to filter every tile" over bars that
  swallow the click
- the story's primary button says "Capture current view" and stores a sheet id
- the presentation's answer to that is "This step has no chart binding"
- the ＋ menu starts to explain Dataset vs Spreadsheet and is cut off mid-phrase
- "Start live session" opens a network room and reports nothing
- Undo changes the story and the story panel does not move
- "Open as a spreadsheet" makes a copy

Individually these are small. Together they teach the reader not to trust what
the interface says, and that is the specific feeling the owner is naming. Nothing
here is a hard bug; every one is a promise the app breaks in the first ten
minutes.

### Which surface is furthest from releasable

**Story — and nobody has touched it.** It is the only surface where the failure
is visible to an *audience* rather than an author. Its editor does not re-render
on document change, so it disagrees with the file it edits and with its own
presenter. Its capture stores almost nothing. Its presentation is a black screen
with one 14px grey line of internal jargon, prev and next 1236px apart, arrows
that never disable, and a ⏸ that means "reduced motion". A user who follows the
app's own onboarding sentence lands in that room.

3D is a close second and worse in one respect — it has no axes, ticks, legend or
hover, so it cannot be read at all — but it is at least honest about being a
picture. Story is the one that will be shown to someone else.

### What I would cut

**3D, and the story presenter.**

- **3D** costs `viz3d.ts` (~1,050 lines), a WebGL path, a fourth kind cycler and
  a toolbar slot at a width where every label has already been sacrificed — and
  it produces a plot with no axis labels that contradicts the dashboard beside
  it. It is the only feature here with no spreadsheet precedent and no reader
  asking for it. Cutting it frees the toolbar rung that finding 10 needs, and
  shortens the ladder that is currently hiding Chart and Pivot at 1280.
- **The story *presenter*** (not stories). Keep "capture a view" as saved views
  in the sheet — that is a genuinely useful, cheap, testable thing and the model
  already stores it. Drop the full-screen overlay, the dots, the motion toggle
  and the black stage. Presenting is slides' job, and dash presenting badly is
  worse for the suite than dash not presenting.

Everything else on this list is a day's work or less. The two above are weeks,
and they are the two weakest surfaces in the product.
