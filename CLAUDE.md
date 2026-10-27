# Bento — self-contained office documents

One HTML file = the document + viewer + editor. See `README.md` for the vision.
`slides/` is the first app (PowerPoint replacement); **Bento Spaces**
(Notion/notes-like) and **Bento Dash** (data/spreadsheet) are starting —
names provisional.

## Multi-app coordination (read first when working beyond slides/)

- `docs/PLATFORM.md` — invariants EVERY Bento app must honor (splice contract,
  docId, format additivity, collab, signed updates). Breaking these bricks
  shipped files.
- `docs/PARALLEL-WORK.md` — ownership zones + branch/merge discipline for the
  many parallel agents/tools working on this repo. Kernel-zone changes are
  serialized, never parallelized.
- `docs/DECISIONS.md` — append-only decision log. Read before non-trivial
  work; append when you settle something other agents could contradict.
- `AGENTS.md` — the tool-agnostic contract (Codex/Antigravity read this).

## Where the detail lives

- `slides/CLAUDE.md`: the slides architecture (model, renderer, present mode,
  editor, charts, tables, media, collaboration UI), the hard-won details that
  must not regress, and the commands. It loads automatically when you work
  under `slides/`.
- `kernel/CLAUDE.md` points kernel work at the sections of it that describe
  shared machinery.

## Testing gotcha

**Reading back a style property you just wrote is not a measurement.** A CSS
transform does NOTHING to a non-replaced inline element — the browser accepts
the declaration, `style.transform` (and `getComputedStyle`) return it verbatim,
and the box moves zero pixels. So a check like "did the tokens get transforms?"
passes identically whether the element travelled 400px or none. Verify motion
with `getBoundingClientRect`, or by stepping `anim.setManual(true)` + `tick()`
and reading rendered geometry. This cost eight rounds of "it does not animate"
against measurements insisting it did (fixed by giving code tokens
`display:inline-block`; `kernel/src/anim.ts` now warns when a transform channel
targets an inline element, guarded by `scripts/test-anim-inline.ts`).

Two more instruments that lie, both hit in the same session:
- **`requestAnimationFrame` is throttled to zero in a hidden/occluded tab**, so
  every tween silently does nothing. Check `document.visibilityState` before
  concluding an animation is broken — a driven browser tab is often hidden.
- **A live sampler polling the DOM mid-animation** reported zero while tokens
  were demonstrably moving, and could never distinguish "no tween" from "a
  tween I cannot see". Instrument the DECISION (did it pair? did onUpdate run?)
  rather than sampling the result.


Synthetic `PointerEvent`s do NOT trigger Moveable/Selecto (Gesto listens for mouse
events) — dispatch `MouseEvent`s, or use trusted input. After changing selection, wait a
frame before starting a synthetic drag.
