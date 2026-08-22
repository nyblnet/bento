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

import { type SpacesDoc, type Page, type Block, isRemote, tableOf, linkCard } from './model'
import { sanitizeInline, inertBody, esc } from './sanitize'
import { tokenize } from './highlight'
import { t, locale } from './i18n'
import { TAG_OF, LIST_OF, SPEC, TONE, mediaPlayback } from './blocks'
import {
  fieldByKey, optionOf, issuesOf, headerLength, propBlockOf,
  passesFilter, filterCount, unknownFilterKeys,
  sortRows, unknownSortKeys, type ViewSort, type FieldSpec,
} from './fields'
import { answer, feed, freshContext, type CalcCtx } from './calc.ts'
import { ICONS, type IconName } from './icons'

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
  // MAGIC NOTES' CONTEXT, accumulated as the pass goes. A name is defined by a
  // line and usable by the lines BELOW it — the same direction a person reads
  // in, and the reason this needs no second pass and cannot cycle.
  const calc: CalcCtx = freshContext()
  // stack of open containers, innermost last: [blockId, element]
  const stack: Array<[string, HTMLElement]> = []
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
    ;(kind && list ? list.el : host).appendChild(node)

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
      stack.push([b.id, body])
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
      stack.push([b.id, node])
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
      if (isRemote(rawSrc) && !opts.allowRemote?.(rawSrc)) {
        fig.appendChild(remotePlaceholder(rawSrc, b, opts,
          t('Image from {host}', { host: remoteHost(rawSrc) }), t('Load this image')))
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
      if (isRemote(rawSrc) && !opts.allowRemote?.(rawSrc)) {
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
        if (poster && !(isRemote(poster) && !opts.allowRemote?.(poster))) {
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

      // THE THUMBNAIL IS LOCAL OR IT IS ABSENT. `linkCard` has already dropped
      // a remote one — this cannot be re-tested here, because a check that can
      // be forgotten in one of four surfaces is a check that will be.
      if (c.image) {
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

    case 'view': {
      el.classList.add('sp-view')
      renderView(el, b, doc, opts)
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
      twist.setAttribute('aria-label', 'Toggle section')
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

export function resolveSrc(src: string, doc: SpacesDoc): string {
  // hasOwn, not a bare index: `assets['toString']` returns a FUNCTION, which is
  // truthy, so the `?? ''` never fired and the stringified function was assigned
  // to img.src. Same class as the icon lookup — an author-supplied key reaching
  // a lookup table through the prototype chain.
  if (src.startsWith('asset:')) {
    const key = src.slice(6)
    const table = doc.assets
    return table && Object.hasOwn(table, key) ? table[key] : ''
  }
  return src
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
  if (poster && !(isRemote(poster) && !opts.allowRemote?.(poster))) {
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
  else if (width === 'wide') inner.style.maxWidth = '1500px'
  else if (doc.theme.measure) {
    // AND THE DEFAULT ITSELF GROWS. 720px is ~88 characters at 16px, which is
    // already at the long end — so this does not widen the line much; what it
    // does is stop a 2560px screen showing a 720px ribbon using 31% of it.
    // Capped, because past ~95 characters a line is harder to read, not easier.
    const m = doc.theme.measure
    inner.style.maxWidth = `min(max(${m}px, 42vw), ${Math.round(m * 1.25)}px)`
  }
  if (width) inner.classList.add('sp-wide')

  const h = document.createElement('h1')
  h.className = 'sp-title'
  h.dataset.pageTitle = page.id
  h.dir = 'auto'
  if (opts.editable) h.contentEditable = 'true'
  h.textContent = page.title
  inner.appendChild(h)

  inner.appendChild(renderBlocks(page, doc, opts))
  art.appendChild(inner)
  return art
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
 * A BOARD or a LIST of the issues in this space.
 *
 * Derived, never stored: the view holds a query, and the issues are wherever
 * they are. Storing membership would mean a card could disagree with the page
 * it stands for — the mistake every "database" makes when it keeps its own copy
 * of the rows.
 */
function renderView(host: HTMLElement, b: Block, doc: SpacesDoc, opts: RenderOpts): void {
  const layout = String((b as { layout?: unknown }).layout ?? 'board')
  const groupKey = String((b as { groupBy?: unknown }).groupBy ?? 'status')
  const field = fieldByKey(doc, groupKey)
  const filter = (b as { filter?: unknown }).filter
  const sort = (b as { sort?: unknown }).sort
  const all = issuesOf(doc)
  const rows = sortRows(doc, all.filter((r) => passesFilter(doc, r.values, filter)), sort)

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
    const asList = layout === 'list'
    const layoutB = btn('viewLayout', asList ? t('List') : t('Board'),
      asList ? t('Show as a board') : t('Show as a list'))

    // GROUP BY. Only fields with declared options: a board's columns ARE the
    // option list, so grouping by a free-text field would make one column per
    // distinct string and call it a board.
    const groupB = btn('viewGroup', field ? `${t('Group')} · ${field.label}` : t('Group'),
      t('Choose the field the columns come from'))

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
    head.append(layoutB, ...(asList ? [] : [groupB]), sortB, openB, filterB)
  }
  host.appendChild(head)

  // A rule this build cannot evaluate means the view shows MORE than its author
  // asked for. Additivity keeps the rule; honesty says so.
  const unknown = unknownFilterKeys(filter)
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
