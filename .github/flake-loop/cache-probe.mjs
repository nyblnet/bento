import http from 'node:http'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
const pw = await import(process.env.PLAYWRIGHT_MODULE)
const engine = process.env.E || 'webkit'
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': q.url.endsWith('.js') ? 'text/javascript' : 'text/html', 'cache-control': process.env.CC || 'no-cache' }); r.end(q.url.endsWith('.js') ? "self.addEventListener('install',e=>e.waitUntil((async()=>{const c=await caches.open('swc');await c.put('/a',new Response('aaa'));await c.put('/b',await fetch('/b.txt'))})()));self.addEventListener('activate',e=>e.waitUntil(clients.claim()))" : '<p>hi</p>') })
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const O = `http://127.0.0.1:${srv.address().port}`
for (const persistent of [false, true]) {
  const ctx = persistent ? await pw[engine].launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'wkp-'))) : await (await pw[engine].launch()).newContext()
  const p = await ctx.newPage(); await p.goto(O + '/')
  const fromPage = await p.evaluate(async () => { const c = await caches.open('pagec'); await c.put('/x', new Response('xxx')); await c.put('/y', await fetch('/y.txt')); return { keys: (await c.keys()).length, match: await (await c.match('/x'))?.text() } })
  const sw = await p.evaluate(async () => { const r = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; const c = await caches.open('swc'); return { state: r.active?.state, names: await caches.keys(), keys: (await c.keys()).map((q) => q.url), a: await (await c.match('/a'))?.text() } })
  console.log(engine, persistent ? 'persistent' : 'ephemeral', JSON.stringify({ fromPage, sw }))
  await ctx.close()
}
srv.close(); process.exit(0)
