# UX pyramid audit — slides editor revamp (2026-10-30)

Branch `slides/inspector-split` at 703e0c6e, single-file build (820KB). Four
observers drove the built editor in headless Chromium with real mouse and
keyboard input (1440×900, 1280×800, 1024, 768; light and dark; en, de, pt);
`window.bento.doc` was only read, never written. Evidence (scripts and
screenshots) was kept in the session scratchpad, not the repo; screenshot
names are cited so a re-run can reproduce them.

## Scope

- **Users.** People building persuasive and executive decks, mostly
  non-designers; some designers arriving from Figma, Keynote or PowerPoint.
- **Workflows audited** (frequency × consequence):
  1. *Lay out and style a content row* — the core authoring loop, repeated on
     nearly every slide.
  2. *Keep the deck on-brand* — tokens, modes and components: the change-once
     promise the revamp exists to keep.
  3. *Build a morph* — Bento's signature, and the one that fails in front of
     an audience.
  Plus a cross-cutting *inspector craft* pass (dropdowns, geometry, align and
  distribute, motion), at the user's request.
- **Out of scope.** Collaboration, saving and recovery, spaces and type,
  present-mode features other than the morph.
- **Unknown.** Read-only viewer behaviour (no second session); Alt-drag
  duplicate; equal-spacing smart guides.

Every finding is **Observed** unless marked **Inferred**.

## 1 · Lay out and style a content row

**Goal** — three cards (rounded rectangle + title) in an evenly spaced row,
styled with a brand fill, an outside stroke and a gradient overlay.
**Entry** — a new blank slide; the user knows Keynote or Figma basics.

**Flow** — new slide (2 clicks) → R/F/T insert a default object at the slide
centre (not a draw tool: R-then-drag draws a marquee) → T with a frame
selected lands *beside* the frame, and dragging text onto a frame does not
put it inside → select text, ⇧A wraps it in a hug frame (a card) → ⌘D/⌘C⌘V
of that card copies the empty frame without its text → three cards built by
hand, ⇧A on each → marquee + ⇧A *flattens* the cards into one 1648px row
(⌘Z) → shift-click each card's 11px padding strip, ⇧A → row with gap 16 →
style each card separately (multi-select shows no Fill or Stroke) → nudge the
gap with `+24` / scrub.

**Friction**

① Duplicating or copy-pasting a frame drops its children.
   Layer: Functionality. Evidence: Observed in the model after ⌘D and
   ⌘C/⌘V (`17-after-duplicate-x2`, `19-copy-paste-frame`).
   Why it matters: "make one card, duplicate it" is the core move; users get
   empty boxes.
   Change: copy, paste and duplicate the whole subtree (descendants by
   `parentId`) with remapped ids.

② Press-and-drag on an unselected element does nothing and throws
   `Cannot set properties of null (setting 'dist')` on every mousemove.
   Layer: Functionality. Evidence: Observed in all three workflows
   (`24-drag-unselected-rect`, w3 `21-first-drag…`).
   Why it matters: the default arranging gesture in every slide tool.
   Change: a press on an unselected element selects it and starts the drag.

③ Typing on a selected title placeholder runs the one-letter tools: "Revenue"
   inserts rectangles, no text.
   Layer: Functionality. Evidence: Observed (w3 `13-BUG-…`).
   Why it matters: "Click to add title" invites one click; the first keystrokes
   litter the slide with hidden shapes.
   Change: a printable key on a selected text element enters text editing with
   that character; tools fire only when nothing editable is selected.

④ The arrange toolbar overflows: with 3 elements selected, 7 of 21 buttons
   are covered and Exclude is off-screen; with one, Align bottom's centre is a
   dead click.
   Layer: Functionality. Evidence: Observed by hit-test (`multi3-Format`,
   `toolbar-single-1440`); CSS says it wraps but is `flex-wrap: nowrap`.
   Why it matters: aligning and distributing several elements — the user's
   explicit priority — is impossible by mouse.
   Change: a dedicated align/distribute row, and order/flip/boolean on a
   second row, fixed 24×26 tools.

⑤ A card inside a row can't edit its own auto layout; its sizing shows
   "Fixed" while the model hugs, and Hug isn't offered.
   Layer: Functionality. Evidence: Observed (`34-card1-selected`).
   Change: show the frame's own Auto layout block, then a "Resizing in
   parent" block with Hug / Fixed / Fill.

⑥ Marquee selects descendants and ⇧A flattens nested frames; clicking a card
   selects its text, and nothing selects the parent.
   Layer: Usability. Evidence: Observed (`30-…`, `31-outer-row-frame`).
   Change: marquee takes top-level elements; ⇧A drops a selected item whose
   ancestor is also selected; first click selects the outermost frame,
   double-click goes deeper, Esc selects the parent (Figma's model).

⑦ Multi-selection shows no Fill, Stroke or Shadow.
   Layer: Efficiency (Functionality for "recolour these"). Evidence: Observed
   (`multi3-Format`). Why it matters: styling three cards costs every step
   three times (~15 extra actions).
   Change: show Fill, Stroke and Shadow for a selection that shares them, with
   the existing Mixed convention.

⑧ Align on a frame's child appears to work but does nothing; X shows 1260
   while the model holds 581.
   Layer: Usability. Evidence: Observed (`frame-child-alignright`).
   Change: for a frame child, hide align and show the frame's alignment;
   X/Y read-only. Re-render W/H/X/Y after every layout pass (the row's W also
   showed 880 against 1008).

⑨ Esc in the colour popover silently reverts the edit; clicking outside keeps
   it. Picking a theme colour on a transparent fill keeps 0% alpha, so the
   click looks broken.
   Layer: Usability. Evidence: Observed (`37-card-accent-fill`).
   Change: Esc closes and keeps (⌘Z undoes); a pick on a 0%-alpha fill sets
   100%; a transparent fill reads "None".

⑩ Numeric fields hold focus after Enter and Esc, swallowing ⌘D, ⌘Z and ⇧A
   (⇧A typed "240A" into W); invalid input ("abc") reverts silently.
   Layer: Usability. Evidence: Observed (`43-gap-abc`).
   Change: Esc blurs back to the canvas; ⌘Z/⇧⌘Z in a number field run document
   undo; a refused value flashes the field with the reason.

⑪ Fill and stroke layer rows overflow the panel: the hex collapses to 14px,
   the theme button clips, the blend select spills over and gets its own row.
   Layer: Clarity. Evidence: Observed (`38-added-fill-layer`,
   `50-…-1024`).
   Change: one row per layer (eye · swatch · hex · % · ⋯), blend inside ⋯; drop
   the Solid/Linear/Radial duplicate between the row and the popover.

**Bottleneck** — Functionality (①–⑤). **Next elevation** — fix ①–④, then the
selection model ⑥: the row drops from ~40 actions to ~15.

## 2 · Keep the deck on-brand

**Goal** — a brand colour and a spacing value defined once, used on several
slides, changed once, with a dark variant; a stat card reused on three slides
that follows its main while one copy keeps a local label.
**Entry** — a user who has heard "tokens" or knows Figma variables.

**Flow** — discovered only by opening the Tokens tab (⌘K and ? know nothing
of tokens, modes or components) → + creates a token inline → bind a colour
through the "Theme colors" button (tokens and theme colours in one menu) and
numbers through a hover-only dot → change the token: slides follow → add a
mode: copies Default, switches live → ⌥⌘K makes a component (no feedback) →
Insert puts a copy at the main's coordinates over existing content → main
edits propagate; a local text edit survives. Zero console errors; every action
is one undo step.

**Friction**

① Number and font-size token names are invisible: the name field is 14px at
   the default panel width (and at 1024/768); colour names truncate to "col…".
   Layer: Usability. Evidence: Observed (`20-token-rows-closeup`).
   Change: name above value when narrow, or the value shrinks first and the
   name keeps ≥80px.

② Tokens, modes and components can't be found where users search.
   Layer: Usability. Evidence: Observed (⌘K "token", "component", "mode",
   "main", "detach" → nothing; ? has no Tokens row; binding dot is hover-only).
   Change: commands New token, Bind to token…, Create component, Detach, Go to
   main component, Switch mode → X; one ? row; the dot visible on focus.

③ Theme colours and colour tokens are two brand systems for one job.
   Layer: Clarity. Evidence: Observed (both under one "Theme colors" button;
   "Accent" vs "Accent 1"; a token's detach says "Detach from the theme"; only
   tokens have modes).
   Why it matters: "where do I set the brand colour" has two answers that
   don't know about each other.
   Change: show the theme colours as built-in, non-deletable colour tokens in
   the Tokens view (with modes); the Theme section links there; one vocabulary
   ("Colours & tokens", "Detach from token").

④ The starter deck hard-codes its brand colour 49 times; there is no way to
   adopt a literal as a token.
   Layer: Efficiency. Evidence: Observed (`29`, `30`).
   Change: on a swatch, "Make a token from this colour — binds its N uses",
   and "Select all with this colour".

⑤ No "where used", no account of what a mode switch changed, and bound
   swatches in the inspector go stale after a token or mode change.
   Layer: Usability. Evidence: Observed (`15`, `27`, `35`).
   Change: the use count steps through bound elements; a mode switch toasts
   "N properties changed · M hard-coded colours didn't"; bound swatches
   re-render on token and mode changes.

⑥ A component has no identity in the inspector, a copy can't reach its main,
   deleting a main warns nothing, Detach on part of a main silently shrinks the
   component, and Insert lands on top of existing content.
   Layer: Usability. Evidence: Observed (`46`, `49`, `51`, `64`, `65`).
   Change: an inspector header ("◆ Stat card · main" / "◇ Copy · Go to main
   (slide 3) · Reset · Detach"); confirm before deleting a main; "Remove from
   component" on a main's part; insert at the viewport centre and select it.

⑦ Token values use the native colour input, not the app's picker; invalid
   token names are refused silently; focus drops to `<body>` after creating.
   Layer: Usability. Evidence: Observed (`11`, `41`).
   Change: reuse the colour popover; an inline reason under the name; focus
   the new row.

**Bottleneck** — Usability. **Next elevation** — ①, ②, ⑤, ⑥ (findability and
feedback), then the Clarity merge ③ and the adoption path ④.

## 3 · Build a morph

**Goal** — slide 2 shows the same card enlarged and moved, the title morphs,
one new element enters.
**Entry** — a user who has seen the showcase deck's morphs.

**Flow** — duplicate the slide (hover icon or right-click) → the duplicate
keeps "Fade" → move the card (the first press-drag fails, ②) → the card's
Animate tab already says "Morph from the slide before ☑" though the slide
fades → set Transition to Morph on the slide (deselect, Animate tab) → a
dashed ghost of the old position and an arc appear; Layers shows ↔ badges →
Preview slider animates only the selected element → present: F5 starts at
slide 1, so ← → to see it → the card glides, new text fades in, and the
title's text swaps instantly.

**Friction**

① The editor says an element morphs when it won't (checkbox ticked under a
   Fade transition; still ticked after a rename broke the pair, while ghost
   and badge vanished).
   Layer: Usability (predictability). Evidence: Observed (`22`, `38`, `40`).
   Change: derive the checkbox from the effective pairing; when a pair exists
   but the slide doesn't morph, say so with a one-click "Use Morph".

② Renaming a paired element's Morph name silently unpairs it (and stores
   "revenue card" as `revenuecard`).
   Layer: Usability. Evidence: Observed (`38`).
   Change: rename the counterpart on the neighbouring slide too; show the
   normalised value.

③ "Morph with" is a native select of ~186 near-identical options ("Slide 1 ·
   Shape" ×20), including later slides; confirmations quote raw ids
   (`s-mvutazhm-9rdmmd`) and point "below" at a control that is above.
   Layer: Clarity. Evidence: Observed (`33`, `35`, `37`).
   Change: the previous slide's unpaired elements first, by their Layers name
   and a text/colour hint; other slides in a collapsed group; type to filter;
   "Pairs with: Slide 2 · Revenue card" instead of ids.

④ The preview animates only the selected element and never shows that text
   swaps instantly.
   Layer: Usability (feedback mismatch). Evidence: Observed (`27`, `29`,
   `42-contact-sheet`).
   Change: the scrubber previews the whole slide (paired, entering, leaving);
   a text pair notes "text changes at once; position and size morph".

⑤ Morph is three non-obvious steps in a fixed order; checking one means
   presenting from slide 1 or ← → from the target.
   Layer: Usability / Efficiency. Evidence: Observed (`05-shortcuts`, F5 →
   "1 / 17").
   Change: offer "Use Morph" on a duplicated slide whose elements moved; a
   "Play transition" command that starts at the previous slide.

**Bottleneck** — Usability (predictability). **Next elevation** — one source
of truth for "will this morph" (①, ②), a whole-slide preview (④), a usable
pairing picker (③).

## 4 · Inspector craft (cross-cutting)

- **Dropdowns that should be icon pickers.** Stroke position (truncates in
  English), line style (solid / dashed / dotted / custom), auto-layout
  direction (`frameRow/Col/Grid` icons exist, unused), padding and gap labels
  (`padding`, `gap` icons exist), chart type, fit, slide transition, entrance
  (8 chips, 171px → effect segmented + direction pad), lap easing (4 curves),
  appearance (system / light / dark), Off/On selects → toggles, pan & zoom →
  toggle + 3-icon motion. Keep as dropdowns: font, weight, blend (unify the 8-
  and 16-entry lists), code language (add type-to-filter), layout role, link
  targets. Line start/end: keep a menu with glyph previews and a swap button.
- **Geometry.** Toolbar tools are 30 high (dominant 26); the two-column grid
  is 101·22·101 with the ratio lock, 148·4·72 for blend/opacity, 110·4·110
  elsewhere, and jumps between single and multi selection; colour-row hex
  widths are 96 / 102 / 132 / 164 for the same control; checkboxes overrun the
  right edge by 4px; the table stepper ends 46px short and can't be typed;
  heights 18–44 and radii 3–999 for controls that should share 26 and 6; the
  alignment matrix's cells are 21 / 15 / 15 high; the same Size/Line height
  is in-field in Text and labelled rows in Code.
- **Labels.** A fixed 90px label column wraps English labels and 6–8 rows per
  tab in German and Portuguese (PT "Transformar a partir do slide anterior":
  three lines); side tabs truncate ("Camadas" 52/61).
- **Align and distribute.** Math is correct (Align middles, Space evenly,
  Same width verified in the model); no shortcuts, no context-menu entries,
  no ⌘K commands, no spacing value; align ignores rotation (Inferred).
- **Motion.** Consistent: tab pill 140ms, popovers 120ms, fold 140ms, all off
  under reduced motion; no layout shift on edits (CLS 0). Focus drops to
  `<body>` after "+ Add shadow", "+ Add row" and toolbar actions.
- **Dark mode.** Field and select borders 1.33:1 and field fill ~1.2:1 against
  the panel — below 3:1 for non-text.
- **Chrome.** The boot toast covers the notes pane; at 768px the topbar's
  icons overlap and the panels don't collapse; Layers names are generic
  ("Rectangle" ×20, "Diagram" ×20).

## Systemic issues

| Issue | Fix at |
|---|---|
| A frame is a "Rectangle" when made with F and a "Frame" with ⇧A; "Layout" (role) sits beside "Auto layout"; Width "Fill" collides with the Fill section; "Layers" is the side tab and the paint layers | Product model — name it Frame everywhere; "Resizing: Hug / Fixed / Fill container"; rename the role section after what it holds |
| Theme colours vs tokens | Product model — theme colours are built-in tokens |
| Focus lost to `<body>` after add/remove/create/toolbar actions and popover close | Component — the panel restores focus by stable key after each rebuild |
| ⌘K misses arrange, style, tokens, components, morph | Flow — register them as commands (the palette reads the list) |
| Selection model: children win over frames; marquee takes descendants | Flow — outermost first, double-click to enter, Esc to the parent |
| Copy/duplicate don't carry structure (frames lose children) | Product model — a frame and its descendants move as one unit |
| Silent refusals (numbers, token names, morph names) | Component — one inline "why" for refused input |

## Elevation roadmap

```text
Current position   Usability in places, but Functionality is broken on the core loop
Primary bottleneck Functionality: drag-unselected, letters-in-placeholder, frame
                   copy without children, toolbar overflow, nested frames' layout
Elevation 1        Fix those five; the selection model (outermost first, Esc to
                   parent, marquee top-level, ⇧A over nested); multi-selection
                   Fill/Stroke/Shadow; frame-child align/X/Y; numeric-field focus
                   and undo; Esc keeps popover edits
Elevation 2        One "will it morph" truth + whole-slide preview + pairing picker;
                   tokens findable (⌘K, ?, visible names, where used, mode toast,
                   live swatches); component identity and go-to-main; icon pickers
                   where the options are visual; one grid, one colour row, one
                   height/radius; label column that fits de/pt
Elevation 3        Theme colours as built-in tokens; adopt a literal as a token;
                   gap inferred by ⇧A; Play transition; insert-at-viewport
Defer              Dark-mode border contrast tuning, boot toast placement, 768px
                   topbar, generic layer names — after the elevations above
```

Metrics worth measuring after Elevation 1: actions to build the three-card row
(observed ~40), and the share of first-attempt drags that move the element
(observed 0% when the element was not already selected).
