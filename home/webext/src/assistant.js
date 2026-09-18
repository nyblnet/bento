// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The assistant's extension side: the ONLY place the endpoint, the model and
// the key exist, and the only place the request is made.
//
// WHY HERE. A `.bento.html` is a document people mail, copy, share live and
// paste as JSON — every one of those a place a key could leak from. So the
// page (slides/src/editor/assistant/transport.ts is the contract) never holds
// one: it sends text and gets text back, over the same envelope the save
// bridge uses, and everything that could identify an account lives in
// `chrome.storage.local` where no page can read it.
//
// FOUR RULES, from the security review of #512:
//
// 1. WHICH DOCUMENT IS ASKING is read from the sender the browser stamps
//    (`sender.url`, `sender.frameId`), never from the payload — background.js
//    rule 2, applied to a key instead of a file.
// 2. CONSENT IS PER DOCUMENT, not per install. A malicious .html on disk is
//    indistinguishable from a deck, and any page the bridge runs in could
//    otherwise spend the key and read the replies. So the first request from
//    each file opens a prompt naming the file and the host; the answer is
//    remembered per file and revocable in Settings.
// 3. NOTHING SECRET IS ECHOED. `describe` says the host and the model id;
//    errors carry a status and the provider's own message, never the URL,
//    the headers or the body that was sent.
// 4. THE REPLY IS DATA. The model's text is passed through verbatim — no tool
//    calls honoured, no URLs followed on its say-so.
//
// This module is deliberately `chrome`-free: it takes its environment as an
// argument so scripts/test-webext-assistant.ts can drive the real code with a
// fake fetch and a fake storage. background.js supplies the real ones.

import { DEFAULTS, describeHost, shapeRequest, shapeCheck, errorFrom, streamReply, iterateBody, originOf } from './providers.js'

/** `chrome.storage.local` keys. */
export const CONFIG_KEY = 'assistant'
export const ALLOWED_KEY = 'assistantAllowed'

/** Providers in the order Settings offers them; the built-in model first when present. */
export const PROVIDERS = Object.freeze(['builtin', 'gemini', 'anthropic', 'openai'])

/** The port name a streaming turn rides on (relay.js ↔ background.js). */
export const PORT = 'bento-assistant'

/** Page-minted ids for these ops carry this prefix; anything else is not the page. */
export const ID_PREFIX = 'asst-'

const ROLES = new Set(['system', 'user', 'assistant'])

/**
 * The document a request comes from, as the browser reports it — or null when
 * the sender is not a top-frame page with a URL. The hash and query are
 * dropped: they are the page's to change, and the file is the same file.
 */
export function docKeyOf(sender) {
  if (!sender || typeof sender.url !== 'string') return null
  if (sender.frameId !== undefined && sender.frameId !== 0) return null
  try {
    const u = new URL(sender.url)
    if (u.protocol !== 'file:') return null
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch { return null }
}

/** A well-formed `assistant.send` payload, or null. */
export function validMessages(payload) {
  const m = payload?.messages
  if (!Array.isArray(m) || !m.length || m.length > 200) return null
  const out = []
  for (const x of m) {
    if (!x || !ROLES.has(x.role) || typeof x.content !== 'string') return null
    out.push({ role: x.role, content: x.content })
  }
  return out
}

/** The stored configuration with defaults filled in; `provider` decides which. */
export function normalizeConfig(raw, hasBuiltin) {
  const c = raw && typeof raw === 'object' ? raw : {}
  // A saved 'builtin' on a Chrome without the Prompt API (a synced profile,
  // a downgrade) is not a provider that can answer; Gemini is the next default.
  const known = PROVIDERS.includes(c.provider) && (c.provider !== 'builtin' || hasBuiltin)
  const provider = known ? c.provider : (hasBuiltin ? 'builtin' : 'gemini')
  const d = DEFAULTS[provider]
  return {
    provider,
    baseUrl: typeof c.baseUrl === 'string' && c.baseUrl.trim() ? c.baseUrl.trim() : (d?.baseUrl ?? ''),
    model: typeof c.model === 'string' && c.model.trim() ? c.model.trim() : (d?.model ?? ''),
    key: typeof c.key === 'string' ? c.key.trim() : '',
  }
}

/** Could a request be made with this configuration? (The built-in model is asked separately.) */
export function httpConfigured(cfg) {
  if (cfg.provider === 'builtin') return false
  if (!cfg.model) return false
  // A local OpenAI-compatible server needs no key; the hosted vendors do.
  return cfg.provider === 'openai' ? true : !!cfg.key
}

/** What the built-in model can do right now, in the Prompt API's own words. */
export async function builtinAvailability(LanguageModel) {
  if (typeof LanguageModel?.availability !== 'function') return 'unsupported'
  try { return String(await LanguageModel.availability()) } catch { return 'unavailable' }
}

/**
 * `assistant.describe`: the host and the model, and whether a request could
 * be made now. The host is a hostname — `describeHost` — and for the built-in
 * model a word for "this device"; there is no endpoint to name.
 */
export async function describe(cfg, env) {
  if (cfg.provider === 'builtin') {
    const a = await builtinAvailability(env.LanguageModel)
    return { ok: true, host: env.t('asstOnDevice'), model: 'Gemini Nano', configured: a === 'available' }
  }
  return { ok: true, host: describeHost(cfg), model: cfg.model, configured: httpConfigured(cfg) }
}

/** A network failure, in words that name the host and nothing else. */
function unreachable(cfg, env) {
  return env.t('asstUnreachable', describeHost(cfg) || cfg.provider)
}

/** `assistant.check`: one cheap round trip. */
export async function check(cfg, env) {
  if (cfg.provider === 'builtin') {
    const a = await builtinAvailability(env.LanguageModel)
    if (a === 'available') return { ok: true }
    return { ok: false, reason: env.t(a === 'unsupported' || a === 'unavailable' ? 'asstBuiltinUnsupported' : 'asstBuiltinDownload') }
  }
  if (!httpConfigured(cfg)) return { ok: false, reason: env.t('asstNotConfigured') }
  const req = shapeCheck(cfg)
  let r
  try {
    r = await env.fetch(req.url, { method: req.method, headers: req.headers, body: req.body })
  } catch {
    return { ok: false, reason: unreachable(cfg, env) }
  }
  if (r.ok) return { ok: true }
  return { ok: false, reason: errorFrom(cfg.provider, r.status, await r.text().catch(() => '')) }
}

/**
 * One chat turn against the built-in model. The Prompt API takes the history
 * as `initialPrompts` and the newest user message as the prompt; deltas come
 * from `promptStreaming`. Chrome changed that stream from cumulative to
 * delta-per-chunk across versions, so both shapes are accepted: a chunk that
 * repeats everything so far is the cumulative form.
 */
async function runBuiltin(messages, onChunk, signal, env) {
  const LM = env.LanguageModel
  if ((await builtinAvailability(LM)) !== 'available') throw new Error(env.t('asstBuiltinUnsupported'))
  const last = messages[messages.length - 1]
  const history = messages.slice(0, -1)
  const session = await LM.create({ initialPrompts: history, signal })
  let text = ''
  try {
    const stream = session.promptStreaming(last.content, { signal })
    for await (const chunk of stream) {
      const s = String(chunk)
      const delta = text && s.startsWith(text) ? s.slice(text.length) : s
      if (delta) { text += delta; onChunk(delta) }
    }
  } finally {
    try { session.destroy?.() } catch { /* already gone */ }
  }
  return text
}

async function runHttp(cfg, messages, onChunk, signal, env) {
  if (!httpConfigured(cfg)) throw new Error(env.t('asstNotConfigured'))
  const req = shapeRequest(cfg, messages)
  let r
  try {
    r = await env.fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal })
  } catch (e) {
    if (e?.name === 'AbortError') throw e
    throw new Error(unreachable(cfg, env))
  }
  if (!r.ok) throw new Error(errorFrom(cfg.provider, r.status, await r.text().catch(() => '')))
  if (!r.body) throw new Error(errorFrom(cfg.provider, r.status, ''))
  return streamReply(cfg.provider, iterateBody(r.body), onChunk)
}

/**
 * `assistant.send`, once accepted: stream the reply as evt frames. Emits
 * exactly one of `assistant.done` / `assistant.error` — or nothing at all
 * after an abort, which the page has already stopped listening for.
 */
export async function run(cfg, messages, emit, signal, env) {
  try {
    const onChunk = (t) => { if (!signal.aborted) emit('assistant.chunk', { text: t }) }
    const text = cfg.provider === 'builtin'
      ? await runBuiltin(messages, onChunk, signal, env)
      : await runHttp(cfg, messages, onChunk, signal, env)
    if (!signal.aborted) emit('assistant.done', { text })
  } catch (e) {
    if (signal.aborted || e?.name === 'AbortError') return
    emit('assistant.error', { reason: String(e?.message || e) })
  }
}

/** The origin Settings asks site access for, or null for the built-in model. */
export function permissionOriginOf(cfg) {
  return cfg.provider === 'builtin' ? null : originOf(cfg)
}
