// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// A single-page paste-and-create form served at `/`. Stands in for the real
// multi-step app (prompt template → paste → review → assets) planned for a
// follow-up PR on Cloudflare Pages — this exists so the Worker is testable
// end-to-end (create → view → present) right after a manual dashboard
// deploy, with nothing else to stand up. It accepts a full bento/slides doc
// JSON directly (the "advanced: paste full Bento JSON" escape hatch); the
// outline-schema compiler that turns a chat AI's structured answer into this
// shape is deliberately out of scope for this PR.

const EXAMPLE_DOC = {
  format: 'bento/slides',
  version: 1,
  title: 'Hello from the platform',
  size: { width: 1280, height: 720 },
  theme: { background: '#0D1B2E', color: '#F5F7FA', accent: '#E8442E', fontFamily: 'system-ui' },
  slides: [
    {
      id: 's1',
      background: '#0D1B2E',
      transition: 'none',
      notes: '',
      elements: [
        {
          id: 'headline',
          type: 'text',
          x: 96,
          y: 260,
          w: 1088,
          h: 200,
          html: 'Pasted, stored, served.',
          fontSize: 96,
          fontFamily: 'system-ui',
          fontWeight: 900,
          color: '#F5F7FA',
          align: 'left',
          valign: 'top',
          lineHeight: 1,
          rotation: 0,
          opacity: 1,
        },
        {
          id: 'bar',
          type: 'shape',
          shape: 'rect',
          x: 96,
          y: 220,
          w: 160,
          h: 12,
          fill: '#E8442E',
          stroke: 'none',
          strokeWidth: 0,
          radius: 0,
          rotation: 0,
          opacity: 1,
        },
      ],
    },
  ],
}

export function renderDemoPage(): string {
  const exampleJson = JSON.stringify(EXAMPLE_DOC, null, 2)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bento platform — create a deck</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 760px; margin: 48px auto; padding: 0 20px; }
  h1 { font-size: 22px; }
  textarea { width: 100%; height: 320px; font: 13px/1.4 ui-monospace, monospace; box-sizing: border-box; }
  button { font: inherit; padding: 8px 16px; cursor: pointer; }
  #status { margin-top: 12px; white-space: pre-wrap; }
  #status.err { color: #c0392b; }
  #status.ok { color: #1a7f37; }
  code { background: rgba(127,127,127,0.15); padding: 1px 4px; border-radius: 3px; }
</style>
</head>
<body>
<h1>Bento platform — create a deck</h1>
<p>Paste a full <code>bento/slides</code> document (the JSON that lives in a
<code>.bento.html</code> file's <code>#bento-doc</code> block). This is the
"advanced / paste raw JSON" path — the outline-schema paste flow lands in a
follow-up.</p>
<textarea id="doc" spellcheck="false"></textarea>
<p>
  <button id="loadExample" type="button">Load example</button>
  <button id="create" type="button">Create deck</button>
</p>
<div id="status"></div>
<script>
document.getElementById('loadExample').onclick = () => {
  document.getElementById('doc').value = ${JSON.stringify(exampleJson)}
}
document.getElementById('create').onclick = async () => {
  const status = document.getElementById('status')
  status.className = ''
  status.textContent = 'Creating…'
  let doc
  try {
    doc = JSON.parse(document.getElementById('doc').value)
  } catch (e) {
    status.className = 'err'
    status.textContent = 'Not valid JSON: ' + e.message
    return
  }
  try {
    const res = await fetch('/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc }),
    })
    const body = await res.json()
    if (!res.ok) {
      status.className = 'err'
      status.textContent = 'Rejected:\\n' + (body.errors || []).map(e => e.field + ': ' + e.message).join('\\n')
      return
    }
    status.className = 'ok'
    status.textContent =
      'Created ' + body.id + '\\n' +
      'View:     ' + location.origin + '/d/' + body.id + '\\n' +
      'Present:  ' + location.origin + '/d/' + body.id + '#present\\n' +
      'Download: ' + location.origin + '/d/' + body.id + '/download\\n' +
      'Edit token (save this — shown once): ' + body.editToken
  } catch (e) {
    status.className = 'err'
    status.textContent = 'Request failed: ' + e.message
  }
}
</script>
</body>
</html>`
}
