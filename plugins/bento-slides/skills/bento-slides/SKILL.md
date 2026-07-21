---
name: bento-slides
description: >-
  Create and edit Bento presentations — single-file .bento.html decks whose
  document is plain JSON in a "#bento-doc" script block. Use whenever the user
  wants a slide deck or presentation: starting from NOTHING (it downloads the
  latest Bento app from bento.page automatically), from source material, or by
  improving an existing .bento.html. Maps content to the right feature
  (charts, morph transitions, state slides, ken-burns, motion paths) instead
  of static text slides, then writes the document JSON in place. Full schema +
  recipes at https://bento.page/agents.md.
---

# Authoring Bento decks

A Bento deck is one self-contained `.bento.html` file. The document is plain
JSON in a single block:

```html
<script type="application/bento+json" id="bento-doc"> { "format":"bento/slides", ... } </script>
```

You edit **that block only**, in place. Escape every `<` in the JSON as
`<` so it can never contain a literal `</script>`. Leave the rest of the
file (the compressed runtime) untouched. In a chat context instead, the user
copies the JSON out (*Save ▾ → Copy document JSON*) and pastes your
replacement back (*Save ▾ → Replace from JSON…*); `window.bento.loadDoc(json)`
does it from the console.

## Starting from nothing

The user does NOT need Bento installed — the app ships inside every deck.
When there is no `.bento.html` to edit, fetch the latest signed release
yourself and author into it:

```bash
# name the file after the deck's topic, e.g. Q4_Review.bento.html
curl -fsSL https://bento.page/releases/slides/Bento_Slides.bento.html -o "<Topic>.bento.html"
```

(Windows without curl: `iwr https://bento.page/releases/slides/Bento_Slides.bento.html -OutFile <Topic>.bento.html`.)

Then verify the download contains `id="bento-doc"`, and **replace** that
block's JSON (it ships with a showcase deck — discard it) with your document.
Rules for a fresh document:

- **Fetch https://bento.page/agents.md BEFORE authoring** and start from its
  "Minimal valid document" skeleton. `size` and `theme` (including
  `theme.fontFamily`) are **required** — the app will not boot without them.
- **Fully specify element fields** as the skeleton shows (shapes need
  `stroke`/`strokeWidth`; text needs `fontFamily`/`align`/`valign`) — missing
  fields render wrong or not at all.
- **Omit `docId` and `collab` entirely**: the app mints a fresh identity and
  dormant collaboration credentials on first open.

When done, offer to open it (`open` / `xdg-open` / `start`) — the file boots
straight into the editor with the finished deck. Aim for one pass from
request to opened deck.

## Workflow

1. **Find the document.** Locate the `#bento-doc` block; parse its JSON. Note
   `doc.size` (canonical 1280×720), `doc.theme`, existing element `id`s, and
   whether `doc.template`/`doc.readonly` are set.
2. **Read the source material the user gave you** and classify each piece —
   is it a stat? a table? a process? a definition to expand? a photo?
3. **Map material → feature (do NOT default to bullet text).** This is the
   step that makes it a Bento deck rather than a slideshow of paragraphs:
   - numbers to compare visually (trend, magnitude, share) → a **chart** element
   - a comparison / spec / pricing / feature grid → a **table** element
     (`columns` weights + `rows` of `cells` + a `style` object)
   - consecutive slides about the **same thing changing** → **morph**: give
     shared elements the same `id` on both slides + `transition:"morph"` on
     the later one (Bento's signature move — reach for it liberally)
   - a point to **drill into** → a **state slide** (`stateOf` + element `link`)
   - a **hero / full-slide image** → full-bleed image + scrim rect + text,
     with **ken-burns** drift
   - a **sequence / flow / timeline** → a line/`path` with a `dash-march`
     loop, or morph a highlight through the steps
   - a **headline number** → big text + `fx:{countUp:true}`
   - **every cover / divider** → at least one ambient motion
   - **repeated chrome / logo** → keep its `id` stable across slides so it
     morphs in place
   - a **demo clip / recording / soundbite** → a **media** element
     (`kind: video|audio`); embed short clips as a data URI, link big ones by
     URL to keep the file small
4. **Author** using the schema. Keep the full schema and copy-paste recipes
   open: **fetch https://bento.page/agents.md** (it has the element shapes,
   the morph/chart/state/ken-burns snippets, and the gotchas). Respect one
   accent colour, ≤2 typefaces, 96px side margins (right-most x ≤ 1184),
   and write **speaker notes** on each slide.
5. **Self-audit before finishing:**
   - [ ] any numbers rendered as text that should be a **chart**?
   - [ ] do consecutive slides on one subject share **ids + `transition:"morph"`**?
   - [ ] at least one **motion moment** (ken-burns / loop / count-up), esp. the cover?
   - [ ] a drill-down that would work better as a **state slide**?
   - [ ] one accent colour, ≤2 typefaces, 96px margins?
   - [ ] speaker notes on every slide?
6. **Write back** the edited `#bento-doc` block (escaping `<`), or return the
   replacement JSON. Never regenerate the whole HTML file.

## Critical gotchas

- **Charts:** bar/line series `data` must be **plain numbers** (`{value,…}`
  item objects coerce to 0 — only pie takes `{name,value}`); colour by
  series, not per bar; `option` is pure JSON, template formatters only
  (`{b}`/`{c}`/`{d}`), never functions.
- **Morph needs deterministic, stable ids** shared across the slides that
  should animate together. Different ids = no morph (elements just cut).
- **Images/fonts must be embedded** as data URIs in `doc.assets` and
  referenced by `"asset:<key>"` — the file stays self-contained.
- **Media:** a `media` element (`kind: video|audio`) embeds short clips as a
  data URI in `src` (self-contained) or references a URL for big files (keeps
  the deck small). `autoplay` runs only in present mode and needs `muted:true`
  for video. Don't embed large videos — they bloat the file.
- **Never regenerate `docId`** when editing an existing deck; it is the
  document's identity. (Fresh decks omit it — the app mints one.)
- `template:true` → every open mints a fresh deck; `readonly:true` → the
  file boots straight into the show with no editor.

Working examples of every technique: open any template at
https://bento.page and read its `#bento-doc` block.
