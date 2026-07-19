# Bento — self-contained office documents

One HTML file = the document + viewer + editor. See `README.md` for the vision.
`slides/` is the first app (PowerPoint replacement); docs and sheets come later.

## Architecture (slides/)

- `src/model.ts` — the `bento/slides` JSON document model. This is the format.
- `src/starterdeck.ts` — the showcase starter deck (what a fresh build opens
  with): four 'sd-tile-*' elements morph through EVERY slide (the id-continuity
  demo), one deliberate 'fade' beat exists because entrance staggers/count-ups
  only run on non-morph entries, charts slide + hidden pie state demo the
  bar⇄pie data morph, speaker notes double as the feature tour. Gotchas learned
  building it: line shapes take their color from `fill` (not `stroke` — the
  stroke attr is what morphs tween), and the renderer draws lines horizontally
  across the element box (vertical lines = rotation), keep 96px side margins
  (x ≤ 1184 for right-most content).
- `src/save.ts` — the self-save trick: clone the document at boot (`capturePristine`),
  swap the `#bento-doc` data block, re-serialize. JSON is `<`-escaped (`<`) so it can
  never contain `</script>`. File System Access API first, download fallback.
- `src/autosave.ts` (v0.9.8) — auto-save + local version history, IndexedDB
  (`bento-autosave`, two stores: `recovery` single-latest-per-docId, `versions`
  capped timeline). Editor debounces (2.5s) on `doc` events: writes a recovery
  snapshot (plain doc JSON, NOT the shell) + a throttled version, and — when a
  FSA handle exists — silently rewrites the real file (`writeUpdatedFile`, shows
  a "Saved" tag). On boot `checkRecovery` compares the latest snapshot's
  `docContentKey` (content minus volatile modified/collab fields) to the loaded
  doc; a mismatch shows a Restore/Discard banner. Encrypted decks are NEVER
  snapshotted to IndexedDB (plaintext-to-disk) — their file write-back stays
  encrypted. readonly players skip autosave. Version history UI in the About
  dialog; restore = `store.replaceDoc` (undoable). Keyed by docId, so recovery
  needs a stable docId (saved files) — the fresh-each-load anonymous demo won't
  cross-reload-recover, by design.
- `src/render.ts` — single model→DOM renderer shared by editor canvas, thumbnails, and
  Reveal sections. Elements carry `data-el-id` (editing) and `data-flip-id` (morph).
  **Dynamic fields (v0.9.12)**: text resolves `{{page}}`, `{{pages}}`, `{{title}}`,
  `{{date}}`, `{{time}}` tokens at render time (`resolveFields`); page/pages take a
  zero-pad width (`{{page:2}}`→"06"). `renderSlide` auto-fills `RenderOpts.fields`
  via `fieldContext(doc,slide)` (page = 1-based position among NON-state slides).
  The MODEL stores the raw token; only output is resolved, so inserting/removing
  slides re-numbers everything. Editing gotcha: the canvas renders resolved, but
  `canvas.startTextEdit` swaps the token BACK to raw `el.html` while editing so
  authors edit the field, not the computed value. The starter deck's furniture +
  ghost numerals use `{{page:2}}` (they can't drift). Groundwork for the office
  suite's field/cross-reference system.
- `src/editor/clipboard.ts` (v0.9.9) — system-clipboard copy/paste. Bento content
  is written as JSON tagged `__bento:"clip"` (kind elements|slides) with referenced
  assets/fonts embedded, so it round-trips across decks/tabs; asset-key collisions
  remap. Editor: ⌘C copies selected elements, or the current slide when nothing is
  selected (→ `navigator.clipboard.writeText`); a document `paste` listener handles
  external images (embed as data-URI image element), plain text (→ text element),
  and Bento payloads (insert elements on the current slide / slides after it, fresh
  ids). Pasted slides drop `stateOf`. Guarded to skip when a text field is focused.
  Also v0.9.9: a `?` help overlay (editor.openHelp — shortcuts + tips, topbar ?
  button) and richer toolbar tooltips.
- `src/anim.ts` — in-house animation engine (no GSAP): to/fromTo tweens with
  channels opacity/y/scale/color/strokeDashoffset/attr{}/motionPath, delay/
  repeat/yoyo/ease, per-channel overwrite, killTweensOf/getTweensOf, manual
  clock for tests (window.bento.anim). Transform channels compose via a
  per-element registry that preserves the model's rotate() — call resetXform
  after applyElementFrame or stale y/scale re-emerge on the next tween.
- `src/present.ts` — Reveal.js overlay; slides with `transition:'morph'` morph
  matched `data-flip-id` elements MODEL-driven (both frames are in the doc —
  no DOM measuring): translate+scale about top-left, PowerPoint scale mode.
  Style props (fill/color) tween straight from the model values — including
  gradients (stop colors + line coords tween; solid⇄gradient fabricates/
  collapses a temp gradient; from-colors sampled at matching stop positions). Elements carry `fx` (enter stagger — equal
  `order` = simultaneous, countUp, ken-burns (`fx.ken` dir drift/out/in + zoom %/secs;
  out/in are one-shot settles per slide entry), `loop` dash-march/motion-path), `link`
  (click → slide id) and `group`; slides can set `hover:'focus-group'` (dim other
  groups). Present arrows are handled capture-phase (focus-proof). Editing UI for
  fx/link lives in the panel's "Presenting" section. Motion-path loops are edited
  visually on canvas (`editor/patheditor.ts`): draggable anchors auto-smoothed
  Catmull-Rom→cubic bezier; the stored path is RELATIVE to the element's rest
  position (first anchor = rest position; committing moves the element there).
  **Variable speed (v0.9.7)**: `fx.loop` motion-path takes `ease` (per-lap tempo,
  panel dropdown) and `speeds[]` (per-anchor multipliers, one per anchor —
  scroll a point in the path editor to set it; badge shows non-1 values). anim.ts
  `samplePath(d, speeds)` warps time→arc-length: locate each anchor's arc-length
  fraction (nearest sample), integrate 1/speed to a time LUT, invert — so the
  element dwells at low-speed anchors and rushes at high ones. Uniform speeds =
  identity (no cost); speeds omitted from the model unless they vary.
- **Signed writes / read-only tiers (v0.9.18)**: three file modes now, split
  from the old conflated `readonly`. (1) **Presentation package** = `doc.readonly`
  (unchanged: PLAYER file, present-only, collab stripped) — "Save as
  presentation package…". (2) **Read-only live viewer** = `collab.role:'reader'`
  + `writerPriv` stripped — "Save read-only copy…" (shown only when sharing is
  on); boots the editor in a locked state (`store.readOnly` no-ops commit; remote
  ops apply via session's direct state.apply+emit, NOT commit, so live updates
  still land; `editor.enterReaderMode` hides the insert group + Moveable handles,
  shows a pulsing banner; canvas text/cell edits early-return). (3) **Writer**
  (default). ENFORCEMENT is cryptographic, not honour-system: `collab` gains an
  ECDSA P-256 writer keypair (`writerPub` in every copy, `writerPriv` only in
  writers) SEPARATE from the symmetric `key` (read cap). `mintCollab` is ASYNC
  now and the room id COMMITS to the pubkey — `w`+b64url(sha256(pubRaw)) — so the
  blind relay pins the writer key trustlessly (legacy rooms are `r`+random,
  stay permissive). OnlineTransport signs op batches + snapshots (ECDSA over the
  ciphertext `${i}.${d}`); the relay (server/sync-worker) verifies the
  commitment at connect and DROPS any persisted frame lacking a valid sig →
  readers (no priv) can't write. Client signs on the old relay too (extra fields
  ignored) so there was no breakage window; **relay must be `wrangler deploy`d**
  for enforcement (done). Async-mint ripple: `session.ensureCollab` (new docs
  only, never auto-connected), startSharing/rotateKeys/saveAsNewDeck await.
  Full spec + threat model in docs/collab-design.md.
- **File modes (v0.9.0)**: `doc.readonly` = PLAYER file (boots straight into
  the show; exit lands on a minimal card, never the editor; "Save read-only
  copy…" strips collab). Password encryption: the #bento-doc block can hold a
  `bento/enc` envelope (PBKDF2-SHA-256 300k + AES-GCM-256 over the doc JSON) —
  boot shows a password gate; the password is held in memory so ⌘S and
  self-update keep writing encrypted (save.ts serializeAuto/serializeDocInto
  are THE encryption-aware paths; serializeFile stays plain for tooling).
  Splice contract intact: the envelope is still plaintext JSON in the block.
  mintCollab now mints on:true (decks are eligible to be live from creation)
  — BUT auto-connect-on-open is gated by SyncSession.shareEligible():
  connect only if the doc ARRIVED carrying collab (a saved/shared file) OR
  the user opted in this session (saved, or "Start live session" →
  enableSharing()). A never-saved starter/template stays dormant so the
  anonymous bento.page/slides demo and template tire-kickers never phone
  home (v0.9.1 fix — v0.9.0 connected every visitor). "Stop sharing" opts
  out; Offline mode hard-blocks regardless.
- `src/update.ts` — signed self-update: checks a release manifest at LAUNCH
  by default (localStorage 'bento-auto-check'='off' disables; toggle in the
  About dialog; found updates badge the topbar sync button) and on demand via
  About/topbar (`bento.page`; dev override localStorage 'bento-update-url'),
  verifies ECDSA P-256 signature against the embedded
  PUBLIC_KEY_JWK + sha256 of the fetched shell + version monotonicity, then
  re-splices the current doc into the new shell (`save.serializeWith`) and
  downloads it as a NEW file (original untouched = rollback). APP_VERSION baked
  from package.json via vite define. Private key: `scripts/keygen.mjs` →
  `~/.bento/release-key.json` (offline, NEVER commit/CI); sign releases with
  `scripts/sign-release.mjs`. Docs carry a stable `docId` (uuid, minted at
  creation/load) — identity for future sync/merge; never regenerate it.
  Scripting: `window.bento.updates.{version,check,build,apply}`.
- `src/i18n.ts` + `src/i18n/*.ts` — internationalization: ~1KB t() with
  ENGLISH-STRING-AS-KEY (gettext style; missing key = English fallback),
  {placeholder} interpolation, catalogs compiled in (ja, zh-Hans, zh-Hant, es,
  fr, de, it — 7 locales + English fallback = 8 UI languages);
  locale follows the VIEWER (navigator.language; localStorage 'bento-lang'
  override; picker in About rebuilds the workspace). Language never enters the
  document format. select() localizes DISPLAY labels only (values stay model
  words). GOTCHAS: never call t() in module-level consts (frozen at import —
  translate at render time); keys must match source EXACTLY (validate with the
  extraction/diff script pattern in git history); setLocale('x-pseudo') audits
  unswept strings. New UI strings must be added to ALL catalogs.
- `src/charts.ts` — charts-lite, OUR OWN engine (ECharts removed for size:
  it was 630KB = 47% of the shell; git history has the integration). Same
  3-function API (CHART_PRESETS/mountChart/chartSnapshotSvg) interpreting the
  ECharts option SHAPE (format unchanged): bar/line/pie/scatter, nice-tick
  axes, legend, axis/item tooltips, inside wheel-zoom+drag-pan, transitions
  (same series types = numeric-leaf lerp of the whole option per frame;
  type change bar⇄pie = staged fade+sweep). Pure SVG on anim.ts. Options stay
  PURE JSON (template formatters {b}/{c}/{d}, never functions). Editor
  canvas/thumbs/print use chartSnapshotSvg (cached); present mounts live
  (host exposes `__bentoChart`). Unknown option keys are ignored gracefully —
  exotic ECharts configs degrade, don't crash. Bar/line series data must be
  PLAIN NUMBERS ({value,itemStyle} item objects coerce to 0 — only pie takes
  {name,value}); per-item bar colors unsupported, color by series. New charts
  (＋ Chart, preset switch, table→chart) inherit the deck's palette:
  `applyChartPalette` (model.ts) bakes `option.color` from `doc.theme.chartPalette`
  (optional format field; the starter deck declares peach/steel) or, absent that,
  `deriveChartPalette(accent)` (accent + a cool HSL counterpart, each tinted).
  tableToChart makes ONE series per numeric column (commas/`%` stripped, blanks→0,
  first column = x labels) — and when two columns sit on very different scales
  (or one reads as `%`) it auto-splits them onto a DUAL axis: bars on the left,
  the odd column as a line on a right-hand axis. **Dual y-axis (v0.9.6)**:
  `option.yAxis` may be an ARRAY of two value axes; a series picks one via
  `yAxisIndex` (0/1). renderCartesian computes a range per axis, shares gridline
  rows (2nd axis labels on the right, its own nice scale via `fixedTicks`), and
  honours per-axis `min`/`max` + `axisLabel.formatter` ('{value}%'). **Visual
  chart editor** (panels.ts buildChartProps): structured UI over the option —
  Type, Legend + Second-axis toggles, a Series list (name · bar/line · left/right
  axis · colour · remove), per-axis min/max, and an editable categories×series
  data grid (add/remove rows keep xAxis.data + every series.data in lockstep);
  pie gets a slices grid. The raw-JSON textarea stays as the 'Advanced (JSON)'
  escape hatch. **Live table binding (v0.9.8)**: `chart.source={tableId}` links
  a chart to a table — table→chart sets it by default. `model.syncLinkedChart`
  pushes the table's labels+numeric columns into the chart's option IN PLACE
  (data only; styling/axes preserved), and editor `syncLinkedCharts` re-derives
  on the current slide whenever a table changes (signature-guarded against
  loops; each collab replica derives identically from the synced table so no
  extra ops needed). Panel shows a link banner + Unlink. Shapes:
  `strokeStyle` solid/dashed/dotted (legacy `strokeDash` still honoured);
  line shapes have `lineStart`/`lineEnd` tips (arrow/dot/bar) rendered as
  per-instance svg markers (sized in strokeWidth units, endpoints inset);
  line color morphs tween the STROKE attr (lines paint stroke, not fill).
  Elements carry optional `shadow` {x,y,blur,color} — rendered as CSS
  drop-shadow in applyElementFrame (follows alpha shape: rounded corners,
  glyphs, image cutouts); panel offers presets (subtle/soft/elevated/glow),
  non-matching values show as 'custom'. Present-mode Reveal CONTROLS (corner
  arrows) default OFF (doc.present.controls re-enables).
- **Tables (v0.9.3)**: `table` element — a real HTML `<table>` (table-layout
  fixed) rendered by the shared render.ts (`renderTableHtml`), identical in
  editor/thumb/present/print. Model: `columns` fractional weights, `rows` of
  `{cells:[{html,align?,color?,bg?,bold?}]}`, `header` bool, `style` object
  (headerBg/Color, zebra, borderColor/Width, cellPad X/Y, fontSize, color,
  radius). Cells edit on canvas via contentEditable (canvas.ts editCellAt/
  commitCellEdit, mirroring text edit; Tab/Enter navigate, Tab off the end
  appends a row). Column widths drag via `.bento-col-handle` overlays
  (updateTableHandles/startColResize — live DOM update during drag, commit on
  release; needs real-mouse QA like Moveable). Panel: row/col steppers, header
  toggle, style presets (Lined/Zebra/Boxed/Minimal), colours, and a
  table→chart bridge (buildTableProps/tableToChart: first column = labels,
  first numeric column = series). Morphs as a BOX (cell content does not
  morph); under collab `rows` is a whole-value LWW register (concurrent
  different-cell edits are last-writer-wins — documented limitation).
- **Media (v0.9.16)**: `media` element (`kind` video|audio) mirrors image.
  HYBRID storage — `src` is a data: URI (embedded, self-contained), an external
  URL/relative path (referenced, small file), or `asset:`; the editor embeds
  picked files and `confirm()`s above `MEDIA_EMBED_BUDGET` (8MB, model.ts),
  offering a URL instead (browser file-pickers give bytes not a path, so
  "reference a local file" isn't possible — the URL field is the escape hatch).
  render.ts: real `<video>`/`<audio>` on canvas+present, a cheap poster/icon
  still in thumbnails (`svgAsImage`). Media is `pointer-events:none` on the
  canvas (gated by the `liveMedia` RenderOpt, present-only) so its native
  controls don't swallow Selecto selection. **Autoplay is NEVER set at render
  time** (would fire on the canvas and in every thumbnail) — present.ts
  `startMediaIn`/`pauseMediaIn` play flagged clips (`data-autoplay="1"`) on
  slide-enter and pause on exit/teardown; browsers need `muted` for video
  autoplay so `defaultMedia` mutes video. Panel 'Source & playback'
  (buildMediaProps): embedded/linked status+size, Choose/Replace file, URL,
  controls/autoplay/loop/muted, and (video) fit/corner/poster.
- **Diagram philosophy**: complex diagrams are ordinary Bento elements (rects, texts,
  `path` shapes) with groups — interactivity = linked state slides + morph (filters,
  era sequences), hover = focus-group, motion = fx.loop. Opaque `svg` elements are
  the fallback for geography/static artwork only.
- **Interactive states**: `Slide.stateOf` marks a slide as a hidden variant of another
  slide — skipped by linear navigation (← returns to parent, → continues past it),
  reached by element `link`s, morphing when ids are shared. Authoring: select an
  element → "＋ New state linked from this element" in the Presenting panel. States
  live adjacent to their parent and render nested in the sidebar.
- **Layouts**: `doc.layouts` (Slide-shaped templates) + built-ins in model.ts.
  Instantiating KEEPS element ids — slides from the same layout share ids, so
  their chrome morphs across transitions (and re-apply-by-lineage stays
  possible). Text `placeholder` prompts render dimmed in the editor and are
  hidden in present/print (`hidePlaceholders` RenderOpt). Picker on the
  New-slide button AND the insert-gaps; "Save slide as layout" + "Apply
  layout" in the slide panel. Apply (model.applyLayout) matches donors by id,
  then by `role` (title/subtitle/body/kicker — Role select in the element
  panel); layout supplies frame+typography, content rides along; layout-owned
  leftovers are dropped UNLESS they are text someone wrote; user extras stay.
- **Comments**: `Slide.comments` threads (author/at/text/replies/resolved) —
  saved in the file, editor-only (canvas markers + thread popover via
  editor/comments.ts; never in present/print). Anchors: element id, POINT
  (x/y slide coords — "📍 Comment at a point" arms a one-shot crosshair
  click, Esc cancels), or the slide. Author name in localStorage
  'bento-author'; unresolved threads badge the sidebar thumb. ONE entry
  point: the topbar 💬 tool (C) — armed click on an element anchors there,
  on empty canvas anchors the point; OFF the slide (grey canvas) anchors the WHOLE SLIDE; near-full-slide backdrops never
  capture (a comment on scenery means the spot). While armed, hover previews the pending anchor (amber outline on elements, pin+coords elsewhere); fresh markers pulse. `window.bento.comments()`
  returns the flat typed-anchor list — the entry point for AI agents
  processing flagged issues in a deck.
- **Hover content is in-slide, not states**: `showOnHover` sets + slide
  `hover:'reveal'` (with a default set) swap content on pointer-over. Editor previews
  one set at a time. Rule of thumb: click → state slide; hover → reveal set.
- **Speaker view**: OUR OWN popup (present.ts openSpeaker, S key) — current +
  next slide via renderSlide, notes, elapsed timer (click resets) + clock,
  synced on slidechanged, closed on present exit. Reveal's notes plugin is
  NOT used: its speaker window reloads the presentation URL in iframes,
  which boots the Bento EDITOR (a whole second app instance) — never
  reintroduce it. GOTCHA (fixed v0.9.7): opening the speaker popup while in
  real fullscreen makes the browser leave fullscreen, whose `fullscreenchange`
  would call `exit()` and END the show — `openingSpeaker` guards onFsChange and
  re-enters fullscreen. Escape stays a separate exit path, so the guard can't
  strand the presenter. **Dual-screen (v0.9.14)**: the Window Management
  permission CANNOT be requested during present — the S keypress activation is
  spent on window.open/requestFullscreen. So `src/screens.ts` holds the shared
  layout and the **editor's Slide panel** ("Presenter display" section) grants
  it via a dedicated click BEFORE presenting (`grantScreens`), caching the live
  ScreenDetails; the editor also `refreshScreensIfGranted()` at boot. present.ts
  `openSpeaker` reads `secondScreen()` synchronously and opens the notes popup
  directly on that display's coords; if none is set up it drops fullscreen so
  the notes aren't hidden. (The old in-present grant pill was removed.) Needs a
  real two-monitor rig for final QA.
- **Animation robustness**: slide exit kills tweens AND restores model frames; a
  2.8s wall-clock settle guarantee lands entrances on starved render loops; never
  put entrance tweens on motion-path elements (transform conflict).
- **Other format/runtime features**: `doc.fonts[]` (@font-face from assets at boot);
  PDF export via print CSS (`@page` sized 1600×900, states excluded); state
  "Sync from parent" (id-lineage merge — generators must emit deterministic
  element ids for it and for cross-state morphs); slide deletion cascades states
  and clears inbound links after confirm; `[`/`]` collapse the side panels.
- **Panel accordion**: every `.ed-section` header is retrofitted into a
  collapsible group after each rebuild (panels.applyAccordion) — open state
  persisted per title in localStorage; Presenting/Interactivity/Layout
  default closed. Add new panel content under a section header and the
  accordion picks it up automatically.
- `src/sync/` — **bento-sync live collaboration** (design: docs/collab-design.md).
  `crdt.ts` is the engine (pure data, runs in node too): element node
  identity is the COMPOSITE `slideId U+001F elementId` (elKey) — bare ids
  repeat across slides (the morph idiom), each per-slide copy is its own
  node, the format never sees composite keys, and cross-slide moves diff
  as del+ins (ord never re-parents); state+wire are versioned (SYNC_V:
  `v` in SyncStateJSON, `pv` on frames — pre-v2 saved sync state and
  frames are discarded, the file rejoins as a fresh adopt); per-(node,key)
  LWW regs ordered by (lamport, actor); liveness = births vs tombs (an INS is a
  whole-node ASSIGNMENT — it resurrects by out-stamping the tomb and
  supersedes all older property regs; slide-ins = slide assignment + an
  independent element-ins per member, member processing must NEVER be
  skipped by the slide-level LWW race); pos = fractional base-62 keys
  (keyBetween midstrings, spreadKey for deterministic file adoption);
  dead-window values park in a reg-stamped `stash` and replay on
  resurrection ONLY while their reg is still the winner; element.html is a
  token RGA whose seed = (max(reg,birth).l, contentHash) so concurrent
  first-editors merge — a GENERATION duels plain sets as a unit, rebirths
  void only seeds BELOW their lamport; delivery = per-actor contiguous `s`
  + gap buffer + `pending` for not-yet-known nodes (drain on every liveness
  event AND on txt progress — anchors/deletes can overtake their inserts).
  Convergence rig: `node scripts/test-sync.ts` (SEEDS/STEPS/ACTORS env) —
  run it after ANY crdt.ts change; it caught 15+ ordering bugs. Debug: set
  `globalThis.__dbgEl = '<node-id>'` to trace one node through the gates.
  `session.ts` bridges the store: local commits → debounced (90ms) shadow
  diff → ops; remote ops apply surgically then re-emit the store events the
  editor already listens to (zero editor rewrites). Actor ids are fresh PER
  SESSION INSTANCE (a reloaded tab is a new replica; the engine skips "own"
  ops on apply — a persisted actor id would make relay replay a no-op).
  Same-machine tabs always sync (BroadcastChannel `bento-sync-<docId>`);
  `online.ts` adds the E2EE relay (AES-GCM, key in `doc.collab.key`, ?tok=
  hash-of-key possession proof; replay bookmark is MEMORY-ONLY — it's valid
  only with the CRDT state it was earned with). Credentials are minted AT
  CREATION (session.attach → mintCollab: RANDOM room id, never docId —
  re-share/fork rooms can't collide and the relay learns nothing), dormant
  until `collab.on` (absent = true for v0.8.0 files); "Rotate keys" is
  revocation. The saved FILE is the capability: opening a copy auto-joins
  (editor.connectSync joinIfShared). Saves stamp `doc.collab.sync`
  (SyncStateJSON via session.stampInto) so a copy edited OFFLINE rejoins as
  a true fork: restored regs defend its edits, relay replay vv-dedups, and
  a fork `snap` frame carries its state to peers (mergeSnapshot) — merge is
  two-way, verified under partition. hello replies include a `need` (ops
  minted before connecting flow back); onRelayReady re-sends log ops the
  room's replay lacked. "Duplicate as new deck…" (About) = identity fork:
  new docId + fresh creds, never syncs with its ancestor. Relay:
  `server/sync-worker/` (blind DO, ciphertext-only storage — verified;
  `npx wrangler dev --port 8787` + localStorage 'bento-sync-url' for local
  testing; NEVER pipe wrangler dev through `head` — SIGPIPE kills it).
  **The DO MUST use the WebSocket Hibernation API** (`state.acceptWebSocket` +
  `webSocketMessage`/`webSocketClose` handlers, `getWebSockets()` for fan-out,
  per-socket state via `serializeAttachment`) — plain `server.accept()` keeps
  the invocation alive for the whole connection and throws "Exceeded allowed
  duration in Durable Objects free tier", which silently breaks ALL live
  collab (the bug behind v0.9.7). The relay must be redeployed
  (`wrangler deploy`) for worker changes to take effect — the app shell release
  does NOT touch it.
  Undo under collab is snapshot-based and may revert concurrent remote
  edits to the same properties (documented LWW compromise).
- `src/editor/` — vanilla-TS editor. Moveable + Selecto handle manipulation.
  Interaction modifiers: Shift = keep-ratio resize / axis-locked drag / 15°
  rotate snap; Alt/Option = resize from CENTER (deep-select exempts
  Moveable's control box, so Alt-on-a-handle means center-scale);
  ⌘/Ctrl-drag = duplicate (originals move, copies stay — one undo step;
  Alt on element bodies stays deep-select). Selecto's container/
  dragContainer is the SCROLLER (not the stage) — marquees must be able
  to start on the grey surround, the natural gesture; floating controls
  (FABs/zoombar/chevrons) are exempted in the selecto dragStart guard.
  Pane testing: synthetic drags on Moveable HANDLES don't register at
  all (verified against pre-change code too) — resize behavior needs a
  real mouse. Present: real fullscreen via overlay.requestFullscreen at start +
  F toggle (denied requests degrade to tab-fill — that IS the testing/
  sharing mode). Topbar is responsive by HIDING TEXT, never scrolling: labels
  collapse to icons <1200px, the wordmark collapses to the mark <760px.
  Panel show/hide lives ON the resizer strips as chevron tabs (docked
  flush to the screen edge when collapsed); phones (<700px) boot with
  both panels collapsed (canvas-first; chevrons/[/] bring them back).
  Update chip sits beside the wordmark and exists ONLY when an update
  is found. Present lives as FLOATING buttons at the canvas's BOTTOM-LEFT
  (zoombar owns the right corner): big round FAB = fullscreen present,
  small one BESIDE it (never above — it would cover the slide) =
  tab-fill mode (testing/window-sharing); both call editor.present(
  fromStart, fullscreen) → startPresentation opts.fullscreen. Leaving
  fullscreen (Esc/F/browser UI) ENDS the show — it never drops to
  tab-fill (fullscreenchange listener; tab mode only via the small
  FAB). Touch: our own swipe nav (Reveal touch OFF — it would walk
  into hidden states); swiping past either end exits to the editor.
  Deck PAGE SIZE: presets + custom in the slide panel (doc.size —
  already per-doc in the format); canonical 16:9 = 1280×720 (matches
  the model default; presets use exact-px matching); print @page is
  generated per-deck (width normalised to 1600, height follows
  aspect). Size changes reframe the canvas, never rescale elements.
  FULLSCREEN paints only the fullscreened element's subtree — anything
  body-mounted (chart tooltips!) must reparent into
  document.fullscreenElement while it's active. Save is a dropdown: copy (identity-keeping invite) / new
  deck (fresh identity) / template. "Live" button popover: name field,
  collaborator list (click follows), join/leave toasts. Deck buttons use
  ONE invisible hit-rect above button+label (hard-won #7) — never put
  `link` on both a rect and its label text (two mismatched hover pills).
  Alt/Option-click digs through overlapping elements (capture-phase, beats
  Moveable's control box). Fill/stroke colors carry alpha (color input + % pair,
  rgba round-trip); shapes support `fillGradient` (linear, CSS-convention angle,
  multi-stop) — rendered as per-instance svg `<defs>` gradients (unique ids:
  url(#…) refs are document-global across canvas/thumbs/present). Arrange kit in
  the panel: align/distribute/z-step + Group (⌘G/⇧⌘G — `groupId`, distinct from
  presentation `group`; click selects the group, Alt-click reaches a member;
  duplicate remaps groupIds). Text editing supports ⌘B/I/U plus markdown
  autoformat (editor/markdown.ts: **bold** *italic* `code` ~~strike~~ and "- "
  bullets collapse as typed — mind contentEditable NBSPs and stale
  Selection offsets after DOM surgery; pasted plain text converts too).
  Escapes: backslash before a marker keeps it literal (stripped at commit);
  ⌘Z immediately after a conversion restores the typed markers (one-shot,
  cleared by the next input). Note markdown.ts carries LITERAL invisible
  chars (NBSP, ZWSP, U+E000) — they don't survive retyping; edit that file
  with line-targeted scripts, not copy-typed strings.
  Sidebar has hover insert-gaps between thumbnails (never between a parent and
  its states). Selecto's continue-select list is synced in syncTargets — stale
  cross-slide shift-click selections were a real bug.

## Hard-won details — do not regress

1. **Moveable in a scaled canvas**: the control box mounts INSIDE `.ed-stage-scale`
   (the `transform: scale()` wrapper) with `rootContainer: document.body`, and
   `moveable.zoom = 1/scale` on relayout. Then all Moveable event coords are in
   slide-local px. Mounting it outside the scaled wrapper gives garbage coordinates.
2. **Don't reset `moveable.target` to an identical array** — gesture listeners re-attach
   a frame later and a drag started in that frame is swallowed (`syncTargets` checks).
3. **`querySelector('[data-el-id=…]')` is ambiguous** — sidebar thumbnails contain the
   same ids as the canvas. Always scope to the surface (`.ed-stage-scale …`).
4. **Never let a literal `</script>` into the bundle** — `save.ts` builds it by
   concatenation; the data block JSON escapes `<`.
5. Reveal's `.reveal-viewport` paints white; the present overlay CSS overrides it black.
6. **svg-element CSS must be scoped** (`render.ts scopeCss`) — svg `<style>` applies
   document-wide, so one diagram's animation/dim rules would leak into every other
   svg on the page (CSS animations with fill modes even beat later static rules).
7. Tiny text labels make unusable click targets when scaled down — interactive
   controls get padded transparent `link` overlay rects, not links on the text itself.

- **Compressed shell (Phase 1)**: `scripts/postbuild-compress.mjs` (runs in
  build:single) deflates runtime JS+CSS into base64 `bento/deflate-b64` script
  blocks + ~1KB loader (DecompressionStream → blob import; pre-2023 browsers
  get a plain-HTML message). Byte order: chrome → NOTICE → tooling comment →
  PLAINTEXT #bento-doc → splash → payloads last. Shell ~373KB (was 1.33MB).
  SPLICE CONTRACT (old updaters are frozen code): #bento-doc stays plaintext/
  same id, file survives DOMParser→splice→outerHTML, no stray script-close —
  release.mjs runs a conformance GATE before signing every release.
- **AI round-trip**: the DOCUMENT is the interchange unit (chat AIs can't emit
  1MB+ files). About → "Copy document JSON" / "Replace document from JSON…"
  (store.replaceDoc, undoable); `window.bento.loadDoc(json)` for scripts; the
  shell carries a Tooling-note comment pointing AIs at #bento-doc + the API.
  Agent harnesses edit files in place; chat AIs round-trip the JSON.

## Commands

- `npm run dev` (in slides/) — dev server; `.claude/launch.json` has `slides-dev` (:5199)
  and `serve-built` (:5198, serves dist-single).
- `npm run build:single` — the shippable `dist-single/Bento_Slides.bento.html`.
- In-page scripting/testing API: `window.bento` → `{ doc, serialize() }`.

## Testing gotcha

Synthetic `PointerEvent`s do NOT trigger Moveable/Selecto (Gesto listens for mouse
events) — dispatch `MouseEvent`s, or use trusted input. After changing selection, wait a
frame before starting a synthetic drag.
