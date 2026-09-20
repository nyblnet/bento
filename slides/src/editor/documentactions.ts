// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/** Searchable commands, outline editing and document actions. These operate
 * through the store and renderer, and add no document fields or network calls. */
import type { Store } from '../store'
import type { TextElement } from '../model'
import { t } from '../i18n'
import { referencedAssetKeys } from '../assets'
import { createDialog, type Dialog } from '../../../kernel/src/ui/dialog'
import '../../../kernel/src/ui/dialog.css'

export interface Command { label: string; run: () => void }
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
  const el = document.createElement(tag); el.textContent = text; return el
}
const button = (label: string, run: () => void) => {
  const b = node('button', label); b.type = 'button'; b.className = 'ed-btn'; b.onclick = run; return b
}
const plain = (html: string) => new DOMParser().parseFromString(html, 'text/html').body.textContent ?? ''
const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`

export class DocumentActions {
  private dialog?: Dialog
  constructor(private store: Store, private commands: () => Command[], private commitText: () => void) {}
  private open(title: string, content: HTMLElement, actions?: HTMLElement[], closeLabel = t('Done')) {
    this.dialog?.close()
    this.commitText()
    const close = button(closeLabel, () => this.dialog?.close())
    const d = createDialog({ title, content, actions: [close, ...(actions ?? [])] })
    d.card.classList.add('ed-document-dialog')
    this.dialog = d
    d.open()
    return d
  }
  private locate(slideId: string, element?: string) {
    this.dialog?.close()
    const at = this.store.doc.slides.findIndex(s => s.id === slideId)
    if (at < 0) return
    this.store.goTo(at)
    if (element) this.store.select([element])
  }
  search() {
    const body = node('div'), input = node('input'), list = node('div')
    input.type = 'search'; input.placeholder = t('Search commands and slides'); input.setAttribute('aria-label', input.placeholder)
    list.className = 'ed-command-results'
    body.append(input, list)
    const commands: Command[] = [
      { label: t('Edit text and notes'), run: () => this.outline() },
      { label: t('File size'), run: () => this.size() },
      { label: t('Recent changes'), run: () => this.history() },
      ...this.commands(),
    ]
    const render = () => {
      list.replaceChildren()
      const q = input.value.toLocaleLowerCase().trim()
      const matches = commands.filter(x => x.label.toLocaleLowerCase().includes(q))
      if (matches.length) list.append(node('h3', t('Editing')))
      for (const cmd of matches) {
        const row = button(cmd.label, () => { this.dialog?.close(); cmd.run() })
        row.classList.add('ed-command-row'); list.append(row)
      }
      let slideCount = 0
      this.store.doc.slides.forEach((s, i) => {
        const title = s.name || s.elements.filter(e => e.type === 'text').map(e => plain(e.html)).join(' ').slice(0, 100) || t('Untitled')
        const all = [title, s.notes, ...s.elements.map(e => e.type === 'text' ? plain(e.html) : e.type === 'code' ? e.content : e.type === 'table' ? JSON.stringify(e.rows) : '')].join(' ').toLocaleLowerCase()
        if (!q || !all.includes(q) || slideCount >= 30) return
        if (!slideCount++) list.append(node('h3', t('Slides')))
        const row = button(`${i + 1}. ${title}`, () => this.locate(s.id))
        row.classList.add('ed-command-row'); list.append(row)
      })
      if (!list.childElementCount) list.append(node('p', t('No results')))
    }
    input.oninput = render
    body.addEventListener('keydown', e => {
      const rows = [...list.querySelectorAll('button')]
      const at = rows.indexOf(document.activeElement as HTMLButtonElement)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation()
        const next = e.key === 'ArrowDown' ? (at + 1) % rows.length : at <= 0 ? rows.length - 1 : at - 1
        rows[next]?.focus()
      } else if (e.key === 'Enter' && e.target === input) { e.preventDefault(); rows[0]?.click() }
    })
    render(); this.open(t('Search commands and slides'), body).card.classList.add('ed-command-dialog')
  }
  outline() {
    this.commitText()
    const body = node('div'), select = node('select'), fields = node('div')
    select.setAttribute('aria-label', t('Slides'))
    for (const [i, s] of this.store.doc.slides.entries()) {
      const opt = node('option', `${i + 1}. ${s.name || s.elements.filter(e => e.type === 'text').map(e => plain(e.html)).join(' ').slice(0, 70) || t('Untitled')}`)
      opt.value = s.id; select.append(opt)
    }
    select.value = this.store.slide.id
    body.append(select, node('p', t('Edit as plain text. Applying replaces inline formatting.')), fields)
    type Edit = { id?: string; initial: string; initialText: string; input: HTMLTextAreaElement }
    const drafts = new Map<string, { edits: Edit[]; fields: Node[] }>()
    let slideId = select.value
    const fill = () => {
      slideId = select.value
      const slide = this.store.doc.slides.find(s => s.id === slideId)
      fields.replaceChildren()
      if (!slide) return
      const draft = drafts.get(slideId)
      if (draft) { fields.append(...draft.fields); return }
      const edits: Edit[] = []
      for (const e of slide.elements) if (e.type === 'text') {
        const label = node('label', `${t('Text')} ${edits.length + 1}`), area = node('textarea')
        area.value = plain(e.html.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n'))
        area.rows = 3; label.append(area); fields.append(label)
        edits.push({ id: e.id, initial: e.html, initialText: area.value, input: area })
      }
      const label = node('label', t('Speaker notes')), area = node('textarea')
      area.value = slide.notes ?? ''; area.rows = 5; label.append(area); fields.append(label)
      edits.push({ initial: slide.notes ?? '', initialText: area.value, input: area })
      drafts.set(slideId, { edits, fields: [...fields.childNodes] })
    }
    const apply = button(t('Apply'), () => {
      const slide = this.store.doc.slides.find(s => s.id === slideId)
      if (!slide) return
      const pending = [...drafts].flatMap(([id, draft]) => draft.edits
        .filter(edit => edit.input.value !== edit.initialText)
        .map(edit => ({ slide: this.store.doc.slides.find(s => s.id === id), edit })))
      if (pending.some(({ slide, edit }) => !slide || (edit.id
        ? (slide.elements.find(x => x.id === edit.id) as TextElement | undefined)?.html
        : slide.notes ?? '') !== edit.initial)) {
        warning.textContent = t('Content changed while editing. Reopen this editor.'); return
      }
      if (pending.length) this.store.commit(() => {
        for (const { slide, edit } of pending) {
          if (edit.id) {
            const el = slide!.elements.find(x => x.id === edit.id) as TextElement
            el.html = edit.input.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
          } else slide!.notes = edit.input.value
        }
      })
      this.locate(slide.id)
    })
    const warning = node('p'); warning.setAttribute('role', 'status'); body.append(warning)
    select.onchange = fill; fill()
    this.open(t('Edit text and notes'), body, [apply], t('Cancel'))
  }
  size() {
    const doc = this.store.doc, body = node('div'), used = referencedAssetKeys(doc)
    const total = new TextEncoder().encode(JSON.stringify(doc)).length
    body.append(node('p', `${t('Data in this deck')}: ${bytes(total)}`), node('p', t('Size excludes the viewer and editor.')))
    const assets = Object.entries(doc.assets ?? {}).map(([key, value]) => ({ key, size: new TextEncoder().encode(value).length, used: used.has(key) })).sort((a,b)=>b.size-a.size)
    for (const asset of assets) body.append(node('p', `${asset.key} — ${bytes(asset.size)}${asset.used ? '' : ` · ${t('Unused assets')}`}`))
    const optimize = this.commands().find(c => c.label === t('Compress pictures in this deck…'))
    this.open(t('File size'), body, optimize ? [button(optimize.label, () => { this.dialog?.close(); optimize.run() })] : undefined)
  }
  history() {
    const body = node('div')
    body.append(node('p', t('Changes are kept only for this session.')))
    for (const change of [...this.store.recentChanges].reverse()) {
      const card = node('div'); card.className = 'ed-change-card'
      card.append(node('strong', `${change.local ? t('You') : t('Collaborator')} · ${new Date(change.at).toLocaleTimeString()}`))
      for (const c of change.delta.slice(0, 12)) {
        const path = c.path.map(x => typeof x === 'string' ? x : x.id).join(' / ')
        const summarize = (x: unknown) => typeof x === 'string' ? x.slice(0, 120) : JSON.stringify(x)?.slice(0, 120) ?? '—'
        card.append(node('p', `${path}: ${summarize(c.before)} → ${summarize(c.after)}`))
      }
      card.append(button(t('Revert this change'), () => {
        if (!confirm(t('Revert the selected change? Later edits to these fields will be overwritten.'))) return
        this.store.revertChange(change.id); this.history()
      }))
      body.append(card)
    }
    this.open(t('Recent changes'), body)
  }
}
