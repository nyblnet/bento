# Bento for AI agents

*Drop this file into your context (or point your harness at it) and you can
author and edit Bento presentations directly. Also published at
[bento.page/agents.md](https://bento.page/agents.md).*

A Bento deck (`*.bento.html`) is a self-contained HTML file. The document
lives in ONE plaintext block near the top:

```html
<script type="application/bento+json" id="bento-doc">
{ "format": "bento/slides", ... }
</script>
```

Two ways to work with it:

1. **File harness** (Claude Code, agent sandboxes): edit the JSON inside the
   `#bento-doc` block in place. Escape every `<` in the JSON as `\u003c`
   so the block can never contain a literal `</script>`. Leave everything else in the
   file untouched.
2. **Chat round-trip** (any chatbot): the user copies the JSON out via
   *About → Copy document JSON*, you return a full replacement document,
   they paste it back via *About → Replace document from JSON…* (undoable).
   In the browser console: `window.bento.doc` (read) /
   `window.bento.loadDoc(json)` (write, undoable).

## Minimal valid document

```json
{
  "format": "bento/slides", "version": 1, "title": "My deck",
  "size": { "width": 1280, "height": 720 },
  "theme": { "background": "#101418", "color": "#F2F0EA",
             "accent": "#FF9E8A", "fontFamily": "system-ui, sans-serif" },
  "slides": [
    { "id": "s1", "background": "#101418", "transition": "none",
      "notes": "speaker notes here",
      "elements": [
        { "id": "t1", "type": "text", "x": 96, "y": 260, "w": 1088, "h": 160,
          "rotation": 0, "opacity": 1,
          "html": "Hello from an agent.",
          "fontSize": 88, "fontFamily": "system-ui, sans-serif",
          "fontWeight": 800, "color": "#F2F0EA",
          "align": "left", "valign": "top", "lineHeight": 1.1 }
      ] }
  ]
}
```

## Element types (all share `id,x,y,w,h,rotation,opacity`)

- **text**: `html` (inline `<b> <i> <br>` ok), `fontSize`, `fontFamily`,
  `fontWeight`, `color`, `align` (`left|center|right`), `valign`,
  `lineHeight`, optional `letterSpacing`.
- **shape**: `shape` = `rect|ellipse|triangle|line|path`, `fill`, `stroke`,
  `strokeWidth`, `radius` (rect corner). Optional `fillGradient`
  `{angle, stops:[{at:0..1, color}]}` (CSS-convention angle). Lines take
  their color from `fill` and draw horizontally across the box (rotate for
  vertical); `strokeStyle: solid|dashed|dotted`; tips `lineStart`/`lineEnd`
  = `arrow|dot|bar`.
- **image**: `src` = data URI or `"asset:<key>"` into `doc.assets`,
  `fit: cover|contain|fill`, `radius`. Embed images as data URIs in
  `doc.assets` and reference them — the file must stay self-contained.
- **chart**: `preset: bar|line|pie|scatter`, `option` = ECharts-SHAPED pure
  JSON. **Bar/line series data must be plain numbers** (`{value,itemStyle}`
  objects coerce to 0 — only pie takes `{name,value}`); per-item bar colors
  are unsupported, color by series; template formatters only (`{b}`, `{c}`,
  `{d}`), never functions.
- **svg**: `asset` or `markup` for static artwork. Prefer composing rects/
  texts/paths — those stay editable and can morph.

## The rules that make decks feel designed

- **Morph = shared ids.** Slides with `"transition": "morph"` tween any
  elements whose `id` matches the previous slide — position, size, color,
  gradients. This is THE signature move: carry 2–4 ids through the deck and
  rearrange them per slide. Generators must emit deterministic ids.
- **Entrances**: `fx: { enter: "fade-up", order: 0 }` — equal `order` =
  simultaneous. Entrance staggers only run on non-morph arrivals.
- **Ken-burns**: `fx: { ambient: "kenburns", ken: { dir: "drift|out|in",
  scale: 1.08, duration: 20 } }` — `drift` loops, `out`/`in` settle once on
  slide entry. For full-bleed photos: image at 0,0,1280,720 + a scrim rect
  + text on top. Never combine entrance tweens with motion-path loops.
- **Loops**: `fx: { loop: { type: "dash-march" | "motion-path", ... } }`.
- **Interactivity**: element `link: "<slide-id>"` jumps on click; a slide
  with `stateOf: "<parent-id>"` is a hidden variant reached only by links
  (arrow keys skip it, ← returns to parent). Give clickable things a padded
  transparent rect as the hit target, not the text itself.
- **Numbers count up** with `fx: { countUp: true }`.
- **Speaker notes** (`notes`) are part of the document — write them; they
  make a template teach itself.

## Layout guardrails

- Canonical canvas 1280×720 (`doc.size` can differ — read it first).
- Keep 96 px side margins (right-most content x ≤ 1184).
- One accent color; 2 typefaces max. `theme` sets deck defaults.
- Fonts: `doc.fonts` (`{family, asset, weight}`) + woff2 data URIs in
  `doc.assets` if you need embedded faces; otherwise stick to system stacks.

## Gotchas

- Escape `<` as `\u003c` anywhere in the JSON when writing the file block.
- Don't invent property names — unknown keys are ignored, so a typo means
  your styling silently doesn't apply.
- `docId` is the document's identity — never regenerate it when editing.
- `readonly: true` makes a PLAYER file — it boots straight into the
  presentation with no editor. Set it only on hand-out copies.
- If `template: true` is set, every open mints a fresh document (that's for
  distributable templates; remove it for a personal deck).
- Charts degrade gracefully but exotic ECharts config is ignored — keep
  options minimal.

Working examples of everything above: the template decks at
[bento.page](https://bento.page) — open one and read its JSON block.
