// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Stage-0 probe P6: a slow remote MCP server (sittings C4, C5; rows 10, 11).
// Two tools, nothing else:
//   sleep(seconds)    waits, then answers. Annotated as a WRITE tool
//                     (readOnlyHint false), so C5 can ask whether a plan
//                     without developer mode may call one at all.
//   big(kilobytes)    answers with exactly that many KiB of text, framed by
//                     BEGIN-<n>KB and END-<n>KB, so a cut-off result shows.
//
// MCP Streamable HTTP, stateless: POST /mcp takes JSON-RPC and answers with
// application/json; no session id, no server-sent events, no auth (the vendors
// allow an authless custom connector for testing). It stores nothing and logs
// nothing (observability off in wrangler.toml). GET / is the instructions page.

import { page } from './page.js'

const SERVER = { name: 'bento-stage0-slow-probe', version: '1.0.0' }
const KNOWN = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']
const MAX_SLEEP = 900
const MAX_KB = 20000

export const TOOLS = [
  {
    name: 'sleep',
    title: 'Sleep (a write tool, for testing)',
    description: 'Stage-0 test tool. Waits the given number of seconds, then says how long it waited. Marked as a write tool on purpose; it changes nothing.',
    inputSchema: { type: 'object', properties: { seconds: { type: 'number', minimum: 0, maximum: MAX_SLEEP, description: 'Seconds to wait (0 to 900).' } }, required: ['seconds'] },
    annotations: { title: 'Sleep', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'big',
    title: 'Big result (for testing)',
    description: 'Stage-0 test tool. Returns exactly the given number of kilobytes (KiB) of filler text between BEGIN-<n>KB and END-<n>KB markers.',
    inputSchema: { type: 'object', properties: { kilobytes: { type: 'integer', minimum: 1, maximum: MAX_KB, description: 'Size of the result in KiB (1 to 20000).' } }, required: ['kilobytes'] },
    annotations: { title: 'Big result', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
]

/** Exactly kb*1024 bytes of ASCII: a BEGIN line, numbered filler lines, an END line. */
export function bigText(kb) {
  const total = kb * 1024
  const begin = 'BEGIN-' + kb + 'KB\n'
  const end = 'END-' + kb + 'KB total ' + total + ' bytes\n'
  let body = ''
  const room = total - begin.length - end.length
  if (room < 0) return (begin + end).slice(0, total)
  const lines = []
  let used = 0
  for (let i = 1; used + 64 <= room; i++) {
    const head = 'line ' + String(i).padStart(7, '0') + ' '
    lines.push(head + '.'.repeat(63 - head.length) + '\n')
    used += 64
  }
  body = lines.join('') + '.'.repeat(room - used)
  return begin + body + end
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))
const result = (id, value) => ({ jsonrpc: '2.0', id, result: value })
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], isError })

async function call(name, args) {
  if (name === 'sleep') {
    const s = Number(args && args.seconds)
    if (!Number.isFinite(s) || s < 0 || s > MAX_SLEEP) return text('seconds must be a number from 0 to ' + MAX_SLEEP, true)
    const start = new Date()
    await sleepMs(s * 1000)
    return text('slept ' + s + ' s (started ' + start.toISOString() + ', finished ' + new Date().toISOString() + ')')
  }
  if (name === 'big') {
    const kb = Number(args && args.kilobytes)
    if (!Number.isInteger(kb) || kb < 1 || kb > MAX_KB) return text('kilobytes must be an integer from 1 to ' + MAX_KB, true)
    return text(bigText(kb))
  }
  return null
}

export async function handle(msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return error(null, -32600, 'Invalid Request')
  const isRequest = typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null
  if (!isRequest) return null // notifications and responses: nothing to answer
  const { id, method, params } = msg
  if (method === 'initialize') {
    const asked = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
    // Echo any date-shaped version (a newer client gets its own revision back:
    // this server's surface is the same in every revision); else the newest known.
    const protocolVersion = /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : KNOWN[KNOWN.length - 1]
    return result(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER,
      instructions: 'A test server for measuring tool-call timeouts and result sizes. sleep waits; big returns filler text. Neither reads or changes anything.',
    })
  }
  if (method === 'ping') return result(id, {})
  if (method === 'tools/list') return result(id, { tools: TOOLS })
  if (method === 'tools/call') {
    const r = await call(params && params.name, params && params.arguments)
    return r ? result(id, r) : error(id, -32602, 'Unknown tool: ' + String(params && params.name))
  }
  return error(id, -32601, 'Method not found: ' + method)
}

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' }

export default {
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(page(url.origin), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
        },
      })
    }
    if (url.pathname !== '/mcp') return new Response('not found', { status: 404 })
    if (request.method !== 'POST') return new Response('POST only (this server opens no event stream)', { status: 405, headers: { allow: 'POST' } })
    let body
    try { body = await request.json() } catch { return Response.json(error(null, -32700, 'Parse error'), { status: 400, headers: JSON_HEADERS }) }
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(handle))).filter(Boolean)
      return out.length ? new Response(JSON.stringify(out), { headers: JSON_HEADERS }) : new Response(null, { status: 202 })
    }
    const out = await handle(body)
    return out ? new Response(JSON.stringify(out), { headers: JSON_HEADERS }) : new Response(null, { status: 202 })
  },
}
