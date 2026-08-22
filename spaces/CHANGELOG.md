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
