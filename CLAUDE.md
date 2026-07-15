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
  tween straight from the model values. Elements can carry `fx` (enter stagger,
  countUp, ken-burns ambient) and `link` (click → jump to slide id) — both run only
  in present mode; the editor ignores them (no UI yet).
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
