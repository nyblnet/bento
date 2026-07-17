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
- `src/render.ts` — single model→DOM renderer shared by editor canvas, thumbnails, and
  Reveal sections. Elements carry `data-el-id` (editing) and `data-flip-id` (morph).
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
- `src/update.ts` — signed self-update: About dialog (topbar logo) checks a
  release manifest ON USER CLICK ONLY (`bento.page`; dev override localStorage
  'bento-update-url'), verifies ECDSA P-256 signature against the embedded
  PUBLIC_KEY_JWK + sha256 of the fetched shell + version monotonicity, then
  re-splices the current doc into the new shell (`save.serializeWith`) and
  downloads it as a NEW file (original untouched = rollback). APP_VERSION baked
  from package.json via vite define. Private key: `scripts/keygen.mjs` →
  `~/.bento/release-key.json` (offline, NEVER commit/CI); sign releases with
  `scripts/sign-release.mjs`. Docs carry a stable `docId` (uuid, minted at
  creation/load) — identity for future sync/merge; never regenerate it.
  Scripting: `window.bento.updates.{version,check,build,apply}`.
- `src/charts.ts` — ECharts (Apache-2.0, svg renderer only, tree-shaken:
  bar/line/pie/scatter + grid/tooltip/legend/dataZoom/title/dataset). A `chart`
  element stores a PURE-JSON option (template-string formatters, never
  functions — the doc must serialize). Editor canvas/thumbnails/print show
  cached SSR SVG snapshots (chartSnapshotSvg); present mode mounts live
  instances (tooltips + dataZoom work), disposed back to snapshots on slide
  exit. Live node exposes `__bentoChart` for scripting. Panel: preset select
  re-seeds the option; JSON textarea is the escape hatch. NOTICE block in
  index.html carries MIT + Apache/BSD notices into every saved document.
  Charts on morph/state transitions data-morph: the incoming chart paints the
  outgoing side's option first, then setOption's to its own with
  universalTransition (values tween in place, bar⇄pie works). Shapes:
  `strokeStyle` solid/dashed/dotted (legacy `strokeDash` still honoured);
  line shapes have `lineStart`/`lineEnd` tips (arrow/dot/bar) rendered as
  per-instance svg markers (sized in strokeWidth units, endpoints inset);
  line color morphs tween the STROKE attr (lines paint stroke, not fill).
  Elements carry optional `shadow` {x,y,blur,color} — rendered as CSS
  drop-shadow in applyElementFrame (follows alpha shape: rounded corners,
  glyphs, image cutouts); panel offers presets (subtle/soft/elevated/glow),
  non-matching values show as 'custom'. Present-mode Reveal CONTROLS (corner
  arrows) default OFF (doc.present.controls re-enables).
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
  reintroduce it.
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
- `src/editor/` — vanilla-TS editor. Moveable + Selecto handle manipulation.
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

## Commands

- `npm run dev` (in slides/) — dev server; `.claude/launch.json` has `slides-dev` (:5199)
  and `serve-built` (:5198, serves dist-single).
- `npm run build:single` — the shippable `dist-single/Bento_Slides.bento.html`.
- In-page scripting/testing API: `window.bento` → `{ doc, serialize() }`.

## Testing gotcha

Synthetic `PointerEvent`s do NOT trigger Moveable/Selecto (Gesto listens for mouse
events) — dispatch `MouseEvent`s, or use trusted input. After changing selection, wait a
frame before starting a synthetic drag.
