#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
//
// The LaTeX behind the Light Clock example deck, in one list so the baker can
// read it without importing the deck (see scripts/bake-math.mjs).
//
//   node scripts/bake-math.mjs scripts/lightclock-deck.tex.mjs
//     → scripts/lightclock-deck.math.mjs   (the baked SVG, committed)
//
// `key` names the entry in the generated BAKED map. `mode: 'note'` bakes prose
// with inline $…$; everything else is a standalone display equation.
//
// The eight entries from `pyth` to `gammaeq` are ONE derivation shown across
// eight morph-linked slides, which is the whole point of the deck: consecutive
// steps share a morph key, so Bento tweens each symbol from where it was to
// where it ends up instead of crossfading the formula. `tags` are morph hints —
// they force the two pairings the automatic glyph match cannot infer, because
// the shapes involved have no symbols in common (`2L/c` becoming `Δt'`, and a
// whole radical collapsing into `γ`).

export const MATH = [
  // ── the clock at rest ────────────────────────────────────────────────────
  { key: 'rest', source: "\\Delta t' = \\frac{2L}{c}" },

  // ── the derivation, step by step (one morph key across all eight) ────────
  // Plain parentheses, not \left(…\right): normal-size delimiters keep the
  // glyph count honest and morph cleanly into the expanded fractions.
  { key: 'pyth', source: '(c\\,\\Delta t/2)^{2} = L^{2} + (v\\,\\Delta t/2)^{2}' },
  { key: 'expand', source: '\\frac{c^{2}\\Delta t^{2}}{4} = L^{2} + \\frac{v^{2}\\Delta t^{2}}{4}' },
  // the step the whole deck is built to show: a term crosses the equals sign
  { key: 'gather', source: '\\frac{c^{2}\\Delta t^{2}}{4} - \\frac{v^{2}\\Delta t^{2}}{4} = L^{2}' },
  { key: 'factor', source: '\\frac{\\Delta t^{2}}{4}\\,(c^{2} - v^{2}) = L^{2}' },
  { key: 'isolate', source: '\\Delta t^{2} = \\frac{4L^{2}}{c^{2} - v^{2}}' },
  {
    key: 'root',
    source: '\\Delta t = \\frac{2L}{c}\\cdot\\frac{1}{\\sqrt{1 - v^{2}/c^{2}}}',
    tags: [
      { tex: '\\frac{2L}{c}', tag: 'rest' },
      { tex: '\\frac{1}{\\sqrt{1 - v^{2}/c^{2}}}', tag: 'gam' },
    ],
  },
  {
    key: 'gammaeq',
    source: "\\Delta t = \\gamma\\,\\Delta t'",
    tags: [
      { tex: "\\Delta t'", tag: 'rest' },
      { tex: '\\gamma', tag: 'gam' },
    ],
  },

  // ── the Lorentz factor, on its own ───────────────────────────────────────
  { key: 'gammadef', source: '\\gamma = \\frac{1}{\\sqrt{1 - v^{2}/c^{2}}}' },
  // the low-speed limit — why nobody noticed for 200 years
  { key: 'lowspeed', source: '\\gamma \\approx 1 + \\frac{1}{2}\\frac{v^{2}}{c^{2}}' },

  // ── worked numbers ───────────────────────────────────────────────────────
  // deliberately short: these two sit side by side in a narrow column, and a
  // formula is sized from its intrinsic width, so a long one shrinks to nothing
  { key: 'muonflat', source: 'd_{0} = v\\,\\tau \\approx 660\\,\\mathrm{m}' },
  { key: 'muon', source: 'd = \\gamma\\, d_{0} \\approx 15.8 \\times 660\\,\\mathrm{m} \\approx 10\\,\\mathrm{km}' },

  // ── prose with inline math ───────────────────────────────────────────────
  {
    key: 'note_setup',
    mode: 'note',
    source:
      'A pulse of light bounces between two mirrors held a distance $L$ apart. ' +
      'One tick is one round trip. Nothing here is exotic — it is a clock, and ' +
      'the only thing it depends on is the speed of light $c$.',
  },
  {
    key: 'note_moving',
    mode: 'note',
    source:
      'Now slide the whole clock sideways at speed $v$. In your frame the pulse ' +
      'no longer goes straight up and down: while it climbs, the mirror moves. ' +
      'Its path is the hypotenuse — and it is longer than $L$.',
  },
  {
    key: 'note_trap',
    mode: 'note',
    source:
      'A longer path at the same speed takes longer. That is the entire argument. ' +
      'The pulse covers $c\\,\\Delta t/2$ while the clock slides $v\\,\\Delta t/2$, ' +
      'and the mirror gap $L$ closes the triangle.',
  },
  {
    key: 'note_gamma',
    mode: 'note',
    source:
      'Everything the deck has done collapses into one number, $\\gamma$. At walking ' +
      'pace it is $1$ to twelve decimal places; at $0.99c$ it is about $7$. It is ' +
      'never less than $1$, so a moving clock is never fast — only slow.',
  },
  {
    key: 'note_muon',
    mode: 'note',
    source:
      'Muons are made about $15\\,\\mathrm{km}$ up when cosmic rays hit the atmosphere, ' +
      'and they live $\\tau \\approx 2.2\\,\\mu\\mathrm{s}$. Travelling at $0.998c$ they ' +
      'should manage $660\\,\\mathrm{m}$ and die high overhead. They reach the ground ' +
      'in numbers — because $\\gamma \\approx 15.8$.',
  },
]
