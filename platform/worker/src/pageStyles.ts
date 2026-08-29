// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Shared CSS for every plain HTML page this Worker serves (demo.ts, and the
// setup/login pages) — one copy instead of drifting duplicates. Hand-written,
// no framework/CDN: see demo.ts's file header for why (this repo's
// zero-external-dependency convention). An elegant, warm LIGHT palette —
// ivory paper + deep ink navy + the same brand terracotta accent used
// throughout (Bento's example decks default to #E8442E too, so the platform
// chrome and a freshly-compiled deck's own default theme still rhyme).
// Previously dark-only navy/#F5F7FA; switched per explicit request. Two
// accent tokens instead of one: `--accent` (#E8442E) is for BACKGROUNDS —
// button fills, active pills, borders — where a bold saturated red-orange
// reads fine even at small sizes. `--accent-ink` is a deepened version of
// the same hue for TEXT/icon foreground use — #E8442E as running text sits
// at ~3.7:1 against this bg (fails WCAG AA body-text contrast; it only
// passed against the old dark navy bg because dark bg + a mid-saturation
// red is a much easier contrast pair than near-white + the same red).
// `--accent-ink` sits at ~5.8:1, comfortably AA. Hover overlays elsewhere in
// this file and demo.ts use `rgba(28,43,61, α)` — the same RGB triplet as
// `--text` below, tinting darker on hover instead of the old dark theme's
// lighter-tint-on-hover (the correct direction flips with the theme).
export const PAGE_STYLES = `
  :root {
    --bg: #FAF7F2;
    --bg-elev: #F1ECE3;
    --card: #FFFFFF;
    --border: rgba(28,43,61,0.10);
    --border-strong: rgba(28,43,61,0.20);
    --text: #1C2B3D;
    --text-dim: #6B7686;
    --accent: #E8442E;
    --accent-ink: #B23223;
    --accent-hover: #C93A26;
    --ok-bg: rgba(31,122,68,0.10);
    --ok-fg: #1F7A44;
    --err-bg: rgba(163,49,31,0.09);
    --err-fg: #A3311F;
    color-scheme: light;
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
  h1 span { color: var(--accent-ink); }
  .subtitle { color: var(--text-dim); font-size: 15px; margin: 0; max-width: 60ch; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 28px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(28,43,61,0.04); }
  .step-label {
    display: inline-block; font-size: 12px; font-weight: 700; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--accent-ink); margin-bottom: 10px;
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
  button:hover { background: rgba(28,43,61,0.06); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  button.primary:disabled { opacity: 0.6; cursor: default; }
  .status { margin-top: 16px; padding: 12px 14px; border-radius: 8px; font-size: 13px; white-space: pre-wrap; display: none; }
  .status.err { display: block; background: var(--err-bg); color: var(--err-fg); }
  .status.ok { display: block; background: var(--ok-bg); color: var(--ok-fg); }
  .status a { color: inherit; text-decoration: underline; font-weight: 600; }
  .status a:hover { opacity: 0.8; }
  code { background: rgba(28,43,61,0.07); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  @media (max-width: 600px) {
    .wrap { padding: 32px 16px 60px; }
    h1 { font-size: 23px; }
    .card { padding: 18px; border-radius: 10px; margin-bottom: 18px; }
    textarea { min-height: 200px; font-size: 12px; }
    .actions { flex-direction: column; }
    .actions button { width: 100%; }
  }
`
