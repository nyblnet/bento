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
//
// Styling is hand-written CSS, no framework — this repo runs on a strict
// zero-external-dependency ethos (slides/src/charts.ts dropped ECharts for
// its own engine specifically over size/dependency cost; see CLAUDE.md).
// A CDN-hosted framework would violate that AND add a live network
// dependency to a page whose whole point is working right after a fresh
// deploy. Deliberately dark-only (not adaptive to light mode) — matches the
// navy/accent palette already used in EXAMPLE_DOC/EXAMPLE_OUTLINE below, and
// this is a small enough surface that committing to one look beats
// maintaining two palettes.

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
  :root {
    --bg: #0D1B2E;
    --bg-elev: #0A1524;
    --card: #142338;
    --border: rgba(245,247,250,0.12);
    --border-strong: rgba(245,247,250,0.22);
    --text: #F5F7FA;
    --text-dim: #93A2BA;
    --accent: #E8442E;
    --accent-hover: #FF5B3F;
    --ok-bg: rgba(45,164,78,0.16);
    --ok-fg: #5BD584;
    --err-bg: rgba(232,68,46,0.14);
    --err-fg: #FF8A76;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  }
  .wrap { max-width: 880px; margin: 0 auto; padding: 56px 24px 80px; }
  header.hero { margin-bottom: 36px; }
  h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.01em; margin: 0 0 8px; }
  h1 span { color: var(--accent); }
  .subtitle { color: var(--text-dim); font-size: 15px; margin: 0; max-width: 60ch; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 28px; margin-bottom: 24px; }
  .step-label {
    display: inline-block; font-size: 12px; font-weight: 700; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--accent); margin-bottom: 10px;
  }
  h2 { font-size: 19px; font-weight: 700; margin: 0 0 10px; }
  .card > p { color: var(--text-dim); margin: 0 0 16px; font-size: 14px; }
  textarea {
    display: block; width: 100%; min-height: 260px; background: var(--bg-elev); color: var(--text);
    border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; resize: vertical;
  }
  textarea:focus { outline: none; border-color: var(--accent); }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
  button {
    font: inherit; font-weight: 600; font-size: 14px; padding: 10px 18px; border-radius: 8px;
    border: 1px solid var(--border-strong); background: transparent; color: var(--text); cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  button:hover { background: rgba(245,247,250,0.07); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  .status { margin-top: 16px; padding: 12px 14px; border-radius: 8px; font-size: 13px; white-space: pre-wrap; display: none; }
  .status.err { display: block; background: var(--err-bg); color: var(--err-fg); }
  .status.ok { display: block; background: var(--ok-bg); color: var(--ok-fg); }
  code { background: rgba(245,247,250,0.1); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  @media (max-width: 600px) {
    .wrap { padding: 32px 16px 60px; }
    h1 { font-size: 23px; }
    .card { padding: 18px; border-radius: 10px; margin-bottom: 18px; }
    textarea { min-height: 200px; font-size: 12px; }
    .actions { flex-direction: column; }
    .actions button { width: 100%; }
  }
</style>
</head>
<body>
<div class="wrap">
<header class="hero">
  <h1>Bento platform <span>·</span> compile &amp; create</h1>
  <p class="subtitle">Two steps: compile a small structured outline into a real deck, review the JSON, create it.</p>
</header>

<section class="card">
  <div class="step-label">Step 1</div>
  <h2>Compile from an outline</h2>
  <p>The small structured schema a chat AI's prompt template (not built yet —
  this is what it will target) asks for. See <code>platform/worker/src/compile/schema.ts</code>
  for the full shape and every layout kind.</p>
  <textarea id="outline" spellcheck="false"></textarea>
  <div class="actions">
    <button id="loadOutlineExample" type="button">Load example outline</button>
    <button id="compile" class="primary" type="button">Compile →</button>
  </div>
  <div id="compileStatus" class="status"></div>
</section>

<section class="card">
  <div class="step-label">Step 2</div>
  <h2>Review the compiled JSON, or paste your own</h2>
  <p>Compiling fills this in; you can also paste a full <code>bento/slides</code>
  document directly here (the "advanced" path — same JSON that lives in a
  <code>.bento.html</code> file's <code>#bento-doc</code> block).</p>
  <textarea id="doc" spellcheck="false"></textarea>
  <div class="actions">
    <button id="loadExample" type="button">Load example doc</button>
    <button id="create" class="primary" type="button">Create deck</button>
  </div>
  <div id="status" class="status"></div>
</section>
</div>
<script>
document.getElementById('loadOutlineExample').onclick = () => {
  document.getElementById('outline').value = ${JSON.stringify(exampleOutlineJson)}
}
document.getElementById('compile').onclick = async () => {
  const cstatus = document.getElementById('compileStatus')
  cstatus.className = 'status'
  cstatus.textContent = 'Compiling…'
  cstatus.style.display = 'block'
  let outline
  try {
    outline = JSON.parse(document.getElementById('outline').value)
  } catch (e) {
    cstatus.className = 'status err'
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
      cstatus.className = 'status err'
      cstatus.textContent = 'Rejected:\\n' + (body.errors || []).map(e => e.field + ': ' + e.message).join('\\n')
      return
    }
    document.getElementById('doc').value = JSON.stringify(body.doc, null, 2)
    cstatus.className = 'status ok'
    cstatus.textContent = 'Compiled — filled the JSON into step 2 below. Review it, then Create deck.'
  } catch (e) {
    cstatus.className = 'status err'
    cstatus.textContent = 'Request failed: ' + e.message
  }
}
document.getElementById('loadExample').onclick = () => {
  document.getElementById('doc').value = ${JSON.stringify(exampleJson)}
}
document.getElementById('create').onclick = async () => {
  const status = document.getElementById('status')
  status.className = 'status'
  status.textContent = 'Creating…'
  status.style.display = 'block'
  let doc
  try {
    doc = JSON.parse(document.getElementById('doc').value)
  } catch (e) {
    status.className = 'status err'
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
      status.className = 'status err'
      status.textContent = 'Rejected:\\n' + (body.errors || []).map(e => e.field + ': ' + e.message).join('\\n')
      return
    }
    status.className = 'status ok'
    status.textContent =
      'Created ' + body.id + '\\n' +
      'View:     ' + location.origin + '/d/' + body.id + '\\n' +
      'Present:  ' + location.origin + '/d/' + body.id + '#present\\n' +
      'Download: ' + location.origin + '/d/' + body.id + '/download\\n' +
      'Edit token (save this — shown once): ' + body.editToken
  } catch (e) {
    status.className = 'status err'
    status.textContent = 'Request failed: ' + e.message
  }
}
</script>
</body>
</html>`
}
