#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The DOM-free rules behind code in a text box (slides/src/editor/codefence.ts):
//
//   node scripts/test-slides-code-fence.ts
//
// WHAT THIS PROVES. Which text counts as a fence (only a CLOSED one — a
// half-typed ``` is never swallowed), what language its info string means
// (common spellings mapped to the built-in tokenizer's ids, unknown ones left
// unset), when the caret is inside an open fence (autoformat's guard), and
// what elements a fenced box becomes (the first part keeps the box's identity;
// later parts never copy its morph key, which must stay unique on a slide).
// test-slides-code-fence-browser.mjs drives the same rules through the editor.

import { codeLanguage, estimatedFrames, fencedElements, hasFence, insideOpenFence, splitFences } from '../slides/src/editor/codefence.ts'
import { defaultText } from '../slides/src/model.ts'

let failures = 0, checks = 0
const ok = (cond: boolean, msg: string) => { checks++; if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`) }

console.log('\nsplitFences\n')
const one = splitFences('```js\nconst a = 1\n```')
ok(one.length === 1 && one[0].kind === 'code' && one[0].lines.join('\n') === 'const a = 1' && (one[0] as { lang?: string }).lang === 'js', 'a box that is only a fence → one code part')
const mixed = splitFences('Intro\n\n```py\nprint(1)\n\nprint(2)\n```\n\nAfter')
ok(mixed.map((p) => p.kind).join(',') === 'text,code,text', `text, code, text (${mixed.map((p) => p.kind).join(',')})`)
ok(mixed[1].lines.join('\n') === 'print(1)\n\nprint(2)', 'blank lines INSIDE the code are kept')
ok(mixed[0].lines.join('|') === 'Intro' && mixed[2].lines.join('|') === 'After', 'blank lines at the edges of text parts are dropped')
ok(splitFences('```\nnot closed').every((p) => p.kind === 'text') && !hasFence('```\nnot closed'), 'an unclosed fence stays text')
ok(splitFences('a\n```\nx\n```\n```ts\ny\n```').filter((p) => p.kind === 'code').length === 2, 'two fences → two code parts')
ok(splitFences(' ``` \nx\n```').some((p) => p.kind === 'code'), 'contentEditable NBSPs around ``` still count')
ok(splitFences('use ``` inline ``` here').every((p) => p.kind === 'text'), '``` mid-line is not a fence')
ok(splitFences('```js\nx\n```js').every((p) => p.kind === 'text'), 'only a bare ``` closes (```js twice is not open+close)')

console.log('\ncodeLanguage\n')
const lang: Record<string, string | undefined> = {
  js: 'js', javascript: 'js', JSX: 'js', typescript: 'ts', tsx: 'ts', python: 'py', bash: 'sh', shell: 'sh',
  'c++': 'cpp', 'c#': 'csharp', rb: 'ruby', rs: 'rust', golang: 'go', yml: 'yaml', markdown: 'md', diff: 'diff',
  kotlin: 'kotlin', sql: 'sql', '': undefined, nosuchlang: undefined,
}
for (const [info, want] of Object.entries(lang)) ok(codeLanguage(info) === want, `"${info}" → ${want ?? 'unset'} (${codeLanguage(info)})`)

console.log('\ninsideOpenFence (autoformat\'s guard)\n')
ok(insideOpenFence('```js\nconst a = `hi'), 'caret after an opener → inside')
ok(!insideOpenFence('```js\nx\n```\nnow `prose'), 'after the closer → outside again')
ok(!insideOpenFence('plain `text'), 'no fence → outside')
ok(insideOpenFence('```\na\n```\n```\nb'), 'a second opener → inside')

console.log('\nfencedElements\n')
const src = { ...defaultText({ html: 'x', color: '#123456' }), id: 'tx', morphId: 'keep', role: 'body', x: 100, y: 50, w: 700 }
const parts = splitFences('Intro\n```ts\nlet a = 1\n```\nAfter')
const els = fencedElements(src as never, parts, estimatedFrames(src, parts))
ok(els.map((e) => e.type).join(',') === 'text,code,text', 'element types follow the parts')
ok(els[0].id === 'tx' && els[0].morphId === 'keep' && (els[0] as { role?: string }).role === 'body', 'the first part keeps id, morph key and role')
ok(els.slice(1).every((e) => e.id !== 'tx' && e.morphId === undefined && (e as { role?: string }).role === undefined), 'later parts: fresh ids, no morph key, no role')
const code = els[1] as { content: string; grammarName?: string; color: string; fontFamily: string }
ok(code.content === 'let a = 1' && code.grammarName === 'ts' && code.color === '#123456', 'the code part: content, language, the box\'s colour')
ok(els.every((e) => e.x === 100 && e.w === 700) && els[0].y === 50 && els[0].y < els[1].y && els[1].y < els[2].y, 'one column, stacked from the box top')
const whole = fencedElements(src as never, splitFences('```\nplain\n```'), [{ y: 50, h: 100 }])
ok(whole.length === 1 && whole[0].type === 'code' && whole[0].id === 'tx' && whole[0].morphId === 'keep' && (whole[0] as { grammarName?: string }).grammarName === undefined,
  'a whole-box fence: the box itself becomes code, identity kept, no language guessed')
ok(fencedElements(src as never, parts, [{ y: 1, h: 1, html: '<b>Intro</b>' }, { y: 2, h: 2 }, { y: 3, h: 3 }])[0].type === 'text' &&
  (fencedElements(src as never, parts, [{ y: 1, h: 1, html: '<b>Intro</b>' }, { y: 2, h: 2 }, { y: 3, h: 3 }])[0] as { html: string }).html === '<b>Intro</b>',
  'a measured text part keeps its formatting (html from the editor)')
ok((src as { html: string }).html === 'x' && src.id === 'tx', 'the source element is not modified')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
