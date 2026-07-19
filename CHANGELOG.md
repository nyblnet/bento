# Changelog

All notable changes to **Bento Slides**. The app version is baked into every
shell as `APP_VERSION` (from `slides/package.json`) and shown in the About
dialog; a shipped file updates itself through the signed release channel.

The format (`bento/slides`, version `1`) is additive and stable — every version
below opens files from every earlier version, and unknown fields are preserved.
This project's versions roughly follow semantic-ish `0.MINOR.PATCH` while it is
pre-1.0.

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
