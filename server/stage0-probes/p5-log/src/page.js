// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// P5's instructions page. Sends nothing unless the person presses Send.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export function page(origin) {
  const o = esc(origin)
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Probe P5 log canary</title>
<style>
:root { color-scheme: light dark; --bg: #fbfaf7; --fg: #1e2a3a; --muted: #5b6573; --line: #d9d6cf; --accent: #b4532a; }
@media (prefers-color-scheme: dark) { :root { --bg: #14181f; --fg: #eceae4; --muted: #a3aab5; --line: #343a45; --accent: #f08a5d; } }
* { box-sizing: border-box; } body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 900px; margin: 0 auto; padding: 16px; } h1 { font-size: 22px; } p, li { max-width: 72ch; }
.tag { font-size: 12px; padding: 1px 8px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); }
pre, textarea { font: 13px/1.4 ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-all; border: 1px solid var(--line); border-radius: 8px; padding: 8px; width: 100%; background: transparent; color: inherit; }
button, select, input[type=text] { font: inherit; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: inherit; min-height: 36px; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
table { border-collapse: collapse; width: 100%; } td { border-top: 1px solid var(--line); padding: 6px 4px; vertical-align: top; }
.muted { color: var(--muted); }
</style></head>
<body><main>
<span class="tag">stage-0 measurement probe · P5 log canary</span>
<h1>What does Cloudflare keep about a request?</h1>
<p>Sitting C3. This Worker receives one request with a canary in its URL, in
a header and in its body. The Worker itself logs only one line,
<code>probe-logline CANARY-LOGLINE-…</code>, so you can tell "logs are off"
from "logs are on but did not keep this". It never logs the URL, headers or
body; anything of those you find in the dashboard, the platform kept.</p>
<p><b>What is sent where:</b> one POST, from your machine to <code>${o}/canary</code>,
with <code>?canary=CANARY-URL-<span class="run"></span></code>, the header
<code>X-Canary: CANARY-HDR-<span class="run"></span></code> and the body
<code>CANARY-BODY-<span class="run"></span></code>. Nothing else, and only when
you run the line below or press Send. The run id is new on every page load.</p>

<h2>1. Send the canary</h2>
<pre id="curl"></pre>
<p><button id="send">Send it from this page instead</button> <span id="sent" class="muted"></span></p>

<h2>2. Look for it</h2>
<ol>
<li>Cloudflare dashboard → Workers &amp; Pages → <b>bento-log-probe</b> → <b>Logs</b>
(and <b>Observability</b> / Workers Logs). Wait a minute, then search for <code>CANARY-</code>.</li>
<li>Tick what you found below, note where, and the retention the dashboard states.
Documentation at the time of writing gives Workers Logs retention as 3 days
(Workers Free) or 7 days (Workers Paid); the dashboard is the authority, so
write down what it says.</li>
<li>Copy results. Then redeploy with the next config (the README lists the three)
and repeat from step 1 with a fresh page load.</li>
</ol>
<table>
<tr><td>Config deployed</td><td><select id="config"><option>default (no observability block)</option><option>logs on (wrangler.toml)</option><option>logs off (wrangler.logs-off.toml)</option></select></td></tr>
<tr><td>CANARY-URL seen</td><td><select id="u"><option>-</option><option>yes</option><option>no</option></select></td></tr>
<tr><td>CANARY-HDR seen</td><td><select id="h"><option>-</option><option>yes</option><option>no</option></select></td></tr>
<tr><td>CANARY-BODY seen</td><td><select id="b"><option>-</option><option>yes</option><option>no</option></select></td></tr>
<tr><td>CANARY-LOGLINE seen (control)</td><td><select id="l"><option>-</option><option>yes</option><option>no</option></select></td></tr>
<tr><td>Where (tab, field)</td><td><input type="text" id="where" style="width:100%"></td></tr>
<tr><td>Retention the dashboard states</td><td><input type="text" id="ret" style="width:100%"></td></tr>
<tr><td>Notes</td><td><input type="text" id="notes" style="width:100%"></td></tr>
</table>
<p><button id="copy" class="primary">Copy results</button> <span id="copy-status" class="muted"></span></p>
<textarea id="result" rows="3" readonly hidden></textarea>
</main>
<script>
(() => {
  'use strict'
  const run = Math.random().toString(36).slice(2, 10)
  const origin = ${JSON.stringify(origin)}
  const $ = (id) => document.getElementById(id)
  document.querySelectorAll('.run').forEach((e) => { e.textContent = run })
  $('curl').textContent = "curl -sS -X POST '" + origin + "/canary?canary=CANARY-URL-" + run + "' -H 'X-Canary: CANARY-HDR-" + run + "' -H 'content-type: text/plain' --data 'CANARY-BODY-" + run + "'"
  let sent = 'not from this page'
  $('send').addEventListener('click', async () => {
    try {
      const r = await fetch('/canary?canary=CANARY-URL-' + run, { method: 'POST', headers: { 'X-Canary': 'CANARY-HDR-' + run, 'content-type': 'text/plain' }, body: 'CANARY-BODY-' + run })
      const j = await r.json()
      sent = 'page ' + r.status + (j.run === run ? ' run matched' : ' run MISMATCH')
    } catch (e) { sent = 'page error ' + (e && e.name) }
    $('sent').textContent = sent
  })
  const clean = (v) => String(v == null ? '' : v).replace(/[\\r\\n\\t]+/g, ' ').replace(/\\|/g, '/').trim().slice(0, 400) || '-'
  $('copy').addEventListener('click', async () => {
    const pairs = [['run', run], ['config', $('config').value], ['sent', sent], ['url', $('u').value], ['header', $('h').value], ['body', $('b').value], ['logline', $('l').value], ['where', $('where').value], ['retention', $('ret').value], ['notes', $('notes').value]]
    const text = ['P5 v1'].concat(pairs.map((p) => p[0] + '=' + clean(p[1]))).join(' | ')
    const out = $('result'); out.value = text; out.hidden = false
    let how = 'shown below; select it and copy by hand'
    try { await navigator.clipboard.writeText(text); how = 'copied to the clipboard' } catch (e) {}
    $('copy-status').textContent = 'Results ' + how + '.'
    $('copy').dataset.copied = '1'
  })
})()
</script>
</body></html>`
}
