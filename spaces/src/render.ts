// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// model → DOM. ONE renderer for the editor, the reader, print and (later) the
// file-manager preview, so those surfaces can never disagree about what a
// document looks like.
//
// The renderer emits REAL SEMANTIC TAGS — h1..h3, ul/ol/li, blockquote,
// pre>code, figure — never divs with classes. That buys the screen-reader
// story, native ⌘F, print fidelity and lossless markdown export at once, from
// one decision.

import { type SpacesDoc, type Page, type Block, loadsRemotely, assetValue, tableOf, linkCard, coverSrc } from './model'
import { proceduralCoverSvg, proceduralCoverFor } from './procedural'
import { sanitizeInline, inertBody, esc } from './sanitize'
import { decorateTags } from './tags.ts'
import { tokenize } from './highlight'
import { t, locale } from './i18n'
import { TAG_OF, LIST_OF, SPEC, TONE, mediaPlayback } from './blocks'
import {
  fieldByKey, fieldsOf, optionOf, viewRows, headerLength, propBlockOf,
  passesFilter, filterCount, unknownFilterKeys, unknownSourceKeys,
  sortRows, unknownSortKeys, sortDirOf, layoutOf, nextLayout,
  type ViewSort, type FieldSpec, type ViewLayout, type IssueRow,
} from './fields'
import { renderCalendar, spanOf, nextSpan } from './calendar.ts'
import { unknownFilterOps } from './query.ts'
import { ganttModel } from './gantt.ts'
import { workloadModel, workloadOption, bucketField } from './workload.ts'
import { todayISO } from './journal.ts'
// THE SHARED CHART ENGINE, from the kernel and not from this app. dash already
// imports it from outside slides, so this is a settled cross-app path rather
// than a new one — and it is read-only: kernel/src is a serialized zone.
import { chartSnapshotSvg } from '../../kernel/src/charts.ts'
import { answer, feed, freshContext, type CalcCtx } from './calc.ts'
import { ICONS, type IconName } from './icons'
import { renderCanvasHead, placeCard } from './canvas.ts'
import { viewEmbed, anchorOf } from './embed.ts'
import { markRefs, notesOnPage, noteOf, noteId, refId, type PageNotes } from './footnotes.ts'
import { renderChartBlock } from './charts.ts'

export interface RenderOpts {
  /** editable per-block hosts (the editor); false for reader/print */
  editable?: boolean
  /** resolve a page id to its title, for link chips and pagelink blocks */
  titleOf?: (pageId: string) => string | undefined
  /**
   * This READER's preferred width for a page that does not state one.
   *
   * Viewer-scoped, like locale and the pane width — never a document field. It
   * is a fact about the screen somebody is sitting at, so two people opening
   * one space each get their own answer, and neither writes it into the file.
   */
  readerWidth?: 'wide' | 'full'
  /** collapsed toggles render OPEN — print always passes this */
  forceOpen?: boolean
  /** rendering to paper: no controls, because paper has no buttons */
  printing?: boolean
  /**
   * Has the READER agreed to load this remote url?
   *
   * A VIEWER-scoped decision, never a document field — the same rule as locale
   * and reduced motion. Putting consent in the file would mean the author
   * decides whether the reader phones home, which is precisely backwards, and
   * it would travel to the next person the file is mailed to.
   */
  allowRemote?: (src: string) => boolean
  /**
   * The pages already open above this render, host page first — the embed
   * cycle and depth guard (embed.ts `viewEmbed`).
   *
   * NOT a document field and not module state: it is a fact about one render
   * pass, and two surfaces render at once (the editor canvas and the still
   * preview), so a shared counter between them would be a race that only shows
   * up in a saved thumbnail. `renderBlocks` seeds it with the page it was
   * given, so nothing outside this file ever has to pass it.
   */
  embedChain?: readonly string[]
  /**
   * DERIVED, and set by `renderBlocks` for its own descent — never by a caller.
   *
   * Footnote numbering is a fact about a whole PAGE (order of appearance), and
   * `renderBlock` draws one block, so the numbering has to arrive from above.
   * It rides in the options rather than as a fifth parameter for the same
   * reason `calc` does not: every intermediate would have to thread it.
   */
  footnotes?: PageNotes
  /** the page whose numbering `footnotes` is — DOM ids are document-global and
   *  print draws every page at once, so a label's ids are scoped by page */
  footnoteScope?: string
}

// The tag and list maps come from the block registry (blocks.ts), so a new
// block type declares its element once instead of being added here, to the /
// menu, to the autoformat table and to the markdown exporter separately.


/**
 * Render one page's blocks.
 *
 * Nesting is `Block.parent`, and the array is pre-order, so a child always
 * follows its parent. That is what lets a single forward pass build the tree
 * without a lookup table.
 */
export function renderBlocks(page: Page, doc: SpacesDoc, opts: RenderOpts = {}): DocumentFragment {
  const frag = document.createDocumentFragment()
  // The embed guard starts here, with the page being drawn, so an embed of the
  // page you are ON is a cycle at depth zero. Seeded rather than mutated: the
  // caller's opts object is not ours to write to.
  if (!opts.embedChain) opts = { ...opts, embedChain: [page.id] }
  // FOOTNOTE NUMBERING IS COMPUTED ONCE, HERE. It is order-of-appearance over
  // the whole page, so no block can work it out on its own — and it is derived
  // every paint rather than stored, so inserting a reference renumbers
  // everything after it with nothing to keep in step (src/footnotes.ts).
  const fnotes = notesOnPage(doc, page)
  if (fnotes.order.length) opts = { ...opts, footnotes: fnotes, footnoteScope: page.id }
  // MAGIC NOTES' CONTEXT, accumulated as the pass goes. A name is defined by a
  // line and usable by the lines BELOW it — the same direction a person reads
  // in, and the reason this needs no second pass and cannot cycle.
  const calc: CalcCtx = freshContext()
  // stack of open containers, innermost last: [blockId, element, type]
  //
  // The TYPE is on the stack because a canvas's children are POSITIONED and
  // nothing else's are. A block cannot know that on its own — `x` and `y` mean
  // "where on the surface" only inside a surface — so the placement decision
  // belongs here, where the open container is known, rather than to a test on
  // the child that would also fire on a stray `x` anywhere else in a document.
  const stack: Array<[string, HTMLElement, string]> = []
  let list: { el: HTMLElement; kind: 'ul' | 'ol'; under: string } | null = null

  const hostFor = (parent: string | undefined): HTMLElement | DocumentFragment => {
    while (stack.length && stack[stack.length - 1][0] !== parent) stack.pop()
    return stack.length ? stack[stack.length - 1][1] : frag
  }

  // FIELDS AT THE TOP ARE A HEADER STRIP — by position, not by a flag.
  //
  // `prop` blocks that precede the first non-prop block are drawn as one
  // compact row under the title; the same blocks further down render inline.
  // Nothing in the format says "this is a header", so a build that predates all
  // of this shows exactly the same values in exactly the same order, just
  // stacked — which is the whole reason the header is a convention rather than
  // a container.
  const head = headerLength(page)
  let strip: HTMLElement | null = null
  if (head > 0) {
    strip = document.createElement('div')
    strip.className = 'sp-props'
    frag.appendChild(strip)
  }

  page.blocks.forEach((b, i) => {
    // MAGIC NOTES' CONTEXT IS FED AFTER THE BLOCK IS DRAWN, not before, and the
    // order is the whole difference between `sum above` working and reading 0:
    // an answering line ENDS the run of figures it summarises, so feeding it
    // first cleared the very run its own answer needed. After means a line sees
    // exactly what is above it and nothing of itself — which is also what makes
    // a name usable by the lines below and by none above.
    const takeIn = () => feed(calc, textFromHtml(b.html))
    if (strip && i < head) {
      strip.appendChild(renderBlock(b, doc, opts, calc))
      takeIn()
      return
    }
    const host = hostFor(b.parent)
    const kind = LIST_OF[b.type]

    // adjacent same-kind list items share one <ul>/<ol>
    if (kind) {
      if (!list || list.kind !== kind || list.under !== (b.parent ?? '')) {
        const el: HTMLElement = document.createElement(kind)
        el.className = 'sp-list'
        host.appendChild(el)
        list = { el, kind, under: b.parent ?? '' }
      }
    } else {
      list = null
    }

    const node = renderBlock(b, doc, opts, calc)
    takeIn()
    const into = kind && list ? list.el : host
    into.appendChild(node)
    // A CARD IS PLACED AFTER IT IS APPENDED: its index among its siblings is
    // the fallback position for a card that has never been dragged, and the
    // index is a fact about the parent, not about the block.
    if (stack.length && stack[stack.length - 1][0] === b.parent && stack[stack.length - 1][2] === 'canvas') {
      placeCard(node, b)
    }

    // A CONTAINER owns the blocks whose parent is its id. Which types those are
    // is registry data (blocks.ts `container`), not a name test here — the
    // second container type is what turned `b.type === 'toggle'` from a fact
    // into a bug waiting for the third one.
    const container = SPEC.get(b.type)?.container
    if (container) {
      const body = document.createElement('div')
      body.className = `sp-${b.type}-body`
      if (container === 'fold' && !(opts.forceOpen || b.open)) body.hidden = true
      node.appendChild(body)
      stack.push([b.id, body, b.type])
      list = null
    } else if (kind) {
      // A LIST ITEM OWNS ITS INDENTED CHILDREN.
      //
      // Tab already wrote `parent` (editor.indent), and nothing rendered it:
      // only registry containers opened a body, so an indented bullet came out
      // flat and Tab was a key that did nothing you could see. The <li> IS the
      // host — that is what HTML nesting is — so a child list starts inside it
      // and `list.under` changing is what makes the grouping open a fresh
      // <ul>/<ol> at the deeper level.
      //
      // Not `container: true` in the registry: a list item does not take a body
      // div, it takes children directly, and the gutter/inline-host rules that
      // `container` implies are wrong for it.
      stack.push([b.id, node, b.type])
    }
  })
  return frag
}

export function renderBlock(b: Block, doc: SpacesDoc, opts: RenderOpts = {}, calc: CalcCtx = {}): HTMLElement {
  const type = b.type
  const el = document.createElement(TAG_OF[type] ?? 'div')
  el.dataset.blockId = b.id
  el.dataset.type = type
  el.className = `sp-b sp-b-${type}`

  switch (type) {
    case 'divider':
      el.className = 'sp-b sp-b-divider'
      el.appendChild(document.createElement('hr'))
      return el

    case 'code': {
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      // `language-xx` is the convention every markdown pipeline already reads,
      // and it carries the author's raw tag even when this build cannot
      // highlight it. esc() because it lands in a class attribute.
      if (b.lang) code.className = `language-${esc(String(b.lang))}`
      if (opts.editable) { code.contentEditable = 'true'; code.dataset.edit = b.id }
      paintCode(code, textFromHtml(b.html), b.lang)
      pre.appendChild(code)
      el.appendChild(pre)
      return el
    }

    case 'image': {
      const fig = document.createElement('figure')
      const rawSrc = String(b.src ?? '')

      // A REMOTE image is not loaded until the reader asks for it.
      //
      // Measured: a space carrying <img src="https://…/pixel.png"> requests it
      // on open. In a format whose whole point is that you can mail it, that is
      // a tracking pixel — the recipient's IP and the moment they opened your
      // document, delivered to whoever wrote the file. It also breaks PLATFORM
      // §1: no network is required to open a document.
      //
      // This costs authors nothing, because the editor never writes a remote
      // src: picked images are downscaled, interned by content hash and stored
      // as `asset:`. Only hand- or agent-authored documents carry URLs, and for
      // those the reader gets a placeholder naming the host and a button. One
      // click, per image, informed — the model every mail client settled on.
      if (loadsRemotely(rawSrc, doc) && !opts.allowRemote?.(rawSrc)) {
        fig.appendChild(remotePlaceholder(rawSrc, b, opts,
          t('Image from {host}', { host: remoteHost(resolveSrc(rawSrc, doc)) }), t('Load this image')))
        if (b.caption) {
          const cap = document.createElement('figcaption')
          cap.innerHTML = sanitizeInline(String(b.caption))
          fig.appendChild(cap)
        }
        el.appendChild(fig)
        return el
      }

      const img = document.createElement('img')
      img.src = resolveSrc(rawSrc, doc)
      img.alt = String(b.alt ?? '')
      if (b.width) img.style.width = `${Math.max(10, Math.min(100, Number(b.width)))}%`
      // intrinsic size holds the aspect box while the image decodes, so the
      // page does not reflow under the reader's cursor
      if (b.w && b.h) { img.width = Number(b.w); img.height = Number(b.h) }
      fig.appendChild(img)
      if (b.caption) {
        const cap = document.createElement('figcaption')
        cap.innerHTML = sanitizeInline(String(b.caption))
        fig.appendChild(cap)
      }
      el.appendChild(fig)
      return el
    }

    case 'table': {
      el.appendChild(renderTable(b, opts))
      return el
    }

    case 'media': {
      const fig = document.createElement('figure')
      const play = mediaPlayback(b)
      const rawSrc = String(b.src ?? '')
      el.dataset.kind = play.kind
      const done = () => {
        if (b.caption) {
          const cap = document.createElement('figcaption')
          cap.innerHTML = sanitizeInline(String(b.caption))
          fig.appendChild(cap)
        }
        el.appendChild(fig)
        return el
      }

      // NO SOURCE YET. Inserting the block and choosing the file are two
      // gestures — a picker can be cancelled, and a link has to be typed
      // somewhere — so the empty state is part of the block rather than a
      // failure of it. The editor wires these two buttons; a reader, a
      // printout and a still see the same box saying what is missing, which is
      // more honest than a gap.
      if (!rawSrc) {
        const box = document.createElement('div')
        box.className = 'sp-media-empty'
        const line = document.createElement('div')
        line.className = 'sp-remote-line'
        line.textContent = play.kind === 'audio' ? t('Audio') : t('Video')
        box.appendChild(line)
        if (opts.editable && !opts.printing) {
          const pick = document.createElement('button')
          pick.type = 'button'
          pick.className = 'sp-btn sp-remote-load'
          pick.textContent = t('Choose a file…')
          pick.dataset.pickMedia = b.id
          const link = document.createElement('button')
          link.type = 'button'
          link.className = 'sp-btn sp-remote-load'
          link.textContent = t('Use a link…')
          link.dataset.linkMedia = b.id
          const row = document.createElement('div')
          row.className = 'sp-media-actions'
          row.append(pick, link)
          box.appendChild(row)
        }
        fig.appendChild(box)
        return done()
      }

      // THE SAME CONSENT GATE AS AN IMAGE, and it matters MORE here. A remote
      // <video> asks its host for byte ranges the moment the element is
      // parsed, so an autoplaying tracker is not even needed: opening the
      // space is the ping. Same rule, same host named, different words.
      if (loadsRemotely(rawSrc, doc) && !opts.allowRemote?.(rawSrc)) {
        const host = remoteHost(rawSrc)
        fig.appendChild(remotePlaceholder(rawSrc, b, opts,
          play.kind === 'audio' ? t('Audio from {host}', { host }) : t('Video from {host}', { host }),
          play.kind === 'audio' ? t('Load this audio') : t('Load this video')))
        return done()
      }

      // PAPER AND THUMBNAILS GET A STILL, NEVER A PLAYER.
      //
      // `printing` is the flag both of those surfaces already pass (print, and
      // preview.ts's file-manager render), and it is the honest test: it means
      // "this output cannot be interacted with". A <video> on paper prints as
      // a black rectangle; in a file-manager preview it would be an element
      // that decodes, buffers and — with scripting off, where nothing can stop
      // it — sits there holding a source open. preview.ts also BANS the tags
      // outright, which is defence in depth rather than the mechanism: by the
      // time it runs there is nothing to ban.
      if (opts.printing) {
        fig.appendChild(mediaStill(b, doc, opts, play.kind))
        return done()
      }

      const m = document.createElement(play.kind === 'audio' ? 'audio' : 'video') as
        HTMLVideoElement | HTMLAudioElement
      m.className = 'sp-media'
      m.src = resolveSrc(rawSrc, doc)
      // metadata, not auto: enough to draw the first frame and a duration, and
      // no more. `auto` on a linked clip downloads the whole thing to display a
      // page nobody has pressed play on.
      m.preload = 'metadata'
      // A block with controls off is a rectangle you cannot use, which is fine
      // for a reader looking at a caption-and-poster figure and useless to the
      // author who has to click it to change it. So the editor always has them.
      m.controls = play.controls || opts.editable === true
      m.loop = play.loop
      // NOTHING SETS `m.autoplay`. mediaPlayback() cannot return true for it,
      // and this is the surface that would have obeyed it — see blocks.ts.
      if (play.kind === 'video') {
        const v = m as HTMLVideoElement
        // iOS otherwise takes the clip fullscreen on play, which throws the
        // reader out of the page they were reading
        v.playsInline = true
        // muted is a VIDEO choice: a silent audio block is a block that does
        // nothing, so the editor does not offer it and neither does this
        v.muted = play.muted
        const poster = String(b.poster ?? '')
        // a remote poster is the same tracking pixel as a remote image, so it
        // goes through the same consent
        if (poster && !(loadsRemotely(poster, doc) && !opts.allowRemote?.(poster))) {
          const resolved = resolveSrc(poster, doc)
          if (resolved) v.poster = resolved
        }
        if (b.w && b.h) { v.width = Number(b.w); v.height = Number(b.h) }
        if (b.width) v.style.width = `${Math.max(10, Math.min(100, Number(b.width)))}%`
      }
      fig.appendChild(m)
      return done()
    }

    case 'pagelink': {
      const a = document.createElement('a')
      const target = String(b.page ?? '')
      a.href = `#p/${target}`
      a.className = 'sp-pagecard'
      const title = opts.titleOf?.(target)
      a.textContent = title ?? '(missing page)'
      if (!title) a.classList.add('sp-dead')
      el.appendChild(a)
      return el
    }

    case 'embed': {
      renderEmbed(el, b, doc, opts)
      return el
    }

    case 'link': {
      // A CARD DRAWN ENTIRELY FROM THE FILE.
      //
      // There is no fetch here and there is no deferred one either. Every value
      // was typed by the author and stored; the only thing derived at render
      // time is the site name, and that is `new URL(url).host` — parsing, not a
      // request. PLATFORM §1 and the 2026-08-03 decision both land on this
      // line, so the negative test in scripts/test-spaces-model.ts pins it.
      const c = linkCard(b)
      el.classList.add('sp-link')

      // AN ANCHOR ONLY WHEN THERE IS SOMEWHERE TO GO. A card whose url is
      // empty, or is a `javascript:`/`data:` string out of a mailed file, is a
      // <div>: `linkCard` returns '' for all three, and an <a> with no href is
      // a link a keyboard can focus and a screen reader will announce, leading
      // nowhere.
      const card = document.createElement(c.url ? 'a' : 'div')
      card.className = 'sp-linkcard'
      if (c.url) {
        const a = card as HTMLAnchorElement
        a.href = c.url
        // the same treatment sanitizeInline gives an external link: this leaves
        // the document, so it must not be able to reach back through opener
        a.rel = 'noopener noreferrer'
        a.target = '_blank'
      } else {
        card.classList.add('sp-dead')
      }

      // THE THUMBNAIL IS LOCAL OR IT IS ABSENT. `linkCard` drops one that was
      // WRITTEN remote, and that is as far as it can see: it takes a block, not
      // a document, so it cannot know what an `asset:` key resolves to. The
      // asset table is exactly where a remote URL hid, so the resolved check has
      // to happen at the one place that holds both the src and the document —
      // here, which is also the only place that loads anything.
      if (c.image && !loadsRemotely(c.image, doc)) {
        const img = document.createElement('img')
        img.src = resolveSrc(c.image, doc)
        img.alt = ''
        img.className = 'sp-linkcard-img'
        card.appendChild(img)
      }

      const body = document.createElement('span')
      body.className = 'sp-linkcard-body'

      const title = document.createElement('span')
      title.className = 'sp-linkcard-title'
      // an empty card is not an empty box: it says what it is and, in the
      // editor, offers the way to fill it in
      title.textContent = c.title || t('A link with nothing in it yet')
      body.appendChild(title)

      if (c.desc) {
        const desc = document.createElement('span')
        desc.className = 'sp-linkcard-desc'
        desc.textContent = c.desc
        body.appendChild(desc)
      }

      const foot = document.createElement('span')
      foot.className = 'sp-linkcard-site'
      if (c.icon) {
        const mark = document.createElement('span')
        mark.className = 'sp-linkcard-mark'
        // textContent, never innerHTML: this is one field out of a mailed file
        mark.textContent = c.icon
        foot.appendChild(mark)
      }
      const site = document.createElement('span')
      site.textContent = c.site || c.url
      foot.appendChild(site)
      if (c.site || c.url || c.icon) body.appendChild(foot)

      card.appendChild(body)
      el.appendChild(card)

      // The card itself opens the link, so editing needs its own control — and
      // only where there is an editor. Reading view, print and a locked space
      // must not paint a button that does nothing (the callout chip's rule).
      if (opts.editable) {
        const edit = document.createElement('button')
        edit.type = 'button'
        edit.className = 'sp-linkcard-edit'
        edit.dataset.editLink = b.id
        edit.title = t('Edit this link card')
        edit.textContent = c.url ? t('Edit') : t('Add a link')
        el.appendChild(edit)
      }
      return el
    }

    case 'todo': {
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = !!b.done
      box.className = 'sp-check'
      // the checkbox is a control, not text: it must not be inside the
      // editable host or typing would land in it
      el.appendChild(box)
      hostAndAnswer(el, b, opts, calc)
      if (b.done) el.classList.add('sp-done')
      return el
    }

    case 'prop': {
      // A FIELD VALUE. The chip is built from the schema, but the block's own
      // `html` is what a build that does not know this type shows — so the two
      // must always say the same thing, and fields.ts keeps them in step.
      const key = String((b as { key?: unknown }).key ?? '')
      const f = fieldByKey(doc, key)
      const value = (b as { value?: unknown }).value
      el.classList.add('sp-prop')
      el.dataset.field = key

      const label = document.createElement('span')
      label.className = 'sp-prop-key'
      label.textContent = f?.label ?? key
      el.appendChild(label)

      const val = document.createElement(opts.editable ? 'button' : 'span')
      val.className = 'sp-prop-val'
      if (opts.editable) {
        ;(val as HTMLButtonElement).type = 'button'
        val.dataset.editField = key
      }
      const opt = f && optionOf(f, value)
      if (opt) {
        const dot = document.createElement('span')
        dot.className = 'sp-prop-dot'
        // colour is a HINT, never the meaning — the label is always present, so
        // this reads correctly in monochrome and without colour vision
        if (opt.color) dot.style.background = opt.color
        val.appendChild(dot)
      }
      const text = document.createElement('span')
      text.textContent = shownValue(f, value)
      val.appendChild(text)
      el.appendChild(val)
      return el
    }

    case 'canvas': {
      // The BODY is opened by renderBlocks (registry `container`), which is
      // also what puts the cards in it — so this draws the chrome and nothing
      // else. `cards` is only needed for the empty-state line, and counting
      // here rather than after the fact keeps renderBlock a pure function of
      // one block.
      const cards = doc.pages
        .find((p) => p.blocks.some((x) => x.id === b.id))?.blocks
        .filter((x) => x.parent === b.id).length ?? 0
      renderCanvasHead(el, b, opts.editable === true, cards)
      return el
    }

    case 'view': {
      el.classList.add('sp-view')
      renderView(el, b, doc, opts)
      return el
    }

    case 'chart': {
      // A CHART OF THE TRAIL, not of the pages — see blocks.ts and charts.ts
      // for why that makes it a block rather than a view layout. `todayISO()`
      // is the reader's own wall-clock day: the today point is DERIVED from
      // live state, every earlier day is read from the record.
      el.classList.add('sp-chart')
      renderChartBlock(el, b, doc, todayISO(), { editable: opts.editable === true })
      return el
    }

    case 'callout': {
      const raw = String(b.tone ?? 'note')
      const known = TONE.has(raw) ? raw : 'note'
      // Only a KNOWN tone reaches the class name. An unrecognised one keeps the
      // neutral treatment (and its own word as the label) — and a class built
      // from an arbitrary string out of a mailed file is a thing not to have.
      el.className = `sp-b sp-b-callout sp-tone-${known}`

      // The chip is the tone control when there is an editor to change it in,
      // and a plain label otherwise — reading view, print and a locked space
      // must not paint a button that does nothing.
      const chip = document.createElement(opts.editable ? 'button' : 'span')
      chip.className = 'sp-callout-chip'
      if (chip instanceof HTMLButtonElement) {
        chip.type = 'button'
        chip.title = t('Change the kind of callout')
      }
      const mark = document.createElement('span')
      mark.className = 'sp-callout-mark'
      calloutMark(mark, b, known)
      const label = document.createElement('span')
      label.className = 'sp-callout-label'
      // NOT aria-hidden and never a ::before: the tone is content the way a
      // "Warning:" printed on a page is content. A screen reader reading this
      // page linearly must hear it, and a printout must carry it.
      label.textContent = toneLabel(raw)
      chip.append(mark, label)
      el.appendChild(chip)
      hostAndAnswer(el, b, opts, calc)
      return el
    }

    case 'toggle': {
      const twist = document.createElement('button')
      twist.className = 'sp-twist'
      twist.type = 'button'
      twist.setAttribute('aria-expanded', String(!!(opts.forceOpen || b.open)))
      twist.setAttribute('aria-label', t('Toggle section'))
      twist.textContent = '▸'
      el.appendChild(twist)
      hostAndAnswer(el, b, opts, calc)
      return el
    }

    default:
      hostAndAnswer(el, b, opts, calc)
      return el
  }
}

/**
 * A table — the same DOM in the editor, the reading view, print and the still
 * preview, because there is one renderer.
 *
 * REAL `<table>`, `<thead>`, `<th>`, exactly as this renderer emits real
 * headings and real list items: that is what buys the screen-reader story
 * (row and column announcement), native ⌘F, print fidelity and a lossless
 * markdown export, all from one decision. A grid of divs would need four
 * separate answers.
 *
 * The widths are a `<colgroup>` over `table-layout: fixed` — the one layout
 * mode in which a column's width is what the document SAYS rather than what
 * this reader's font measured, so a table looks the same to everyone the file
 * is mailed to. Percentages, never px: `cols` holds fractions (model.ts) and
 * the text column is a theme concern.
 *
 * Cells are editable HOSTS in the editor and inert `<td>`s everywhere else, and
 * the editable one is the cell itself rather than a span inside it — a cell is
 * a box you click into, and a nested host makes a 1px strip around its edge
 * that swallows the click.
 */
function renderTable(b: Block, opts: RenderOpts): HTMLElement {
  const t = tableOf(b)
  const wrap = document.createElement('div')
  // A wide table SCROLLS rather than widening the prose column: the measure is
  // the document's, and a five-column table must not push the paragraph above
  // it off the screen on a phone.
  wrap.className = 'sp-tb-wrap'
  const table = document.createElement('table')
  table.className = 'sp-tb'
  const total = t.cols.reduce((s, n) => s + n, 0) || t.w
  const group = document.createElement('colgroup')
  for (const w of t.cols) {
    const col = document.createElement('col')
    col.style.width = `${((w / total) * 100).toFixed(3)}%`
    group.appendChild(col)
  }
  table.appendChild(group)

  const body = document.createElement('tbody')
  t.rows.forEach((row, r) => {
    const head = t.header && r === 0
    const tr = document.createElement('tr')
    row.forEach((cell, c) => {
      const td = document.createElement(head ? 'th' : 'td')
      td.className = 'sp-tb-cell'
      td.dataset.r = String(r)
      td.dataset.c = String(c)
      if (head) td.setAttribute('scope', 'col')
      if (t.colAlign[c]) td.style.textAlign = t.colAlign[c]
      // per cell, for the reason text blocks carry it: a table of Arabic terms
      // beside English ones must lay each column out by what is IN it
      td.dir = 'auto'
      if (opts.editable) {
        td.contentEditable = 'true'
        // NOT `data-edit`: that name means "this element's html IS the block's
        // html", and the editor's generic input handler would write one cell
        // over the whole table. A cell says which block AND which cell it is.
        td.dataset.cell = b.id
      }
      td.innerHTML = sanitizeInline(cell)
      decorateTags(td)
      // the same either/or as inlineHost, for the same reason — a cell is an
      // editable host too
      const cleanCell = sanitizeInline(cell)
      td.innerHTML = opts.editable || !opts.footnotes
        ? cleanCell
        : markRefs(cleanCell, opts.footnotes, opts.footnoteScope ?? '')
      tr.appendChild(td)
    })
    if (head) {
      const thead = document.createElement('thead')
      thead.appendChild(tr)
      table.appendChild(thead)
    } else body.appendChild(tr)
  })
  table.appendChild(body)
  wrap.appendChild(table)
  return wrap
}

/**
 * An embed: the source page's own blocks, drawn here.
 *
 * THREE THINGS THIS DOES THAT ARE NOT DECORATION.
 *
 * It is ATTRIBUTED and clickable. A block of someone else's page dropped into
 * yours with no seam is a lie about where the words live, and the reader who
 * wants to fix a typo has nowhere to go. The header names the source page and
 * links to it, and the section when there is one.
 *
 * It is NEVER EDITABLE, whatever the host surface is. The blocks belong to
 * another page; an editable host here would write a keystroke into `html` on a
 * block the editor is not showing, and the change would appear to happen
 * nowhere. `editable: false` on the nested render is the whole of that.
 *
 * And it carries NO `data-block-id`. The editor's paint sweeps every
 * `[data-block-id]` under the page and hangs a drag gutter, a checkbox
 * handler, a language chip on each — all keyed to `store.block(id)`, which
 * resolves ANY id in the document. A checkbox ticked inside an embed would
 * have committed to the source page from a surface that was not showing it.
 * Stripping the hook is one line and closes the whole class.
 */
function renderEmbed(el: HTMLElement, b: Block, doc: SpacesDoc, opts: RenderOpts): void {
  const box = document.createElement('div')
  box.className = 'sp-embed'
  const view = viewEmbed(b, doc, opts.embedChain ?? [])

  const head = document.createElement(view.page ? 'a' : 'div')
  head.className = 'sp-embed-src'
  const anchor = anchorOf(b)
  if (view.page) {
    ;(head as HTMLAnchorElement).href = `#p/${view.page.id}`
    head.textContent = anchor ? `${view.page.title} › ${anchor}` : view.page.title
    head.setAttribute('aria-label', t('Embedded from {page}', { page: view.page.title }))
  } else {
    head.textContent = anchor ? `[[?#${anchor}]]` : '[[?]]'
    head.classList.add('sp-dead')
  }
  box.appendChild(head)

  if (!view.ok) {
    const note = document.createElement('p')
    note.className = 'sp-embed-note'
    note.textContent =
      view.why === 'cycle' ? t('This embed is inside itself — the loop stops here.')
        : view.why === 'depth' ? t('Embeds are not followed deeper than this.')
          : view.why === 'no-section' ? t('No section named {name} on this page.', { name: view.anchor ?? '' })
            : t('This embed points at a page that is not here.')
    box.appendChild(note)
    el.appendChild(box)
    return
  }

  const body = document.createElement('div')
  body.className = 'sp-embed-body'
  body.appendChild(renderBlocks({ ...view.page, blocks: view.blocks }, doc, {
    ...opts,
    editable: false,
    embedChain: [...(opts.embedChain ?? []), view.page.id],
  }))
  for (const node of body.querySelectorAll<HTMLElement>('[data-block-id]')) {
    delete node.dataset.blockId
  }
  box.appendChild(body)
  el.appendChild(box)
}

/**
 * A callout tone's name, in the reader's language.
 *
 * Written out as t() calls rather than read from a table in blocks.ts: the i18n
 * sweep (scripts/build-spaces-i18n.mjs) collects t() calls with a LITERAL
 * STRING out of the source, so a name held as data would ship English to all
 * eight locales. A tone with no case here fails scripts/test-spaces-model.ts.
 *
 * (The sweep reads comments too, so do not write an example call in one.)
 *
 * An UNRECOGNISED tone returns its own word. A file from a future build that
 * says `success` should say "success", not "Note" — the label is the one place
 * that can tell the reader the truth about a tone we cannot draw.
 */
export function toneLabel(tone: string): string {
  switch (tone) {
    case 'note': return t('Note')
    case 'tip': return t('Tip')
    case 'important': return t('Important')
    case 'warning': return t('Warning')
    case 'caution': return t('Caution')
    default: return tone
  }
}

/**
 * Fill a callout's mark: the author's override if there is one, else the tone's
 * own shape.
 *
 * The override follows the same rule as a page icon (editor.ts pageIcon) — a
 * name from the icon set, or any other string as literal TEXT, which is how an
 * emoji works. textContent, never innerHTML: this string came out of a file
 * someone sent you.
 *
 * `Object.hasOwn`, not `in`: ICONS is an object literal, so `'toString' in
 * ICONS` is TRUE and the lookup hands back a function, which would then be
 * stringified into the page as markup.
 */
function calloutMark(host: HTMLElement, b: Block, known: string): void {
  const custom = typeof b.icon === 'string' ? b.icon : ''
  if (custom) {
    if (Object.hasOwn(ICONS, custom)) host.innerHTML = ICONS[custom as IconName]
    else host.textContent = custom
    return
  }
  host.innerHTML = ICONS[(TONE.get(known) ?? TONE.get('note')!).icon]
}

/**
 * The editable host, plus the ANSWER when the line asks for one.
 *
 * The answer is a SIBLING of the editable span, never inside it. Inside, it
 * would be part of what contentEditable hands back on the next keystroke, and
 * the derived answer would be committed into `html` — which is exactly the
 * frozen-result design this feature exists to avoid. It is also
 * contenteditable=false and aria-hidden: it is output, not text, and a screen
 * reader should hear the line once.
 */
function hostAndAnswer(el: HTMLElement, b: Block, opts: RenderOpts, ctx: CalcCtx): void {
  el.appendChild(inlineHost(b, opts))
  const ans = answer(textFromHtml(b.html), ctx, locale())
  if (ans === null) return
  const out = document.createElement('span')
  out.className = 'sp-ans'
  out.contentEditable = 'false'
  out.setAttribute('aria-hidden', 'true')
  out.textContent = ans
  el.appendChild(out)
}

/** The editable text host. Per-block, never one big editable container — that
 *  is what keeps Selection block-scoped and stops a merge re-minting ids. */
function inlineHost(b: Block, opts: RenderOpts): HTMLElement {
  const inner = document.createElement('span')
  inner.className = 'sp-text'
  inner.dataset.edit = b.id
  // direction is per-block from the CONTENT, inside a container pinned by the
  // document's theme.dir — PLATFORM §8's two-layer rule
  inner.dir = 'auto'
  if (opts.editable) inner.contentEditable = 'true'
  inner.innerHTML = sanitizeInline(b.html ?? '')
  // Chips are drawn INTO the editable host, and taken back out of whatever the
  // editor commits (`tags.ts readInline`). Rendering them only in the reader
  // would be safer and would also mean the one view people actually write in
  // is the one view that cannot show a tag.
  decorateTags(inner)
  // MARKERS ARE DRAWN ONLY WHERE THEY CANNOT BE TYPED INTO. `host.innerHTML`
  // is written straight to `Block.html` on every `input` event, so a `<sup>`
  // injected into an editable host is one keystroke from being committed to the
  // document — and the reference `[^1]` it replaced would be gone. While a
  // block is editable the author sees and edits the token, exactly as they see
  // and edit `budget * 0.3 =` (calc.ts). Reading view, print and the
  // file-manager still are all `editable: false` and get the superscript.
  const clean = sanitizeInline(b.html ?? '')
  inner.innerHTML = opts.editable || !opts.footnotes
    ? clean
    : markRefs(clean, opts.footnotes, opts.footnoteScope ?? '')
  if (!b.html) inner.dataset.empty = '1'
  return inner
}

// Untrusted html — parse INERT. A detached div still loads what it creates,
// so `<img src="404" onerror>` in a code block would run its handler here.
// See sanitize.ts inertBody().
const textFromHtml = (html: string | undefined): string => {
  if (!html) return ''
  return inertBody(html).textContent ?? ''
}

/**
 * Paint highlighted code into a `<code>` element — the ONE place colour is
 * applied, so the editor, the reader and print can never disagree.
 *
 * NOTHING IS BUILT AS A STRING. `tokenize` returns ranges into `text`, and
 * every node here comes from `createTextNode`/`textContent`. Code is text
 * someone mailed you; the model never gains markup and neither does the DOM.
 *
 * IT RECONCILES RATHER THAN REPLACING, and that is the whole answer to
 * highlighting a live contenteditable. On `input` the browser has ALREADY
 * applied the keystroke to the DOM, so re-tokenising the same text usually
 * yields byte-identical nodes: typing inside a string, a comment or an
 * identifier changes that token's text and nothing else, the existing text node
 * already holds the new value, and this function performs ZERO mutations. The
 * caret is not restored because it was never disturbed.
 *
 * Only a keystroke that moves a token BOUNDARY — opening a quote, completing a
 * keyword — restructures anything, and then `changed` is true and the caller
 * puts the caret back by character offset. Assigning `Text.data` wholesale is
 * specified to collapse a live range inside it to offset 0, so a restore is
 * genuinely required there; it is just rare.
 *
 * Returns whether the DOM changed.
 */
export function paintCode(code: HTMLElement, text: string, lang?: unknown): boolean {
  let changed = false
  let node: ChildNode | null = code.firstChild

  for (const tk of tokenize(text, lang)) {
    const s = text.slice(tk.a, tk.b)
    if (tk.k) {
      const cls = `sp-t-${tk.k}`
      const fit = node?.nodeType === 1 && (node as HTMLElement).className === cls &&
        node.firstChild?.nodeType === 3 && !node.firstChild.nextSibling
      if (fit) {
        if (node!.firstChild!.nodeValue !== s) { (node!.firstChild as Text).data = s; changed = true }
      } else {
        const span = document.createElement('span')
        span.className = cls
        span.textContent = s
        code.insertBefore(span, node)
        changed = true
        continue   // `node` still has to be matched against the NEXT token
      }
    } else if (node?.nodeType === 3) {
      if (node.nodeValue !== s) { (node as Text).data = s; changed = true }
    } else {
      code.insertBefore(document.createTextNode(s), node)
      changed = true
      continue
    }
    node = node!.nextSibling
  }

  while (node) { const next = node.nextSibling; node.remove(); node = next; changed = true }
  return changed
}

/** What this src loads. One implementation, in model.ts, beside the predicate
 *  that decides whether loading it leaves the machine. */
export function resolveSrc(src: string, doc: SpacesDoc): string {
  return assetValue(src, doc)
}


/** The host a reader is being asked to trust, or the raw src if it will not parse. */
function remoteHost(src: string): string {
  try { return new URL(src, 'https://x.invalid').host || src } catch { return src }
}

/**
 * What stands in for an unloaded remote resource: what it is, WHERE it would
 * come from, and a button. Naming the host is the point — "load images" with no
 * indication of who is being contacted is not consent.
 *
 * `line` and `action` are passed rather than derived from the block, because a
 * video and an audio clip are the same gate with different words, and the
 * strings have to be LITERAL t() calls somewhere for the i18n sweep to find
 * them (scripts/build-spaces-i18n.mjs reads the source). Their call sites say
 * them; this says the part that is identical.
 */
function remotePlaceholder(
  src: string, b: Block, opts: RenderOpts, line0: string, action: string,
): HTMLElement {
  const box = document.createElement('div')
  box.className = 'sp-remote'
  box.dataset.remoteSrc = src

  const line = document.createElement('div')
  line.className = 'sp-remote-line'
  line.textContent = line0
  box.appendChild(line)

  const why = document.createElement('div')
  why.className = 'sp-remote-why'
  why.textContent = t('Not loaded — opening it would tell that site you opened this space.')
  box.appendChild(why)

  const alt = String(b.alt ?? '')
  if (alt) {
    const a = document.createElement('div')
    a.className = 'sp-remote-alt'
    a.textContent = alt
    box.appendChild(a)
  }

  // `allowRemote` is passed by print too, so this clause was always truthy there
  // and paper carried a live "Load this image" button. Print asks for it
  // explicitly instead.
  if (opts.printing !== true && (opts.editable !== false || opts.allowRemote)) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'sp-btn sp-remote-load'
    btn.textContent = action
    btn.dataset.loadRemote = src
    box.appendChild(btn)
  }
  return box
}

/**
 * What a clip looks like where nothing can play it: paper, and a file-manager
 * thumbnail.
 *
 * The POSTER if there is one — that is the frame the author chose, and it is
 * the whole reason the field is worth having — and otherwise a quiet box that
 * says what is there. Not nothing: a printed handbook that silently omits the
 * paragraph where the demo video was is the same class of bug as a toggle that
 * prints shut.
 *
 * A remote poster is skipped rather than fetched. preview.ts passes no
 * `allowRemote` at all, so a still built for a file manager can never make a
 * request — which is the point, because nobody is there to consent.
 */
function mediaStill(b: Block, doc: SpacesDoc, opts: RenderOpts, kind: 'video' | 'audio'): HTMLElement {
  const box = document.createElement('div')
  box.className = 'sp-media-still'
  const poster = String(b.poster ?? '')
  if (poster && !(loadsRemotely(poster, doc) && !opts.allowRemote?.(poster))) {
    const resolved = resolveSrc(poster, doc)
    if (resolved) {
      const img = document.createElement('img')
      img.src = resolved
      img.alt = String(b.alt ?? '')
      box.appendChild(img)
      box.classList.add('sp-has-poster')
    }
  }
  const badge = document.createElement('span')
  badge.className = 'sp-media-badge'
  // the triangle is the universal mark and needs no font; the word beside it
  // is what makes it readable aloud and in monochrome
  badge.textContent = `\u25B8 ${kind === 'audio' ? t('Audio') : t('Video')}`
  box.appendChild(badge)
  return box
}

/**
 * A whole page, including its title. The OUTER wrapper stays ltr — scrollLeft
 * and every coordinate calculation change meaning under rtl — and the INNER
 * container carries the document's declared base direction.
 */
export function renderPage(page: Page, doc: SpacesDoc, opts: RenderOpts = {}): HTMLElement {
  const art = document.createElement('article')
  art.className = 'sp-page'
  art.style.direction = 'ltr'

  const inner = document.createElement('div')
  inner.className = 'sp-page-inner'
  inner.dir = doc.theme.dir ?? 'ltr'
  // THE MEASURE IS FOR PROSE. A line of text has a comfortable width and that
  // is what `theme.measure` is for — but a board is not a line of text, and
  // squeezing one into 720px shows two and a half columns of a six-column
  // board. A page carrying a view gets the room instead; a page of writing
  // keeps its measure.
  // The page decides; a board is only the DEFAULT for a page that has not.
  // `width` absent on a board page keeps the room it always had, and an
  // unknown value from a newer build falls back to the measure rather than to
  // no width at all.
  const auto: 'wide' | undefined = page.blocks.some((b) => b.type === 'view') ? 'wide' : undefined
  // PRECEDENCE: what the PAGE says, then what this READER prefers, then the
  // board default, then the measure.
  //
  // The reader's preference is the piece this was missing. A per-page control
  // answers "this page needs the room"; it does not answer "I have a 27-inch
  // monitor", which is a fact about the person and not about any document —
  // and making them set it page by page is the wrong shape of work. It lives
  // in localStorage beside the language and the pane width, never in the file,
  // for the reason PLATFORM §8 gives about locale: two people opening one
  // space on different screens should each get their own answer.
  const width = page.width === 'wide' || page.width === 'full' ? page.width
    : page.width === undefined ? (opts.readerWidth ?? auto)
    : undefined
  if (width === 'full') inner.style.maxWidth = 'none'
  // WIDE IS A PROPORTION, not a number. It was a flat 1500px, which is wider
  // than the reading area of any laptop — so it clamped to the container and
  // came out identical to Full. Measured at a 1440px viewport: column 720,
  // wide 1130, full 1130. Two of the three choices did the same thing, and the
  // one screen where they differed was a 27-inch monitor.
  //
  // 80% keeps a visible step at every size, and the 1500px cap keeps Wide from
  // becoming an unreadable line on a very large screen — at which point Full is
  // the thing to pick, deliberately.
  // …WITH A FLOOR, because a proportion has nothing to be a proportion OF on a
  // phone. 80% of a 354px page is 283px, and the 26px the gutter takes there
  // leaves a 257px column on a 390px screen — a third of the display given to
  // margin on the setting whose entire purpose is "room for a board or a
  // table", and reachable in one tap ("Use this width for every page" is a
  // per-screen preference). `max(80%, 680px)` is the same 80% wherever 80% is
  // at least 680px (a container of 850px and up) and the whole container below
  // that, since a max-width wider than the box does nothing. Measured at 390px:
  // column 257 → 328, the page's left margin 79 → 26.
  else if (width === 'wide') inner.style.maxWidth = 'min(1500px, max(80%, 680px))'
  else if (doc.theme.measure) {
    // AND THE DEFAULT ITSELF GROWS. 720px is ~88 characters at 16px, which is
    // already at the long end — so this does not widen the line much; what it
    // does is stop a 2560px screen showing a 720px ribbon using 31% of it.
    // Capped, because past ~95 characters a line is harder to read, not easier.
    // THE CAP IS IN CHARACTERS, not pixels — that is the whole point.
    // A px cap does not hold a line length: capped at measure x 1.25 = 900px,
    // a 5120px screen rendered 110 characters, past the range anyone reads
    // comfortably, while the comment above it claimed ~95 was the limit.
    //
    // 75ch, not 90ch: `ch` is the width of the digit ZERO, and prose averages
    // narrower than that — measured here, 9.77px against 8.16px — so 75ch
    // renders about 90 real characters and 90ch would render 108. The unit
    // flatters itself by about a fifth.
    //
    // And because `ch` scales with --sp-read, the column grows in PIXELS on a
    // large screen while holding the same character count. That is what the
    // extra pixels are for: bigger type at a longer viewing distance, not a
    // longer line.
    const m = doc.theme.measure
    inner.style.maxWidth = `min(75ch, max(${m}px, 42vw))`
  }
  if (width) inner.classList.add('sp-wide')

  // THE COVER, above everything, and FULL-BLEED rather than inside the column.
  // That is what makes it read as a cover instead of as the first image in the
  // page: it belongs to the page, not to the prose, so it ignores the measure
  // the way a book's jacket ignores the type area. It escapes the reading
  // column's padding with negative margins off `--sp-pad-x/y`, which is why
  // that padding is written as variables — a hard-coded -44px would be wrong on
  // a phone, wrong in reading mode and wrong in print, all silently.
  //
  // `resolveSrc` is the same lookup an image block goes through, and `coverSrc`
  // is what refuses a remote one — so a cover can never make opening a document
  // a network request (PLATFORM §1).
  const cover = resolveSrc(coverSrc(page), doc)
  if (cover) {
    art.classList.add('sp-has-cover')
    const wrap = document.createElement('div')
    wrap.className = 'sp-cover'
    const img = document.createElement('img')
    img.className = 'sp-cover-img'
    img.src = cover
    // DECORATIVE, deliberately. The page's own title is right underneath it and
    // says the same thing; a screen reader announcing "cover image" before every
    // title is noise, and there is nowhere to write alt text for it anyway.
    img.alt = ''
    img.setAttribute('aria-hidden', 'true')
    wrap.appendChild(img)
    art.appendChild(wrap)
  } else {
    // NO COVER: the HOME page gets a procedural one — a figure seeded from its
    // id, never written to the document. The home page only, and never on
    // paper or in the thumbnail; procedural.ts decides and argues both. A page
    // whose cover is removed lands here again, which is the "gets it back" half.
    const gen = proceduralCoverFor(page, doc, opts.printing === true)
    if (gen) {
      art.classList.add('sp-has-cover')
      const wrap = document.createElement('div')
      wrap.className = 'sp-cover sp-cover-gen'
      wrap.innerHTML = gen
      art.appendChild(wrap)
    }
  }

  const h = document.createElement('h1')
  h.className = 'sp-title'
  h.dataset.pageTitle = page.id
  h.dir = 'auto'
  if (opts.editable) h.contentEditable = 'true'
  h.textContent = page.title
  inner.appendChild(h)

  inner.appendChild(renderBlocks(page, doc, opts))
  const feet = renderFootnotes(page, doc, opts)
  if (feet) inner.appendChild(feet)
  art.appendChild(inner)
  return art
}

/**
 * The notes at the foot of the page, or null when the page has none.
 *
 * DERIVED, LIKE THE NUMBERS. Nothing in the document says "put a footnote
 * section here" — the section IS the page's references, in the order they
 * appear, so deleting the last reference removes the section and no cleanup
 * has to remember to.
 *
 * A REFERENCE WITH NO NOTE STILL GETS A ROW, and that is the whole authoring
 * gesture: type `[^1]` in a sentence and an empty numbered slot appears down
 * here to write the note into. It is also why a dangling reference cannot be
 * silently lost — what validate() reports is the same thing the author is
 * already looking at.
 *
 * In the editor the note body is an editable host; in reading view, print and
 * the file-manager still it is inert. `data-edit-note`, deliberately NOT
 * `data-edit`: that name means "this element's html IS a BLOCK's html", and the
 * editor's generic input handler would write a note over a block.
 */
function renderFootnotes(page: Page, doc: SpacesDoc, opts: RenderOpts): HTMLElement | null {
  const notes = notesOnPage(doc, page)
  if (!notes.order.length) return null
  const sec = document.createElement('section')
  sec.className = 'sp-fnotes'
  // A real landmark with a real name: on paper it is the block at the foot of
  // the page, and to a screen reader it is the region the superscripts point at.
  sec.setAttribute('aria-label', t('Footnotes'))

  const ol = document.createElement('ol')
  ol.className = 'sp-fnlist'
  for (const label of notes.order) {
    const li = document.createElement('li')
    li.className = 'sp-fnote'
    li.id = noteId(page.id, label)

    // BACK TO THE SENTENCE. A footnote you cannot get back from costs the
    // reader their place; in print the anchor is inert and harmless, so it is
    // hidden by the stylesheet rather than conditioned on the surface here.
    const back = document.createElement('a')
    back.className = 'sp-fnback'
    back.href = `#${refId(page.id, label)}`
    back.textContent = '\u21A9'
    back.setAttribute('aria-label', t('Back to the text'))
    li.appendChild(back)

    const body = document.createElement('span')
    body.className = 'sp-fnbody'
    body.dir = 'auto'
    // The note came out of a file somebody mailed you, exactly like a block's
    // html, and goes through the same allowlist.
    body.innerHTML = sanitizeInline(noteOf(doc, label) ?? '')
    if (opts.editable) {
      body.contentEditable = 'true'
      body.dataset.editNote = label
      // `:empty::before`, the same idiom the canvas title uses — no companion
      // `data-empty` flag to keep in step with what the author has typed
      body.dataset.ph = t('Write the note')
    }
    li.appendChild(body)
    ol.appendChild(li)
  }
  sec.appendChild(ol)
  return sec
}

/** What a value reads as. Mirrors fields.ts propHtml, which writes the same
 *  text into the block so an older build shows it too. */
function shownValue(f: FieldSpec | undefined, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—'
  if (f?.vt === 'select') return optionOf(f, value)?.label ?? String(value)
  if (f?.vt === 'labels') return Array.isArray(value) ? value.join(', ') : String(value)
  return String(value)
}

/**
 * What a coverless card shows: the page's icon, else the first character of
 * its title.
 *
 * The same rule `calloutMark` follows and for the same reasons — a name from
 * the icon set is markup we wrote, anything else is TEXT out of a file someone
 * sent you, and `Object.hasOwn` keeps `toString` from resolving to a function.
 */
function pageMark(host: HTMLElement, page: Page): void {
  const icon = typeof page.icon === 'string' ? page.icon : ''
  if (icon) {
    if (Object.hasOwn(ICONS, icon)) { host.innerHTML = ICONS[icon as IconName]; host.classList.add('sp-gcard-ico') }
    else host.textContent = icon
    return
  }
  // [...str][0], not str[0]: an emoji or a CJK title is not one UTF-16 unit,
  // and slicing one in half renders a replacement character.
  host.textContent = [...(page.title || '?').trim()][0] ?? '?'
}

/**
 * A BOARD or a LIST of the issues in this space.
 *
 * Derived, never stored: the view holds a query, and the issues are wherever
 * they are. Storing membership would mean a card could disagree with the page
 * it stands for — the mistake every "database" makes when it keeps its own copy
 * of the rows.
 */
function renderView(host: HTMLElement, b: Block, doc: SpacesDoc, opts: RenderOpts): void {
  const layout = String((b as { layout?: unknown }).layout ?? 'board')
  const calSpan = (b as { span?: unknown }).span
  const groupKey = String((b as { groupBy?: unknown }).groupBy ?? 'status')
  const field = fieldByKey(doc, groupKey)
  const filter = (b as { filter?: unknown }).filter
  const sort = (b as { sort?: unknown }).sort
  const all = viewRows(doc, (b as { source?: unknown }).source)
  const rows = sortRows(doc, all.filter((r) => passesFilter(doc, r.values, filter, r.page)), sort)

  const head = document.createElement('div')
  head.className = 'sp-view-head'
  const title = document.createElement('span')
  title.className = 'sp-view-title'
  title.textContent = String(b.html || t('Issues'))
  const count = document.createElement('span')
  count.className = 'sp-view-count'
  count.textContent = String(rows.length)
  head.append(title, count)

  // The controls belong to the EDITOR, like the callout chip and the language
  // chip: a reader, a printout and a locked space get the view, not the buttons
  // that change what it holds.
  if (opts.editable) {
    const btn = (attr: string, label: string, title: string, on = false): HTMLButtonElement => {
      const el2 = document.createElement('button')
      el2.type = 'button'
      el2.className = 'sp-btn sp-view-btn' + (on ? ' sp-on' : '')
      el2.dataset[attr] = '1'
      el2.textContent = label
      el2.title = title
      el2.setAttribute('aria-label', title)
      return el2
    }

    // LAYOUT. Both shapes have always rendered; only the board was reachable,
    // so a view block could hold `layout:'list'` that nothing in the app could
    // produce or undo. One button, because there are two of them and a menu to
    // choose between two things is a menu too many.
    // THREE shapes now, so the button says what you are looking at and the
    // click moves to the next one. A menu to choose between three is still a
    // menu too many; a cycle is one control and one word.
    // `layoutOf`, not a lookup in a local map: the cycle is ONE fact and it now
    // lives in fields.ts, because it used to live here AND in editor.ts and the
    // two drifted. A view block hand-authored with layout:"toString" — plain
    // JSON, in a file someone sent you — made the truthiness test here pass on
    // a native function, and the button's label rendered as
    // `function toString() { [native code] }`. The editor's copy had been
    // hardened and its comment said the label was safe; the label is rendered
    // here, and this half had not been.
    const here = layoutOf(layout)
    // WHICH SHAPES HAVE BUCKETS. A list, a table and a gallery have no columns,
    // so "the field the columns come from" is not a question they can be asked.
    // A workload chart's BARS are buckets — it is the same question with the
    // same key and the same answer, which is the whole reason it is a layout
    // here rather than a block with a vocabulary of its own.
    const grouped = here === 'board' || here === 'workload'
    // Three WHOLE sentences rather than one with the shape interpolated into
    // it. "Show as a {what}" reads fine in English and breaks in half the
    // catalogs, where the article and the adjective agree with the noun's
    // gender — der Tafel / die Liste, un tableau / une liste. Two of these
    // three keys already existed for the same reason.
    // THE EXTRACTOR SWEEPS LITERALS. `t(WORD[here])` compiles, runs, and is
    // never translated by anybody: no catalog ever learns the string exists,
    // and the packer still reports 100% because it builds coverage from the
    // keys it swept. Measured on main: "Board", "List" and "Show as a list"
    // were present in de.ts and ABSENT from packed.ts — translations already
    // written, dropped on the floor, while the button read English in all eight
    // locales. So the words are chosen HERE, as literals the sweep can see;
    // fields.ts answers "which shape is this" and "what comes next".
    const LAYOUT_LABEL: Record<ViewLayout, string> = {
      board: t('Board'), list: t('List'), table: t('Table'), gallery: t('Gallery'),
      calendar: t('Calendar'), gantt: t('Timeline'), workload: t('Workload'),
    }
    const NEXT_LABEL: Record<ViewLayout, string> = {
      board: t('Show as a list'), list: t('Show as a table'),
      table: t('Show as a gallery'), gallery: t('Show as a calendar'),
      calendar: t('Show as a timeline'),
      gantt: t('Show as a workload chart'), workload: t('Show as a board'),
    }
    const asList = here !== 'board'
    const layoutB = btn('viewLayout', LAYOUT_LABEL[here], NEXT_LABEL[here])
    layoutB.dataset.next = nextLayout(here)

    // THE CALENDAR'S SECOND SHAPE, on the pattern `groupBy` already set: a
    // parameter of ONE layout gets its own control, shown only while that
    // layout is on, rather than a sixth entry in a cycle everybody has to click
    // through. Whole sentences again, for the reason three lines up.
    const spanB = here === 'calendar'
      ? btn('viewSpan',
        spanOf(calSpan) === 'timeline' ? t('Timeline') : t('Month'),
        spanOf(calSpan) === 'timeline' ? t('Show a month at a time') : t('Show a timeline'))
      : undefined
    if (spanB) spanB.dataset.next = nextSpan(calSpan)

    // GROUP BY. Only fields with declared options: a board's columns ARE the
    // option list, so grouping by a free-text field would make one column per
    // distinct string and call it a board.
    // The button must name the field the view is ACTUALLY bucketed by, which
    // for a workload chart with no stored `groupBy` is the person field and not
    // `status` — saying "Group · Status" over a chart of people would be the
    // control and the picture disagreeing, which is worse than no control.
    const shown = here === 'workload' && !Object.hasOwn(b as object, 'groupBy')
      ? bucketField(doc) : field
    const groupB = btn('viewGroup', shown ? `${t('Group')} · ${shown.label}` : t('Group'),
      here === 'workload'
        ? t('Choose the field the bars come from')
        : t('Choose the field the columns come from'))
    groupB.dataset.shape = here

    const sortKey = (Array.isArray(sort) ? sort : [])[0] as ViewSort | undefined
    const sortField = sortKey && fieldByKey(doc, sortKey.key)
    const sortB = btn('viewSort',
      sortField ? `${t('Sort')} · ${sortField.label}` : t('Sort'),
      t('Choose the order'), !!sortField)

    const on = !!(filter as { open?: unknown } | undefined)?.open
    const openB = btn('viewOpen', t('Open only'), t('Open only'), on)
    openB.setAttribute('aria-pressed', String(on))
    const n = filterCount(filter)
    // the count rather than a list of chips: what matters is that the view is
    // narrowed at all, and the popover says by what
    const filterB = btn('viewFilter', n ? `${t('Filter')} · ${n}` : t('Filter'), t('Filter'), !!n)

    // a LIST has no columns, so the field the columns would come from is not a
    // question it can be asked
    // WHICH PAGES. Named after what it answers rather than "Source", because
    // the question in the reader's head is "what is in this?" — and it says the
    // answer, not the word, when there is one.
    const src = (b as { source?: { has?: unknown; under?: unknown; tag?: unknown } }).source
    const hasKey = typeof src?.has === 'string' ? src.has : ''
    const underId = typeof src?.under === 'string' ? src.under : ''
    const tagKey = typeof src?.tag === 'string' ? src.tag : ''
    const srcLabel = hasKey ? (fieldByKey(doc, hasKey)?.label ?? hasKey)
      : underId ? (doc.pages.find((p) => p.id === underId)?.title || t('Untitled'))
        // the tag SAYS ITSELF — no lookup, and the hash is what makes it read
        // as a tag rather than as a page somebody happened to call "recipe"
        : tagKey ? '#' + tagKey
          : t('Issues')
    const sourceB = btn('viewSource', `${t('Pages')} · ${srcLabel}`,
      t('Choose which pages this view holds'), !!(hasKey || underId || tagKey))

    head.append(layoutB, ...(spanB ? [spanB] : []), sourceB,
      ...(asList ? [] : [groupB]), sortB, openB, filterB)
    head.append(layoutB, sourceB, ...(grouped ? [groupB] : []), sortB, openB, filterB)
  }
  host.appendChild(head)

  // A SOURCE this build cannot evaluate is the WORST of the three, and it had
  // no warning at all until now — `unknownSourceKeys` existed in fields.ts and
  // nothing called it. An unreadable filter over-shows; an unreadable SOURCE
  // means the view silently falls back to the backlog and shows a completely
  // different set of pages, with the header still naming the source it cannot
  // apply. Measured against a build of `main`: a view sourced on a tag renders
  // as Issues there, and says nothing.
  //
  // That build is already shipped and cannot be told. What this fixes is
  // forward: the FOURTH selector, whenever somebody adds one, degrades loudly.
  const unknownSrc = unknownSourceKeys((b as { source?: unknown }).source)
  if (unknownSrc.length) {
    const note = document.createElement('p')
    note.className = 'sp-view-empty'
    note.textContent = t('This view chooses its pages in a way this build does not understand, so it is showing the backlog instead.')
    host.appendChild(note)
  }

  // A rule this build cannot evaluate means the view shows MORE than its author
  // asked for. Additivity keeps the rule; honesty says so.
  // ...and the same rule one level down: an OPERATOR from a newer build is a
  // rule that was not applied, which is the same superset with the same banner.
  const unknown = [...unknownFilterKeys(filter), ...unknownFilterOps(filter)]
  if (unknown.length) {
    const note = document.createElement('p')
    note.className = 'sp-view-empty'
    note.textContent = t('A filter here is newer than this build and was not applied.')
    host.appendChild(note)
  }
  // Same rule, same honesty: a sort key naming a field this build has no schema
  // for is skipped, and the order you are looking at is not the one the author
  // asked for. Silently showing a different order is the failure additivity
  // trades for.
  if (unknownSortKeys(doc, sort).length) {
    const note = document.createElement('p')
    note.className = 'sp-view-empty'
    note.textContent = t('A sort here is newer than this build and was not applied.')
    host.appendChild(note)
  }

  if (!rows.length) {
    const empty = document.createElement('p')
    empty.className = 'sp-view-empty'
    // says how to fix it, because an empty board with no explanation reads as
    // broken rather than as empty — and an empty board with issues behind a
    // filter is a DIFFERENT thing to fix
    empty.textContent = all.length
      ? t('No issues match this filter.')
      : t('No issues yet. Add a status field to any page and it appears here.')
    host.appendChild(empty)
    return
  }

  const card = (page: Page, values: Map<string, unknown>): HTMLElement => {
    // A DIV holding a link, not a link holding controls: the card carries a
    // BUTTON now (the status picker, which is the only way to change a status
    // with a finger), and interactive content inside an <a> is invalid and
    // unreachable from the keyboard. The whole card is still one click target —
    // the title's ::after stretches over it (styles.css).
    const a = document.createElement('div')
    a.className = 'sp-issue'
    a.dataset.issue = page.id
    const t1 = document.createElement(opts.editable === false ? 'span' : 'a')
    t1.className = 'sp-issue-title'
    if (t1 instanceof HTMLAnchorElement) t1.href = `#p/${page.id}`
    t1.textContent = page.title
    a.appendChild(t1)
    const meta = document.createElement('span')
    meta.className = 'sp-issue-meta'

    // THE STATUS IS A CONTROL, because a phone cannot drag. It is the same
    // picker and the same writer the issue's own header strip uses — one path,
    // so `value` and `html` can never fall out of step.
    const own = opts.editable && field && propBlockOf(page, groupKey)
    if (own) {
      const set = document.createElement('button')
      set.type = 'button'
      set.className = 'sp-issue-chip sp-issue-set'
      set.dataset.setField = own.id
      set.title = t('Change {field}', { field: field!.label })
      set.setAttribute('aria-label', t('Change {field}', { field: field!.label }))
      const cur = optionOf(field, values.get(groupKey))
      const d = document.createElement('span')
      d.className = 'sp-prop-dot'
      if (cur?.color) d.style.background = cur.color
      set.append(d, document.createTextNode(shownValue(field, values.get(groupKey))))
      meta.appendChild(set)
    }

    for (const k of ['priority', 'assignee', 'estimate']) {
      const v = values.get(k)
      if (v === undefined || v === '' || v === null) continue
      const f2 = fieldByKey(doc, k)
      const chip = document.createElement('span')
      chip.className = 'sp-issue-chip'
      const o = f2 && optionOf(f2, v)
      if (o?.color) {
        const d = document.createElement('span')
        d.className = 'sp-prop-dot'
        d.style.background = o.color
        chip.appendChild(d)
      }
      chip.append(document.createTextNode(shownValue(f2, v)))
      meta.appendChild(chip)
    }
    if (meta.childElementCount) a.appendChild(meta)
    return a
  }

  // GANTT — one bar per page, from its start to its due date. A layout and not
  // a `chart` block; the argument is in gantt.ts.
  //
  // `layoutOf`, not the raw string: a `layout` out of a mailed file can be
  // anything, and this branch must never be entered by a value that only looks
  // like one of ours.
  if (layoutOf(layout) === 'gantt') {
    renderGantt(host, doc, rows, groupKey)
    return
  }

  // WORKLOAD — the same rows, added up per bucket. The only shape here whose
  // marks are not pages, which is exactly the objection gantt.ts answers.
  if (layoutOf(layout) === 'workload') {
    // `groupBy` ABSENT falls through to workload.ts's own default (the person
    // field), because absent has always meant "the sensible default for this
    // shape" and a board's default is not a chart's. A block that STORES a
    // groupBy gets what it stored, in every layout.
    renderWorkload(host, doc, rows,
      Object.hasOwn(b as object, 'groupBy') ? groupKey : undefined)
    return
  }

  // GALLERY — the shape that makes a reading list look like a reading list. A
  // board answers "what state is this in" and a table answers "what does it
  // say"; a gallery answers "which one is it", which for books, films, recipes
  // and people is the question actually being asked, and is why the covers
  // exist at all.
  //
  // A card without a cover is not a hole. It gets a tinted panel carrying the
  // page's own icon (or its first letter), on a hue derived from the page id —
  // so a gallery of pages nobody has given a picture to still reads as a set of
  // distinct things rather than as a grid of grey rectangles.
  if (layout === 'gallery') {
    const grid = document.createElement('div')
    grid.className = 'sp-gallery'
    for (const r of rows) {
      const cardEl = document.createElement('div')
      cardEl.className = 'sp-gcard'
      cardEl.dataset.issue = r.page.id

      const shot = document.createElement('div')
      shot.className = 'sp-gcard-shot'
      const src = resolveSrc(coverSrc(r.page), doc)
      if (src) {
        const img = document.createElement('img')
        img.src = src
        img.alt = ''
        img.setAttribute('aria-hidden', 'true')
        // A gallery is many pictures at once — the one place in this app where
        // decoding them all up front is a real cost, and the one place the
        // browser can be told not to.
        img.loading = 'lazy'
        img.decoding = 'async'
        shot.appendChild(img)
      } else {
        shot.classList.add('sp-gcard-bare')
        // deterministic, so a page keeps its cover across reloads, readers and
        // machines — the same reason ids are repaired from the id and never
        // from Math.random. The figure is procedural.ts's; the mark rides on it.
        shot.innerHTML = proceduralCoverSvg(r.page.id, 'card')
        const mark = document.createElement('span')
        mark.className = 'sp-gcard-mark'
        pageMark(mark, r.page)
        shot.appendChild(mark)
      }
      cardEl.appendChild(shot)

      const body = document.createElement('div')
      body.className = 'sp-gcard-body'
      const t1 = document.createElement(opts.editable === false ? 'span' : 'a')
      t1.className = 'sp-issue-title'
      if (t1 instanceof HTMLAnchorElement) t1.href = `#p/${r.page.id}`
      t1.textContent = r.page.title || t('Untitled')
      body.appendChild(t1)

      // EVERY field the page carries, not the tracker's four. A gallery of
      // books whose cards showed Priority and Estimate and not the Author would
      // be the board wearing a different shape.
      const meta = document.createElement('span')
      meta.className = 'sp-issue-meta'
      for (const f of fieldsOf(doc)) {
        const v = r.values.get(f.key)
        if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue
        const chip = document.createElement('span')
        chip.className = 'sp-issue-chip'
        const o = optionOf(f, v)
        if (o?.color) {
          const d = document.createElement('span')
          d.className = 'sp-prop-dot'
          d.style.background = o.color
          chip.appendChild(d)
        }
        chip.append(document.createTextNode(shownValue(f, v)))
        meta.appendChild(chip)
      }
      if (meta.childElementCount) body.appendChild(meta)
      cardEl.appendChild(body)
      grid.appendChild(cardEl)
    }
    host.appendChild(grid)
    return
  }

  // TABLE — the shape a base is usually looked at in, and the one this app did
  // not have. Columns are the fields the ROWS ACTUALLY CARRY, in the schema's
  // declared order: a table of books should not carry an Estimate column
  // because the vocabulary happens to contain one, and a page that has a field
  // the others lack should not be the reason everyone gets an empty column.
  if (layout === 'table') {
    const keys = fieldsOf(doc).map((f) => f.key).filter((k) => rows.some((r) => r.values.has(k)))
    const wrap = document.createElement('div')
    // its own scroller: a wide table must not make the PAGE scroll sideways
    wrap.className = 'sp-view-tablewrap'
    const table = document.createElement('table')
    table.className = 'sp-view-table'
    const thead = document.createElement('thead')
    const hr = document.createElement('tr')
    const th0 = document.createElement('th')
    // THE PAGE COLUMN DOES NOT SORT, and it says so by being a plain heading
    // rather than a dead button. A view's `sort` names a FIELD: sortRows looks
    // each key up in the schema and skips what it cannot find, so ordering by
    // title would need a second ordering mechanism living beside the first —
    // and one order stored in two shapes is the thing that later disagrees with
    // itself. A pseudo-key like `title` is worse still: every build that ships
    // today would report it through unknownSortKeys as "newer than this build"
    // and then not apply it. Better a column that plainly does not sort.
    th0.textContent = t('Page')
    hr.appendChild(th0)
    for (const k of keys) {
      const th = document.createElement('th')
      const label = fieldByKey(doc, k)?.label ?? k
      const dir = sortDirOf(sort, k)
      // The state lives on the TH as aria-sort, the attribute a screen reader
      // already announces; the arrow is what a sighted reader reads. Two
      // renderings of ONE fact — the view's own `sort` — so there is no second
      // place the arrow could come from and no way for it to disagree with the
      // order the rows are actually in.
      th.setAttribute('aria-sort', dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none')
      // A READER GETS THE HEADING, not the control — the rule the card chip and
      // every view button already follow: a printout and a locked space show
      // the view, never the things that change it.
      if (opts.editable) {
        const sortB = document.createElement('button')
        sortB.type = 'button'
        sortB.className = 'sp-view-sort' + (dir ? ' sp-on' : '')
        sortB.dataset.sortCol = k
        sortB.title = t('Sort by {field}', { field: label })
        sortB.setAttribute('aria-label', t('Sort by {field}', { field: label }))
        const arrow = document.createElement('span')
        arrow.className = 'sp-sortdir'
        arrow.setAttribute('aria-hidden', 'true')
        arrow.textContent = dir === 'asc' ? '\u2191' : dir === 'desc' ? '\u2193' : ''
        sortB.append(document.createTextNode(label), arrow)
        th.appendChild(sortB)
      } else {
        th.textContent = label
      }
      hr.appendChild(th)
    }
    thead.appendChild(hr)
    table.appendChild(thead)

    // What a cell SHOWS. THROUGH THE OPTION, so a select shows its label and
    // its colour rather than the id the model stores — the same thing propHtml
    // does for the header strip, and for the same reason: the id is not for
    // reading. An unset value is an em dash, so an empty cell is still a place
    // you can aim at.
    const fill = (into: HTMLElement, f: FieldSpec | undefined, v: unknown): void => {
      const opt = optionOf(f, v)
      if (opt) {
        const chip = document.createElement('span')
        chip.className = 'sp-prop-chip'
        const dot = document.createElement('span')
        dot.className = 'sp-prop-dot'
        if (opt.color) dot.style.background = opt.color
        chip.append(dot, document.createTextNode(opt.label))
        into.appendChild(chip)
      } else if (v !== undefined && v !== null && String(v) !== '') {
        into.appendChild(document.createTextNode(shownValue(f, v)))
      } else {
        into.classList.add('sp-view-empty')
        into.appendChild(document.createTextNode('\u2014'))
      }
    }

    const tb = document.createElement('tbody')
    for (const r of rows) {
      const tr = document.createElement('tr')
      const td0 = document.createElement('td')
      // the page itself, reached the same way a card reaches it
      const a = document.createElement('a')
      a.className = 'sp-view-cellink'
      a.href = `#p/${r.page.id}`
      a.dataset.page = r.page.id
      a.textContent = r.page.title || t('Untitled')
      td0.appendChild(a)
      tr.appendChild(td0)
      for (const k of keys) {
        const td = document.createElement('td')
        const f = fieldByKey(doc, k)
        const v = r.values.get(k)
        // A CELL IS A CONTROL where there is an editor — a real <button>, so it
        // is in the tab order and answers Enter and Space without a key handler
        // of its own. It is emitted even for a page carrying no such prop block:
        // an empty cell is how the field gets ONTO that page, exactly as
        // dropping a card into a column is.
        if (opts.editable && f) {
          const cell = document.createElement('button')
          cell.type = 'button'
          cell.className = 'sp-view-cell'
          cell.dataset.cellPage = r.page.id
          cell.dataset.cellField = k
          cell.title = t('Change {field}', { field: f.label })
          cell.setAttribute('aria-label', t('Change {field}', { field: f.label }))
          fill(cell, f, v)
          td.appendChild(cell)
        } else {
          fill(td, f, v)
        }
        tr.appendChild(td)
      }
      tb.appendChild(tr)
    }
    table.appendChild(tb)
    wrap.appendChild(table)
    host.appendChild(wrap)
    return
  }

  // CALENDAR — the shape that answers "when". Its own file: the arithmetic is
  // the part of this app most likely to be wrong east of UTC, and it wanted a
  // rig that can import it without a DOM. `layoutOf`, not the raw string, so a
  // block claiming `layout:"toString"` cannot reach this branch and everything
  // a newer build might name falls through to the board.
  if (layoutOf(layout) === 'calendar') {
    renderCalendar(host, {
      doc,
      rows,
      blockId: b.id,
      span: spanOf(calSpan),
      locale: locale(),
      editable: opts.editable,
      card: (r) => card(r.page, r.values),
    })
    return
  }

  if (layout === 'list') {
    const ul = document.createElement('ul')
    ul.className = 'sp-view-list'
    for (const r of rows) {
      const li = document.createElement('li')
      li.appendChild(card(r.page, r.values))
      ul.appendChild(li)
    }
    host.appendChild(ul)
    return
  }

  // BOARD, in the schema's declared order — not alphabetical, and not the order
  // issues happen to be in. A status list has a direction, and a board that
  // does not follow it is a board you have to read rather than glance at.
  const board = document.createElement('div')
  board.className = 'sp-board'
  const cols = field?.options ?? []
  const seen = new Set<string>()
  for (const opt of cols) {
    const mine = rows.filter((r) => String(r.values.get(groupKey) ?? '') === opt.id)
    mine.forEach((r) => seen.add(r.page.id))
    const col = document.createElement('div')
    col.className = 'sp-col'
    col.dataset.group = opt.id
    const ch = document.createElement('div')
    ch.className = 'sp-col-head'
    const dot = document.createElement('span')
    dot.className = 'sp-prop-dot'
    if (opt.color) dot.style.background = opt.color
    ch.append(dot, document.createTextNode(opt.label))
    const n = document.createElement('span')
    n.className = 'sp-col-count'
    n.textContent = String(mine.length)
    ch.appendChild(n)
    col.appendChild(ch)
    for (const r of mine) col.appendChild(card(r.page, r.values))
    board.appendChild(col)
  }
  // An issue whose status this build does not know still has to appear, or the
  // board silently loses work written by a newer build. It carries NO
  // `data-group`, which is also what makes it a place you can drag OUT of and
  // not INTO: "Other" is not a value, so there is nothing a drop here could
  // write, and inventing one would overwrite a newer build's status with a
  // guess. Dragging a card from here to a real column is how you correct it,
  // deliberately.
  const orphans = rows.filter((r) => !seen.has(r.page.id))
  if (orphans.length) {
    const col = document.createElement('div')
    col.className = 'sp-col'
    const ch = document.createElement('div')
    ch.className = 'sp-col-head'
    ch.textContent = t('Other')
    col.appendChild(ch)
    for (const r of orphans) col.appendChild(card(r.page, r.values))
    board.appendChild(col)
  }
  host.appendChild(board)
}

// --- charts ------------------------------------------------------------------
//
// TWO SHAPES, ONE HOST. Both `gantt` and `workload` are `view` LAYOUTS rather
// than a new block type; the argument is in gantt.ts and is not repeated here.
// What belongs here is how they are PAINTED, and the one rule both follow:
//
//   THE PICTURE IS SVG WITH PRESENTATION ATTRIBUTES, NOT CSS CLASSES.
//
// Not a style preference. This app draws the same block on four surfaces — the
// editor, the reading view, PAPER, and the file-manager still (preview.ts) —
// and the still carries its OWN small stylesheet, deliberately, because
// QuickLook's renderer is a conservative one. A bar coloured by a `.sp-gt-bar`
// rule in styles.css is a bar that is invisible in a thumbnail and, on paper,
// is at the mercy of the browser's "do not print backgrounds" default. Colour,
// geometry and size travel INSIDE the element, so the four surfaces cannot
// disagree, and `@media print` has nothing left to get wrong.

/** A colour a `fill=` attribute will certainly accept, or nothing. Same test
 *  preview.ts makes, and for the same reason: the theme comes out of a file. */
const flatColor = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : ''
  return /^#[0-9a-f]{3,8}$/i.test(s) || /^rgb/i.test(s) ? s : null
}

const svgEl = (name: string, attrs: Record<string, string | number>): SVGElement => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', name)
  for (const k of Object.keys(attrs)) el.setAttribute(k, String(attrs[k]))
  return el
}

const GRID = '#E3E8EF'
const MUTED = '#5B6472'
const DANGER = '#E5484D'
const INK = '#1E2A3A'

/** Logical drawing size. The svg scales to its container through the viewBox,
 *  so these are proportions, not pixels on anybody's screen. */
const GT = { w: 960, name: 210, padR: 14, head: 28, row: 26, bar: 12 }

/** As many characters as fit the name column at 12px. Measuring is not
 *  available here (the block is painted before layout) and a `<title>` child
 *  carries the whole name anyway, so a cheap cut with an ellipsis beats a
 *  clipPath that silently swallows half a word. */
const cut = (s: string, n = 28): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)

function renderGantt(host: HTMLElement, doc: SpacesDoc, rows: IssueRow[], groupKey: string): void {
  const m = ganttModel(doc, rows, todayISO(), groupKey)

  if (m.noDateField) {
    const p = document.createElement('p')
    p.className = 'sp-view-empty'
    p.textContent = t('A timeline needs a date field. Add one and it appears here.')
    host.appendChild(p)
    return
  }
  if (!m.bars.length) {
    const p = document.createElement('p')
    p.className = 'sp-view-empty'
    p.textContent = m.undated
      ? t('No page here has a date yet.')
      : t('No issues match this filter.')
    host.appendChild(p)
    return
  }

  const accent = flatColor((doc.theme as { accent?: unknown } | undefined)?.accent) ?? '#5B8DEF'
  const x0 = GT.name
  const tw = GT.w - GT.name - GT.padR
  const h = GT.head + m.bars.length * GT.row + 10

  const wrap = document.createElement('div')
  // its own scroller, exactly as the table layout has: a schedule with thirty
  // rows is tall, never wide, but a phone is 320px and the name column plus a
  // month of track does not fit in it. The PAGE must not scroll sideways.
  wrap.className = 'sp-gt-wrap'
  const svg = svgEl('svg', {
    viewBox: `0 0 ${GT.w} ${h}`, width: GT.w, height: h,
    role: 'img', 'aria-label': t('Timeline'),
  })
  svg.setAttribute('style', `width:100%;height:auto;display:block;min-width:${Math.round(GT.w / 1.5)}px`)

  // gridlines and their labels
  for (const tick of m.ticks) {
    const x = x0 + tick.x * tw
    svg.appendChild(svgEl('line', { x1: x, y1: GT.head - 8, x2: x, y2: h - 6, stroke: GRID, 'stroke-width': 1 }))
    const lab = svgEl('text', { x: x + 3, y: GT.head - 12, fill: MUTED, 'font-size': 11 })
    lab.textContent = tick.label
    svg.appendChild(lab)
  }

  // TODAY. Only when it is inside the span — gantt.ts refuses to stretch the
  // chart to reach it, and a marker clamped to the edge would read as "today is
  // the last day of this project". When it is outside, the note below says so
  // in words, which is a thing a line cannot say.
  if (m.todayX !== null) {
    const x = x0 + m.todayX * tw
    svg.appendChild(svgEl('line', {
      x1: x, y1: GT.head - 10, x2: x, y2: h - 6,
      stroke: INK, 'stroke-width': 1.5, opacity: 0.45,
    }))
    const lab = svgEl('text', { x: x + 4, y: h - 1, fill: INK, opacity: 0.55, 'font-size': 10 })
    lab.textContent = t('Today')
    svg.appendChild(lab)
  }

  m.bars.forEach((b, i) => {
    const cy = GT.head + i * GT.row + GT.row / 2
    const fill = flatColor(b.color) ?? accent

    // The NAME is a link, and it is an svg <a>, so the whole picture is one
    // element on every surface. The editor's delegated handler matches on
    // closest('a') + an href starting `#p/`, which an SVGAElement satisfies;
    // the preview strips href along with every other runtime attribute, so the
    // still shows the same words without being clickable, which is correct.
    const a = svgEl('a', { href: `#p/${b.pageId}` })
    const name = svgEl('text', { x: 0, y: cy + 4, fill: INK, 'font-size': 12 })
    name.textContent = cut(b.title || t('Untitled'))
    const full = svgEl('title', {})
    full.textContent = b.title || t('Untitled')
    name.appendChild(full)
    a.appendChild(name)
    svg.appendChild(a)

    // the row's own track, so a bar in the middle of a wide span still reads as
    // a position on a line rather than as a rectangle floating in space
    svg.appendChild(svgEl('line', {
      x1: x0, y1: cy, x2: x0 + tw, y2: cy, stroke: GRID, 'stroke-width': 1, opacity: 0.7,
    }))

    let mark: SVGElement
    if (b.milestone) {
      // A DIAMOND, because a date with no duration is not a bar. This is what
      // every issue written before `start` existed looks like — see the field
      // comment in fields.ts; it is the installed base, not an edge case.
      const cx = x0 + b.x * tw
      const r = 6
      mark = svgEl('path', {
        d: `M${cx} ${cy - r}L${cx + r} ${cy}L${cx} ${cy + r}L${cx - r} ${cy}Z`,
        fill, stroke: b.overdue ? DANGER : 'none', 'stroke-width': b.overdue ? 1.5 : 0,
      })
    } else {
      mark = svgEl('rect', {
        x: x0 + b.x * tw, y: cy - GT.bar / 2,
        // a one-day task is one day wide, never zero — but a one-day task in a
        // ten-year span rounds to a third of a pixel, so the floor is the one
        // place the model's fraction is overridden and it is a VISIBILITY floor
        width: Math.max(3, b.w * tw), height: GT.bar, rx: 3,
        fill,
        stroke: b.invalid || b.overdue ? DANGER : 'none',
        'stroke-width': b.invalid || b.overdue ? 1.5 : 0,
        'stroke-dasharray': b.invalid ? '3 2' : '',
      })
    }
    const why = svgEl('title', {})
    // The dates as the FILE holds them — ISO, unambiguous in every locale, and
    // the thing somebody fixing a wrong row needs to see. The axis is localized
    // because it is a label; this is a value.
    why.textContent = b.invalid
      ? t('{a} to {b} — the end is before the start', { a: b.to, b: b.from })
      : b.milestone ? `${b.title} · ${b.from}` : `${b.title} · ${b.from} → ${b.to}`
    mark.appendChild(why)
    svg.appendChild(mark)
  })

  wrap.appendChild(svg)
  host.appendChild(wrap)

  // WHAT THE PICTURE COULD NOT SAY. Every one of these is a count that would
  // otherwise be a silent difference between the chart and the document, which
  // is the whole failure mode of drawing a picture of somebody else's numbers.
  const notes: string[] = []
  if (m.dropped) notes.push(t('{n} more not shown', { n: String(m.dropped) }))
  if (m.undated) notes.push(t('{n} with no date', { n: String(m.undated) }))
  if (m.todayX === null) notes.push(t('Today is outside this range'))
  // "{n} end before they start" reads wrong at n=1 in English and needs a
  // plural rule in half the catalogs; t() has no plural machinery and should
  // not grow one for a footnote. A noun phrase is correct at every n in every
  // one of the eight languages, which is the cheaper answer.
  const bad = m.bars.filter((b) => b.invalid).length
  if (bad) notes.push(t('{n} with the end before the start', { n: String(bad) }))
  if (notes.length) {
    const p = document.createElement('p')
    p.className = 'sp-view-empty sp-gt-note'
    p.textContent = notes.join(' · ')
    host.appendChild(p)
  }
}

function renderWorkload(host: HTMLElement, doc: SpacesDoc, rows: IssueRow[], groupKey?: string): void {
  const m = workloadModel(doc, rows, groupKey, t('Unassigned'),
    (n) => t('Other ({n})', { n: String(n) }))

  if (!m.sum) {
    const p = document.createElement('p')
    p.className = 'sp-view-empty'
    p.textContent = t('A workload chart adds up a number field. This space has none.')
    host.appendChild(p)
    return
  }
  if (!m.bars.length) {
    const p = document.createElement('p')
    p.className = 'sp-view-empty'
    p.textContent = t('No issues match this filter.')
    host.appendChild(p)
    return
  }

  const accent = flatColor((doc.theme as { accent?: unknown } | undefined)?.accent) ?? '#5B8DEF'
  const wrap = document.createElement('div')
  wrap.className = 'sp-wl-wrap'
  // THE SHARED ENGINE, kernel/src/charts.ts — this app draws no chart of its
  // own. `chartSnapshotSvg` and not `mountChart`: the live path exists for
  // slides' present mode, where a chart is hovered and zoomed; here the same
  // markup has to survive being printed and being handed to a thumbnailer that
  // runs no script, and a still does that by being a still.
  wrap.innerHTML = chartSnapshotSvg({ w: 720, h: 320, option: workloadOption(m, accent) })
  const svg = wrap.querySelector('svg')
  // the engine asks for height:100% (it is sized by its host in slides); in a
  // flowing column that is zero, so the aspect comes from the viewBox instead
  if (svg) svg.setAttribute('style', 'width:100%;height:auto;display:block;min-width:420px')
  host.appendChild(wrap)

  // THE NUMBERS, IN WORDS, BESIDE THE PICTURE. Three jobs at once and it is the
  // cheapest way to do any of them: the axis labels are truncated to fit, a
  // chart is unreadable to a screen reader, and a bar's height is not a value
  // anybody can quote. Rendered from the SAME model the chart is, so the two
  // can never disagree.
  const list = document.createElement('p')
  list.className = 'sp-wl-legend'
  for (const b of m.bars) {
    const chip = document.createElement('span')
    chip.className = 'sp-issue-chip'
    const dot = document.createElement('span')
    dot.className = 'sp-prop-dot'
    dot.style.background = flatColor(b.color) ?? accent
    chip.append(dot, document.createTextNode(`${b.label} · ${b.total}`))
    list.appendChild(chip)
  }
  host.appendChild(list)

  const notes: string[] = []
  if (m.folded) notes.push(t('{n} more grouped as Other', { n: String(m.folded) }))
  if (m.ignored) notes.push(t('{n} left out: not a number', { n: String(m.ignored) }))
  const blank = m.bars.reduce((s, b) => s + b.blank, 0)
  if (blank) notes.push(t('{n} with no estimate', { n: String(blank) }))
  if (notes.length) {
    const p = document.createElement('p')
    p.className = 'sp-view-empty sp-gt-note'
    p.textContent = notes.join(' · ')
    host.appendChild(p)
  }
}
