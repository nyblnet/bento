#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type theme rig.  node scripts/test-type-theme.mjs
//
// Static checks over the stylesheet, so a theme cannot rot silently.
//
// The bug this exists because of: the block-style <select> was given
// `background: var(--paper)`. In light theme that is white on white chrome and
// looks fine. In dark theme it is a WHITE box with pale grey text — measured at
// 1.92:1 against a WCAG AA floor of 4.5. It happened because `--paper` is
// deliberately NOT themed (a document is white because paper is white), and I
// used a document token for a chrome control. That is a whole bug CLASS, and it
// is checkable without a browser:
//
//   · chrome must never reference a --paper* token
//   · every themed token must exist in BOTH themes, or one theme silently
//     inherits the other's value
//   · no literal colour may appear outside a token block

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'type/src/styles.css'), 'utf8');

let checks = 0, failures = 0;
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`); } else console.log(`  ok    ${m}`); };
const H = (s) => console.log(`\n=== ${s} ===`);

/** The declarations inside a given selector's block. */
const blockFor = (selector) => {
  const i = css.indexOf(selector);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i));
};
const tokensIn = (block) => [...block.matchAll(/--([a-z0-9-]+)\s*:/g)].map(m => m[1]);

const light = blockFor(':root, :root[data-theme="light"]');
const dark = blockFor(':root[data-theme="dark"]');
const base = blockFor(':root {');

H('both themes define the same roles');
{
  const l = new Set(tokensIn(light)), d = new Set(tokensIn(dark));
  ok(l.size > 5, `the light theme defines ${l.size} tokens`);
  const missing = [...l].filter(t => !d.has(t));
  const extra = [...d].filter(t => !l.has(t));
  ok(missing.length === 0,
     `every light token has a dark counterpart${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`);
  ok(extra.length === 0,
     `and the dark theme invents none${extra.length ? ` — extra: ${extra.join(', ')}` : ''}`);
}

H('the document surface is NOT themed');
{
  const paperTokens = tokensIn(base).filter(t => t.startsWith('paper'));
  ok(paperTokens.length > 0, `paper tokens live in the unthemed block (${paperTokens.join(', ')})`);
  const themedPaper = [...tokensIn(light), ...tokensIn(dark)].filter(t => t.startsWith('paper'));
  ok(themedPaper.length === 0,
     `no paper token is themed${themedPaper.length ? ` — ${themedPaper.join(', ')} would invert the document` : ''}`);
}

H('chrome never borrows a document token');
{
  // every rule that is NOT the page or its decorations
  const rules = css.split('}').filter(r => r.includes('{'));
  const offenders = [];
  for (const r of rules) {
    const sel = r.slice(0, r.indexOf('{')).trim();
    if (!sel || sel.startsWith(':root') || sel.startsWith('/*')) continue;
    const isDocument = /\.t-paper|\.t-deco/.test(sel);
    if (isDocument) continue;
    if (/var\(--paper/.test(r)) offenders.push(sel.replace(/\s+/g, ' ').slice(0, 48));
  }
  ok(offenders.length === 0,
     `no chrome rule uses a --paper token${offenders.length ? ` — ${offenders.join(' | ')}` : ''}`);
}

H('no literal colours outside the token blocks');
{
  // EXEMPT, with the reason written down — the house pattern from
  // scripts/test-slides-theme.mjs, which keeps a list like this rather than
  // letting the gate erode:
  //
  //   .t-mark-word span   the slash in `bento/type` is the BRAND accent, and
  //                       brand does not follow the reader's theme — the same
  //                       literal appears in slides and spaces, beside the
  //                       mark's SVG fills which are literal for the same
  //                       reason. Tokenising it would let a future theme
  //                       recolour the wordmark, which is the one thing in the
  //                       chrome that must look identical in all three apps.
  const EXEMPT = /\.t-mark-word\s+span/;
  const lines = css.split('\n');
  const strays = [];
  lines.forEach((line, i) => {
    if (/^\s*--/.test(line)) return;                     // a token definition
    if (EXEMPT.test(line)) return;
    if (/#[0-9a-fA-F]{3,8}\b/.test(line)) strays.push(`${i + 1}: ${line.trim().slice(0, 56)}`);
  });
  ok(strays.length === 0,
     `every colour comes from a token${strays.length ? `\n        ${strays.join('\n        ')}` : ''}`);
}

H('the suite palette is not forked');
{
  // the light theme must still BE the shared palette — a drifted copy is how
  // three apps stop looking like one product
  const shared = { ink: '#1e2a3a', 'ink-2': '#31445c', chrome: '#f5f7fa',
                   'chrome-2': '#eceff4', line: '#e3e8ef', muted: '#5b6472',
                   accent: '#f7a600', 'accent-ink': '#7a5200', blue: '#5b8def' };
  const wrong = [];
  for (const [name, value] of Object.entries(shared)) {
    const m = light.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
    if (!m || m[1].trim().toLowerCase() !== value) wrong.push(`--${name} is ${m ? m[1].trim() : 'missing'}, suite uses ${value}`);
  }
  ok(wrong.length === 0, `the light theme matches slides/spaces exactly${wrong.length ? `\n        ${wrong.join('\n        ')}` : ''}`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
