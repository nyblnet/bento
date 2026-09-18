// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Provider shapers for the assistant. PURE: build a request description from
// chat messages, and parse one SSE stream into text deltas. No fetch, no
// `chrome`, no DOM — the service worker (assistant.js) makes the request, so
// the key never leaves extension storage, and this file runs unchanged in the
// node rig (scripts/test-webext-assistant.ts).
//
// Three HTTP families. Gemini is first-class rather than "OpenAI-compatible
// with another base URL": its compat endpoint drops system instructions and
// streaming details, so the native `streamGenerateContent?alt=sse` is used.
// The Chrome built-in model (Prompt API) is not HTTP and lives in assistant.js.
//
// Every provider takes a base URL (proxies, gateways, local servers); the
// defaults below are the vendors' own. `describeHost` is the ONLY thing the
// page may be told about the endpoint: a base URL can carry a tenant id in
// its path, a hostname cannot.

/** @typedef {'openai'|'anthropic'|'gemini'} Provider */
/** @typedef {{ provider: Provider, baseUrl?: string, model: string, key?: string }} ProviderConfig */
/** @typedef {{ role: 'system'|'user'|'assistant', content: string }} ChatMessage */

const trimSlash = (s) => String(s || '').replace(/\/+$/, '')

/**
 * The value BEFORE the first successful model listing, and nothing more: a
 * hard-coded model name goes stale in a season. Once a key is entered the
 * provider's own list is fetched and `pickDefault` chooses by RULE — the
 * newest general-purpose chat model at the vendor's mid tier — so these only
 * have to be right on the day the key is typed. Mid tier on purpose: cheap
 * and fast is the right default for editing slides; the big one is a pick.
 */
export const DEFAULTS = Object.freeze({
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-3-flash' },
})

/** The input window assumed when nothing — listing, family, the user — says otherwise. */
export const FALLBACK_CONTEXT = 128000

/** The model-list request, keyed like `shapeCheck`. All three vendors have one. */
export function shapeModels(cfg) {
  const base = baseOf(cfg)
  switch (cfg.provider) {
    case 'openai':
      return { method: 'GET', url: `${base}/models`, headers: cfg.key ? { authorization: `Bearer ${cfg.key}` } : {} }
    case 'anthropic':
      return { method: 'GET', url: `${base}/v1/models?limit=1000`, headers: { 'x-api-key': cfg.key || '', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } }
    case 'gemini':
      return { method: 'GET', url: `${base}/v1beta/models?pageSize=1000`, headers: { 'x-goog-api-key': cfg.key || '' } }
    default:
      throw new Error(`unknown provider: ${cfg.provider}`)
  }
}

/**
 * One shape out of three listings: `{ id, created?, contextTokens? }`.
 * OpenAI and Anthropic say when a model was made and nothing about its
 * window; Gemini says the window (`inputTokenLimit`) and nothing about when.
 * Gemini's ids arrive as `models/gemini-…`; the prefix is not part of the id
 * the request URL takes.
 */
export function parseModels(provider, json) {
  const rows = provider === 'gemini' ? json?.models : json?.data
  if (!Array.isArray(rows)) return []
  const out = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    if (provider === 'gemini') {
      if (typeof r.name !== 'string') continue
      const methods = Array.isArray(r.supportedGenerationMethods) ? r.supportedGenerationMethods : []
      if (methods.length && !methods.includes('generateContent')) continue
      const m = { id: r.name.replace(/^models\//, '') }
      if (Number.isFinite(r.inputTokenLimit)) m.contextTokens = r.inputTokenLimit
      out.push(m)
    } else {
      if (typeof r.id !== 'string') continue
      const m = { id: r.id }
      const created = provider === 'anthropic' ? Date.parse(r.created_at) / 1000 : r.created
      if (Number.isFinite(created)) m.created = created
      out.push(m)
    }
  }
  return out
}

/**
 * The input window a model FAMILY is documented with, by id, for the two
 * vendors whose listings do not say. A gateway serving `gpt-4o` is still
 * serving a 128k model, so this is keyed on the id and not on the host.
 * Anything unrecognised gets FALLBACK_CONTEXT; the settings field overrides
 * all of it, which is the answer for a self-hosted server only its owner
 * knows the number for.
 */
export function familyContext(id) {
  const m = String(id || '').toLowerCase()
  if (/^claude-/.test(m)) return 200000
  if (/^gpt-4\.1/.test(m)) return 1047576
  if (/^gpt-5/.test(m)) return 400000
  if (/^gpt-4o|^gpt-4-turbo|^chatgpt-4o/.test(m)) return 128000
  if (/^gpt-4/.test(m)) return 8192
  if (/^gpt-3\.5/.test(m)) return 16385
  if (/^o[134](-|$)/.test(m)) return 200000
  if (/^gemini-/.test(m)) return 1048576
  return FALLBACK_CONTEXT
}

/** What is known about one model's window: the listing first, then the family. */
export function contextOf(id, models) {
  const hit = models?.find((m) => m.id === id)
  return Number.isFinite(hit?.contextTokens) ? hit.contextTokens : familyContext(id)
}

/**
 * The recommended model out of a listing, by RULE: general-purpose chat
 * models only (no audio/image/embedding/realtime/dated snapshots), the
 * vendor's mid tier first — mini over nano and the full model, sonnet over
 * haiku over opus, flash over flash-lite and pro — and the newest of those.
 * "Newest" is `created` where the listing has it and the version number in
 * the id where it does not. Null when nothing qualifies.
 */
export function pickDefault(provider, models) {
  const rules = {
    openai: {
      family: /^gpt-\d/,
      exclude: /audio|realtime|search|transcribe|tts|image|embedding|instruct|codex|chat-latest|-\d{4}-\d{2}-\d{2}$|-\d{4}$/,
      tier: (id) => /-mini(-|$)/.test(id) ? 2 : /-nano(-|$)/.test(id) ? 1 : 0,
    },
    anthropic: {
      family: /^claude-/,
      exclude: /-\d{8}$/,
      tier: (id) => /sonnet/.test(id) ? 2 : /haiku/.test(id) ? 1 : 0,
    },
    gemini: {
      family: /^gemini-\d/,
      exclude: /preview|exp|image|tts|live|audio|embedding|thinking|-8b|learnlm|robotics|computer-use|-\d{3}$/,
      tier: (id) => /flash-lite/.test(id) ? 1 : /flash/.test(id) ? 2 : 0,
    },
  }[provider]
  if (!rules) return null
  const version = (id) => parseFloat((/(\d+(?:\.\d+)?)/.exec(id.replace(/^[a-z]+-/, '')) || [])[1] || '0')
  const ok = (models || []).filter((m) => rules.family.test(m.id) && !rules.exclude.test(m.id))
  ok.sort((a, b) => rules.tier(b.id) - rules.tier(a.id)
    || (b.created ?? 0) - (a.created ?? 0)
    || version(b.id) - version(a.id)
    || a.id.localeCompare(b.id))
  return ok[0]?.id ?? null
}

export const PROVIDERS = Object.freeze(['openai', 'anthropic', 'gemini'])

const baseOf = (cfg) => trimSlash(cfg.baseUrl || DEFAULTS[cfg.provider].baseUrl)

/**
 * What the page may be told: the HOSTNAME the request goes to, never more.
 * Not host:port — the page bounds this to a hostname shape (transport.ts
 * HOST_RE) and blanks anything else, so `localhost:11434` would show as "—".
 * The port is shown where it is useful, in the settings page's own status.
 */
export function describeHost(cfg) {
  try { return new URL(shapeRequest(cfg, [{ role: 'user', content: '' }]).url).hostname } catch { return '' }
}

/** Host and port, for messages a person reads (the settings status line, an unreachable error). */
export function hostPortOf(cfg) {
  try { return new URL(shapeRequest(cfg, [{ role: 'user', content: '' }]).url).host } catch { return '' }
}

/** The origin a runtime host permission would be asked for, or null. */
export function originOf(cfg) {
  try { return new URL(baseOf(cfg)).origin } catch { return null }
}

/** Build the streaming request for one chat turn. */
export function shapeRequest(cfg, messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const turns = messages.filter((m) => m.role !== 'system')
  const base = baseOf(cfg)
  switch (cfg.provider) {
    case 'openai':
      return {
        url: `${base}/chat/completions`,
        headers: {
          'content-type': 'application/json',
          // A local server (Ollama, LM Studio) needs no key; sending an empty
          // bearer would be refused by some of them.
          ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}),
        },
        body: JSON.stringify({ model: cfg.model, stream: true, messages }),
      }
    case 'anthropic':
      return {
        url: `${base}/v1/messages`,
        headers: {
          'content-type': 'application/json',
          'x-api-key': cfg.key || '',
          'anthropic-version': '2023-06-01',
          // The request runs in an extension worker, which the API treats as a
          // browser origin: without this header it refuses CORS outright.
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: cfg.model, max_tokens: 16384, stream: true,
          ...(system ? { system } : {}),
          messages: turns.map((m) => ({ role: m.role, content: m.content })),
        }),
      }
    case 'gemini':
      return {
        url: `${base}/v1beta/models/${encodeURIComponent(cfg.model)}:streamGenerateContent?alt=sse`,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.key || '' },
        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents: turns.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        }),
      }
    default:
      throw new Error(`unknown provider: ${cfg.provider}`)
  }
}

/** A cheap reachability probe (assistant.check): the request to make; 2xx counts as ok. */
export function shapeCheck(cfg) {
  const base = baseOf(cfg)
  switch (cfg.provider) {
    case 'openai':
      return { method: 'GET', url: `${base}/models`, headers: cfg.key ? { authorization: `Bearer ${cfg.key}` } : {} }
    case 'anthropic': {
      const r = shapeRequest(cfg, [{ role: 'user', content: 'ping' }])
      return { method: 'POST', url: r.url, headers: r.headers, body: JSON.stringify({ model: cfg.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }) }
    }
    case 'gemini':
      return { method: 'GET', url: `${base}/v1beta/models/${encodeURIComponent(cfg.model)}`, headers: { 'x-goog-api-key': cfg.key || '' } }
    default:
      throw new Error(`unknown provider: ${cfg.provider}`)
  }
}

/**
 * Pull the text delta out of one SSE `data:` payload. Returns '' for frames
 * that carry no text (role deltas, usage, pings) and null when the stream is
 * finished ([DONE], message_stop, an error frame).
 */
export function deltaFrom(provider, data) {
  if (data === '[DONE]') return null
  let j
  try { j = JSON.parse(data) } catch { return '' }
  if (!j || typeof j !== 'object') return ''
  switch (provider) {
    case 'openai': {
      const c = j.choices?.[0]
      if (!c) return j.error ? null : ''
      const d = c.delta?.content ?? c.text ?? ''
      return typeof d === 'string' ? d : ''
    }
    case 'anthropic': {
      if (j.type === 'message_stop') return null
      if (j.type === 'error') return null
      if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') return String(j.delta.text ?? '')
      return ''
    }
    case 'gemini': {
      const parts = j.candidates?.[0]?.content?.parts
      return Array.isArray(parts) ? parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : ''
    }
    default:
      return ''
  }
}

/**
 * The error text to surface for a non-2xx response body, provider-shaped.
 * Status and the provider's own message — never the URL, the headers or
 * what was sent (security review of #512, item 3).
 */
export function errorFrom(provider, status, body) {
  try {
    const j = JSON.parse(body)
    const m = j.error?.message ?? j.message ?? (typeof j.error === 'string' ? j.error : null)
    if (m) return `HTTP ${status}: ${String(m).slice(0, 200)}`
  } catch { /* not json */ }
  return `HTTP ${status}${body ? `: ${String(body).slice(0, 120)}` : ''}`
}

/**
 * Incremental SSE line parser: feed chunks of the response body, get the
 * `data:` payloads. Handles multi-line data fields, CRLF, and a payload
 * split across chunks (which every provider does).
 */
export class SseParser {
  #buf = ''
  #data = []
  feed(chunk) {
    this.#buf += chunk
    const out = []
    let i
    while ((i = this.#buf.search(/\r?\n/)) >= 0) {
      const line = this.#buf.slice(0, i)
      this.#buf = this.#buf.slice(i + (this.#buf[i] === '\r' ? 2 : 1))
      if (line === '') {
        if (this.#data.length) { out.push(this.#data.join('\n')); this.#data = [] }
      } else if (line.startsWith('data:')) {
        this.#data.push(line.slice(5).replace(/^ /, ''))
      }
      // event:/id:/retry:/comments ignored — none of the three providers needs them
    }
    return out
  }
  /** end of stream: flush a dangling event with no trailing blank line */
  end() {
    const out = this.feed('\n\n')
    if (this.#data.length) { out.push(this.#data.join('\n')); this.#data = [] }
    return out
  }
}

/**
 * Drive one streaming response. `read` yields body text chunks; `onChunk` is
 * called per text delta; resolves with the whole text. The model's text is
 * passed through VERBATIM and never interpreted — no tool calls honoured, no
 * URLs followed. The page treats the reply as data; so does this.
 */
export async function streamReply(provider, read, onChunk) {
  const sse = new SseParser()
  let text = ''
  let done = false
  const take = (payloads) => {
    for (const p of payloads) {
      if (done) return
      const d = deltaFrom(provider, p)
      if (d === null) { done = true; return }
      if (d) { text += d; onChunk(d) }
    }
  }
  for await (const chunk of read) { take(sse.feed(chunk)); if (done) break }
  if (!done) take(sse.end())
  return text
}

/** A fetch body as text chunks, for `streamReply`. */
export async function* iterateBody(body) {
  const reader = body.getReader()
  const dec = new TextDecoder()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      yield dec.decode(value, { stream: true })
    }
    const tail = dec.decode()
    if (tail) yield tail
  } finally {
    reader.releaseLock()
  }
}
