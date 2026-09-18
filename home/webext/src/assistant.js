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

import { DEFAULTS, describeHost, hostPortOf, shapeRequest, shapeCheck, shapeModels, parseModels, contextOf, curateModels, errorFrom, streamReply, iterateBody, originOf } from './providers.js'
import { validMaterial, buildMessages, responseSchema, parseReply, isPatch, RETRY_NUDGE, ASSUMED_WINDOW_LOCAL, ASSUMED_WINDOW_HOSTED } from './prompt.js'

/** `chrome.storage.local` keys. */
export const CONFIG_KEY = 'assistant'
export const ALLOWED_KEY = 'assistantAllowed'
/** Model listings, by `modelsKey(cfg)`: `{ at, models }`. Refreshed on Check and Save. */
export const MODELS_KEY = 'assistantModels'
/** The built-in model's input quota, once read: `{ at, tokens }`. */
export const BUILTIN_KEY = 'assistantBuiltin'

/** Providers in the order Settings offers them; the built-in model first when present. */
export const PROVIDERS = Object.freeze(['builtin', 'gemini', 'anthropic', 'openai'])

/** The port name a streaming turn rides on (relay.js ↔ background.js). */
export const PORT = 'bento-assistant'

/** Page-minted ids for these ops carry this prefix; anything else is not the page. */
export const ID_PREFIX = 'asst-'

const ROLES = new Set(['system', 'user', 'assistant'])
const trimSlash = (s) => String(s || '').replace(/\/+$/, '')

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

/** The largest reply schema accepted from the page, in JSON bytes. */
export const SCHEMA_BUDGET = 8192

/**
 * The reply schema in an `assistant.send` payload, or undefined. Data, not
 * code: a plain JSON object under the budget, re-read through JSON so no
 * prototype or function rides along; anything else is dropped and the turn
 * proceeds as prose.
 */
export function validSchema(payload) {
  const s = payload?.schema
  if (!s || typeof s !== 'object' || Array.isArray(s)) return undefined
  let text
  try { text = JSON.stringify(s) } catch { return undefined }
  if (typeof text !== 'string' || text.length > SCHEMA_BUDGET || text[0] !== '{') return undefined
  return JSON.parse(text)
}

/** The stored configuration with defaults filled in; `provider` decides which. */
export function normalizeConfig(raw, hasBuiltin) {
  const c = raw && typeof raw === 'object' ? raw : {}
  // A saved 'builtin' on a Chrome without the Prompt API (a synced profile,
  // a downgrade) is not a provider that can answer; Gemini is the next default.
  const known = PROVIDERS.includes(c.provider) && (c.provider !== 'builtin' || hasBuiltin)
  const provider = known ? c.provider : (hasBuiltin ? 'builtin' : 'gemini')
  const d = DEFAULTS[provider]
  const out = {
    provider,
    baseUrl: typeof c.baseUrl === 'string' && c.baseUrl.trim() ? c.baseUrl.trim() : (d?.baseUrl ?? ''),
    model: typeof c.model === 'string' && c.model.trim() ? c.model.trim() : (d?.model ?? ''),
    key: typeof c.key === 'string' ? c.key.trim() : '',
  }
  // The person's own number for the input window, overriding everything the
  // extension could find out — the answer for a self-hosted server. Absent
  // unless it is a whole number in the range the page accepts.
  const ct = Number(c.contextTokens)
  if (Number.isInteger(ct) && ct >= 1000 && ct <= 10_000_000) out.contextTokens = ct
  // Picker preferences, per provider: the full listing instead of the
  // curated one, and the models actually chosen from the page (newest first).
  if (c.showAll === true) out.showAll = true
  if (Array.isArray(c.pinned)) out.pinned = c.pinned.filter((id) => typeof id === 'string' && MODEL_RE.test(id)).slice(0, 8)
  return out
}

/** How many picked models a provider remembers at the top of its group. */
export const PINNED_MAX = 8

/**
 * The stored shape: `{ active, providers: { [provider]: { baseUrl, model,
 * key, contextTokens } } }` — every provider keeps what was typed for it, so
 * switching (in Settings or from the page's picker) costs no pasted key.
 * The first release stored one flat `{ provider, … }`; that reads as the
 * active provider's entry.
 */
export function storedProviders(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  if (c.providers && typeof c.providers === 'object') {
    return { active: typeof c.active === 'string' ? c.active : '', providers: { ...c.providers } }
  }
  if (typeof c.provider === 'string') {
    const { provider, ...rest } = c
    return { active: provider, providers: { [provider]: rest } }
  }
  return { active: '', providers: {} }
}

/** The active provider's configuration, defaults filled. */
export function activeConfig(raw, hasBuiltin) {
  const st = storedProviders(raw)
  const cfg = normalizeConfig({ provider: st.active, ...(st.providers[st.active] || {}) }, hasBuiltin)
  // `active` may name nothing usable (or nothing at all): normalizeConfig
  // chose the default provider — read THAT provider's stored fields.
  if (cfg.provider !== st.active) return normalizeConfig({ provider: cfg.provider, ...(st.providers[cfg.provider] || {}) }, hasBuiltin)
  return cfg
}

/** A provider's configuration out of the store, defaults filled, whether or not it is active. */
export function providerConfig(raw, provider, hasBuiltin) {
  const st = storedProviders(raw)
  return normalizeConfig({ provider, ...(st.providers[provider] || {}) }, hasBuiltin)
}

/** The store with one provider's fields replaced (and made active when `activate`). */
export function withProvider(raw, cfg, activate = true) {
  const st = storedProviders(raw)
  const { provider, ...fields } = cfg
  st.providers[provider] = fields
  if (activate) st.active = provider
  return st
}

/** The model ids the page accepts (transport.ts MODEL_RE). */
export const MODEL_RE = /^[A-Za-z0-9._:/-]{1,120}$/

/** The most entries `assistant.models` returns; the page reads no more. */
export const MODELS_MAX = 200

/**
 * `assistant.models`: every route that could be taken RIGHT NOW — each
 * provider that has what it needs, its configured model first and then its
 * cached listing (never fetched here: this runs on every describe). The
 * built-in model is listed only when it can answer; the page cannot start
 * a download. Ordered as Settings orders providers.
 */
export async function models(raw, env) {
  const hasBuiltin = typeof env.LanguageModel !== 'undefined'
  const active = activeConfig(raw, hasBuiltin)
  const out = []
  for (const provider of PROVIDERS) {
    const cfg = providerConfig(raw, provider, hasBuiltin)
    if (provider === 'builtin') {
      if ((await builtinAvailability(env.LanguageModel)) !== 'available') continue
      const tokens = cfg.contextTokens || await env.builtinTokens?.()
      out.push({ provider, model: 'gemini-nano', local: true, ...(tokens ? { contextTokens: tokens } : {}), ...(active.provider === 'builtin' ? { current: true } : {}) })
      continue
    }
    if (!httpConfigured(cfg)) continue
    const host = describeHost(cfg)
    const listed = (await env.models?.(cfg)) || []
    // The configured model, then what the person picked before, then the
    // curated listing (or all of it, when Settings says so) — deduplicated.
    const ids = []
    const add = (id) => { if (!ids.includes(id)) ids.push(id) }
    add(cfg.model)
    for (const id of cfg.pinned || []) add(id)
    for (const m of curateModels(provider, listed, { all: cfg.showAll })) add(m.id)
    for (const id of ids) {
      if (out.length >= MODELS_MAX) break
      if (!MODEL_RE.test(id)) continue
      const tokens = contextTokensOf({ ...cfg, model: id, contextTokens: id === cfg.model ? cfg.contextTokens : undefined }, listed)
      out.push({
        provider, model: id, host,
        ...(tokens ? { contextTokens: tokens } : {}),
        ...(active.provider === provider && active.model === id ? { current: true } : {}),
      })
    }
  }
  return out.slice(0, MODELS_MAX)
}

/**
 * `assistant.select`: make a provider+model the active route. Persists that
 * and nothing else — no key changes, no fetch. A model outside the listing
 * is allowed (the free-text field allows it) as long as the provider is
 * configured. Returns the new store, or a reason.
 */
export async function select(raw, payload, env) {
  const provider = payload?.provider
  const model = payload?.model
  if (!PROVIDERS.includes(provider)) return { ok: false, reason: 'unknown provider' }
  if (typeof model !== 'string' || !MODEL_RE.test(model)) return { ok: false, reason: 'bad model id' }
  const hasBuiltin = typeof env.LanguageModel !== 'undefined'
  if (provider === 'builtin') {
    if (!hasBuiltin || (await builtinAvailability(env.LanguageModel)) !== 'available') return { ok: false, reason: env.t('asstBuiltinUnsupported') }
    if (model !== 'gemini-nano') return { ok: false, reason: 'bad model id' }
    return { ok: true, store: withProvider(raw, providerConfig(raw, 'builtin', hasBuiltin)) }
  }
  const cfg = { ...providerConfig(raw, provider, hasBuiltin), model }
  if (!httpConfigured(cfg)) return { ok: false, reason: env.t('asstNotConfigured') }
  // A model chosen from the page floats to the top of its group next time.
  cfg.pinned = [model, ...(cfg.pinned || []).filter((id) => id !== model)].slice(0, PINNED_MAX)
  return { ok: true, store: withProvider(raw, cfg) }
}

/** A token count the way a picker shows it beside a model: 1M, 200k, 6k. */
export function shortTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
  return `${Math.round(n / 1000)}k`
}

/**
 * The rows of the Settings model picker for one provider: the configured
 * model, the pinned picks, then the curated (or full) listing — each with
 * its window as a label — and whether the configured model came from the
 * listing at all (when not, the picker shows it as its own row anyway: an
 * id the person typed is still the model).
 */
export function pickerRows(cfg, listing) {
  const rows = []
  const seen = new Set()
  const add = (id) => {
    if (!id || seen.has(id) || !MODEL_RE.test(id)) return
    seen.add(id)
    const tokens = contextTokensOf({ ...cfg, model: id, contextTokens: id === cfg.model ? cfg.contextTokens : undefined }, listing)
    rows.push({ id, label: tokens ? `${id} · ${shortTokens(tokens)}` : id })
  }
  add(cfg.model)
  for (const id of cfg.pinned || []) add(id)
  for (const m of curateModels(cfg.provider, listing || [], { all: cfg.showAll })) add(m.id)
  return rows
}

/** Where a listing is cached: the provider and the endpoint, never the key. */
export const modelsKey = (cfg) => `${cfg.provider}|${cfg.baseUrl || ''}`

/** Fetch and parse the provider's model list. Throws with a provider-shaped reason. */
export async function listModels(cfg, env) {
  const req = shapeModels(cfg)
  let r
  try {
    r = await env.fetch(req.url, { method: req.method, headers: req.headers })
  } catch {
    throw new Error(env.t('asstUnreachable', hostPortOf(cfg) || cfg.provider))
  }
  if (!r.ok) throw new Error(errorFrom(cfg.provider, r.status, await r.text().catch(() => '')))
  return parseModels(cfg.provider, await r.json())
}

/**
 * The input window to report: the person's override, else the cached
 * listing, else the family table. `models` is the cached list for this
 * provider+endpoint (or nothing).
 */
export function contextTokensOf(cfg, models) {
  if (cfg.contextTokens) return cfg.contextTokens
  return contextOf(cfg.model, models)
}

/**
 * The built-in model's input window. `inputQuota` lives on a SESSION, so one
 * is created and destroyed to read it — cheap once the model is on disk, and
 * cached by the caller. Null when the model cannot answer yet.
 */
export async function builtinContext(LanguageModel) {
  if ((await builtinAvailability(LanguageModel)) !== 'available') return null
  let session
  try {
    session = await LanguageModel.create()
    const q = session?.inputQuota
    return Number.isFinite(q) && q > 0 ? Math.floor(q) : null
  } catch {
    return null
  } finally {
    try { session?.destroy?.() } catch { /* already gone */ }
  }
}

/** Could a request be made with this configuration? (The built-in model is asked separately.) */
export function httpConfigured(cfg) {
  if (cfg.provider === 'builtin') return false
  if (!cfg.model) return false
  // The hosted vendors need a key. An OpenAI-compatible server at some other
  // address (Ollama, LM Studio, a gateway) may not — but api.openai.com
  // itself does, so "no key" only counts once the base URL has been changed.
  if (cfg.key) return true
  return cfg.provider === 'openai' && trimSlash(cfg.baseUrl) !== DEFAULTS.openai.baseUrl
}

/** What the built-in model can do right now, in the Prompt API's own words. */
export async function builtinAvailability(LanguageModel) {
  if (typeof LanguageModel?.availability !== 'function') return 'unsupported'
  try { return String(await LanguageModel.availability()) } catch { return 'unavailable' }
}

/**
 * `assistant.describe`: the host and the model, and whether a request could
 * be made now. NEVER prose: the page bounds `host` to a hostname shape and
 * `model` to an id shape and blanks anything else, so a hostile bridge cannot
 * smuggle a key into the page through them. The built-in model has no
 * endpoint: `host` is empty, `local: true` says why, and the page renders
 * "on this device" in its own language.
 */
export async function describe(cfg, env) {
  if (cfg.provider === 'builtin') {
    const a = await builtinAvailability(env.LanguageModel)
    const tokens = cfg.contextTokens || (a === 'available' ? await env.builtinTokens?.() : null)
    return {
      ok: true, host: '', model: 'gemini-nano', local: true, configured: a === 'available',
      ...(tokens ? { contextTokens: tokens } : {}),
    }
  }
  const tokens = contextTokensOf(cfg, await env.models?.(cfg))
  return { ok: true, host: describeHost(cfg), model: cfg.model, configured: httpConfigured(cfg), ...(tokens ? { contextTokens: tokens } : {}) }
}

/** A network failure, in words that name the host and nothing else. */
function unreachable(cfg, env) {
  return env.t('asstUnreachable', hostPortOf(cfg) || cfg.provider)
}

/**
 * Why the built-in model cannot answer right now, as a code the page keys on
 * and words for the person. 'downloadable' is NOT "no model": nothing starts
 * Chrome's download except `LanguageModel.create()`, which Settings offers as
 * a button — so the words send them there rather than to another provider.
 */
export function builtinProblem(a, t) {
  if (a === 'downloadable') return { code: 'model-download', reason: t('asstBuiltinDownload') }
  if (a === 'downloading') return { code: 'model-downloading', reason: t('asstBuiltinDownloading') }
  return { code: 'model-unavailable', reason: t('asstBuiltinUnsupported') }
}

/** `assistant.check`: one cheap round trip. */
export async function check(cfg, env) {
  if (cfg.provider === 'builtin') {
    const a = await builtinAvailability(env.LanguageModel)
    if (a === 'available') return { ok: true }
    return { ok: false, ...builtinProblem(a, env.t) }
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
async function runBuiltin(messages, onChunk, signal, env, schema) {
  const LM = env.LanguageModel
  const a = await builtinAvailability(LM)
  if (a !== 'available') {
    const p = builtinProblem(a, env.t)
    const e = new Error(p.reason); e.code = p.code
    throw e
  }
  const last = messages[messages.length - 1]
  const history = messages.slice(0, -1)
  const session = await LM.create({ initialPrompts: history, signal })
  let text = ''
  const read = async (opts) => {
    for await (const chunk of session.promptStreaming(last.content, opts)) {
      const s = String(chunk)
      const delta = text && s.startsWith(text) ? s.slice(text.length) : s
      if (delta) { text += delta; onChunk(delta) }
    }
  }
  try {
    // `responseConstraint` (Chrome 137+) makes the model answer in the shape
    // — Nano ignores a prose "answer in JSON". An older Chrome throws on the
    // option before any chunk arrives; then the turn runs unconstrained.
    if (schema) {
      try { await read({ signal, responseConstraint: schema }) } catch (e) {
        if (signal.aborted || text) throw e
        await read({ signal })
      }
    } else {
      await read({ signal })
    }
  } finally {
    try { session.destroy?.() } catch { /* already gone */ }
  }
  return text
}

async function runHttp(cfg, messages, onChunk, signal, env, schema) {
  if (!httpConfigured(cfg)) throw new Error(env.t('asstNotConfigured'))
  const post = async (opts) => {
    const req = shapeRequest(cfg, messages, opts)
    try {
      return await env.fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal })
    } catch (e) {
      if (e?.name === 'AbortError') throw e
      throw new Error(unreachable(cfg, env))
    }
  }
  let r = await post({ schema })
  if (!r.ok) {
    let body = await r.text().catch(() => '')
    // An OpenAI-compatible server that does not know `response_format` says
    // so with a 400; the turn is worth more than the constraint, so once
    // more without it. Only that: any other refusal is reported as is.
    if (schema && cfg.provider === 'openai' && r.status === 400 && /response_format|json_schema/i.test(body)) {
      r = await post({})
      if (!r.ok) body = await r.text().catch(() => '')
    }
    if (!r.ok) throw new Error(errorFrom(cfg.provider, r.status, body))
  }
  if (!r.body) throw new Error(errorFrom(cfg.provider, r.status, ''))
  return streamReply(cfg.provider, iterateBody(r.body), onChunk)
}

/**
 * `assistant.send`, once accepted: stream the reply as evt frames. Emits
 * exactly one of `assistant.done` / `assistant.error` — or nothing at all
 * after an abort, which the page has already stopped listening for.
 */
export async function run(cfg, messages, emit, signal, env, schema) {
  try {
    const onChunk = (t) => { if (!signal.aborted) emit('assistant.chunk', { text: t }) }
    const text = cfg.provider === 'builtin'
      ? await runBuiltin(messages, onChunk, signal, env, schema)
      : await runHttp(cfg, messages, onChunk, signal, env, schema)
    if (!signal.aborted) emit('assistant.done', { text })
  } catch (e) {
    if (signal.aborted || e?.name === 'AbortError') return
    emit('assistant.error', { reason: String(e?.message || e), ...(e?.code ? { code: e.code } : {}) })
  }
}

/** One completion, streamed: the text, or a throw with the provider's reason (and a code when there is one). */
async function complete(cfg, messages, onChunk, signal, env, schema) {
  return cfg.provider === 'builtin'
    ? runBuiltin(messages, onChunk, signal, env, schema)
    : runHttp(cfg, messages, onChunk, signal, env, schema)
}

/** A well-formed `assistant.turn` payload, or null. */
export function validTurn(payload) {
  if (!payload || typeof payload !== 'object') return null
  const request = typeof payload.request === 'string' ? payload.request.trim() : ''
  if (!request || request.length > 20000) return null
  const history = Array.isArray(payload.history)
    ? payload.history.filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string').map((t) => ({ role: t.role, text: t.text })).slice(-16)
    : []
  const f = payload.focus && typeof payload.focus === 'object' ? payload.focus : {}
  const focus = {
    index: Number.isInteger(f.index) && f.index >= 0 ? f.index : 0,
    selection: Array.isArray(f.selection) ? f.selection.filter((x) => typeof x === 'string').slice(0, 200) : [],
  }
  return { request, history, focus }
}

/** The input window a turn is sized to: what describe would report, else the assumption by kind. */
export async function windowFor(cfg, env) {
  if (cfg.contextTokens) return cfg.contextTokens
  if (cfg.provider === 'builtin') return (await env.builtinTokens?.()) || ASSUMED_WINDOW_LOCAL
  return contextTokensOf(cfg, await env.models?.(cfg)) || ASSUMED_WINDOW_HOSTED
}

/**
 * `assistant.turn`, once accepted and consented: ask the page for the
 * material, size it to the model, run the turn, and hand back prose or an
 * ops patch. `io.document()` resolves with the page's answer to
 * `assistant.document`; `emit` sends evt frames. Exactly one of done /
 * error, or nothing after an abort.
 *
 * An EDIT that comes back as prose gets ONE nudge (RETRY_NUDGE) as a
 * follow-up turn before it is handed over as text — a small model that was
 * shown the schema in prose sometimes needs telling twice.
 */
export async function runTurn(cfg, turn, io, emit, signal, env) {
  try {
    const window = await windowFor(cfg, env)
    const material = validMaterial(await io.document())
    if (signal.aborted) return
    if (!material) return emit('assistant.error', { code: 'document', reason: env.t('asstNoDocument') })
    const built = buildMessages(material, turn.history, turn.request, window)
    if (!built.fits) {
      return emit('assistant.error', { code: 'window', reason: env.t('asstWindow', built.contextTokens.toLocaleString(), window.toLocaleString()) })
    }
    const schema = responseSchema(built.mode, built.focus)
    if (built.mode === 'ask') {
      const text = await complete(cfg, built.messages, (t) => { if (!signal.aborted) emit('assistant.chunk', { text: t }) }, signal, env, undefined)
      if (!signal.aborted) emit('assistant.done', { mode: 'ask', text })
      return
    }
    let text = await complete(cfg, built.messages, () => {}, signal, env, schema)
    env.log?.('[bento/home assistant] reply', cfg.provider, cfg.model, text)
    // An object with none of the op keys — `{}` from a model that hollowed
    // the schema, or an unrelated object — is not a patch; it is shown as
    // what the model said, never applied as nothing.
    let parsed = parseReply(text)
    if (parsed.kind === 'json' && !isPatch(parsed.value)) parsed = { kind: 'text', text: text.trim() }
    if (parsed.kind === 'text' && !signal.aborted) {
      const again = [...built.messages, { role: 'assistant', content: text }, { role: 'user', content: RETRY_NUDGE }]
      text = await complete(cfg, again, () => {}, signal, env, schema)
      env.log?.('[bento/home assistant] reply after nudge', cfg.provider, cfg.model, text)
      parsed = parseReply(text)
      if (parsed.kind === 'json' && !isPatch(parsed.value)) parsed = { kind: 'text', text: text.trim() }
    }
    if (signal.aborted) return
    const outlineOnly = built.focus === 'none' ? env.t('asstOutlineOnly') : ''
    if (parsed.kind === 'json') {
      const note = [outlineOnly, parsed.note].filter(Boolean).join(' ')
      emit('assistant.done', { mode: 'edit', ops: parsed.value, note, focus: built.focus })
    } else {
      emit('assistant.done', { mode: 'edit', text: parsed.text, ...(outlineOnly ? { note: outlineOnly } : {}) })
    }
  } catch (e) {
    if (signal.aborted || e?.name === 'AbortError') return
    emit('assistant.error', { reason: String(e?.message || e), ...(e?.code ? { code: e.code } : {}) })
  }
}

/** The origin Settings asks site access for, or null for the built-in model. */
export function permissionOriginOf(cfg) {
  return cfg.provider === 'builtin' ? null : originOf(cfg)
}
