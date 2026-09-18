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
  ok(asst.httpConfigured(asst.normalizeConfig({ provider: 'openai', model: 'm' }, false)), 'httpConfigured: openai needs no key (local servers)')
  ok(!asst.httpConfigured(asst.normalizeConfig({ provider: 'gemini', model: 'm' }, false)), 'httpConfigured: gemini needs a key')
}
{
  const d = await asst.describe(cfgOpenai, { t })
  ok(d.ok === true && d.host === 'gw.example' && d.model === 'm' && d.configured === true, 'describe: host, model, configured')
  const s = JSON.stringify(d)
  ok(!s.includes(KEY) && !s.includes(TENANT), 'describe: neither the key nor the base URL path leaks')
  ok(Object.keys(d).sort().join() === 'configured,host,model,ok', 'describe: exactly the contract\'s fields')
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
  ok(d.ok === true && d.host === 'gw.example' && Object.keys(d).sort().join() === 'configured,host,model,ok', 'assistant.describe over sendMessage: the bounded shape')
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

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
