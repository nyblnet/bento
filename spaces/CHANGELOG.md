# Changelog

All notable changes to **bento/spaces**. The app version is baked into every
shell as `APP_VERSION` (from `spaces/package.json`) and shown in the About
dialog; a shipped file updates itself through the signed release channel.

This file is per-app on purpose. The notes ride inside the **signed** update
manifest and are what someone reads while deciding whether to rewrite their
file — so an app must never describe another app's changes.

The format (`bento/spaces`, version `1`) is additive and stable — every version
below opens files from every earlier version, and unknown fields are preserved.
Versions follow `0.MINOR.PATCH` while pre-1.0.

## [Unreleased]

- **The table sorts and edits again.** A rebase duplicated the whole
  `layout === 'table'` branch in the renderer. Both copies compiled, and the
  first one returned — so the second, the one carrying click-to-sort headers
  and edit-in-place cells, was unreachable from the moment covers and the
  gallery landed. The table still drew, so nothing looked broken; it was
  simply read-only and unsortable. Measured in the built shell before the fix:
  0 header buttons, 0 cell buttons, no sort attribute anywhere. After: 2 and 6,
  and clicking a column header actually reorders the rows.
- **`#tag` in the prose, and everything that follows from it.** Type `#recipe`
  in a sentence and it renders as a clickable chip; the chip opens a tag sheet
  listing every page carrying it. Tags reach ⌘K (a query starting with `#`
  lists tags and how much of the space each covers), a view's **source** (a
  base can be "everything tagged #recipe", chosen from the Pages · button),
  and the graph (two pages sharing a tag draw an edge, capped at eight pages
  per tag — past that a tag is a category, not a relationship).

  **A tag is stored exactly once, in the words.** There is no `page.tags`
  array and there must not be one: the index is derived from `html` every time
  something asks, the same way backlinks already are, so it can never disagree
  with what is written. The consequence worth having is that this costs the
  FILE nothing — measured against a build of the previous release, a tagged
  paragraph renders there as ordinary prose, byte-identical, with no chip and
  no lost text.

  `#project/bento` is one **nested** tag, and it counts under `#project` too —
  settled now rather than later, because reading it as the flat tag `project`
  first would silently change the meaning of text already in files when
  nesting arrived. The tag sheet walks up and down that hierarchy.

  What is deliberately NOT a tag, each one tested by running the parser:
  `# Title` (a Markdown heading — a tag has no space after the hash), `#42`
  and `#404` (issue numbers), `#fff` and `#f7a600` (CSS colours), `C#` and
  `a#b` (a hash inside a word), a `#` in `<code>`, a URL fragment such as
  `https://x.example/p#top`, and this app's own `#p/` page links.

- **A view whose source this build cannot read now says so.** `unknownSourceKeys`
  existed and nothing called it, so a view selecting its pages in a way the
  build does not understand silently fell back to the backlog and showed a
  different set of pages while its header still named the source. It shows a
  line now, the way an unreadable filter already did. Known limitation, stated
  because it cannot be fixed retroactively: builds shipped before this one
  still degrade silently, so a view sourced on a tag reads as Issues there.
- **A timeline and a workload chart, as view layouts.** The one layout control
  cycles through two more shapes. `gantt` draws a bar per page from its start
  date to its due date, with today marked and overdue work outlined; `workload`
  adds up the estimates per assignee and draws a bar chart. Both read the view's
  existing `source`, `filter`, `sort` and `groupBy`, so "the workload for this
  project, open only" is expressible with no key of its own.

  **They are layouts and not a new `chart` block**, and that choice is argued in
  `spaces/src/gantt.ts` because every chart this app grows will inherit it. The
  measurable half: a shell built from the previous release, shown a view block
  with `layout:"gantt"`, renders a BOARD of the same pages, keeps the key
  through a save, and keeps the new `start` values too — checked against a real
  build, not asserted. A `chart` block would have fallen to the unknown-type
  path and drawn one line of text where a schedule was.

- **A `start` date field.** The tracker shipped with `Due` and nothing else,
  which is enough for a deadline and not for a bar. It is optional and appears
  when set, like `Due` and `Labels` — but it has a consequence worth stating:
  every issue in every file already written has a due date and NO start, so
  absent-start is the whole installed base rather than an edge case. Those draw
  as a **milestone diamond** at the due date — a date with no duration, which is
  what the file actually says — not as a zero-width bar.

- **What the pictures refuse to do quietly.** A chart is a picture of numbers
  out of a file somebody mailed you, so each wrong-data case is decided and
  asserted rather than left to arithmetic: a due date before the start is drawn
  between the two dates that are really there and FLAGGED, never silently
  swapped; a malformed date is an absent date; a negative or non-numeric
  estimate is excluded from the sum and counted, because a −3 absorbed into a
  bar makes somebody look lighter than the work they hold; and a 10,000-page
  view draws a capped, ordered chart that says how many it did not draw. Every
  date is compared as an integer day number computed arithmetically, with no
  `Date` involved, so the answer is the same in Kiritimati and in Niue.

  Both charts print, and both survive into the file-manager thumbnail: colour
  and geometry travel as presentation attributes inside the SVG rather than in
  `styles.css`, which the still's own stylesheet is not.

- **The whole gallery card is the target, and a long title stops inflating its
  row.** In a shelf of covers the picture is what you point at, so the title's
  link now stretches over the card rather than the card holding a second one —
  one link, one accessible name. And the two-line clamp on card titles was
  written but never in effect: `.sp-gcard .sp-issue-title` loses on specificity
  to `.sp-page a.sp-issue-title`, so `display: -webkit-box` never applied and
  `-webkit-line-clamp` sat inert. Measured in the built shell: computed display
  `block` and a long title rendering four lines with nothing clipped. It clamps
  to two now.

- **A layout out of a file cannot reach `Object.prototype`.** `layout` is a free
  string in a view block, and the renderer picked the button's word out of an
  object literal by it, guarded by truthiness — but `WORD['toString']` is a
  native function, and truthy. A page hand-authored with `layout:"toString"`
  rendered its layout button as `function toString() { [native code] }`. The
  cycle was written twice, once for what a click stores and once for what the
  button says; the guard had been added to the first copy only, and its comment
  asserted the label was safe while the label came from the second. One
  `nextLayout` in `fields.ts` now, called by both.

- **Every displayed word reaches the catalogs.** The view layout button read
  English in all eight languages: it was written `t(LAYOUT_WORD[here])`, and the
  extractor sweeps LITERALS, so no catalog ever learned the strings existed —
  while the coverage figure said 100%, because it counts what it swept.
  "Board", "List" and "Show as a list" were sitting translated in the catalogs
  and being dropped. The same shape hid five of the six property-type names
  (Select, Number, Date, Person, Labels), which were in no catalog at all. Both
  now choose their words at the call site, and a rig check fails on any `t()`
  that reads a map the extractor cannot see.

- **Page covers, and a gallery to show them off.** A page can carry a picture
  across the top of it — chosen in the properties panel beside the icon, and
  the page's own icon rides up over its lower edge. A view has a fourth shape
  in the layout cycle: **Gallery**, a grid of cards showing each page's cover,
  its title and the values it carries. That is the shape that makes a reading
  list or a film log look like one rather than like a backlog.

  **A cover is never a URL.** `asset:` or `data:` only, for the same reason a
  page icon is one emoji and never an address: opening a document must not
  touch the network. A file that arrives carrying a remote cover keeps the
  field and shows no picture, and the validator says so. Covers go through the
  same pipeline an image block does — downscaled before they travel, stored
  once however many pages use them, the same question asked above 4MB.

  Additive: absent on every page written before this, and a card with no cover
  gets a tinted panel of its own carrying the page's icon.

- **A graph view.** ⋯ → *Graph* draws the space as its pages and the links
  between them: every non-archived page is a node, sized by how connected it
  is, joined by an edge for every `[[wikilink]]` and for every parent/child
  pair in the page tree. Hovering a page lights it and its neighbours and dims
  the rest; clicking one opens it. Scroll to zoom, drag to pan, drag a page to
  move it, *Fit* to reframe.

  **It is a drawing, not a new index.** `buildIndex` has always computed
  `backlinks` — target page → the blocks pointing at it — and the page tree has
  always known its parents. Nothing here is stored in the document: no layout,
  no positions, no second answer to "what links to this page". The picture is
  derived when you open it and thrown away when you close it, so it can never
  go stale and never costs a saved byte.

  **No library.** The force simulation is about eighty lines, written out
  rather than imported: this app ships as one HTML file and every byte is paid
  on every open. The whole feature costs **7.2 KB** of compressed shell.

  **The layout is computed once and is reproducible.** Starting positions come
  from a golden-angle spiral rather than `Math.random`, so the same space draws
  the same picture every time you open it. The animation is an interpolation
  from that spiral toward the settled answer, which is why the camera never
  jitters — it is framed once, against final positions. Once the reveal has
  played there is no timer and no animation frame: a graph on screen costs
  nothing until you touch it.

  **Reduced motion is honoured**, by the rule bento/slides already set: the
  localStorage preference over the OS `prefers-reduced-motion`, never the
  document. With it on there is no reveal — the settled picture is simply
  drawn.

  **Measured, on a synthetic space of 213 pages and 328 links:** 28 ms to open
  (27 ms of it layout), and 0.35 ms to repaint a frame. At 513 pages and 739
  links: 182 ms to open, still under half a millisecond a frame. Labels are
  offered most-connected-first and placed only where they do not collide, so a
  small space labels every page and a large one labels its hubs, and zooming in
  reveals more.

- **A dark interface.** About → Appearance offers *Match my system*, *Light* or
  *Dark*, follows the OS by default, and tracks it live if the OS flips while
  the file is open.

  **The theme is yours, not the file's.** It lives in this browser
  (localStorage), exactly as the interface language already does — send someone
  a space and they read it in their own theme, in their own room. Nothing about
  it is written into the document, so the same bytes come back whoever last
  looked at them.

  **Dark covers the whole window, including the page you are reading.** That is
  deliberately not what bento/slides does, where a slide keeps the background
  its author chose. A space has no such page: the toolbar, the page list and
  the column are one surface with hairlines between them, and a white reading
  column inside a dark window would be a white rectangle over most of the
  screen. The colours the document itself carries — the nine text and highlight
  colours, and the five callout tones — keep their NAMES and change their
  values with the ground, because "red" measured against white is a smudge
  against near-black. Measured: every one of them, plus body text, muted text,
  code, tables and callout labels, clears WCAG AA in both themes.

  **A picture now sits on a white card of its own, in both themes.** A
  screenshot or diagram exported with a transparent background used to be a
  shape floating in nothing; black-on-transparent artwork disappeared entirely
  on a dark ground.

  **Paper stays light**, and a file-manager thumbnail still shows the
  document's own colours: neither of those has a reader to have a preference.
- **A new space opens showing what it can actually do.** The starter space was
  written once and left, and about half of what shipped since had never appeared
  in it: no table, no clip, no link card, no comment, no calculating line, no
  daily notes, no colour, nothing about page width, exporting a page, importing
  a space, or the properties panel — and its limits page still said live
  collaboration was coming, months after it arrived.

  It is eight pages now, and each one demonstrates the thing it describes rather
  than describing it. The page about tables holds one, with a link in a cell that
  really does turn up in the linked page's backlinks. The page about pictures
  holds an embedded drawing and a clip you can press play on. The page about
  archiving *is* the archived page — out of the sidebar, found by typing ⌘K, and
  named on the limits page because sending someone the file sends them that too.
  There is a comment thread with a reply on it, waiting in the margin. The
  Journal page is where ⌘⇧J puts today.

  **The limits page says what is true now.** Live collaboration exists, so it
  explains it — including the awkward part, which is that a session is a room
  whose keys live in the file: whoever holds a copy holds the room, and rotating
  the keys is what revocation looks like when there are no accounts.

  The demonstration pages are meant to be deleted, and say so.

- **Fixed: a link in a table cell could be a link to nowhere in the backlinks.**
  A table written by hand — by an agent, or in a file somebody edited — carried
  its cells but not the readable fallback the rest of the app reads, so a link
  inside one worked when clicked and appeared in no page's "Linked from". Tables
  made in the editor were never affected. Found by writing a starter space that
  claims the feature and watching the claim fail.

- **Fixed: `validate()` asked audio clips for their pixel size.** Every
  correctly-authored audio block was told it had no intrinsic width and height —
  numbers an audio player does not have. A validator that is wrong about good
  documents is a validator agents learn to ignore.

- **A properties panel, on the right.** One place that answers "what can I
  change about this thing". The block the caret is in gets its own settings —
  a table's rows, columns and header row; a code block's language; a callout's
  tone and mark; an image's width and alt text; a clip's poster, loop, mute and
  controls; every field of a link card — and the page underneath it gets its
  icon, its width, whether it is archived, and what is actually in it. Sections
  collapse and remember whether you left them open, the way slides' panel does.

  **It starts closed, and while it is closed it costs the page nothing.** The
  column you read in is the same width with the panel there as without it —
  measured at 1280px and at 2560px, and pinned by the model rig. Open it from
  the chevron on its edge or with `]`; it remembers what you chose. On a narrow
  screen it is an overlay reached from ⋯, never a third column.

  Nothing was taken away to make room for it: the language chip on a code
  block, the mark on a callout and the tools on an image are all still there.
- **A formatting toolbar, over the text you selected.** Select any words and a
  small bar appears above them: bold, italic, underline, strikethrough, inline
  code, highlight, colour, link, and clear formatting. Before this the only
  formatting a space had was ⌘B, ⌘I and ⌘U — which you had to already know
  about — and there was no strikethrough, no inline code, no link and no
  highlight at all.

  Shortcuts come with it: ⇧⌘S strikethrough, ⌘E inline code, ⇧⌘H highlight,
  and ⌘K makes a link out of whatever is selected (with nothing selected it
  still opens search, as before). On a phone or tablet the same buttons dock to
  the bottom of the screen instead of floating over the words, where they would
  fight the selection handles and the system Copy menu. The bar never appears in
  reading view, in a read-only file, or on paper.

- **Text and background colour**, in the palette shape Notion uses: nine
  colours, each usable as the ink or as the band behind the words. Not a colour
  picker — a fixed set means the colours can be chosen to stay readable on the
  page and on a printout, and it means the file never carries a stylesheet of
  its own. Colour prints, deliberately: unlike a callout, which keeps its box
  and its name on paper, a coloured phrase has no second cue, so dropping the
  colour would silently drop the distinction the writer drew.

- **Formatting now has one spelling.** Marks are stored in a fixed nesting
  order and adjacent runs of the same mark are merged, so the same visible
  sentence is always the same bytes — which keeps diffs honest and will keep
  collaborative merges from fighting over text nobody changed. Un-formatting
  part of a formatted run now splits it correctly, which the old ⌘B could not
  do: it handed the job to the browser, whose markup this format does not
  accept.

- **Markdown export no longer drops formatting.** Underline, highlight,
  subscript, superscript and colour were exported as plain text; every mark now
  round-trips, and re-importing the exported file gives back what you had.
  Highlights use `==this==`, which Obsidian and Pandoc both read.

- **Wide screens get wide pages.** The column grows with the window instead of
  sitting at a fixed 720px, and "Use this width for every page" in the page
  menu makes your choice stick across the whole space. It is remembered for
  your screen, not written into the file — someone opening the same space on a
  laptop is unaffected.

- **Tables.** A real table block: `/` → Table, then type. Tab walks the cells
  and appends a row when it runs off the end; rows and columns are added and
  removed from the bar above the table, column widths drag, and the header row
  can be turned off. Cells hold ordinary rich text, so a cell can be bold, hold
  code, or link to another page — and a link in a cell shows up in that page's
  backlinks like any other.

  It exports as a GitHub pipe table, alignment included, and a Markdown file
  you import now becomes a table instead of being kept as text. Older builds of
  bento/spaces show the table's contents as a line of text rather than nothing
  at all, so a space with tables in it is still readable in a copy of the app
  that predates them.

  What this is NOT is a spreadsheet: no formulas, nothing that recalculates.
  That is bento/dash's job, and typed properties with saved views are already
  here as the tracker.
- **Link cards.** `/` → *Link to the web* makes a card for an address: title,
  description, site, an emoji and (if you want one) a picture, laid out like
  the page card it sits beside. Nothing is fetched — not when you make the
  card and not when someone opens the space. Other apps build this card on a
  server that reads the page's OpenGraph tags; a Bento file has no server and
  must not contact one, so the card shows what you type and the dialog says
  so. A card with empty fields is still a working link; a card with no address
  is a plain box that offers to become one. In Markdown it exports as a link,
  because that is what it is.
- **Comments.** Leave a remark on a block (Block options → Comment) or on a
  whole page (the page's ⋯ → Comment on this page), reply to it, and resolve it
  when it is settled. Markers sit in the margin beside what they are about, so
  they never move the writing; a page with something still open shows a count
  in the page list.

  A comment is workspace, not document: it is saved in the file so it travels
  with it, and it never appears in the reading view or on paper. The text is
  plain text — a comment cannot carry formatting, and cannot carry anything
  else either. Your name is the one the people panel already knows.

  Agents get the whole list in one call: `bento.comments()`, each thread saying
  whether it is about a block or a page.
- **A page leaves as its own space, and a space arrives inside another one.**
  "Export page as a space…" writes the page you choose — and, if you want, the
  pages under it — as a new .bento.html file: a whole space, not an attachment.
  It gets a new document id and none of this file's sharing keys, so it is a
  new document rather than a fork that would try to join this one's session.
  Only the images those pages use travel with them, and a link pointing at a
  page that stayed behind becomes text naming that page rather than a link to
  nowhere.

  The import does the same trip backwards: choose a .bento.html space (or drop
  it on the window) and its pages arrive under any page you pick. Ids that this
  space already uses are renamed — derived from the bytes, so the answer is the
  same everywhere — and the links inside the import follow them, so nothing
  arrives pre-broken and no link lands on a stranger page that happened to hold
  that id. Shared images are stored once. It is one ⌘Z, as the Markdown import
  is, and the imported file goes through exactly the same load contract and
  sanitizer as any other file you open.

- **A page can be as wide as it needs to be.** Column, Wide or Full width, in
  the page menu. Pages of writing keep a comfortable line; a page with a board
  on it can have the room. Boards already widened themselves — now they say so,
  and you can disagree.

- **The toolbar fits itself.** It used to fold at two fixed widths that were
  measured in English; German needs 50px more for the same buttons, and eight
  languages ship in every file. It now measures itself and steps down when it
  actually runs out of room — at any zoom level, text size or language.

- **You can see who else is here.** A coloured initial sits on the page each
  person is reading, so a shared space shows at a glance where everyone is
  working. Click somebody in the people panel to go to them.

  The button beside ⋯ tells you the truth about three different situations:
  live with others, open in another window on this computer, or not shared at
  all. Nothing leaves the file until you start a session.

- **Live collaboration.** Two tabs of the same space, or two people with the
  same file, now edit it together: changes merge per character, and the file
  you save carries the state so a copy edited on a plane rejoins as a fork
  rather than overwriting anyone.

  A space goes live only when it arrived carrying a session — a file that was
  saved or shared — or when you start one. A fresh space and a template stay
  offline, as they always have.

  When somebody else deletes the page you are reading, you surface at the page
  above it rather than being thrown back to the start. And their typing never
  says "Edited" in your window; only the unsaved dot moves, because the file on
  disk is out of date either way.

- **Fixed: Save was partly off the screen on a phone.** Measured on a 390×844
  viewport, the topbar laid out 467px wide inside 390 and the Save button's
  right edge landed at x = 426 — 36px past the edge, on the one control that
  must never be unreachable. A phone now also folds the wordmark, undo/redo and
  the other-ways-to-save caret into the ⋯ menu, which already held the six
  secondary actions, and the ＋ Insert button keeps its icon without its word.
  Nothing is removed — undo and redo are in ⋯ carrying their shortcuts and their
  disabled state, and Save a copy / Export as Markdown join them there. The same
  fold now starts at the drawer breakpoint (820px) rather than 720, because at
  768 — an iPad in portrait — the save caret still ended 27px off the screen.
  The bar fits exactly at 320, 375, 390 and 768px, and is unchanged at 1280.

- **Fixed: every block cost a whole row of chrome on a phone.** The ＋/grip
  gutter is shown rather than hovered on touch (there is no hover), but it was
  laid out IN the flow: a one-line paragraph measured 68.4px tall, 36px of it
  affordances. The gutter moves into a reserved 44px start margin, out of the
  flow, keeping the grip — whose menu already offers "Add below". A one-line
  paragraph is 32.4px now; the reading column gives up 26px of width for it.

- **Callouts.** A boxed note, tip, important, warning or caution — `/callout`,
  the Insert menu, or type `[!warning] ` on an empty line. Press ⏎ inside one
  and the next line goes in with it; an empty line and ⌫ takes you back out.
  Click the mark to change which kind it is, or to give it an emoji of your own.
  The kind is named in words as well as coloured, so it survives a
  black-and-white printout and reads correctly without colour vision, and it
  exports as a GitHub alert (`> [!WARNING]`) with its nested blocks intact — including multi-line ones, which the first version quietly broke: a nested code block left its 2nd line unquoted, which ends the blockquote and unterminates the fence.
- **Code blocks are highlighted**, in eight languages — JavaScript, TypeScript,
  Python, Shell, JSON, YAML, SQL, HTML/XML and CSS — with a plain rendering for
  everything else. No library: the whole lexer, painter and palette cost 5.4KB
  in the shell, where highlight.js alone is ~120KB. Colour is applied when the
  page is drawn and never enters the document, so a highlighted block is the
  same bytes on disk as an unhighlighted one, and reading view and print show
  exactly what the editor shows.

- **A code block says what it is, and you can change it.** Hover a block for its
  language chip; the fence takes the language with it, so ` ```py ` opens a
  Python block. A language this build cannot highlight is kept as written —
  ` ```rust ` still round-trips, still exports as ` ```rust `, and will light up
  by itself when the lexer learns it.

- **Fixed: markdown shortcuts did not fire.** A space typed at the end of a
  line is inserted by the browser as a non-breaking space, so `# `, `- `, `1. `,
  `> `, `[] ` and `--- ` never matched their triggers. All of them work now.

- **Fixed: Enter and Tab inside a code block.** Enter adds a line instead of
  splitting the block, and Tab indents by two spaces instead of re-parenting the
  block in the page tree.
- **Import the notes you already have.** Drop a folder of `.md` files onto the
  window — or pick them — and each file becomes a page, the folder tree becomes
  the page tree, and `[[wikilinks]]` between the files become real links you can
  click. An Obsidian vault arrives with its structure intact: headings, lists,
  to-dos, quotes, fenced code with its language, dividers and inline
  `**bold**` / `*italic*` / `` `code` `` / `~~strike~~` / `[links](url)`.
  Frontmatter is kept verbatim in a folded block rather than being interpreted,
  because spaces has no properties model yet and inventing one in an importer
  would settle it by accident. Include the image files in the selection and
  they are embedded; an image the browser cannot open keeps its path as text
  instead of becoming a broken picture. The whole import is one undo step, and
  pages are always ADDED — nothing already in the space is replaced.
- **A space can be authored by an agent without flying blind.** `window.bento`
  gains `validate()` — every duplicate id, dead link, unknown block type,
  un-`alt`-ed image, orphaned asset and unreachable page, each with a severity
  and a fix — plus `outline()` (the whole tree, with headings, in one call) and
  `stats()` (where the bytes went, biggest assets first). `validate()` is
  silent on a good document; that is enforced by the test rig against the space
  every new file opens with.

- **Structured edits instead of rewriting the file.** `updateBlock`,
  `removeBlocks`, `moveBlock`, `updatePage` and `removePage` join
  `insertBlocks`, each one undoable step, each refusing rather than silently
  ignoring what it cannot do. A refused edit leaves no undo entry behind.
  Everything an agent writes goes through the editor's own sanitizer first, so
  the API cannot put anything in a file that the app itself could not have
  written.

- **A board can be a list, grouped by any field, in any order.** The view's
  controls were two buttons; they are five. **Board ⇄ List** switches the shape —
  the list has always rendered, but nothing in the app could produce one, so a
  view could hold a layout you could not undo. **Group** picks the field the
  columns come from. **Sort** orders by any field, and clicking the field you
  are already sorted by reverses it; **Manual order** is always the first item,
  because a board somebody arranged by dragging must be one click from getting
  that order back. A select sorts by its declared order, never alphabetically —
  "Backlog, Todo, In progress, Done" is a direction — and an unset value sorts
  last in both directions, because a blank estimate is not the cheapest issue.
  A sorted board still accepts a dragged card; it just stops pretending you can
  choose where in the column it lands.

- **Fixed: a field exported as `status: doing`.** Every field block carries a
  readable form — "Status: In progress" — which is the whole reason the format
  degrades instead of vanishing for an older build, a thumbnailer or a grep. The
  Markdown export was the one consumer ignoring it, and published the internal
  option id to the audience with no schema to look it up in. It now exports
  **Status:** In progress.

- **Fixed: a board exported as the word "Issues".** Downloading a tracker as
  Markdown gave you the view's title in italics and nothing else. A board now
  exports its issues — grouped as the board groups them, in the board's column
  order, each one a link back to its page, carrying the same chips the card
  shows — with the same filter and sort the screen is using applied.

- **A new space opens with a tracker in it.** The starter space gains a
  **Tracker** page — a board, and five issues nested under it that explain
  themselves: open a card and you are in an ordinary page with fields along the
  top. The tracker shipped invisible last round, findable only by someone who
  already knew ⌘⇧I existed. The demo issues are meant to be deleted, and say so.

- **Fixed: the page list closed every time you clicked a page.** Following a
  link in the sidebar dismissed it — right on a phone, where the drawer covers
  the page you just asked for, and wrong on every larger screen, where it
  collapsed the column and remembered the collapse. The list stayed shut on the
  next open, and the one after that. The phone drawer still closes; nothing else
  does.

- **Fixed: `newPage` accepted things that were not titles.** It takes a string
  where the verbs beside it take an object, so `bento.newPage({ title: 'x' })`
  is the mistake a caller actually makes — and it made a page called
  `[object Object]` and reported success. It now refuses, as does `newIssue` and
  `updatePage` for the same argument.

- **Fixed: pages could disappear from the sidebar and from the Markdown
  export.** Two people dragging pages onto each other — or one hand-edited
  file — could leave a pair each nested inside the other. Neither was reachable
  from the top, so both dropped out of the sidebar and out of exported
  Markdown while still sitting in the file, with nothing to say so. They are
  listed at the top level now.

- **Fixed: deleting a block could take blocks you did not select.** "What is
  nested under this?" was answered four different ways in four places, and on a
  document where a block's parent sits *after* it, one of those answers
  returned the whole tangle — including the block itself. There is one answer
  now, and it cannot tangle: a block is nested under its parent only when that
  parent is genuinely above it on the page.

- **Lines that work things out.** End a line with `=` and it answers:
  `budget - flights =`, `20% of 340 =`, `940 km in miles =`, `today + 3 weeks =`,
  `9:30 + 45 min =`, `sum above =`. Give something a name — `budget = 2400` —
  and the lines below can use it.

  **The answer is never written into your file.** The line stores what you
  typed, and the number is worked out each time the page is drawn. Change the
  budget at the top and every line below follows. Search, export and older
  versions of the app all see the expression, which reads perfectly well on its
  own.

  Type a sum *without* the `=` and it shows you the answer first, quietly, with
  a `Tab` to keep it — so nothing appears in your notes that you did not ask
  for. A line it cannot fully work out gets nothing at all: "Meet Ana at 3"
  stays a sentence.

  `bento.calc('20% of 340')` answers the same way for an agent.

- **Daily notes.** `⌘⇧J` opens today's journal — a page per day, made the first
  time you write in it rather than one for every day you happen to open the
  file. Arrows either side of the date walk to yesterday and tomorrow, and the
  entries nest under a **Journal** page, newest first, however out of order you
  wrote them.

  An entry is an ordinary page, so it searches, links, back-links, prints and
  exports like everything else — and you can rename one to "Monday — sprint
  kickoff" without it ceasing to be that day's. The date, not the title, is
  what makes it a journal. Logseq derives the same thing from a formatted page
  title, and their tracker carries the data loss that follows when the format
  changes.

  The date is stored as `2026-08-06` and SHOWN in your own language and format —
  Japanese readers see 2026年8月6日木曜日, German readers Donnerstag, 6. August
  2026, from the same file. `bento.journal()` opens today's for an agent, and
  `bento.journal('2026-08-06')` any day's.

- **A finger can do the four things only a mouse could.** Reordering a block,
  nesting a page in the tree, moving an issue card between columns and moving a
  card on a canvas were all mouse-only: the first three are HTML5
  drag-and-drop, which never fires from a touch, and the fourth listened for
  `mousedown`. Two had a fallback (Move up / Move down in the block menu; tap a
  card's status chip) and **the page tree had none** — nesting a page was
  impossible on a phone by any route. Press and hold now starts the same drag,
  and holding a card at the edge of a board or a list scrolls it along, since at
  390px only one of six columns is on screen at a time.

  A finger that MOVES is still scrolling. Nothing is captured until the press
  has been held still, so a swipe that starts on a card scrolls the page exactly
  as it did before.

- **Pinch to zoom the graph.** One finger already panned it, but zoom was on the
  scroll wheel alone — so on a phone the one view whose whole point is a crowded
  picture could be shoved around and never scaled. Two fingers zoom about the
  point between them and pan at the same time; the second finger also ends the
  one-finger drag it interrupts, so the two gestures no longer fight.

- **A menu taller than the window has items nobody can reach.** Measured on a
  390×800 phone: Insert laid out 19 items 1000px tall, putting Table, Link to
  the web, Image and Video or audio 253px below the screen with no gesture that
  reaches them — the menu is positioned inside a fixed bar, so the page cannot
  scroll to them. ⋯ lost its last five the same way. Both scroll now, and this
  was never only a phone bug: on an 860px laptop window the last Insert item was
  off the bottom too.

- **A sideways swipe stops at the edge of what it is scrolling.** A board or a
  wide table that runs out of content handed the rest of the gesture to the
  browser, which on a phone is the back-navigation swipe. It ends where the
  board does.

- **A wide page stops giving away a third of a phone.** "Wide" is 80% of the
  window, which is a sensible proportion on a desktop and 283px on a 390px
  phone — with the block gutter's 26px that left a 257px column inside a 390px
  screen. It takes the whole width below 850px and is unchanged above it
  (measured at 1400px: 872px before and after). And the sharing button, alone
  among the toolbar's controls, was 35×29 rather than the 40×40 every other one
  gets on a touch screen.
- **Page templates, and a template for the daily note.** Open a page you would
  like to reuse, and the page's ⋯ menu offers **Save as template**. From then on
  the ＋ above the page list offers a blank page or any of your templates, and
  the new page arrives with the blocks, the icon and the width of the one you
  saved. With no templates saved the ＋ makes a blank page exactly as it always
  did — the picker only appears once there is something in it.

  The one that earns the feature is **Use for daily notes**: pick a template in
  ⋯ → Templates… and every new journal entry starts with your structure instead
  of an empty page. It is the most-used workflow in Obsidian and Logseq and it
  was the only thing a daily note here could not do.

  Write `{{date}}` anywhere in a template and each new page gets its own date
  there — `{{date:iso}}` for `2026-03-14`, `{{date:short}}` for a tight space,
  `{{date+1:iso}}` for tomorrow, plus `{{time}}` and `{{title}}`. Expanded ONCE,
  when the page is made, so what lands in the file is ordinary text an older
  build reads the same way. A journal entry gets the date it is FOR: backfilling
  Tuesday's note on Thursday writes Tuesday.

  Templates live in the document (`doc.templates`) rather than as hidden pages,
  so they never appear in search, the graph, backlinks, the sidebar or the
  Markdown export — and the flip side, stated plainly: they travel with the FILE
  and not with a page you graft into another space. Additive as ever: a file
  written before this has no templates key and opens unchanged, and turning the
  daily-note setting off deletes the key rather than storing a default. Saving
  or deleting a template is one ⌘Z.
- **A page can show another page: transclusion.** The new `embed` block draws a
  live view of another page — or of one heading's section of it, chosen by name
  — attributed to its source and clickable through to it. It stores a
  REFERENCE and never a copy, so the source page stays the single copy of the
  words and every embed of it changes when it does.

  This closes a hole in the Obsidian import that nothing reported. `markdown.ts`
  had parsed `![[Page]]` since the importer was written and carried a comment
  saying "an embed of a note is just a link to it, because there is no
  transclusion in the model" — so a vault arrived with every embed silently
  demoted to a plain link. A whole line of `![[Page]]` or `![[Page#Section]]`
  is now an embed, and exports back as itself; an `![[…]]` inside a sentence is
  still a link, because a block cannot live in the middle of one.

  What the reader is never shown is a blank box. A loop (A embeds B embeds A)
  renders as a named placeholder that says which page repeats, an embed chain
  is followed at most three pages deep, a target that has been deleted says so,
  and an `anchor` that matches no heading says THAT rather than quietly falling
  back to the whole page. `validate()` names all four (`broken-embed`,
  `embed-cycle`, `no-section`). An embed also appears in "Linked from" like a
  page link does — it is the strongest reference in the model, and the one you
  most want to be warned about before rewriting a page — and it survives being
  extracted or grafted into another space, where a target that did not travel
  becomes the same honest `[[Name]]` text a page link becomes.
- **A view can be a CALENDAR.** The fifth shape on the one layout button —
  board, list, table, gallery, calendar — and the one that answers *when*. It
  has two forms behind a second button: a month grid, and a timeline that reads
  newest first. Two forms rather than two entries in the cycle, because they are
  one question at two densities (a month grid is useless on dates spread over
  years, and a timeline cannot show you the shape of a week), and because the
  layout control is a cycle whose cost is one click for everybody every time
  they pass a shape they did not want.

  **Which date a page sits on is a rule, not a setting, and the view says the
  rule out loud**: its journal date if it is a journal entry, otherwise the
  first date field in the schema it carries a real date for. A page with neither
  is listed under "No date" — visible, because a calendar quietly holding fewer
  pages than the count beside its own title is a view lying about what it
  contains, and the pages it would drop are exactly the ones somebody forgot to
  date. A value that is digit-shaped but not a day (`2026-13-99`) is no date
  rather than a confident wrong one.

  Month names, weekday names and **which day the week starts on** all come from
  the reader's own locale, so the same file is a Sunday-first 2026年9月 in Tokyo
  and a Monday-first September 2026 in London. Nothing formatted is ever stored.
  Measured in a built shell: February 2026 draws 28 cells in four rows, August
  2026 draws 42 in six, September 35 in five — the count is derived from the
  month and the reader, never assumed.

  `layout: "calendar"` and `span: "timeline"` are additive: verified against a
  build that has never heard of either, which renders the board and round-trips
  both keys untouched. And `board`/`month` stay the ABSENT keys — a view cycled
  all the way round, span and all, is byte-identical to one nobody touched.
- **A page becomes a deck.** Save → **Export page as slides…** turns one page
  into a `bento/slides` presentation: headings start slides, lists stay lists,
  a table stays a table, a board becomes a table of the rows it stands for, and
  a canvas becomes a slide with every card where you put it. The page's title,
  icon and cover make the title slide; the space's theme becomes the deck's.
  No hosted notes app can hand you a presentation you own outright, and this
  one can, because both apps are the same repository.

  **What it hands over is the deck's document JSON**, which you paste into
  Bento Slides through its own "Replace from JSON…" — not a finished
  `.bento.html`. A self-contained deck is a document spliced into a slides
  SHELL, and the only ways for this app to have one are bundling half a
  megabyte of another app into every space or fetching it, which is the one
  thing opening a document must never do. The Markdown export sets the
  precedent: write the other format faithfully and hand it over.

  **Nothing is fetched, and nothing is dropped in silence.** Every picture
  travels as its bytes, re-interned in the deck's own asset table; anything
  that would still reach the network — including bytes hidden one `asset:`
  indirection away, the hole closed on the reading side in 0.1.x — is left out
  and said out loud. The dialog lists what did not come across before you
  download anything, and the same list is written into the deck's speaker
  notes, so a presenter opening it next week is told too. Speaker notes are
  otherwise NOT invented: mapping review comments onto them would move a remark
  addressed to a person into a file people present from.
- **A space you can hand to a reader.** "Save a reading copy…" (in the share
  popover) writes a second file that opens as a **document** rather than as an
  editor: the pages, the tree, ⌘K search and print, and none of the machinery
  for changing them. The eye toggle is the same view for the file you are
  writing in — it now takes the tools away rather than merely switching them
  off, and every page carries a Previous / Next pair so a reader can go through
  a space without hunting the sidebar.

  What the copy leaves behind is the point, and it comes in three grades:

  - **Cryptographic.** `doc.collab` is deleted outright, so the copy holds no
    room, no symmetric read key and no private signing key of any kind — owner,
    writer or invite. Whoever you send it to cannot read the room's history,
    cannot write to it, and cannot join it, because the material a socket must
    present to the relay is not in the file.
  - **Format-level.** Comment threads are gone from the bytes, page-level and
    block-level, replies included. Comments are workspace, not publication, and
    a copy that merely hid them would still be a file whose JSON block carries
    every remark anyone made about the draft.
  - **Cosmetic.** `doc.readonly` itself. It states what the file is and the app
    honours it; anyone can open the HTML and change it back. It is intent, never
    a lock, and nothing in this release presents it as one.

  `doc.readonly` was declared in the format and read by nothing until recently —
  now it opens the reader. Old builds ignore the flag and open the space
  editable, which is the correct degradation: the guarantees that matter are
  bytes that are not in the file, and those are absent whatever opens it. A
  reading copy of a password-protected space is written encrypted with the same
  password, and carries no file-manager preview — a plaintext home page beside
  the ciphertext is the leak the password exists to prevent.

  `scripts/test-spaces-reading.ts` asserts all of it on the SERIALIZED document
  rather than on "the strip function ran", the way the invite rig does.

- **A page can answer to more than one name.** "Also known as" in the page
  panel takes a comma-separated list — "NYC, the Big Apple" on a page titled
  New York — and every one of those names reaches the page from a
  `[[wikilink]]`, from ⌘K search, and from the `[[` page picker. All three, on
  purpose: an alias that links but cannot be searched means you file something
  under the name you use for it and then cannot find it by that name, which
  reads as the search being broken rather than the alias being half-built.

  The alias is resolved where a name becomes a page id, so what gets written
  into the file is an ordinary `#p/<id>` link — backlinks, the graph, export,
  print and collaboration never learn that aliases exist. `aliases` is a new,
  absent-by-default key; clearing the last one deletes it again, so a page that
  had an alias and lost it is byte-identical to one that never had one, and an
  older build round-trips the array untouched.

  Two pages can claim one name, because a file arrives already written. The
  resolver settles it the same way in every copy — a title always beats an
  alias, then document order — and `bento.validate()` reports it as
  `alias-collision`, naming which page a `[[link]]` will actually reach. It is
  the one place this app tells you about a clash it resolved on your behalf.

- **Unlinked mentions: "this page is named in six others you never linked."**
  Under the backlinks, every place this page's title or aliases appear as plain
  words somewhere else, each with the sentence it appears in and a button that
  turns those exact words into a link.

  Most of the work is in what it refuses to find. A title inside a code block
  or a code span, inside a link you already made, inside a URL or a mail
  address, or in the middle of a longer word is not a mention; nor is a block
  that already links here; nor is the page's own text. Names shorter than three
  characters are not scanned for at all, because a page called "It" mentions
  everything.

  **CJK was designed for, not discovered.** A word-boundary rule built for
  English does not degrade in Japanese, it returns exactly zero — every kana
  beside a name is a letter, so the boundary never opens. So a boundary is
  required only where the name's own edge is a word character in a script that
  separates words, and two Han characters count as a whole name where three
  Latin ones are the floor. 私は東京に住んでいます mentions 東京. The cost of
  that rule, stated because it is real: a Han name also matches inside a longer
  Han compound.

  And it is not the quadratic thing it sounds like. Reading a page scans the
  document ONCE for that page's names, so the cost is the size of the space and
  not the number of pages in it: measured on a synthetic 1000-page, 2.5MB
  space, 6.5ms per page open, against 1.9ms for the backlink index the app
  already built. A 100-page space is 1.3ms.
- **A view's filter can ask a real question.** It had two things to say — "show
  me what is open" and "show me these values" — under five layouts that exist to
  hold books, tasks and dates. "Published after 2020", "due this week", "not
  tagged draft", "title contains onboarding" and "has no due date" were all
  unaskable. A view now carries **conditions**: a field, an operator and a
  value, built in the Filter popover and listed there in words.

  Eleven operators, chosen per field type rather than collected. Numbers and
  dates get `is more than` / `is at least` / `is less than` / `is at most`, and
  two of them AND into a range. Dates also get relative windows — Today, This
  week, This month, In the past (which is what "overdue" is), In the future —
  resolved against **your own day in your own timezone**, and against your own
  locale's week: the same file answers "this week" as Monday–Sunday in Berlin
  and Sunday–Saturday in Chicago, because a week start is a reader's fact and
  not a document's. Text gets `contains` / `does not contain`, matching what is
  on the screen rather than what is stored underneath, so a status matches its
  label. Everything gets `is` / `is not` and `is empty` / `is not empty` — the
  question membership could never ask, because an unset value is the absence of
  a value rather than one of its values. A condition can also ask about the page
  **title**, which is not a property and no field name could reach.

  Conditions are a flat list with one switch — **Match all** or **Match any** —
  and no nesting, deliberately: a filter you cannot read at a glance is worse
  than one that cannot ask everything, and the popover is a sheet on a phone.
  The Filter chip counts them alongside the old two.

  Nothing written before this changes. Every existing filter runs through
  exactly the code it always did and selects exactly the rows it always did, and
  a view whose conditions are all removed goes back to being byte-identical to
  one nobody ever filtered. An **older build** opening a file with conditions
  ignores them, shows a superset of the rows, and says so in the banner it
  already had for a newer sort — and a **newer** operator meeting this build
  does the same rather than hiding rows for a rule nobody can see.
- **Footnotes.** A mark in the prose, the note at the foot of the page — write
  `[^1]` where the mark goes and the note appears as a numbered slot below the
  page to write into. Notes print, export as `[^1]: the note.` and import back
  the same way, so an Obsidian or Pandoc vault keeps its footnotes in both
  directions rather than losing them silently on the way in.

  **The number is never stored.** Footnotes are numbered by order of appearance
  and the number is worked out when the page is drawn, the way a magic note's
  answer and a slide's page number are: put a new reference above two existing
  ones and they renumber to 2 and 3 with nothing in the file changing. Measured
  in the built shell — `[^1]` renders as "2" while `block.html` still says
  `[^1]`. A stored number would have been wrong from the first sentence anyone
  moved, and nothing would have said so.

  **The reference is text, not markup**, which is the whole reason it survives
  editing: `[^1]` moves with the prose through a keystroke, a sanitize pass, a
  canonicalisation and a merge exactly the way the word beside it does, because
  there is no offset to keep in step and no attribute for the allowlist to have
  an opinion about. It also means a build that predates this shows the sentence
  with `[^1]` in it and hands the `footnotes` key back untouched — verified by
  loading a footnoted document into a shell built from the previous release.

  A reference whose note has been deleted still renders, numbered, into an
  empty note; a note whose reference has gone is kept, never quietly dropped.
  `bento.validate()` reports both (`dangling-footnote`, `orphan-footnote`) and
  names the block. Costs 3,176 bytes on the shell.
- **Version history inside the file.** Every save records what changed, in the
  document itself, under `doc.revisions` — so the history travels with the
  file. Mail the space and the recipient has it; open it on a phone and it is
  there; open it in six months on a different machine and it is still there.
  Until now the timeline lived in one browser's IndexedDB, which meant a space
  that left this computer left its past behind. That browser-local timeline is
  unchanged and still listed beside this one; what is new is the half that
  survives being sent.

  **Restore is exact.** Restoring a version reproduces the space's content —
  title, home page, theme and every page — byte for byte as it was when that
  version was saved, verified on the serialized document rather than on a count
  of blocks. It is an ordinary edit: `⌘Z` walks it back, the file stays the
  same document, and the timeline is not rewound with it.

  **Changes, in words.** Beside every version, a **Changes** view showing what
  moved — pages added, deleted and renamed, and inside each page the words that
  went and the words that arrived. Word granularity, not lines and not
  characters: a line diff calls a reflowed paragraph wholly rewritten, and a
  character diff marks "30" → "60" as one glyph nobody can see.

  **It is bounded, because this file gets emailed.** A revision stores only what
  changed since the one before it, at page and block granularity, so an ordinary
  save costs a few hundred bytes rather than a copy of the space — measured on
  the starter space, 269 bytes per save against 37 KB for a whole snapshot.
  History is capped at 128 KB and sixty entries; past either, the oldest entries
  are folded together, so the distant past gets coarser while this afternoon
  keeps every save, and every version that remains still restores exactly what
  it did before. A space too large to carry even one revision keeps none and
  says so, rather than half-keeping a history it cannot honour.

  **Encrypted spaces get history too** — the first place they have ever had any.
  `revisions` is a field of the document, so it is inside the `bento/enc`
  envelope, encrypted by the same pass over the same JSON as the pages it
  describes. Nothing is written in the clear beside the ciphertext.

  **And it is said out loud that history remembers what you deleted.** A page you
  removed is still in the file, in the version that last held it, which is true
  of every version history ever built and matters more when the document is
  something you send. The dialog says so and offers **Clear history**; a page
  extracted as its own space carries none of the parent's.
- **The starter space demonstrates the twelve features above.** `starter.ts`
  states its own rule — a feature the starter does not demonstrate is a feature
  the starter denies — and none of the twelve had been walked back through it,
  so the first document every new user opened quietly said the app could not do
  any of them. Two pages are new: **Planning** (a calendar of what has a date,
  an overdue table, and a filtered list — three views asking three real
  questions) and **Handing it over** (reading it, sending a reading copy,
  exporting it as slides, printing it). The rest arrive inside pages that
  already existed, because a page titled "Footnotes" explaining footnotes is
  the failure this file is written against.

  Every claim is carried by document data rather than by prose about it:
  Welcome transcludes the **Saving** section of Sharing & limits instead of
  repeating it; the tracker's cards gained due dates, estimates and a project,
  so the calendar has days to sit on and the filters have something to exclude;
  the tracker answers to *the board* and the journal to *daily notes*, so both
  pages list real unlinked mentions of themselves; the space ships a **Daily
  note** template wired to ⌘⇧J and a **Meeting** template, which is also what
  makes the sidebar's ＋ offer a choice at all. Verified in a built shell, not
  asserted: the overdue view holds 3 of 5 cards, the tag view 2 pages, clicking
  a column header reorders the rows, ⌘⇧J produces the template's three
  headings, and *Handing it over* exports as six slides.

  **Two notes that are workarounds, not preferences.** The starter keeps
  footnotes out of any section it also transcludes — a reference inside an
  embedded body draws its number on the host page while the note stays on the
  source page, so the marker points at an anchor that is not there. And the
  page that describes tags cannot yet show a tag *chip*, for a reason recorded
  against the tag work rather than here.
- **Fixed: `Reset access…` was still called `Rotate keys` in the starter.** The
  control was renamed and the one document every user reads was not, so the
  starter named a button that does not exist.
- **The arrow keys move between blocks, and within one first.** Every block is
  its own `contenteditable` host, which is what keeps a Selection block-scoped
  so splitting and merging can never re-mint an id — and the price, until now,
  was that the browser's own caret movement stopped dead at a block boundary.
  ↑ and ↓ did nothing at all; ← and → did nothing at the edges. There was no
  arrow handling in the editor whatsoever.

  ↓ from the first line of a wrapped paragraph means its second line, not the
  next block, so the question asked is not "which block is this" but "is the
  caret on the edge VISUAL line of its host" — measured off the caret's own
  rectangle against the host's line boxes, never counted in characters, because
  where a line wraps depends on the font, the width, the language and the marks.
  The goal column is kept across consecutive vertical steps, so down onto a
  short line and down again comes back out near the original x, and a pointer
  ends the run. ← at the start of a block goes to the end of the one before and
  → at the end to the start of the next. It crosses callouts, toggles and canvas
  cards for free — they render in document order — and a table is stepped by its
  GRID, because cells are row-major in the DOM and column-major on the screen;
  entering one from above or below lands in the column the goal column is over,
  not in the first cell. The table's own ⇥ and ⏎ are untouched.

- **Tab on a block with nothing above it now says so.** A space expresses
  nesting with one field — `Block.parent`, pointing at a preceding sibling — so
  the first block at its level has nothing to nest under. `indent()` walked
  backwards looking for one, found none, and returned in silence: no indent, no
  feedback, no explanation, which reads as a broken app rather than as a gesture
  that does not apply. It refuses out loud now, in the status line and with a
  nudge on the block itself, and the indent control shows the reason before the
  key is pressed.

  The alternative was to allow it by storing an indent LEVEL, the way Google
  Docs does. That is a permanent format addition and a SECOND way to express
  nesting, which the renderer, the markdown export, the outline, the graph and
  the CRDT would each have to reconcile forever; a silent Tab is worth an
  afternoon and a duplicate nesting model is worth every future version. Notion,
  Workflowy, Bear and Logseq all refuse the same case, because they all nest by
  parenthood too. Nothing about the format changed. ⇧Tab still outdents — and
  now explains itself when there is nothing to outdent from — and Tab still
  commits a showing calc answer before it considers indenting at all.

- **Bullets, numbers, to-dos, quotes, headings, indent and outdent have a
  control.** There were none: the formatting bar is inline-only and appears on a
  SELECTION, which is the wrong trigger for "make this a bullet" — you want that
  with a caret and nothing selected. So the block's own format is a row at the
  top of the block menu, the one the gutter grip opens and the one that is
  already a bottom sheet on a phone. Indent and outdent existed on no surface at
  all before this, at any width: ⇥ and ⇧⇥ were their only gesture, and a phone
  keyboard has neither. ⌘/ opens the menu from the keyboard, since the gutter is
  hover-revealed and ⇥ inside a block is indent.
- **Progress charts — burndown, burnup and cumulative flow — over a record the
  file keeps of itself.** A tracker could always tell you what is open today and
  never what was open last Tuesday, because the only artefact that ever knew was
  gone. A space now writes one small row a day (`doc.trail`): how many issues
  sat in each status, and their summed estimates. Counts only — no page ids, no
  assignee breakdown, no per-issue anything, on purpose and permanently. A
  `chart` block draws it against a `doc.periods` window you name ("Sprint 12,
  1–20 Sept"), with the scope frozen as it was when you started the period, so
  editing a view next month cannot redefine last month's sprint.

  **Days nobody worked are drawn as gaps, not as zeroes.** The line breaks, the
  region is hatched, and the legend says "not recorded" — because a carried-
  forward value looks exactly like data, and an interpolated weekend shows work
  happening on Sunday. A day with nothing open is still a point at zero, and the
  two look different. When the record gets long the distant past is thinned to
  one reading a week; those points join with a DASHED line, so a weekly sample
  is never mistaken for a daily one, and thinning always keeps a row somebody
  actually observed rather than averaging two into a number nobody ever saw.

  **Today's point is computed live, every earlier day is read from the record.**
  Change an estimate now and the chart moves now; yesterday's row stands
  whatever you do to the document today.

  Nothing turns itself on: a space with no issues writes no rows, and a space
  that recorded and then cleared is byte-identical to one that never did. The
  record never outweighs what it is a record of — trail and version history
  share one ceiling, a quarter of the document's own content between 64 KB and
  256 KB, and it thins rather than failing. It is stripped from reading copies
  and page extracts: the aggregate counts are dull, but the pattern of which
  days a file was touched is not, and that should not travel to a client by
  accident.

- **A reading copy really does strip the working record now.** The line above,
  and `docs/spaces-agents.md`, and `trail.ts`'s own header have all said since
  the trail landed that a reading copy carries none of it. It carried all of
  it: `stripRecord` had exactly ONE call site, in the page-extract path, and
  `readingCopy` never called it. So every reading copy ever written went out
  with `doc.trail` and `doc.periods` intact — not the pages, not the comments,
  not the keys, but the cadence. Which days the file was worked on, which weeks
  nothing moved, who was editing on a Sunday. Fixed, and the reading rig now
  asserts it by scanning the whole serialized copy for a canary day and a
  period label, the way it already scans for key material. Both assertions were
  watched to FAIL against the unfixed function before being believed.

  Found by writing a starter page that tells the reader to go and check the
  claim. That is the argument for falsifiable documentation in one line: the
  sentence could not be written without somebody looking.

- **The starter space demonstrates the project-management work.** A feature the
  starter does not demonstrate is a feature the starter denies, and five had
  arrived since it was last written. It gains a page — **How it is going** —
  and extends four others.

  - **Planning** now carries a **Gantt** and a **workload chart**, because both
    are live views of the same pages the rest of that page is about. The five
    demo cards gained `start` dates and two assignees to give them something to
    draw: three bars, one **milestone diamond** (a card with a due date and no
    start — which is not an edge case, it is every issue in every file written
    before `start` existed) and one card with neither date, which is not drawn
    and is counted underneath instead.
  - **How it is going** carries the three trail charts. Two are drawn from a
    **labelled, invented fortnight** and the third has no period at all and is
    the one you start yourself.
  - **Writing** gains a six-line list that is FLAT AND SHOULD NOT BE, and the
    **Inbox** gains two paragraphs sitting among its to-dos. Both are wrong on
    purpose: the block bar (⌘/), indent, and the change-this-block-type row are
    chrome with no document surface, so rather than a paragraph telling you to
    press a key, the page is unfinished in a way only that control finishes. A
    reader ends up having USED the gesture. The first line of the Inbox is
    where Tab's refusal is met, because the only block that refuses is the
    first one on a page.
  - The tracker said the view button "steps through the five shapes". There are
    seven.

  **THE STARTER SHIPS A SEEDED `doc.trail`, AND IT IS QUARANTINED AND
  LABELLED.** This was the hard call and the reasoning is written out at the
  site in `starter.ts`, because the numbers alone read like a convenience.
  Against: the trail stores observations, and the app refuses to fabricate past
  days even for the reader who asks it to. For: a starter period is a fixed
  window in the past, so an unseeded chart draws NOTHING in every copy forever
  — and everything these charts are clever about (a gap drawn as a gap rather
  than a zero, a thinned sample, the recording-starts-here edge, scope that
  grew mid-sprint, stacked bands) exists only over a real span. So both: ten
  rows under their own series id `sample/…`, which `recordTrail` never writes
  to and so can never mix with what the file records about you; a period
  labelled "Sample sprint (invented numbers)", which is the string every chart
  header prints; and a fourth chart with no period, whose **Choose a period…**
  button takes a real baseline from the board and writes today's real row.

  **What it costs, measured:** 1,222 B of document JSON in every saved file
  (1,052 B of trail across 10 rows — 105 B/row — plus 170 B of period), which
  is 1.7% of the 70,964 B starter document, and 492 B in the compressed shell.
  The whole content change is 5,204 B of shell (373,257 → 378,461 B).

  **One loss, said out loud:** `clearTrail()` exists and has no UI wired to it,
  so a reader who wants the sample rows gone has no button. That is the
  strongest argument for the other answer and it is filed, not hidden.

## [0.1.0] — 2026-08-03

First release.

- **A space is one file: a tree of pages, in HTML you can mail.** Pages nest,
  the sidebar is the tree, and everything — text, images, structure, the editor
  itself — is in the single file you saved. No account, no server, no folder of
  attachments that goes missing when you forward it.

- **Writing that gets out of the way.** Markdown as you type — `# `, `- `,
  `1. `, `> `, `[] ` and `**bold**` each become the thing they describe — a `/`
  menu at the caret for every block type, a grip to drag blocks and pages into
  a new order, and `[[` to link a page by name, which offers to create that
  page if it does not exist yet.

- **Links go both ways.** Link to a page and that page lists who linked to it.
  Nothing to maintain: backlinks are derived, so a space stays navigable
  without anyone curating an index.

- **Find anything, and change it everywhere.** ⌘K jumps to any page or block
  by content; ⌘F finds and replaces across the whole space, not just the page
  you are looking at.

- **Images that do not make the file unmailable.** A phone photo is downscaled
  to fit the column before it is embedded, and the space says so — with the
  original one click away. Identical images are stored once. Measured: a 4.9 MB
  photograph embeds as 33 KB.

- **Reading view.** Hide the editing surface and read — or hand the file to
  someone else, who sees the same thing. Printing and PDF export follow the
  same rules: toggles print open, archived pages are excluded.

- **Nine languages.** English, Deutsch, Español, Français, Italiano,
  Português, 日本語, 中文 (简体 / 繁體). The interface follows the reader, not
  the document, so one file reads in each person's own language.

- **Archive rather than delete.** An archived page leaves the sidebar and the
  search results but stays in the file, restorable, because the file is the
  only copy there is.

- **A space does not phone home when you open it.** If a document references
  an image on the web, it is not fetched until you ask — the placeholder names
  the site first. Opening a file someone mailed you should not tell a third
  party that you read it, and nothing else in a space touches the network.

- **Password protection, autosave and recovery, signed self-update** —
  the platform guarantees, on the same terms as bento/slides.
