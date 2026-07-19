# The `bento/slides` document format

*Normative reference for the JSON document model, current as of Bento Slides
**v0.9.20** (format version `1`). The authoritative source is
[`slides/src/model.ts`](../slides/src/model.ts) — this document tracks it. If
the two disagree, the code wins; please file that as a docs bug.*

A `.bento.html` file carries one JSON document inside a single plaintext block:

```html
<script type="application/bento+json" id="bento-doc">
{ "format": "bento/slides", "version": 1, ... }
</script>
```

Everything else in the HTML file is the fixed *shell* (the runtime, styles,
license notices). The document block is the only part that changes between
saves. See [architecture.md](architecture.md) for how the file is built and
saves itself; this document specifies the JSON.

This spec is for people writing tools, generators, or agents against the
format. If you want to *author a good-looking deck*, read
[agents.md](agents.md) — it maps content to the right feature. This one is the
dry reference of every field.

---

## Conventions

- **Coordinates** are pixels in the slide space defined by `doc.size` (default
  `1280 × 720`, a 16:9 canvas). `x,y` is an element's top-left corner.
- **Colors** are any CSS color string, including `rgba(...)` for alpha.
- **Angles** are degrees. Rotation is clockwise. Gradient angles follow the CSS
  convention (`0` = bottom→top, `90` = left→right).
- **Ids are identity.** Elements that share an `id` across adjacent slides
  *morph* into each other; slide `stateOf` and element `link` both reference
  slide ids. Generators must emit deterministic, stable ids.
- **Additive & forward-compatible.** Unknown fields are preserved through
  parse → serialize. Old files must open in newer shells. Never repurpose or
  remove a field; add optional ones.
- **Pure data.** Text HTML is sanitized to an inline whitelist; chart options
  are pure JSON (no functions). A document can never carry executable code.
- **Self-contained.** Everything a view needs is in the file. External
  references (image/media URLs) are allowed but break the offline guarantee;
  embedded `data:`/`asset:` sources keep it intact.

When writing the JSON into the file block, **escape every `<` as `<`** so
the string `</script>` can never appear and terminate the block.

---

## Top-level: `BentoDoc`

| Field | Type | Required | Notes |
|---|---|---|---|
| `format` | `"bento/slides"` | yes | Format discriminant. Check it before editing. |
| `version` | `number` | yes | Format version. Current: `1`. |
| `docId` | `string` (uuid) | yes* | Stable per-document identity, minted at creation. **Never regenerate it.** *Minted on load if a pre-`docId` file lacks one. |
| `title` | `string` | yes | Deck title; also synced to the HTML `<title>`. |
| `size` | `{ width, height }` | yes | Slide coordinate space in px. Default `1280 × 720`. |
| `theme` | `Theme` | yes | Deck-wide defaults (see below). |
| `slides` | `Slide[]` | yes | Linear order; state slides sit right after their parent. Must be non-empty. |
| `modified` | `string` (ISO) | yes | Last-modified timestamp. |
| `present?` | `{ slideNumber?, controls?, progress? }` | no | Present-mode Reveal chrome toggles. |
| `assets?` | `Record<string,string>` | no | Shared blobs (raw SVG markup or `data:` URIs), referenced by key as `"asset:<key>"`. |
| `fonts?` | `Array<{ family, asset, weight?, style? }>` | no | Embedded `@font-face`s injected at boot; `asset` is a key into `assets` (a woff2 data URI). |
| `layouts?` | `Slide[]` | no | Slide-shaped templates (see [Layouts](#layouts)). Absent = the built-in starter layouts are offered. |
| `collab?` | `Collab` | no | Live-collaboration credentials + CRDT state (see [Collaboration fields](#collaboration-fields)). |
| `template?` | `boolean` | no | Template file: every open mints a fresh `docId` and drops `collab` (see [File modes](#file-modes)). |
| `readonly?` | `boolean` | no | Player file: boots straight into the presentation, no editor. |

### `Theme`

| Field | Type | Notes |
|---|---|---|
| `background` | `string` | Default slide/canvas background. |
| `color` | `string` | Default text color. |
| `accent` | `string` | Single accent color; also seeds derived chart palettes. |
| `fontFamily` | `string` | Default font stack. |
| `chartPalette?` | `string[]` | Ordered series colors for new charts. Absent = derived from `accent`. |

---

## `Slide`

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | `string` | yes | Stable slide id. Link + morph targets reference it. |
| `background` | `string` | yes | Slide background (CSS color). |
| `transition` | `TransitionKind` | yes | `none \| fade \| slide \| zoom \| morph`. `morph` tweens matched element ids from the previous slide. |
| `elements` | `SlideElement[]` | yes | **Array order = paint order (z).** First element is at the back. |
| `notes` | `string` | yes | Speaker notes (travel in the file; shown in speaker view). |
| `name?` | `string` | no | Friendly label for link pickers / state badges. |
| `stateOf?` | `string` | no | Marks this slide a hidden *state* variant of the slide with this id (see [Interactive states](#interactive-states)). |
| `hover?` | `{ type, dim?, default? }` | no | Present-mode hover behaviour: `type: 'focus-group'` (dim elements outside the hovered group) or `'reveal'` (`showOnHover` set swap; `default` names the resting set). |
| `comments?` | `Comment[]` | no | Review threads. Editor-only — never rendered in present/print, but saved in the file. |

### `Comment`

`{ id, author, text, at (ISO) }` plus an optional anchor and thread:

- Anchor: `elementId?` (thread pinned to an element), or `x?`/`y?` (a point in
  slide coordinates), or neither/dangling (the whole slide).
- `resolved?: boolean`; `replies?: Array<{ id, author, text, at }>`.

`window.bento.comments()` returns the flat, typed-anchor list — the entry point
for tooling that processes flagged issues in a deck.

---

## Elements

Every element carries the common `ElementBase` fields, plus type-specific ones.

### `ElementBase` (shared by all)

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Identity. Shared ids across adjacent slides morph. |
| `x, y, w, h` | `number` | Frame in slide px (top-left origin). |
| `rotation` | `number` | Degrees, clockwise. |
| `opacity` | `number` | `0..1`. |
| `shadow?` | `ShadowSpec \| ShadowSpec[]` | Drop shadow(s): `{ x?, y?, blur, color }`. An array stacks (e.g. elevation + glow). Follows the element's alpha shape. |
| `fx?` | `Fx` | Presentation behaviour — runs in present mode only (see [`fx`](#fx-presentation-effects)). |
| `link?` | `string` | While presenting, clicking jumps to this slide id. |
| `group?` | `string` | Semantic group tag — hover focus + multi-element present behaviours target it. |
| `groupId?` | `string` | *Editor* grouping (select/move as one). Distinct from `group`. |
| `showOnHover?` | `string` | In-slide hover reveal: visible only while an element whose `group` equals this value is hovered (with `slide.hover.type='reveal'`). |
| `role?` | `string` | Layout role (`title`/`subtitle`/`body`/`kicker` by convention) — drives cross-layout content moves. Free-form. |

The element `type` discriminant is one of: `text`, `shape`, `image`, `svg`,
`chart`, `table`, `media`.

### `text`

`type: "text"` — `html` (sanitized inline subset: `b/i/u/s/code/br/span`),
`fontSize`, `fontFamily`, `fontWeight`, `color`, `align` (`left|center|right`),
`valign` (`top|middle|bottom`), `lineHeight`. Optional `letterSpacing` (px) and
`placeholder` (a dimmed prompt shown while `html` is empty; hidden in
present/print).

Text also resolves dynamic-field tokens at render time — `{{page}}`,
`{{pages}}`, `{{title}}`, `{{date}}`, `{{time}}` — with an optional zero-pad
width on page/pages (`{{page:2}}` → `06`). The model stores the raw token;
only the rendered output is resolved, so numbering re-flows when slides move.

### `shape`

`type: "shape"` — `shape: rect | ellipse | triangle | arrow | line | path`,
plus `fill`, `stroke`, `strokeWidth`, `radius` (rect corner). Options:

- `fillGradient?`: `{ angle, stops: [{ at: 0..1, color }] }` — linear gradient;
  when set it wins over `fill` (kept as the solid fallback).
- `strokeStyle?`: `solid | dashed | dotted` (wins over legacy `strokeDash?`).
- **line** shapes take their color from `fill`, draw horizontally across the
  box (rotate for vertical), and accept tips `lineStart?`/`lineEnd?` =
  `none | arrow | dot | bar`.
- **path** shapes carry `d?` (SVG path data) authored in the `pathBox?`
  viewBox `[x, y, w, h]`.

### `image`

`type: "image"` — `src` (a `data:` URI or `"asset:<key>"`), `fit`
(`contain|cover|fill`), `radius`. Embed images as `data:` URIs in `doc.assets`
and reference them to keep the file self-contained.

### `svg`

`type: "svg"` — `asset?` (key into `doc.assets` holding raw SVG markup;
preferred, dedupes) or `markup?` (inline SVG). `css?` is injected inside the
svg and scoped to it at render (hover/focus/animation styles stay contained).
Prefer composing native `shape`/`text`/`path` elements when they can morph;
use `svg` for static artwork/geography.

### `chart`

`type: "chart"` — `option` is a **pure-JSON, ECharts-*shaped*** option object
(the format is ECharts-compatible; the renderer is the in-house `charts-lite`
engine, not ECharts). Static SVG snapshots on the editor canvas / thumbnails /
print; a live interactive instance (tooltips, wheel-zoom, drag-pan) while
presenting.

- `preset?`: `bar | line | pie | scatter` — the panel's re-seed key.
- `source?`: `{ tableId }` — live binding; the chart's labels + series values
  track that table element (data only; styling/axes preserved).

**Chart rules that bite:**

- Bar/line series `data` must be **plain numbers**. `{value, itemStyle}` item
  objects coerce to `0`; only **pie** takes `{name, value}`.
- Color **by series**, not per bar — per-item bar colors are unsupported.
- Formatters are **template strings only** (`{b}`, `{c}`, `{d}`) — never
  functions (they can't serialize).
- **Dual y-axis**: `yAxis` may be an array of two `{type:"value"}` axes; a
  series selects one via `yAxisIndex: 0|1`. Give the second axis
  `axisLabel:{formatter:"{value}%"}` for a percentage scale.
- Unknown option keys degrade gracefully (ignored, never fatal).

### `table`

`type: "table"` — a real HTML `<table>` (table-layout fixed), rendered
identically on canvas/thumbnails/present/print.

- `columns`: `Array<{ w }>` — fractional column weights, normalised at render.
- `rows`: `Array<{ cells: TableCell[] }>` where `TableCell` = `{ html, align?,
  color?, bg?, bold? }` (`html` is the same sanitized inline subset as text).
- `header`: `boolean` — treat row 0 as a styled header.
- `style`: `TableStyle` = `{ headerBg, headerColor, zebra?, borderColor,
  borderWidth, cellPadX, cellPadY, fontSize, fontFamily?, color, radius }`.

Cohesion lives in `style`; cells carry only overrides. Morphs as a box —
cell *content* does not morph. Under live collaboration `rows` is a whole-value
LWW register (concurrent different-cell edits are last-writer-wins).

### `media`

`type: "media"` — `kind: video | audio`, `src` (a `data:` URI = embedded, an
external URL / relative path = referenced, or `"asset:<key>"`). Video also
takes `poster?` (`data:`/`asset:`/URL), `fit?` (`contain|cover|fill`),
`radius?`. Playback flags: `controls?`, `autoplay?`, `loop?`, `muted?`.

- **Autoplay fires only in present mode** (never on the canvas or in
  thumbnails), and browsers require `muted: true` for a video to autoplay — so
  `defaultMedia` mutes video by default.
- Embed only **short** clips. The editor warns above `MEDIA_EMBED_BUDGET`
  (8 MB) and offers a URL instead — a big data URI makes the file slow to open
  and save.

---

## `fx` (presentation effects)

All `fx` behaviour runs in **present mode only**.

| Field | Type | Meaning |
|---|---|---|
| `enter?` | `'fade-up' \| 'fade' \| 'fade-down' \| 'slide-left' \| 'slide-right' \| 'slide-up' \| 'slide-down'` | Entrance animation. `fade-*` nudge ~16px; `slide-*` sweep ~120px from an edge. Only runs on non-morph arrivals. |
| `order?` | `number` | Stagger step in the entrance sequence; **equal values enter together**. |
| `countUp?` | `boolean` | Animate numeric parts of the text from 0 to their final value. |
| `ambient?` | `'kenburns'` | Continuous ambient motion for full-bleed photos. |
| `ken?` | `{ dir?, scale?, duration? }` | Ken-burns tuning. `dir: 'drift'` (default) is an endless slow yoyo zoom; `'out'`/`'in'` play once per slide entry (`'out'` starts zoomed by `scale` and settles). `duration` in seconds. |
| `loop?` | dash-march or motion-path | Continuous loop (below). |

`loop` is one of:

- `{ type: 'dash-march', distance?, duration? }` — marching dashed strokes.
- `{ type: 'motion-path', path, duration, delay?, ease?, speeds? }` — the
  element travels an SVG path **relative to its rest position** (the first
  anchor is `0,0`). `ease` sets per-lap tempo; `speeds[]` gives per-anchor speed
  multipliers (`1` = normal, `<1` dwells, `>1` rushes; length matches the
  anchor count). Never combine a motion-path loop with an entrance tween.

---

## Interactive states

A slide with `stateOf: "<parent-id>"` is a hidden variant of its parent:

- Skipped by linear navigation. Reached only by element `link`s.
- While on a state, `ArrowLeft` returns to the parent, `ArrowRight` continues
  *past* it.
- If it shares element ids with its parent (or a sibling state) and the
  transition is `morph`, the matched elements glide between the two.

State slides live adjacent to their parent in `slides[]` and render nested in
the editor sidebar. A clickable trigger should be a padded transparent hit
rect, not the label text itself.

---

## Layouts

`doc.layouts` holds `Slide`-shaped templates (plus the built-ins in `model.ts`).
Instantiating a layout **keeps element ids** — slides born from the same layout
share ids, so their common chrome morphs across transitions and stays traceable
for a re-apply merge.

Applying a layout to an existing slide matches donors first by id, then by
`role` (same element type required); the layout supplies frame + typography
while content (text `html`, `link`) rides along. Layout-owned leftovers are
dropped unless they are text someone actually wrote; user extras survive on top.

---

## Collaboration fields

`doc.collab` is optional and additive; a file with no `collab` opens as a
standalone document forever. Full design and threat model:
[collab-design.md](collab-design.md).

| Field | Type | Notes |
|---|---|---|
| `room` | `string` | Relay WebSocket URL. Room id is **random** — never derived from `docId`. Signed-scheme rooms start `w`; legacy rooms start `r`. |
| `key` | `string` | base64url AES-GCM room key — the **read** capability. Travels in every copy. |
| `on?` | `boolean` | Gates auto-join. Absent = `true` (v0.8.0 files only carried `collab` while actively shared). |
| `sync?` | `SyncStateJSON` | CRDT state (registers / liveness / text) stamped at save on shared documents. Lets an offline-edited copy rejoin as a true fork and merge two-way. Never transmitted as ops. |
| `writerPub?` | `string` | ECDSA P-256 public key (raw SPKI, base64url) — the **write** capability's public half. Travels in every copy; the relay verifies authorship against it. |
| `writerPriv?` | `string` | ECDSA private key (PKCS#8, base64url). Travels **only** in writer copies. A read-only copy is a writer copy with this stripped. |
| `role?` | `'writer' \| 'reader'` | `'reader'` = a live viewer: receives updates, never sends. |

Possession of a copy is the capability; **"Rotate keys" re-mints them to cut
old copies off** (and upgrades a legacy `r`-room to an enforced `w`-room).

---

## File modes

| Mode | Set by | Behaviour |
|---|---|---|
| **Editable deck** | (default) | Boots the editor; saves rewrite the file in place. |
| **Template** | `template: true` | Every open mints a fresh `docId` and drops `collab` (`parseDoc` strips the flag) — each opener gets an independent deck. The template file itself never changes. |
| **Player / presentation package** | `readonly: true` | Boots straight into the presentation; never shows the editor. Collab is stripped from the saved copy. |
| **Read-only live viewer** | `collab.role: 'reader'` (`writerPriv` stripped) | Boots the editor locked; receives live updates but the relay drops any write. |

Encryption is orthogonal: the `#bento-doc` block may hold a `bento/enc`
envelope (PBKDF2-SHA-256 + AES-GCM over the doc JSON) instead of plaintext
document JSON — boot shows a password gate. The envelope is still plaintext
JSON in the block, so the splice contract holds.

---

## Format invariants (do not break)

1. `format: "bento/slides"` plus **additive, optional** fields — old files open
   in newer shells; unknown fields survive parse → serialize.
2. Element **ids are identity** — morph, states, and links all key off them.
   Generators must emit deterministic ids.
3. The data-block JSON stays `<`-escaped; text HTML and chart options stay pure
   data (no functions, sanitized HTML) — a document can never smuggle code.
4. Asset references are `asset:` keys into `doc.assets`; a self-contained file
   fetches nothing external at view time.
5. Motion paths are stored **relative** to the element's rest position; the
   first path anchor is that position by definition.
6. Every document carries a stable `docId` — never derive it from content,
   never regenerate it on save.

## Minimal valid document

```json
{
  "format": "bento/slides",
  "version": 1,
  "title": "My deck",
  "size": { "width": 1280, "height": 720 },
  "theme": {
    "background": "#101418", "color": "#F2F0EA",
    "accent": "#FF9E8A", "fontFamily": "system-ui, sans-serif"
  },
  "slides": [
    {
      "id": "s1", "background": "#101418", "transition": "none",
      "notes": "speaker notes here",
      "elements": [
        {
          "id": "t1", "type": "text",
          "x": 96, "y": 260, "w": 1088, "h": 160,
          "rotation": 0, "opacity": 1,
          "html": "Hello from a tool.",
          "fontSize": 88, "fontFamily": "system-ui, sans-serif",
          "fontWeight": 800, "color": "#F2F0EA",
          "align": "left", "valign": "top", "lineHeight": 1.1
        }
      ]
    }
  ],
  "modified": "2026-07-19T00:00:00.000Z"
}
```

`docId` is omitted above for brevity — `parseDoc` mints one on load. When a
tool *creates* a document from scratch, generate a fresh uuid for `docId`.
