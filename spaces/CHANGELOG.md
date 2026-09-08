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
