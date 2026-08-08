// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// A single-page compile → review → create form served at `/`. Stands in for
// the real multi-step app (prompt template page, tolerant paste/review flow,
// placeholder upload UI) planned for a follow-up PR on Cloudflare Pages —
// this exists so the Worker is testable end-to-end (compile → create → view
// → present) right after a manual dashboard deploy, with nothing else to
// stand up. Two steps, mirroring the real flow: compile an outline (or skip
// straight to pasting a full bento/slides doc — the "advanced" escape
// hatch), review/edit the JSON, then create.

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

const EXAMPLE_OUTLINE = {
  title: 'Platform demo',
  theme: { background: '#0D1B2E', color: '#F5F7FA', accent: '#E8442E' },
  slides: [
    { layout: 'title', heading: 'Compiled, not typed', subheading: 'From an outline, via POST /api/compile', morphGroup: 'cover' },
    { layout: 'title', heading: 'Compiled, not typed', subheading: 'Same headline, new frame — that’s morph', morphGroup: 'cover' },
    { layout: 'bullets', heading: 'What this exercises', bullets: [
      'Layout geometry from slides/src/model.ts’s own builtinLayouts()',
      'Theme colors applied consistently across slide kinds',
      'A morphGroup pairing two titles via morphId',
    ] },
    { layout: 'stat', heading: 'Headline number', value: 2450, label: 'Decks compiled so far (not really)' },
    { layout: 'chart', heading: 'Bar chart from data', chartType: 'bar', categories: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'Revenue', data: [420, 780, 1300, 2450] }] },
    { layout: 'table', heading: 'A comparison', columns: ['Plan', 'Price'], rows: [['Basic', '$9'], ['Pro', '$29']] },
    { layout: 'quote', quote: 'The compiler picks the feature; you just write the outline.', attribution: 'This demo' },
  ],
}

export function renderDemoPage(): string {
  const exampleJson = JSON.stringify(EXAMPLE_DOC, null, 2)
  const exampleOutlineJson = JSON.stringify(EXAMPLE_OUTLINE, null, 2)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bento platform — compile &amp; create a deck</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 760px; margin: 48px auto; padding: 0 20px; }
  h1 { font-size: 22px; }
  textarea { width: 100%; height: 320px; font: 13px/1.4 ui-monospace, monospace; box-sizing: border-box; }
  button { font: inherit; padding: 8px 16px; cursor: pointer; }
  #status, #compileStatus { margin-top: 12px; white-space: pre-wrap; }
  .err { color: #c0392b; }
  .ok { color: #1a7f37; }
  code { background: rgba(127,127,127,0.15); padding: 1px 4px; border-radius: 3px; }
</style>
</head>
<body>
<h1>Bento platform — compile &amp; create a deck</h1>

<h2>1. Compile from an outline</h2>
<p>The small structured schema a chat AI's prompt template (not built yet —
this is what it will target) asks for. See <code>platform/worker/src/compile/schema.ts</code>
for the full shape and every layout kind.</p>
<textarea id="outline" spellcheck="false"></textarea>
<p>
  <button id="loadOutlineExample" type="button">Load example outline</button>
  <button id="compile" type="button">Compile →</button>
</p>
<div id="compileStatus"></div>

<h2>2. Review the compiled JSON, or paste your own</h2>
<p>Compiling fills this in; you can also paste a full <code>bento/slides</code>
document directly here (the "advanced" path — same JSON that lives in a
<code>.bento.html</code> file's <code>#bento-doc</code> block).</p>
<textarea id="doc" spellcheck="false"></textarea>
<p>
  <button id="loadExample" type="button">Load example doc</button>
  <button id="create" type="button">Create deck</button>
</p>
<div id="status"></div>
<script>
document.getElementById('loadOutlineExample').onclick = () => {
  document.getElementById('outline').value = ${JSON.stringify(exampleOutlineJson)}
}
document.getElementById('compile').onclick = async () => {
  const cstatus = document.getElementById('compileStatus')
  cstatus.className = ''
  cstatus.textContent = 'Compiling…'
  let outline
  try {
    outline = JSON.parse(document.getElementById('outline').value)
  } catch (e) {
    cstatus.className = 'err'
    cstatus.textContent = 'Not valid JSON: ' + e.message
    return
  }
  try {
    const res = await fetch('/api/compile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outline }),
    })
    const body = await res.json()
    if (!res.ok) {
      cstatus.className = 'err'
      cstatus.textContent = 'Rejected:\\n' + (body.errors || []).map(e => e.field + ': ' + e.message).join('\\n')
      return
    }
    document.getElementById('doc').value = JSON.stringify(body.doc, null, 2)
    cstatus.className = 'ok'
    cstatus.textContent = 'Compiled — filled the JSON into step 2 below. Review it, then Create deck.'
  } catch (e) {
    cstatus.className = 'err'
    cstatus.textContent = 'Request failed: ' + e.message
  }
}
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
