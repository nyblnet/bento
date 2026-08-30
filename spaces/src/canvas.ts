// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The `canvas` block: a bounded surface holding cards you place by hand —
// storyboards, roadmaps, mind maps.
//
// ————— THE FORMAT, AND WHY IT IS THIS SHAPE ———————————————————————————————
//
// A CARD IS A BLOCK, not an entry in an array on the canvas. The canvas
// `container: 'always'` owns the blocks whose `parent` is its id, exactly as a
// callout and a toggle do, and the only thing a card adds is WHERE IT SITS:
// two flat numbers, `x` and `y`.
//
// The obvious alternative — `canvas.cards: [{id, x, y, text}]` — was rejected
// for three reasons, in ascending order of how permanent the mistake would be.
//
//   1. It would be a SECOND place text lives. Every other word in a space is a
//      block's `html`, canonicalised by one sanitizer, found by ⌘F, exported by
//      one markdown pass, backlinked by buildIndex because it reads `html`. A
//      card's words inside an array are none of those things, and each one
//      would have to be taught about the array separately.
//   2. It would DEGRADE BADLY. renderBlocks resolves a child against the open
//      container stack, and an unknown type opens no container — so on a build
//      that has never heard of `canvas`, the cards fall out to the top level
//      and render as ordinary paragraphs and page cards under the canvas's own
//      title. Nothing is hidden and nothing is lost. Cards in an array on a
//      block whose type means nothing would render as the canvas's `html` and
//      no more, and the words would be on screen only if the html duplicated
//      them — which is what a table has to do, and pays for in bytes.
//   3. It would LOSE EDITS UNDER COLLABORATION. model.ts states the rule:
//      properties are flat because each (node, key) pair is one last-writer-
//      wins register. `cards` as one array is ONE register — two people
//      dragging two different cards keep one of the two moves, silently. As
//      blocks, each card is its own CRDT node and `x` and `y` are its own
//      registers, so two simultaneous drags both land. `table.rows` has the
//      array problem and documents it as a limitation; there is no reason to
//      take it on again where the alternative is strictly simpler.
//
// COORDINATES ARE PERCENTAGES of the surface, `x` across and `y` down, one
// decimal place. Not pixels: the same file is read at 320px and at 2560px and
// printed on A4, and a layout in px is a layout that is right at one width.
// Not a 1000-unit abstract grid either — that is a percentage with a scale
// factor bolted on, and it needs the renderer to know the factor forever. A
// percentage needs nothing: `left: calc(var(--sp-x) * 1%)`.
//
// `ratio` (width ÷ height) is the surface's shape and lives on the canvas
// block. It has to be a document field: a roadmap is wide and a mind map is
// square, the cards' y coordinates are relative to it, and a reader-side
// default would move every card the moment the default changed.
//
// WHAT IS DELIBERATELY NOT HERE, so a follow-up does not have to guess:
//   · card SIZE. `w`/`h` are already taken — an image block carries its
//     intrinsic pixels in them, and an image is a perfectly good card. A
//     future size field is `cw`/`ch`, in the same percentage units.
//   · CONNECTORS. They belong on the canvas block as `links: [{from, to}]` of
//     card ids — a relation is not a property of either end.
//   · NESTING. A canvas inside a canvas is a card whose type is `canvas`; the
//     container stack already supports it and nothing here forbids it.
// None of those is built. All three are additive.

import type { Block, Page } from './model.ts'
import { descendantsOf, newBlock } from './model.ts'
import { sanitizeInline } from './sanitize.ts'
import { t } from './i18n.ts'
import { ICONS } from './icons.ts'

/** The surface's shape, width ÷ height. Wide, because the first thing anyone
 *  draws here is a row of steps. */
export const CANVAS_RATIO = 1.6

/** What a `ratio` in a file may say. A file can be hand-edited or generated,
 *  and a ratio of 0 is a surface with no height — clamped at read time rather
 *  than repaired in the document, the `tableOf` rule. */
export const RATIO_MIN = 0.4
export const RATIO_MAX = 4

/** A card's width, as a percentage of the surface. Fixed until `cw` exists. */
export const CARD_W = 22

/**
 * The surface's shape for one canvas block.
 *
 * An unreadable `ratio` — absent, a string, NaN, negative — is the DEFAULT,
 * never an error and never a rewrite of the document.
 */
export function canvasRatio(b: Block): number {
  const r = (b as { ratio?: unknown }).ratio
  if (typeof r !== 'number' || !Number.isFinite(r)) return CANVAS_RATIO
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, r))
}

/** The three shapes the one shape-button cycles through, and their names. */
export const RATIOS: Array<{ ratio: number; label: string }> = [
  { ratio: 1.6, label: 'Wide' },
  { ratio: 1, label: 'Square' },
  { ratio: 0.7, label: 'Tall' },
]

/** The name for the shape a canvas is currently in — the nearest of the three,
 *  so a hand-written 1.55 still says "Wide" rather than nothing. */
export function ratioName(r: number): string {
  let best = RATIOS[0]
  for (const c of RATIOS) if (Math.abs(c.ratio - r) < Math.abs(best.ratio - r)) best = c
  return best.label
}

export function nextRatio(r: number): number {
  const here = RATIOS.findIndex((c) => c.label === ratioName(r))
  return RATIOS[(here + 1) % RATIOS.length].ratio
}

export interface CardPos { x: number; y: number }

/**
 * A DETERMINISTIC SLOT for a card that has never been placed.
 *
 * Absent coordinates are not an error: `{type:'canvas'}` with three bare
 * paragraphs under it is a valid, hand-writable canvas, and every card an
 * author adds by pressing Enter inside one arrives without a position. Piling
 * them all at (0,0) would make a canvas that looks broken the first time it is
 * used, so an unplaced card gets a slot from its INDEX — same file, same
 * screen, same layout, on every reader's machine.
 *
 * Twelve slots in a 4x3 grid, then the grid repeats with a small diagonal
 * offset, so a thirteenth card is visibly a card rather than a perfect overlap.
 */
export function slotFor(i: number): CardPos {
  const lap = Math.floor(i / 12)
  const n = i % 12
  return {
    x: round1(4 + (n % 4) * 24 + lap * 2),
    y: round1(6 + Math.floor(n / 4) * 30 + lap * 3),
  }
}

/** Where a card sits: what it says, or its slot. `i` is its position among the
 *  canvas's cards, which is what makes the fallback stable. */
export function cardPos(b: Block, i: number): CardPos {
  const x = (b as { x?: unknown }).x
  const y = (b as { y?: unknown }).y
  const slot = slotFor(i)
  return {
    x: typeof x === 'number' && Number.isFinite(x) ? clampPct(x) : slot.x,
    y: typeof y === 'number' && Number.isFinite(y) ? clampPct(y) : slot.y,
  }
}

/** A coordinate a file may contain, brought back into the surface. Negative
 *  and 4000 are both things a generator writes; neither should put a card
 *  where nobody can reach it. */
export const clampPct = (n: number): number => Math.min(100, Math.max(0, round1(n)))

/** One decimal place. Coordinates are written on every drag and read in every
 *  diff, and 0.1% of a surface is well under a pixel of intent — full float
 *  noise makes a one-card move look like a rewritten block. */
export const round1 = (n: number): number => Math.round(n * 10) / 10

/** The cards of one canvas, in document order. */
export function cardsOf(page: Page, canvasId: string): Block[] {
  return page.blocks.filter((b) => b.parent === canvasId)
}

/**
 * Where a NEW card goes: the first slot no card is already sitting on.
 *
 * Not "the next index" — cards get deleted, so index 3 can be free while index
 * 5 is taken, and dropping a new card exactly on top of an old one is the one
 * outcome that reads as a bug.
 */
export function freeSlot(cards: Block[]): CardPos {
  const taken = cards.map((c, i) => cardPos(c, i))
  for (let i = 0; i < 48; i++) {
    const s = slotFor(i)
    if (!taken.some((p) => Math.abs(p.x - s.x) < 8 && Math.abs(p.y - s.y) < 8)) return s
  }
  return slotFor(cards.length)
}

/**
 * GIVE A BRAND-NEW CARD SOMEWHERE TO SIT.
 *
 * An unplaced card falls back to the slot for its INDEX, which is right for a
 * hand-written file and wrong the moment a canvas has been used: pressing Enter
 * in the first card makes a new card at index 1, and index 1's slot is exactly
 * where the card that used to be there is still sitting. Measured — the new
 * card landed underneath the old one and looked like nothing had happened.
 *
 * So the two places the editor creates a block (insertAfter, splitBlock) ask
 * here, and a card born inside a canvas is born with coordinates. Everything
 * else is left alone: this is a no-op for a block whose parent is a callout, a
 * toggle, a list item or nothing at all.
 */
export function placeNewCard(page: Page, fresh: Block): void {
  if (!fresh.parent) return
  const owner = page.blocks.find((b) => b.id === fresh.parent)
  if (owner?.type !== 'canvas') return
  const pos = freeSlot(cardsOf(page, owner.id))
  fresh.x = pos.x
  fresh.y = pos.y
}

// ————— RENDERING ————————————————————————————————————————————————————————

/**
 * The canvas block's own chrome: its name, and the buttons that change it.
 *
 * The BODY is not built here — renderBlocks opens it, because `container` in
 * the registry is what says a type owns the blocks whose parent is its id, and
 * a second body built here would be a second answer to that question.
 *
 * Controls are `opts.editable` only, the callout-chip and view-button rule: a
 * reader, a printout and a locked space get the surface, not the buttons.
 */
export function renderCanvasHead(el: HTMLElement, b: Block, editable: boolean, cards: number): void {
  el.classList.add('sp-canvas')
  el.style.setProperty('--sp-ratio', String(canvasRatio(b)))

  const head = document.createElement('div')
  head.className = 'sp-canvas-head'

  const title = document.createElement(editable ? 'div' : 'span')
  title.className = 'sp-canvas-title'
  title.dir = 'auto'
  if (editable) {
    title.contentEditable = 'true'
    title.dataset.canvasTitle = b.id
    title.dataset.ph = t('Name this canvas')
  }
  title.innerHTML = sanitizeInline(b.html ?? '')
  head.appendChild(title)

  if (editable) {
    const btn = (attr: string, label: string, tip: string): HTMLButtonElement => {
      const el2 = document.createElement('button')
      el2.type = 'button'
      el2.className = 'sp-btn sp-canvas-btn'
      el2.dataset[attr] = b.id
      el2.textContent = label
      el2.title = tip
      el2.setAttribute('aria-label', tip)
      return el2
    }
    const shape = ratioName(canvasRatio(b))
    // ONE cycling button, not a menu of three: the view block's layout control
    // settled this argument already, and the reason is the same — the word on
    // the button is the state, and the click is the change.
    const SHAPE_WORD: Record<string, string> = {
      Wide: t('Wide'), Square: t('Square'), Tall: t('Tall'),
    }
    head.append(
      btn('canvasAdd', t('Add a card'), t('Add a card')),
      btn('canvasAddPage', t('Add a page'), t('Add a card that opens a page')),
      btn('canvasShape', SHAPE_WORD[shape] ?? shape, t('Change the shape of this canvas')),
    )
  }
  el.appendChild(head)

  if (!cards) {
    const empty = document.createElement('p')
    empty.className = 'sp-canvas-empty'
    empty.textContent = t('Nothing on this canvas yet.')
    el.appendChild(empty)
  }
}

/**
 * Put one card where the model says.
 *
 * CSS custom properties rather than `left`/`top` directly, so the stylesheet
 * owns the layout: the phone breakpoint drops the whole canvas to a stacked
 * list by ignoring these, which it could not do against inline `left`.
 *
 * `i` is the card's index among its siblings, and it is read from the DOM
 * AFTER the append, so the caller does not have to keep a counter.
 */
export function placeCard(node: HTMLElement, b: Block): void {
  const i = Math.max(0, (node.parentElement?.children.length ?? 1) - 1)
  const p = cardPos(b, i)
  node.classList.add('sp-cv-card')
  node.style.setProperty('--sp-x', String(p.x))
  node.style.setProperty('--sp-y', String(p.y))
}

// ————— EDITING ——————————————————————————————————————————————————————————

/**
 * What canvas.ts needs from the editor, and nothing more.
 *
 * A deliberately narrow surface rather than the Store itself: render.ts
 * imports this file, so anything this file imports is in the renderer's
 * dependency graph, and the renderer has no business knowing about undo.
 */
export interface CanvasHooks {
  block(id: string): Block | undefined
  page(): Page | undefined
  commit(fn: () => void, opts?: { structure?: boolean }): void
  repaint(): void
  /** the existing page picker, so "a card for a page" is the same dialog as
   *  every other way to point at one */
  pickPage(then: (pageId: string) => void): void
}

export function wireCanvas(root: HTMLElement, hooks: CanvasHooks): void {
  for (const cv of root.querySelectorAll<HTMLElement>('.sp-canvas')) {
    const id = cv.dataset.blockId
    if (!id) continue

    cv.querySelector<HTMLElement>('[data-canvas-add]')
      ?.addEventListener('click', () => addCard(hooks, id, newBlock('p')))
    cv.querySelector<HTMLElement>('[data-canvas-add-page]')
      ?.addEventListener('click', () => {
        hooks.pickPage((pageId) => addCard(hooks, id, newBlock('pagelink', { page: pageId })))
      })
    cv.querySelector<HTMLElement>('[data-canvas-shape]')
      ?.addEventListener('click', () => {
        const b = hooks.block(id)
        if (!b) return
        // THE DEFAULT IS STORED AS AN ABSENT KEY — the `editView` discipline:
        // a canvas cycled back to Wide must be byte-identical to one that was
        // never touched, and a file written before this control existed must
        // stay that way.
        const next = nextRatio(canvasRatio(b))
        hooks.commit(() => {
          if (next === CANVAS_RATIO) delete (b as { ratio?: number }).ratio
          else (b as { ratio?: number }).ratio = next
        })
        hooks.repaint()
      })

    // THE TITLE COMMITS WHEN IT IS DONE WITH, not on every keystroke. It is a
    // short name typed once; an undo entry per character would bury the edit
    // before it under twenty of them.
    const title = cv.querySelector<HTMLElement>('[data-canvas-title]')
    // A NAME IS ONE LINE. Enter in a contentEditable inserts a break, and a
    // two-line surface name pushes the whole canvas down and reads as a bug;
    // it also stops the keystroke reaching the editor's own Enter handling,
    // which would otherwise be asked to split a block that has no text host.
    // Enter here means "done", which is what blur already means.
    title?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      title.blur()
    })
    title?.addEventListener('blur', () => {
      const b = hooks.block(id)
      const next = sanitizeInline(title.innerHTML)
      if (!b || next === (b.html ?? '')) return
      hooks.commit(() => { b.html = next }, { structure: false })
    })

    const body = cv.querySelector<HTMLElement>('.sp-canvas-body')
    if (!body) continue
    for (const card of body.querySelectorAll<HTMLElement>(':scope > .sp-cv-card')) {
      wireCard(card, body, hooks)
    }
  }
}

function addCard(hooks: CanvasHooks, canvasId: string, fresh: Block): void {
  const page = hooks.page()
  if (!page) return
  const at = lastOfCanvas(page, canvasId)
  const pos = freeSlot(cardsOf(page, canvasId))
  fresh.parent = canvasId
  fresh.x = pos.x
  fresh.y = pos.y
  hooks.commit(() => { page.blocks.splice(at, 0, fresh) })
  hooks.repaint()
}

/**
 * The index just past a canvas's last descendant.
 *
 * `parent` is positional in this format — a child must appear strictly after
 * its parent — so a card appended at the very end of the page would belong to
 * whatever container happens to be open there, not to this canvas. The insert
 * point is the end of THIS canvas's run.
 */
function lastOfCanvas(page: Page, canvasId: string): number {
  const at = page.blocks.findIndex((b) => b.id === canvasId)
  if (at < 0) return page.blocks.length
  const mine = descendantsOf(page, canvasId)
  let end = at + 1
  while (end < page.blocks.length && mine.has(page.blocks[end].id)) end++
  return end
}


/**
 * A card's grip, and the drag that moves it.
 *
 * WHY A GRIP RATHER THAN THE WHOLE CARD. A card's text is a live
 * contentEditable, and a mousedown on it is how you put the caret somewhere.
 * A whole-card drag has to guess which of the two the reader meant, and every
 * way of guessing (a movement threshold, a delay, suppressing selection until
 * focused) is a guess that is wrong some of the time — in a way that either
 * eats a click or drags the page while you are trying to select a word. A grip
 * is unambiguous, it is a real button so the keyboard can reach it, and it is
 * the same affordance the block gutter already uses.
 *
 * MOUSE EVENTS, not HTML5 drag-and-drop, and not PointerEvent. dnd reports a
 * drop target, which is what a board needs and the opposite of what a free
 * surface needs — here the answer is a continuous coordinate. Pointer events
 * would be the modern spelling, but the board and the column-resize drag in
 * this app are both mouse-driven and mixing the two in one document is how you
 * get a gesture that works in one place and not the one beside it.
 *
 * ONE COMMIT PER GESTURE. The DOM moves live and the model is written once, on
 * release — the `startColResize` rule, and for the same two reasons: sixty
 * commits is sixty undo entries for one drag, and repainting under the cursor
 * loses the pointer on the first frame. A drag that ENDS WHERE IT STARTED
 * commits nothing at all: no undo entry, no dirty flag, no op on the wire.
 */
function wireCard(card: HTMLElement, body: HTMLElement, hooks: CanvasHooks): void {
  const id = card.dataset.blockId
  if (!id) return

  // NO DELETE BUTTON HERE, deliberately. Every block in a space is deleted
  // from the gutter menu, and a card is a block — a second ✕ that only exists
  // inside a canvas is a second answer to a question already answered, and it
  // was the reason an earlier draft hid the gutter, which is the ONLY way to
  // reach Turn into, Duplicate and Delete on a phone.
  const grip = document.createElement('button')
  grip.type = 'button'
  grip.className = 'sp-cv-grip'
  grip.innerHTML = ICONS.grip
  grip.title = t('Drag to move this card')
  grip.setAttribute('aria-label', t('Drag to move this card'))
  card.appendChild(grip)

  grip.addEventListener('mousedown', (down) => startDrag(down, card, body, id, hooks))

  // THE KEYBOARD MOVES IT TOO. A surface reachable only by mouse is a surface
  // half this app's readers cannot use, and the same clamp and the same commit
  // serve both — one keypress is one user action, so one commit is right here
  // where sixty would be wrong in a drag.
  grip.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 5 : 1
    const d: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    }
    const move = d[e.key]
    if (!move) return
    e.preventDefault()
    const b = hooks.block(id)
    if (!b) return
    const now = cardPos(b, indexOfCard(card))
    const max = limits(card, body)
    const next = {
      x: Math.min(max.x, clampPct(now.x + move[0])),
      y: Math.min(max.y, clampPct(now.y + move[1])),
    }
    if (next.x === now.x && next.y === now.y) return
    card.style.setProperty('--sp-x', String(next.x))
    card.style.setProperty('--sp-y', String(next.y))
    commitPos(hooks, id, next)
  })
}

const indexOfCard = (card: HTMLElement): number =>
  Math.max(0, [...(card.parentElement?.children ?? [])].indexOf(card))

/** How far right and down this card's TOP-LEFT may go and still leave the whole
 *  card on the surface. Measured, because a card's height is its text's. */
function limits(card: HTMLElement, body: HTMLElement): CardPos {
  const box = body.getBoundingClientRect()
  const r = card.getBoundingClientRect()
  if (!box.width || !box.height) return { x: 100, y: 100 }
  return {
    x: Math.max(0, round1(100 - (r.width / box.width) * 100)),
    y: Math.max(0, round1(100 - (r.height / box.height) * 100)),
  }
}

function startDrag(
  down: MouseEvent, card: HTMLElement, body: HTMLElement, id: string, hooks: CanvasHooks,
): void {
  down.preventDefault()
  const box = body.getBoundingClientRect()
  if (!box.width || !box.height) return
  const start = card.getBoundingClientRect()
  // where inside the card the grip was taken hold of, so the card does not jump
  const grabX = down.clientX - start.left
  const grabY = down.clientY - start.top
  const max = limits(card, body)
  const from = { x: cssNum(card, '--sp-x'), y: cssNum(card, '--sp-y') }
  let now = from
  document.body.classList.add('sp-canvas-dragging')
  card.classList.add('sp-cv-moving')

  const move = (m: MouseEvent) => {
    now = {
      x: Math.min(max.x, clampPct(((m.clientX - grabX - box.left) / box.width) * 100)),
      y: Math.min(max.y, clampPct(((m.clientY - grabY - box.top) / box.height) * 100)),
    }
    card.style.setProperty('--sp-x', String(now.x))
    card.style.setProperty('--sp-y', String(now.y))
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    document.body.classList.remove('sp-canvas-dragging')
    card.classList.remove('sp-cv-moving')
    // landed where it started: not a change, so not an undo step
    if (now.x === from.x && now.y === from.y) return
    commitPos(hooks, id, now)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

const cssNum = (el: HTMLElement, prop: string): number =>
  Number(el.style.getPropertyValue(prop)) || 0

/**
 * WRITE THE POSITION. `structure: false` because nothing moved in the block
 * list — a canvas drag changes two numbers on one block, and telling the store
 * otherwise makes it re-key the whole page for a card that slid 4%.
 */
function commitPos(hooks: CanvasHooks, id: string, p: CardPos): void {
  hooks.commit(() => {
    const b = hooks.block(id)
    if (!b) return
    b.x = p.x
    b.y = p.y
  }, { structure: false })
}
