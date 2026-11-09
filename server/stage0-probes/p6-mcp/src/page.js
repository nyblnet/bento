// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// P6's instructions page. Sends nothing.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export function page(origin) {
  const mcp = esc(origin + '/mcp')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Probe P6 slow MCP</title>
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
<span class="tag">stage-0 measurement probe · P6 slow MCP server</span>
<h1>How long and how big can a tool call be?</h1>
<p>Sittings C4 and C5. A remote MCP server with two tools: <code>sleep(seconds)</code>
waits and answers (it is marked as a <b>write</b> tool, on purpose; it changes
nothing) and <code>big(kilobytes)</code> returns that much filler text between
<code>BEGIN-&lt;n&gt;KB</code> and <code>END-&lt;n&gt;KB</code>. It has no
sign-in, stores nothing and logs nothing. What the AI product sends it is the
tool name and the number you asked for.</p>
<p>Connector URL: <code id="url">${mcp}</code></p>
<h2>C4: timeouts and sizes</h2>
<ol>
<li>claude.ai → Settings → Connectors → <b>Add custom connector</b>, URL above. Then
ChatGPT → Settings → Connectors (developer mode) → add it.</li>
<li>Ask each: "Call sleep with 10", then 30, 60, 120, 300.</li>
<li>Then "Call big with 10", then 100, 500, 1000, 5000. A result came through
whole when the AI can quote the <code>END-&lt;n&gt;KB total … bytes</code> line.</li>
<li>Fill in one line per product and Copy results.</li>
</ol>
<h2>C5: a plan without developer mode</h2>
<p>ChatGPT on Plus or Free: Settings → Connectors. Can you add a custom MCP server
at all? If yes, add this one and ask it to call <code>sleep 1</code>. Screenshot.</p>
<table>
<tr><td>Product and plan</td><td><input type="text" id="product" placeholder="e.g. claude.ai Max, ChatGPT Pro (developer mode)" style="width:100%"></td></tr>
<tr><td>Longest sleep that returned (s)</td><td><input type="text" id="sok" style="width:100%"></td></tr>
<tr><td>First sleep that did not (s) and its error text</td><td><input type="text" id="sfail" style="width:100%"></td></tr>
<tr><td>Biggest big that came through whole (KB)</td><td><input type="text" id="bok" style="width:100%"></td></tr>
<tr><td>First big that did not (KB) and what happened</td><td><input type="text" id="bfail" style="width:100%"></td></tr>
<tr><td>C5: could add a custom server</td><td><select id="add"><option>-</option><option>yes</option><option>no</option><option>n/a</option></select></td></tr>
<tr><td>C5: sleep 1 (a write tool) ran</td><td><select id="write"><option>-</option><option>yes</option><option>no</option><option>asked to confirm</option><option>n/a</option></select></td></tr>
<tr><td>Notes</td><td><input type="text" id="notes" style="width:100%"></td></tr>
</table>
<p><button id="copy" class="primary">Copy results</button> <span id="copy-status" class="muted"></span></p>
<textarea id="result" rows="3" readonly hidden></textarea>
</main>
<script>
(() => {
  'use strict'
  const $ = (id) => document.getElementById(id)
  const clean = (v) => String(v == null ? '' : v).replace(/[\\r\\n\\t]+/g, ' ').replace(/\\|/g, '/').trim().slice(0, 400) || '-'
  $('copy').addEventListener('click', async () => {
    const pairs = [['product', $('product').value], ['sleep-ok', $('sok').value], ['sleep-fail', $('sfail').value], ['big-ok', $('bok').value], ['big-fail', $('bfail').value], ['can-add', $('add').value], ['write-call', $('write').value], ['notes', $('notes').value]]
    const text = ['P6 v1'].concat(pairs.map((p) => p[0] + '=' + clean(p[1]))).join(' | ')
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
