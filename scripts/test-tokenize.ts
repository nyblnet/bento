#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The tokenizer's contract, held.
//
//   node scripts/test-tokenize.ts
//
// WHAT THIS PROVES. Three things the renderer and the token diff both lean on:
//
//   1. LOSSLESS — the concatenated token values ARE the source, byte for byte,
//      for every language table and for malformed input (unterminated string,
//      unclosed block comment). The renderer rebuilds the text from tokens, so
//      one dropped character is a corrupted slide, silently.
//   2. CLASSIFIED — keywords/strings/comments/numbers/calls land in the right
//      class per language family, case-insensitively where the table says so,
//      and the line formats (diff, markdown) classify by prefix.
//   3. HONEST ABOUT NEWLINES — multiline tokens (block comments, triple
//      strings) exist and are DECLARED: consumers that blockify tokens must
//      split them, so this rig asserts which token kinds may carry \n rather
//      than pretending none do.

import { tokenize, LANGS, type Tok } from '../kernel/src/tokenize.ts'

const FAILS: string[] = []
const check = (name: string, cond: boolean) => {
  if (!cond) FAILS.push(name)
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`)
}
const cat = (toks: Tok[]) => toks.map((t) => t.v).join('')
const kinds = (toks: Tok[], v: string) => toks.filter((t) => t.v.trim() === v.trim()).map((t) => t.t)

// 1. LOSSLESS over every language table, on a sample exercising its own syntax.
const SAMPLES: Record<string, string> = {
  js: `// c\nconst x = f(1) + 'a\\'b' + \`t\`\n/* multi\nline */`,
  ts: `interface A { x: number }\nconst f = async (): Promise<void> => {}`,
  py: `def f(x):\n    '''doc\nstring'''\n    return x  # tail`,
  rust: `fn main() { let mut x: i32 = 0x1F; println!("{}", x); }`,
  go: "func main() {\n\ts := `raw\nstring`\n}",
  sql: `SELECT COUNT(*) FROM t -- trailing\nWHERE a = 'it''s'`,
  c: `#include <stdio.h>\nint main(void) { return 0; }`,
  ruby: `=begin\nblock\n=end\ndef f; :sym; end`,
  lua: `--[[ block\ncomment ]] local x = 1`,
  haskell: `{- nested? no -}\nmain :: IO ()\nmain = putStrLn "hi"`,
  json: `{"a": [1, 2.5e3, true, null]}`,
  yaml: `key: value # comment\nlist:\n  - yes`,
}
for (const [lang, src] of Object.entries(SAMPLES)) {
  check(`lossless: ${lang}`, cat(tokenize(src, lang)) === src)
}
// Every remaining table at least survives its own keyword list, losslessly.
for (const lang of Object.keys(LANGS)) {
  if (lang in SAMPLES) continue
  const src = `${LANGS[lang].kw.split(' ').slice(0, 4).join(' ')} ident 42\n`
  check(`lossless: ${lang}`, cat(tokenize(src, lang)) === src)
}

// Malformed input runs to end of input, still lossless, never throws.
for (const [name, src, lang] of [
  ['unterminated string', `const s = "never closed\nnext line`, 'js'],
  ['unclosed block comment', `x /* runs forever`, 'js'],
  ['unclosed triple quote', `s = '''dangling`, 'py'],
  ['escape at EOF', `s = "trailing\\`, 'js'],
] as const) {
  let ok = true, out = ''
  try { out = cat(tokenize(src, lang)) } catch { ok = false }
  check(`malformed, lossless: ${name}`, ok && out === src)
}

// 2. CLASSIFICATION.
const js = tokenize(`// note\nconst n = f(42) + "s"`, 'js')
check('keyword classed k', kinds(js, 'const').includes('k'))
check('call classed f', kinds(js, 'f').includes('f'))
check('number classed n', kinds(js, '42').includes('n'))
check('string classed s', kinds(js, '"s"').includes('s'))
check('line comment classed c', js.some((t) => t.t === 'c' && t.v === '// note'))
check('line comment excludes its newline', !js.some((t) => t.t === 'c' && t.v.includes('\n')))
check('sql keywords case-insensitive', kinds(tokenize('select X from T', 'sql'), 'select').includes('k'))
check('unknown lang falls back, lossless', cat(tokenize('const x = 1', 'nosuchlang')) === 'const x = 1')

const diff = tokenize(`--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n ctx`, 'diff')
check('diff: hunk header k', diff.some((t) => t.t === 'k' && t.v.startsWith('@@')))
check('diff: added a / removed d',
  diff.some((t) => t.t === 'a' && t.v.startsWith('+new')) && diff.some((t) => t.t === 'd' && t.v.startsWith('-old')))
const md = tokenize('# Title\n```\ncode block\n```\n- item with `tick`', 'md')
check('md: heading k', md.some((t) => t.t === 'k' && t.v.startsWith('# Title')))
check('md: fenced body stays plain', md.some((t) => t.t === 'x' && t.v.startsWith('code block')))
check('md: inline code s', md.some((t) => t.t === 's' && t.v === '`tick`'))

// 3. NEWLINE HONESTY — the declared multiline kinds, and no others.
const multi = tokenize(`/* a\nb */ "one\\nline" x\ny`, 'js')
  .concat(tokenize(`'''a\nb'''`, 'py'))
const carriers = new Set(multi.filter((t) => t.v.includes('\n')).map((t) => t.t))
check('newlines only in whitespace/comment/string kinds', [...carriers].every((k) => 'xcs'.includes(k)))
check('multiline block comment exists (consumers must split)', carriers.has('c'))
check('multiline triple string exists (consumers must split)', carriers.has('s'))

console.log(FAILS.length ? `\n${FAILS.length} FAILED` : `\nall passed — ${Object.keys(LANGS).length} language tables`)
process.exit(FAILS.length ? 1 : 0)
