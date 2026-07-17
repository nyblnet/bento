// Review comments. Threads live in Slide.comments (saved with the file,
// never rendered in present/print). The editor shows them as small numbered
// markers on the canvas — at the anchored element's top-right corner, or
// stacked in the slide's top-left for slide-level (and orphaned) threads.
// Clicking a marker opens the thread popover: entries, reply, resolve, delete.

import type { Store } from '../store'
import { uid, type Comment } from '../model'

/** The commenter's name, remembered per browser; asked for on first use. */
export function commentAuthor(): string | null {
  let name = localStorage.getItem('bento-author')
  if (!name) {
    name = window.prompt('Your name (shown on comments):')?.trim() || ''
    if (!name) return null
    localStorage.setItem('bento-author', name)
  }
  return name
}

function relTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (!Number.isFinite(s) || s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`
  return new Date(iso).toLocaleDateString()
}

export class CommentsUI {
  private layer: HTMLElement

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
      marker.textContent = String(1 + (c.replies?.length ?? 0))
      marker.title = `${c.author}: ${c.text.slice(0, 80)}`
      if (el) {
        marker.style.left = `${(el.x + el.w) * scale - 9}px`
        marker.style.top = `${el.y * scale - 9}px`
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

  /** Start a new thread on an element (or the slide) and open its popover. */
  openNew(elementId?: string) {
    const author = commentAuthor()
    if (!author) return
    const text = window.prompt('Comment:')?.trim()
    if (!text) return
    const comment: Comment = {
      id: uid('cmt'), elementId, author, text, at: new Date().toISOString(),
    }
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
    head.textContent = c.elementId ? 'Comment · element' : 'Comment · slide'
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
    reply.placeholder = 'Reply…'
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
      mkBtn('Reply', () => {
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
      mkBtn(c.resolved ? 'Reopen' : 'Resolve', () => {
        this.store.commit(() => {
          const live = this.store.slide.comments?.find((x) => x.id === commentId)
          if (live) live.resolved = !live.resolved
        })
        pop.remove()
        this.refresh()
      }),
      mkBtn('Delete', () => {
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
