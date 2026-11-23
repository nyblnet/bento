// Minimal: a fresh context, a new page, one navigation off about:blank, one evaluate.
// Does the evaluate ever hang (Juggler losing the main world)? Variants: a plain page; a page
// that registers a service worker; the same with a strict CSP.
import http from 'node:http'
const pw = await import(process.env.PLAYWRIGHT_MODULE)
const N = +(process.env.N || 100)
const variant = process.env.V || 'plain'
const page = (sw) => `<!doctype html><title>t</title><p>hi</p>${sw ? "<script>navigator.serviceWorker.register('/sw.js').then(()=>document.documentElement.dataset.sw='1')</script>" : ''}`
const srv = http.createServer((q, r) => {
  if (q.url === '/sw.js') { r.writeHead(200, { 'content-type': 'text/javascript' }); return r.end("self.addEventListener('fetch',()=>{})") }
  const h = { 'content-type': 'text/html' }
  if (variant === 'csp' || variant.startsWith('coop')) h['content-security-policy'] = "default-src 'none'; script-src 'unsafe-inline'; worker-src 'self'; frame-ancestors 'none'"
  if (variant.startsWith('coop') && q.url !== '/probe.html') h['cross-origin-opener-policy'] = 'same-origin-allow-popups'
  r.writeHead(200, h); r.end(page(variant !== 'plain'))
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${srv.address().port}/`
const b = await pw.firefox.launch()
let hung = 0
for (let i = 0; i < N; i++) {
  const ctx = await b.newContext()
  const p = await ctx.newPage()
  if (variant === 'coop-warm') await p.goto(url + 'probe.html')
  await p.goto(url)
  const ok = await Promise.race([p.evaluate(() => document.readyState).then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))])
  if (!ok) { hung++; console.log(`hang at iteration ${i}`) }
  await Promise.race([ctx.close(), new Promise((r) => setTimeout(r, 5000))])
}
console.log(`juggler repro (${variant}): ${hung} of ${N} first-navigation evaluates hung`)
await b.close(); srv.close()
