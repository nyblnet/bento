// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The Assistant drawer: a chat that edits the open deck. Lives at the foot of
// the properties panel (sticky, so it stays in reach while the inspector
// scrolls) and is re-appended by PropsPanel.rebuild on every rebuild — the
// SAME node, like Layers, so a running turn survives a canvas click.
//
// The page never holds an endpoint or a key: every turn goes out through the
// bento/home extension (transport.ts has the contract and the reasoning).
// Without the extension the drawer is one sentence and a link. A reply that
// carries JSON becomes ONE store.replaceDoc through parseDocInputReport — the
// gate pasted JSON meets — and the result card says what was dropped, what
// the validator flagged, and offers Undo (store.undo: the same step).

import { t } from '../../i18n'
import type { Store } from '../../store'
import { parseDocInputReport, fitAutoHeights, restack } from '../../compactload'
import { validateDoc, type Finding } from '../../validate'
import { lsGet, lsSet } from '../../../../kernel/src/storage.ts'
import { offlineEnabled } from '../../../../kernel/src/net.ts'
import { ExtensionTransport, extensionPresent, type AssistantDescription, type AssistantModel, type AssistantTransport } from './transport'

/** Display names for on-device model ids; anything else shows as its id. */
export const MODEL_NAMES: Record<string, string> = { 'gemini-nano': 'Gemini Nano' }
export const modelDisplay = (id: string): string => MODEL_NAMES[id] ?? id
/** provider ids → the names people know them by; unknown ids as-is */
const PROVIDER_NAMES: Record<string, string> = { builtin: 'Chrome', gemini: 'Gemini', anthropic: 'Anthropic', openai: 'OpenAI' }
export const providerDisplay = (id: string): string => PROVIDER_NAMES[id] ?? id
/** 200000 → "200k", 1048576 → "1M" */
export const windowDisplay = (n: number): string => n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
import { applyOps, buildMessages, cleanDoc, mergeReply, parseReply, responseSchema, RETRY_NUDGE, type Turn } from './prompt'
import { remoteUrls } from './ops'
import { sanitizeHtml, sanitizeSvgCss, sanitizeSvgMarkup } from '../../render'

/**
 * A reply's markdown as html for the transcript: paragraphs on blank lines,
 * "- " / "* " / "1. " lines as lists, **bold**, *italic*, `code`. Escaped
 * FIRST — a model's prose can carry markup — and sanitized again after, the
 * same gate as every model string. The editor's markdown.ts converts for
 * contentEditable (<br>, bullet glyphs); a transcript wants real blocks.
 */
export function proseHtml(text: string): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (t: string) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
  const out: string[] = []
  for (const block of text.replace(/\r\n?/g, '\n').trim().split(/\n{2,}/)) {
    const lines = block.split('\n')
    const bullet = lines.every((l) => /^\s*[-*•]\s+/.test(l))
    const numbered = !bullet && lines.every((l) => /^\s*\d+[.)]\s+/.test(l))
    if (bullet || numbered) {
      const tag = bullet ? 'ul' : 'ol'
      out.push(`<${tag}>${lines.map((l) => `<li>${inline(l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''))}</li>`).join('')}</${tag}>`)
    } else if (/^#{1,6}\s/.test(lines[0])) {
      out.push(`<p><strong>${inline(lines[0].replace(/^#{1,6}\s+/, ''))}</strong></p>`)
      if (lines.length > 1) out.push(`<p>${lines.slice(1).map(inline).join('<br>')}</p>`)
    } else {
      out.push(`<p>${lines.map(inline).join('<br>')}</p>`)
    }
  }
  return out.join('')
}

/** The floating window's last rectangle (viewport px), clamped on read so a
 *  window saved on a big display still lands on screen on a small one. */
const FLOAT_KEY = 'bento-assist-rect'
function readRect(): { x: number; y: number; w: number; h: number } {
  // default: beside the right sidebar, not over it — the point of popping out
  // is the deck AND the inspector beside the chat
  const side = document.querySelector<HTMLElement>('.ed-props:not(.ed-collapsed)')?.offsetWidth ?? 0
  let r = { x: Math.max(0, window.innerWidth - side - 360 - 24), y: 80, w: 360, h: Math.min(560, window.innerHeight - 120) }
  try {
    const v = JSON.parse(lsGet(FLOAT_KEY) || 'null') as Partial<typeof r> | null
    if (v && [v.x, v.y, v.w, v.h].every((n) => typeof n === 'number' && Number.isFinite(n))) r = v as typeof r
  } catch { /* keep the default */ }
  r.w = Math.min(Math.max(r.w, 280), window.innerWidth)
  r.h = Math.min(Math.max(r.h, 240), window.innerHeight)
  r.x = Math.min(Math.max(r.x, 0), window.innerWidth - 120)
  r.y = Math.min(Math.max(r.y, 0), window.innerHeight - 40)
  return r
}
function saveRect(win: HTMLElement) {
  lsSet(FLOAT_KEY, JSON.stringify({ x: win.offsetLeft, y: win.offsetTop, w: win.offsetWidth, h: win.offsetHeight }))
}

/** Where "get the extension" points. The app has no store link yet — the
 *  repository directory is the honest address until a listing exists. */
export const EXTENSION_URL = 'https://github.com/nyblnet/bento/tree/main/home/webext'

const el = (tag: string, cls: string, text?: string) => {
  const n = document.createElement(tag)
  n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

const findingKey = (f: Finding) => `${f.code}|${f.slide ?? ''}|${f.element ?? ''}|${f.message}`

export interface AssistantPanelOpts {
  /** the sidebar tab the panel fills; without it the panel is a standalone drawer (tests) */
  dock?: HTMLElement
  store: Store
  /** injectable for the rig; production omits it and the window decides */
  transport?: AssistantTransport | null
  present?: () => boolean
  toast?: (message: string) => void
}

export class AssistantPanel {
  readonly root = el('section', 'ed-assist')
  private body = el('div', 'ed-assist-body')
  private status = el('div', 'ed-assist-status')
  private log = el('div', 'ed-assist-log')
  private input = document.createElement('textarea')
  private clearB = document.createElement('button')
  private dock: HTMLElement | null = null
  /** the floating window when popped out (the same body, re-parented) */
  private float: HTMLElement | null = null
  private floatB = document.createElement('button')
  /** the editor listens: a popped-out assistant empties its tab */
  onFloatChange: ((floating: boolean) => void) | null = null
  get floating(): boolean { return this.float !== null }
  private notice = el('div', 'ed-assist-notice')
  private sendB = document.createElement('button')
  private history: Turn[] = []
  private transport: AssistantTransport | null
  private present: () => boolean
  private running: AbortController | null = null
  private described: AssistantDescription | null = null
  /** the routes the extension offered (assistant.models); a picker when > 1 */
  private routes: AssistantModel[] = []
  /** the extension is asking the user (check code 'consent-pending'): one re-check is armed */
  private consentPending = false
  private recheckArmed = false
  private store: Store
  private toast: (m: string) => void

  constructor(opts: AssistantPanelOpts) {
    this.store = opts.store
    this.toast = opts.toast ?? (() => {})
    this.present = opts.present ?? (() => extensionPresent())
    this.transport = opts.transport === undefined ? (this.present() ? new ExtensionTransport() : null) : opts.transport
    this.dock = opts.dock ?? null
    this.build()
    if (this.dock) {
      // docked: no accordion — the tab IS the open state, the column is the height
      this.root.classList.add('ed-assist-docked')
      this.dock.appendChild(this.root)
      this.setOpen(true, false)
      if (lsGet('bento-assist-float') === 'on') this.popOut(false)
    }
  }

  /** The tab was shown: make sure the route is fresh and the input has focus. */
  activate() {
    if (!this.root.classList.contains('open')) this.setOpen(true, false)
    else void this.describe()
    this.focusInput()
  }

  focusInput() { this.input.focus() }

  /**
   * Pop out: the panel becomes a floating window over the canvas —
   * draggable by its header, resizable by its corner (CSS resize), size and
   * position remembered — so the deck and the chat sit side by side without
   * narrowing the inspector. The same node moves; nothing about the
   * conversation changes. Dock it back with the same button.
   */
  popOut(persist = true) {
    if (this.float || !this.dock) return
    const win = el('div', 'ed-assist-float')
    const pos = readRect()
    win.style.left = `${pos.x}px`
    win.style.top = `${pos.y}px`
    win.style.width = `${pos.w}px`
    win.style.height = `${pos.h}px`
    win.appendChild(this.root)
    document.body.appendChild(win)
    this.float = win
    this.floatB.textContent = '⇲'
    this.floatB.title = t('Dock to the sidebar')
    // drag by the header; clamp so the title bar always stays on screen
    let drag: { dx: number; dy: number } | null = null
    const head = this.root.querySelector<HTMLElement>('.ed-assist-head')!
    head.style.cursor = 'move'
    head.addEventListener('mousedown', (ev) => {
      if ((ev.target as HTMLElement).closest('button:not(.ed-assist-head)')) return
      drag = { dx: ev.clientX - win.offsetLeft, dy: ev.clientY - win.offsetTop }
      ev.preventDefault()
    })
    const move = (ev: MouseEvent) => {
      if (!drag) return
      const x = Math.min(Math.max(ev.clientX - drag.dx, 0), window.innerWidth - 120)
      const y = Math.min(Math.max(ev.clientY - drag.dy, 0), window.innerHeight - 40)
      win.style.left = `${x}px`; win.style.top = `${y}px`
    }
    const up = () => { if (drag) { drag = null; saveRect(win) } }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
    const ro = new ResizeObserver(() => saveRect(win))
    ro.observe(win)
    this.floatCleanup = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); ro.disconnect(); head.style.cursor = '' }
    if (persist) lsSet('bento-assist-float', 'on')
    this.onFloatChange?.(true)
    this.fitInput()
  }

  private floatCleanup: (() => void) | null = null

  dockBack() {
    if (!this.float || !this.dock) return
    this.floatCleanup?.(); this.floatCleanup = null
    this.dock.appendChild(this.root)
    this.float.remove()
    this.float = null
    this.floatB.textContent = '⇱'
    this.floatB.title = t('Pop out')
    lsSet('bento-assist-float', 'off')
    this.onFloatChange?.(false)
  }

  private build() {
    const head = document.createElement('button')
    head.className = 'ed-assist-head'
    head.type = 'button'
    head.append(el('span', 'ed-assist-title', t('Assistant')), el('span', 'ed-assist-chev', '▾'))
    head.addEventListener('click', () => { if (!this.dock) this.setOpen(!this.root.classList.contains('open')) })
    // pop out / dock back (docked panels only; a drawer has nowhere to go)
    this.floatB.type = 'button'
    this.floatB.className = 'ed-assist-pop'
    this.floatB.textContent = '⇱'
    this.floatB.title = t('Pop out')
    this.floatB.addEventListener('click', (ev) => { ev.stopPropagation(); if (this.float) this.dockBack(); else this.popOut() })
    head.appendChild(this.floatB)

    // the scope is the selection (prompt.ts says why there is no switch);
    // the notice under the input says what will go, and follows it
    this.store.on('selection', () => this.refreshNotice())
    this.store.on('current', () => this.refreshNotice())
    this.store.on('doc', () => this.refreshNotice())
    this.input.className = 'ed-assist-input'
    this.input.rows = 2
    this.input.placeholder = t('Ask for a change…')
    this.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); void this.submit() }
    })
    this.sendB.type = 'button'
    this.sendB.className = 'ed-btn ed-btn-primary ed-assist-send'
    this.sendB.textContent = t('Send')
    this.sendB.addEventListener('click', () => { if (this.running) this.stop(); else void this.submit() })
    // the box grows with what is typed, up to six lines — unless the user
    // dragged its handle, then that height is theirs (remembered)
    this.input.addEventListener('input', () => this.fitInput())
    const savedH = Number(lsGet('bento-assist-input-h'))
    if (savedH >= 40) { this.input.style.height = `${savedH}px`; this.inputSized = true }
    this.input.addEventListener('mousedown', () => { this.inputH0 = this.input.offsetHeight })
    this.input.addEventListener('mouseup', () => {
      if (this.inputH0 !== null && this.input.offsetHeight !== this.inputH0) { this.inputSized = true; lsSet('bento-assist-input-h', String(this.input.offsetHeight)) }
      this.inputH0 = null
    })
    const acts = el('div', 'ed-assist-acts')
    acts.append(el('span', 'ed-assist-hint', t('Enter to send · Shift+Enter for a new line')), this.sendB)
    // clear: the transcript and the history the next turn would carry
    this.clearB.type = 'button'
    this.clearB.className = 'ed-assist-clear'
    this.clearB.textContent = t('Clear')
    this.clearB.title = t('Clear the conversation')
    this.clearB.addEventListener('click', () => this.clear())
    this.clearB.hidden = true

    this.body.append(this.status, this.log, this.input, this.notice, acts)
    this.root.append(head, this.body)
    this.setOpen(lsGet('bento-assist-open') === 'on', false)
    this.refreshStatus()
  }

  private setOpen(open: boolean, persist = true) {
    this.root.classList.toggle('open', open)
    if (persist) lsSet('bento-assist-open', open ? 'on' : 'off')
    if (open) void this.describe()
  }

  /** The sentence at the top: the route, or why there is none. */
  private refreshStatus() {
    const s = this.status
    s.innerHTML = ''
    s.appendChild(this.clearB)
    this.refreshNotice()
    const usable = this.transport && !offlineEnabled()
    this.input.disabled = !usable
    this.sendB.disabled = !usable
    if (!this.transport) {
      s.append(el('span', '', t('The assistant needs the bento/home extension (Chrome or Edge).') + ' '))
      const a = document.createElement('a')
      a.href = EXTENSION_URL
      a.target = '_blank'
      a.rel = 'noopener'
      a.textContent = t('Get the extension')
      s.appendChild(a)
      return
    }
    if (offlineEnabled()) {
      s.append(el('span', '', t('Offline mode is on — the assistant is off.')))
      return
    }
    const d = this.described
    const settings = document.createElement('a')
    settings.href = '#'
    settings.className = 'ed-assist-settings'
    settings.textContent = t('Settings…')
    settings.addEventListener('click', (ev) => { ev.preventDefault(); void this.transport?.openSettings() })
    if (d && !d.configured) {
      s.append(el('span', '', t('The extension has no assistant endpoint yet.') + ' '), settings)
      this.input.disabled = true
      this.sendB.disabled = true
      return
    }
    if (this.consentPending) {
      s.append(el('span', 'ed-assist-waiting', t('Waiting for your permission on this device…') + ' '), settings)
      this.input.disabled = true
      this.sendB.disabled = true
      return
    }
    const where = d?.local ? `${t('on this device')} · ${modelDisplay(d.model)}` : d ? `${d.host || '—'} · ${d.model || '—'}` : ''
    if (this.routes.length > 1) {
      // several routes: the model is a picker; the extension keeps the
      // keys and the choice, the page only says which
      s.append(el('span', 'ed-assist-route', `${t('via {host}', { host: this.transport.name })} · `), this.buildPicker(), el('span', '', ' '), settings)
      return
    }
    const route = where ? `${t('via {host}', { host: this.transport.name })} · ${where}` : t('via {host}', { host: this.transport.name })
    s.append(el('span', 'ed-assist-route', route + ' '), settings)
  }

  /** The route picker: one option per model, grouped by provider, the
   *  window beside it when known. Choosing one is assistant.select, then
   *  a fresh describe + check. */
  private buildPicker(): HTMLSelectElement {
    const sel = document.createElement('select')
    sel.className = 'ed-assist-model'
    sel.title = t('Model')
    const groups = new Map<string, HTMLOptGroupElement>()
    const d = this.described
    for (const r of this.routes) {
      let g = groups.get(r.provider)
      if (!g) { g = document.createElement('optgroup'); g.label = providerDisplay(r.provider); groups.set(r.provider, g); sel.appendChild(g) }
      const o = document.createElement('option')
      o.value = `${r.provider}\u001f${r.model}`
      const name = r.local ? modelDisplay(r.model) : r.model
      o.textContent = r.contextTokens ? `${name} · ${windowDisplay(r.contextTokens)}` : name
      if (r.current || (d && d.model === r.model && ((r.local && d.local) || (!r.local && d.host === r.host)))) o.selected = true
      g.appendChild(o)
    }
    sel.addEventListener('change', () => {
      const [provider, model] = sel.value.split('\u001f')
      sel.disabled = true
      void this.transport?.select(provider, model).then(async (r) => {
        if (!r.ok) this.note(t('The request failed: {reason}', { reason: r.reason }), 'err')
        await this.describe()
      })
    })
    return sel
  }

  /** Where the user is: the open slide and the selected element ids. */
  private focus() {
    return { index: this.store.currentIndex, selection: this.store.selection }
  }

  /** One line under the input saying what leaves the page (prompt.ts):
   *  the deck's outline plus the focus — the selection, or the open slide. */
  private refreshNotice() {
    if (!this.transport) { this.notice.textContent = ''; return }
    const host = this.described?.local ? t('the on-device model') : (this.described?.host || this.transport.name)
    const n = this.store.selection.length
    const focus = n === 1 ? t('the selected element') : n > 1 ? t('the {n} selected elements', { n: String(n) }) : t('this slide')
    this.notice.textContent = t("Sends the deck's outline and {focus} to {host}; comments stay here.", { focus, host })
  }

  private async describe() {
    if (!this.transport) return
    try {
      this.described = await this.transport.describe()
      this.routes = await this.transport.models()
    } catch (e) {
      this.described = { host: '', model: '', configured: false }
      this.routes = []
      this.note(t('The extension did not answer: {reason}', { reason: (e as Error).message }), 'err')
    }
    this.refreshStatus()
    this.refreshNotice()
    if (this.described.configured) await this.check()
  }

  /**
   * One cheap round-trip before a real turn. Keyed on the CODE: 'consent-pending'
   * means the extension is asking the user (an on-device model's prompt), so
   * the drawer waits and re-checks ONCE when the document comes back —
   * focus or visibility, whichever fires first — rather than polling.
   */
  private async check(): Promise<void> {
    if (!this.transport) return
    const r = await this.transport.check()
    this.consentPending = !r.ok && r.code === 'consent-pending'
    if (!r.ok && !this.consentPending) this.note(t('The request failed: {reason}', { reason: r.reason }), 'err')
    this.refreshStatus()
    if (this.consentPending && !this.recheckArmed) {
      this.recheckArmed = true
      const once = () => {
        window.removeEventListener('focus', once)
        document.removeEventListener('visibilitychange', once)
        this.recheckArmed = false
        if (this.consentPending) void this.check()
      }
      window.addEventListener('focus', once)
      document.addEventListener('visibilitychange', once)
    }
  }

  /** A line in the log. */
  private note(text: string, kind: 'user' | 'assistant' | 'err' | 'info'): HTMLElement {
    const n = el('div', `ed-assist-msg ed-assist-${kind}`, text)
    this.log.appendChild(n)
    this.log.scrollTop = this.log.scrollHeight
    this.clearB.hidden = false
    return n
  }

  /**
   * A finished assistant reply: rendered from its markdown (bold, lists,
   * paragraphs — models write it whether asked or not) through the same
   * sanitizer every model string passes, plus a Copy button for the raw
   * text. Streaming stays plain text; this runs once at the end.
   */
  private finishReply(live: HTMLElement, text: string) {
    live.classList.remove('ed-assist-live', 'ed-assist-wait')
    live.textContent = ''
    const body = el('div', 'ed-assist-prose')
    body.innerHTML = sanitizeHtml(proseHtml(text))
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'ed-assist-copy'
    copy.title = t('Copy')
    copy.textContent = '⧉'
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(text).then(() => { copy.textContent = '✓'; setTimeout(() => { copy.textContent = '⧉' }, 1200) })
    })
    live.append(body, copy)
  }

  private inputSized = false
  private inputH0: number | null = null
  private fitInput() {
    if (this.inputSized) return
    this.input.style.height = 'auto'
    const line = 20
    this.input.style.height = `${Math.min(Math.max(this.input.scrollHeight, line * 2), line * 6 + 12)}px`
  }

  /** Forget the conversation: the log and the turns the next request would carry. */
  clear() {
    this.log.replaceChildren()
    this.history = []
    this.clearB.hidden = true
    this.input.focus()
  }

  stop() {
    this.running?.abort()
  }

  private setRunning(on: boolean) {
    this.running = on ? new AbortController() : null
    this.sendB.textContent = on ? t('Stop') : t('Send')
    this.sendB.classList.toggle('ed-assist-stop', on)
    this.input.disabled = on
  }

  async submit(): Promise<void> {
    const request = this.input.value.trim()
    if (!request || this.running || !this.transport || offlineEnabled()) return
    this.input.value = ''
    this.fitInput()
    this.note(request, 'user')
    this.history.push({ role: 'user', text: request })
    const doc = this.store.doc
    const index = this.store.currentIndex
    const local = !!this.described?.local
    const { messages, elided, mode, focus, contextTokens, window, fits } = buildMessages(doc, this.focus(), this.history.slice(0, -1), request, { local, contextTokens: this.described?.contextTokens })
    // the turn was sized to the model's window (prompt.ts): refuse here,
    // with the numbers, rather than after the wait with the provider's
    // "too large"
    if (!fits) {
      this.note(t('The deck outline alone is too large for this model ({tokens} tokens; its window is {window}). Choose a model with a larger window in the extension settings.', { tokens: String(contextTokens), window: String(window) }), 'err')
      return
    }
    if (mode === 'edit' && focus === 'none') {
      // the focus did not fit: the model gets the outline only, so it can
      // change words and structure but not geometry or styling
      this.note(t('Only the outline fits this model\u2019s window, so it can change words, notes and slides but not positions or styling.'), 'info')
    }
    this.setRunning(true)
    // the live bubble says the model is working until the first token —
    // an on-device model can take seconds to load before it says anything
    const live = this.note(local ? t('Working on it… the on-device model is loading.') : t('Working on it…'), 'assistant')
    live.classList.add('ed-assist-live', 'ed-assist-wait')
    let text = ''
    const schema = responseSchema(mode, focus)
    const onChunk = (chunk: string) => {
      if (live.classList.contains('ed-assist-wait')) { live.classList.remove('ed-assist-wait'); live.textContent = '' }
      live.textContent += chunk
      this.log.scrollTop = this.log.scrollHeight
    }
    try {
      text = await this.transport.send(messages, onChunk, this.running!.signal, { schema })
      // an edit that came back as prose gets ONE nudge (a small model that
      // ignored the shape usually takes it the second time); prose again is
      // shown as the answer — that is the "this needs a hosted model" reply
      if (mode !== 'ask' && !text.includes('{')) {
        const again = [...messages, { role: 'assistant' as const, content: text }, { role: 'user' as const, content: RETRY_NUDGE }]
        live.textContent = ''
        live.classList.add('ed-assist-wait')
        live.textContent = t('Working on it…')
        text = await this.transport.send(again, onChunk, this.running!.signal, { schema })
      }
    } catch (e) {
      live.remove()
      const err = e as Error
      if (err.name === 'AbortError') this.note(t('Stopped.'), 'info')
      else if ((err as { code?: string }).code === 'consent-denied') this.refusal()
      else this.note(t('The request failed: {reason}', { reason: err.message }), 'err')
      this.setRunning(false)
      return
    }
    this.setRunning(false)
    // a question's reply is prose whatever shape it took — never applied
    const reply = mode === 'ask' ? { kind: 'text' as const, text: text.trim() } : parseReply(text)
    if (reply.kind === 'text') {
      this.finishReply(live, reply.text)
      this.history.push({ role: 'assistant', text: reply.text })
      return
    }
    live.remove()
    if (reply.note) this.note(reply.note, 'assistant')
    this.history.push({ role: 'assistant', text: reply.note || t('(edited the deck)') })
    // the ops patch (ops.ts): applied to a copy of the elided compact doc,
    // then the same road as pasted JSON
    const r = applyOps(elided.doc, reply.value)
    if (!r.applied.length) { this.note(t('The reply changed nothing I could apply.'), 'err'); return }
    if (r.skipped.length) this.note(t('{n} changes named something that is not there and were skipped.', { n: String(r.skipped.length) }), 'info')
    this.apply(index, r.doc, elided, r.applied)
  }

  /** The user declined the on-device model: a plain card, nothing changed. */
  private refusal() {
    const card = el('div', 'ed-assist-card ed-assist-refused')
    card.appendChild(el('div', 'ed-assist-card-h', t('Permission was refused on this device — nothing was changed.')))
    this.log.appendChild(card)
    this.log.scrollTop = this.log.scrollHeight
  }

  /** The patched deck → one undoable document swap, and a card saying what happened. */
  private apply(index: number, value: Record<string, unknown>, elided: ReturnType<typeof buildMessages>['elided'], ops: string[] = []) {
    if (this.store.readOnly) { this.note(t('This deck is read-only here — nothing was changed.'), 'err'); return }
    const json = mergeReply(this.store.doc, value, elided)
    const parsed = json ? parseDocInputReport(json) : null
    if (!parsed) { this.note(t('The reply was not a deck edit I could apply.'), 'err'); return }
    const next = parsed.doc
    // the model's markup is cleaned ONCE, here, the way pasted markup is at
    // commit — the gate above is a shape gate (prompt.ts cleanDoc says why)
    cleanDoc(next, { html: sanitizeHtml, svg: sanitizeSvgMarkup, svgCss: sanitizeSvgCss })
    // the card reports what the EDIT introduced: a deck that already had
    // fourteen off-canvas warnings should not list them under every reply
    const had = new Set(validateDoc(this.store.doc).findings.map(findingKey))
    // the fetches this patch introduced: every remote URL in the new
    // document that the old one did not have (F: the user sees the request
    // the deck will make at render, the model cannot add one silently)
    const before = remoteUrls(this.store.doc)
    const introduced = [...remoteUrls(next)].filter((u) => !before.has(u))
    // identity and capability are the live document's, never the reply's —
    // the same rule "Replace from JSON…" applies (editor.ts)
    const keep = this.store.doc.collab
    if (keep) next.collab = keep
    else delete next.collab
    this.store.replaceDoc(next)
    if (index < next.slides.length) this.store.goTo(index)
    if (parsed.report.refit.length) {
      void document.fonts?.ready.then(() => {
        if (this.store.doc !== next) return
        const n = fitAutoHeights(next, { autoHeight: parsed.report.refit })
        if (n) { restack(next, { stacks: parsed.report.stacks }); this.store.commit(() => {}) }
      })
    }
    const r = parsed.report
    const fresh = r.findings.findings.filter((f) => f.severity !== 'info' && !had.has(findingKey(f)))
    const warnings = fresh.length
    const card = el('div', 'ed-assist-card')
    const head = el('div', 'ed-assist-card-h',
      ops.length === 1 ? t('Applied: {what}', { what: ops[0] }) : t('Applied {n} changes', { n: String(ops.length) }))
    const undo = document.createElement('button')
    undo.type = 'button'
    undo.className = 'ed-btn ed-assist-undo'
    undo.textContent = t('Undo')
    undo.addEventListener('click', () => { this.store.undo(); undo.disabled = true })
    head.appendChild(undo)
    card.appendChild(head)
    if (introduced.length) {
      const line = el('div', 'ed-assist-card-remote', t('Loads from the web: {hosts}', { hosts: introduced.slice(0, 6).join(', ') + (introduced.length > 6 ? '…' : '') }))
      card.appendChild(line)
    }
    if (r.dropped.length || warnings) {
      card.appendChild(el('div', 'ed-assist-card-sum',
        t('{dropped} fields dropped, {warnings} warnings', { dropped: String(r.dropped.length), warnings: String(warnings) })))
      const list = el('ul', 'ed-assist-card-list')
      for (const d of r.dropped.slice(0, 4)) list.appendChild(el('li', '', `${d.path} — ${d.reason}`))
      for (const f of fresh.slice(0, 4)) list.appendChild(el('li', '', f.message))
      card.appendChild(list)
      console.info('[bento] assistant load report', r)
    }
    this.log.appendChild(card)
    this.log.scrollTop = this.log.scrollHeight
    this.toast(t('Deck updated by the assistant — ⌘Z undoes'))
  }
}
