// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Shared CSS for every plain HTML page this Worker serves (demo.ts, and the
// setup/login pages) — one copy instead of drifting duplicates. Hand-written,
// no framework/CDN: see demo.ts's file header for why (this repo's
// zero-external-dependency convention). Deliberately dark-only, matching
// Bento's own example palette (#0D1B2E/#F5F7FA/#E8442E).
//
// Page-specific rules (demo.ts's `pre.prompt`, say) are appended by the page
// itself after this block, not folded in here — this file is only the parts
// every page actually shares.
export const PAGE_STYLES = `
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
  .wrap.narrow { max-width: 420px; }
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
  label { display: block; font-size: 13px; font-weight: 600; color: var(--text-dim); margin: 0 0 6px; }
  textarea, input[type=text], input[type=password] {
    display: block; width: 100%; background: var(--bg-elev); color: var(--text);
    border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  textarea { min-height: 260px; resize: vertical; }
  textarea:focus, input:focus { outline: none; border-color: var(--accent); }
  .field { margin-bottom: 16px; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
  button {
    font: inherit; font-weight: 600; font-size: 14px; padding: 10px 18px; border-radius: 8px;
    border: 1px solid var(--border-strong); background: transparent; color: var(--text); cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  button:hover { background: rgba(245,247,250,0.07); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  button.primary:disabled { opacity: 0.6; cursor: default; }
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
`
