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
//   assistant.describe   payload {}                → res { ok:true, host, model, configured }
//                        host = the endpoint's hostname (never the key, never
//                        the full URL with a query), model = the configured
//                        model id, configured = whether a request could be
//                        made right now. ok:false { reason } only on a bridge
//                        fault.
//   assistant.check      payload {}                → res { ok:true } | { ok:false, reason }
//                        one cheap round-trip to the endpoint (a model list or
//                        an empty completion) so the panel can say "reachable"
//                        before a real turn.
//   assistant.send       payload { messages: [{ role:'system'|'user'|'assistant', content }] }
//                        → res { ok:true }           the request was accepted and is streaming
//                        | res { ok:false, reason }   refused (not configured, offline, bad key …)
//                        then, for an accepted request, zero or more
//                        evt { kind:'assistant.chunk', text }        one delta of reply text
//                        and exactly one of
//                        evt { kind:'assistant.done', text }         the WHOLE reply text
//                        evt { kind:'assistant.error', reason }      the request failed mid-way
//   assistant.abort      payload { req: <id of the send> } → res { ok:true }
//                        stop streaming that request; the extension may still
//                        emit a final evt for it, which the page ignores.
//   assistant.settings.open  payload {}            → res { ok:true }
//                        open the extension's options page (endpoint / model /
//                        key live there and only there).
//
// A `res` that does not arrive within REQ_TIMEOUT ms is a bridge fault
// ({ ok:false, reason:'timeout' }); a stream has no timeout of its own — the
// user has Stop.

export type AssistantRole = 'system' | 'user' | 'assistant'

export interface AssistantMessage {
  role: AssistantRole
  content: string
}

export interface AssistantDescription {
  /** what the page may show: the endpoint's hostname and the model id */
  host: string
  model: string
  /** could a request be made right now? */
  configured: boolean
}

export type CheckResult = { ok: true } | { ok: false; reason: string }

export interface AssistantTransport {
  /** what the panel names as the route, e.g. 'bento/home extension' */
  readonly name: string
  describe(): Promise<AssistantDescription>
  check(): Promise<CheckResult>
  /**
   * One chat turn. `onChunk` receives reply deltas as they stream; the
   * promise resolves with the whole reply text, rejects with an Error whose
   * `name` is 'AbortError' when `signal` fired, or with the reason otherwise.
   */
  send(messages: AssistantMessage[], onChunk: (text: string) => void, signal: AbortSignal): Promise<string>
  /** ask the host to show where the endpoint and key are configured */
  openSettings(): Promise<void>
}

/**
 * What `describe` may hand the page: a hostname and a model id, by SHAPE.
 * A hostile bridge could otherwise make the page HOLD a key by smuggling it
 * through `host` — the one field the drawer displays and the only text the
 * page ever keeps from the extension. Anything else becomes ''.
 */
export const HOST_RE = /^[a-z0-9.-]{1,253}$/i
export const MODEL_RE = /^[A-Za-z0-9._:/-]{1,120}$/
const boundTo = (v: unknown, re: RegExp): string => (typeof v === 'string' && re.test(v) ? v : '')

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
    }
  }

  async check(): Promise<CheckResult> {
    const r = await this.request('assistant.check')
    return r.ok === true ? { ok: true } : { ok: false, reason: String(r.reason ?? 'unknown') }
  }

  send(messages: AssistantMessage[], onChunk: (text: string) => void, signal: AbortSignal): Promise<string> {
    this.listen()
    const id = mintId()
    return new Promise<string>((resolve, reject) => {
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
        if (f.kind === 'assistant.chunk') {
          const t = typeof f.text === 'string' ? f.text : ''
          if (t) { text += t; onChunk(t) }
        } else if (f.kind === 'assistant.done') {
          finish(() => resolve(typeof f.text === 'string' && f.text ? f.text : text))
        } else if (f.kind === 'assistant.error') {
          finish(() => reject(new Error(String(f.reason ?? 'request failed'))))
        }
      })
      void this.request('assistant.send', { messages }, id).then((r) => {
        if (r.ok !== true) finish(() => reject(new Error(String(r.reason ?? 'refused'))))
      })
    })
  }

  async openSettings(): Promise<void> {
    await this.request('assistant.settings.open')
  }
}
