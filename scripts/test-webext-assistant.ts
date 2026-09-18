#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// home/webext assistant rig.
//
//   node scripts/test-webext-assistant.ts
//
// WHAT THIS PROVES. The assistant is extension-only: the page holds no key,
// so the property that decides the feature is what the EXTENSION accepts and
// what it says back (security review of #512, §4). Four things, each pinned
// here against the files that ship:
//
//   1. Only the top document's own scripts can start a turn — a frame posted
//      from an iframe (a live web embed on a slide) is dropped by relay.js.
//   2. Consent is per DOCUMENT: a file that has not been allowed gets a prompt,
//      and nothing but the extension's own consent page can answer it.
//   3. Nothing secret is echoed: describe is host + model, errors are status +
//      the provider's message, never the URL, the key or what was sent.
//   4. An abort reaches only the turn its own tab started.
//
// Plus the provider layer (request shapes, SSE parsing, streaming) — pure
// functions the slides side wrote the cases for and the extension now owns.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'home/webext')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick() }

// A `chrome` just real enough for background.js to load and for the assistant
// wiring to run against. Installed BEFORE the import: the module reads it at
// load to decide whether to attach listeners (it must not, here — there is no
// onMessage), and at call time for storage, windows and the runtime.
const store: Record<string, unknown> = {}
const windowsOpened: string[] = []
let optionsOpened = 0
const EXT = 'chrome-extension://ext-id/'
;(globalThis as any).chrome = {
  runtime: {
    id: 'ext-id',
    getURL: (p: string) => EXT + p,
    openOptionsPage: async () => { optionsOpened++ },
    getManifest: () => ({ version: '0.0.0' }),
  },
  storage: {
    local: {
      get: async (k: string) => ({ [k]: store[k] }),
      set: async (o: Record<string, unknown>) => { Object.assign(store, o) },
    },
  },
  windows: { create: async (o: { url: string }) => { windowsOpened.push(o.url) } },
}

const providers = await import('../home/webext/src/providers.js')
const asst = await import('../home/webext/src/assistant.js')
const bg = await import('../home/webext/src/background.js')
const { shapeRequest, shapeCheck, deltaFrom, errorFrom, SseParser, streamReply, describeHost } = providers

console.log('\n— providers: request shapes')
const msgs = [
  { role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'yo' }, { role: 'user', content: 'again' },
] as const
{
  const r = shapeRequest({ provider: 'openai', baseUrl: 'https://api.openai.com/v1/', model: 'm', key: 'K' }, [...msgs])
  ok(r.url === 'https://api.openai.com/v1/chat/completions', 'openai: trailing slash on the base is not doubled')
  ok(r.headers.authorization === 'Bearer K', 'openai: bearer header')
  const b = JSON.parse(r.body)
  ok(b.stream === true && b.messages.length === 4 && b.messages[0].role === 'system', 'openai: system stays a message, stream on')
  ok(describeHost({ provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'm', key: 'K' }) === 'localhost', 'describeHost: hostname only — the page blanks a host:port (HOST_RE)')
  ok(providers.hostPortOf({ provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'm', key: 'K' }) === 'localhost:11434', 'hostPortOf: host and port, for words a person reads')
  const local = shapeRequest({ provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'm', key: '' }, [...msgs])
  ok(!('authorization' in local.headers), 'openai: no key → no bearer header (a local server would refuse an empty one)')
}
{
  const r = shapeRequest({ provider: 'anthropic', model: 'm', key: 'K' }, [...msgs])
  ok(r.url === 'https://api.anthropic.com/v1/messages', 'anthropic: the vendor endpoint by default')
  ok(r.headers['x-api-key'] === 'K' && r.headers['anthropic-version'] === '2023-06-01', 'anthropic: key header + version')
  const b = JSON.parse(r.body)
  ok(b.system === 'SYS' && b.messages.length === 3 && b.messages.every((m: any) => m.role !== 'system'), 'anthropic: system lifted out of messages')
  ok(b.max_tokens >= 8192, 'anthropic: max_tokens large enough for a deck')
  const proxied = shapeRequest({ provider: 'anthropic', baseUrl: 'https://gw.example/anthropic/', model: 'm', key: 'K' }, [...msgs])
  ok(proxied.url === 'https://gw.example/anthropic/v1/messages', 'anthropic: base URL editable (proxies)')
}
{
  const r = shapeRequest({ provider: 'gemini', model: 'gemini-2.5-flash', key: 'K' }, [...msgs])
  ok(r.url.endsWith('/models/gemini-2.5-flash:streamGenerateContent?alt=sse') && r.headers['x-goog-api-key'] === 'K', 'gemini: native streaming endpoint + key header')
  const b = JSON.parse(r.body)
  ok(b.systemInstruction.parts[0].text === 'SYS' && b.contents.length === 3 && b.contents[1].role === 'model', 'gemini: systemInstruction; assistant → model')
  ok(!r.url.includes('K') && !JSON.stringify(b).includes('K'), 'gemini: the key is a header, never in the URL or body')
}
{
  ok(shapeCheck({ provider: 'openai', baseUrl: 'https://x/v1', model: 'm', key: 'K' }).url === 'https://x/v1/models', 'check: openai lists models')
  ok(shapeCheck({ provider: 'gemini', model: 'g', key: 'K' }).method === 'GET', 'check: gemini GETs the model')
  ok(JSON.parse(shapeCheck({ provider: 'anthropic', model: 'm', key: 'K' }).body!).max_tokens === 1, 'check: anthropic sends a 1-token message')
}

console.log('\n— providers: listings, windows and the default by rule')
{
  const { shapeModels, parseModels, familyContext, contextOf, pickDefault, DEFAULTS } = providers
  ok(shapeModels({ provider: 'openai', baseUrl: 'https://x/v1', key: 'K' }).url === 'https://x/v1/models', 'models: openai GET /models')
  ok(shapeModels({ provider: 'anthropic', key: 'K' }).headers['anthropic-version'] === '2023-06-01', 'models: anthropic listing carries the version header')
  ok(shapeModels({ provider: 'gemini', key: 'K' }).url.includes('/v1beta/models'), 'models: gemini GET /v1beta/models')
  const oa = parseModels('openai', { data: [{ id: 'gpt-4o-mini', created: 1 }, { id: 'gpt-5-mini', created: 5 }, { id: 'gpt-5', created: 5 }, { id: 'gpt-5-nano', created: 6 }, { id: 'gpt-5-mini-2026-01-01', created: 9 }, { id: 'gpt-4o-audio-preview', created: 9 }, { id: 'o3-mini', created: 8 }, { bogus: true }] })
  ok(oa.length === 7 && oa[0].created === 1, 'parseModels: openai rows → {id, created}; junk dropped')
  ok(pickDefault('openai', oa) === 'gpt-5-mini', 'pickDefault openai: newest mini, not nano, not a dated snapshot, not audio')
  const an = parseModels('anthropic', { data: [{ id: 'claude-opus-5', created_at: '2026-05-01T00:00:00Z' }, { id: 'claude-sonnet-4-5', created_at: '2025-09-29T00:00:00Z' }, { id: 'claude-sonnet-5', created_at: '2026-04-01T00:00:00Z' }, { id: 'claude-haiku-4-5', created_at: '2026-04-02T00:00:00Z' }] })
  ok(pickDefault('anthropic', an) === 'claude-sonnet-5', 'pickDefault anthropic: newest sonnet over a newer opus')
  const ge = parseModels('gemini', { models: [{ name: 'models/gemini-2.5-flash', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-3-pro', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-3-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-3-flash-lite', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-3-flash-preview', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] }] })
  ok(ge.length === 5 && ge[0].id === 'gemini-2.5-flash' && ge[0].contextTokens === 1048576, 'parseModels: gemini strips models/, keeps inputTokenLimit, drops non-chat')
  ok(pickDefault('gemini', ge) === 'gemini-3-flash', 'pickDefault gemini: highest version flash, not lite/pro/preview')
  ok(pickDefault('openai', []) === null && pickDefault('nope', oa) === null, 'pickDefault: nothing qualifies → null')
  ok(familyContext('claude-sonnet-5') === 200000 && familyContext('gpt-4.1-mini') === 1047576 && familyContext('gpt-5-mini') === 400000 && familyContext('o3') === 200000 && familyContext('llama3.2') === 128000, 'familyContext: the documented windows by id, 128k for the unknown')
  ok(contextOf('gemini-2.5-flash', ge) === 1048576 && contextOf('claude-sonnet-5', an) === 200000, 'contextOf: the listing when it says, the family when it does not')
  for (const p of ['openai', 'anthropic', 'gemini'] as const) ok(pickDefault(p, [{ id: DEFAULTS[p].model, created: 1 }]) === DEFAULTS[p].model, `DEFAULTS.${p} is itself a mid-tier pick by the rule`)
  ok(DEFAULTS.openai.model === 'gpt-5.6-luna' && DEFAULTS.anthropic.model === 'claude-sonnet-5' && DEFAULTS.gemini.model === 'gemini-3.8-flash', 'DEFAULTS are the ids the maintainer named (pre-listing stopgap)')
  const { modelVersion } = providers
  ok(modelVersion('gpt-5.6-luna') === 5.6 && modelVersion('gemini-3.8-flash') === 3.8 && modelVersion('claude-sonnet-4-5') === 4.5 && modelVersion('gpt-4o-mini') === 4 && modelVersion('o3-mini') === 3 && modelVersion('nano') === 0, 'modelVersion: the number anywhere in the id, as a float')
  // The maintainer's synthetic listing: the newest mid tier wins in every family.
  const today = (ids: string[]) => ids.map((id) => ({ id, created: 1 }))
  ok(pickDefault('openai', today(['gpt-5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5-mini'])) === 'gpt-5.6-luna', 'pickDefault openai: gpt-5.6-luna (mid tier of the 5.6 line) over gpt-5, gpt-5-mini and sol')
  ok(pickDefault('openai', today(['gpt-5', 'gpt-5.6-sol'])) === 'gpt-5.6-sol', 'pickDefault openai: with only sol listed, the newer full model still beats the old one')
  ok(pickDefault('gemini', today(['gemini-3-flash', 'gemini-3.8-flash', 'gemini-3.8-pro']).map(({ id }) => ({ id }))) === 'gemini-3.8-flash', 'pickDefault gemini: 3.8 flash above 3 flash and 3.8 pro')
  ok(pickDefault('anthropic', today(['claude-sonnet-5', 'claude-opus-5', 'claude-sonnet-4-5'])) === 'claude-sonnet-5', 'pickDefault anthropic: sonnet 5 above sonnet 4.5 and opus 5')
  ok(familyContext('gpt-5.6-luna') === 400000 && familyContext('gemini-3.8-flash') === 1048576 && familyContext('claude-opus-5') === 200000, 'familyContext covers the 5.6 / 3.8 / 5 lines')
}
console.log('\n— providers: deltas and errors')
ok(deltaFrom('openai', '{"choices":[{"delta":{"content":"He"}}]}') === 'He', 'openai delta')
ok(deltaFrom('openai', '{"choices":[{"delta":{"role":"assistant"}}]}') === '', 'openai role frame → empty')
ok(deltaFrom('openai', '[DONE]') === null, 'openai [DONE] → finished')
ok(deltaFrom('anthropic', '{"type":"content_block_delta","delta":{"type":"text_delta","text":"llo"}}') === 'llo', 'anthropic text_delta')
ok(deltaFrom('anthropic', '{"type":"message_start"}') === '' && deltaFrom('anthropic', '{"type":"ping"}') === '', 'anthropic non-text frames → empty')
ok(deltaFrom('anthropic', '{"type":"message_stop"}') === null, 'anthropic message_stop → finished')
ok(deltaFrom('gemini', '{"candidates":[{"content":{"parts":[{"text":"Hi "},{"text":"there"}]}}]}') === 'Hi there', 'gemini: parts joined')
ok(deltaFrom('gemini', '{"usageMetadata":{}}') === '', 'gemini usage frame → empty')
ok(deltaFrom('openai', 'not json') === '', 'garbage → empty, not a throw')
ok(errorFrom('openai', 401, '{"error":{"message":"Incorrect API key"}}') === 'HTTP 401: Incorrect API key', 'openai error message')
ok(errorFrom('anthropic', 400, '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens"}}').startsWith('HTTP 400: max_tokens'), 'anthropic error message')
ok(errorFrom('gemini', 403, '{"error":{"code":403,"message":"API key not valid"}}') === 'HTTP 403: API key not valid', 'gemini error message')
ok(errorFrom('openai', 502, '<html>bad gateway</html>') === 'HTTP 502: <html>bad gateway</html>', 'non-json body → status + head of body')

console.log('\n— providers: SSE')
{
  const p = new SseParser()
  ok(p.feed('data: {"a":1}\n\n').length === 1, 'one event')
  ok(p.feed('data: {"a":').length === 0 && p.feed('2}\n\ndata: x\n').length === 1, 'a payload split across chunks completes')
  ok(p.end()[0] === 'x', 'end flushes a dangling event')
  const q = new SseParser()
  ok(q.feed('event: message\r\ndata: a\r\ndata: b\r\n\r\n')[0] === 'a\nb', 'CRLF and multi-line data')
  ok(q.feed(': comment\n\n').length === 0, 'comments ignored')
}
{
  async function* chunks(s: string, n = 7) { for (let i = 0; i < s.length; i += n) yield s.slice(i, i + n) }
  const openai = 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\ndata: {"choices":[{"delta":{"content":"LATE"}}]}\n\n'
  const got: string[] = []
  ok(await streamReply('openai', chunks(openai), (t: string) => got.push(t)) === 'Hello' && got.join('|') === 'Hel|lo', 'openai stream: deltas in order, nothing after [DONE]')
  const anthropic = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"A"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"B"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
  ok(await streamReply('anthropic', chunks(anthropic, 5), () => {}) === 'AB', 'anthropic stream')
  const gemini = 'data: {"candidates":[{"content":{"parts":[{"text":"x"}]}}]}\r\n\r\ndata: {"candidates":[{"content":{"parts":[{"text":"y"}]},"finishReason":"STOP"}],"usageMetadata":{}}\r\n\r\n'
  ok(await streamReply('gemini', chunks(gemini, 3), () => {}) === 'xy', 'gemini stream, CRLF, no trailing [DONE]')
}

// ---------------------------------------------------------------------------
console.log('\n— assistant.js: who is asking, and what is said back')
const t = (k: string, ...s: unknown[]) => [k, ...s].join('|')
const KEY = 'sk-SECRET-KEY-VALUE'
const TENANT = 'tenant-4711'
const cfgOpenai = asst.normalizeConfig({ provider: 'openai', baseUrl: `https://gw.example/${TENANT}/v1`, model: 'm', key: KEY }, false)

{
  const c = asst.normalizeConfig({ provider: 'openai', model: 'm', contextTokens: 200000 }, false)
  ok(c.contextTokens === 200000, 'normalizeConfig: a whole number in range is kept as the override')
  ok(asst.normalizeConfig({ provider: 'openai', model: 'm', contextTokens: '200000' }, false).contextTokens === 200000, 'normalizeConfig: the settings field\'s string becomes the NUMBER the page requires')
  for (const bad of [999, 10_000_001, 1.5, NaN, undefined, '', 'lots'] as const) {
    ok(!('contextTokens' in asst.normalizeConfig({ provider: 'openai', model: 'm', contextTokens: bad as any }, false)), `normalizeConfig: ${JSON.stringify(bad)} is not an override`)
  }
  ok(asst.contextTokensOf(c, [{ id: 'm', contextTokens: 8000 }]) === 200000, 'contextTokensOf: the override beats the listing')
  ok(asst.contextTokensOf(asst.normalizeConfig({ provider: 'openai', model: 'm' }, false), [{ id: 'm', contextTokens: 8000 }]) === 8000, 'contextTokensOf: the listing beats the family')
  const d = await asst.describe(asst.normalizeConfig({ provider: 'gemini', model: 'gemini-2.5-flash', key: 'K' }, false), { t, models: async () => [{ id: 'gemini-2.5-flash', contextTokens: 1048576 }] })
  ok(d.contextTokens === 1048576, 'describe: reports the cached listing\'s window')
  const b = await asst.describe({ provider: 'builtin' } as any, { t, LanguageModel: { availability: async () => 'available' }, builtinTokens: async () => 6144 })
  ok(b.contextTokens === 6144 && b.local === true, 'describe: the built-in model reports its inputQuota')
  const nb = await asst.describe({ provider: 'builtin' } as any, { t, LanguageModel: { availability: async () => 'downloadable' }, builtinTokens: async () => 6144 })
  ok(!('contextTokens' in nb), 'describe: no quota claimed while the model cannot answer')
  const q = await asst.builtinContext({ availability: async () => 'available', create: async () => ({ inputQuota: 6144.7, destroy() {} }) })
  ok(q === 6144, 'builtinContext: reads a session\'s inputQuota and destroys the session')
  const listed = await asst.listModels(asst.normalizeConfig({ provider: 'anthropic', model: 'm', key: 'K' }, false), { t, fetch: async () => ({ ok: true, json: async () => ({ data: [{ id: 'claude-sonnet-5', created_at: '2026-04-01T00:00:00Z' }] }) }) })
  ok(listed.length === 1 && listed[0].id === 'claude-sonnet-5', 'listModels: fetches and parses')
  let threw = ''
  await asst.listModels(cfgOpenai, { t, fetch: async () => ({ ok: false, status: 401, text: async () => '{"error":{"message":"bad key"}}' }) }).catch((e: Error) => { threw = e.message })
  ok(threw === 'HTTP 401: bad key', 'listModels: a refused listing is the provider\'s message, nothing else')
}


{
  ok(asst.docKeyOf({ url: 'file:///Users/x/Decks/Q3.bento.html#s2?x=1', frameId: 0 }) === 'file:///Users/x/Decks/Q3.bento.html', 'docKeyOf: the file, without hash or query')
  ok(asst.docKeyOf({ url: 'file:///Users/x/Decks/Q3.bento.html', frameId: 3 }) === null, 'docKeyOf: a sub-frame is not a document')
  ok(asst.docKeyOf({ url: 'https://bento.page/slides/', frameId: 0 }) === null, 'docKeyOf: only file: documents (the content script matches no other)')
  ok(asst.docKeyOf({}) === null && asst.docKeyOf(undefined) === null, 'docKeyOf: no sender, no key')
}
{
  ok(asst.validMessages({ messages: [{ role: 'user', content: 'x' }] })?.length === 1, 'validMessages: the page\'s shape')
  ok(asst.validMessages({ messages: [{ role: 'tool', content: 'x' }] }) === null, 'validMessages: unknown role refused')
  ok(asst.validMessages({ messages: [{ role: 'user', content: 5 }] }) === null, 'validMessages: content must be a string')
  ok(asst.validMessages({ messages: [] }) === null && asst.validMessages({}) === null, 'validMessages: empty or absent refused')
  const extra = asst.validMessages({ messages: [{ role: 'user', content: 'x', provider: 'evil', key: 'k' }] })!
  ok(Object.keys(extra[0]).join() === 'role,content', 'validMessages: nothing but role and content survives — the page cannot name a provider')
}
{
  const c = asst.normalizeConfig(undefined, true)
  ok(c.provider === 'builtin', 'normalizeConfig: the built-in model is the default when Chrome has one')
  ok(asst.normalizeConfig(undefined, false).provider === 'gemini', 'normalizeConfig: otherwise Gemini')
  ok(asst.normalizeConfig({ provider: 'openai' }, false).baseUrl === 'https://api.openai.com/v1', 'normalizeConfig: vendor defaults fill in')
  ok(asst.normalizeConfig({ provider: 'nope', key: 'k' }, false).provider === 'gemini', 'normalizeConfig: an unknown provider falls back')
  ok(asst.normalizeConfig({ provider: 'builtin' }, false).provider === 'gemini', 'normalizeConfig: a saved built-in choice on a Chrome without one falls back too')
  ok(!asst.httpConfigured(asst.normalizeConfig({ provider: 'openai', model: 'm' }, false)), 'httpConfigured: openai at api.openai.com needs a key')
  ok(asst.httpConfigured(asst.normalizeConfig({ provider: 'openai', model: 'm', baseUrl: 'http://localhost:11434/v1' }, false)), 'httpConfigured: an OpenAI-compatible server elsewhere needs none (Ollama, LM Studio)')
  ok(!asst.httpConfigured(asst.normalizeConfig({ provider: 'gemini', model: 'm' }, false)), 'httpConfigured: gemini needs a key')
}
{
  const d = await asst.describe(cfgOpenai, { t })
  ok(d.ok === true && d.host === 'gw.example' && d.model === 'm' && d.configured === true, 'describe: host, model, configured')
  const s = JSON.stringify(d)
  ok(!s.includes(KEY) && !s.includes(TENANT), 'describe: neither the key nor the base URL path leaks')
  ok(Object.keys(d).sort().join() === 'configured,contextTokens,host,model,ok', 'describe: exactly the contract\'s fields')
  ok(d.contextTokens === 128000, 'describe: an unknown model id on an OpenAI-compatible endpoint reports the documented 128k fallback')
  ok(/^[A-Za-z0-9._:/-]{1,120}$/.test(d.model) && /^[A-Za-z0-9.-]+(:\d+)?$/.test(d.host), 'describe: host and model fit the shapes the page bounds them to')
  const b = await asst.describe({ provider: 'builtin' } as any, { t, LanguageModel: { availability: async () => 'available' } })
  ok(b.host === '' && b.model === 'gemini-nano' && b.local === true && b.configured === true,
    'describe: the built-in model is host "" + local:true + an id-shaped model — no prose the page would blank')
  ok(!('local' in d), 'describe: an HTTP provider carries no local flag')
  const nb = await asst.describe({ provider: 'builtin' } as any, { t, LanguageModel: undefined })
  ok(nb.configured === false, 'describe: built-in without the Prompt API is not configured')
}
{
  const calls: any[] = []
  const fetch401 = async (url: string, init: any) => {
    calls.push({ url, init })
    return { ok: false, status: 401, text: async () => '{"error":{"message":"Incorrect API key"}}' }
  }
  const r = await asst.check(cfgOpenai, { t, fetch: fetch401 })
  ok(r.ok === false && r.reason === 'HTTP 401: Incorrect API key', 'check: the provider\'s message and status')
  ok(!r.reason.includes(TENANT) && !r.reason.includes(KEY), 'check: the reason names neither the URL nor the key')
  ok(calls[0].init.headers.authorization === `Bearer ${KEY}`, 'check: the key went in the header of the real request')
  const down = await asst.check(cfgOpenai, { t, fetch: async () => { throw new TypeError('Failed to fetch') } })
  ok(down.ok === false && down.reason === 'asstUnreachable|gw.example', 'check: a network failure names the host only')
  const local = asst.normalizeConfig({ provider: 'openai', baseUrl: 'http://127.0.0.1:8765/v1', model: 'm' }, false)
  ok((await asst.describe(local, { t })).host === '127.0.0.1', 'describe: a port-bearing endpoint is reported as its hostname')
  ok((await asst.check(local, { t, fetch: async () => { throw new TypeError('x') } })).reason === 'asstUnreachable|127.0.0.1:8765', 'but the unreachable reason keeps the port, which is what the person needs')
  const unset = await asst.check(asst.normalizeConfig({ provider: 'gemini', model: 'g' }, false), { t, fetch: fetch401 })
  ok(unset.ok === false && unset.reason === 'asstNotConfigured' && calls.length === 1, 'check: unconfigured → no request at all')
}

/** A streaming body: the provider's SSE bytes, chunked. */
const sseBody = (text: string, n = 9) => {
  const enc = new TextEncoder()
  let i = 0
  return {
    getReader: () => ({
      read: async () => (i >= text.length ? { done: true, value: undefined } : { done: false, value: enc.encode(text.slice(i, (i += n))) }),
      releaseLock() {},
    }),
  }
}
const openaiSse = 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n'

{
  const frames: any[] = []
  const emit = (kind: string, x: any) => frames.push({ kind, ...x })
  const ac = new AbortController()
  await asst.run(cfgOpenai, [{ role: 'user', content: 'hi' }], emit, ac.signal, {
    t, fetch: async () => ({ ok: true, status: 200, body: sseBody(openaiSse) }),
  })
  ok(frames.map((f) => f.kind).join() === 'assistant.chunk,assistant.chunk,assistant.done', 'run: chunks then exactly one done')
  ok(frames[2].text === 'Hello', 'run: done carries the whole text')
}
{
  const frames: any[] = []
  const ac = new AbortController()
  await asst.run(cfgOpenai, [{ role: 'user', content: 'hi' }], (k: string, x: any) => frames.push({ kind: k, ...x }), ac.signal, {
    t, fetch: async () => ({ ok: false, status: 429, body: null, text: async () => '{"error":{"message":"rate limited"}}' }),
  })
  ok(frames.length === 1 && frames[0].kind === 'assistant.error' && frames[0].reason === 'HTTP 429: rate limited', 'run: a refused request is one error frame')
}
{
  const frames: any[] = []
  const ac = new AbortController()
  await asst.run(cfgOpenai, [{ role: 'user', content: 'hi' }], (k: string, x: any) => {
    frames.push({ kind: k, ...x })
    ac.abort() // stop on the first delta
  }, ac.signal, { t, fetch: async () => ({ ok: true, status: 200, body: sseBody(openaiSse) }) })
  ok(frames.length === 1 && frames[0].kind === 'assistant.chunk', 'run: after an abort nothing more is emitted — no done, no error')
}
{
  // 'downloadable' is not "no model": only LanguageModel.create() starts
  // Chrome's download, and Settings has the button for it — so check and
  // send must point there, with a code the page can key on, and never say
  // "no built-in model" on a Chrome that has one.
  const LMstate = (a: string) => ({ availability: async () => a, create: async () => { throw new Error('must not be called from a turn') } })
  for (const [a, code, reason] of [['downloadable', 'model-download', 'asstBuiltinDownload'], ['downloading', 'model-downloading', 'asstBuiltinDownloading'], ['unavailable', 'model-unavailable', 'asstBuiltinUnsupported']] as const) {
    const c = await asst.check({ provider: 'builtin' } as any, { t, LanguageModel: LMstate(a) })
    ok(c.ok === false && c.code === code && c.reason === reason, `check (built-in, ${a}): code ${code} + the matching words`)
    const frames: any[] = []
    await asst.run({ provider: 'builtin' } as any, [{ role: 'user', content: 'hi' }], (k: string, x: any) => frames.push({ kind: k, ...x }), new AbortController().signal, { t, LanguageModel: LMstate(a) })
    ok(frames.length === 1 && frames[0].kind === 'assistant.error' && frames[0].code === code && frames[0].reason === reason, `send (built-in, ${a}): one error frame with the same code`)
  }
  ok(/LanguageModel\.create\(\{\s*monitor/.test(read('src/home.js')) && /downloadprogress/.test(read('src/home.js')), 'Settings starts the download with create({monitor}) and shows progress')
}
{
  // The built-in model: both stream shapes Chrome has shipped.
  const session = (chunks: string[]) => ({
    promptStreaming: () => ({ [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c } }),
    destroy() {},
  })
  const LM = (chunks: string[]) => ({ availability: async () => 'available', create: async () => session(chunks) })
  for (const [label, chunks] of [['delta', ['Hel', 'lo']], ['cumulative', ['Hel', 'Hello']]] as const) {
    const frames: any[] = []
    await asst.run({ provider: 'builtin' } as any, [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }],
      (k: string, x: any) => frames.push({ kind: k, ...x }), new AbortController().signal, { t, LanguageModel: LM([...chunks]) })
    ok(frames.at(-1)?.kind === 'assistant.done' && frames.at(-1)?.text === 'Hello'
      && frames.filter((f) => f.kind === 'assistant.chunk').map((f) => f.text).join('|') === 'Hel|lo',
      `run (built-in, ${label} chunks): Hello, as two deltas`)
  }
}

// ---------------------------------------------------------------------------
console.log('\n— relay.js: only the top document, only its own turns')
function loadRelay() {
  const posted: any[] = []
  const sent: any[] = []
  const ports: any[] = []
  const listeners: ((ev: any) => void)[] = []
  const win: any = {
    addEventListener: (_: string, fn: (ev: any) => void) => listeners.push(fn),
    postMessage: (m: any) => posted.push(m),
  }
  const chrome = {
    runtime: {
      // relay.js says `hello` once at load (the folder-learning ping); that is
      // not the traffic under test, so it is not counted.
      sendMessage: async (m: any) => { if (m.op !== 'hello') sent.push(m); return { ok: true, echo: m.op } },
      connect: ({ name }: { name: string }) => {
        const onMessage: any[] = []
        const onDisconnect: any[] = []
        const port = {
          name, out: [] as any[], disconnected: false,
          postMessage(m: any) { port.out.push(m) },
          disconnect() { port.disconnected = true },
          onMessage: { addListener: (f: any) => onMessage.push(f) },
          onDisconnect: { addListener: (f: any) => onDisconnect.push(f) },
          // the worker's side of the port, for the rig
          reply: (m: any) => onMessage.forEach((f) => f(m)),
          drop: () => onDisconnect.forEach((f) => f()),
        }
        ports.push(port)
        return port
      },
    },
  }
  const ctx: any = createContext({ window: win, chrome, setTimeout, Promise, JSON, String, Map, console })
  runInContext(read('src/relay.js'), ctx)
  const deliver = (data: any, source: any = win) => listeners.forEach((f) => f({ data, source }))
  return { posted, sent, ports, deliver, win }
}
const CH = '__bento_tray__'
{
  const r = loadRelay()
  r.deliver({ [CH]: true, dir: 'req', id: 'asst-1', op: 'assistant.send', payload: { messages: [] } }, { not: 'the window' })
  await settle()
  ok(r.ports.length === 0 && r.sent.length === 0 && r.posted.length === 0, 'a frame from another window (an iframe on a slide) is dropped entirely')
}
{
  const r = loadRelay()
  r.deliver({ [CH]: true, dir: 'req', id: '1700000000-3', op: 'assistant.send', payload: { messages: [] } })
  await settle()
  ok(r.ports.length === 0 && r.sent.length === 0 && r.posted.length === 0, 'an assistant op without the page\'s asst- id prefix gets nothing')
}
{
  const r = loadRelay()
  r.deliver({ [CH]: true, dir: 'req', id: 'asst-7', op: 'assistant.send', payload: { messages: [{ role: 'user', content: 'hi' }] } })
  await settle()
  ok(r.ports.length === 1 && r.ports[0].name === 'bento-assistant', 'a send opens one port of the agreed name')
  ok(r.ports[0].out[0]?.op === 'assistant.send' && r.ports[0].out[0].id === 'asst-7', 'and posts the turn on it with the page\'s id')
  ok(r.sent.length === 0, 'nothing rides sendMessage')
  const p = r.ports[0]
  p.reply({ dir: 'res', id: 'asst-7', result: { ok: true } })
  p.reply({ dir: 'evt', id: 'asst-7', kind: 'assistant.chunk', text: 'He' })
  p.reply({ dir: 'evt', id: 'asst-9', kind: 'assistant.chunk', text: 'NOT MINE' })
  ok(r.posted.length === 2 && r.posted[0].dir === 'res' && r.posted[0][CH] === true && r.posted[1].kind === 'assistant.chunk' && r.posted[1].text === 'He',
    'res and evt frames come back to the page under the envelope key, with the same id')
  ok(!r.posted.some((m) => m.text === 'NOT MINE'), 'a frame for another id is not forwarded')
  // an abort for THIS turn reaches its port; one for a turn this tab never started reaches nothing
  r.deliver({ [CH]: true, dir: 'req', id: 'asst-8', op: 'assistant.abort', payload: { req: 'asst-7' } })
  r.deliver({ [CH]: true, dir: 'req', id: 'asst-10', op: 'assistant.abort', payload: { req: 'asst-OTHER-TAB' } })
  await settle()
  ok(p.out.some((m: any) => m.op === 'assistant.abort'), 'abort for a turn this tab started is posted on that turn\'s port')
  ok(r.ports.length === 1 && r.sent.length === 0, 'abort for any other id opens nothing and sends nothing — it cannot name another tab\'s turn')
  ok(r.posted.filter((m) => m.dir === 'res' && m.id.startsWith('asst-') && m.id !== 'asst-7').length === 2, 'both aborts are answered ok, as the contract says')
  p.reply({ dir: 'evt', id: 'asst-7', kind: 'assistant.done', text: 'Hello' })
  ok(p.disconnected, 'done closes the port')
  const r2 = loadRelay()
  r2.deliver({ [CH]: true, dir: 'req', id: 'asst-20', op: 'assistant.send', payload: { messages: [{ role: 'user', content: 'hi' }] } })
  await settle()
  r2.ports[0].reply({ dir: 'evt', id: 'asst-20', kind: 'assistant.error', code: 'consent-denied', reason: 'no' })
  ok(r2.posted.at(-1)?.code === 'consent-denied', 'the machine code on an error event is forwarded')
}
{
  const r = loadRelay()
  r.deliver({ [CH]: true, dir: 'req', id: 'asst-11', op: 'assistant.send', payload: { messages: [{ role: 'user', content: 'hi' }] } })
  await settle()
  r.ports[0].reply({ dir: 'res', id: 'asst-11', result: { ok: true } })
  r.ports[0].drop()
  ok(r.posted.at(-1)?.kind === 'assistant.error' && r.posted.at(-1)?.reason === 'disconnected', 'the worker going away mid-stream is one error frame, not a hang')
}
{
  const r = loadRelay()
  r.deliver({ [CH]: true, dir: 'req', id: 'asst-12', op: 'assistant.describe', payload: {} })
  r.deliver({ [CH]: true, dir: 'req', id: '1700-1', op: 'claim', payload: {} })
  await settle()
  ok(r.sent.map((m) => m.op).join() === 'assistant.describe,claim' && r.posted.length === 2, 'describe and the save ops still ride sendMessage, unchanged')
}
{
  const manifest = JSON.parse(read('manifest.json'))
  ok(manifest.content_scripts.every((cs: any) => cs.all_frames === false), 'content scripts state all_frames: false explicitly — the default, but a future edit cannot flip it silently')
  ok(manifest.content_scripts.every((cs: any) => cs.matches.every((m: string) => m.startsWith('file:///'))), 'and only on file: documents')
  ok(/ev\.source !== window/.test(read('src/relay.js')), 'relay.js checks the frame\'s source is its own window')
  ok(/'assistant'/.test(read('src/page-bridge.js')), 'page-bridge.js announces the capability')
  ok(Array.isArray(manifest.optional_host_permissions) && !manifest.host_permissions, 'site access is optional and asked per origin, never declared up front')
}

// ---------------------------------------------------------------------------
console.log('\n— background.js: consent per document, answered only by the consent page')
const FILE = { url: 'file:///Users/x/Decks/Q3.bento.html', frameId: 0, id: 'ext-id' }
const OTHER = { url: 'file:///Users/x/Decks/Other.bento.html', frameId: 0, id: 'ext-id' }
const CONSENT_PAGE = { id: 'ext-id', url: EXT + 'src/consent.html?doc=x' }
const fetchOk = async () => ({ ok: true, status: 200, body: sseBody(openaiSse) })
;(globalThis as any).fetch = fetchOk

/** A port as the worker sees it, from the given sender. */
function fakePort(sender: any, name = 'bento-assistant') {
  const onMessage: any[] = []
  const onDisconnect: any[] = []
  const port = {
    name, sender, out: [] as any[],
    postMessage(m: any) { port.out.push(m) },
    disconnect() { onDisconnect.forEach((f) => f()) },
    onMessage: { addListener: (f: any) => onMessage.push(f) },
    onDisconnect: { addListener: (f: any) => onDisconnect.push(f) },
    send: (m: any) => onMessage.forEach((f) => f(m)),
  }
  return port
}
const until = async (fn: () => boolean, n = 50) => { for (let i = 0; i < n && !fn(); i++) await tick() }
const consentNonce = (url: string) => new URL(url).searchParams.get('nonce')

store[asst.CONFIG_KEY] = { provider: 'openai', baseUrl: `https://gw.example/${TENANT}/v1`, model: 'm', key: KEY }
{
  const port = fakePort(FILE)
  bg.serveAssistantPort(port)
  port.send({ op: 'assistant.send', id: 'asst-1', payload: { messages: [{ role: 'user', content: 'hi' }] } })
  await until(() => windowsOpened.length > 0)
  ok(port.out[0]?.dir === 'res' && port.out[0].result.ok === true, 'a turn from a file not yet allowed is accepted…')
  ok(windowsOpened.length === 1 && windowsOpened[0].startsWith(EXT + 'src/consent.html?'), '…and opens the consent window')
  const u = new URL(windowsOpened[0])
  ok(u.searchParams.get('doc') === FILE.url && u.searchParams.get('host') === 'gw.example' && u.searchParams.get('model') === 'm', 'the window is told the file, the host and the model')
  ok(!windowsOpened[0].includes(KEY) && !windowsOpened[0].includes(TENANT), 'and not the key or the base URL path')
  ok(port.out.length === 1, 'nothing streams while the question is open')

  // a second turn from the same file while the prompt is open shares it
  const port2 = fakePort(FILE)
  bg.serveAssistantPort(port2)
  port2.send({ op: 'assistant.send', id: 'asst-2', payload: { messages: [{ role: 'user', content: 'hi' }] } })
  await settle()
  ok(windowsOpened.length === 1, 'a second turn from the same file joins the open prompt rather than opening another')

  // the page itself cannot answer
  const nonce = consentNonce(windowsOpened[0])
  const forged = await bg.recordConsent(FILE, { op: 'assistant.consent', nonce, doc: FILE.url, allow: true })
  await settle()
  ok(forged.ok === false && !store[asst.ALLOWED_KEY], 'a document posting the consent answer itself is refused and nothing is recorded')
  ok(port.out.length === 1, 'and the stream is still waiting')

  // the consent page can
  const real = await bg.recordConsent(CONSENT_PAGE, { op: 'assistant.consent', nonce, doc: FILE.url, host: 'gw.example', allow: true })
  await until(() => port.out.some((m: any) => m.kind === 'assistant.done'))
  ok(real.ok === true && !!(store[asst.ALLOWED_KEY] as any)?.[FILE.url], 'the consent page\'s Allow is recorded for that file')
  ok(port.out.filter((m: any) => m.kind === 'assistant.chunk').length === 2 && port.out.at(-1).kind === 'assistant.done' && port.out.at(-1).text === 'Hello',
    'and the waiting turn streams: two chunks, one done')
  await until(() => port2.out.some((m: any) => m.kind === 'assistant.done'))
  ok(port2.out.at(-1)?.kind === 'assistant.done', 'the turn that joined the prompt streams too')
  ok(port.out.every((m: any) => m.id === 'asst-1') && port2.out.every((m: any) => m.id === 'asst-2'), 'each turn\'s frames carry its own id')
}
{
  // now allowed: no prompt
  const port = fakePort(FILE)
  bg.serveAssistantPort(port)
  port.send({ op: 'assistant.send', id: 'asst-3', payload: { messages: [{ role: 'user', content: 'hi' }] } })
  await until(() => port.out.some((m: any) => m.kind === 'assistant.done'))
  ok(windowsOpened.length === 1 && port.out.at(-1)?.kind === 'assistant.done', 'an allowed file is not asked again')
}
{
  // another file: its own prompt; declined → error, nothing recorded
  const port = fakePort(OTHER)
  bg.serveAssistantPort(port)
  port.send({ op: 'assistant.send', id: 'asst-4', payload: { messages: [{ role: 'user', content: 'hi' }] } })
  await until(() => windowsOpened.length > 1)
  ok(windowsOpened.length === 2 && new URL(windowsOpened[1]).searchParams.get('doc') === OTHER.url, 'a different file gets its own prompt')
  await bg.recordConsent(CONSENT_PAGE, { op: 'assistant.consent', nonce: consentNonce(windowsOpened[1]), doc: OTHER.url, allow: false })
  await until(() => port.out.length > 1)
  ok(port.out.at(-1)?.kind === 'assistant.error' && port.out.at(-1)?.reason === 'asstDenied' && port.out.at(-1)?.code === 'consent-denied',
    'Not now → one error frame naming the refusal, with the machine code the page keys on')
  ok(!(store[asst.ALLOWED_KEY] as any)[OTHER.url], 'and the refusal is not recorded as consent')
}
{
  // the consent window closed without an answer: declined, not stuck
  const port = fakePort(OTHER)
  bg.serveAssistantPort(port)
  port.send({ op: 'assistant.send', id: 'asst-5', payload: { messages: [{ role: 'user', content: 'hi' }] } })
  await until(() => windowsOpened.length > 2)
  const nonce = consentNonce(windowsOpened[2])!
  const beat = fakePort(CONSENT_PAGE, `bento-consent:${nonce}`)
  bg.watchConsentWindow(beat)
  beat.disconnect()
  await until(() => port.out.length > 1)
  ok(port.out.at(-1)?.kind === 'assistant.error', 'closing the window is a refusal — the turn does not wait forever')
  const spoof = fakePort(FILE, `bento-consent:${nonce}`)
  let dropped = false
  spoof.disconnect = () => { dropped = true }
  bg.watchConsentWindow(spoof)
  ok(dropped, 'a heartbeat port from anything but the consent page is dropped')
}
{
  // who may open a turn at all
  for (const [label, sender] of [['a sub-frame', { ...FILE, frameId: 2 }], ['an https page', { url: 'https://bento.page/slides/', frameId: 0 }], ['no sender', undefined]] as const) {
    const port = fakePort(sender)
    bg.serveAssistantPort(port)
    port.send({ op: 'assistant.send', id: 'asst-6', payload: { messages: [{ role: 'user', content: 'hi' }] } })
    await settle()
    ok(port.out.length === 1 && port.out[0].result.ok === false && port.out[0].result.reason === 'not a document', `${label} cannot start a turn`)
  }
  const port = fakePort(FILE)
  bg.serveAssistantPort(port)
  port.send({ op: 'assistant.send', id: '1700-1', payload: { messages: [{ role: 'user', content: 'hi' }] } })
  port.send({ op: 'assistant.send', id: 'asst-x', payload: { messages: [{ role: 'user', content: 'hi', extra: 1 }, { role: 'bad' }] } })
  await settle()
  ok(port.out[0]?.result.reason === 'bad id' && port.out[1]?.result.reason === 'bad request', 'a foreign id and a malformed payload are refused before anything is read')
  ok(port.out.length === 2, 'and neither opened a prompt or a request')
}
{
  // abort: the port's own turn, and the tab closing
  let aborted = 0
  ;(globalThis as any).fetch = async (_u: string, init: any) => {
    init.signal.addEventListener('abort', () => aborted++)
    return { ok: true, status: 200, body: { getReader: () => ({ read: () => new Promise(() => {}), releaseLock() {} }) } }
  }
  const port = fakePort(FILE)
  bg.serveAssistantPort(port)
  port.send({ op: 'assistant.send', id: 'asst-7', payload: { messages: [{ role: 'user', content: 'hi' }] } })
  await settle(20)
  port.send({ op: 'assistant.abort' })
  ok(aborted === 1, 'an abort on the port aborts the request it carries')
  const port2 = fakePort(FILE)
  bg.serveAssistantPort(port2)
  port2.send({ op: 'assistant.send', id: 'asst-8', payload: { messages: [{ role: 'user', content: 'hi' }] } })
  await settle(20)
  port2.disconnect()
  ok(aborted === 2, 'the tab going away (port disconnect) aborts its request')
  ;(globalThis as any).fetch = fetchOk
}
{
  // sendMessage ops
  const d = await bg.assistantOp('assistant.describe', FILE)
  ok(d.ok === true && d.host === 'gw.example' && Object.keys(d).sort().join() === 'configured,contextTokens,host,model,ok', 'assistant.describe over sendMessage: the bounded shape')
  const s = await bg.assistantOp('assistant.settings.open', FILE)
  ok(s.ok === true && optionsOpened === 1, 'assistant.settings.open opens the options page')
  const c = await bg.assistantOp('assistant.check', FILE)
  ok(c.ok === true, 'assistant.check from an allowed file makes the probe')
  store[asst.ALLOWED_KEY] = {}
  const before = windowsOpened.length
  const pending = await bg.assistantOp('assistant.check', FILE)
  ok(pending.ok === false && pending.code === 'consent-pending' && pending.reason === 'asstWaitConsent' && windowsOpened.length === before + 1,
    'assistant.check from a file not yet allowed opens the prompt and answers inside the page\'s timeout')
  await bg.recordConsent(CONSENT_PAGE, { op: 'assistant.consent', nonce: consentNonce(windowsOpened.at(-1)!), doc: FILE.url, allow: false })
  const u = await bg.assistantOp('assistant.check', { url: 'https://x/', frameId: 0 })
  ok(u.ok === false && u.reason === 'not a document', 'assistant.check from a non-document is refused')
  const unknown = await bg.assistantOp('assistant.nope', FILE)
  ok(unknown.ok === false, 'an unknown assistant op is refused')
}

console.log('\n— providers: a reply schema, per provider')
const EDITS = { type: 'object', properties: { edits: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } } }, required: ['edits'] }
{
  const oa = JSON.parse(shapeRequest({ provider: 'openai', model: 'm', key: 'K' }, [...msgs], { schema: EDITS }).body)
  ok(oa.response_format?.type === 'json_schema' && oa.response_format.json_schema.name === 'reply' && JSON.stringify(oa.response_format.json_schema.schema) === JSON.stringify(EDITS), 'openai: schema rides as response_format.json_schema, verbatim')
  ok(!('response_format' in JSON.parse(shapeRequest({ provider: 'openai', model: 'm', key: 'K' }, [...msgs]).body)), 'openai: no schema, no response_format')
  const ge = JSON.parse(shapeRequest({ provider: 'gemini', model: 'g', key: 'K' }, [...msgs], { schema: EDITS }).body)
  ok(ge.generationConfig?.responseMimeType === 'application/json' && JSON.stringify(ge.generationConfig.responseSchema) === JSON.stringify(EDITS), 'gemini: schema rides as generationConfig.responseSchema with the JSON mime type')
  ok(!('generationConfig' in JSON.parse(shapeRequest({ provider: 'gemini', model: 'g', key: 'K' }, [...msgs]).body)), 'gemini: no schema, no generationConfig')
  const an = JSON.parse(shapeRequest({ provider: 'anthropic', model: 'm', key: 'K' }, [...msgs], { schema: EDITS }).body)
  ok(!JSON.stringify(an).includes('"edits"'), 'anthropic: no constrained mode without tools — the schema stays out of the request, the prompt carries it')
}
{
  ok(JSON.stringify(asst.validSchema({ schema: EDITS })) === JSON.stringify(EDITS), 'validSchema: the page\'s edits shape passes, as data')
  ok(JSON.stringify(asst.validSchema({ schema: { type: 'object' } })) === '{"type":"object"}', 'validSchema: the page\'s bare object shape passes')
  for (const [label, bad] of [['absent', {}], ['a string', { schema: '{"type":"object"}' }], ['an array', { schema: [] }], ['null', { schema: null }]] as const) {
    ok(asst.validSchema(bad as any) === undefined, `validSchema: ${label} → no schema, the turn runs as prose`)
  }
  ok(asst.validSchema({ schema: { type: 'object', description: 'x'.repeat(asst.SCHEMA_BUDGET) } }) === undefined, 'validSchema: over the byte budget → dropped')
  const proto = JSON.parse('{"type":"object","__proto__":{"polluted":true}}')
  const cleaned = asst.validSchema({ schema: proto })!
  ok(cleaned && !('polluted' in cleaned) && Object.getPrototypeOf(cleaned) === Object.prototype, 'validSchema: re-read through JSON, nothing but plain data survives')
}
{
  // the OpenAI-compatible server that does not know response_format: one retry without
  const bodies: any[] = []
  const frames: any[] = []
  await asst.run(cfgOpenai, [{ role: 'user', content: 'hi' }], (k: string, x: any) => frames.push({ kind: k, ...x }), new AbortController().signal, {
    t, fetch: async (_u: string, init: any) => {
      const b = JSON.parse(init.body); bodies.push(b)
      if (b.response_format) return { ok: false, status: 400, text: async () => '{"error":{"message":"response_format is not supported"}}' }
      return { ok: true, status: 200, body: sseBody(openaiSse) }
    },
  }, EDITS)
  ok(bodies.length === 2 && !!bodies[0].response_format && !bodies[1].response_format && frames.at(-1)?.kind === 'assistant.done', 'run (openai): a 400 about response_format → once more without it, and the turn completes')
  const other: any[] = []
  const f2: any[] = []
  await asst.run(cfgOpenai, [{ role: 'user', content: 'hi' }], (k: string, x: any) => f2.push({ kind: k, ...x }), new AbortController().signal, {
    t, fetch: async (_u: string, init: any) => { other.push(1); return { ok: false, status: 400, text: async () => '{"error":{"message":"context length exceeded"}}' } },
  }, EDITS)
  ok(other.length === 1 && f2[0]?.kind === 'assistant.error' && f2[0].reason === 'HTTP 400: context length exceeded', 'run (openai): any other 400 is reported once, not retried')
}
{
  // the built-in model: responseConstraint when Chrome takes it, plain when it throws on the option
  const make = (acceptsConstraint: boolean) => {
    const opts: any[] = []
    const LM = {
      availability: async () => 'available',
      create: async () => ({
        promptStreaming: (_t: string, o: any) => {
          opts.push(o)
          if (o.responseConstraint && !acceptsConstraint) throw new TypeError('responseConstraint is not a known option')
          return { [Symbol.asyncIterator]: async function* () { yield '{"edits":[]}' } }
        },
        destroy() {},
      }),
    }
    return { LM, opts }
  }
  for (const accepts of [true, false]) {
    const { LM, opts } = make(accepts)
    const frames: any[] = []
    await asst.run({ provider: 'builtin' } as any, [{ role: 'user', content: 'hi' }], (k: string, x: any) => frames.push({ kind: k, ...x }), new AbortController().signal, { t, LanguageModel: LM }, EDITS)
    ok(opts[0].responseConstraint === EDITS && frames.at(-1)?.kind === 'assistant.done' && frames.at(-1).text === '{"edits":[]}',
      accepts ? 'run (built-in): the schema goes to promptStreaming as responseConstraint' : 'run (built-in): a Chrome that rejects the option gets one plain retry')
    ok(opts.length === (accepts ? 1 : 2) && (accepts || !('responseConstraint' in opts[1])), accepts ? 'run (built-in): and only once' : 'run (built-in): the retry carries no constraint')
  }
  const { LM, opts } = make(true)
  await asst.run({ provider: 'builtin' } as any, [{ role: 'user', content: 'hi' }], () => {}, new AbortController().signal, { t, LanguageModel: LM })
  ok(!('responseConstraint' in opts[0]), 'run (built-in): no schema, no constraint')
}
{
  // through the port: the schema in the frame reaches the provider's body; a malformed one is dropped, not fatal
  const bodies: any[] = []
  ;(globalThis as any).fetch = async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, body: sseBody(openaiSse) } }
  store[asst.ALLOWED_KEY] = { [FILE.url]: { at: 1 } }
  const port = fakePort(FILE)
  bg.serveAssistantPort(port)
  port.send({ op: 'assistant.send', id: 'asst-s1', payload: { messages: [{ role: 'user', content: 'hi' }], schema: EDITS } })
  await until(() => port.out.some((m: any) => m.kind === 'assistant.done'))
  ok(JSON.stringify(bodies[0]?.response_format?.json_schema?.schema) === JSON.stringify(EDITS), 'port: a send frame with schema reaches the provider body in the right field')
  const port2 = fakePort(FILE)
  bg.serveAssistantPort(port2)
  port2.send({ op: 'assistant.send', id: 'asst-s2', payload: { messages: [{ role: 'user', content: 'hi' }] } })
  await until(() => port2.out.some((m: any) => m.kind === 'assistant.done'))
  ok(bodies.length === 2 && !('response_format' in bodies[1]), 'port: one without has no such field')
  const port3 = fakePort(FILE)
  bg.serveAssistantPort(port3)
  port3.send({ op: 'assistant.send', id: 'asst-s3', payload: { messages: [{ role: 'user', content: 'hi' }], schema: 'not an object' } })
  await until(() => port3.out.some((m: any) => m.kind === 'assistant.done'))
  ok(bodies.length === 3 && !('response_format' in bodies[2]) && port3.out.at(-1)?.kind === 'assistant.done', 'port: a malformed schema is dropped and the turn still runs as prose')
  ;(globalThis as any).fetch = fetchOk
}

console.log('\n— assistant.models / assistant.select: the page\'s picker')
{
  const LMon = { availability: async () => 'available' }
  const LMdl = { availability: async () => 'downloadable' }
  const noList = { t, LanguageModel: LMon, builtinTokens: async () => 6144, models: async () => undefined }
  // the store: old flat shape reads as the active provider's entry
  const st = asst.storedProviders({ provider: 'gemini', model: 'g', key: 'K' })
  ok(st.active === 'gemini' && st.providers.gemini.key === 'K', 'storedProviders: the first release\'s flat config migrates in place')
  ok(asst.activeConfig({ active: 'openai', providers: { openai: { model: 'm' }, gemini: { key: 'K' } } }, false).provider === 'openai', 'activeConfig: the active provider\'s fields')
  ok(asst.activeConfig({ active: 'builtin', providers: { gemini: { key: 'K' } } }, false).provider === 'gemini', 'activeConfig: an unusable active provider falls to the default, with THAT provider\'s fields')
  ok(asst.providerConfig({ active: 'gemini', providers: { gemini: { key: 'K' }, anthropic: { key: 'A', model: 'x' } } }, 'anthropic', false).key === 'A', 'providerConfig: another provider\'s fields, without making it active')

  // a fresh install with only the built-in model: one entry, so the page shows no picker
  const fresh = await asst.models(undefined, noList)
  ok(fresh.length === 1 && fresh[0].provider === 'builtin' && fresh[0].model === 'gemini-nano' && fresh[0].local === true && fresh[0].current === true && fresh[0].contextTokens === 6144, 'models: fresh install with the built-in model → exactly one entry, current')
  ok(!('host' in fresh[0]), 'models: the built-in entry carries no host')
  ok((await asst.models(undefined, { ...noList, LanguageModel: LMdl })).length === 0, 'models: a downloadable built-in model is not a route the page can take')

  // with a Gemini key: built-in + the configured model + its cached listing
  const raw = { active: 'gemini', providers: { gemini: { key: 'K', model: 'gemini-3.8-flash' } } }
  const listing = [{ id: 'gemini-3.8-flash', contextTokens: 1048576 }, { id: 'gemini-3.8-pro', contextTokens: 1048576 }, { id: 'bad id!' }]
  let fetched = 0
  const withList = { ...noList, models: async (c: any) => (c.provider === 'gemini' ? listing : undefined), fetch: async () => { fetched++; throw new Error('must not fetch') } }
  const m = await asst.models(raw, withList)
  ok(m.map((x) => `${x.provider}:${x.model}`).join() === 'builtin:gemini-nano,gemini:gemini-3.8-flash,gemini:gemini-3.8-pro', 'models: providers in settings order, the configured model first in its provider, the listing after, ids outside MODEL_RE dropped')
  ok(m[1].current === true && !('current' in m[0]) && !('current' in m[2]), 'models: current marks the active route only')
  ok(m[1].host === 'generativelanguage.googleapis.com' && m[1].contextTokens === 1048576 && m[2].contextTokens === 1048576, 'models: host as describe reports it, window per the same resolution')
  ok(fetched === 0, 'models: never fetches — it runs on every describe')
  const unkeyed = await asst.models({ active: 'gemini', providers: { gemini: { model: 'g' }, anthropic: {} } }, noList)
  ok(unkeyed.length === 1 && unkeyed[0].provider === 'builtin', 'models: a provider without its key is not offered')
  ok((await asst.models({ active: 'openai', providers: { openai: { model: 'local-llama', baseUrl: 'http://localhost:11434/v1' } } }, { ...noList, LanguageModel: undefined })).length === 1, 'models: a local OpenAI-compatible endpoint needs no key and is offered')
  const many = { active: 'openai', providers: { openai: { model: 'gpt-5.6-luna', key: 'K', showAll: true } } }
  const big = await asst.models(many, { ...noList, LanguageModel: undefined, models: async () => Array.from({ length: 500 }, (_, i) => ({ id: `m${i}` })) })
  ok(big.length === asst.MODELS_MAX, 'models: even with show-all on, capped at what the page reads')

  // select
  const sel = await asst.select(raw, { provider: 'gemini', model: 'gemini-3.8-pro' }, withList)
  ok(sel.ok === true && sel.store.active === 'gemini' && sel.store.providers.gemini.model === 'gemini-3.8-pro' && sel.store.providers.gemini.key === 'K', 'select: persists the model for that provider, keeps its key, changes nothing else')
  ok((await asst.select(raw, { provider: 'gemini', model: 'not-listed-but-fine' }, withList)).ok === true, 'select: a model outside the listing is allowed (the free-text field allows it)')
  ok((await asst.select(raw, { provider: 'anthropic', model: 'claude-sonnet-5' }, withList)).ok === false, 'select: an unconfigured provider → ok:false')
  ok((await asst.select(raw, { provider: 'evil', model: 'x' }, withList)).ok === false && (await asst.select(raw, { provider: 'gemini', model: 'has space' }, withList)).ok === false, 'select: provider outside the enum or a model outside MODEL_RE → ok:false')
  const b = await asst.select(raw, { provider: 'builtin', model: 'gemini-nano' }, withList)
  ok(b.ok === true && b.store.active === 'builtin' && b.store.providers.gemini.key === 'K', 'select: the built-in model becomes active; the Gemini key is untouched')
  ok((await asst.select(raw, { provider: 'builtin', model: 'gemini-nano' }, { ...withList, LanguageModel: LMdl })).ok === false, 'select: a built-in model that cannot answer is refused')

  // through the worker, and across a restart: the store is the only state
  store[asst.CONFIG_KEY] = raw
  const r = await bg.assistantOp('assistant.select', FILE, { provider: 'gemini', model: 'gemini-3.8-pro' })
  ok(r.ok === true && (store[asst.CONFIG_KEY] as any).providers.gemini.model === 'gemini-3.8-pro', 'assistant.select over sendMessage persists to chrome.storage.local')
  const fresh2 = await import('../home/webext/src/background.js?restart=1')
  const d = await fresh2.assistantOp('assistant.describe', FILE)
  ok(d.model === 'gemini-3.8-pro', 'a fresh worker (module re-import) describes the selected model — nothing lived in memory')
  const listed = await bg.assistantOp('assistant.models', FILE)
  ok(listed.ok === true && Array.isArray(listed.models) && listed.models.some((x: any) => x.provider === 'gemini' && x.model === 'gemini-3.8-pro' && x.current === true), 'assistant.models over sendMessage: the selected route is current')
  const bad = await bg.assistantOp('assistant.select', FILE, { provider: 'anthropic', model: 'claude-sonnet-5' })
  ok(bad.ok === false && (store[asst.CONFIG_KEY] as any).active === 'gemini', 'assistant.select refused leaves the store as it was')
}

console.log('\n— curation: what the picker shows')
{
  const { chatModels, curateModels, CURATED_MAX, parseModels } = providers
  // a Gemini listing the way the API returns it: 40 entries, most of them not for chat
  const g = (name: string, extra: any = {}) => ({ name: `models/${name}`, supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576, ...extra })
  const raw = { models: [
    g('gemini-3.8-flash'), g('gemini-3.8-pro'), g('gemini-3.8-flash-lite'), g('gemini-3.8-flash-preview'), g('gemini-3.8-flash-001'),
    g('gemini-3-flash'), g('gemini-3-pro'), g('gemini-3-pro-preview'), g('gemini-3-flash-lite'),
    g('gemini-2.5-flash'), g('gemini-2.5-pro'), g('gemini-2.5-flash-lite'), g('gemini-2.5-flash-preview-05-20'), g('gemini-2.5-pro-exp'),
    g('gemini-2.0-flash'), g('gemini-2.0-flash-001'), g('gemini-2.0-flash-lite'), g('gemini-2.0-pro-exp'), g('gemini-2.0-flash-exp'),
    g('gemini-1.5-flash'), g('gemini-1.5-pro'), g('gemini-1.5-flash-8b'), g('gemini-1.5-flash-001'), g('gemini-1.5-pro-002'),
    g('gemini-2.5-flash-preview-tts'), g('gemini-2.5-pro-preview-tts'), g('gemini-2.0-flash-preview-image-generation'),
    g('gemini-2.5-flash-native-audio'), g('gemini-2.5-flash-live'), g('gemini-live-2.5-flash'),
    g('gemini-embedding-001', { supportedGenerationMethods: ['embedContent'] }), g('text-embedding-004', { supportedGenerationMethods: ['embedContent'] }),
    g('veo-3.0-generate', { supportedGenerationMethods: ['predictLongRunning'] }), g('imagen-4.0-generate', { supportedGenerationMethods: ['predict'] }),
    g('aqa'), g('learnlm-2.0-flash'), g('gemini-robotics-er'), g('gemini-2.5-computer-use'),
    g('gemini-3.8-flash-image'), g('gemma-3-27b-it'),
  ] }
  const parsed = parseModels('gemini', raw)
  ok(parsed.length === 36, `parseModels keeps generateContent entries (${parsed.length} of 40)`)
  const chat = chatModels('gemini', parsed)
  const ids = chat.map((m) => m.id)
  ok(!ids.some((id) => /tts|image|embedding|audio|live|veo|imagen|aqa|learnlm|robotics|computer-use|gemma/.test(id)), 'chatModels gemini: no tts/image/embedding/audio/live/veo/imagen/aqa/learnlm/robotics')
  ok(!ids.includes('gemini-3.8-flash-001') && !ids.includes('gemini-1.5-pro-002') && !ids.includes('gemini-2.0-flash-001'), 'chatModels: dated snapshots fold into their undated alias')
  ok(!ids.some((id) => /preview|exp/.test(id)), 'chatModels: preview/exp dropped while stable builds exist')
  const cur = curateModels('gemini', parsed)
  ok(cur.length <= CURATED_MAX && cur.length >= 10, `curateModels: ≤${CURATED_MAX} (${cur.length})`)
  ok(cur[0].id === 'gemini-3.8-flash' && cur[1].id === 'gemini-3.8-pro' && cur[2].id === 'gemini-3.8-flash-lite', 'curateModels: newest version first; flash, then pro, then lite within it')
  ok(cur.map((m) => providers.modelVersion(m.id)).every((v, i, a) => i === 0 || v <= a[i - 1]), 'curateModels: versions descend through the list')
  const all = curateModels('gemini', parsed, { all: true })
  ok(all.length === parsed.length, 'curateModels all: the full listing, uncapped')
  ok(curateModels('gemini', [{ id: 'gemini-9-flash-preview' }, { id: 'gemini-9-pro-exp' }]).length === 2, 'curateModels: preview/exp stay when nothing else exists')
  const oa = curateModels('openai', parseModels('openai', { data: [
    { id: 'gpt-5.6-luna', created: 9 }, { id: 'gpt-5.6-sol', created: 9 }, { id: 'gpt-5-mini', created: 5 }, { id: 'gpt-5-nano', created: 5 }, { id: 'gpt-5', created: 5 },
    { id: 'gpt-4o-mini-2024-07-18', created: 1 }, { id: 'gpt-4o-mini', created: 1 }, { id: 'text-embedding-3-small', created: 1 }, { id: 'whisper-1', created: 1 },
    { id: 'gpt-4o-realtime-preview', created: 1 }, { id: 'dall-e-3', created: 1 }, { id: 'o3-mini', created: 4 }, { id: 'tts-1', created: 1 }, { id: 'omni-moderation-latest', created: 1 },
  ] }))
  ok(oa.map((m) => m.id).join() === 'gpt-5.6-luna,gpt-5.6-sol,gpt-5-mini,gpt-5,gpt-5-nano,gpt-4o-mini,o3-mini', 'curateModels openai: chat families only, newest first, luna before sol, mini before full before nano')

  // through assistant.models: pinned first after the configured model, show-all honoured
  const cfgRaw = { active: 'gemini', providers: { gemini: { key: 'K', model: 'gemini-3.8-flash', pinned: ['gemini-2.5-pro', 'gemini-3-pro'] } } }
  const env = { t, LanguageModel: undefined, models: async () => parsed }
  const list = (await asst.models(cfgRaw, env)).map((m) => m.model)
  ok(list.slice(0, 3).join() === 'gemini-3.8-flash,gemini-2.5-pro,gemini-3-pro', 'models: the configured model, then the pinned picks, then the curated cut')
  ok(list.length <= CURATED_MAX + 2 && !list.includes('gemini-2.5-flash-preview-tts'), 'models: the rest is the curated listing')
  const allRaw = { active: 'gemini', providers: { gemini: { key: 'K', model: 'gemini-3.8-flash', showAll: true } } }
  ok((await asst.models(allRaw, env)).length === parsed.length, 'models: "show all" for the provider → the full listing')
  const picked = await asst.select(cfgRaw, { provider: 'gemini', model: 'gemini-1.5-pro' }, env)
  ok(picked.ok === true && picked.store.providers.gemini.pinned.join() === 'gemini-1.5-pro,gemini-2.5-pro,gemini-3-pro', 'select: the chosen model is pinned first for next time')
  ok(asst.normalizeConfig({ provider: 'gemini', pinned: Array.from({ length: 20 }, (_, i) => `m${i}`).concat(['bad id']) }, false).pinned!.length === asst.PINNED_MAX, 'normalizeConfig: pinned is bounded and shaped')
}

console.log('\n— the Settings model picker')
{
  const { parseModels } = providers
  const g = (name: string) => ({ name: `models/${name}`, supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576 })
  const listing = parseModels('gemini', { models: [g('gemini-3.8-flash'), g('gemini-3.8-pro'), g('gemini-3.8-flash-lite'), g('gemini-3-flash'), g('gemini-2.5-flash-preview-tts'), g('gemini-embedding-001')] })
  const cfg = asst.normalizeConfig({ provider: 'gemini', key: 'K', model: 'gemini-3.8-flash', pinned: ['gemini-3-flash'] }, false)
  const rows = asst.pickerRows(cfg, listing)
  ok(rows.map((r) => r.id).join() === 'gemini-3.8-flash,gemini-3-flash,gemini-3.8-pro,gemini-3.8-flash-lite', 'pickerRows: configured first, pinned next, then the curated cut — tts and embeddings absent')
  ok(rows[0].label === 'gemini-3.8-flash · 1M', 'pickerRows: the window beside each id, the way the page shows it')
  ok(asst.shortTokens(1048576) === '1M' && asst.shortTokens(200000) === '200k' && asst.shortTokens(6144) === '6k' && asst.shortTokens(400000) === '400k', 'shortTokens: 1M / 200k / 6k / 400k')
  const typed = asst.pickerRows(asst.normalizeConfig({ provider: 'gemini', key: 'K', model: 'my-tuned-model' }, false), listing)
  ok(typed[0].id === 'my-tuned-model' && typed.length === 5, 'pickerRows: an unlisted (typed) model is still a row, first')
  const fresh = asst.pickerRows(asst.normalizeConfig({ provider: 'gemini', key: 'K' }, false), [])
  ok(fresh.length === 1 && fresh[0].id === providers.DEFAULTS.gemini.model, 'pickerRows: before the first listing, just the default (the form adds Other…)')
  const all = asst.pickerRows(asst.normalizeConfig({ provider: 'gemini', key: 'K', model: 'gemini-3.8-flash', showAll: true }, false), listing)
  ok(all.length === listing.length, 'pickerRows: show-all refills with the whole listing')
  const home = read('src/home.js')
  ok(!/createElement\('datalist'\)/.test(home), 'Settings: the datalist is gone')
  ok(/const model = document\.createElement\('select'\)/.test(home) && /asstOtherModelRow/.test(home) && /other\.hidden = model\.value !== OTHER/.test(home), 'Settings: the model is a <select> whose Other… row reveals the free-text field')
  ok(/MODEL_RE\.test\(c\.model\)/.test(home), 'Settings: an Other… id is validated by MODEL_RE before it is saved')
}

console.log('\n— prompt.js: the turn from the page\'s material')
const prompt = await import('../home/webext/src/prompt.js')
const MATERIAL = {
  outline: 'Deck "Q3", 2 slides.\nSlide 1:\n  - title: Hello\nSlide 2:\n  - body: World',
  addressed: 'Deck "Q3", 2 slides.\nSlide 1 (id "s1"):\n  - [1/t1] title: Hello\nSlide 2 (id "s2"):\n  - [2/t2] body: World',
  open: 2, size: { width: 1280, height: 720 },
  focus: { kind: 'slide', label: 'slide 2 (id "s2") in full, its elements addressed as 2/<id>', json: '{"id":"s2","elements":[{"id":"t2","type":"text","html":"World"}]}' },
  theme: '{"accent":"#f80"}',
}
{
  ok(prompt.isQuestion('What is slide 2 about?') && prompt.isQuestion('summarise the deck') && !prompt.isQuestion('make the title bolder'), 'isQuestion: a trailing ? or an asking opener')
  const m = prompt.validMaterial(MATERIAL)!
  ok(m.open === 2 && m.focus?.kind === 'slide' && m.theme === MATERIAL.theme, 'validMaterial: the page\'s shape, bounded')
  ok(prompt.validMaterial({ outline: 5 }) === null && prompt.validMaterial('x') === null && prompt.validMaterial({ outline: 'x', focus: { kind: 'weird', json: '{}' } })!.focus === null, 'validMaterial: not material → null; an odd focus → none')
  const ask = prompt.buildMessages(m, [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }], 'What is slide 2 about?', 128000)
  ok(ask.mode === 'ask' && ask.focus === 'none' && ask.fits && ask.messages[0].content === prompt.QUESTION_PROMPT && ask.messages.length === 4, 'buildMessages ask: the question prompt, the history, the plain outline')
  ok(ask.messages[3].content.startsWith('Deck outline (slide 2 is open):\nDeck "Q3"') && ask.messages[3].content.endsWith('What is slide 2 about?'), 'buildMessages ask: outline first, request last')
  const edit = prompt.buildMessages(m, [], 'make the title bolder', 128000)
  ok(edit.mode === 'edit' && edit.focus === 'slide' && edit.fits && edit.messages[0].content === prompt.OPS_PROMPT, 'buildMessages edit: the ops prompt, the addressed outline, the focus')
  const u = edit.messages[1].content
  ok(u.includes('[1/t1]') && u.includes('Focus — slide 2 (id "s2") in full') && u.includes('; the deck\'s theme is {"accent":"#f80"}:\n{"id":"s2"') && u.endsWith('make the title bolder'), 'buildMessages edit: addressed outline, focus label + theme + json, request last')
  const small = prompt.buildMessages(m, [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }, { role: 'user', text: 'c' }, { role: 'assistant', text: 'd' }], 'make the title bolder', 2130)
  ok(small.mode === 'edit' && small.focus === 'none' && small.fits && !small.messages.some((x: any) => x.content.includes('Focus —')) && small.messages.length === 1 + prompt.WORDS_HISTORY + 1, 'buildMessages edit, small window: the focus is dropped, history cut to WORDS_HISTORY, still fits')
  const none = prompt.buildMessages(m, [], 'make the title bolder', 1000)
  ok(none.fits === false && none.contextTokens > 0 && none.window === 1000, 'buildMessages edit, tiny window: fits:false with the numbers')
  ok(prompt.responseSchema('ask') === undefined && prompt.responseSchema('edit', 'none') === prompt.OPS_SCHEMA && prompt.responseSchema('edit', 'slide') === prompt.OBJECT_SCHEMA, 'responseSchema: none / strict / loose by mode and focus')
  ok(prompt.parseReply('Sure:\n```json\n{"edits":[{"id":"1/t1","text":"Hi"}]}\n```').kind === 'json' && (prompt.parseReply('Sure:\n```json\n{"edits":[]}\n```') as any).note === 'Sure:', 'parseReply: a fenced object, with the note before it')
  ok((prompt.parseReply('Here {"edits":[]} done') as any).value.edits.length === 0 && prompt.parseReply('just words').kind === 'text' && prompt.parseReply('{not json}').kind === 'text', 'parseReply: bare braces; prose stays prose')
}

console.log('\n— runTurn: material in, prose or an ops patch out')
{
  const turnOf = (request: string, history: any[] = []) => asst.validTurn({ request, history, focus: { index: 1, selection: [] } })!
  const openaiOf = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`
  const envWith = (replies: string[], seen: any[] = []) => ({
    t, models: async () => undefined,
    fetch: async (_u: string, init: any) => { seen.push(JSON.parse(init.body)); return { ok: true, status: 200, body: sseBody(openaiOf(replies.shift() ?? '')) } },
  })
  ok(asst.validTurn({ request: ' hi ', history: [{ role: 'tool', text: 'x' }, { role: 'user', text: 'y' }], focus: { index: -1, selection: ['a', 5] } })!.history.length === 1, 'validTurn: bounds roles, index and selection')
  ok(asst.validTurn({}) === null && asst.validTurn({ request: '' }) === null, 'validTurn: no request → null')
  // a question streams prose
  {
    const frames: any[] = []
    const io = { document: async () => MATERIAL }
    await asst.runTurn(cfgOpenai, turnOf('What is slide 2 about?'), io, (k: string, x: any) => frames.push({ kind: k, ...x }), new AbortController().signal, envWith(['It is about the world.']))
    ok(frames.some((f) => f.kind === 'assistant.chunk') && frames.at(-1).kind === 'assistant.done' && frames.at(-1).mode === 'ask' && frames.at(-1).text === 'It is about the world.', 'runTurn ask: chunks stream, done carries mode ask + text')
  }
  // an edit returns the parsed ops patch, constrained
  {
    const frames: any[] = []
    const seen: any[] = []
    await asst.runTurn(cfgOpenai, turnOf('make the title bolder'), { document: async () => MATERIAL }, (k: string, x: any) => frames.push({ kind: k, ...x }), new AbortController().signal, envWith(['{"style":[{"id":"1/t1","weight":"bold"}]}'], seen))
    ok(frames.length === 1 && frames[0].kind === 'assistant.done' && frames[0].mode === 'edit' && frames[0].ops.style[0].weight === 'bold' && frames[0].focus === 'slide' && frames[0].note === '', 'runTurn edit: no chunks, done carries the ops object + focus')
    ok(seen[0].response_format?.json_schema?.schema === prompt.OBJECT_SCHEMA || JSON.stringify(seen[0].response_format?.json_schema?.schema) === '{"type":"object"}', 'runTurn edit with focus: the loose schema constrains the reply')
  }
  // prose back → one nudge → ops
  {
    const frames: any[] = []
    const seen: any[] = []
    await asst.runTurn(cfgOpenai, turnOf('make the title bolder'), { document: async () => MATERIAL }, (k: string, x: any) => frames.push({ kind: k, ...x }), new AbortController().signal, envWith(['I would make it bold.', 'Ok {"style":[{"id":"1/t1","weight":"bold"}]}'], seen))
    ok(seen.length === 2 && seen[1].messages.at(-1).content === prompt.RETRY_NUDGE && seen[1].messages.at(-2).content === 'I would make it bold.', 'runTurn edit: a prose reply gets exactly one nudge, with the prose as the assistant turn')
    ok(frames.at(-1).mode === 'edit' && frames.at(-1).ops.style && frames.at(-1).note === 'Ok', 'runTurn edit: the nudged reply\'s patch, its note kept')
  }
  // prose twice → text
  {
    const frames: any[] = []
    await asst.runTurn(cfgOpenai, turnOf('make the title bolder'), { document: async () => MATERIAL }, (k: string, x: any) => frames.push({ kind: k, ...x }), new AbortController().signal, envWith(['No.', 'Still no.']))
    ok(frames.at(-1).kind === 'assistant.done' && frames.at(-1).mode === 'edit' && frames.at(-1).text === 'Still no.' && !('ops' in frames.at(-1)), 'runTurn edit: prose after the nudge is handed over as text')
  }
  // a small window: outline only, strict schema, a note in our words
  {
    const frames: any[] = []
    const seen: any[] = []
    const small = { ...asst.normalizeConfig({ provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'tiny', contextTokens: 2130 }, false) }
    await asst.runTurn(small, turnOf('make the title bolder'), { document: async () => MATERIAL }, (k: string, x: any) => frames.push({ kind: k, ...x }), new AbortController().signal, envWith(['{"edits":[{"id":"1/t1","text":"HELLO"}]}'], seen))
    ok(frames.at(-1).focus === 'none' && frames.at(-1).note === 'asstOutlineOnly' && JSON.stringify(seen[0].response_format.json_schema.schema) === JSON.stringify(prompt.OPS_SCHEMA), 'runTurn edit, small window: focus none, the strict schema, a note saying only the outline fit')
  }
  // nothing fits → error with the numbers
  {
    const frames: any[] = []
    const tiny = asst.normalizeConfig({ provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'tiny', contextTokens: 1000 }, false)
    let fetched = 0
    await asst.runTurn(tiny, turnOf('make the title bolder'), { document: async () => MATERIAL }, (k: string, x: any) => frames.push({ kind: k, ...x }), new AbortController().signal, { t, fetch: async () => { fetched++; throw new Error('no') }, models: async () => undefined })
    ok(frames.length === 1 && frames[0].kind === 'assistant.error' && frames[0].code === 'window' && /^asstWindow\|[\d,.]+\|1,000$/.test(frames[0].reason) && fetched === 0, 'runTurn: nothing fits → error code window with the numbers, no request made')
  }
  // no material → error; abort mid-way → silence
  {
    const frames: any[] = []
    await asst.runTurn(cfgOpenai, turnOf('hi'), { document: async () => null }, (k: string, x: any) => frames.push({ kind: k, ...x }), new AbortController().signal, envWith([]))
    ok(frames.length === 1 && frames[0].kind === 'assistant.error' && frames[0].code === 'document', 'runTurn: the page not answering with material → error code document')
    const ac = new AbortController()
    const f2: any[] = []
    await asst.runTurn(cfgOpenai, turnOf('hi'), { document: async () => { ac.abort(); return MATERIAL } }, (k: string, x: any) => f2.push({ kind: k, ...x }), ac.signal, envWith(['x']))
    ok(f2.length === 0, 'runTurn: aborted while the page answered → nothing emitted')
  }
  // the window resolution
  ok(await asst.windowFor(cfgOpenai, { models: async () => undefined }) === 128000 && await asst.windowFor({ provider: 'builtin' } as any, { builtinTokens: async () => 6144 }) === 6144 && await asst.windowFor({ provider: 'builtin' } as any, { builtinTokens: async () => null }) === prompt.ASSUMED_WINDOW_LOCAL, 'windowFor: the family, the quota, the assumption')
}

console.log('\n— the turn over the port: consent first, then the deck is asked for')
{
  ;(globalThis as any).fetch = async () => ({ ok: true, status: 200, body: sseBody('data: {"choices":[{"delta":{"content":"{\\"edits\\":[]}"}}]}\n\ndata: [DONE]\n\n') })
  store[asst.CONFIG_KEY] = { provider: 'openai', baseUrl: `https://gw.example/${TENANT}/v1`, model: 'm', key: KEY }
  store[asst.ALLOWED_KEY] = {}
  const NEW = { url: 'file:///Users/x/Decks/Turn.bento.html', frameId: 0, id: 'ext-id' }
  const port = fakePort(NEW)
  bg.serveAssistantPort(port)
  const before = windowsOpened.length
  port.send({ op: 'assistant.turn', id: 'asst-t1', payload: { request: 'make it bold', history: [], focus: { index: 0, selection: [] } } })
  await until(() => windowsOpened.length > before)
  ok(port.out.length === 1 && port.out[0].result.ok === true && !port.out.some((m: any) => m.kind === 'assistant.document'), 'turn from a new file: accepted, consent asked, and the deck NOT asked for yet')
  // a document answer before consent is ignored
  port.send({ op: 'assistant.document', id: 'asst-t1', payload: MATERIAL })
  await settle()
  ok(!port.out.some((m: any) => m.kind === 'assistant.done'), 'a document pushed before consent goes nowhere')
  await bg.recordConsent(CONSENT_PAGE, { op: 'assistant.consent', nonce: consentNonce(windowsOpened.at(-1)!), doc: NEW.url, allow: true })
  await until(() => port.out.some((m: any) => m.kind === 'assistant.document'))
  ok(port.out.some((m: any) => m.kind === 'assistant.document' && m.id === 'asst-t1'), 'after Allow the extension asks the page for the material, with the turn\'s id')
  port.send({ op: 'assistant.document', id: 'asst-OTHER', payload: MATERIAL })
  await settle()
  ok(!port.out.some((m: any) => m.kind === 'assistant.done'), 'an answer with another id is ignored')
  port.send({ op: 'assistant.document', id: 'asst-t1', payload: MATERIAL })
  await until(() => port.out.some((m: any) => m.kind === 'assistant.done'))
  const done = port.out.find((m: any) => m.kind === 'assistant.done')
  ok(done.mode === 'edit' && done.ops && Array.isArray(done.ops.edits), 'the material answered → the turn runs → done carries the ops patch')
  ;(globalThis as any).fetch = fetchOk
}
{
  // relay: the document ask reaches the page as an evt; the page's answer rides the turn's port
  const r = loadRelay()
  r.deliver({ [CH]: true, dir: 'req', id: 'asst-r1', op: 'assistant.turn', payload: { request: 'x', history: [], focus: { index: 0, selection: [] } } })
  await settle()
  ok(r.ports[0].out[0].op === 'assistant.turn', 'relay: a turn opens a port and posts assistant.turn on it')
  r.ports[0].reply({ dir: 'res', id: 'asst-r1', result: { ok: true } })
  r.ports[0].reply({ dir: 'evt', id: 'asst-r1', kind: 'assistant.document' })
  ok(r.posted.at(-1).dir === 'evt' && r.posted.at(-1).kind === 'assistant.document' && r.posted.at(-1).id === 'asst-r1', 'relay: the document ask reaches the page as an evt frame')
  r.deliver({ [CH]: true, dir: 'req', id: 'asst-r1', op: 'assistant.document', payload: { outline: 'o' } })
  await settle()
  ok(r.ports[0].out.at(-1).op === 'assistant.document' && r.ports[0].out.at(-1).payload.outline === 'o' && r.sent.length === 0, 'relay: the page\'s answer goes onto that turn\'s port, never onto sendMessage')
  r.deliver({ [CH]: true, dir: 'req', id: 'asst-NOPE', op: 'assistant.document', payload: { outline: 'o' } })
  await settle()
  ok(r.posted.at(-1).dir === 'res' && r.posted.at(-1).result.ok === false, 'relay: a document for a turn this tab is not streaming is refused')
  r.ports[0].reply({ dir: 'evt', id: 'asst-r1', kind: 'assistant.done', mode: 'edit', ops: { edits: [] }, note: 'n', focus: 'slide' })
  const d = r.posted.at(-1)
  ok(d.kind === 'assistant.done' && d.mode === 'edit' && d.ops.edits.length === 0 && d.note === 'n' && d.focus === 'slide', 'relay: done forwards mode/ops/note/focus')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
