# Bento — self-contained office documents

One HTML file = the document + viewer + editor. See `README.md` for the vision.
`slides/` is the first app (PowerPoint replacement); docs and sheets come later.

## Architecture (slides/)

- `src/model.ts` — the `bento/slides` JSON document model + starter deck. This is the format.
- `src/save.ts` — the self-save trick: clone the document at boot (`capturePristine`),
  swap the `#bento-doc` data block, re-serialize. JSON is `<`-escaped (`<`) so it can
  never contain `</script>`. File System Access API first, download fallback.
- `src/render.ts` — single model→DOM renderer shared by editor canvas, thumbnails, and
  Reveal sections. Elements carry `data-el-id` (editing) and `data-flip-id` (morph).
- `src/present.ts` — Reveal.js overlay; slides with `transition:'morph'` use GSAP Flip:
  matched `data-flip-id` elements animate geometry via Flip, style props (fill/color)
  tween straight from the model values. Elements carry `fx` (enter stagger — equal
  `order` = simultaneous, countUp, ken-burns, `loop` dash-march/motion-path), `link`
  (click → slide id) and `group`; slides can set `hover:'focus-group'` (dim other
  groups). Present arrows are handled capture-phase (focus-proof). Editing UI for
  fx/link lives in the panel's "Presenting" section. Motion-path loops are edited
  visually on canvas (`editor/patheditor.ts`): draggable anchors auto-smoothed
  Catmull-Rom→cubic bezier; the stored path is RELATIVE to the element's rest
  position (first anchor = rest position; committing moves the element there).
- **Diagram philosophy**: complex diagrams are ordinary Bento elements (rects, texts,
  `path` shapes) with groups — interactivity = linked state slides + morph (filters,
  era sequences), hover = focus-group, motion = fx.loop. Opaque `svg` elements are
  the fallback for geography/static artwork only.
- **Interactive states**: `Slide.stateOf` marks a slide as a hidden variant of another
  slide — skipped by linear navigation (← returns to parent, → continues past it),
  reached by element `link`s, morphing when ids are shared. Authoring: select an
  element → "＋ New state linked from this element" in the Presenting panel. States
  live adjacent to their parent and render nested in the sidebar.
- **Hover content is in-slide, not states**: `showOnHover` sets + slide
  `hover:'reveal'` (with a default set) swap content on pointer-over. Editor previews
  one set at a time. Rule of thumb: click → state slide; hover → reveal set.
- **Animation robustness**: slide exit kills tweens AND restores model frames; a
  2.8s wall-clock settle guarantee lands entrances on starved render loops; never
  put entrance tweens on motion-path elements (transform conflict).
- **Other format/runtime features**: `doc.fonts[]` (@font-face from assets at boot);
  PDF export via print CSS (`@page` sized 1600×900, states excluded); state
  "Sync from parent" (id-lineage merge — generators must emit deterministic
  element ids for it and for cross-state morphs); slide deletion cascades states
  and clears inbound links after confirm; `[`/`]` collapse the side panels.
- `src/editor/` — vanilla-TS editor. Moveable + Selecto handle manipulation.

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
