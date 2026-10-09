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

- **A page with no cover gets a procedural one — on the home page and on every
  gallery card, and nowhere else.** A gradient plus a geometric figure (orbs,
  bands, a dot lattice, rings, facets or waves), seeded from the page id, drawn
  at render time and never written into the file: `cover` absent stays absent,
  an older build sees no cover exactly as before, and a saved space does not
  grow by a byte. The same id draws the same cover on every machine and every
  reload; a page that gains a real cover shows that and nothing else, and a
  page whose cover is removed gets its procedural one back. The gallery already
  tinted its coverless cards on a hue from the id — this is that tint with a
  figure on it, in the same two hues at the same alphas, over the theme's own
  ground, so one SVG is right in light and in dark.

  Home page and gallery only, on purpose. A cover is a full-bleed band that
  pushes the title down and lifts the icon into a disc; on a space of two
  hundred plain notes that is two hundred posters, and a journal entry under a
  banner is wrong however restrained the artwork. The two surfaces chosen are
  the two that already single a page out. Never on paper (5cm of toner for a
  figure nobody chose) and never in the file-manager thumbnail (a still of the
  author's document, and this is not in it).

  Measured with real pixels, the SVG rasterised over the theme ground, across
  400 ids covering all eight hues and all six figures: the card's letter-mark
  keeps at least 4.29:1 in light and 3.28:1 in dark (34px bold; the figure
  costs about a point against the plain tint, which sat at 6.55 and 4.13);
  the icon on the home page's disc reads at 9.94:1 light / 9.30:1 dark. The
  disc's EDGE against the cover is 1.33–2.31:1 in light and 1.91–3.53:1 in
  dark — the disc is white-on-a-wash by design, as it is over a pale
  photograph, and its shadow carries the boundary; the glyph is what has to
  read. Shell +1,412 B.
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
- **Callouts, quotes and captions survive a trip through Markdown.** Four
  places where the exporter and the importer disagreed with each other, each
  measured by exporting one block and reading it back:
  - A **GitHub alert** — `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`,
    `[!CAUTION]` — now imports as a callout of that tone, with everything in
    the box (lists, code, a nested alert) as its body. The export already
    wrote alerts; the importer read them back as a plain quote with `[!WARNING]`
    as its first words. Alerts written by GitHub or Obsidian read the same way,
    including Obsidian's lower-case tags, fold markers and text on the tag
    line. Other tags (`[!info]`) stay a quote, word for word.
  - A **quote with a line break** exported its second line without `> `, so a
    blank line inside it came back as a quote followed by a loose paragraph.
    Every line is marked now.
  - An **image caption** leaves as the Markdown title, `![alt](src "caption")`.
    The importer already read that title as the caption; the exporter was
    dropping it. An image's size still does not survive — Markdown has no
    place for it.
  - A **divider** comes back as the same block the editor made.

  `scripts/test-spaces-md-strict.ts` holds every block type to this bar: 13 of
  the 20 now come back byte for byte (9 did before), and the other 7 — toggle,
  link card, media, field, board, page link, canvas — are pinned with the
  reason, so the rig fails if one starts to qualify without the pin being
  lifted on purpose.
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
- **A saved copy of a shared space rejoins its live session with its offline
  edits.** ⌘S, Save a copy and both self-update writes now stamp the live
  session's sync state into the file (`collab.sync`), as bento/slides always
  has. Before, a copy edited away from the session reopened as if it had never
  synced: its edits stayed in that copy and never reached anyone else, and an
  edit to a paragraph somebody had also changed was overwritten by theirs.
  Measured in two Chrome tabs: edit in one, save, edit the saved file offline,
  edit in the other tab meanwhile, reopen — the old build ends with the two
  tabs disagreeing; this one shows both edits in both tabs. View-only copies,
  page extracts, Markdown and JSON exports, and "Duplicate as a new space…"
  carry no sync state, and a file opened read-only is never re-stamped.
- **⌘Z no longer undoes who a space is.** Undo restores a snapshot of the
  whole document, and it used to bring that snapshot's identity back with the
  content: edit something, then Stop sharing, and the next ⌘Z switched sharing
  back on, silently rejoining the room you had just left. A key rotation could
  be undone into the revoked key the same way, and a new docId or a read-only
  mode reverted to whatever the snapshot held. Undo and redo now move content
  only. The docId, the live-session credentials and the read-only and template
  modes always stay as they are in the open space. Restoring a version, the
  recovery banner, Replace from JSON and `bento.loadDoc` follow the same rule:
  they replace the pages, title and theme, and never the space's identity.
  Bento Slides had the same bug.
- **A copy that cannot write never gets writer chrome.** Whether a copy may
  write was decided by `collab.role !== 'reader'`, so the live-show
  `'audience'` role — and any role added later — passed as a writer: an
  audience copy opened editable, was labelled Editor in People, and made local
  commits the relay then refused. It is an allowlist now (`copyCanWrite` in
  `share.ts`, the same shape as bento/type's): no role field or `'writer'`
  writes, anything else opens view-only. Every gate — the boot lock, the Share
  popover, the People label — asks that one function. Plain files and legacy
  rooms open exactly as before.
- **Fixed: an edit made while the file was being written could be marked saved.**
  Saving takes a moment — the file is reconnected, the space is written out,
  the disk answers — and a word typed in that moment went into the space after
  the file's copy had already been taken. When the write finished, the unsaved
  dot went out anyway, so the file was missing the edit and nothing said so.
  Now each save writes the space exactly as it was when that save began, and
  the dot goes out only if nothing has changed since. Anything newer — your own
  typing, a colleague's edit arriving live, an undo — keeps the dot on and goes
  into the next save. Two saves in quick succession wait for each other instead
  of writing the file at the same time, and so does "Update this file" in
  About. A save that fails now says so ("Save failed — see console") instead of
  leaving "Saving…" on screen, and the space stays unsaved.

- **Restoring from this browser checks what it restores.** The recovery
  banner's snapshot and every History entry are kept in the browser's storage,
  which every local Bento file shares, so they are now treated like a file
  that arrived from somewhere else, as Bento Slides already treats them. An
  entry that names a different space, is not a bento/spaces document, was
  written by a newer version, or is oversized is not restored: nothing
  changes, and the entry is left where it is. Text in a restored entry is
  cleaned the way an imported space's is. A bad entry never raises the
  recovery banner in the first place. Reading copies and view-only copies
  don't offer to restore at all.

- **Every menu is the suite's menu now, and it behaves like one.** Insert, ⋯,
  the save caret, the block and page ⋯ menus, a board's group, sort, filter and
  source menus, a field's options, a code block's language and a callout's tone
  are all built on the kernel's shared menu. You can walk every one of them with
  the arrow keys and close it with Escape, and focus goes back to the button
  that opened it. Opening one menu closes any other. Four things this fixes,
  each measured in the built file:
  - A menu closed with Escape left its click-away listener behind, and that
    listener closed the NEXT thing you opened on your first click inside it:
    Escape a block menu, press ⌘K, click in the search box, and the search
    vanished.
  - On a phone the ⋯ menu was 950px tall on an 844px screen. Its last three
    rows, which are the only ways to save a copy or export on a phone, could
    not be reached. It now ends inside the screen and scrolls.
  - The Insert menu's last row ran off the bottom of a 1440×900 window. Insert
    is one line per row now, with the Markdown shortcut (`#`, `1.`, `>`) on the
    right. The descriptions stay on the `/` menu, where you learn them.
  - With About or the shortcut sheet open, `[` collapsed the page list behind
    it and `?` opened a second sheet on top. Nothing reaches the page under an
    open dialog now.

  On a phone, every anchored menu is a sheet at the bottom of the screen,
  including the page ⋯ menu, which used to be a small popup over the drawer.
  Rows are 44px tall under a finger. Shortcuts are right-aligned and written
  in one order, ⌃⌥⇧⌘ (⌥⌘N, not ⌘⌥N). They are hidden where there is no
  keyboard. Only menus whose rows have consequences keep a second line saying
  what each row does (save a copy, archive, delete, page width). The overflow
  button is ⋯, not ⋮, as in slides. A search, import or export dialog now
  closes with Escape wherever the focus is, not only while it is inside the
  card. The graph view puts focus in its card, not on the dimmed page behind it.

- **Every dialog and both side panels are the suite's.** About, the keyboard
  shortcuts, Search, Link to page, Link card, Import, the import reports,
  Export page as a space, Print and the graph now use the kernel's dialog. Each
  one keeps the keyboard inside it: Tab used to leave the import dialog on 23
  presses out of 25. Escape closes any of them wherever the focus is. Each opens
  on a real title (17px, D4) rather than a small grey caption, with the
  corner, shadow and scrim slides uses.
  - The shortcut sheet no longer draws a blue ring around itself when it opens.
    Its shortcuts are written in one order, ⌃⌥⇧⌘.
  - In Search and in Link to page, the arrow keys move through the results while
    you keep typing, and Enter opens the highlighted one. Before, a result could
    only be reached with Tab.

  The page list and the properties panel are the kernel's side panel. You drag
  the edge to resize, double-click it to reset, and use the chevron to close or
  open. Below 820px each panel is a drawer over the page. Your widths and
  open/closed choices are kept exactly as before, under the same keys. Opening
  and closing the drawer on a phone never changes what a desktop remembers.

- **The phone bar, the dialogs' buttons, and messages you must not miss.**
  - **Phone targets.** Every control in the phone bar is a 44px target now.
    Five of them were 40px and the Live button was 35×29. Page rows and their
    ⋯ are 44px too; they were 28px and 20×20.
  - **Save on a phone** is a square icon button. It used to be a 66×40 dark
    slab with the icon at one end. The unsaved dot is a badge on its corner.
  - **The Live button** sits on the same grid as the buttons beside it and has
    no frame of its own.
  - **Dialog buttons.** A secondary button in a dialog looks like a button:
    Import's "Choose a folder…" and "Choose a space…" read as plain words
    before. The primary button's text follows the theme, so it no longer
    disappears in dark mode.
  - **About's links** are darker, 4.5:1 or better. They were 3.23:1.
  - **Messages you must not miss** now show as a notice at the foot of the
    window, the way slides shows them. That covers:
    - a change the relay refused;
    - a file that could not be read;
    - a page that cannot contain itself;
    - "every page opens wide from now on";
    - a copy that was written.

    Before, these were the same small grey line in the bar as "Edited", and it
    faded in under two seconds. "Edited" and "Saved" stay on the bar.
  - **Small fixes.** The properties panel's section headings get a real
    disclosure caret, where the old one rendered as a dot. The share panel sets
    "Reset access…" apart from the rows above it.

- **The top bar is slides' top bar.** Same padding (8/14) and spacing (10
  between groups, 6 inside one), the same mark at the same size, a 220px title
  in regular weight, and every button on the same 30px grid. The Save half is
  slides' width with its caret; it stays the dark primary button. The unsaved
  dot is a badge on Save's corner at every width. Language (the globe) and the
  keyboard shortcuts (`?`) now sit in the bar's corner, as in slides. The globe
  opens the same list of languages slides shows, with the current one ticked.
  Choosing one rebuilds the chrome in that language. Share is labelled "Share".
  ＋ Insert stays one menu, next to undo and redo where slides keeps its insert
  tools, and ⋯ closes the row.
  - **It narrows as slides' does.** Labels go first, then the word beside the
    mark, then controls fold into ⋯. On a phone the bar always folds. Below
    what even a folded bar needs (about 370px), it scrolls sideways instead of
    cutting off ⋯, and its menus still open fully on screen. Before, spaces
    dropped its labels only at 800px, where slides drops them at 1360.
  - **On a phone** the mark stays in the corner as a 44px button to About, and
    the Pages button follows the title. Language and Keyboard shortcuts are in
    ⋯ once the bar has folded.
  - **Fixed:** changing the language in About took the Share button out of the
    bar until you reloaded.

- **Everything that opens from the top bar is slides' too.** Menus, the Share
  popover, the dialogs, the shortcut sheet, the notice pill and the update
  chip now take slides' measurements: 30px menu rows in 13px regular type (the
  Save menu 12.5px, as in slides), the icons in the same ink as the words,
  hairline separators, a 4px gap under the button, slides' shadow, and in dark
  mode slides' slightly lighter menu surface. The Save button and its caret are
  slides' primary split, pixel for pixel, at every width.
  - **The Save menu holds everything that acts on the file, in slides'
    order.** Save a copy, Duplicate as a new space, the Markdown and page
    exports, Encrypt with password (Change or Remove once set), then Version
    history, Copy document JSON, Replace from JSON and Import Markdown. Most of
    these used to be sections of the About dialog; About now holds what slides'
    About holds — the version and updates, your appearance and language, the
    file's numbers and the document's properties.
  - **Encrypt with password asks twice**, in a dialog, instead of a single
    browser prompt; Version history and Replace from JSON open as their own
    dialogs.
  - **⋯ appears only when the bar is too narrow**, as in slides, and then holds
    the buttons the bar gave up followed by the Save menu. Its other rows moved
    to where slides keeps their kind: New page, Today's journal and New issue
    to the foot of ＋ Insert; Graph and Print to the bar beside Reading view;
    "Make this page an issue" to the page's own ⋯ menu; About to the wordmark.
  - **The Share popover is laid out as slides' is**: your name on one line,
    People, the connection line in amber or green, Share a copy, then the
    session controls — its actions plain one-line rows like the Save menu's.
  - **An update found at launch shows slides' peach version chip** beside the
    wordmark and says so once; clicking it opens About on a fresh check.
  - **Every Save row and Share action says what it does** in its hover
    tooltip, as slides' do, and a screen reader announces it as the row's
    description. The
    Save list scrolls under the bar on a short window instead of running off
    it, menus cast a deeper shadow in dark mode, and a keyboard focus ring
    in the accent colour marks where you are in the bar, menus and dialogs.

- **The bar's labels are slides' labels.** The `?` button and its sheet are
  "Shortcuts & tips", ⋯ is "More actions", Print is "Export PDF (print)", the
  Save caret reads "Save as… — copy, new space, password", the wordmark reads
  "About bento/spaces — version, updates, licenses", and the Save row is
  "Duplicate as new space…". The translations are slides' own wherever slides
  has the same string.

- **Insert is slides' insert group.** The single ＋ Insert menu is gone.
  The bar now has one button per kind of thing: Text ▾, Image ▾, Table,
  View ▾, Code and Comment. Chart and Embed appear on builds that have those
  blocks. A kind with variants opens a small menu of them, for example
  headings, lists, quote, callout, toggle and divider under Text, or Board,
  List, Table view, Gallery and Canvas under View. Video and Audio are now
  separate rows.
  - **A new block goes after the one you are in**, not at the foot of the
    page. The caret lands in it, and one undo removes it. With no caret it
    goes at the end.
  - **New page, Today's journal and New issue** moved to a ＋ ▾ beside the page
    list's ＋, with their shortcuts. ＋ is still New page.
  - The labels hide on a narrower window as slides' do. On a phone, the
    whole group is in ⋯, under captions. The `/` menu lists the same families
    in the same order, with the same captions.
- **Page templates, and a template for the daily note.** Open a page you would
  like to reuse, and the page's ⋯ menu offers **Save as template**. From then on
  the ＋ above the page list offers a blank page or any of your templates, and
  the new page arrives with the blocks, the icon and the width of the one you
  saved. With no templates saved the ＋ makes a blank page exactly as it always
  did — the picker only appears once there is something in it.

  The one that earns the feature is **Use for daily notes**: pick a template in
  **Templates…**, in the ▾ beside that ＋, and every new journal entry starts
  with your structure instead of an empty page. It is the most-used workflow in Obsidian and Logseq and it
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
