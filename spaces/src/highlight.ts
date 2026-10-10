// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Syntax highlighting for `code` blocks — ours, because nobody's fits.
//
// SIZE IS THE DESIGN. highlight.js is ~120KB and the useful subset of Prism is
// ~30KB; the whole spaces shell was 72KB compressed. Either library would be
// the largest thing in the product, in a format whose entire premise is that
// you can mail the file. So this is a small lexer covering the languages people
// actually paste into notes, and everything else degrades to plain text.
//
// MEASURED on the built shell: the lexer, the painter, the chip and the colours
// together cost 4.0KB compressed, and ALL EIGHT vocabularies together cost a
// further 1.4KB — about 180 bytes per language, because keyword lists are
// lowercase ascii and deflate eats them. So the expensive part is the machinery
// and the languages are nearly free, which is the opposite of the intuition
// that says "support fewer languages to save space".
//
// THE OUTPUT IS OFFSETS, NEVER STRINGS. A token is `{k, a, b}` — a kind and a
// half-open range into the caller's text. `tokenize` is TOTAL: the tokens
// partition [0, text.length) exactly, in order, with no gaps and no overlap.
// That is not tidiness, it is the security property. Code in a space is text
// someone mailed you; a highlighter that cannot produce a string cannot produce
// markup, whatever the input does. `scripts/test-spaces-model.ts` asserts the
// partition over a hostile corpus, in every language, and the renderer builds
// nodes with `createTextNode` from those ranges.
//
// WHICH LANGUAGES, AND WHY THESE. The set is what a working notebook actually
// accumulates — shell one-liners, a config file, a snippet from the codebase —
// not a survey of programming languages:
//
//   js/ts   the most-pasted family, and this codebase's own
//   py      the other one
//   sh      every notes app is half terminal commands
//   json    configs, API responses, and it is nearly free given the lexer
//   yaml    CI files and manifests, the other config people paste
//   sql     queries are exactly the thing you keep notes about
//   html    including xml/svg — its own scanner, tags are not tokens
//   css     the last of the everyday web three
//
// The C-family scanner below is parameterised, so a new curly-brace language is
// one keyword list (~150 bytes). Resist adding them anyway: a language nobody
// tested renders *nearly* right, which is worse than the plain fallback, and
// the fallback is designed to look deliberate rather than broken.
//
// WHAT IT DELIBERATELY DOES NOT DO: no semantic anything (a type is not a
// keyword), no nested grammars (js inside `<script>`, interpolation inside a
// template literal or an f-string, code inside a YAML block scalar — all stay
// one token), no HTML entities. Each of those costs bytes to get right and
// nothing to get wrong.

export type Kind =
  | ''    // plain
  | 'c'   // comment
  | 's'   // string
  | 'n'   // number, and css hex colours
  | 'k'   // keyword, and markup tags
  | 'l'   // literal / builtin, and shell variables
  | 'p'   // property: object key, attribute name, css property

export interface Token { k: Kind; a: number; b: number }

interface Lang {
  label: string
  /** line-comment openers */
  lc?: string[]
  /** block comment, open and close */
  bc?: [string, string]
  /** characters that open a string */
  q?: string
  /** python ''' and """ */
  triple?: boolean
  /** `'` strings take no backslash escapes; a doubled `''` stays inside */
  rawSq?: boolean
  /** keywords, space separated */
  kw?: string
  /** literals and builtins, space separated */
  lit?: string
  /** keywords match without regard to case (SQL) */
  ci?: boolean
  /** a word or string followed by `:` is a property */
  keys?: boolean
  /** `$NAME` and `${…}` */
  vars?: boolean
  /** `-` is a word character (css properties, yaml keys) */
  dash?: boolean
  /** `@name` is a keyword (css at-rules, python decorators) */
  at?: boolean
  /** `#rrggbb` is a colour, so a number */
  hex?: boolean
  /** tags and attributes, not words and punctuation */
  markup?: boolean
  /** built on first use — the catalogs ship as strings so deflate can see them */
  kset?: Set<string>
  lset?: Set<string>
}

const JS_KW =
  'as async await break case catch class const continue debugger declare default delete do else enum ' +
  'export extends finally for from function get if implements import in infer instanceof interface is ' +
  'keyof let namespace new of private protected public readonly return satisfies set static super ' +
  'switch this throw try type typeof var void while with yield'

const LANGS: Record<string, Lang> = {
  js: {
    label: 'JavaScript',
    lc: ['//'], bc: ['/*', '*/'], q: '\'"`',
    kw: JS_KW,
    lit: 'true false null undefined NaN Infinity console document window globalThis process require ' +
      'module exports Promise Array Object String Number Boolean Math JSON Symbol Map Set WeakMap Error ' +
      'RegExp Date parseInt parseFloat setTimeout setInterval fetch',
  },
  ts: {
    label: 'TypeScript',
    lc: ['//'], bc: ['/*', '*/'], q: '\'"`',
    kw: JS_KW + ' abstract override unique asserts',
    lit: 'true false null undefined NaN Infinity console document window globalThis process require ' +
      'module exports Promise Array Object String Number Boolean Math JSON Symbol Map Set Error ' +
      'string number boolean any unknown never object symbol bigint',
  },
  py: {
    label: 'Python',
    lc: ['#'], q: '\'"', triple: true, at: true,
    kw: 'and as assert async await break class continue def del elif else except finally for from ' +
      'global if import in is lambda nonlocal not or pass raise return try while with yield match case',
    lit: 'True False None self cls print len range str int float bool bytes list dict set tuple open ' +
      'type super isinstance issubclass enumerate zip map filter sum min max abs round sorted reversed ' +
      'repr format input __init__ __name__ __main__',
  },
  sh: {
    label: 'Shell',
    lc: ['#'], q: '\'"', rawSq: true, vars: true,
    kw: 'if then else elif fi for while until do done case esac in function return select break ' +
      'continue local export declare readonly',
    lit: 'echo cd pwd ls cp mv rm mkdir rmdir touch cat head tail grep sed awk find xargs sort uniq wc ' +
      'chmod chown ln df du ps kill sudo set unset read source alias exit eval exec trap wait shift ' +
      'test printf true false git npm node curl docker make ssh tar',
  },
  json: {
    label: 'JSON',
    q: '"', keys: true,
    lit: 'true false null',
  },
  yaml: {
    label: 'YAML',
    lc: ['#'], q: '\'"', rawSq: true, keys: true, dash: true,
    lit: 'true false null yes no on off True False Null',
  },
  sql: {
    label: 'SQL',
    lc: ['--'], bc: ['/*', '*/'], q: '\'"', rawSq: true, ci: true,
    kw: 'select from where group by order having limit offset insert into values update set delete ' +
      'create table view materialized index drop alter add column primary key foreign references ' +
      'unique check not null default join inner left right full outer cross on using as union all ' +
      'except intersect distinct case when then else end and or in like ilike between exists is asc ' +
      'desc with recursive returning constraint cascade begin commit rollback transaction grant ' +
      'revoke explain analyze if temporary replace',
    lit: 'int integer bigint smallint serial bigserial text varchar char boolean bool date timestamp ' +
      'timestamptz time interval numeric decimal real double precision float json jsonb uuid bytea ' +
      'array enum true false null count sum avg min max coalesce nullif greatest least now ' +
      'current_timestamp current_date extract cast substring length lower upper trim',
  },
  css: {
    label: 'CSS',
    bc: ['/*', '*/'], q: '\'"', keys: true, dash: true, at: true, hex: true,
    kw: 'important',
    lit: 'inherit initial revert unset none auto currentColor transparent var calc url rgb rgba hsl ' +
      'hsla min max clamp',
  },
  html: { label: 'HTML', markup: true },
}

/**
 * What a reader can pick, in the order the picker shows them. Plain text is
 * first because it is the default, and because "no highlighting" has to look
 * like a choice rather than a failure.
 */
export const CODE_LANGS: ReadonlyArray<{ id: string; label: string }> =
  ['', ...Object.keys(LANGS)].map((id) => ({ id, label: id ? LANGS[id].label : '' }))

/**
 * Aliases people actually write in a fence. Everything unlisted falls through
 * to plain — including a language we could nearly render, which is the point:
 * `lang` is preserved in the model either way, so a later build can light it up
 * without anyone re-tagging their blocks.
 */
const ALIAS: Record<string, string> = {
  javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
  typescript: 'ts', tsx: 'ts',
  python: 'py', python3: 'py', py3: 'py',
  bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh', terminal: 'sh', ksh: 'sh',
  yml: 'yaml',
  postgres: 'sql', postgresql: 'sql', psql: 'sql', mysql: 'sql', sqlite: 'sql',
  xml: 'html', svg: 'html', xhtml: 'html', htm: 'html',
}

/** The language id this build will actually highlight with, or '' for plain. */
export function normLang(lang: unknown): string {
  if (typeof lang !== 'string') return ''
  const k = lang.trim().toLowerCase().replace(/^\./, '')
  const id = ALIAS[k] ?? k
  return id in LANGS ? id : ''
}

/** The chip's label: a known language's name, or whatever the file said. */
export function langLabel(lang: unknown): string {
  const id = normLang(lang)
  if (id) return LANGS[id].label
  return typeof lang === 'string' ? lang.trim() : ''
}

const WORD = /[A-Za-z_$]/
const WORDC = /[\w$]/
const DIGIT = /[0-9]/
const HEX = /^[0-9a-fA-F]+$/
const NAMEC = /[\w:.-]/

const words = (s: string | undefined): Set<string> => new Set(s ? s.split(' ') : [])

export function tokenize(text: string, lang?: unknown): Token[] {
  const out: Token[] = []
  const n = text.length
  if (!n) return out

  /** Adjacent runs of the same kind coalesce, so plain text is one node. */
  const push = (k: Kind, a: number, b: number): void => {
    if (b <= a) return
    const last = out[out.length - 1]
    if (last && last.k === k && last.b === a) last.b = b
    else out.push({ k, a, b })
  }

  const L = LANGS[normLang(lang)]
  if (!L) { push('', 0, n); return out }
  if (L.markup) { scanMarkup(text, push); return out }

  if (!L.kset) { L.kset = words(L.kw); L.lset = words(L.lit) }
  const kset = L.kset
  const lset = L.lset!

  /** Is the next non-blank character a `:`? Then that word was a key. */
  const keyAhead = (j: number): boolean => {
    while (j < n && (text[j] === ' ' || text[j] === '\t')) j++
    return text[j] === ':'
  }

  let i = 0
  while (i < n) {
    const c = text[i]

    // block comment — first, so `/*` never reads as an operator
    if (L.bc && text.startsWith(L.bc[0], i)) {
      const e = text.indexOf(L.bc[1], i + L.bc[0].length)
      const end = e < 0 ? n : e + L.bc[1].length   // unterminated runs to EOF
      push('c', i, end); i = end; continue
    }

    if (L.lc) {
      let hit = false
      for (const op of L.lc) {
        if (!text.startsWith(op, i)) continue
        // `#` only opens a comment at the start of a word. Otherwise every URL
        // fragment in a shell script — `curl host/x#frag` — eats its line.
        if (op === '#' && i > 0 && /[\w$/.\-"']/.test(text[i - 1])) continue
        hit = true; break
      }
      if (hit) {
        let e = text.indexOf('\n', i)
        if (e < 0) e = n
        push('c', i, e); i = e; continue
      }
    }

    // shell variables, before the word rule — `$` is a word character in js
    if (L.vars && c === '$') {
      let j = i + 1
      if (text[j] === '{') { const e = text.indexOf('}', j); j = e < 0 ? n : e + 1 }
      else if (text[j] === '(') { j += 1 }
      else while (j < n && WORDC.test(text[j])) j++
      push(j > i + 1 ? 'l' : '', i, Math.max(j, i + 1)); i = Math.max(j, i + 1); continue
    }

    if (L.at && c === '@') {
      let j = i + 1
      while (j < n && WORDC.test(text[j])) j++
      push(j > i + 1 ? 'k' : '', i, Math.max(j, i + 1)); i = Math.max(j, i + 1); continue
    }

    // a css colour. `#main` is not hex, so a selector stays plain.
    if (L.hex && c === '#') {
      let j = i + 1
      while (j < n && WORDC.test(text[j])) j++
      if (j > i + 1 && HEX.test(text.slice(i + 1, j))) { push('n', i, j); i = j; continue }
    }

    if (L.q && L.q.includes(c)) {
      const end = scanString(text, i, c, L)
      // in a keyed language a quoted key is a key, not a value: JSON is
      // otherwise a wall of one colour
      push(L.keys && keyAhead(end) ? 'p' : 's', i, end)
      i = end; continue
    }

    if (DIGIT.test(c) || (c === '.' && DIGIT.test(text[i + 1] ?? ''))) {
      let j = i + 1
      // `[\w.]` swallows the unit in `10px` and the radix in `0xff`, which is
      // what you want to see; `1e-9` needs the sign after an exponent
      while (j < n && (/[\w.]/.test(text[j]) || (/[eE]/.test(text[j - 1]) && /[+-]/.test(text[j])))) j++
      push('n', i, j); i = j; continue
    }

    if (WORD.test(c) || (L.dash && c === '-')) {
      let j = i + 1
      while (j < n && (WORDC.test(text[j]) || (L.dash && text[j] === '-'))) j++
      const w = text.slice(i, j)
      const key = L.ci ? w.toLowerCase() : w
      let k: Kind = ''
      if (L.keys && keyAhead(j)) k = 'p'
      else if (kset.has(key)) k = 'k'
      else if (lset.has(key)) k = 'l'
      push(k, i, j); i = j; continue
    }

    push('', i, i + 1); i++
  }
  return out
}

/**
 * A string, from its opening quote to just past its closing one.
 *
 * An UNTERMINATED string ends at the newline, not at end-of-file, in every
 * language whose strings are single-line. Half-written code is the normal state
 * of a code block in a notes app, and running one stray quote to the bottom of
 * the block turns the rest of it green while you type.
 */
function scanString(text: string, i: number, q: string, L: Lang): number {
  const n = text.length
  if (L.triple && text.startsWith(q + q + q, i)) {
    const e = text.indexOf(q + q + q, i + 3)
    return e < 0 ? n : e + 3
  }
  const raw = L.rawSq && q === '\''
  const multi = q === '`' || raw
  let j = i + 1
  while (j < n) {
    const d = text[j]
    if (d === '\\' && !raw) { j += 2; continue }
    if (d === q) {
      // `''` inside a raw single-quoted string is an escaped quote (SQL)
      if (raw && text[j + 1] === q) { j += 2; continue }
      return j + 1
    }
    if (d === '\n' && !multi) return j
    j++
  }
  return n
}

/**
 * Markup is not words and punctuation, so it gets its own scanner: text is
 * text, and only what is inside `<…>` has structure. Tag name and its angle
 * bracket are one token — colouring the bracket separately reads as noise at
 * 13px.
 */
function scanMarkup(text: string, push: (k: Kind, a: number, b: number) => void): void {
  const n = text.length
  let i = 0
  while (i < n) {
    const lt = text.indexOf('<', i)
    if (lt < 0) { push('', i, n); return }
    push('', i, lt)

    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt)
      const end = e < 0 ? n : e + 3
      push('c', lt, end); i = end; continue
    }
    if (text[lt + 1] === '!' || text[lt + 1] === '?') {   // doctype, xml decl
      const e = text.indexOf('>', lt)
      const end = e < 0 ? n : e + 1
      push('c', lt, end); i = end; continue
    }

    let j = lt + 1
    if (text[j] === '/') j++
    const nameAt = j
    while (j < n && NAMEC.test(text[j])) j++
    if (j === nameAt) { push('', lt, lt + 1); i = lt + 1; continue }   // a bare `<`
    push('k', lt, j)

    while (j < n && text[j] !== '>') {
      const c = text[j]
      if (c === '"' || c === '\'') {
        const e = text.indexOf(c, j + 1)
        const end = e < 0 ? n : e + 1
        push('s', j, end); j = end; continue
      }
      if (NAMEC.test(c)) {
        let e = j
        while (e < n && NAMEC.test(text[e])) e++
        push('p', j, e); j = e; continue
      }
      push('', j, j + 1); j++
    }
    if (j < n) { push('k', j, j + 1); j++ }   // the closing `>`
    i = j
  }
}
