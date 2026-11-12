#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The relay's blob routes answer an R2 or body-stream failure with a status,
// never an uncaught exception.
//
//   node scripts/test-relay-blob-errors.ts
//
// WHY. `BLOBS.put` throws in two ordinary situations: R2 refuses concurrent
// writes to one object key (error 10058), and an upload whose client goes away
// mid-body ends in "Network connection lost". The blob route had no catch, so
// both became Cloudflare's opaque 1101 page and a scriptThrewException — about
// 1.6k PUTs a day on the live relay in November 2026, most of them from clients
// uploading one picture several times at once. The client cannot back off from
// an HTML error page it cannot tell apart from an outage; it can from 429/503
// with retry-after.

// The harness swaps in a FakeResponse for the DO rigs; this rig needs real
// headers, so keep the platform's Response and put it back after loading it.
const NativeResponse = globalThis.Response
const { ok, finish } = await import('./lib/relay-harness.ts')
globalThis.Response = NativeResponse

const worker = (await import('../server/sync-worker/src/worker.js')).default as {
  fetch(req: unknown, env: unknown): Promise<{ status: number; headers: { get(k: string): string | null }; text(): Promise<string> }>
}

function env(put: () => Promise<unknown>, authz = 200) {
  return {
    ROOM: {
      idFromName: (n: string) => n,
      get: () => ({ fetch: async () => new Response(JSON.stringify(authz === 200 ? { reserved: 1 } : { error: 'room-blobs-full' }), { status: authz }) }),
    },
    BLOBS: { head: async () => null, put, get: async () => null },
  }
}
const putReq = () => ({
  url: 'https://sync.test/b/wRoom/' + 'k'.repeat(24) + '?tok=tok_0123456789',
  method: 'PUT',
  body: null,
  headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? '1000' : null) },
})

async function call(put: () => Promise<unknown>, authz = 200) {
  try {
    return { res: await worker.fetch(putReq(), env(put, authz)), threw: null as unknown }
  } catch (e) {
    return { res: null, threw: e }
  }
}

console.log('blob PUT failures become statuses, not exceptions…')
{
  const good = await call(async () => ({}))
  ok(!good.threw && good.res?.status === 200, `positive control: a stored PUT answers 200 (${good.res?.status ?? String(good.threw)})`)

  const busy = await call(async () => { throw new Error('put: Reduce your concurrent request rate for the same object. (10058)') })
  ok(!busy.threw, `R2's same-key limit does not escape as an exception (${String(busy.threw ?? '')})`)
  ok(busy.res?.status === 429, `it answers 429 (${busy.res?.status})`)
  ok(!!busy.res?.headers.get('retry-after'), 'with retry-after')
  ok(!!busy.res?.headers.get('access-control-allow-origin'), 'and CORS, so a browser can read the status at all')

  const lost = await call(async () => { throw new Error('Network connection lost.') })
  ok(!lost.threw, `an upload cut off mid-body does not escape as an exception (${String(lost.threw ?? '')})`)
  ok(lost.res?.status === 503, `it answers 503 (${lost.res?.status})`)
}

console.log('a refusal is returned as itself, and nothing is written…')
{
  // The catch must never turn a denial into something else, and a denied PUT
  // must never reach the bucket. These pass on the code before the catch too:
  // they pin that the catch did not change them.
  let puts = 0
  const put = async () => { puts++; return {} }
  const denied = await call(put, 403)
  ok(denied.res?.status === 403 && puts === 0, `authz 403 answers 403 and nothing is stored (${denied.res?.status}, ${puts} puts)`)
  const full = await call(put, 507)
  ok(full.res?.status === 507 && puts === 0, `a full room answers 507 and nothing is stored (${full.res?.status}, ${puts} puts)`)
}

finish('relay blob errors')
