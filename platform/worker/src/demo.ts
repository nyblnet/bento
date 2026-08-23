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
// The base stylesheet itself lives in pageStyles.ts, shared with the
// setup/login pages — this file only adds its own `pre.prompt` rules.
import { PAGE_STYLES } from './pageStyles.ts'

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
${PAGE_STYLES}
  pre.prompt {
    display: block; width: 100%; background: var(--bg-elev); color: var(--text);
    border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    max-height: 280px; overflow: auto; white-space: pre-wrap; word-break: break-word; margin: 0;
  }
  .hero-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .access-field { margin: 12px 0 0; }
  .access-field label {
    font-size: 12px; font-weight: 600; text-transform: none; letter-spacing: normal; margin-bottom: 4px;
  }
  .access-field select {
    display: block; width: 100%; background: var(--bg-elev); color: var(--text);
    border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; font-size: 13px;
  }
  .access-field select:focus { outline: none; border-color: var(--accent); }
  @media (max-width: 600px) {
    pre.prompt { max-height: 220px; font-size: 12px; }
  }

  /* deck history sidebar — a ChatGPT-style session list, added alongside
     the wizard rather than replacing its layout: .main-content just becomes
     the flex sibling of .sidebar, .wrap inside it is unchanged. */
  .app-shell { display: flex; align-items: stretch; min-height: 100vh; }
  .sidebar {
    width: 260px; flex: 0 0 260px; background: var(--bg-elev); border-right: 1px solid var(--border);
    display: flex; flex-direction: column; padding: 20px 14px; box-sizing: border-box;
    position: sticky; top: 0; height: 100vh; overflow-y: auto;
  }
  .sidebar-brand { font-weight: 800; font-size: 15px; margin: 0 0 16px; padding: 0 2px; }
  .sidebar-brand span { color: var(--accent); }
  .new-deck-btn { width: 100%; justify-content: center; margin-bottom: 16px; }
  .deck-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
  .deck-list-label {
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--text-dim); padding: 0 10px; margin: 4px 0 6px;
  }
  .deck-item {
    display: flex; align-items: center; gap: 4px; padding: 2px 2px 2px 10px; border-radius: 8px;
    font-size: 13px;
  }
  .deck-item:hover { background: rgba(245,247,250,0.07); }
  .deck-item-link {
    flex: 1; min-width: 0; padding: 6px 0; color: var(--text); text-decoration: none; overflow: hidden;
  }
  .deck-item .deck-title {
    display: block; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .deck-item .deck-time { display: block; color: var(--text-dim); font-size: 11px; margin-top: 2px; }
  .deck-status {
    flex: 0 0 auto; width: 20px; text-align: center; font-size: 12px; opacity: 0.85;
  }
  .deck-gear {
    flex: 0 0 auto; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center;
    border: none; background: none; color: var(--text-dim); cursor: pointer; border-radius: 6px; font-size: 13px;
    opacity: 0.6;
  }
  .deck-gear:hover { opacity: 1; background: rgba(245,247,250,0.1); color: var(--text); }
  .deck-list-empty, .deck-list-loading { color: var(--text-dim); font-size: 13px; padding: 8px 10px; }

  /* access dialog — a body-level centered modal, deliberately NOT anchored
     inside .deck-list: that container is overflow-y:auto, and a floating
     child positioned inside a scroll container gets clipped the moment its
     box would extend past it (CLAUDE.md hard-won lesson #10) — the exact
     trap a sidebar-anchored popover here would fall into. */
  .access-modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 50;
    display: flex; align-items: center; justify-content: center; padding: 20px;
  }
  .access-modal {
    background: var(--card); border: 1px solid var(--border); border-radius: 14px;
    padding: 20px; width: 360px; max-width: 100%; box-sizing: border-box;
  }
  .access-modal h3 { margin: 0 0 4px; font-size: 16px; }
  .access-modal-sub { color: var(--text-dim); font-size: 12px; margin: 0 0 14px; }
  .access-option {
    display: flex; align-items: flex-start; gap: 10px; width: 100%; text-align: left;
    background: var(--bg-elev); border: 1px solid var(--border); border-radius: 10px;
    padding: 10px 12px; margin-bottom: 8px; cursor: pointer; color: var(--text); font: inherit;
  }
  .access-option:hover { border-color: var(--border-strong); }
  .access-option.current { border-color: var(--accent); background: rgba(232,68,46,0.1); }
  .access-option:disabled { opacity: 0.6; cursor: default; }
  .access-option .access-icon { font-size: 17px; flex-shrink: 0; line-height: 1.3; }
  .access-option .access-label { font-weight: 700; font-size: 13px; display: block; }
  .access-option .access-desc { display: block; font-weight: 400; color: var(--text-dim); font-size: 11px; margin-top: 2px; }
  .rename-row { display: flex; gap: 8px; margin-bottom: 16px; }
  .rename-row input {
    flex: 1; min-width: 0; background: var(--bg-elev); color: var(--text); border: 1px solid var(--border);
    border-radius: 8px; padding: 8px 10px; font: 13px/1.4 inherit;
  }
  .rename-row input:focus { outline: none; border-color: var(--accent); }
  .rename-row button { flex: 0 0 auto; padding: 8px 14px; font-size: 13px; }
  .access-modal-close { width: 100%; margin-top: 2px; }
  .access-danger {
    width: 100%; margin: 4px 0 8px; padding: 10px 12px; border-radius: 10px; text-align: center;
    background: transparent; border: 1px solid var(--err-fg); color: var(--err-fg); cursor: pointer; font: inherit;
  }
  .access-danger:hover { background: var(--err-bg); }
  .access-danger:disabled { opacity: 0.6; cursor: default; }
  .sidebar-footer { border-top: 1px solid var(--border); margin-top: 12px; padding-top: 12px; }
  .logout-link {
    display: block; width: 100%; text-align: left; font-size: 13px; color: var(--text-dim);
    background: none; border: none; cursor: pointer; padding: 6px 10px;
  }
  .logout-link:hover { color: var(--text); }
  .main-content { flex: 1; min-width: 0; }
  .menu-toggle { display: none; }
  .sidebar-backdrop { display: none; }

  @media (max-width: 860px) {
    .sidebar {
      position: fixed; inset: 0 auto 0 0; z-index: 30; transform: translateX(-100%);
      transition: transform 0.2s ease; box-shadow: 2px 0 16px rgba(0,0,0,0.5);
    }
    .sidebar.open { transform: translateX(0); }
    .sidebar-backdrop {
      display: block; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 25;
      opacity: 0; pointer-events: none; transition: opacity 0.2s ease;
    }
    .sidebar-backdrop.open { opacity: 1; pointer-events: auto; }
    .menu-toggle {
      display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px;
      border-radius: 8px; border: 1px solid var(--border-strong); background: transparent; color: var(--text);
      cursor: pointer; font-size: 18px; flex-shrink: 0; margin-bottom: 12px;
    }
  }
</style>
</head>
<body>
<div class="app-shell">
  <div class="sidebar-backdrop" id="sidebarBackdrop"></div>
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-brand">Bento platform <span>·</span> decks</div>
    <button id="newDeck" class="primary new-deck-btn" type="button">+ New deck</button>
    <div class="deck-list-label">History</div>
    <div class="deck-list" id="deckList">
      <div class="deck-list-loading">Loading…</div>
    </div>
    <div class="sidebar-footer">
      <button id="logout" class="logout-link" type="button">Log out</button>
    </div>
  </aside>
  <main class="main-content">
    <div class="wrap">
      <header class="hero hero-row">
        <div>
          <button class="menu-toggle" id="menuToggle" type="button" aria-label="Toggle deck history">☰</button>
          <h1>Bento platform <span>·</span> compile &amp; create</h1>
          <p class="subtitle">Two steps: get an outline from an AI you're already talking to, paste it back here, get a deck.</p>
        </div>
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
        <div class="access-field">
          <label for="accessSelect">Who can open this deck's link? (changeable anytime from the sidebar's ⚙️)</label>
          <select id="accessSelect">
            <option value="edit" selected>Editable — anyone with the link can edit it, like you</option>
            <option value="view">View only — anyone with the link can view/present it, not edit</option>
            <option value="private">Private — only you; a 404 for anyone else, even with the link</option>
          </select>
        </div>
        <div class="actions">
          <button id="loadOutlineExample" type="button">Load example outline</button>
          <button id="loadExample" type="button">Load example doc (advanced)</button>
          <button id="create" class="primary" type="button">Create deck →</button>
        </div>
        <div id="status" class="status"></div>
      </section>
    </div>
  </main>
</div>
<script>
function relativeTime(ms) {
  const diff = Date.now() - ms
  const min = Math.round(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return min + 'm ago'
  const hr = Math.round(min / 60)
  if (hr < 24) return hr + 'h ago'
  const day = Math.round(hr / 24)
  if (day < 30) return day + 'd ago'
  return new Date(ms).toLocaleDateString()
}
const ACCESS_LEVELS = [
  { value: 'edit', icon: '🔓', label: 'Editable', desc: 'Anyone with the link can edit it, just like you' },
  { value: 'view', icon: '👁️', label: 'View only', desc: 'Anyone with the link can view/present it, not edit' },
  { value: 'private', icon: '🔒', label: 'Private', desc: 'Only you — a 404 for anyone else, even with the link' },
]
function accessMeta(value) {
  return ACCESS_LEVELS.find(a => a.value === value) || ACCESS_LEVELS[0]
}

let deckIndex = {}

async function loadDeckList() {
  const list = document.getElementById('deckList')
  try {
    const res = await fetch('/api/decks')
    if (!res.ok) throw new Error('failed to load')
    const body = await res.json()
    const decks = body.decks || []
    deckIndex = {}
    decks.forEach(d => { deckIndex[d.id] = d })
    if (decks.length === 0) {
      list.innerHTML = '<div class="deck-list-empty">No decks yet — create your first one →</div>'
      return
    }
    list.innerHTML = decks.map(d => {
      const a = accessMeta(d.access)
      return (
        '<div class="deck-item">' +
        '<a class="deck-item-link" href="/d/' + d.id + '" target="_blank" rel="noopener">' +
        '<span class="deck-title">' + (d.title || 'Untitled deck').replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</span>' +
        '<span class="deck-time">' + relativeTime(d.updatedAt) + '</span>' +
        '</a>' +
        '<span class="deck-status" title="' + a.label + ' — ' + a.desc + '">' + a.icon + '</span>' +
        '<button class="deck-gear" type="button" data-id="' + d.id + '" title="Deck settings">⚙️</button>' +
        '</div>'
      )
    }).join('')
  } catch (e) {
    list.innerHTML = '<div class="deck-list-empty">Couldn\\'t load deck history.</div>'
  }
}
loadDeckList()

function openAccessModal(id) {
  const info = deckIndex[id] || { title: '', access: 'edit' }
  const backdrop = document.createElement('div')
  backdrop.className = 'access-modal-backdrop'
  backdrop.innerHTML =
    '<div class="access-modal">' +
    '<h3>Deck settings</h3>' +
    '<p class="access-modal-sub">Rename it, choose who can open its link, or delete it.</p>' +
    '<div class="rename-row">' +
    '<input type="text" id="renameInput" maxlength="200">' +
    '<button type="button" id="renameSave">Rename</button>' +
    '</div>' +
    ACCESS_LEVELS.map(a =>
      '<button type="button" class="access-option' + (a.value === info.access ? ' current' : '') + '" data-value="' + a.value + '">' +
      '<span class="access-icon">' + a.icon + '</span>' +
      '<span><span class="access-label">' + a.label + '</span>' +
      '<span class="access-desc">' + a.desc + '</span></span>' +
      '</button>'
    ).join('') +
    '<button type="button" class="access-danger" id="deleteDeck">Delete this deck…</button>' +
    '<button type="button" class="access-modal-close">Close</button>' +
    '</div>'
  document.body.appendChild(backdrop)
  const renameInput = backdrop.querySelector('#renameInput')
  renameInput.value = info.title || ''
  const close = () => backdrop.remove()
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close() })
  backdrop.querySelector('.access-modal-close').onclick = close

  const doRename = async () => {
    const newTitle = renameInput.value.trim()
    if (!newTitle || newTitle === info.title) return
    const saveBtn = backdrop.querySelector('#renameSave')
    saveBtn.disabled = true
    try {
      const res = await fetch('/api/decks/' + id + '/title', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: newTitle }),
      })
      if (!res.ok) throw new Error('failed')
      close()
      loadDeckList()
    } catch (err) {
      saveBtn.disabled = false
      alert('Could not rename this deck. Try again.')
    }
  }
  backdrop.querySelector('#renameSave').onclick = doRename
  renameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doRename() })

  backdrop.querySelectorAll('.access-option').forEach(btn => {
    btn.onclick = async () => {
      const value = btn.dataset.value
      if (value === info.access) { close(); return }
      backdrop.querySelectorAll('.access-option').forEach(b => b.disabled = true)
      try {
        const res = await fetch('/api/decks/' + id + '/access', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ access: value }),
        })
        if (!res.ok) throw new Error('failed')
        close()
        loadDeckList()
      } catch (err) {
        backdrop.querySelectorAll('.access-option').forEach(b => b.disabled = false)
        alert('Could not change this deck\\'s access. Try again.')
      }
    }
  })

  backdrop.querySelector('#deleteDeck').onclick = async () => {
    if (!confirm('Permanently delete "' + (info.title || 'this deck') + '"? This cannot be undone.')) return
    const delBtn = backdrop.querySelector('#deleteDeck')
    delBtn.disabled = true
    try {
      const res = await fetch('/api/decks/' + id, { method: 'DELETE' })
      if (!res.ok) throw new Error('failed')
      close()
      loadDeckList()
    } catch (err) {
      delBtn.disabled = false
      alert('Could not delete this deck. Try again.')
    }
  }
}

document.getElementById('deckList').addEventListener('click', (e) => {
  const btn = e.target.closest('.deck-gear')
  if (!btn) return
  e.preventDefault()
  openAccessModal(btn.dataset.id)
})

document.getElementById('newDeck').onclick = () => location.reload()

const sidebar = document.getElementById('sidebar')
const backdrop = document.getElementById('sidebarBackdrop')
function closeSidebar() { sidebar.classList.remove('open'); backdrop.classList.remove('open') }
document.getElementById('menuToggle').onclick = () => {
  sidebar.classList.toggle('open')
  backdrop.classList.toggle('open')
}
backdrop.onclick = closeSidebar

document.getElementById('logout').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' })
  location.href = '/login'
}
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
    const access = document.getElementById('accessSelect').value
    const res = await fetch('/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc, access }),
    })
    const body = await res.json()
    if (!res.ok) {
      status.className = 'status err'
      status.textContent = 'Rejected:\\n' + (body.errors || []).map(e => e.field + ': ' + e.message).join('\\n')
      return
    }
    status.className = 'status ok'
    const viewUrl = location.origin + '/d/' + body.id
    const note = access === 'private' ? ' — private, only you can open it'
      : access === 'view' ? ' — view only for anyone but you'
      : ''
    status.innerHTML =
      'Created <strong>' + body.id + '</strong>' + note + '<br>' +
      '<a href="' + viewUrl + '" target="_blank" rel="noopener">Open it</a> · ' +
      '<a href="' + viewUrl + '#present" target="_blank" rel="noopener">Present</a> · ' +
      '<a href="' + viewUrl + '/download" target="_blank" rel="noopener">Download</a>'
    loadDeckList()
  } catch (e) {
    status.className = 'status err'
    status.textContent = 'Request failed: ' + e.message
  }
}
</script>
</body>
</html>`
}
