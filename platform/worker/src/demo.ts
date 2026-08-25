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
//   1. You've already been chatting with an AI about some topic. Pick the
//      pattern closest to what you're making (changes the prompt's
//      guidance + example, not what you can build), copy the prompt, paste
//      it as your NEXT message in that SAME conversation — the AI already
//      has the context, so it turns what you discussed into outline JSON
//      without you re-explaining anything.
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
// Same reasoning killed a FontAwesome-style icon font when it came up: the
// sidebar's icons are hand-drawn inline SVG (ICONS below) instead — zero
// requests, zero license/version to track, same visual language either way.
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

// Copy-pasteable as a follow-up message in an existing AI chat. Mirrors
// platform/worker/src/compile/schema.ts field-for-field (names, optionality,
// constraints) so a compliant reply parses cleanly — and is explicit about
// "JSON only" because /api/compile has no tolerant/fence-stripping parser
// yet (platform/README.md "Known gaps"): the prompt has to compensate for
// that, not the backend. Shared verbatim across every pattern below —
// varying it per pattern would risk a pattern silently drifting from what
// the compiler actually accepts.
const SCHEMA_BLOCK = `Match this shape exactly:

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
- "morphGroup": "some-id"  — give this SAME string to two ADJACENT slides (next to each other in the array) to make their heading visually morph/animate between them instead of cutting. Good for e.g. a title slide reappearing with a new subtitle, or a chart's heading carrying into its own detail slide.`

// --- content patterns --------------------------------------------------
//
// Bento's slide shapes (title/section/bullets/stat/chart/table/quote/image)
// suit a handful of recurring content shapes well beyond "generic deck" —
// picking the closest one gives the AI a tighter, more specific brief
// (which layouts to reach for and why) plus a genuinely relevant loadable
// example, instead of one generic prompt trying to cover every genre at
// once. This only changes the PROMPT's guidance and the example — every
// pattern still compiles through the exact same schema/compiler.
interface Pattern {
  id: string
  label: string
  blurb: string
  guidance: string
  example: unknown
}

const PATTERNS: Pattern[] = [
  {
    id: 'general',
    label: 'General',
    blurb: 'A balanced mix — works for most topics.',
    guidance: `Pick layouts deliberately: numbers worth comparing → chart, not bullets. A spec/pricing/feature comparison → table, not bullets. One number that matters most → stat, not buried in a sentence. A quotable line → quote, not a bullet. Everything else that's genuinely a list → bullets. Don't force everything into bullets.`,
    example: {
      title: 'Q3 Review',
      slides: [
        { layout: 'title', heading: 'Q3 Review', subheading: 'Growth & retention' },
        { layout: 'stat', value: 2450, label: 'New customers this quarter' },
        {
          layout: 'chart',
          heading: 'Revenue by quarter',
          chartType: 'bar',
          categories: ['Q1', 'Q2', 'Q3', 'Q4'],
          series: [{ name: 'Revenue', data: [420, 780, 1300, 2450] }],
        },
        { layout: 'quote', quote: 'This changed everything.', attribution: 'A customer' },
      ],
    },
  },
  {
    id: 'business',
    label: 'Business review',
    blurb: 'Quarterly/monthly reviews — metrics, trends, comparisons.',
    guidance: `This is a periodic business review — lead with the headline number, then the trend, then the detail. Typical shape: title → one or two "stat" slides for the top-line metrics → a "chart" slide for the trend over time → a "table" slide for a segment/region/product breakdown → a "bullets" slide for risks or next steps → a closing "quote" or "section" slide for the takeaway. Use "section" dividers between major topic shifts (e.g. Revenue → Costs → Headcount) if the review spans several areas.`,
    example: {
      title: 'Q3 Business Review',
      theme: { background: '#0D1B2E', color: '#F5F7FA', accent: '#E8442E' },
      slides: [
        { layout: 'title', heading: 'Q3 Business Review', subheading: "Revenue, retention, and what's next" },
        { layout: 'stat', heading: 'Headline', value: 4200000, label: 'ARR, up 18% quarter over quarter' },
        {
          layout: 'chart',
          heading: 'Revenue by quarter',
          chartType: 'line',
          categories: ['Q4', 'Q1', 'Q2', 'Q3'],
          series: [{ name: 'ARR ($k)', data: [2800, 3200, 3560, 4200] }],
        },
        {
          layout: 'table',
          heading: 'Revenue by segment',
          columns: ['Segment', 'Q2', 'Q3'],
          rows: [
            ['Enterprise', '$1.8M', '$2.3M'],
            ['Mid-market', '$1.1M', '$1.4M'],
            ['SMB', '$0.66M', '$0.5M'],
          ],
        },
        {
          layout: 'bullets',
          heading: 'Risks for Q4',
          bullets: [
            'SMB churn ticked up 2pts — pricing tier under review',
            'Two enterprise renewals slipping into Q1',
            'Hiring plan is 3 roles behind schedule',
          ],
        },
        {
          layout: 'quote',
          quote: 'Enterprise is carrying the quarter. SMB needs a plan before Q4 close.',
          attribution: 'CFO summary',
        },
      ],
    },
  },
  {
    id: 'pitch',
    label: 'Pitch deck',
    blurb: 'Product or startup pitch — problem, solution, traction.',
    guidance: `This is a pitch — open with the problem before the product, and let the SAME headline element morph from the title slide into the problem statement (give both slides the same morphGroup) so the story feels continuous rather than cut. Typical shape: title → "section" or "bullets" for the problem → "bullets" for the solution → a "stat" for market size or a key metric → a "table" for competitive comparison → a "quote" for a customer/investor testimonial → a closing "title" slide (ask/CTA).`,
    example: {
      title: 'Lumen — Pitch',
      theme: { background: '#0D1B2E', color: '#F5F7FA', accent: '#E8442E' },
      slides: [
        { layout: 'title', heading: 'Lumen', subheading: 'Expense reports that write themselves', morphGroup: 'hook' },
        { layout: 'section', kicker: 'THE PROBLEM', heading: 'Lumen', morphGroup: 'hook' },
        {
          layout: 'bullets',
          heading: 'Finance teams lose a week a month to this',
          bullets: [
            'Receipts live in email, Slack, and shoeboxes',
            'Categorization is manual and inconsistent',
            'Close takes 3 extra days waiting on expense data',
          ],
        },
        {
          layout: 'bullets',
          heading: 'How Lumen fixes it',
          bullets: [
            "Forward any receipt — email, photo, PDF — it's parsed automatically",
            'Categorized against your chart of accounts in real time',
            'Synced straight into your close checklist',
          ],
        },
        { layout: 'stat', heading: 'Market', value: 38, label: 'billion-dollar spend-management market, growing 22% a year' },
        {
          layout: 'table',
          heading: 'Why Lumen',
          columns: ['', 'Lumen', 'Legacy tools'],
          rows: [
            ['Setup time', '1 day', '6-8 weeks'],
            ['Auto-categorization', 'Yes', 'Manual rules'],
            ['Price', '$8/seat', '$25+/seat'],
          ],
        },
        { layout: 'quote', quote: 'We closed two days faster the first month we used it.', attribution: 'Head of Finance, pilot customer' },
        { layout: 'title', heading: "Let's talk", subheading: 'Raising a $4M seed to get from 40 to 400 customers' },
      ],
    },
  },
  {
    id: 'tutorial',
    label: 'Tutorial',
    blurb: 'Teaching a concept step by step.',
    guidance: `This is a teaching walkthrough — one concept per slide, and use "section" slides as chapter breaks between topics so the structure is visible at a glance. Typical shape: title → a "section" slide per major topic, each followed by one or two "bullets" slides explaining it → a "table" if concepts are being compared → one "stat" if there's a number worth remembering → a closing "quote" or "bullets" slide summarizing the key takeaway.`,
    example: {
      title: 'Understanding CRDTs',
      theme: { background: '#0D1B2E', color: '#F5F7FA', accent: '#E8442E' },
      slides: [
        { layout: 'title', heading: 'Understanding CRDTs', subheading: "How offline-first apps merge changes without a server refereeing" },
        { layout: 'section', kicker: 'PART 1', heading: 'The problem' },
        {
          layout: 'bullets',
          heading: 'Why merging is hard',
          bullets: [
            'Two people edit the same document offline',
            "Neither has seen the other's changes",
            "There's no central server to say who's right",
          ],
        },
        { layout: 'section', kicker: 'PART 2', heading: 'The idea' },
        {
          layout: 'bullets',
          heading: 'What makes an operation CRDT-safe',
          bullets: [
            "Every operation must be commutative — order doesn't matter",
            'Every operation must be idempotent — applying it twice is safe',
            'Conflicts resolve by a fixed rule, not by asking anyone',
          ],
        },
        {
          layout: 'table',
          heading: 'Two common strategies',
          columns: ['Strategy', 'Good for', 'Trade-off'],
          rows: [
            ['LWW (last-write-wins)', 'Simple fields', 'Concurrent edits silently lose'],
            ['RGA (sequence CRDT)', 'Text/lists', 'More bookkeeping per element'],
          ],
        },
        {
          layout: 'stat',
          heading: 'In practice',
          value: 3,
          label: 'extra fields most CRDT implementations add per value: a timestamp, an actor id, and a tombstone flag',
        },
        {
          layout: 'quote',
          quote: "A CRDT doesn't prevent conflicts — it guarantees that everyone resolves them the same way.",
          attribution: 'The one-sentence version',
        },
      ],
    },
  },
]

export function renderDemoPage(): string {
  const exampleJson = JSON.stringify(EXAMPLE_DOC, null, 2)
  const patternsJson = JSON.stringify(PATTERNS)
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
  .pattern-picker { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
  .pattern-pill {
    padding: 7px 14px; border-radius: 999px; border: 1px solid var(--border-strong); background: transparent;
    color: var(--text-dim); font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .pattern-pill:hover { border-color: var(--accent); color: var(--text); }
  .pattern-pill.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .pattern-blurb { color: var(--text-dim); font-size: 12px; margin: 0 0 12px; }
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
  .deck-kind, .deck-status {
    flex: 0 0 auto; width: 18px; display: flex; align-items: center; justify-content: center; opacity: 0.7;
  }
  .deck-gear {
    flex: 0 0 auto; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center;
    border: none; background: none; color: var(--text-dim); cursor: pointer; border-radius: 6px;
    opacity: 0.6;
  }
  .deck-gear:hover { opacity: 1; background: rgba(245,247,250,0.1); color: var(--text); }
  .deck-list-empty, .deck-list-loading { color: var(--text-dim); font-size: 13px; padding: 8px 10px; }
  .deck-rename-row { flex: 1; min-width: 0; padding: 4px 0; }
  .deck-rename-row input {
    width: 100%; box-sizing: border-box; background: var(--bg-elev); color: var(--text);
    border: 1px solid var(--accent); border-radius: 6px; padding: 5px 8px; font: 600 13px/1.3 inherit;
  }
  .deck-rename-row input:focus { outline: none; }

  /* deck context menu — a body-level fixed-position panel, deliberately NOT
     anchored inside .deck-list: that container is overflow-y:auto, and a
     floating child positioned inside a scroll container gets clipped the
     moment its box would extend past it (CLAUDE.md hard-won lesson #10) —
     the exact trap a sidebar-nested menu here would fall into. */
  .ctx-menu {
    position: fixed; z-index: 60; background: var(--card); border: 1px solid var(--border);
    border-radius: 10px; padding: 6px; min-width: 200px; box-shadow: 0 10px 30px rgba(0,0,0,0.45);
  }
  .ctx-item {
    display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 8px 10px;
    border-radius: 6px; background: none; border: none; color: var(--text); font: inherit; font-size: 13px; cursor: pointer;
  }
  .ctx-item:hover { background: rgba(245,247,250,0.08); }
  .ctx-item:disabled { opacity: 0.5; cursor: default; }
  .ctx-item.danger { color: var(--err-fg); }
  .ctx-item.danger:hover { background: var(--err-bg); }
  .ctx-icon { flex-shrink: 0; display: inline-flex; }
  .ctx-right { margin-left: auto; opacity: 0.75; display: inline-flex; }
  .ctx-sep { height: 1px; background: var(--border); margin: 5px 4px; }
  .ctx-header {
    display: flex; align-items: center; gap: 8px; padding: 4px 6px 8px; font-size: 12px; font-weight: 700;
    color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em;
  }
  .ctx-header button { background: none; border: none; color: var(--text-dim); cursor: pointer; display: inline-flex; padding: 2px; }
  .ctx-header button:hover { color: var(--text); }
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
        you're happy with what a page-by-page outline should cover. Then pick the pattern closest to
        what you're making, copy the prompt below, and paste it as your <strong>next message in that
        same conversation</strong> — the AI already has the context, so it turns what you discussed
        into JSON matching our schema without you re-explaining anything.</p>
        <div class="pattern-picker" id="patternPicker"></div>
        <p class="pattern-blurb" id="patternBlurb"></p>
        <pre class="prompt" id="promptText"></pre>
        <div class="actions">
          <button id="copyPrompt" class="primary" type="button">Copy prompt</button>
        </div>
      </section>

      <section class="card">
        <div class="step-label">Step 2</div>
        <h2>Paste the AI's JSON — or a self-contained HTML deck — and create</h2>
        <p>Paste whatever the AI replied with. We'll detect whether it's outline JSON (from step 1), a full
        <code>bento/slides</code> document (the "advanced" path — paste one directly to skip the AI
        entirely), or a complete, self-running HTML slide deck some AIs will generate directly if you
        just ask for one — that gets stored and served as-is, not compiled into Bento's own format,
        so it's always view-only for anyone but you.</p>
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
          <button id="loadOutlineExample" type="button">Load pattern's example</button>
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

// --- hand-drawn inline icons (no icon font/CDN — see file header) ----------
const ICONS = {
  lock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  unlock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>',
  eye: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
  gear: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  chevronRight: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
  chevronLeft: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  code: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
}
function iconSpan(svg, cls) {
  return '<span class="ctx-icon' + (cls ? ' ' + cls : '') + '">' + svg + '</span>'
}

const ACCESS_LEVELS = [
  { value: 'edit', icon: ICONS.unlock, label: 'Editable', desc: 'Anyone with the link can edit it, just like you' },
  { value: 'view', icon: ICONS.eye, label: 'View only', desc: 'Anyone with the link can view/present it, not edit' },
  { value: 'private', icon: ICONS.lock, label: 'Private', desc: 'Only you — a 404 for anyone else, even with the link' },
]
function accessMeta(value) {
  return ACCESS_LEVELS.find(a => a.value === value) || ACCESS_LEVELS[0]
}

// --- Step 1: pattern picker -------------------------------------------------

const PATTERNS = ${patternsJson}
const SCHEMA_BLOCK = ${JSON.stringify(SCHEMA_BLOCK)}
let activePattern = PATTERNS[0]

function buildPrompt(pattern) {
  return "Based on everything we've discussed above, turn it into a slide deck outline as JSON. Output ONLY the JSON — no markdown code fences, no commentary before or after, nothing else in your reply.\\n\\n" +
    SCHEMA_BLOCK + '\\n\\n' + pattern.guidance +
    '\\n\\nExample (for shape reference only — replace with our actual content):\\n\\n' +
    JSON.stringify(pattern.example, null, 2)
}

function renderPatternPicker() {
  document.getElementById('patternPicker').innerHTML = PATTERNS.map(p =>
    '<button type="button" class="pattern-pill' + (p.id === activePattern.id ? ' active' : '') + '" data-id="' + p.id + '">' + p.label + '</button>'
  ).join('')
  document.querySelectorAll('.pattern-pill').forEach(btn => {
    btn.onclick = () => {
      activePattern = PATTERNS.find(p => p.id === btn.dataset.id)
      renderPatternPicker()
      updatePromptText()
    }
  })
  document.getElementById('patternBlurb').textContent = activePattern.blurb
}
function updatePromptText() {
  document.getElementById('promptText').textContent = buildPrompt(activePattern)
  document.getElementById('patternBlurb').textContent = activePattern.blurb
}
renderPatternPicker()
updatePromptText()

// --- sidebar deck list -------------------------------------------------

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
      const kindBadge = d.kind === 'html' ? '<span class="deck-kind" title="Self-contained HTML file — stored and served as-is">' + ICONS.code + '</span>' : ''
      return (
        '<div class="deck-item" data-id="' + d.id + '">' +
        '<a class="deck-item-link" href="/d/' + d.id + '" target="_blank" rel="noopener">' +
        '<span class="deck-title">' + (d.title || 'Untitled deck').replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</span>' +
        '<span class="deck-time">' + relativeTime(d.updatedAt) + '</span>' +
        '</a>' +
        kindBadge +
        '<span class="deck-status" title="' + a.label + ' — ' + a.desc + '">' + a.icon + '</span>' +
        '<button class="deck-gear" type="button" data-id="' + d.id + '" title="Deck menu">' + ICONS.gear + '</button>' +
        '</div>'
      )
    }).join('')
  } catch (e) {
    list.innerHTML = '<div class="deck-list-empty">Couldn\\'t load deck history.</div>'
  }
}
loadDeckList()

// --- per-deck context menu (right-click, or the ⚙️ button) -----------------
// Windows-Explorer-style: right-click (or the gear button) opens a small
// fixed-position menu at the cursor/button; Rename edits the title in place
// in the row itself (also Explorer-style) rather than in a dialog.

let openMenuEl = null
function onDocClick(e) { if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu() }
function onDocKey(e) { if (e.key === 'Escape') closeMenu() }
function closeMenu() {
  if (openMenuEl) { openMenuEl.remove(); openMenuEl = null }
  document.removeEventListener('click', onDocClick, true)
  document.removeEventListener('keydown', onDocKey, true)
  document.removeEventListener('contextmenu', onDocClick, true)
}

function startInlineRename(id, info) {
  const item = document.querySelector('.deck-item[data-id="' + id + '"]')
  if (!item) return
  const link = item.querySelector('.deck-item-link')
  if (!link) return
  link.style.display = 'none'
  const row = document.createElement('div')
  row.className = 'deck-rename-row'
  row.innerHTML = '<input type="text" maxlength="200">'
  item.insertBefore(row, link)
  const input = row.querySelector('input')
  input.value = info.title || ''
  input.focus()
  input.select()
  let done = false
  const finish = (commit) => {
    if (done) return
    done = true
    const newTitle = input.value.trim()
    if (!commit || !newTitle || newTitle === info.title) { loadDeckList(); return }
    fetch('/api/decks/' + id + '/title', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: newTitle }),
    }).then(res => {
      if (!res.ok) throw new Error('failed')
      loadDeckList()
    }).catch(() => {
      alert('Could not rename this deck. Try again.')
      loadDeckList()
    })
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true) }
    if (e.key === 'Escape') { e.preventDefault(); finish(false) }
  })
  input.addEventListener('blur', () => finish(true))
}

async function doDelete(id, info) {
  if (!confirm('Permanently delete "' + (info.title || 'this deck') + '"? This cannot be undone.')) return
  try {
    const res = await fetch('/api/decks/' + id, { method: 'DELETE' })
    if (!res.ok) throw new Error('failed')
    loadDeckList()
  } catch (err) {
    alert('Could not delete this deck. Try again.')
  }
}

function positionMenu(el, x, y) {
  const rect = el.getBoundingClientRect()
  const vw = window.innerWidth, vh = window.innerHeight
  let left = x, top = y
  if (left + rect.width > vw - 8) left = vw - rect.width - 8
  if (top + rect.height > vh - 8) top = vh - rect.height - 8
  el.style.left = Math.max(8, left) + 'px'
  el.style.top = Math.max(8, top) + 'px'
}

function openDeckMenu(id, x, y) {
  closeMenu()
  const info = deckIndex[id] || { title: '', access: 'edit', kind: 'bento' }
  const menu = document.createElement('div')
  menu.className = 'ctx-menu'

  function renderMain() {
    menu.innerHTML =
      '<button type="button" class="ctx-item" data-a="rename">' + iconSpan(ICONS.pencil) + '<span>Rename</span></button>' +
      '<button type="button" class="ctx-item" data-a="access">' + iconSpan(ICONS.eye) + '<span>Access</span>' + iconSpan(ICONS.chevronRight, 'ctx-right') + '</button>' +
      '<div class="ctx-sep"></div>' +
      '<button type="button" class="ctx-item danger" data-a="delete">' + iconSpan(ICONS.trash) + '<span>Delete…</span></button>'
    menu.querySelector('[data-a="rename"]').onclick = () => { closeMenu(); startInlineRename(id, info) }
    menu.querySelector('[data-a="access"]').onclick = renderAccess
    menu.querySelector('[data-a="delete"]').onclick = () => { closeMenu(); doDelete(id, info) }
    positionMenu(menu, x, y)
  }

  function renderAccess() {
    // 'edit' means nothing for an 'html' deck — there's no document to edit
    // in place, only bytes to serve as-is (see store.ts's DeckAccess).
    const levels = info.kind === 'html' ? ACCESS_LEVELS.filter(a => a.value !== 'edit') : ACCESS_LEVELS
    menu.innerHTML =
      '<div class="ctx-header"><button type="button" data-a="back">' + ICONS.chevronLeft + '</button><span>Access</span></div>' +
      levels.map(a =>
        '<button type="button" class="ctx-item" data-v="' + a.value + '">' +
        iconSpan(a.icon) + '<span>' + a.label + '</span>' +
        (a.value === info.access ? iconSpan(ICONS.check, 'ctx-right') : '') +
        '</button>'
      ).join('')
    menu.querySelector('[data-a="back"]').onclick = renderMain
    menu.querySelectorAll('[data-v]').forEach(btn => {
      btn.onclick = async () => {
        const value = btn.dataset.v
        if (value === info.access) { closeMenu(); return }
        menu.querySelectorAll('[data-v]').forEach(b => b.disabled = true)
        try {
          const res = await fetch('/api/decks/' + id + '/access', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ access: value }),
          })
          if (!res.ok) throw new Error('failed')
          closeMenu()
          loadDeckList()
        } catch (err) {
          menu.querySelectorAll('[data-v]').forEach(b => b.disabled = false)
          alert('Could not change this deck\\'s access. Try again.')
        }
      }
    })
    positionMenu(menu, x, y)
  }

  document.body.appendChild(menu)
  openMenuEl = menu
  renderMain()
  setTimeout(() => {
    document.addEventListener('click', onDocClick, true)
    document.addEventListener('keydown', onDocKey, true)
    document.addEventListener('contextmenu', onDocClick, true)
  }, 0)
}

document.getElementById('deckList').addEventListener('click', (e) => {
  const gear = e.target.closest('.deck-gear')
  if (!gear) return
  e.preventDefault()
  const rect = gear.getBoundingClientRect()
  openDeckMenu(gear.dataset.id, rect.left, rect.bottom + 4)
})
document.getElementById('deckList').addEventListener('contextmenu', (e) => {
  const item = e.target.closest('.deck-item')
  if (!item) return
  e.preventDefault()
  openDeckMenu(item.dataset.id, e.clientX, e.clientY)
})

document.getElementById('newDeck').onclick = () => location.reload()

const sidebar = document.getElementById('sidebar')
const sidebarBackdrop = document.getElementById('sidebarBackdrop')
function closeSidebar() { sidebar.classList.remove('open'); sidebarBackdrop.classList.remove('open') }
document.getElementById('menuToggle').onclick = () => {
  sidebar.classList.toggle('open')
  sidebarBackdrop.classList.toggle('open')
}
sidebarBackdrop.onclick = closeSidebar

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
  document.getElementById('input').value = JSON.stringify(activePattern.example, null, 2)
}
document.getElementById('loadExample').onclick = () => {
  document.getElementById('input').value = ${JSON.stringify(exampleJson)}
}
function looksLikeHtmlDocument(raw) {
  return /^\\s*<(!doctype\\s+html|html[\\s>])/i.test(raw)
}

document.getElementById('create').onclick = async () => {
  const status = document.getElementById('status')
  status.className = 'status'
  status.textContent = 'Working…'
  status.style.display = 'block'

  const raw = document.getElementById('input').value
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    parsed = undefined
  }

  let requestBody
  let isHtml = false
  if (parsed !== undefined && parsed && parsed.format === 'bento/slides') {
    requestBody = { doc: parsed }
  } else if (parsed !== undefined) {
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
      requestBody = { doc: compileBody.doc }
    } catch (e) {
      status.className = 'status err'
      status.textContent = 'Compile request failed: ' + e.message
      return
    }
  } else if (looksLikeHtmlDocument(raw)) {
    isHtml = true
    requestBody = { html: raw }
  } else {
    status.className = 'status err'
    status.textContent = 'Not valid JSON, and not an HTML document either (expected it to start with <!doctype html> or <html>).'
    return
  }

  try {
    let access = document.getElementById('accessSelect').value
    // 'edit' is meaningless for an uploaded HTML file — nothing to edit in
    // place — so it's downgraded here too, matching the server's own
    // coercion (POST /api/decks), so the success note below is accurate
    // rather than claiming "editable" when the server didn't grant it.
    if (isHtml && access === 'edit') access = 'view'
    requestBody.access = access
    const res = await fetch('/api/decks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
    const body = await res.json()
    if (!res.ok) {
      status.className = 'status err'
      status.textContent = 'Rejected:\\n' + (body.errors || [{ field: '', message: body.error || 'unknown error' }]).map(e => (e.field ? e.field + ': ' : '') + e.message).join('\\n')
      return
    }
    status.className = 'status ok'
    const viewUrl = location.origin + '/d/' + body.id
    const note = access === 'private' ? ' — private, only you can open it'
      : access === 'view' ? ' — view only for anyone but you'
      : ''
    const presentLink = isHtml ? '' : '<a href="' + viewUrl + '#present" target="_blank" rel="noopener">Present</a> · '
    status.innerHTML =
      'Created <strong>' + body.id + '</strong>' + note + '<br>' +
      '<a href="' + viewUrl + '" target="_blank" rel="noopener">Open it</a> · ' +
      presentLink +
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
