#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Where a control LIVES — the gate for it.
//
//   node scripts/test-type-chrome.ts
//
// The app reached a state where "Cross-reference" was in the Insert menu AND
// in ⋯, "Equation block" was an action while "Formula" was an insert, and
// "Page break here" was an action competing with the breakBefore checkbox that
// does the same thing. None of it was decided; each feature picked a home as it
// landed, and the result reads as carelessness to anyone using it.
//
// The rule, from slides:
//
//   Insert  — anything that PUTS SOMETHING IN the document. One home.
//   ⋯       — document-level actions you do occasionally: snapshot, review,
//             sign, print, import, about.
//   panel   — every property.
//   bar     — only what is reached for mid-sentence.
//
// This is a SOURCE-level check on purpose. Booting the app to read its live
// registry would need a DOM, and the thing being guarded is a fact about how
// the features register themselves — which is visible in the text, and stays
// visible when a feature is added by someone who never runs the app.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', 'type', 'src');

let checks = 0, bad = 0;
const ok = (cond: boolean, msg: string) => {
  checks++;
  if (cond) { console.log(`  ok    ${msg}`); return; }
  bad++; console.log(`  FAIL  ${msg}`);
};

// A label is written `label: t('X')`, `label: () => t('X')`, or
// `get label() { return <anything with t('X') in it>; }` — the last of which
// can be a TERNARY, because a toggle's label depends on its state:
//
//   get label() { return hidden() ? t('Show comments') : t('Hide comments'); }
//
// So: find where the label starts, cut to the next key of the object literal,
// and take EVERY t('…') in between. Matching only the first one silently
// dropped every toggle in the app — which the coverage assertion below caught,
// and which is the only reason this comment exists.
const labelsIn = (block: string): string[] => {
  const start = block.search(/(?:get )?label\s*[(:]/);
  if (start < 0) return [];
  const rest = block.slice(start);
  // the next sibling key ends the label region; `run:` always follows
  const end = rest.search(/\n\s*(?:get\s+)?(?:run|order|icon|id|title)\s*[(:]/);
  const region = end < 0 ? rest : rest.slice(0, end);
  return [...region.matchAll(/t\(\s*'([^']+)'/g)].map(m => m[1]);
};

// Registration calls are found by scanning forward to the balanced close. A
// naive /registerTool\({[^}]*}\)/ stops at the first nested `}` — which every
// one of these has, in a getter or an arrow body — and silently matches
// nothing useful. Counting braces is the difference between a gate and a
// decoration.
const callsOf = (src: string, fn: string): string[] => {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const at = src.indexOf(`${fn}({`, i);
    if (at < 0) break;
    let depth = 0, j = at + fn.length + 1;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) { j++; break; }
    }
    out.push(src.slice(at, j));
    i = j;
  }
  return out;
};

const inserts = new Map<string, string>();   // label -> file
const actions = new Map<string, string>();

for (const f of readdirSync(SRC).filter(n => n.endsWith('.ts'))) {
  const src = readFileSync(join(SRC, f), 'utf8');
  for (const call of callsOf(src, 'registerTool')) {
    if (!/group:\s*'insert'/.test(call)) continue;
    for (const l of labelsIn(call)) inserts.set(l, f);
  }
  for (const call of callsOf(src, 'registerMenuItem')) {
    for (const l of labelsIn(call)) actions.set(l, f);
  }
}

// The ⋯ menu is not built only from the registry: main.ts ships a handful of
// buttons in its own markup (snapshot, review, sign, print, about) and labels
// them by id. Scanning only registerMenuItem saw ONE ⋯ entry where the running
// app shows seven, so the rule would have been enforced against a seventh of
// the menu.
const main = readFileSync(join(SRC, 'main.ts'), 'utf8');
// Slice to </header>, NOT to the first </div>: the menu contains
// `<div class="t-menu-sep"></div>` separators, so the first close tag after
// id="moreMenu" belongs to a separator two buttons in. Cutting there found ms
// and mc and stopped — five of the seven ⋯ entries were invisible to a gate
// whose whole job is to see all of them. Same mistake as the one callsOf()
// above is written to avoid, made again twenty lines later.
const menuMarkup = main.slice(main.indexOf('id="moreMenu"'), main.indexOf('</header>'));
for (const m of menuMarkup.matchAll(/<button id="([a-z]+)"/g)) {
  const id = m[1];
  const lbl = main.match(new RegExp(`label\\('${id}',[^;]*?t\\(\\s*'([^']+)'`, 's'));
  if (lbl) actions.set(lbl[1], 'main.ts');
}

console.log(`\ninsert menu: ${[...inserts.keys()].join(', ')}`);
console.log(`⋯ menu:      ${[...actions.keys()].join(', ')}\n`);

// The gate must be able to FAIL. If the scan finds nothing it would pass every
// assertion below while proving nothing at all — the most comfortable kind of
// broken test.
ok(inserts.size >= 5, `the scan actually found insert tools (${inserts.size})`);
ok(actions.size >= 4, `the scan actually found ⋯ actions (${actions.size})`);

// 1. Nothing lives in two places.
const norm = (s: string) => s.replace(/[…\.]+$/, '').replace(/\s*\(.*\)$/, '').trim().toLowerCase();
const insertNorm = new Map([...inserts].map(([l, f]) => [norm(l), f]));
for (const [label, file] of actions) {
  const clash = insertNorm.get(norm(label));
  ok(clash === undefined,
     `"${label}" (${file}) is not also an Insert tool${clash ? ` — duplicated from ${clash}` : ''}`);
}

// 2. ⋯ holds no INSERTS. A verb that puts something in the document belongs in
//    the Insert menu, whatever it is called.
const INSERTY = /^(insert|add|new)\b|\b(block|equation|reference|citation|caption|picture|image|table|formula)\b/i;
const IMPORT_OK = /^import\b/i;   // importing a bibliography is document-level
for (const [label, file] of actions) {
  ok(!INSERTY.test(label) || IMPORT_OK.test(label),
     `⋯ item "${label}" (${file}) is not an insert wearing an action's clothes`);
}

// 3. ⋯ holds no PROPERTIES. "Do not number this heading" and "Page break here"
//    were both properties of the block under the caret: they have a STATE, and
//    an action can only offer to flip it, never show it.
const PROPERTYISH = /^(do not|don't|toggle)\b|\bthis (heading|paragraph|block)\b|^page break/i;
for (const [label, file] of actions) {
  ok(!PROPERTYISH.test(label),
     `⋯ item "${label}" (${file}) is not a property of the selection`);
}

console.log('\n— every element the chrome reaches for actually exists —');
{
  // byId() is `document.getElementById(id) as T` — it returns null for a
  // missing id and the cast hides that from tsc. label() then dereferences it
  // and the whole boot dies AFTER the page has rendered its paper, so the app
  // looks fine and simply never publishes window.bento.
  //
  // This has now happened twice: once when buttons moved into the ⋯ menu, and
  // again when two of them were REMOVED from it and their label() calls were
  // left behind. Both times the symptom was a working-looking page.
  const src = readFileSync(join(SRC, 'main.ts'), 'utf8');

  const declared = new Set<string>();
  for (const m of src.matchAll(/\bid="([A-Za-z][\w-]*)"/g)) declared.add(m[1]);
  // ids created in script rather than in the template
  for (const m of src.matchAll(/\.id\s*=\s*'([^']+)'/g)) declared.add(m[1]);
  for (const m of src.matchAll(/\.id\s*=\s*`([^`$]+)`/g)) declared.add(m[1]);

  const referenced = new Map<string, string>();
  for (const re of [/\blabel\(\s*'([^']+)'/g, /\bbyId(?:<[^>]*>)?\(\s*'([^']+)'/g]) {
    for (const m of src.matchAll(re)) referenced.set(m[1], m[0].split('(')[0]);
  }

  ok(declared.size > 5, `the scan found the template's ids (${declared.size})`);
  ok(referenced.size > 5, `and the lookups (${referenced.size})`);
  for (const [id, how] of referenced) {
    ok(declared.has(id), `${how}('${id}') refers to an element that exists`);
  }
}

console.log(`\n${checks - bad}/${checks} checks passed`);
if (bad) process.exit(1);
