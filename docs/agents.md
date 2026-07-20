# Bento Slides — for AI agents

**Guide version `__APP_VERSION__`** · document format `bento/slides` (v1). This
guide matches the Bento Slides shell of the same version. A deck's `#bento-doc`
JSON is always the source of truth — if it was written by a newer shell it may
carry features beyond this guide; unknown keys are ignored, never fatal.

> **Bento is a suite.** Slides is the first app. **Docs** (`bento/docs`) and
> **Sheets** (`bento/sheets`) follow, each shipping as its own self-contained
> distributable — `Bento_Slides.bento.html`, `Bento_Docs.bento.html`,
> `Bento_Sheets.bento.html` — with its own agent guide at
> `bento.page/<app>/agents.md`. **This guide covers Slides only.** Before you
> edit a file, check its `"format"` and use the matching guide.

*Drop this file into your context (or point your harness at it) and you can
author and edit Bento presentations directly. Also published at
[bento.page/agents.md](https://bento.page/agents.md). For a harness
(Claude Code / Cowork), the packaged skill is at
[bento.page/skills/bento-deck/SKILL.md](https://bento.page/skills/bento-deck/SKILL.md).*

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

---

## Make a GREAT deck, not just a correct one

**Read this section first — it is the difference between a wall of text and a
Bento deck.** The format's whole value is motion, morph, charts and
interactivity. A correct-but-static result (bullets on slides) wastes it and
is the #1 failure mode. The move is to look at the *source material* and map
each kind of content to the feature built for it:

| When the material is… | Reach for | Why |
|---|---|---|
| numbers to **compare visually** (trend, magnitude, share) | a **chart** element | bars/lines read instantly |
| a **comparison / spec / pricing / feature grid** (rows × columns of labels + values) | a **table** element | structured cells beat 20 hand-placed text boxes; it styles cohesively |
| consecutive slides about the **same thing changing** (before/after, process steps, a metric across stages) | **morph**: same element `id` on both slides + `transition:"morph"` on the later one | the shared elements glide; this is Bento's signature and is *almost always missed* |
| a point to **drill into** (a definition, "click to see how", a sub-topic) | a **state slide** (`stateOf` + element `link`) | keeps the linear story clean; the detail is one click away |
| a **hero / full-slide image** | full-bleed image + scrim rect + text, with **ken-burns** | static photos feel dead; a slow drift feels intentional |
| a **sequence / flow / timeline / connection** | a line or `path` with a **`dash-march` loop**, or morph a highlight through the steps | motion carries the eye along the sequence |
| a **headline number** | big text + `fx:{countUp:true}` | the count-up earns attention |
| **every cover / section divider** | at least **one ambient motion** (ken-burns, an orbiting accent) | a still cover is a missed first impression |
| **repeated chrome / a logo** | keep its `id` stable across slides | it morphs in place instead of popping on every slide |
| a **demo clip / recording / soundbite** | a **media** element (embed short, link long) | a live video/audio beats a screenshot of one |

### Copy-paste recipes

**Morph a title + accent bar between two slides** — identical ids, `transition:"morph"`:
```json
// slide 1
{ "id":"s1","transition":"none","elements":[
  { "id":"headline","type":"text","x":96,"y":140,"w":900,"h":200,"html":"Big claim.","fontSize":120,"fontWeight":900,"color":"#111","align":"left","valign":"top","lineHeight":1,"rotation":0,"opacity":1 },
  { "id":"bar","type":"shape","shape":"rect","x":96,"y":380,"w":320,"h":16,"fill":"#E8442E","stroke":"none","strokeWidth":0,"radius":0,"rotation":0,"opacity":1 } ] }
// slide 2 — same ids, new frames → they animate
{ "id":"s2","transition":"morph","elements":[
  { "id":"headline","type":"text","x":96,"y":84,"w":500,"h":80,"html":"Big claim.","fontSize":40,"fontWeight":900,"color":"#888","align":"left","valign":"top","lineHeight":1,"rotation":0,"opacity":1 },
  { "id":"bar","type":"shape","shape":"rect","x":96,"y":170,"w":16,"h":450,"fill":"#E8442E","stroke":"none","strokeWidth":0,"radius":0,"rotation":0,"opacity":1 } ] }
```

**A bar chart from a table** — bar/line data is PLAIN NUMBERS (see chart rules below):
```json
{ "id":"c1","type":"chart","x":96,"y":260,"w":1088,"h":380,"rotation":0,"opacity":1,"preset":"bar","option":{
  "xAxis":{"type":"category","data":["2022","2023","2024","2025"]},
  "yAxis":{"type":"value"},
  "series":[{"type":"bar","data":[420,780,1300,2450],"itemStyle":{"color":"#141310"},"barWidth":90}],
  "tooltip":{"trigger":"item","formatter":"{b}: {c}"} },
  "fx":{"enter":"fade-up"} }
```

**A comparison table** — a real HTML table; cells are the same inline-html subset as text:
```json
{ "id":"tbl1","type":"table","x":240,"y":220,"w":800,"h":260,"rotation":0,"opacity":1,
  "header":true,
  "columns":[{"w":1.4},{"w":1},{"w":1}],
  "rows":[
    { "cells":[{"html":"Plan"},{"html":"Price","align":"right"},{"html":"Seats","align":"right"}] },
    { "cells":[{"html":"Team"},{"html":"$29"},{"html":"5"}] },
    { "cells":[{"html":"Business"},{"html":"$79"},{"html":"25"}] } ],
  "style":{"headerBg":"#1E2A3A","headerColor":"#fff","zebra":"rgba(30,42,58,0.05)",
    "borderColor":"rgba(30,42,58,0.14)","borderWidth":1,"cellPadX":16,"cellPadY":11,
    "fontSize":18,"color":"#1E2A3A","radius":10} }
```

**A state slide reached by clicking a node** — parent slide has the clickable element, the state lives adjacent:
```json
// on the parent slide, an element the viewer clicks:
{ "id":"node-ingest","type":"shape","shape":"ellipse","x":330,"y":180,"w":74,"h":74,"fill":"#0B0E1E","stroke":"#7A5CFF","strokeWidth":2,"radius":0,"rotation":0,"opacity":1,"link":"state-ingest" }
// a hidden state slide (arrow keys skip it; ← returns to parent):
{ "id":"state-ingest","stateOf":"parent-slide-id","transition":"morph","name":"INGEST","elements":[ /* … */
  { "id":"dismiss","type":"shape","shape":"rect","x":0,"y":0,"w":1280,"h":720,"fill":"rgba(0,0,0,0)","stroke":"none","strokeWidth":0,"radius":0,"rotation":0,"opacity":1,"link":"parent-slide-id" } ] }
```

**Full-bleed hero image with ken-burns + scrim + text:**
```json
{ "id":"photo","type":"image","x":0,"y":0,"w":1280,"h":720,"src":"asset:hero","fit":"cover","radius":0,"rotation":0,"opacity":1,"fx":{"ambient":"kenburns","ken":{"dir":"drift","scale":1.09,"duration":22}} },
{ "id":"scrim","type":"shape","shape":"rect","x":0,"y":0,"w":1280,"h":720,"fill":"rgba(10,14,26,0.55)","stroke":"none","strokeWidth":0,"radius":0,"rotation":0,"opacity":1 },
{ "id":"htitle","type":"text","x":96,"y":460,"w":1000,"h":180,"html":"On top of the photo.","fontSize":76,"fontWeight":800,"color":"#fff","align":"left","valign":"top","lineHeight":1.05,"rotation":0,"opacity":1,"fx":{"enter":"fade-up"} }
```
(Embed the image as a data URI in `doc.assets` under key `hero`, then reference `"asset:hero"` — the file must stay self-contained.)

**Video — embed a short clip, or link a big one** (autoplay is present-only; `muted` required to autoplay):
```json
// embedded — self-contained, keep it small (a few MB at most):
{ "id":"clip","type":"media","kind":"video","src":"data:video/mp4;base64,AAAA…","x":220,"y":120,"w":840,"h":472,"rotation":0,"opacity":1,"controls":true,"muted":true,"autoplay":true,"loop":true,"fit":"cover","radius":8 }
// linked — deck stays tiny; needs the URL at play time (give it a poster):
{ "id":"clip","type":"media","kind":"video","src":"https://cdn.example.com/demo.mp4","poster":"asset:demo-poster","x":220,"y":120,"w":840,"h":472,"rotation":0,"opacity":1,"controls":true }
```

### Before you finish — self-audit

- [ ] Any numbers rendered as text that should be a **chart**?
- [ ] Do consecutive slides on one subject share element **ids + `transition:"morph"`**?
- [ ] At least one **motion moment** (ken-burns / loop / count-up), especially the cover?
- [ ] A drill-down that would work better as a **state slide**?
- [ ] One accent colour, at most two typefaces, **96px** side margins (right-most x ≤ 1184)?
- [ ] **Speaker notes** written on each slide (they travel in the file and double as the talk track)?

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
- **shape**: `shape` = `rect|ellipse|triangle|arrow|line|path`, `fill`, `stroke`,
  `strokeWidth`, `radius` (rect corner). Optional `fillGradient`
  `{angle, stops:[{at:0..1, color}]}` (CSS-convention angle). Lines take
  their color from `fill` and draw horizontally across the box (rotate for
  vertical); `strokeStyle: solid|dashed|dotted`; tips `lineStart`/`lineEnd`
  = `arrow|dot|bar`. A `path` is a free vector: `d` (SVG path data) +
  `pathBox` `[x,y,w,h]` authoring viewBox, stretched into the element box;
  for a **curved line** set `fill:"transparent"` + a `stroke` + `strokeWidth`.
  A **connector** is a `line` (or `path`) with `from`/`to: {el, side}` — its ends
  follow those elements and re-route when they move (side `"auto"` picks the
  nearest border). Make sure a shape's colour contrasts with its slide background.
- **image**: `src` = data URI or `"asset:<key>"` into `doc.assets`,
  `fit: cover|contain|fill`, `radius`. Embed images as data URIs in
  `doc.assets` and reference them — the file must stay self-contained.
- **chart**: `preset: bar|line|pie|scatter`, `option` = ECharts-SHAPED pure
  JSON. **Bar/line series data must be plain numbers** (`{value,itemStyle}`
  objects coerce to 0 — only pie takes `{name,value}`); per-item bar colors
  are unsupported, color by series; template formatters only (`{b}`, `{c}`,
  `{d}`), never functions. **Dual axis**: for two series on very different
  scales (e.g. volume + a %), make `yAxis` an ARRAY of two `{type:"value"}`
  axes (give the 2nd `axisLabel:{formatter:"{value}%"}`) and point the odd
  series at it with `"yAxisIndex":1` — render it as a `line` over the bars.
- **table**: `columns` (array of `{w}` fractional weights), `rows` (array of
  `{cells:[{html, align?, color?, bg?, bold?}]}`), `header` (bool — row 0 is
  the header), and a `style` object (`headerBg`, `headerColor`, `zebra?`,
  `borderColor`, `borderWidth`, `cellPadX`, `cellPadY`, `fontSize`, `color`,
  `radius`). Renders as a real HTML table. Use for comparison/spec/pricing
  grids — NOT for numeric trends (use a chart).
- **svg**: `asset` or `markup` for static artwork. Prefer composing rects/
  texts/paths — those stay editable and can morph.
- **media**: `kind: video|audio`, `src` = data URI (embedded — travels in the
  file), an external URL / relative path (referenced — keeps the file small,
  needs the network at play time), or `"asset:<key>"`. Video also takes
  `poster`, `fit: cover|contain|fill`, `radius`. Playback flags: `controls`,
  `autoplay`, `loop`, `muted`. **Autoplay fires only in present mode**, and
  browsers require `muted:true` for a video to autoplay. **Embed only SHORT
  clips** — a big data URI bloats the file and makes it slow to open/save;
  host large media and reference its URL instead.

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

## Dynamic fields (tokens in text `html`)

Put these tokens in any text element's `html`; they resolve at render time (the
model keeps the raw token, so numbering/props update automatically):
`{{page}}`, `{{pages}}` (position among non-state slides; zero-pad with
`{{page:2}}`→"06"), `{{title}}`, `{{date}}`, `{{time}}`, and the document
properties `{{author}}`, `{{company}}`, `{{subject}}`, `{{event}}`. Set the
props in an optional top-level `"meta": {author, company, subject, event,
keywords}` object — great for title slides and footers that fill from one place.

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
- **Media size**: embedding a large video as a data URI can push the file into
  the tens of MB and make it slow to open and save. Embed only short clips;
  otherwise host the file and put its URL in `media.src`.

Working examples of everything above: the template decks at
[bento.page](https://bento.page) — open one and read its JSON block.
