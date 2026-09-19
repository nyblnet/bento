// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The assistant's transport: how a chat turn leaves the page and how the
// reply streams back. There is exactly one implementation, and it is NOT a
// network call — the page never talks to a model endpoint itself.
//
// WHY EXTENSION-ONLY. A chat that edits the deck needs an endpoint and a key.
// A key held by the page would be a key in the page: in a `.bento.html` that
// is a document people mail, save copies of, share live and paste as JSON —
// every one of those a place the key could leak from, and every one a rig to
// write and keep green. The bento/home extension already exists, already has
// a bridge into every file:// deck it hosts, and has real extension storage
// the page cannot read. So the endpoint, the model and the key live THERE,
// the request is made THERE, and the page only ever sees text: the prompt it
// sends and the reply it gets. There is no fallback path with a key in it,
// which is what makes "the page has no place to put a key" a property a rig
// can assert (scripts/test-export-secrets.ts) rather than a promise.
//
// ——— THE BRIDGE CONTRACT (home/webext implements the other side) ———
//
// Frames ride the SAME window.postMessage envelope the save bridge uses
// (home/webext/src/page-bridge.js, relay.js):
//
//   page → extension   { __bento_tray__: true, dir: 'req', id, op, payload }
//   extension → page   { __bento_tray__: true, dir: 'res', id, result }
//   extension → page   { __bento_tray__: true, dir: 'evt', id, kind, ... }   (streaming only)
//
// `id` is minted by the page and is unique per request (prefix `asst-`, so it
// can never collide with page-bridge's own ids). The extension announces the
// capability by listing 'assistant' in `window.__bentoHost.ops`; a host
// without it is treated as absent (the page shows the install sentence and
// sends nothing).
//
// Ops:
//
//   assistant.describe   payload {}                → res { ok:true, host, model, configured, local?, contextTokens? }
//                        host = the endpoint's hostname (never the key, never
//                        the full URL with a query), model = the configured
//                        model id, configured = whether a request could be
//                        made right now. ok:false { reason } only on a bridge
//                        fault. `local: true` = an on-device model (the
//                        browser's own, e.g. `gemini-nano`): host is '' and
//                        the page renders "on this device · <display name>"
//                        itself, from a small id→name map (unknown ids as-is).
//                        `contextTokens` = the model's input window in tokens
//                        when the extension knows it (the provider's model
//                        listing, the Prompt API's inputQuota, or the user's
//                        own number in settings); the page sizes each turn to
//                        it — JSON edit when it fits, a words patch when only
//                        the outline does, a refusal with the numbers when
//                        nothing does. Absent = the page assumes a window by
//                        `local` (small on-device, large hosted).
//   assistant.models     payload {}                → res { ok:true, models: [{ provider, model, host?, local?, contextTokens?, current? }] }
//                        every model the extension could route to RIGHT NOW:
//                        for each provider that has what it needs (a key, or
//                        the on-device model present), its configured model
//                        and its cached listing. The page renders a picker
//                        from it — by SHAPE (provider/model ids, hostname,
//                        window), never a label the bridge chose — and shows
//                        nothing when there is one choice. Optional op: an
//                        older extension answers ok:false and the picker
//                        does not exist.
//   assistant.select     payload { provider, model } → res { ok:true } | { ok:false, reason }
//                        make that the active route (persisted by the
//                        extension in its own storage — the page holds
//                        nothing). The page re-describes and re-checks after.
//   assistant.check      payload {}                → res { ok:true } | { ok:false, reason, code? }
//                        one cheap round-trip to the endpoint (a model list or
//                        an empty completion) so the panel can say "reachable"
//                        before a real turn. `code: 'consent-pending'` = the
//                        extension is asking the user (a local model's
//                        download/consent prompt): the drawer shows waiting
//                        text and re-runs check ONCE when the document regains
//                        focus or visibility. The page keys on CODES, never on
//                        the reason text.
//   assistant.turn       payload { request, history: [{ role:'user'|'assistant', text }] (≤8), focus: { index, selection } }
//                        one conversation turn. The EXTENSION owns the model
//                        knowledge — is it a question or an edit, what the
//                        model's window takes, the prompts, the schema, the
//                        nudge when a small model answers in prose — and the
//                        page owns the document. So the page sends only the
//                        request and where the user is, and:
//                        → res { ok:true }           accepted (consent is asked FIRST — nothing
//                                                     of the document leaves before it holds)
//                        | res { ok:false, reason, code? }   refused (not configured, offline, denied …)
//                        then the extension ASKS for the material:
//                        evt { kind:'assistant.document', id, slide? }
//                        and the page answers on the same id:
//                        req { op:'assistant.document', id, payload: <Material> }
//                        `slide` (1-based) asks for the material with THAT slide as the
//                        focus (its elements in full) instead of the user's selection —
//                        the `slide(n)` tool of an agent loop; absent = the user's focus.
//                        The extension may then CHECK a patch before it commits to it —
//                        the closed loop: a model's first patch is often almost right,
//                        and only the page can say which address did not resolve:
//                        evt { kind:'assistant.check', id, ops }
//                        → req { op:'assistant.check', id, payload: { applied: string[], skipped: string[], structural: boolean,
//                                                                    outline?: string, warnings?: string[] } }
//                        a DRY RUN of ops.ts applyOps on the material's document: what would
//                        land, what would be refused (named as the drawer names them), the
//                        addressed outline as it would read after, and `warnings` — what the
//                        change would BREAK, in the validator's words ("Text needs 457px but
//                        the box is 372px tall — it overflows by 85px…"), fresh ones only —
//                        so a harness can have the model fix it before it lands. Nothing is
//                        committed.
//                        The extension may check as often as it likes; the turn commits only
//                        on `done`.
//                        (material.ts: the plain outline, the addressed
//                        outline, the focus in full — every shape at once;
//                        the extension picks by the model it holds. The
//                        elision map never leaves the page.) Then zero or more
//                        evt { kind:'assistant.chunk', text }        a prose delta (question turns)
//                        and exactly one of
//                        evt { kind:'assistant.done', mode:'ask', text, sources? }
//                        evt { kind:'assistant.done', mode:'edit', ops, note?, focus:'elements'|'slide'|'none', sources? }
//                                                     `sources` = what the model read on the web for this
//                                                     turn (a provider's search grounding, or the fetch
//                                                     tool): [{ title, url }], read by SHAPE — an http(s)
//                                                     url ≤ 2048, a title ≤ 200 chars, at most 20 — and
//                                                     shown as a "Sources" line so a number on a slide can
//                                                     be traced. Never applied to the document.
//                                                     `ops` = the JSON object the model returned, UNTRUSTED —
//                                                     the page applies it through ops.ts and the gate;
//                                                     `note` = a sentence to show (e.g. only the outline fit)
//                        evt { kind:'assistant.done', mode:'edit', text }   the model answered in prose
//                        evt { kind:'assistant.error', reason, code? }  the turn failed; the page shows
//                                                     `reason` verbatim (the extension localizes) and keys
//                                                     behaviour on `code`: 'consent-denied' (deck unchanged),
//                                                     'window' (nothing fit), 'model-download' …
//   assistant.abort      payload { req: <id of the turn> } → res { ok:true }
//                        stop streaming that request; the extension may still
//                        emit a final evt for it, which the page ignores.
//   assistant.settings.open  payload { section? }  → res { ok:true }
//                        open the extension's options page AT that section
//                        ('assistant': the Assistant card, scrolled into view,
//                        the active provider's card open) — endpoint / model /
//                        key live there and only there.
//
// A `res` that does not arrive within REQ_TIMEOUT ms is a bridge fault
// ({ ok:false, reason:'timeout' }); a stream has no timeout of its own — the
// user has Stop.

/** A conversation turn as the page keeps it: text only. */
export interface Turn { role: 'user' | 'assistant'; text: string }

/** A page the model read for this turn. */
export interface Source { title: string; url: string }

/** What a turn resolved to. `ops` is untrusted data for ops.ts. */
export type TurnResult =
  | { mode: 'ask'; text: string; sources?: Source[] }
  | { mode: 'edit'; text: string; sources?: Source[] }
  | { mode: 'edit'; ops: Record<string, unknown>; note?: string; focus: 'elements' | 'slide' | 'none'; sources?: Source[] }

export const SOURCES_MAX = 20
/** the sources on a done frame, by shape; [] when none pass */
export function boundSources(v: unknown): Source[] {
  if (!Array.isArray(v)) return []
  const out: Source[] = []
  for (const s of v.slice(0, SOURCES_MAX)) {
    if (!s || typeof s !== 'object') continue
    const o = s as Record<string, unknown>
    const url = typeof o.url === 'string' && o.url.length <= 2048 && /^https?:\/\/[^\s"'<>]+$/i.test(o.url) ? o.url : null
    if (!url) continue
    let title = typeof o.title === 'string' ? o.title.trim().slice(0, 200) : ''
    if (!title) { try { title = new URL(url).host } catch { title = url } }
    out.push({ title, url })
  }
  return out
}

export interface AssistantDescription {
  /** what the page may show: the endpoint's hostname and the model id */
  host: string
  model: string
  /** could a request be made right now? */
  configured: boolean
  /** an on-device model: no host to name, the page says "on this device" */
  local?: boolean
  /** the model's input window in tokens, when known (bounded 1k–10M) */
  contextTokens?: number
}

export type CheckResult = { ok: true } | { ok: false; reason: string; code?: string }

/** One route the extension can take, as the picker shows it. */
export interface AssistantModel {
  provider: string
  model: string
  host?: string
  local?: boolean
  contextTokens?: number
  current?: boolean
}


/** A failed send. `code` is the machine-readable reason, when the bridge gave one. */
export class AssistantError extends Error {
  code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.name = 'AssistantError'
    if (code) this.code = code
  }
}

/** Machine codes the extension may attach: short, lower-case, dashed. */
export const CODE_RE = /^[a-z][a-z0-9-]{0,39}$/
export const codeOf = (v: unknown): string | undefined => (typeof v === 'string' && CODE_RE.test(v) ? v : undefined)

export interface AssistantTransport {
  /** what the panel names as the route, e.g. 'bento/home extension' */
  readonly name: string
  describe(): Promise<AssistantDescription>
  check(): Promise<CheckResult>
  /** every route available now; [] when the extension has no such op */
  models(): Promise<AssistantModel[]>
  /** make one of them the active route */
  select(provider: string, model: string): Promise<CheckResult>
  /**
   * One conversation turn. `material` is called when the extension asks for
   * the document (after consent); `onChunk` receives prose deltas as they
   * stream; the promise resolves with the turn's result, rejects with an
   * Error whose `name` is 'AbortError' when `signal` fired, or an
   * AssistantError (with `code`) otherwise.
   */
  turn(request: string, history: Turn[], focus: { index: number; selection: string[] }, material: (slide?: number) => Record<string, unknown>, onChunk: (text: string) => void, signal: AbortSignal, check?: (ops: Record<string, unknown>) => Record<string, unknown>): Promise<TurnResult>
  /** ask the host to show where the endpoint and key are configured */
  openSettings(section?: string): Promise<void>
}

/**
 * What `describe` may hand the page: a hostname and a model id, by SHAPE.
 * A hostile bridge could otherwise make the page HOLD a key by smuggling it
 * through `host` — the one field the drawer displays and the only text the
 * page ever keeps from the extension. Anything else becomes ''.
 */
export const HOST_RE = /^[a-z0-9.-]{1,253}$/i
export const MODEL_RE = /^[A-Za-z0-9._:/-]{1,120}$/
export const PROVIDER_RE = /^[a-z][a-z0-9-]{0,39}$/
/** at most this many routes are read from a models listing */
export const MODELS_MAX = 200
const boundTo = (v: unknown, re: RegExp): string => (typeof v === 'string' && re.test(v) ? v : '')
/** A window size the page will believe: a whole number of tokens from 1k to 10M. */
export const CONTEXT_MIN = 1000
export const CONTEXT_MAX = 10_000_000
const boundWindow = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= CONTEXT_MIN && v <= CONTEXT_MAX ? v : undefined

/** The envelope key page-bridge.js / relay.js already use. */
export const CH = '__bento_tray__'
export const REQ_TIMEOUT = 5000

interface HostInfo { name?: string; ops?: unknown }

/** Is a host that speaks the assistant ops injected into this page? */
export function extensionPresent(w: Window = window): boolean {
  const host = (w as unknown as { __bentoHost?: HostInfo }).__bentoHost
  return !!host && Array.isArray(host.ops) && host.ops.includes('assistant')
}

type Frame = { [CH]: true; dir: 'req' | 'res' | 'evt'; id: string; [k: string]: unknown }

const isFrame = (data: unknown): data is Frame =>
  !!data && typeof data === 'object' && (data as Record<string, unknown>)[CH] === true
  && typeof (data as Record<string, unknown>).id === 'string'

let seq = 0
const mintId = () => `asst-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/**
 * The bridge client. Takes the window so a rig can hand it a double that
 * answers frames; production passes the real one.
 */
export class ExtensionTransport implements AssistantTransport {
  readonly name = 'bento/home extension'
  private pending = new Map<string, (result: Record<string, unknown>) => void>()
  private streams = new Map<string, (frame: Frame) => void>()
  private listening = false
  private readonly w: Window

  constructor(w: Window = window) { this.w = w }

  private listen() {
    if (this.listening) return
    this.listening = true
    this.w.addEventListener('message', (ev: MessageEvent) => {
      // Same-window frames only: relay.js posts from the page's own window
      // (an isolated world shares it), and a frame from an iframe or opener
      // is nobody's business here.
      if (ev.source !== this.w) return
      const d = ev.data
      if (!isFrame(d)) return
      if (d.dir === 'res') {
        const cb = this.pending.get(d.id)
        if (cb) { this.pending.delete(d.id); cb((d.result ?? {}) as Record<string, unknown>) }
      } else if (d.dir === 'evt') {
        this.streams.get(d.id)?.(d)
      }
    })
  }

  private request(op: string, payload: Record<string, unknown> = {}, id = mintId()): Promise<Record<string, unknown>> {
    this.listen()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) resolve({ ok: false, reason: 'timeout' })
      }, REQ_TIMEOUT)
      this.pending.set(id, (r) => { clearTimeout(timer); resolve(r) })
      this.w.postMessage({ [CH]: true, dir: 'req', id, op, payload }, '*')
    })
  }

  async describe(): Promise<AssistantDescription> {
    const r = await this.request('assistant.describe')
    if (r.ok !== true) throw new Error(String(r.reason ?? 'bridge fault'))
    return {
      host: boundTo(r.host, HOST_RE),
      model: boundTo(r.model, MODEL_RE),
      configured: r.configured === true,
      ...(r.local === true ? { local: true } : {}),
      ...(boundWindow(r.contextTokens) !== undefined ? { contextTokens: boundWindow(r.contextTokens) } : {}),
    }
  }

  async models(): Promise<AssistantModel[]> {
    const r = await this.request('assistant.models')
    if (r.ok !== true || !Array.isArray(r.models)) return []
    const out: AssistantModel[] = []
    for (const m of (r.models as unknown[]).slice(0, MODELS_MAX)) {
      if (!m || typeof m !== 'object') continue
      const o = m as Record<string, unknown>
      const provider = boundTo(o.provider, PROVIDER_RE)
      const model = boundTo(o.model, MODEL_RE)
      if (!provider || !model) continue
      const host = boundTo(o.host, HOST_RE)
      const win = boundWindow(o.contextTokens)
      out.push({
        provider, model,
        ...(host ? { host } : {}),
        ...(o.local === true ? { local: true } : {}),
        ...(win !== undefined ? { contextTokens: win } : {}),
        ...(o.current === true ? { current: true } : {}),
      })
    }
    return out
  }

  async select(provider: string, model: string): Promise<CheckResult> {
    if (!PROVIDER_RE.test(provider) || !MODEL_RE.test(model)) return { ok: false, reason: 'bad route' }
    const r = await this.request('assistant.select', { provider, model })
    return r.ok === true ? { ok: true } : { ok: false, reason: String(r.reason ?? 'refused') }
  }

  async check(): Promise<CheckResult> {
    const r = await this.request('assistant.check')
    if (r.ok === true) return { ok: true }
    const code = codeOf(r.code)
    return { ok: false, reason: String(r.reason ?? 'unknown'), ...(code ? { code } : {}) }
  }

  turn(request: string, history: Turn[], focus: { index: number; selection: string[] }, material: (slide?: number) => Record<string, unknown>, onChunk: (text: string) => void, signal: AbortSignal, check?: (ops: Record<string, unknown>) => Record<string, unknown>): Promise<TurnResult> {
    this.listen()
    const id = mintId()
    return new Promise<TurnResult>((resolve, reject) => {
      let text = ''
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        this.streams.delete(id)
        signal.removeEventListener('abort', onAbort)
        fn()
      }
      const onAbort = () => {
        void this.request('assistant.abort', { req: id })
        const err = new Error('aborted'); err.name = 'AbortError'
        finish(() => reject(err))
      }
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
      this.streams.set(id, (f) => {
        if (f.kind === 'assistant.document') {
          // the extension asks for the deck (consent holds): answer on the
          // same id. The material is built NOW, from the live document.
          const slide = typeof f.slide === 'number' && Number.isInteger(f.slide) && f.slide >= 1 ? f.slide : undefined
          void this.request('assistant.document', material(slide), id)
        } else if (f.kind === 'assistant.check') {
          // a dry run of a candidate patch, answered on the same id; a
          // frame without an object, or a page without a checker, answers
          // an empty result so the extension is never left waiting
          const ops = f.ops && typeof f.ops === 'object' && !Array.isArray(f.ops) ? f.ops as Record<string, unknown> : {}
          void this.request('assistant.check', check ? check(ops) : { applied: [], skipped: [], structural: false }, id)
        } else if (f.kind === 'assistant.chunk') {
          const t = typeof f.text === 'string' ? f.text : ''
          if (t) { text += t; onChunk(t) }
        } else if (f.kind === 'assistant.done') {
          const whole = typeof f.text === 'string' && f.text ? f.text : text
          const sources = boundSources(f.sources)
          const src = sources.length ? { sources } : {}
          if (f.mode === 'edit' && f.ops && typeof f.ops === 'object' && !Array.isArray(f.ops)) {
            const fs = f.focus === 'elements' || f.focus === 'slide' ? f.focus : 'none'
            finish(() => resolve({ mode: 'edit', ops: f.ops as Record<string, unknown>, focus: fs, ...(typeof f.note === 'string' && f.note ? { note: f.note } : {}), ...src }))
          } else {
            finish(() => resolve(f.mode === 'edit' ? { mode: 'edit', text: whole, ...src } : { mode: 'ask', text: whole, ...src }))
          }
        } else if (f.kind === 'assistant.error') {
          finish(() => reject(new AssistantError(String(f.reason ?? 'request failed'), codeOf(f.code))))
        }
      })
      void this.request('assistant.turn', { request, history: history.slice(-8).map((t) => ({ role: t.role, text: t.text })), focus }, id).then((r) => {
        if (r.ok !== true) finish(() => reject(new AssistantError(String(r.reason ?? 'refused'), codeOf(r.code))))
      })
    })
  }

  async openSettings(section?: string): Promise<void> {
    await this.request('assistant.settings.open', section ? { section } : {})
  }
}
