# Changelog

All notable changes to **bento/slides**. The app version is baked into every
shell as `APP_VERSION` (from `slides/package.json`) and shown in the About
dialog; a shipped file updates itself through the signed release channel.

The format (`bento/slides`, version `1`) is additive and stable — every version
below opens files from every earlier version, and unknown fields are preserved.
This project's versions roughly follow semantic-ish `0.MINOR.PATCH` while it is
pre-1.0.

## [Unreleased]

- **Code on a slide — and it morphs.** A slide can hold a code snippet, syntax
  highlighted, and when the same snippet appears on two slides in a row the code
  *travels* between them. A line that moved moves; a call that changed position
  slides to where it went, and the lines it passes step out of its way. Nothing
  blanks and redraws.

  This is the deck's existing morph pointed at source code. Show a refactor as
  three slides and an audience watches the edit happen rather than comparing two
  static screenshots — the starter deck now walks through fifteen years of
  JavaScript, callbacks to promises to `async`/`await`, and the code rearranges
  itself at each step.

  Symbols with no counterpart on the previous slide fade in, staggered, once the
  movement is already under way, so a newly introduced line arrives as part of
  the same beat instead of snapping in. A word whose *role* changes while its
  text does not — `render(` becoming `.then(render)` — keeps its identity and
  travels, because turning a call into a reference is a refactor, not a rename.

  Highlighting is built in, covers 75 languages plus diffs and Markdown, and
  costs a deck about 10 KB. It is deliberately the cheaper of two tiers: the
  format keeps its seam for full grammars carried as per-deck assets, and
  nothing here closes that door.

- **A deck can set its own morph tempo.** The default 0.65 seconds is tuned for
  the ordinary case — a title sliding in, a shape growing, a journey of several
  hundred pixels. A code symbol moves about one line height, and at that tempo
  the whole journey is over in roughly 300 ms: measurably an animation, watchably
  a blink. A deck built around small, precise movement can now choose a slower
  beat, and decks that say nothing are unchanged.

  This one is a document setting (`present.morphSeconds`, clamped to 0.1–6
  seconds) with no control in the panel yet — reachable today by editing the
  deck's JSON through **Copy document JSON** / **Replace from JSON…**.

- **Deck-wide brand colours.** The Slide panel gains a **Theme** section — a
  background, a text colour and six accents — and every colour control now
  offers those swatches above its picker. Pick one and the deck *remembers where
  the colour came from*, so changing the theme later updates every element using
  it, across every slide. Pick a custom colour instead and it stays exactly as
  you set it: choosing by hand clears the link, because a colour you chose
  deliberately should never be overwritten by a later theme edit.

  The document keeps ordinary colour values throughout, exactly as before — the
  reference sits alongside them rather than replacing them. So a deck saved with
  a theme still opens correctly in any earlier copy of Bento, which simply sees
  a normal deck of normal colours.

- **The web demo says where your deck went.** bento.page always hands out a new
  deck — that is what it is for — so anyone who saved from it and came back
  later got a blank starter and reasonably read it as lost work. Their file was
  on disk the whole time; nothing on screen said so.

  Saving from the web now leaves a line naming the file it went to, and saying
  that this page always starts a new deck. Coming back after a save says the
  same thing before you start typing into a fresh one, with the name of the file
  to open — and **Start a new deck anyway** is always there, because some
  visitors do want a fresh one.

  Two things genuinely do not survive that trip and are worth knowing: version
  history and the recovery snapshot belong to the browser, not the file, so they
  stay behind on bento.page when the deck moves to your disk.

- **Every deck you save is smaller.** The runtime each file carries is now packed
  harder — about 26 KB off a Bento Slides file, for nothing given up. It is the
  same compression format as before, searched more thoroughly at build time, so
  files you already saved keep working and an older copy of Bento still updates
  itself against a new shell exactly as it did.

- **Saving into any of several granted folders.** With the browser extension
  installed, you can grant Bento more than one folder and a deck saves back to
  whichever one it came from. Two decks that share a filename in different
  folders both save correctly now; previously that ambiguity made Bento decline
  the save. Granting a large folder no longer costs anything either, so a whole
  home directory is as cheap as a single decks folder.

- **Fix: several buttons were unreadable in dark mode.** White text on a
  near-white button — the main action in a dialog, the toast that confirms a
  save, the active chip in a settings row, and the ＋ between slides. The
  colour of the text was fixed while the colour behind it followed the theme,
  so what read cleanly in light turned into white-on-white as soon as the
  interface went dark. The panel chevrons had a milder version of the same
  thing. Text now always takes the opposite colour to whatever it sits on.


- **Fix: audio and video played in a show even with Autoplay switched off.**
  Set a clip's *Autoplay* to Off and it still started the moment its slide came
  up — every time, in a saved file, on any browser. The only way to stop it was
  to remove the clip.

  The flag was written as an empty attribute rather than left off, and the
  slideshow engine treats an attribute that is *present* as a yes, whatever it
  says. Bento's own check read the value and was right; it simply never got
  asked. Present since audio and video arrived.

- **Fix: a fading slide painted over the morph behind it.** When a slide set to
  *fade* handed off to a morph, the outgoing slide dissolved on top of the
  animation — a 450 ms curtain over a 600 ms move — so the elements appeared to
  jump straight to their new arrangement. They had been travelling the whole
  time, underneath. Slides that hand off to a morph now cut instead.

- **Fix: a formula's new symbols appeared instantly instead of fading in.** A
  formula gaining a term showed that term snapping into place while every other
  symbol glided. Bento's animation engine recognised HTML and SVG elements but
  not MathML ones, so the fade was quietly written to the wrong place and never
  reached the screen. Formula symbols now arrive on the same staggered beat as
  everything else.

- **Fix: the palette swatches had a border you could not see on a dark panel.**
  The new theme swatches shipped with a border colour pinned to a light-mode
  value while the panel behind it followed the interface theme — the same
  mismatch the dark-mode fix above removes everywhere else. The border now
  follows the theme too.

- **Fix: the toast after saving an editor copy said only "Editor".** In seven of
  the eight built-in languages the message that confirms an editor copy was
  saved carried the translation of the neighbouring one-word "Editor" label
  instead of its own sentence, so a German user saving an editor copy saw a
  toast reading `Bearbeiter` and nothing else. All eight now say what actually
  happened. Downloadable language packs were never affected.

- **Fix: a diagram could restyle other diagrams on the same slide.** An SVG
  element can carry its own `<style>` block, and those rules were applied to the
  whole page rather than to the drawing they belong to. So a diagram that styled
  `.dot` or `.label` silently restyled every other SVG beside it — colours,
  strokes and dimming rules leaking between unrelated drawings, and the more
  diagrams a slide carried the stranger it looked.

  Nothing could escape further than that: a drawing's stylesheet has never been
  able to load or run anything, and still cannot. This was one diagram reaching
  another's appearance, not reaching out of the document.

  Bento already scoped the stylesheet you write in the element panel; the one
  that arrives inside pasted or imported SVG markup was never scoped at all.
  Both go through the same scoping now, and a drawing's own rules still apply to
  it in full.

## [1.0.18] — 2026-08-15

- **Security: offline mode did not block everything it promised.** The switch
  says "nothing leaves this computer", and five things still went out with it
  on: a manual *Check for updates* called the release server, *Manage
  languages…* downloaded the pack index and any pack you added, a deck's video
  or image pointing at a web address still loaded from it, requests already
  running were left to finish, and a second tab that was already in a live
  session kept syncing edits.

  The last two matter most. A remote image or video in a document is the
  cheapest tracking beacon there is — it tells whoever hosts it that you opened
  the file, and when — and offline mode is exactly what you would turn on
  before opening a deck you did not write. The second tab was worse: real
  document content kept moving.

  Separately, where a browser blocks site data — a private window, or a
  locked-down setup — the checkbox showed the switch on while nothing had been
  stored, so it did nothing at all. It now holds for the session regardless and
  says plainly that it will not survive a reload.

  Offline mode now covers all of it: the network is reachable from exactly one
  place in the code, flipping the switch cuts requests and connections that are
  already open rather than only the next one, and a deck's remote images and
  video are left unloaded. Reported privately, with a reproduction — and found
  by watching real traffic after reading the code twice suggested there was
  nothing wrong.

- **Updating a file no longer interrupts you.** With Bento Tray installed and a
  folder granted, "Update this file" now finishes without a single dialog. The
  backup it leaves behind is saved **beside your document** instead of being
  downloaded — so the copy you would roll back to sits next to the thing it
  backs up, rather than in your downloads folder. Without the extension it is
  still a download, exactly as before.

  Two things caused the prompt. The backup was handed to the browser's download
  machinery, which asks where to put things if you have told Chrome to; and an
  update of a double-clicked file described itself to the extension as an
  export, so the extension — correctly — refused to write it for you.

- **Fix: Share opened cut in half on a narrow window.** Once the window is
  narrow enough to fold the toolbar into ⋯, opening **Share** from that menu
  drew the popover sliced down its left edge, with the properties panel showing
  through the gap where the rest of it should have been. Share and Language now
  open as a section of the ⋯ list itself — full width, scrolling with it,
  nothing hanging over an edge to be cut off.

  The ⋯ menu scrolls when it has more in it than fits on screen, and a box that
  scrolls in one direction quietly clips the other whether you asked for that or
  not. Anything floating inside it was always going to be trimmed. Wide windows
  were never affected: the fold only happens when the toolbar runs out of room.

- **The update card drops its peach stripe.** The "Version X is available" card
  in About carried a thick accent rule down its leading edge — the only stripe
  of its kind anywhere in the app, and a hard-coded colour, so it stayed peach
  while everything around it moved into dark mode. It now has the same quiet
  1px border as every other surface in the dialog and themes along with them.
  The accent stays where it earns its place: on the button you press.

## [1.0.17] — 2026-08-10

- **Security: update this file. A deck could run code hidden in its own
  content.** Ordinary-looking document content — an image, a shape, an embedded
  drawing — could carry script that ran when the slide was drawn, or quietly
  send the reader somewhere else. No unusual file was needed and nothing looked
  wrong on screen.

  That matters more here than in most applications, because a Bento file is not
  a passive document: the page holding it also holds the live-session keys, the
  local autosave copy, and — where the browser allows it — permission to write
  back to the file on disk. Anything running inside the page inherits all of it.

  Every path that turns author content into a page is now sanitised: the
  renderer, the still image written for file-manager thumbnails, and the PDF
  export. The iOS host no longer trusts a filename a document supplies, blob
  fetches verify what they received, and new password-protected files use a
  stronger key derivation.

  **Two exports were also leaking.** "Copy document JSON" carried the live
  room's private keys — while suggesting you paste the result into an AI chat —
  and "Save as template…" wrote readable content out of a password-protected
  deck. A third case kept a key in an invite copy that should not have had one.
  All three now strip, through one list in one place rather than three
  independent decisions.

  **If you have already shared a live deck** — its JSON, or the file itself, to
  a chat, a ticket or an agent — updating does not retract that. Use *Share →
  Rotate keys*, which mints a new room and revokes the old one, then re-share
  the new copy. If you published a template made from a password-protected
  deck, treat its contents as disclosed: rotation cannot take back what the
  template already wrote in the clear.

  Found by auditing this repository rather than by a report, with an
  independent adversarial review on each round, and every fix was checked to
  fail against the previous build before being kept. The collaboration relay is
  deliberately **not** part of this release — a relay deployment cannot be
  undone by a file update, so it ships separately once its own regression is
  resolved.

- **A dark interface, if you want one.** *About → Appearance* offers Match my
  system, Light or Dark. It follows your machine by default and changes as your
  machine does, so a laptop that dims at sunset takes the editor with it.

  **Your deck does not invert.** Dark dims the chrome around the slide; the
  slide itself stays exactly as authored, because its background is your data
  and someone proofing at midnight still needs to see what will be projected.
  The presenter window stays dark in both themes — you present in a dark room.

  The theme is a viewer preference, stored on your machine and never written
  into the file, so it never travels to whoever you send a deck to. Same rule
  the interface language and reduced motion already follow.

- **Hide a slide from the show.** Toggle *Hide slide* in the Slide panel and it
  stays in the deck, fully editable, but drops out of the walk: arrow keys pass
  over it, PDF export leaves it out, and it is never picked as the file's
  thumbnail. An element `link` still reaches it, which is the point — backup
  numbers, an appendix, the detail slide you only open if somebody asks.

  Hidden slides do not take a page number, so `{{page}}`/`{{pages}}` stay
  contiguous for the audience: the same rule interactive states already follow,
  rather than a second one to remember. If you prefer the office-suite
  behaviour, where a hidden slide keeps its number so the visible ones do not
  renumber while you toggle slides during rehearsal, turn on *Number hidden
  slides* under Slideshow.

  The sidebar shows what the audience would count — a hidden slide's number is
  struck through, or replaced by a dash when it has none — because a slide you
  have forgotten you hid is a slide you find out about mid-presentation.

- **A deck that is being shared now says so before an agent reads it.** A file
  with live collaboration switched on carries the keys to its own session —
  that is what makes sharing work without accounts, and it means anything
  receiving the file receives the room: a chat, a ticket, an agent harness.
  Nothing about a document looks like a credential, so this was easy to do by
  accident.

  The agent guide and the packaged skill now open by checking for it and
  saying so, and `window.bento.validate()` reports it as
  `collab-secrets-present` — only when private key material is actually there,
  so a read-only copy stays quiet. Removing the keys afterwards does not
  retract them; if a shared deck has already gone somewhere, *Share → Rotate
  keys* is the remedy.

- **Fix: a live session could crash when two people created the same element at
  the same moment.** Sharing an element id across slides is the morph idiom —
  it is what id continuity is *for* — so two collaborators inserting one
  concurrently is ordinary, not a collision. If one copy carried a property the
  other did not (a shadow, a gradient fill, an outline, a group, a link), the
  replica receiving the other's insert threw and the session stopped. Nothing
  was lost from the file; the tab simply stopped keeping up. Same one-line
  defect as the two before it in this engine — a debug string built eagerly
  around a value that can legitimately be absent — and it is now pinned by a
  test with a deterministic trigger rather than left to a random rig's depth.

- **Fix: the end of the toolbar could be cut off the right edge.** Between
  roughly 1200 and 1250 pixels wide, the buttons on the right ran past the
  window while their labels were still showing — the bar collapsed to icons at
  1200px, but it actually needed 1250px to fit. A fixed width was never going
  to be right, because the same buttons need a different amount of room
  depending on browser zoom, system text size, the language the interface is
  in, and whether the update chip is showing. The bar now measures itself and
  steps down through its tiers until it fits, whatever is in it.

- **Fix: on a narrow window, the ⋯ menu could not be clicked.** With the
  properties panel open, the menu opened and drew in full, but every click on
  it landed on the panel behind instead. The toolbar sits in its own painting
  layer, and that layer was ranked below the panel — so nothing the menu itself
  could do would bring it forward. The toolbar now sits above the panels, where
  a menu that escapes it belongs.

- **Fix: choosing a custom slide size now reveals its width and height.** The
  page-size picker rebuilt the properties panel before recording any custom
  state, so a preset-sized deck immediately snapped back to its preset and the
  two inputs never appeared. Custom mode now reveals the existing controls
  without changing the document until a dimension is actually edited.

- **Fix: the toolbar keeps its height as you resize the window.** Narrowing
  past 760px used to shave 4px off it and then, below 700px, add 14px back for
  touch-sized buttons — so the bar shrank and then grew while a window was
  being dragged. It now narrows horizontally only, which is where the room was
  needed anyway, and has two heights with a reason each: normal, and taller on
  a phone where every button is a 44px target.

## [1.0.16] — 2026-08-03

- **Fix: the slide could open off-centre, pushed to one side and clipped.**
  Most likely on a deck whose page is larger than the default — a 1600×900 deck
  outgrows the editing canvas at zoom levels where a 1280×720 one still fits.
  The canvas gained room to pan past the slide's edges in 1.0.14, and turning
  that room on moved the slide within the scrollable area without moving the
  view with it, so you were left looking at the empty margin beside your slide.
  Clicking the zoom percentage snapped it back, because that was the one action
  that re-centred. The view now stays put across any re-layout.

## [1.0.15] — 2026-08-03

- **Fix: removing a formatting option no longer disconnects the people you are
  working with.** While a live session was running, taking something *away* —
  switching a gradient fill back to solid, turning an outline off, ungrouping,
  unlinking a chart from its table, clearing a click target — crashed everyone
  else's copy of the deck. The person doing it saw nothing wrong; their
  collaborators' sessions stopped applying changes.

  Removing a property is sent as an instruction with no value attached, and one
  line of diagnostic code assumed a value was always there. Adding things was
  always safe, which is why this survived: the convergence tests only ever
  added, so an op that takes a property away had never once occurred in 45,000
  checks. They generate removals now.

- **"Save a copy…" and share exports remember their own folder.** The save
  picker used one identity for every kind of save, so it opened wherever you
  last put a view-only copy even when you were saving your working file.
  In-place saves, copies and share exports now each remember their own last
  location.

  Underneath, this makes the *intent* of a save visible to anything hosting
  Bento — `tray/ios`, and browser hosts — which previously could not tell ⌘S
  from "Save a copy…" at all, because both arrived with identical arguments.

- **Fix: the topbar came back in the wrong order after the window narrowed and
  widened again.** Below 700px the bar folds its buttons into two menus, and
  unfolding put them back by a rule rather than by memory — everything except
  Redo went into the right-hand group, immediately before Format. So Comment
  migrated out of the insert tools it belongs to, and Save ended up sitting
  after Help. Each button now returns to the group it was authored into, in the
  order the bar was built with.

- **Fix: a deck opens where the browser refuses it storage.** With site data
  blocked, inside some embedded webviews, or in any sandboxed frame, a Bento
  file showed *"This file could not start"* and nothing else — because reading
  the `localStorage` property (not calling a method on it, merely reading it)
  throws in those contexts, and the very first thing the app did was read your
  saved language. One unreadable preference cost you the whole document.

  Preferences now fall back to their defaults instead: the deck opens and
  behaves as it would for a first-time visitor. Anything you change during the
  session works normally; it just is not remembered.

## [1.0.14] — 2026-08-02

- **Pan the canvas by dragging, and past the slide's edges.** The scrollbars
  were the only way to move a zoomed slide, which puts the control at the edge
  of the screen while the work is in the middle of it. **Hold space and drag**
  to pan — the gesture nearly every canvas tool uses — or drag with the middle
  mouse button if yours has one. On a trackpad a two-finger scroll already
  panned once you were zoomed in, and still does.

  Scrolling also used to stop dead at the slide's edges, so at high zoom a
  corner element could never be moved off the corner of the screen to work on
  it. There is now half a screen of room beyond every edge once you zoom past
  fit — enough for any point on the slide to reach the middle — and none at all
  while the whole slide fits, so a view that needs no scrollbars still has
  none. Asked for by gcgbarbosa.

- **Fit a text box to its text, in one click.** A box that is too short lets its
  content spill over whatever sits below it, and one that is too tall throws off
  its alignment against everything beside it — neither is visible in the numbers.
  The Typography panel now has a button that sets the box to exactly the height
  its text needs, and tells you what that is before you press it.

  Underneath is `window.bento.measure()`, which answers the question the format
  could not: how tall is this string at this width, in this font? Ask it with a
  spec and you can size a box *before* creating the element, which is what turns
  generating a deck from guess-then-correct into laying it out right the first
  time. Requested by thinkbig1979.

- **Entrances and count-ups now run on morph slides.** Both were skipped
  wholesale on any slide reached by `transition:"morph"`, which the authoring
  guide actively encourages — so a headline statistic rendered as a static
  number, and an element told to sweep in from the right got a small upward
  nudge instead.

  The rule is now per element. One that morphs in from the previous slide is
  already in motion and still ignores both. One that is **new** to the slide has
  nothing to fight, so it counts up, and enters the way you asked — direction,
  duration and order included. Elements with no `fx.enter` keep the automatic
  fade-and-rise, so nothing changes in a deck that did not ask for it.

- **Fix: the built-in layouts fit the slide.** They were drawn for a 1600×900
  stage while the default deck is 1280×720, so applying *Title* put the title
  box 160 px off the right edge and *Title + content* overflowed the bottom by
  88 px. They are now scaled to the deck's own page size, which also makes them
  correct for the custom sizes the slide panel offers.

- **Check a deck for what the runtime silently swallows.** Almost everything
  that goes wrong in a generated deck fails quietly: a typo'd property is
  ignored, a `dash-march` loop on a solid stroke animates nothing, a typeface
  the file never carried falls back to something else, and text overflows its
  box while the JSON looks perfect. `window.bento.validate()` reports all of it
  in one structured pass, including text overflow measured against the real
  renderer. It only reads — it never changes the document.

  Its first run found dead configuration in our own starter deck: three charts
  carrying a chart option the renderer has never read, and two entrance
  animations that could never play. Requested by thinkbig1979.

- **Fix: two gallery templates asked for a typeface they did not carry.** The
  Orbital and Pixel Picnic templates set their text in Instrument Sans but
  embedded no font at all, so every viewer without that typeface installed
  silently got Helvetica Neue instead. They now carry the face — and only the
  face they use, rather than every font the gallery has. The failure was
  invisible to us for the worst possible reason: whoever builds a template is
  the person most likely to have its typeface installed.

- **The agent authoring guide describes what the runtime actually does.**
  `agents.md` gained the download URL, the real `fx.loop` parameters (and the
  `strokeStyle` a dash-march needs to be visible), the chart option keys
  charts-lite honours, `morphId`, layouts and `role`, column arithmetic for the
  1280×720 canvas, and an accurate account of embedded fonts. Every gap here
  was found by an agent authoring a deck from the guide alone, and every one of
  them failed silently. Reported in detail by thinkbig1979.

## [1.0.13] — 2026-08-02

- **Fix: fade, slide and zoom transitions animate again.** They had been
  instant cuts. Reveal only mounts slides within `viewDistance`, which was set
  to 1 — so the slide being moved *to* was not in the page, and a CSS
  transition had nothing to animate into. Morph was unaffected, because that
  is Bento's own animation rather than Reveal's. Found and fixed by James
  London.

- **Copy and paste keeps embedded typefaces intact.** Pasting elements into
  another deck used to lose their embedded font entirely, and pasting slides
  carried every face in the source deck while omitting the bytes they pointed
  at. Both now carry exactly the faces in use, and a name collision keeps the
  recipient's own bytes. Fixed by Kushida.

- **Update notes now cover every version you skipped.** The About dialog
  described only the newest release, so upgrading across two versions told you
  nothing about the one in between — and 1.0.12 was barely a day old when this
  release became necessary. It now spans the releases you missed.

## [1.0.12] — 2026-08-01

- **A laser pointer while you present.** Press **L** in the slideshow and the
  cursor becomes a red dot trailing a short comet tail, for pointing at the
  thing you are talking about. Press L again to put it away. It is presenter
  equipment, not deck content: nothing about it is written into the file, so a
  deck you point at is byte-identical to one you did not.

- **Decks thumbnail properly on iPhone and iPad.** 1.0.11 taught files to draw
  a picture of page one in Finder, and it worked everywhere except the platform
  most likely to need it — iOS renders neither a page's JavaScript nor its
  `<noscript>`, so a deck in Files stayed the same dark box. The preview is now
  ordinary markup followed by a script that removes it before the browser paints
  a frame, which the thumbnailer keeps and every reader never sees. Existing
  decks pick this up the next time you save.

- **Count-up numbers keep their thousands separators.** A number written
  `1,234` counted up to `1.234` and stayed wrong once the animation finished;
  `1,234,567` became `1.2340000`. Numbers now settle exactly as you typed them,
  in your own convention — `1,234.5` and `1.234,5` both survive, and a sentence
  ending in a number keeps its full stop.

- **The tab tells you which file you are editing.** A deck's title and its file
  name drift apart constantly — rename the deck and the file on disk keeps its
  old name — and only one of them answers *what does ⌘S overwrite?* The tab and
  a small chip beside the title now show the file, whenever the two differ.

- **Save offers the file you are looking at.** Opening `Q3-board.bento.html`
  and pressing ⌘S used to propose saving `Bento_Slides_Showcase.bento.html` —
  the name was built from the deck's title, so an ordinary save quietly
  suggested a *second* file beside the real one. It now offers the file you
  actually opened. (Exports — share copies, templates — still name themselves;
  those are deliberately new files.)

- **Drop a deck onto an open editor to switch to it.** With a deck already open,
  dragging another `.bento.html` in from Finder opens it in place of the current
  one. On Chrome and Edge it arrives with permission to write back, so ⌘S saves
  it without a dialog — which a deck opened by double-clicking cannot do, since
  the browser gives such a page no way to write to its own file.

- **Release notes in the About dialog get room to be read.** An available
  update is now one card — version, what changed, and the two ways to take it —
  and the notes are a real list inside their own scroll region rather than a
  140px porthole in a dialog that was itself scrolling. The dialog is 440px
  wide instead of 360 (capped to the viewport, so a 375px phone keeps its
  gutters), which is enough that the five bullets a release carries fit whole
  at any normal window height.

- **Turkmen, taking the language packs to 22.** Contributed and reviewed by a
  native speaker (Mekan Soltanov), and the only pack currently complete against
  the whole interface. Install it from the globe menu → Manage languages.

- **Save a copy, set a password or reach version history from a phone.** The
  Save button's caret does not fit beside a 44px target, which left every file
  operation behind it unreachable on a phone — save a copy, duplicate as a new
  deck, the password actions, version history and the JSON round-trip. They now
  sit at the bottom of the ⋯ menu.

- **Fix: the current slide's thumbnail stays visible.** Walking a long deck with
  the arrow keys scrolled the canvas but not the sidebar, so the highlighted
  thumbnail wandered off-screen. Contributed by Yishen Tu.

- **Fix: the auto-save tip pointed at the wrong menu.** It said version history
  lived in About; it moved to the Save menu several releases ago.

## [1.0.11] — 2026-07-27

- **LaTeX maths in any text box, rendered as MathML.** Type `$E=mc^2$` and it
  renders as a formula — `$$…$$` for a display equation on its own line. The
  document stores exactly what you typed, so a deck with maths still opens in
  an older copy of Bento: you'll see the plain `$E=mc^2$` rather than a broken
  slide.

- **Symbol-level formula morphing.** On a morph transition, a term that
  crosses the equals sign is *seen to travel there* instead of the whole
  formula crossfading. Give the element the same id on both slides and `$a + b
  = c$` becomes `$a = c - b$` with the `b` moving across. The starter deck
  demonstrates it.

- **Twenty-one installable language packs, each hash-signed.** The globe menu
  gains **Manage languages…** — install a language from the release channel or
  remove one you don't need. Arabic, Hebrew, Hindi, Korean, Russian,
  Ukrainian, Vietnamese and fourteen others are available without adding a
  byte to files that don't use them. Each pack's fingerprint is signed
  alongside the release, so installing a language is verified exactly like an
  update.

  Your choice lives in the browser, never in the document — a deck written in
  Tokyo opens in French chrome for a French reader, and the deck itself is
  unchanged either way.

- **The editor is usable at 402px — the topbar folds instead of overflowing.**
  The toolbar used to need about 680px of a 402px screen: it ran off the edge,
  took the Save button with it, and because nothing clipped it, swiping the
  toolbar dragged the whole canvas sideways. On a phone it now folds into two
  menus — ＋ for inserting and ⋯ for everything occasional — leaving slides,
  insert, undo, format, save and more, at proper touch size. The side panels
  slide over the canvas instead of squeezing it, so the slide you're editing
  is no longer the smallest thing on screen. Nothing changes on a laptop.

  The save-as list — save a copy, duplicate as a new deck, the password
  actions, version history and the JSON round-trip — sits at the bottom of ⋯ on
  a phone, because the caret that opens it on a laptop doesn't fit beside a
  touch-sized Save button.

- **Decks carry a page-one preview, so Finder and Files thumbnail them
  properly.** Every Bento file used to thumbnail as the same dark box, because
  thumbnails are drawn without running a page's JavaScript and, until Bento
  boots, every deck genuinely is the same bytes plus the same boot splash.
  Saving now writes a still picture of page one into the file, which is what
  those previews draw instead — so a folder of decks is finally something you
  can read. It costs about 14 KB on a typical deck (under 2% of the file),
  never more than 64 KB: a page with a big photograph keeps its layout and its
  words and drops the photograph rather than carrying it twice. Nothing
  changes when you open a deck normally — the picture is written for software
  that can't run the file, and is never shown to a reader.

- **Added an optional virtual laser pointer for presentations.** Press `L`, or
  use the new `🟒` laser button in speaker view, to point at the audience slide.
  The pointer stays local to the current show and leaves a short, smooth,
  tapered trail as it moves.
- **Chart labels and legends now honor their visual options.** The lightweight
  chart renderer applies configured font sizes and weights to axis labels and
  legends, respects legend spacing and placement, and measures CJK legend text
  correctly so localized series names no longer overlap.

  **A password-protected deck gets no preview at all.** A readable picture of
  the title page sitting next to the encrypted document would give away exactly
  what the password is there to protect, so encrypted decks keep the plain dark
  thumbnail — and a deck that had a preview loses it the moment you set a
  password.

- **Deck-level toggles for slide number, progress bar and corner arrows.**
  They live in a new **Slideshow** section of the slide panel. They're
  deck-wide and travel in the file, so a deck you hand to someone else
  presents the way you designed it.

- **Release notes ride in the signed manifest, shown before and after
  updating.** When an update is available the About dialog now lists the
  headlines from that release inline, instead of only a version number and a
  link off to GitHub — and because they travel in the signed manifest, they
  can't be tampered with. After the update lands and you reload, Bento says
  once which version you're now on, with a link to the full notes. It only
  says it if you actually upgraded: someone opening a deck you sent them never
  sees it.

- **A Screen Wake Lock is held for the length of a presentation.** Phones and
  laptops used to dim and lock partway through a talk if you left a slide up
  for a couple of minutes. Bento now holds the screen on for the length of the
  show and lets go when you exit — and takes the lock again if you switch away
  and come back.

- **Honest save messaging where the File System Access API is missing.** Those
  browsers (and every browser on iPhone and iPad) can't rewrite a file in
  place — Bento hands back an updated copy instead. The editor used to say the
  opposite in its tooltips and only admit it in a passing message *after* the
  first save. It now says what will actually happen before any work is at
  stake, once per browser, and the Save button describes the real behaviour.

  Those browsers also now show that your work *is* being kept safe. Bento has
  always snapshotted the deck into the browser as you edit and offered it back
  when you reopen, but on Safari and Firefox nothing ever said so — the only
  signal was an amber dot that never cleared. It now reports when it last
  backed up, while still showing the file itself as out of date, because it is.
  (A password-protected deck is never snapshotted, so it stays quiet rather
  than promise a safety net it doesn't have.)

- **The update save dialog pre-fills the open file's own name.** It offers the
  name of the deck you have open rather than one derived from its title — so a
  file called `Q3-board.bento.html` no longer offers to save itself as
  `Q3_Board_Review.bento.html`. The backup written alongside an in-place
  update follows the same name. Where the save dialog opens is set by the
  browser and can't be pointed at a folder by the page, but it now remembers
  the last place you saved, so the second update onwards starts in the right
  directory.

- **The starter deck is called “Bento Slides Showcase” again.** The lowercase
  rebrand swept the deck's own title along with the app's, but a deck title is
  a document name — it shows in the window title and becomes the suggested
  filename — so it reads better in title case. The `bento/slides` wordmark is
  unchanged.

- **Charts honour axis and legend text styles, and measure CJK correctly.**
  The lightweight chart renderer applies configured font sizes and weights to
  axis labels and legends, respects legend spacing and placement, and measures
  CJK legend text correctly so localized series names no longer overlap.

- **Fix: a formula you opened but didn't change now redraws when you finish.**
  Editing a formula (or a `{{page}}`-style field) shows its raw source; leaving
  without typing anything used to leave that source on the slide until
  something else happened to repaint.

- **Fix: Reveal's scroll view no longer activates below 435px.** Below about
  435px wide, the presentation was quietly switching to a scrolling reading
  layout instead of a slideshow — so swipe navigation stopped working and
  hidden interactive slides became scrollable content.

- **Fix: saves no longer accumulate an uncompressed copy of the stylesheet.**
  Each save wrote a fresh, uncompressed copy of the app's stylesheet into the
  file, which the next save then copied again — a deck saved ten times carried
  ten of them and had put on a megabyte for nothing. The stylesheet belongs in
  the compressed runtime payload, where it takes 27 KB and is written exactly
  once; a file that already accumulated copies drops all of them the next time
  you save it.

- **Fix: the cartesian grid reserves room for the legend's real height.**
  Charts that don't set their own margins now leave room for the legend at
  whatever size it's set to, instead of assuming the default one.

- **Fix: starter-deck axis labels back above the WCAG AA contrast floor.**
  They were being drawn half-transparent against a dark panel.

- **Fix: the About dialog's update section no longer overlaps the controls
  below.** Once an update was found, the extra heading and buttons collapsed
  into a sliver and drew on top of the auto-check and offline switches. It now
  takes the room it needs and the dialog scrolls.

## [1.0.10] — 2026-07-25

- **Table defaults can follow the deck theme.** A deck may now define table
  colours, typography, spacing, borders, and corner radius in `theme.table`.
  Tables inserted from the toolbar inherit those defaults, and switching back
  from the Minimal preset restores the themed header treatment. Existing decks
  without table defaults keep the same built-in appearance.

- **Fix: deleting a slide could empty the deck entirely.** The "a deck needs at
  least one slide" guard counted the slides you had rather than the ones that
  would be left — and deleting a slide also deletes its interactive states. So
  a deck holding one slide plus one state of it passed the check, lost both,
  and left the editor with nothing to show. Deletion then appeared stuck. The
  guard now checks what survives.

- **Fix: setting a morph id by hand did nothing.** Pairing two elements across
  slides via the Morph panel silently failed — the element matched up but never
  animated, so morphing only worked through the duplicate-a-slide route. Both
  ways work now.

- **Photos and video now work in live collaboration.** This finishes what
  1.0.9 could only warn you about: previously anything past about half a
  megabyte was simply too big to send to your collaborators. Now a large image
  is uploaded once, encrypted, and everyone else pulls it down in the
  background — so you can drop a full-resolution photo into a shared deck the
  same way you would in a deck you're editing alone. A 3MB photo used to
  produce a message the relay refused outright; it now travels as a reference
  of about a hundred bytes.

  As always the server never sees the picture: it is encrypted before it
  leaves your machine, and the relay stores bytes it cannot read. Collaborators
  on the same computer don't involve the relay at all. Small images are still
  carried inside the document exactly as before, so nothing changes for
  ordinary decks, and a self-hosted relay without blob storage keeps working —
  it just falls back to the old inline-only behaviour.

## [1.0.9] — 2026-07-25

- **Fix: large text could silently kill live collaboration.** A text box of
  roughly 200KB or more crashed the change-differ — and because that runs on
  every edit, *nothing* synced afterwards, on any slide, with no error shown.
  Collaboration simply stopped. Fixed, and a failed diff can no longer wedge a
  session either: it now recovers by sending a full snapshot, so a future bug
  of that shape degrades instead of silently breaking.

- **Fix: adding a large image while collaborating failed silently.** An image
  over about half a megabyte was dropped on its way to your collaborators —
  they saw a broken picture, and your editor kept retrying it forever. Bento
  now tells you when something is too large to share live (and says so once,
  instead of looping). The size limit itself roughly doubled. Larger media
  still can't be added mid-session; that needs a deeper change, and it's next.

- **The wordmark is lowercase.** `bento/slides`, matching what the file has
  always called itself internally, and the website now uses the `bento/.`
  platform mark.

- Under the hood: shared machinery (saving, encryption, auto-save, updates,
  animation, charts, translations) moved into a common kernel so the coming
  apps use exactly the same document lifecycle as slides. No behaviour change
  — the built file is byte-identical apart from the rebrand.

## [1.0.8] — 2026-07-24

- **Reduce motion during a presentation.** A calmer show for motion sensitivity,
  a laggy projector, or a weak machine. It honours the OS *prefers-reduced-motion*
  setting automatically; the presenter can also toggle it with **M** (or the ⏸
  button in speaker view). When on, slide transitions cut instantly and every
  animation — morph, entrance staggers, count-ups, dash-march / motion-path loops,
  ken-burns — is skipped, so elements just show their final state. It's a
  viewer/presenter preference (persisted per browser), never written into the
  document.

- **Gradient text.** Text can take a multi-stop linear gradient fill (angle +
  colour stops), painted into the glyphs — edited in the Typography panel.

- **Outlined & hollow text.** A text outline (width + colour) with an optional
  hollow interior — the classic outlined section-break word.

- **Element blur & blend modes.** Any element can take a Gaussian blur and a CSS
  blend mode (screen for neon light glows, multiply/overlay for editorial
  duotones), in the Effects panel.

- **Frosted-glass panels.** Elements can blur what's behind them
  (backdrop-filter). Screen-only — pair with a translucent fill so PDF/print
  show a graceful flat panel.

- **First-run Slideshow hint.** New editors get a peach neon-runner cue tracing
  the Slideshow button until they present once (and again on hover); the About
  dialog now links back to bento.page.
- **Fix: live edits no longer lose focus when a collaborator changes something.**
  A remote collab op used to trigger a full canvas repaint that tore down the
  text (or table-cell) node you were typing in — stealing focus and resetting
  the caret. The canvas now defers the repaint while an inline edit is in
  progress (a burst of remote ops coalesces into one repaint), and catches up
  the instant the edit commits. Your edit is untouched; everyone else's changes
  still land — you just see them when you finish typing. (The most-reported
  rough edge from the Show HN launch.)

- **Fix: charts with negative values now baseline at zero.** A bar/line chart
  whose data crosses zero drew everything from the bottom of the plot — negative
  bars pointed up and the x-axis was pinned to the floor. Bars now grow from the
  zero line (positive up, negative down), and the x-axis line sits at zero so
  values dip below it. All-positive charts are unchanged.

- **Fix: two-finger pinch no longer breaks selection on mobile Safari.** A pinch
  over the canvas started a rubber-band marquee and, combined with the page
  zoom, threw the selection box off and could crash the page. Multi-touch
  gestures are now ignored by the marquee and the page pinch-zoom is suppressed
  over the canvas; single-touch scroll and selection are unaffected.

## [1.0.7] — 2026-07-22

- **In-place update keeps its handle.** When a deck opened *without* a File
  System Access handle (e.g. double-clicked from disk) is updated via "Update
  this file…", Bento now keeps the handle the save-picker grants — so this and
  every later update rewrite the file in place silently, instead of re-prompting
  each time. (A double-clicked file gives the browser no handle on open, so the
  first update still needs you to overwrite the file you have open in the save
  dialog; after that it's automatic.)

- **Editable morph id.** Elements now carry an optional `morphId` that
  overrides which element they morph into across slides, so two
  independently-created elements can be paired without the duplicate-a-slide
  dance. The element panel gains a **Morph** section: a "Morph id" field (set it
  back to the element's own id to clear the override) and a "Pair with" picker
  that adopts another slide element's key. `id` stays the stable identity —
  selection, connectors, comments and live-collab node identity are untouched —
  and the default morph (elements sharing an `id`) is unchanged, so existing
  decks behave identically. Same-slide key collisions are rejected inline.

- **True bezier curve editing.** Selecting a curve now shows real pen-tool
  control handles (in/out tangents) on each anchor — drag a handle to bend the
  curve exactly. Smooth anchors mirror the opposite handle; Alt breaks a corner.
  Double-click a segment to insert an anchor (a de Casteljau split that
  preserves the shape), double-click an anchor to remove it. Replaces the old
  Catmull-Rom anchor editing, which sampled the rendered curve into approximate
  points and re-smoothed on every drag — lossy, drifting, no real handles. The
  new model parses the path's actual control points and round-trips losslessly.

- **Hybrid bezier motion paths.** The "Edit path on canvas" motion-path editor
  (the trajectory a presenting element loops along) now uses the same exact
  cubic-bezier core. It stays SIMPLE by default — drop and drag waypoints and
  the path auto-smooths, exactly as before — but selecting a waypoint reveals
  its in/out control handles, and dragging one flips that point to "manual" for
  a precise arc or a sharp corner (Alt) while untouched points keep
  auto-smoothing. Inserting a point (double-click the path) splits the curve
  without changing its shape. Because the path is now stored as explicit cubics,
  the old sample-and-re-smooth round-trip drift is gone: a motion path is
  byte-stable across open/save, and existing decks reopen unchanged. Per-anchor
  speed (scroll a point) and the live preview dot are preserved. Double-clicking
  a waypoint to remove it is detected directly on the point's mousedown (the
  select-on-click redraw would otherwise defeat the browser's dblclick, which
  needs both clicks on the same element) — so remove now works whether or not the
  point was already selected.

- **Help: the `?` overlay now documents lines, curves & motion paths.** New
  "Lines & curves" and "Motion paths" sections spell out the gestures — draw from
  the Shape menu, drag points, click a point for bézier handles, Alt for a sharp
  corner, double-click to add/remove a point, scroll a motion-path point to set
  its speed.

## [1.0.6] — 2026-07-21

- **Fix: topbar menus were icon-only on narrow screens.** The responsive rule
  that collapses topbar button labels to icons below 1200px also hid the label
  of every item INSIDE the dropdown menus (Save, language, shapes, media) —
  on phones they rendered as icon-only mystery lists. Menu items are exempt
  now; only the bar-level buttons collapse.

## [1.0.5] — 2026-07-21

- **Fix: dropdowns unreadable on dark-mode phones.** The app never declared a
  color scheme, so dark-mode Android/iOS rendered NATIVE form controls dark
  (and Chrome-on-Android could force-darken the page) while the ink stayed
  dark — dark-on-dark "blank" dropdowns. The shell now declares
  `color-scheme: only light` (meta + CSS) and form fields carry explicit
  light background/ink. The 1.0.4 iOS `user-select` fix remains as the
  second half of the story.

## [1.0.4] — 2026-07-21

- **Fix: dropdowns rendered blank on iOS Safari.** WebKit draws a `<select>`'s
  chosen value as empty text when any ancestor sets `user-select: none` — which
  `.ed-root` does for the whole drag-driven UI. Form fields (`select`, `input`,
  `textarea`, contenteditable) now restore `user-select: auto` explicitly.

- **Skill renamed `bento-deck` → `bento-slides`** and moved into a Claude Code
  plugin marketplace at the repo root (`/plugin marketplace add nyblnet/bento`,
  then `/plugin install bento-slides@bento`). Also published as a claude.ai
  uploadable zip (`bento.page/skills/bento-slides.zip`); the old
  `skills/bento-deck/SKILL.md` URL keeps serving the current skill. The skill
  now bootstraps from nothing: it downloads the latest signed release itself,
  so "make me a deck" works in an empty folder.

## [1.0.3] — 2026-07-21

- **Fine-grained collaboration (per-person keys).** New decks mint an OWNER
  key; "Invite to edit…" saves a copy carrying an owner-signed invite, and
  every opening device joins with its own key. The People panel shows
  key-verified names, roles and fingerprints (including your own identity),
  and the owner can REMOVE one person — cryptographic revocation enforced by
  the relay, nobody else disturbed. Legacy decks keep working; "Reset access"
  upgrades them.
- **The public guestbook is owner-moderated now** (same scheme, public invite);
  daily auto-roll is off — moderation replaces blanking.
- **Menus rebuilt around one rule — Save is for you, Share is for others.**
  A split [Save|▾] button (with the unsaved-changes dot on its corner) holds
  copy/duplicate/password plus Version history and the JSON round-trip; the
  Share panel holds invite/view-only/present-only/template with People and
  session controls. Icons and tooltips everywhere; a language globe in the
  topbar replaces the About picker.
- **Slideshow controls**: one split pill beside the zoom control — Slideshow
  (fullscreen), Present in this tab, Open speaker view.
- **Share exports name themselves** (-invite / -viewonly / -presentonly /
  -template) and no longer hijack the ⌘S target — previously a later save
  could overwrite an exported copy with the full document.
- **Canvas stability**: element drags can no longer make the slide jump
  (scrollbar appearance reflow fixed); connector anchor points are visible and
  snap; freeform and polygon drawing tools join line/curve/connector.
- All new UI strings translated across the 7 locale catalogs.

## [1.0.2] — 2026-07-20

- **Live-collab stability**: WebSocket keepalive (client ping + relay auto-pong,
  hibernation-safe) so idle connections stop getting reaped — fixes the
  frequent connect/drop churn. Client also detects a dead socket fast and
  reconnects instead of hanging. (Relay redeployed.)
- **Presenter view** overhaul: the speaker window is now a full presenter
  surface — nav bar (first/prev/next/last + counter), clickable thumbnail rail,
  all-slides grid, black-screen toggle, and keyboard control from the window
  itself. It opens from a launcher button by the present controls (or the Slide
  panel) and persists so present mode adopts it.
- **Window Management permission removed** — no prompt; the speaker window opens
  on the current display and you drag it to a second screen. Fixes the macOS
  "notes land on the wrong monitor" bug by keeping open-notes and go-fullscreen
  as two separate gestures.
- **Canvas slide navigation**: arrow keys and the scroll wheel move between
  slides when nothing is selected (arrows still nudge a selected element).
- **Readable default text**: new text boxes and tables pick a colour that reads
  on the current slide, so they're never invisible on a dark deck.
- **Lines, curves & connectors**: lines and curves now edit with direct endpoint
  / anchor handles (no more box-resize-and-rotate); double-click a curve to add
  or remove points. Draw them by dragging on the canvas. New **connectors** snap
  their ends to elements and re-route automatically when those elements move.
- **Document properties**: `doc.meta` (author/company/subject/event/keywords),
  editable in About, usable as `{{author}}` / `{{company}}` / `{{subject}}` /
  `{{event}}` field tokens in any text.
- **Entrance speed**: per-element `fx.enterDur` ("Enter secs" in the panel).
- Live-collab UI hardening: the presence avatar strip caps at a few + a "+N"
  pill, the Live panel's people list scrolls, and join/leave toasts hush in a
  crowded room — so a busy shared deck can't break the topbar.

## [1.0.1] — 2026-07-20

- Cap the live-collaboration presence UI (topbar avatars, Live panel list,
  join/leave toasts) so a crowded room can't overflow the interface.

## [1.0.0] — 2026-07-20

- First 1.0 release. MIT-licensed; feature-complete slides app (charts, tables,
  media, morph, E2EE collab, i18n) with the signed self-update channel.

## [0.9.20] — 2026-07

- Audio: render the native control as-is; add an "insert media from a link"
  entry point.

## [0.9.19]

- Fix audio-player shape (don't wrap the native control in a box).

## [0.9.18]

- **Signed writes / enforced read-only tiers.** Rooms carry an ECDSA P-256
  writer keypair (public half in every copy, private half in writer copies
  only); the room id commits to the pubkey and the blind relay drops mutating
  frames without a valid signature. A read-only copy is a writer copy with the
  private key stripped — enforced at the edge, not by client courtesy. Three
  file modes now: presentation package, read-only live viewer, and writer.
  (Full design + threat model in `docs/collab-design.md`.)

## [0.9.15 – 0.9.17]

- Directional slide-in entrances (`slide-left/right/up/down`, x-channel).
- Second-screen speaker permission moved out of present into the editor's Slide
  panel; Presenter display folded into the Speaker-notes section.
- i18n: the new UI strings translated across all locale catalogs.

## [0.9.10 – 0.9.14]

- **Dynamic field tags** — `{{page}}`, `{{pages}}`, `{{title}}`, `{{date}}`,
  `{{time}}`, resolved at render time (page numbering re-flows as slides move).
- **Dual-screen speaker view**: notes open directly on a second display, via a
  one-click permission grant that sidesteps the activation deadlock.
- Dual-axis linked chart in the starter deck; scatter state; topbar regroup.

## [0.9.8 – 0.9.9]

- **Auto-save + local version history** (IndexedDB): a crash-recovery snapshot
  plus a capped version timeline; restore from the About dialog (undoable).
  Encrypted decks are never snapshotted to disk.
- **Live table→chart binding**: a chart can track a table (`chart.source`);
  edit the table's numbers and the chart follows.
- **System-clipboard copy/paste**: elements or whole slides, across decks and
  tabs; external images and text paste in. A `?` help overlay and richer
  tooltips.

## [0.9.6 – 0.9.7]

- **Dual y-axis charts** and a **visual chart editor** (structured UI over the
  option: type, series, per-axis min/max, an editable data grid).
- Variable-speed motion-path loops (per-lap easing + per-anchor speeds).
- Fixes for live collaboration and speaker-view while presenting in fullscreen;
  a "Live" status dot.

## [0.9.3 – 0.9.5]

- **First-class `table` element** — a real HTML table with inline cell editing,
  style presets, and a table→chart bridge.
- New charts inherit the deck's palette (`theme.chartPalette`, or derived from
  the accent); table→chart charts every numeric column.

## [0.9.0 – 0.9.2]

- **File modes**: read-only **player** files (boot straight into the show) and
  **password encryption** (`bento/enc` envelope, PBKDF2 + AES-GCM; the block
  stays spliceable).
- Live-by-default decks, gated so the anonymous demo never phones home.
- **AI-native**: an embedded agent briefing + cookbook, the `bento-deck` skill,
  and `window.bento.loadDoc` round-trip.

## [0.8.0 – 0.8.11]

- **Live collaboration (bento-sync)** — an in-house op-based CRDT with
  same-machine sync (BroadcastChannel) and an optional end-to-end-encrypted
  blind relay (Cloudflare Durable Object). Offline forks merge two-way. The
  saved file stays a complete standalone document.
- Offline mode, distributable templates, the Collaborate/Live UI, the Save
  menu, and identity (display name).
- Fullscreen presenting, responsive topbar, drag modifiers (duplicate,
  center-resize), swipe navigation, per-deck page sizes, and a mobile pass.

## [0.7.0 – 0.7.1]

- **charts-lite** — the in-house, dependency-free chart engine (bar/line/pie/
  scatter). ECharts/zrender removed (it was ~47% of the shell).
- **Compressed self-extracting shell**: runtime JS+CSS deflated into base64
  blocks with a ~1 KB loader; the `#bento-doc` block stays plaintext. Shell
  dropped from ~1.33 MB to ~373 KB.
- **AI round-trip**: copy/replace document JSON; the shell points agents at the
  document block and API.

## [0.6.0 – 0.6.2]

- **Internationalization** — the viewer follows its own locale; catalogs for
  Japanese, Simplified & Traditional Chinese, Spanish, French, German, Italian.
  Language never enters the document format.

## [0.5.0 – 0.5.5]

- **Signed self-updates**: launch-time (opt-out) and on-demand update checks,
  with a visible topbar affordance; ECDSA-signed manifest verified in-app.
- Identity/branding pass (Bento/Slides lockup, splash, About).

## [0.1.0 – 0.4.2]

- The showcase **starter deck** that doubles as the feature tour (id-continuity
  morph demo, chart data morph, speaker-notes tour).
- In-place **self-update** (rewrite the open file into a new version).
- The core editor, present mode, morph engine, the typography panel, shadows,
  and the midnight-and-peach identity.

---

*This changelog was distilled from the git history for the public launch. Tags
`v0.9.15`+ carry signed releases; earlier entries summarize the pre-tag commit
line. See [docs/RELEASING.md](docs/RELEASING.md) for how a release is cut.*
