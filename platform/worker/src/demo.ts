// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// A two-step page served at `/`, standing in for the real prompt-template +
// paste/review app (Cloudflare Pages, follow-up PR) so the Worker is
// testable end-to-end (compile → create → view → present) right after a
// deploy, with nothing else to stand up.
//
// The two steps match how this is actually meant to be used, NOT a form to
// fill in by hand:
//   1. You've already been chatting with an AI about some topic. Copy the
//      prompt below and paste it as your NEXT message in that SAME
//      conversation — the AI already has the context, so it turns what you
//      discussed into outline JSON without you re-explaining anything.
//   2. Paste whatever JSON the AI replied with. One button creates the
//      deck — it auto-detects whether you pasted outline JSON (compiles it
//      via POST /api/compile first) or an already-compiled bento/slides
//      doc (the "advanced" path — paste one directly, skip the AI
//      entirely), then POSTs to /api/decks either way.
//
// Styling is hand-written CSS, no framework — this repo runs on a strict
// zero-external-dependency ethos (slides/src/charts.ts dropped ECharts for
// its own engine specifically over size/dependency cost; see CLAUDE.md).
// A CDN-hosted framework would violate that AND add a live network
// dependency to a page whose whole point is working right after a fresh
// deploy. Deliberately dark-only (not adaptive to light mode) — matches the
// navy/accent palette already used below, and this is a small enough
// surface that committing to one look beats maintaining two palettes.

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

// Copy-pasteable as a follow-up message in an existing AI chat. Mirrors
// platform/worker/src/compile/schema.ts field-for-field (names, optionality,
// constraints) so a compliant reply parses cleanly — and is explicit about
// "JSON only" because /api/compile has no tolerant/fence-stripping parser
// yet (platform/README.md "Known gaps"): the prompt has to compensate for
// that, not the backend.
const PROMPT_TEMPLATE = `Based on everything we've discussed above, turn it into a slide deck outline as JSON. Output ONLY the JSON — no markdown code fences, no commentary before or after, nothing else in your reply.

Match this shape exactly:

{
  "title": "string",
  "theme": { "background": "#rrggbb", "color": "#rrggbb", "accent": "#rrggbb" },  // optional, omit for a default dark theme
  "slides": [ /* 6-15 slides, one object per slide, shapes below */ ]
}

Each slide is ONE of these shapes — pick whichever fits the idea best:

- Cover / title: {"layout":"title","heading":"...","subheading":"..."}  // subheading optional
- Section divider: {"layout":"section","heading":"...","kicker":"..."}  // kicker optional, a short eyebrow label like "PART 1"
- Bulleted list: {"layout":"bullets","heading":"...","bullets":["...","..."]}  // up to 12 bullets
- A single headline number: {"layout":"stat","heading":"...","value":2450,"label":"..."}  // heading optional; value is a plain number, no commas or units
- A chart: {"layout":"chart","heading":"...","chartType":"bar","categories":["...","..."],"series":[{"name":"...","data":[1,2,3]}]}
    // heading optional. chartType is "bar", "line", or "pie". Every series' "data" array must be the SAME LENGTH as "categories". A pie chart takes exactly ONE series.
- A comparison table: {"layout":"table","heading":"...","columns":["...","..."],"rows":[["...","..."],["...","..."]]}
    // heading optional. Every row must have the SAME NUMBER of cells as "columns".
- A memorable quote: {"layout":"quote","quote":"...","attribution":"..."}  // attribution optional
- A photo moment: {"layout":"image","heading":"...","caption":"...","alt":"a description of the photo"}
    // heading and caption optional. This becomes a placeholder box, not a real photo yet — "alt" is what it should eventually show.

Any slide can also carry:
- "notes": "..."  — speaker notes
- "morphGroup": "some-id"  — give this SAME string to two ADJACENT slides (next to each other in the array) to make their heading visually morph/animate between them instead of cutting. Good for e.g. a title slide reappearing with a new subtitle, or a chart's heading carrying into its own detail slide.

Pick layouts deliberately: numbers worth comparing → chart, not bullets. A spec/pricing/feature comparison → table, not bullets. One number that matters most → stat, not buried in a sentence. A quotable line → quote, not a bullet. Everything else that's genuinely a list → bullets. Don't force everything into bullets.

Example (for shape reference only — replace with our actual content):

{
  "title": "Q3 Review",
  "slides": [
    {"layout":"title","heading":"Q3 Review","subheading":"Growth & retention"},
    {"layout":"stat","value":2450,"label":"New customers this quarter"},
    {"layout":"chart","heading":"Revenue by quarter","chartType":"bar","categories":["Q1","Q2","Q3","Q4"],"series":[{"name":"Revenue","data":[420,780,1300,2450]}]},
    {"layout":"quote","quote":"This changed everything.","attribution":"A customer"}
  ]
}`

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
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
  .card > p strong { color: var(--text); }
  textarea, pre.prompt {
    display: block; width: 100%; background: var(--bg-elev); color: var(--text);
    border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  textarea { min-height: 260px; resize: vertical; }
  textarea:focus { outline: none; border-color: var(--accent); }
  pre.prompt { max-height: 280px; overflow: auto; white-space: pre-wrap; word-break: break-word; margin: 0; }
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
    pre.prompt { max-height: 220px; font-size: 12px; }
    .actions { flex-direction: column; }
    .actions button { width: 100%; }
  }
</style>
</head>
<body>
<div class="wrap">
<header class="hero">
  <h1>Bento platform <span>·</span> compile &amp; create</h1>
  <p class="subtitle">Two steps: get an outline from an AI you're already talking to, paste it back here, get a deck.</p>
</header>

<section class="card">
  <div class="step-label">Step 1</div>
  <h2>Get an outline from your AI chat</h2>
  <p><strong>First, chat with an AI</strong> (ChatGPT, Claude, whatever) about your topic until
  you're happy with what a page-by-page outline should cover. Then copy the prompt below and
  paste it as your <strong>next message in that same conversation</strong> — the AI already has
  the context, so it turns what you discussed into JSON matching our schema without you
  re-explaining anything.</p>
  <pre class="prompt" id="promptText">${escapeHtml(PROMPT_TEMPLATE)}</pre>
  <div class="actions">
    <button id="copyPrompt" class="primary" type="button">Copy prompt</button>
  </div>
</section>

<section class="card">
  <div class="step-label">Step 2</div>
  <h2>Paste the AI's JSON and create your deck</h2>
  <p>Paste whatever the AI replied with. We'll detect whether it's outline JSON (from step 1) or
  a full <code>bento/slides</code> document (the "advanced" path — paste one directly to skip the
  AI entirely) and create the deck either way.</p>
  <textarea id="input" spellcheck="false"></textarea>
  <div class="actions">
    <button id="loadOutlineExample" type="button">Load example outline</button>
    <button id="loadExample" type="button">Load example doc (advanced)</button>
    <button id="create" class="primary" type="button">Create deck →</button>
  </div>
  <div id="status" class="status"></div>
</section>
</div>
<script>
document.getElementById('copyPrompt').onclick = async () => {
  const btn = document.getElementById('copyPrompt')
  try {
    await navigator.clipboard.writeText(document.getElementById('promptText').textContent)
    const original = btn.textContent
    btn.textContent = 'Copied!'
    setTimeout(() => { btn.textContent = original }, 1500)
  } catch (e) {
    alert('Could not copy automatically — select the text above and copy it by hand.')
  }
}
document.getElementById('loadOutlineExample').onclick = () => {
  document.getElementById('input').value = ${JSON.stringify(exampleOutlineJson)}
}
document.getElementById('loadExample').onclick = () => {
  document.getElementById('input').value = ${JSON.stringify(exampleJson)}
}
document.getElementById('create').onclick = async () => {
  const status = document.getElementById('status')
  status.className = 'status'
  status.textContent = 'Working…'
  status.style.display = 'block'

  let parsed
  try {
    parsed = JSON.parse(document.getElementById('input').value)
  } catch (e) {
    status.className = 'status err'
    status.textContent = 'Not valid JSON: ' + e.message
    return
  }

  let doc
  if (parsed && parsed.format === 'bento/slides') {
    doc = parsed
  } else {
    try {
      const compileRes = await fetch('/api/compile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outline: parsed }),
      })
      const compileBody = await compileRes.json()
      if (!compileRes.ok) {
        status.className = 'status err'
        status.textContent = "Couldn't read that as an outline:\\n" +
          (compileBody.errors || []).map(e => e.field + ': ' + e.message).join('\\n')
        return
      }
      doc = compileBody.doc
    } catch (e) {
      status.className = 'status err'
      status.textContent = 'Compile request failed: ' + e.message
      return
    }
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
      'Open it:  ' + location.origin + '/d/' + body.id + '\\n' +
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
