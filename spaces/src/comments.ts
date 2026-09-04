// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Review comments — the markers, and the thread behind one.
//
// WHAT IS SETTLED IN THE MODEL, not here: a thread is anchored by WHERE IT IS
// STORED (`Block.comments` = about that block, `Page.comments` = about the
// page), it is plain text, and it is saved in the file. model.ts carries the
// reasoning for all three, including the collaboration one.
//
// WHERE THE UI LIVES, and why it is not slides' answer:
//
//  · NOT the gutter. A block already has one, at the start edge, and it holds
//    exactly two controls because a phone reserves 44px for it and fits one.
//    A third affordance there is a control nobody on a touch device can reach.
//  · NOT a sidebar panel. The sidebar is the page TREE — the one navigation
//    this app has — and a second thing living in it would be competing with
//    the thing people open it for. The tree carries a COUNT instead: the badge
//    says a page has unread argument, which is the only comment fact worth
//    knowing from another page.
//  · THE END MARGIN, opposite the gutter. A marker sits outside the text
//    column, so it never reflows the prose it is about, and it is beside the
//    line it refers to, which is the whole point of a margin note. Page-level
//    threads sit in a row under the title, where the page's own identity is.
//
// The thread itself is the editor's ordinary popover (or bottom sheet on a
// phone) — the same dismissal behaviour as every other menu in this app,
// because a panel that closes differently from the one beside it reads as a
// bug.

import { uid, commentsOn, type Comment, type CommentAt } from './model.ts'
import type { Store } from './store.ts'
import { t } from './i18n.ts'
import { lsGet, lsSet } from '../../kernel/src/storage.ts'

/** Hooks the editor provides, so this module stays out of editor internals. */
export interface CommentsHost {
  store: Store
  /** the surface the current page was just painted into */
  main(): HTMLElement
  /** the editor's popover — anchored menu on a desktop, bottom sheet on a phone */
  popover(anchor: HTMLElement, build: (pop: HTMLElement, close: () => void) => void): void
  /** repaint the page tree; the unresolved badge lives there */
  paintTree(): void
}

/**
 * The commenter's name, remembered per browser and never sent anywhere.
 *
 * `bento-author` is the key the People panel already reads and writes
 * (collabui.ts), deliberately: the name on your comments and the name beside
 * your cursor are the same fact, and two keys would let one file disagree with
 * itself about who you are.
 */
export function commentAuthor(): string | null {
  let name = lsGet('bento-author')
  if (!name) {
    name = window.prompt(t('Your name (shown on comments):'))?.trim() || ''
    if (!name) return null
    lsSet('bento-author', name)
  }
  return name
}

/** Re-ask for the name; existing threads keep the author they were written by. */
export function changeCommentAuthor(): string | null {
  const next = window.prompt(t('Your name (shown on new comments):'), lsGet('bento-author') ?? '')?.trim()
  if (!next) return null
  lsSet('bento-author', next)
  return next
}

function relTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (!Number.isFinite(s) || s < 45) return t('just now')
  if (s < 3600) return t('{n}m ago', { n: Math.round(s / 60) })
  if (s < 86400) return t('{n}h ago', { n: Math.round(s / 3600) })
  if (s < 86400 * 30) return t('{n}d ago', { n: Math.round(s / 86400) })
  return new Date(iso).toLocaleDateString()
}

const now = (): string => new Date().toISOString()

export class CommentsUi {
  private host: CommentsHost
  private fresh: string | null = null

  constructor(host: CommentsHost) {
    this.host = host
  }

  /**
   * Rebuild the markers for the page on screen.
   *
   * Called after every page paint, and never in the reading view or on paper —
   * the editor holds that gate, because it is the thing that knows which view
   * it is in. `render.ts` has never heard of comments, so print (which renders
   * its own tree) cannot show one however this is called.
   */
  refresh(): void {
    const main = this.host.main()
    for (const old of main.querySelectorAll('.sp-cm-mark, .sp-cm-row')) old.remove()
    const page = this.host.store.page
    if (!page) return

    let row: HTMLElement | null = null
    for (const at of commentsOn(page)) {
      const mark = this.marker(at)
      if (at.blockId) {
        const node = main.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(at.blockId)}"]`)
        // A thread on a block that is not on screen (a collapsed toggle) is not
        // lost — it is in the file, and `window.bento.comments()` lists it.
        node?.append(mark)
      } else {
        if (!row) {
          row = document.createElement('div')
          row.className = 'sp-cm-row'
          const title = main.querySelector('[data-page-title]')
          if (title) title.after(row)
          else main.querySelector('.sp-page-inner')?.prepend(row)
        }
        row.append(mark)
      }
    }
  }

  private marker(at: CommentAt): HTMLButtonElement {
    const c = at.comment
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'sp-cm-mark' + (c.resolved ? ' sp-cm-done' : '') + (c.id === this.fresh ? ' sp-cm-new' : '')
    if (c.id === this.fresh) setTimeout(() => { this.fresh = null }, 1200)
    b.textContent = String(1 + (Array.isArray(c.replies) ? c.replies.length : 0))
    b.title = `${c.author}: ${String(c.text).slice(0, 80)}`
    b.setAttribute('aria-label', t('Comment'))
    b.addEventListener('click', (e) => { e.stopPropagation(); this.open(at.comment.id, b) })
    return b
  }

  /** Start a thread on a block, or — with no block id — on the page itself. */
  openNew(blockId?: string): void {
    const s = this.host.store
    const page = s.page
    if (!page || s.readOnly) return
    const author = commentAuthor()
    if (!author) return
    const text = window.prompt(t('Comment:'))?.trim()
    if (!text) return
    const comment: Comment = { id: uid('cm'), author, at: now(), text }
    this.fresh = comment.id
    // PAGE SCOPE: a thread is on the page in view by construction, and the
    // store's page entry snapshots exactly that page (store.ts entry()).
    s.commit(() => {
      const host = blockId ? page.blocks.find((b) => b.id === blockId) : page
      if (!host) return
      host.comments = [...(host.comments ?? []), comment]
    }, { scope: 'page' })
    this.refresh()
  }

  /** Find the thread again in the LIVE document, and change it in one step. */
  private edit(id: string, fn: (list: Comment[], at: number, owner: { comments?: Comment[] }) => void): void {
    const s = this.host.store
    const page = s.page
    if (!page || s.readOnly) return
    s.commit(() => {
      const live = s.index.page.get(page.id)
      if (!live) return
      for (const owner of [live as { comments?: Comment[] }, ...live.blocks]) {
        const list = owner.comments
        if (!Array.isArray(list)) continue
        const at = list.findIndex((c) => c.id === id)
        if (at < 0) continue
        const next = [...list]
        fn(next, at, owner)
        // An absent key, never a stored empty array: a block somebody
        // commented on and un-commented is byte-identical to one that was
        // never touched, and a file written before comments existed stays that
        // way.
        if (next.length) owner.comments = next
        else delete owner.comments
        return
      }
    }, { scope: 'page' })
    this.refresh()
  }

  private open(id: string, anchor: HTMLElement): void {
    const page = this.host.store.page
    const at = page && commentsOn(page).find((x) => x.comment.id === id)
    if (!at) return
    const c = at.comment
    const readOnly = this.host.store.readOnly

    this.host.popover(anchor, (pop, close) => {
      pop.classList.add('sp-cm-pop')

      const head = document.createElement('div')
      head.className = 'sp-cm-head'
      head.append(Object.assign(document.createElement('span'), {
        textContent: at.blockId ? t('Comment · block') : t('Comment · page'),
      }))
      if (!readOnly) {
        const me = document.createElement('button')
        me.type = 'button'
        me.className = 'sp-cm-me'
        me.textContent = t('you: {name} ✎', { name: lsGet('bento-author') ?? '—' })
        me.title = t('Change the name used for your new comments and replies')
        me.addEventListener('click', () => {
          const next = changeCommentAuthor()
          if (next) me.textContent = t('you: {name} ✎', { name: next })
        })
        head.append(me)
      }
      pop.append(head)

      const entries = document.createElement('div')
      entries.className = 'sp-cm-entries'
      // textContent, ALWAYS: comment text is plain text and this is the only
      // place it reaches a screen. See model.ts CommentEntry.text.
      const entry = (author: string, iso: string, text: string) => {
        const e = document.createElement('div')
        e.className = 'sp-cm-entry'
        const who = document.createElement('b')
        who.textContent = String(author ?? '')
        const when = document.createElement('span')
        when.className = 'sp-cm-time'
        when.textContent = relTime(String(iso ?? ''))
        const body = document.createElement('p')
        body.textContent = String(text ?? '')
        e.append(who, when, body)
        entries.append(e)
      }
      entry(c.author, c.at, c.text)
      for (const r of Array.isArray(c.replies) ? c.replies : []) entry(r.author, r.at, r.text)
      pop.append(entries)

      if (readOnly) return

      const reply = document.createElement('textarea')
      reply.className = 'sp-cm-reply'
      reply.rows = 2
      reply.placeholder = t('Reply…')
      pop.append(reply)

      const foot = document.createElement('div')
      foot.className = 'sp-cm-foot'
      const btn = (label: string, run: () => void) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'sp-btn'
        b.textContent = label
        b.addEventListener('click', run)
        foot.append(b)
      }
      btn(t('Reply'), () => {
        const text = reply.value.trim()
        const author = text ? commentAuthor() : null
        if (!text || !author) return
        close()
        this.edit(id, (list, i) => {
          list[i] = { ...list[i], replies: [...(list[i].replies ?? []), { id: uid('cm'), author, at: now(), text }] }
        })
      })
      btn(c.resolved ? t('Reopen') : t('Resolve'), () => {
        close()
        this.edit(id, (list, i) => {
          const next = { ...list[i] }
          if (next.resolved) delete next.resolved
          else next.resolved = true
          list[i] = next
        })
      })
      btn(t('Delete'), () => {
        close()
        this.edit(id, (list, i) => { list.splice(i, 1) })
      })
      pop.append(foot)

      setTimeout(() => reply.focus(), 0)
    })
  }
}

/** The badge for one page in the tree, or null when nothing is open there. */
export function commentBadge(count: number): HTMLElement | null {
  if (!count) return null
  const b = document.createElement('span')
  b.className = 'sp-cm-badge'
  b.textContent = String(count)
  b.title = t('{n} unresolved comment(s)', { n: count })
  return b
}
