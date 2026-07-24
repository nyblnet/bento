# Changelog

All notable changes to **Bento Slides**. The app version is baked into every
shell as `APP_VERSION` (from `slides/package.json`) and shown in the About
dialog; a shipped file updates itself through the signed release channel.

The format (`bento/slides`, version `1`) is additive and stable — every version
below opens files from every earlier version, and unknown fields are preserved.
This project's versions roughly follow semantic-ish `0.MINOR.PATCH` while it is
pre-1.0.

## [Unreleased]

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
