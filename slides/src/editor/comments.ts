// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
// Review comments. Threads live in Slide.comments (saved with the file,
// never rendered in present/print). The editor shows them as small numbered
// markers on the canvas — at the anchored element's top-right corner, or
// stacked in the slide's top-left for slide-level (and orphaned) threads.
// Clicking a marker opens the thread popover: entries, reply, resolve, delete.

import type { Store } from '../store'
import { uid, type Comment } from '../model'
import { t } from '../i18n'

/** The commenter's name, remembered per browser (localStorage, never sent
 *  anywhere); asked for on first use. */
export function commentAuthor(): string | null {
  let name = localStorage.getItem('bento-author')
  if (!name) {
    name = window.prompt(t('Your name (shown on comments):'))?.trim() || ''
    if (!name) return null
    localStorage.setItem('bento-author', name)
  }
  return name
}

/** Re-ask for the name; existing threads keep their original author. */
export function changeCommentAuthor(): string | null {
  const next = window.prompt(t('Your name (shown on new comments):'), localStorage.getItem('bento-author') ?? '')?.trim()
  if (!next) return null
  localStorage.setItem('bento-author', next)
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

export class CommentsUI {
  private layer: HTMLElement
  private justCreated: string | null = null

  constructor(
    private store: Store,
    stageParent: HTMLElement,
    private scaleOf: () => number,
  ) {
    this.layer = document.createElement('div')
    this.layer.className = 'ed-comment-layer'
    stageParent.appendChild(this.layer)
  }

  /** Rebuild the markers for the current slide (call after render/relayout). */
  refresh() {
    this.layer.innerHTML = ''
    const slide = this.store.slide
    const scale = this.scaleOf()
    let slideStack = 0
    ;(slide.comments ?? []).forEach((c) => {
      const el = c.elementId ? slide.elements.find((e) => e.id === c.elementId) : undefined
      const marker = document.createElement('button')
      marker.className = 'ed-comment-marker' + (c.resolved ? ' resolved' : '')
      if (c.id === this.justCreated) {
        marker.classList.add('fresh')
        setTimeout(() => { this.justCreated = null }, 1200)
      }
      marker.textContent = String(1 + (c.replies?.length ?? 0))
      marker.title = `${c.author}: ${c.text.slice(0, 80)}`
      if (el) {
        marker.style.left = `${(el.x + el.w) * scale - 9}px`
        marker.style.top = `${el.y * scale - 9}px`
      } else if (typeof c.x === 'number' && typeof c.y === 'number') {
        // point anchor: the teardrop's bottom-left tip sits ON the point
        marker.classList.add('point')
        marker.style.left = `${c.x * scale}px`
        marker.style.top = `${c.y * scale - 19}px`
      } else {
        marker.style.left = '10px'
        marker.style.top = `${10 + slideStack * 26}px`
        slideStack++
      }
      marker.addEventListener('click', (ev) => {
        ev.stopPropagation()
        this.openThread(c.id, marker)
      })
      this.layer.appendChild(marker)
    })
  }

  /** Start a new thread on an element, at a point, or on the slide. */
  openNew(elementId?: string, point?: { x: number; y: number }) {
    const author = commentAuthor()
    if (!author) return
    const text = window.prompt(t('Comment:'))?.trim()
    if (!text) return
    const comment: Comment = {
      id: uid('cmt'), elementId, ...(point ?? {}), author, text, at: new Date().toISOString(),
    }
    this.justCreated = comment.id
    this.store.commit(() => {
      const s = this.store.slide
      s.comments = [...(s.comments ?? []), comment]
    })
    this.refresh()
  }

  private openThread(commentId: string, anchor: HTMLElement) {
    document.querySelector('.ed-comment-pop')?.remove()
    const slide = this.store.slide
    const c = slide.comments?.find((x) => x.id === commentId)
    if (!c) return

    const pop = document.createElement('div')
    pop.className = 'ed-comment-pop'

    const head = document.createElement('div')
    head.className = 'ed-comment-pop-head'
    const headLabel = document.createElement('span')
    headLabel.textContent = c.elementId
      ? t('Comment · element')
      : typeof c.x === 'number' ? t('Comment · point ({x}, {y})', { x: c.x!, y: c.y! }) : t('Comment · slide')
    const me = document.createElement('button')
    me.className = 'ed-comment-me'
    me.textContent = t('you: {name} ✎', { name: localStorage.getItem('bento-author') ?? '—' })
    me.title = t('Change the name used for your new comments and replies')
    me.addEventListener('click', () => {
      const next = changeCommentAuthor()
      if (next) me.textContent = t('you: {name} ✎', { name: next })
    })
    head.append(headLabel, me)
    pop.appendChild(head)

    const entries = document.createElement('div')
    entries.className = 'ed-comment-entries'
    const entry = (author: string, at: string, text: string) => {
      const e = document.createElement('div')
      e.className = 'ed-comment-entry'
      e.innerHTML = `<b></b> <span class="ed-comment-time"></span><p></p>`
      e.querySelector('b')!.textContent = author
      e.querySelector('span')!.textContent = relTime(at)
      e.querySelector('p')!.textContent = text
      entries.appendChild(e)
    }
    entry(c.author, c.at, c.text)
    for (const r of c.replies ?? []) entry(r.author, r.at, r.text)
    pop.appendChild(entries)

    const reply = document.createElement('textarea')
    reply.className = 'ed-comment-reply'
    reply.rows = 2
    reply.placeholder = t('Reply…')
    pop.appendChild(reply)

    const foot = document.createElement('div')
    foot.className = 'ed-comment-pop-foot'
    const mkBtn = (label: string, onClick: () => void, cls = 'ed-btn') => {
      const b = document.createElement('button')
      b.className = cls
      b.textContent = label
      b.addEventListener('click', onClick)
      return b
    }
    foot.append(
      mkBtn(t('Reply'), () => {
        const text = reply.value.trim()
        const author = commentAuthor()
        if (!text || !author) return
        this.store.commit(() => {
          const live = this.store.slide.comments?.find((x) => x.id === commentId)
          if (live) live.replies = [...(live.replies ?? []), { id: uid('cmt'), author, text, at: new Date().toISOString() }]
        })
        pop.remove()
        this.refresh()
      }),
      mkBtn(c.resolved ? t('Reopen') : t('Resolve'), () => {
        this.store.commit(() => {
          const live = this.store.slide.comments?.find((x) => x.id === commentId)
          if (live) live.resolved = !live.resolved
        })
        pop.remove()
        this.refresh()
      }),
      mkBtn(t('Delete'), () => {
        this.store.commit(() => {
          const s = this.store.slide
          s.comments = (s.comments ?? []).filter((x) => x.id !== commentId)
          if (!s.comments.length) delete s.comments
        })
        pop.remove()
        this.refresh()
      }),
    )
    pop.appendChild(foot)

    const r = anchor.getBoundingClientRect()
    pop.style.left = `${Math.max(8, Math.min(r.right + 8, window.innerWidth - 320))}px`
    pop.style.top = `${Math.max(8, Math.min(r.top - 10, window.innerHeight - 300))}px`
    document.body.appendChild(pop)
    reply.focus()

    const close = (ev: PointerEvent) => {
      if (!pop.contains(ev.target as Node)) {
        pop.remove()
        document.removeEventListener('pointerdown', close, true)
      }
    }
    setTimeout(() => document.addEventListener('pointerdown', close, true))
  }
}
