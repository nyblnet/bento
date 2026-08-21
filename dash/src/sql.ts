// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// SQL — THE LANGUAGE, NOT AN ENGINE.
//
// docs/dash-sql.md settled this on measurement and it is worth restating here,
// because a reader of this file will reach for SQLite within a minute: DuckDB-
// WASM is ~9,400 KB (17.7× the whole shell) and CANNOT LOAD FROM `file://` AT
// ALL, which is precisely the case a Bento workbook exists for; SQL.js is 442 KB
// and a ROW store, so it would hold a second, drifting copy of every column the
// kernel keeps columnar. WHAT WAS REJECTED WAS THE ENGINE. Nothing rejected the
// language.
//
// So this file parses SQL and COMPILES IT TO `Step[]`. It does not evaluate
// anything. steps.ts is the engine — measured at filter + two-dimension group-by
// over 100,000 rows in 11.4 ms, holding 2.5 MB against a row-shaped 16.8 MB —
// and everything below hands it data:
//
//     SELECT   region, SUM(value) AS pipeline, COUNT(*) AS deals
//     FROM     Pipeline
//     JOIN     Owners ON Pipeline.owner = Owners.name
//     WHERE    stage <> 'Lost'
//     GROUP BY region
//     HAVING   SUM(value) > 10000
//     ORDER BY pipeline DESC
//     LIMIT    20
//
//   → join → filter → group → filter(having) → sort → limit
//
// That output is JSON in the document. It is therefore live (edit a source cell
// and it re-runs), undoable, collaborative, inspectable and traceable — the
// things a dead result set from an embedded database can never be.
//
// ONE EXPRESSION LANGUAGE. `SELECT price * qty` and `WHERE stage <> 'Lost'`
// compile into expressions formula.ts evaluates, because steps.ts already routes
// `filter.where` and `derive.expr` through `evaluate`. There is no second
// evaluator here and there must never be one. Where the two dialects genuinely
// differ, the difference is TRANSLATED and tested, never papered over:
//
//     SQL                     formula.ts            why
//     ------------------------------------------------------------------------
//     'text'                  "text"                SQL quotes strings with '
//     "Q3 pipeline"           [Q3 pipeline]         SQL quotes IDENTIFIERS with "
//     [Q3 pipeline]           [Q3 pipeline]         and people type this too
//     a <> b / a != b         a <> b                != is not a formula operator
//     a AND b                 AND(a, b)             formula's AND is a function
//     a OR b / NOT a          OR(a, b) / NOT(a)
//     x IS NULL               ISBLANK(x)
//     x IS NOT NULL           NOT(ISBLANK(x))
//     x IN (a, b)             OR(x = a, x = b)
//     x BETWEEN a AND b       AND(x >= a, x <= b)
//     a || b                  a & b
//     a % b                   MOD(a, b)
//     CASE WHEN c THEN a END  IFS(c, a, TRUE, "")
//     x LIKE 'North%'         LEFT(LOWER(x), 5) = LOWER("North%"-less-the-%)
//     COUNT(*)                {fn:'count'} with no `of`   — rows in the group
//     COUNT(x)                {fn:'counta', of:x}         — SQL counts NON-NULLs,
//                                                           and dash's COUNT counts
//                                                           NUMBERS. COUNTA is the
//                                                           one that means what SQL
//                                                           means.
//     COUNT(DISTINCT x)       {fn:'countdistinct', of:x}  → COUNTUNIQUE
//
// WHERE SQL AND THIS FORMAT GENUINELY DISAGREE. Each of these is a decision,
// not an oversight, and each is asserted in scripts/test-dash-sql.ts so that
// nobody has to take this comment's word for it:
//
//   - UNION MATCHES COLUMNS BY NAME, not by position (model.ts says why: dash's
//     columns have identity and a SQL result set does not). A union whose arms
//     name their columns differently is REFUSED at compile time rather than
//     filed under whichever column happened to be third.
//   - AN AGGREGATE OVER NO ROWS IS NO ROWS. `SELECT SUM(value) … WHERE <nothing
//     matches>` gives SQL one row holding NULL; here the group step produces
//     zero groups, so the answer is an empty table. This format has no NULL row
//     to invent, and inventing a zero would be a number, which would be a lie.
//   - AMBIGUITY IS DECIDED AT THE SOURCE. A join carries only the columns the
//     query names, so an unqualified column that TWO joined sheets both have
//     would otherwise resolve quietly to whichever one was carried. It is
//     refused, as SQL refuses it.
//   - GROUPING FOLDS CASE AND NUMERIC TEXT, because steps.ts's group key is the
//     one the filter menu and the pivot use. "North" and "north" are one group
//     here and two in most databases; one answer per app beats SQL's.
//
// WHAT A `JOIN` DECLARES, and why it is `card: 'one'`.
// steps.ts REFUSES a join declared `card:'one'` whose right key is not unique,
// because the alternative is every measure below it silently doubling. SQL has
// no way to declare cardinality — `JOIN` says nothing about grain — so this
// compiler must choose the declaration, and it chooses the one that makes the
// silent failure LOUD: `card: 'one'`. A join that fans out then stops the
// pipeline and says by how much, instead of printing a confidently doubled
// total. The author who MEANS to multiply rows says so in the query:
//
//     LEFT JOIN MANY line_items ON orders.id = line_items.order_id
//
// `MANY` is not standard SQL. Nothing in standard SQL carries this information,
// and inventing one word is cheaper than inheriting a decade-old class of wrong
// number. It compiles to `card: 'many'`, which the engine executes and reports.
//
// INNER vs LEFT. steps.ts's `join` is ALWAYS a left join (unmatched rows kept
// with blanks and COUNTED — dropping them is the other way to make a total
// quietly wrong). So `INNER JOIN` compiles to that join PLUS a filter that drops
// the rows which found no match, and the filter is visible in the step list
// rather than hidden in a flag. The right-hand key column is always carried over
// so that filter has something to test; SQL's own semantics agree with the edge
// case, since `ON a.k = b.k` never matches a NULL key and an inner join drops
// those rows too.
//
// PROJECTION IS NOT A STEP, because the format has no `project` op and inventing
// one here would be a format change made by the SQL surface, which is exactly
// backwards. A compiled query therefore carries `select` — the column ids it
// keeps, in order — beside its steps, and `project()` applies it to a frame by
// narrowing `Frame.columns`. That costs nothing: no column is copied, no row is
// touched.
//
// REFERENCES ARE BY COLUMN ID, never by name, wherever a schema is known.
// `Column.id` is identity in this format (model.ts) precisely so that renaming a
// column cannot break a formula, an override, a tile or a CRDT op. A saved query
// that named columns by their display names would be the one thing in the
// workbook that a rename still breaks.
//
// ERRORS ARE DATA. Every refusal below is a `{code, severity, message}` in
// validate.ts's and steps.ts's shape, so `showFindings` renders it with no
// translation layer. A parse error names the POSITION and what was expected; an
// unknown column names the column AND lists the ones that do exist, because dash
// holds the schema and a list of real column names answers the question the
// error is really asking. Nothing in this file throws at its caller.
//
// DELIBERATELY OUT OF THE FIRST CUT, and it SAYS SO rather than failing oddly:
// window functions, correlated subqueries, derived tables, `INSERT`/`UPDATE`/
// `DELETE` (an edit is a patch; a query is a question) and anything
// transactional. Each has its own refusal code and a sentence saying what to do
// instead.

import type { DashDoc, Sheet, Step, TableSheet } from './model.ts'
import {
  columnOf, materialize, runSteps, values,
  type Frame, type StepIssue, type StepSeverity,
} from './steps.ts'
import { FUNCTIONS } from './formula.ts'

// --- what a compile reports ---------------------------------------------------

/** steps.ts's `StepIssue`, plus the character position when the SQL text is at
 *  fault. A caller that only knows `StepIssue` renders these unchanged. */
export interface SqlIssue extends StepIssue {
  /** 0-based offset into the query text */
  pos?: number
}

export interface SqlColumn { id: string; name: string }

/** What the compiler needs to know about a sheet: its name and its columns.
 *  Derived from a `DashDoc` by `tablesOf`, or supplied directly by a rig. */
export interface SqlTable { id: string; name: string; columns: SqlColumn[] }

/**
 * One frame of a compiled query: a source, a step list, and the projection.
 *
 * A query with CTEs or a UNION compiles to SEVERAL of these, in the order they
 * must run — each intermediate is materialised and offered to the next through
 * `RunOpts.sheets`, which is the hook steps.ts already provides for exactly
 * this ("the SQL surface will want to resolve a CTE name to a frame it built").
 */
export interface QueryFrame {
  /** the name later frames refer to it by; '' for the final result */
  name: string
  /** sheet id, or the name of an earlier `QueryFrame` */
  from: string
  steps: Step[]
  /** column ids to keep, in order — SQL's projection */
  select: string[]
  /** display names of those columns, in the same order */
  names: string[]
}

export interface CompiledSql {
  ok: boolean
  issues: SqlIssue[]
  /** every frame, in execution order. The LAST one is the answer. */
  frames: QueryFrame[]
  /** the last of `frames`, or undefined when the compile failed */
  main?: QueryFrame
  sql: string
}

export interface SqlOpts {
  /** the workbook, for the sheet catalogue */
  doc?: DashDoc
  /** or the catalogue directly (a rig, or a caller with a partial workbook) */
  tables?: readonly SqlTable[]
}

const issue = (
  code: string, severity: StepSeverity, message: string, extra: Partial<SqlIssue> = {},
): SqlIssue => ({ code, severity, message, ...extra })

/** The sheet catalogue of a workbook. Table sheets only — a pivot or a canvas
 *  sheet is not a relation and pretending otherwise gives a query no columns. */
export function tablesOf(doc: DashDoc): SqlTable[] {
  const out: SqlTable[] = []
  for (const s of doc.sheets as Sheet[]) {
    if (s.kind !== 'table') continue
    out.push({
      id: s.id,
      name: s.name,
      columns: s.columns.map((c) => ({ id: c.id, name: c.name })),
    })
  }
  return out
}

// --- lexer --------------------------------------------------------------------

type TokKind = 'word' | 'name' | 'num' | 'str' | 'op' | 'punc' | 'eof'

interface Tok {
  t: TokKind
  /** the token's text: for `name`/`str` the UNQUOTED content */
  v: string
  /** uppercased `v`, for keyword comparison. Only on `word`. */
  up: string
  pos: number
  /** the quote a `name` arrived in, so an error can say "that was an identifier" */
  q?: string
  /** verbatim source text, kept for `num` so `0.10` survives as written */
  raw?: string
}

/** A parse failure, thrown internally and converted to an issue by `compileSql`.
 *  Nothing of this shape escapes this module. */
interface Fail { __sqlFail: true; code: string; message: string; pos: number }
const isFail = (e: unknown): e is Fail =>
  typeof e === 'object' && e !== null && (e as Fail).__sqlFail === true
function fail(code: string, message: string, pos: number): never {
  const f: Fail = { __sqlFail: true, code, message, pos }
  throw f
}

// UNICODE-AWARE, because dash ships in eight languages and a column called
// 売上 is a column. formula.ts's own lexer is ASCII-only for bare names, which
// costs nothing here: every column reference is emitted BRACKETED, and its
// bracket escape takes anything up to the `]`.
const WORD_START = /[\p{L}_]/u
const WORD_REST = /[\p{L}\p{N}_$]/u

function lexSql(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  const push = (t: TokKind, v: string, pos: number, extra: Partial<Tok> = {}): void => {
    out.push({ t, v, up: t === 'word' ? v.toUpperCase() : '', pos, ...extra })
  }
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    // -- comment, /* comment */. Dropped, but their length keeps positions honest.
    if (c === '-' && src[i + 1] === '-') {
      const nl = src.indexOf('\n', i)
      i = nl < 0 ? src.length : nl + 1
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end < 0) fail('sql-unterminated-comment', `SQL: a /* comment opened at position ${i} and never closed.`, i)
      i = end + 2
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(src.slice(i))!
      push('num', m[0], i, { raw: m[0] })
      i += m[0].length
      continue
    }
    // '…' is a STRING; '' inside is one quote. This is the difference from
    // formula.ts, where "…" is the string — the single most common thing to get
    // wrong when moving between the two, so it is the first thing tested.
    if (c === "'") {
      let j = i + 1
      let s = ''
      for (;;) {
        if (j >= src.length) fail('sql-unterminated-string', `SQL: a text value opened at position ${i} and never closed. Text is quoted with 'single quotes'.`, i)
        if (src[j] === "'") {
          if (src[j + 1] === "'") { s += "'"; j += 2; continue }
          j++
          break
        }
        s += src[j++]
      }
      push('str', s, i)
      i = j
      continue
    }
    // "…" and […] and `…` are IDENTIFIERS — `FROM "Q3 pipeline"` is a sheet
    // whose name has a space in it, which is what people actually type.
    if (c === '"' || c === '[' || c === '`') {
      const close = c === '[' ? ']' : c
      const end = src.indexOf(close, i + 1)
      if (end < 0) fail('sql-unterminated-name', `SQL: a quoted name opened at position ${i} with ${c} and never closed with ${close}.`, i)
      push('name', src.slice(i + 1, end), i, { q: c })
      i = end + 1
      continue
    }
    if (WORD_START.test(c)) {
      let j = i
      while (j < src.length && WORD_REST.test(src[j])) j++
      push('word', src.slice(i, j), i)
      i = j
      continue
    }
    const three = src.slice(i, i + 2)
    if (three === '<>' || three === '!=' || three === '<=' || three === '>=' || three === '||') {
      push('op', three, i)
      i += 2
      continue
    }
    if ('=<>+-*/%'.includes(c)) { push('op', c, i); i++; continue }
    if ('(),.;'.includes(c)) { push('punc', c, i); i++; continue }
    fail('sql-unexpected-character',
      `SQL: ${JSON.stringify(c)} at position ${i} is not something a query can contain. If it is part of a name, quote it — [like this] or "like this".`, i)
  }
  push('eof', '', src.length)
  return out
}

// --- AST ----------------------------------------------------------------------

type Expr =
  | { k: 'num'; v: number; raw: string; pos: number }
  | { k: 'str'; v: string; pos: number }
  | { k: 'bool'; v: boolean; pos: number }
  | { k: 'null'; pos: number }
  | { k: 'col'; table?: string; name: string; pos: number; quoted?: boolean }
  | { k: 'star'; table?: string; pos: number }
  | { k: 'call'; name: string; args: Expr[]; distinct: boolean; star: boolean; pos: number }
  | { k: 'bin'; op: string; l: Expr; r: Expr; pos: number }
  | { k: 'not'; e: Expr; pos: number }
  | { k: 'neg'; e: Expr; pos: number }
  | { k: 'in'; e: Expr; list: Expr[]; not: boolean; pos: number }
  | { k: 'between'; e: Expr; lo: Expr; hi: Expr; not: boolean; pos: number }
  | { k: 'isnull'; e: Expr; not: boolean; pos: number }
  | { k: 'like'; e: Expr; pat: Expr; not: boolean; pos: number }
  | { k: 'case'; whens: Array<{ when: Expr; then: Expr }>; other?: Expr; pos: number }

interface SelectItem { expr: Expr; as?: string; pos: number }
interface TableRef { table: string; alias: string; pos: number }
interface JoinSpec {
  kind: 'inner' | 'left'
  many: boolean
  ref: TableRef
  on: { l: Expr; r: Expr; pos: number }
  pos: number
}
interface Core {
  items: SelectItem[]
  from: TableRef
  joins: JoinSpec[]
  where?: Expr
  groupBy: Expr[]
  having?: Expr
  pos: number
}
interface OrderTerm { expr: Expr; desc: boolean; pos: number }
interface Stmt {
  ctes: Array<{ name: string; body: Stmt; pos: number }>
  arms: Core[]
  /** one per arm after the first: `UNION ALL` is true, bare `UNION` is false */
  unionAll: boolean[]
  order: OrderTerm[]
  limit?: number
  offset?: number
}

// --- parser -------------------------------------------------------------------
//
// Recursive descent, and precedence climbing for expressions. The whole grammar
// is small enough to read in one sitting, which is the point: a query language
// nobody can predict is worse than no query language.

/** Statements that are not questions. Each gets its own refusal. */
const DML = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'UPSERT', 'TRUNCATE',
  'CREATE', 'DROP', 'ALTER', 'GRANT', 'REVOKE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'START',
  'PRAGMA', 'VACUUM', 'ANALYZE', 'ATTACH', 'DETACH', 'SET', 'CALL', 'EXPLAIN',
])

/** Words that end an expression, so an alias without AS is not swallowed. */
const CLAUSE = new Set([
  'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'UNION',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'ON', 'AS',
  'AND', 'OR', 'NOT', 'THEN', 'WHEN', 'ELSE', 'END', 'BETWEEN', 'IN', 'IS',
  'LIKE', 'ASC', 'DESC', 'BY', 'WITH', 'SELECT', 'DISTINCT', 'ALL', 'OVER',
  // The set operators end an expression too. Without them `FROM deals INTERSECT
  // …` reads INTERSECT as a table ALIAS, and the refusal that explains why
  // INTERSECT is not in this cut never gets to fire — the query dies as a parse
  // error four tokens later instead.
  'INTERSECT', 'EXCEPT', 'MINUS',
])

function parseSql(src: string): Stmt {
  const toks = lexSql(src)
  let p = 0
  const peek = (k = 0): Tok => toks[Math.min(p + k, toks.length - 1)]
  const next = (): Tok => toks[p++]
  const isWord = (w: string, k = 0): boolean => peek(k).t === 'word' && peek(k).up === w
  const eatWord = (w: string): boolean => { if (isWord(w)) { p++; return true } return false }
  const isPunc = (c: string, k = 0): boolean => peek(k).t === 'punc' && peek(k).v === c
  const eatPunc = (c: string): boolean => { if (isPunc(c)) { p++; return true } return false }

  const shown = (t: Tok): string => (t.t === 'eof' ? 'the end of the query' : JSON.stringify(t.v))
  const expected = (what: string): never => {
    const t = peek()
    return fail('sql-parse', `SQL: expected ${what} at position ${t.pos}, but found ${shown(t)}.`, t.pos)
  }
  const wantWord = (w: string, what = w): void => { if (!eatWord(w)) expected(what) }
  const wantPunc = (c: string, what = JSON.stringify(c)): void => { if (!eatPunc(c)) expected(what) }

  /** An identifier: a bare word, or a quoted name. Keywords are not identifiers. */
  const wantName = (what: string): { v: string; quoted: boolean; pos: number } => {
    const t = peek()
    if (t.t === 'name') { p++; return { v: t.v, quoted: true, pos: t.pos } }
    if (t.t === 'word' && !CLAUSE.has(t.up)) { p++; return { v: t.v, quoted: false, pos: t.pos } }
    return expected(what)
  }

  // ---- expressions

  function parseExpr(): Expr { return parseOr() }

  function parseOr(): Expr {
    let l = parseAnd()
    while (isWord('OR')) {
      const pos = next().pos
      l = { k: 'bin', op: 'OR', l, r: parseAnd(), pos }
    }
    return l
  }
  function parseAnd(): Expr {
    let l = parseNot()
    while (isWord('AND')) {
      const pos = next().pos
      l = { k: 'bin', op: 'AND', l, r: parseNot(), pos }
    }
    return l
  }
  function parseNot(): Expr {
    if (isWord('NOT')) {
      const pos = next().pos
      return { k: 'not', e: parseNot(), pos }
    }
    return parseCompare()
  }

  function parseCompare(): Expr {
    let l = parseConcat()
    for (;;) {
      const t = peek()
      if (t.t === 'op' && ['=', '<>', '!=', '<', '<=', '>', '>='].includes(t.v)) {
        p++
        l = { k: 'bin', op: t.v === '!=' ? '<>' : t.v, l, r: parseConcat(), pos: t.pos }
        continue
      }
      const not = isWord('NOT') && (isWord('IN', 1) || isWord('BETWEEN', 1) || isWord('LIKE', 1))
      if (not) p++
      if (isWord('IN')) {
        const pos = next().pos
        wantPunc('(', 'a list of values in brackets after IN')
        if (isWord('SELECT')) {
          fail('sql-subquery-unsupported',
            `SQL: a subquery inside IN (position ${peek().pos}) is not in this first cut. Put it in a WITH clause and JOIN to it, or list the values.`,
            peek().pos)
        }
        const list: Expr[] = []
        if (!isPunc(')')) { do { list.push(parseExpr()) } while (eatPunc(',')) }
        wantPunc(')')
        if (!list.length) {
          fail('sql-empty-in', `SQL: IN () at position ${pos} has no values, so it can never match anything.`, pos)
        }
        l = { k: 'in', e: l, list, not, pos }
        continue
      }
      if (isWord('BETWEEN')) {
        const pos = next().pos
        const lo = parseConcat()
        wantWord('AND', 'AND between the two bounds of BETWEEN')
        const hi = parseConcat()
        l = { k: 'between', e: l, lo, hi, not, pos }
        continue
      }
      if (isWord('LIKE')) {
        const pos = next().pos
        l = { k: 'like', e: l, pat: parseConcat(), not, pos }
        continue
      }
      if (not) expected('IN, BETWEEN or LIKE after NOT')
      if (isWord('IS')) {
        const pos = next().pos
        const isNot = eatWord('NOT')
        if (!eatWord('NULL')) expected('NULL after IS')
        l = { k: 'isnull', e: l, not: isNot, pos }
        continue
      }
      return l
    }
  }

  function parseConcat(): Expr {
    let l = parseAdd()
    while (peek().t === 'op' && peek().v === '||') {
      const pos = next().pos
      l = { k: 'bin', op: '||', l, r: parseAdd(), pos }
    }
    return l
  }
  function parseAdd(): Expr {
    let l = parseMul()
    while (peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const t = next()
      l = { k: 'bin', op: t.v, l, r: parseMul(), pos: t.pos }
    }
    return l
  }
  function parseMul(): Expr {
    let l = parseUnary()
    while (peek().t === 'op' && (peek().v === '*' || peek().v === '/' || peek().v === '%')) {
      const t = next()
      l = { k: 'bin', op: t.v, l, r: parseUnary(), pos: t.pos }
    }
    return l
  }
  function parseUnary(): Expr {
    const t = peek()
    if (t.t === 'op' && t.v === '-') { p++; return { k: 'neg', e: parseUnary(), pos: t.pos } }
    if (t.t === 'op' && t.v === '+') { p++; return parseUnary() }
    return parsePrimary()
  }

  function parsePrimary(): Expr {
    const t = peek()
    if (t.t === 'num') { p++; return { k: 'num', v: Number(t.v), raw: t.raw ?? t.v, pos: t.pos } }
    if (t.t === 'str') { p++; return { k: 'str', v: t.v, pos: t.pos } }
    if (t.t === 'op' && t.v === '*') { p++; return { k: 'star', pos: t.pos } }
    if (t.t === 'punc' && t.v === '(') {
      p++
      if (isWord('SELECT') || isWord('WITH')) {
        fail('sql-subquery-unsupported',
          `SQL: a subquery at position ${peek().pos} is not in this first cut — a query is compiled to a step pipeline, and a correlated subquery is not a pipeline. Name it in a WITH clause and JOIN to it instead.`,
          peek().pos)
      }
      const e = parseExpr()
      wantPunc(')')
      return e
    }
    if (t.t === 'word' && t.up === 'CASE') return parseCase()
    if (t.t === 'word' && t.up === 'EXISTS') {
      fail('sql-subquery-unsupported',
        `SQL: EXISTS at position ${t.pos} needs a subquery, which is not in this first cut. A LEFT JOIN plus "IS NOT NULL" asks the same question as a step pipeline.`, t.pos)
    }
    if (t.t === 'word' && t.up === 'NULL') { p++; return { k: 'null', pos: t.pos } }
    if (t.t === 'word' && (t.up === 'TRUE' || t.up === 'FALSE')) {
      p++
      return { k: 'bool', v: t.up === 'TRUE', pos: t.pos }
    }
    if (t.t === 'word' || t.t === 'name') {
      // a call?
      if (t.t === 'word' && isPunc('(', 1)) return parseCall()
      const first = wantName('a column name')
      if (isPunc('.')) {
        p++
        if (peek().t === 'op' && peek().v === '*') { const s = next(); return { k: 'star', table: first.v, pos: s.pos } }
        const second = wantName('a column name after the dot')
        return { k: 'col', table: first.v, name: second.v, pos: first.pos, quoted: second.quoted }
      }
      return { k: 'col', name: first.v, pos: first.pos, quoted: first.quoted }
    }
    return expected('a value, a column or a function')
  }

  function parseCall(): Expr {
    const t = next()
    wantPunc('(')
    let distinct = false
    let star = false
    const args: Expr[] = []
    if (eatWord('DISTINCT')) distinct = true
    if (peek().t === 'op' && peek().v === '*' && isPunc(')', 1)) { p++; star = true } else if (!isPunc(')')) {
      do { args.push(parseExpr()) } while (eatPunc(','))
    }
    wantPunc(')')
    if (isWord('OVER')) {
      fail('sql-window-unsupported',
        `SQL: ${t.v} OVER (…) at position ${peek().pos} is a window function, which is not in this first cut. Every step in the pipeline is a whole-frame operation; a window is per-row-with-a-neighbourhood and needs its own op. Compute it with a GROUP BY into a WITH clause and JOIN back.`,
        peek().pos)
    }
    return { k: 'call', name: t.up, args, distinct, star, pos: t.pos }
  }

  function parseCase(): Expr {
    const pos = next().pos
    if (!isWord('WHEN')) {
      fail('sql-case-form',
        `SQL: CASE at position ${pos} must be the searched form — CASE WHEN <condition> THEN <value> … END. The CASE <expr> WHEN <value> form is not in this cut.`, pos)
    }
    const whens: Array<{ when: Expr; then: Expr }> = []
    while (eatWord('WHEN')) {
      const when = parseExpr()
      wantWord('THEN', 'THEN after a CASE condition')
      whens.push({ when, then: parseExpr() })
    }
    const other = eatWord('ELSE') ? parseExpr() : undefined
    wantWord('END', 'END to close CASE')
    return { k: 'case', whens, other, pos }
  }

  // ---- clauses

  function parseTableRef(what: string): TableRef {
    if (isPunc('(')) {
      fail('sql-derived-table-unsupported',
        `SQL: a derived table (a SELECT in the FROM clause) at position ${peek().pos} is not in this first cut. Name it in a WITH clause — that is the same thing with a name on it, and the name becomes a real intermediate frame.`,
        peek().pos)
    }
    const n = wantName(what)
    let alias = n.v
    if (eatWord('AS')) alias = wantName('an alias after AS').v
    else if (peek().t === 'word' && !CLAUSE.has(peek().up)) alias = wantName('an alias').v
    else if (peek().t === 'name') alias = wantName('an alias').v
    return { table: n.v, alias, pos: n.pos }
  }

  function parseCore(): Core {
    const pos = peek().pos
    wantWord('SELECT')
    if (isWord('DISTINCT')) {
      fail('sql-distinct-unsupported',
        `SQL: SELECT DISTINCT at position ${peek().pos} is not in this first cut. "GROUP BY" the same columns says the same thing and compiles to a group step you can see.`,
        peek().pos)
    }
    eatWord('ALL')
    const items: SelectItem[] = []
    do {
      const ipos = peek().pos
      const expr = parseExpr()
      let as: string | undefined
      if (eatWord('AS')) as = wantName('an alias after AS').v
      else if ((peek().t === 'word' && !CLAUSE.has(peek().up)) || peek().t === 'name') {
        as = wantName('an alias').v
      }
      items.push({ expr, as, pos: ipos })
    } while (eatPunc(','))

    wantWord('FROM', 'FROM and one sheet to read')
    const from = parseTableRef('a sheet name')
    if (isPunc(',')) {
      fail('sql-cross-join',
        `SQL: a comma-separated FROM list at position ${peek().pos} is a cross join, which multiplies every row of one sheet by every row of the other. Write "JOIN <sheet> ON <key> = <key>" so the join has a declared key and the engine can check its grain.`,
        peek().pos)
    }

    const joins: JoinSpec[] = []
    for (;;) {
      const jpos = peek().pos
      if (isWord('RIGHT') || isWord('FULL') || isWord('CROSS') || isWord('NATURAL')) {
        const w = peek().up
        fail('sql-join-unsupported',
          w === 'RIGHT'
            ? `SQL: RIGHT JOIN at position ${jpos} is not in this cut. The step engine joins LEFT — swap the two sheets and write LEFT JOIN, which is the same answer with the rows the right way up.`
            : `SQL: ${w} JOIN at position ${jpos} is not in this cut. ${w === 'CROSS' || w === 'NATURAL' ? 'It joins without a declared key, which is exactly the grain the engine has to be able to check.' : 'A FULL join keeps unmatched rows from both sides, which the step engine has no shape for; UNION two LEFT joins instead.'}`,
          jpos)
      }
      let kind: 'inner' | 'left' | null = null
      if (isWord('INNER')) { p++; kind = 'inner' }
      else if (isWord('LEFT')) { p++; eatWord('OUTER'); kind = 'left' }
      if (!isWord('JOIN')) {
        if (kind) expected('JOIN')
        break
      }
      p++
      if (kind === null) kind = 'inner'
      const many = eatWord('MANY')
      const ref = parseTableRef('a sheet name to join')
      const onPos = peek().pos
      wantWord('ON', 'ON and the two key columns')
      const cond = parseExpr()
      if (cond.k !== 'bin' || cond.op !== '=') {
        fail('sql-join-condition',
          `SQL: the ON at position ${onPos} must be a single equality between one column on each side — "ON left.key = right.key". The join step carries exactly one key pair, because that pair is what lets the engine check the join's grain and refuse a fan-out.`,
          onPos)
      }
      joins.push({ kind, many, ref, on: { l: cond.l, r: cond.r, pos: onPos }, pos: jpos })
    }

    const where = eatWord('WHERE') ? parseExpr() : undefined
    const groupBy: Expr[] = []
    if (eatWord('GROUP')) {
      wantWord('BY', 'BY after GROUP')
      do { groupBy.push(parseExpr()) } while (eatPunc(','))
    }
    const having = eatWord('HAVING') ? parseExpr() : undefined
    return { items, from, joins, where, groupBy, having, pos }
  }

  // ---- the statement

  const ctes: Stmt['ctes'] = []
  if (eatWord('WITH')) {
    if (eatWord('RECURSIVE')) {
      fail('sql-recursive-cte',
        `SQL: WITH RECURSIVE at position ${peek().pos} is not in this cut. A recursive CTE is a loop, and a step pipeline is a straight line.`,
        peek().pos)
    }
    do {
      const n = wantName('a name for the WITH clause')
      wantWord('AS', 'AS after the name')
      wantPunc('(', '( and the query the name stands for')
      if (isWord('WITH')) {
        fail('sql-nested-with',
          `SQL: a WITH inside a WITH at position ${peek().pos} is not in this cut. Lift it out — every name in one WITH clause can see the ones declared before it.`,
          peek().pos)
      }
      const body = parseInner()
      wantPunc(')')
      ctes.push({ name: n.v, body, pos: n.pos })
    } while (eatPunc(','))
  }
  const stmt = parseInner()
  stmt.ctes = ctes
  if (isPunc(';')) {
    p++
    if (peek().t !== 'eof') {
      fail('sql-one-statement',
        `SQL: there is a second statement at position ${peek().pos}. A query is one question; run them one at a time so each one's steps are its own.`,
        peek().pos)
    }
  }
  if (peek().t !== 'eof') expected('the end of the query')
  return stmt

  /** A statement without its own WITH clause: the arms, then ORDER BY / LIMIT.
   *  ORDER BY and LIMIT are parsed ONCE at the end and belong to the WHOLE
   *  compound, which is what every engine does and what people mean. */
  function parseInner(): Stmt {
    const arms: Core[] = [parseCore()]
    const unionAll: boolean[] = []
    while (isWord('UNION')) {
      p++
      const all = eatWord('ALL')
      if (isWord('DISTINCT')) p++
      unionAll.push(all)
      arms.push(parseCore())
    }
    if (isWord('INTERSECT') || isWord('EXCEPT')) {
      fail('sql-setop-unsupported',
        `SQL: ${peek().up} at position ${peek().pos} is not in this cut — the format has a union op and no intersect or except. A JOIN plus "IS NOT NULL" (or "IS NULL") asks the same two questions.`,
        peek().pos)
    }
    const order: OrderTerm[] = []
    if (eatWord('ORDER')) {
      wantWord('BY', 'BY after ORDER')
      do {
        const opos = peek().pos
        const e = parseExpr()
        let desc = false
        if (eatWord('DESC')) desc = true
        else eatWord('ASC')
        if (isWord('NULLS')) {
          fail('sql-nulls-ordering',
            `SQL: NULLS FIRST/LAST at position ${peek().pos} is not in this cut. Blanks sort in one fixed place here, the same place the grid's column sort puts them, so a sorted query and a sorted grid never disagree.`,
            peek().pos)
        }
        order.push({ expr: e, desc, pos: opos })
      } while (eatPunc(','))
    }
    let limit: number | undefined
    let offset: number | undefined
    if (eatWord('LIMIT')) {
      const t = peek()
      if (t.t !== 'num') expected('a row count after LIMIT')
      p++
      limit = Number(t.v)
      if (isPunc(',')) {
        fail('sql-limit-comma',
          `SQL: "LIMIT ${t.v}, n" at position ${peek().pos} is MySQL's offset-first spelling and reads backwards to everyone else. Write "LIMIT n OFFSET ${t.v}".`,
          peek().pos)
      }
      if (eatWord('OFFSET')) {
        const o = peek()
        if (o.t !== 'num') expected('a row count after OFFSET')
        p++
        offset = Number(o.v)
      }
    } else if (isWord('OFFSET')) {
      fail('sql-offset-without-limit',
        `SQL: OFFSET at position ${peek().pos} has no LIMIT. The limit step takes a window; say how many rows you want.`,
        peek().pos)
    }
    return { ctes: [], arms, unionAll, order, limit, offset }
  }
}

// --- the expression compiler --------------------------------------------------
//
// SQL expression → formula.ts expression. The translation table is in the file
// header; what lives here is the mechanics, and the mechanics have exactly one
// rule worth stating: PRECEDENCE IS PRESERVED BY EMISSION, not by wrapping
// everything in brackets. `price * qty + fee` comes out as `[price] * [qty] +
// [fee]`, because a query saved in a document is read by people.

/** formula.ts's binding powers (formula.ts PREC), so the emitter can bracket
 *  exactly when it must. */
const FPREC: Record<string, number> = {
  '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1,
  '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5,
}

/** SQL binary operator → formula.ts operator, for the ones that map directly. */
const OPMAP: Record<string, string> = {
  '=': '=', '<>': '<>', '<': '<', '>': '>', '<=': '<=', '>=': '>=',
  '+': '+', '-': '-', '*': '*', '/': '/', '||': '&',
}

/**
 * The aggregate names a GROUP BY may use.
 *
 * The first cut's list is SUM/COUNT/AVG/MIN/MAX/COUNT DISTINCT. The rest are
 * here because they cost NOTHING: steps.ts's `aggregate` hands any name it does
 * not open-code to `evaluate` as `NAME(_g)`, so every aggregate formula.ts knows
 * already works. That is the whole argument for one expression language, and the
 * rig checks the claim by resolving every entry here through steps.ts's own
 * alias table into formula.ts's `FUNCTIONS`.
 *
 * The VALUE is the `fn` written into the step. `COUNT` is deliberately NOT
 * `count`: see `compileAgg`.
 */
const AGG_FN: Record<string, string> = {
  SUM: 'sum', AVG: 'avg', AVERAGE: 'avg', MIN: 'min', MAX: 'max',
  COUNT: 'counta', MEDIAN: 'median', STDEV: 'stdev', STDEVP: 'stdevp',
  VAR: 'var', VARP: 'varp', PRODUCT: 'product', MODE: 'mode',
}

/** What a column reference resolved to. */
interface Bound {
  /** id IN THE FRAME — a joined column that clashed carries its sheet prefix */
  id: string
  name: string
  /** the table alias it arrived from; '' for something the pipeline computed */
  from: string
}

interface Ctx {
  /** every column currently visible, in order */
  scope: Bound[]
  /** aggregate key → the group column it becomes */
  aggs: Map<string, string>
  /** GROUP BY expression → the key column it became. `SELECT UPPER(region) …
   *  GROUP BY UPPER(region)` must READ the key the group step made: after a
   *  group the frame holds keys and aggregates and nothing else, so recomputing
   *  the expression would name a column that is no longer there. */
  keys: Map<string, string>
  /** a derived aggregate argument, by expression, so two aggregates over the
   *  same computation share one derive step */
  derivedFor: Map<string, string>
  /** alias (lowercased) → the table it stands for; empty when no schema */
  tables: Map<string, { table?: SqlTable; alias: string }>
  /** (alias U+001F sourceColumnId) → the frame column it becomes */
  bound: Map<string, Bound>
  /** true when the compiler was given a catalogue and may check names */
  typed: boolean
  /** true once a group step has been emitted. A reference to a column the group
   *  consumed can then say WHY it is gone instead of "no such column". */
  grouped: boolean
  /** the base table's alias, for unqualified references */
  base: string
}

const SEP = '\u001f'

const list = (xs: string[], max = 12): string =>
  xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')} and ${xs.length - max} more`

/** A column reference formula.ts will read back as this exact name. */
function refText(id: string, pos: number): string {
  if (id.includes(']')) {
    fail('sql-unreferenceable-column',
      `The column id ${JSON.stringify(id)} contains a "]", so it cannot be written into an expression — formula.ts's [bracketed name] escape has no escape of its own. Rename the column.`,
      pos)
  }
  return `[${id}]`
}

/** A number, written so formula.ts's lexer reads it back unchanged. Its lexer
 *  takes digits and dots only, so `1e-7` has to be spelt out. */
function numText(e: { v: number; raw: string }): string {
  if (/^\d*\.?\d+$/.test(e.raw)) return e.raw
  return e.v.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 })
}

/** A text value, in formula.ts's quotes. */
function strText(v: string, pos: number): string {
  // formula.ts's lexer ends a string at the first `"` and its `""` branch is
  // unreachable, so a double quote inside a value cannot survive the round trip.
  // Refusing is the only honest answer available from this side of the seam.
  if (v.includes('"')) {
    fail('sql-unquotable-text',
      `The text value ${JSON.stringify(v)} contains a double quote, which formula.ts's string literal cannot carry. Compare against the value without it, or store it in a column.`,
      pos)
  }
  return `"${v}"`
}

/** LIKE, for the patterns that translate exactly. */
function likeText(target: string, pat: Expr, not: boolean, pos: number): string {
  if (pat.k !== 'str') {
    fail('sql-like-pattern',
      `SQL: LIKE at position ${pos} needs a literal pattern — a pattern computed per row would have to be re-parsed per row.`, pos)
  }
  const raw = pat.v
  if (raw.includes('_')) {
    fail('sql-like-underscore',
      `SQL: the LIKE pattern ${JSON.stringify(raw)} at position ${pos} uses "_" (any single character), which has no equivalent in the expression language. Use % at the ends, or compare with LEFT/RIGHT/FIND.`, pos)
  }
  const lead = raw.startsWith('%')
  const tail = raw.endsWith('%') && raw.length > 1
  const core = raw.slice(lead ? 1 : 0, tail ? raw.length - 1 : raw.length)
  if (core.includes('%')) {
    fail('sql-like-pattern',
      `SQL: the LIKE pattern ${JSON.stringify(raw)} at position ${pos} has a % in the middle. Only 'starts%', '%ends' and '%contains%' translate exactly; anything else would have to guess.`, pos)
  }
  const lit = strText(core.toLowerCase(), pos)
  // Case-INSENSITIVE, which is LIKE's usual behaviour on ASCII and is also what
  // formula.ts's `=` already does. The two agreeing is the point.
  let out: string
  if (lead && tail) out = `ISNUMBER(FIND(${lit}, LOWER(${target})))`
  else if (lead) out = `RIGHT(LOWER(${target}), ${core.length}) = ${lit}`
  else if (tail) out = `LEFT(LOWER(${target}), ${core.length}) = ${lit}`
  else out = `${target} = ${lit}`
  return not ? `NOT(${out})` : out
}

/**
 * Emit one expression.
 *
 * `min` is the binding power of the context, so a child that binds less tightly
 * brackets itself and nothing else does.
 */
function emit(e: Expr, ctx: Ctx, min: number): string {
  // A grouped expression is READ, not recomputed. Empty until a group step has
  // been emitted, so this costs nothing in an ungrouped query.
  const key = ctx.keys.get(exprKey(e))
  if (key) return refText(key, e.pos)
  switch (e.k) {
    case 'num': return numText(e)
    case 'str': return strText(e.v, e.pos)
    case 'bool': return e.v ? 'TRUE' : 'FALSE'
    case 'null': return '""'
    case 'star':
      return fail('sql-star-in-expression',
        `SQL: "*" at position ${e.pos} means every column, and it can only stand on its own in the SELECT list or inside COUNT(*).`, e.pos)
    case 'col': return refText(resolveCol(e, ctx).id, e.pos)
    case 'neg': {
      const s = `-${emit(e.e, ctx, 5)}`
      return min > 5 ? `(${s})` : s
    }
    case 'not': return `NOT(${emit(e.e, ctx, 0)})`
    case 'isnull': {
      const inner = `ISBLANK(${emit(e.e, ctx, 0)})`
      return e.not ? `NOT(${inner})` : inner
    }
    case 'in': {
      const target = emit(e.e, ctx, 1)
      const parts = e.list.map((x) => `${target} = ${emit(x, ctx, 2)}`)
      const inner = parts.length === 1 ? parts[0] : `OR(${parts.join(', ')})`
      return e.not ? `NOT(${inner})` : inner
    }
    case 'between': {
      const target = emit(e.e, ctx, 1)
      const inner = `AND(${target} >= ${emit(e.lo, ctx, 2)}, ${target} <= ${emit(e.hi, ctx, 2)})`
      return e.not ? `NOT(${inner})` : inner
    }
    case 'like': return likeText(emit(e.e, ctx, 0), e.pat, e.not, e.pos)
    case 'case': {
      const parts: string[] = []
      for (const w of e.whens) parts.push(emit(w.when, ctx, 0), emit(w.then, ctx, 0))
      // A CASE with no ELSE is NULL in SQL; blank is this format's nothing, and
      // IFS's own #N/A would read as an error the author never wrote.
      parts.push('TRUE', e.other ? emit(e.other, ctx, 0) : '""')
      return `IFS(${parts.join(', ')})`
    }
    case 'call': {
      const key = aggKeyOf(e)
      if (key) {
        const col = ctx.aggs.get(key)
        if (!col) {
          return fail('sql-aggregate-here',
            `SQL: ${e.name} at position ${e.pos} is an aggregate, and an aggregate can only appear in the SELECT list, in HAVING or in ORDER BY — never in WHERE, and never inside another aggregate. WHERE chooses rows BEFORE they are grouped; HAVING chooses groups after.`,
            e.pos)
        }
        return refText(col, e.pos)
      }
      if (!FUNCTIONS.includes(e.name)) {
        return fail('sql-unknown-function',
          `SQL: there is no function named ${JSON.stringify(e.name)} (position ${e.pos}). This workbook knows ${FUNCTIONS.length} — ${list(FUNCTIONS.filter((f) => f[0] === e.name[0]), 10) || list(FUNCTIONS, 10)} — and a query uses the same ones a cell does.`,
          e.pos)
      }
      return `${e.name}(${e.args.map((a) => emit(a, ctx, 0)).join(', ')})`
    }
    case 'bin': {
      if (e.op === 'AND' || e.op === 'OR') {
        return `${e.op}(${emit(e.l, ctx, 0)}, ${emit(e.r, ctx, 0)})`
      }
      if (e.op === '%') return `MOD(${emit(e.l, ctx, 0)}, ${emit(e.r, ctx, 0)})`
      if ((e.op === '=' || e.op === '<>') && (e.l.k === 'null' || e.r.k === 'null')) {
        return fail('sql-null-comparison',
          `SQL: comparing with NULL at position ${e.pos} is never true, in SQL or here — write "IS NULL" or "IS NOT NULL", which compiles to ISBLANK.`,
          e.pos)
      }
      const op = OPMAP[e.op]
      if (!op) {
        return fail('sql-unknown-operator',
          `SQL: the operator ${JSON.stringify(e.op)} at position ${e.pos} has no meaning in an expression here.`, e.pos)
      }
      const prec = FPREC[op]
      const s = `${emit(e.l, ctx, prec)} ${op} ${emit(e.r, ctx, prec + 1)}`
      return prec < min ? `(${s})` : s
    }
  }
}

/**
 * An expression's identity, ignoring where it was written.
 *
 * Two things need it. `SUM(value)` in the SELECT list and `SUM(value)` in
 * HAVING must become ONE group column rather than two that happen to agree; and
 * `GROUP BY UPPER(region)` followed by `SELECT UPPER(region)` must READ the key
 * the group made rather than recompute it over a column the group consumed.
 * Names are folded, because SQL identifiers are.
 */
function exprKey(e: Expr): string {
  switch (e.k) {
    case 'num': return `n${e.v}`
    case 'str': return `s${JSON.stringify(e.v)}`
    case 'bool': return `b${e.v}`
    case 'null': return 'null'
    case 'col': return `c${(e.table ?? '').toLowerCase()}.${e.name.toLowerCase()}`
    case 'star': return `*${(e.table ?? '').toLowerCase()}`
    case 'call': return `${e.name}(${e.distinct ? 'D' : ''}${e.star ? '*' : ''}${e.args.map(exprKey).join(',')})`
    case 'bin': return `(${exprKey(e.l)}${e.op}${exprKey(e.r)})`
    case 'not': return `!${exprKey(e.e)}`
    case 'neg': return `-${exprKey(e.e)}`
    case 'in': return `${exprKey(e.e)}${e.not ? '!' : ''}IN(${e.list.map(exprKey).join(',')})`
    case 'between': return `${exprKey(e.e)}${e.not ? '!' : ''}BTW(${exprKey(e.lo)},${exprKey(e.hi)})`
    case 'isnull': return `${exprKey(e.e)}${e.not ? '!' : ''}NULL?`
    case 'like': return `${exprKey(e.e)}${e.not ? '!' : ''}LIKE(${exprKey(e.pat)})`
    case 'case':
      return `CASE(${e.whens.map((w) => `${exprKey(w.when)}=>${exprKey(w.then)}`).join(',')};${e.other ? exprKey(e.other) : ''})`
  }
}

/** The canonical name of an aggregate call. `null` when it is not an aggregate. */
function aggKeyOf(e: Expr): string | null {
  if (e.k !== 'call') return null
  const fn = AGG_FN[e.name]
  if (!fn) return null
  const arg = e.args[0]
  return `${fn}|${e.distinct ? 'd' : ''}|${e.star || !arg ? '*' : exprKey(arg)}`
}

/** Resolve a column reference against the current scope. */
function resolveCol(e: Expr & { k: 'col' }, ctx: Ctx): Bound {
  if (!ctx.typed) return { id: e.table ? `${e.table}.${e.name}` : e.name, name: e.name, from: ctx.base }
  if (e.table) {
    const t = ctx.tables.get(e.table.toLowerCase())
    if (!t) {
      return fail('sql-unknown-table',
        `SQL: nothing in this query is called ${JSON.stringify(e.table)} (position ${e.pos}). The names in scope are ${list([...ctx.tables.keys()])}.`,
        e.pos)
    }
    const col = t.table?.columns.find((c) => sameName(c.name, e.name) || sameName(c.id, e.name))
    if (!col) {
      return fail('sql-unknown-column',
        `SQL: ${JSON.stringify(e.table)} has no column ${JSON.stringify(e.name)} (position ${e.pos}). It has ${list((t.table?.columns ?? []).map((c) => c.name))}.`,
        e.pos)
    }
    const hit = ctx.bound.get(`${e.table.toLowerCase()}${SEP}${col.id}`)
    if (hit) return hit
    if (ctx.grouped) {
      return fail('sql-not-grouped',
        `SQL: ${JSON.stringify(`${e.table}.${e.name}`)} (position ${e.pos}) is neither one of the GROUP BY keys nor inside an aggregate, so this query does not say which of a group's rows it means. Add it to GROUP BY, or wrap it in MIN/MAX/COUNT. After grouping this query has ${list(ctx.scope.map((b) => b.name))}.`,
        e.pos)
    }
    return fail('sql-column-not-carried',
      `SQL: ${JSON.stringify(e.name)} from ${JSON.stringify(e.table)} (position ${e.pos}) is not available at this point in the pipeline.`,
      e.pos)
  }
  // AMBIGUITY IS DECIDED AT THE SOURCE, not in the frame. A join only carries
  // the columns the query asked for, so an unqualified `owner` that two sheets
  // both have would otherwise resolve QUIETLY to whichever one happened to be
  // carried — the base — and the query would answer a question nobody asked.
  if (ctx.typed) {
    const seen = new Set<string>()
    const owners: string[] = []
    for (const [, t] of ctx.tables) {
      if (!t.table || seen.has(t.alias)) continue
      seen.add(t.alias)
      if (t.table.columns.some((c) => sameName(c.name, e.name) || sameName(c.id, e.name))) owners.push(t.table.name)
    }
    if (owners.length > 1) {
      return fail('sql-ambiguous-column',
        `SQL: ${JSON.stringify(e.name)} at position ${e.pos} is a column of ${list(owners)}, so this query does not say which one it means. Qualify it — "${owners[0]}.${e.name}".`,
        e.pos)
    }
  }
  const matches = ctx.scope.filter((b) => sameName(b.name, e.name) || sameName(b.id, e.name))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    return fail('sql-ambiguous-column',
      `SQL: ${JSON.stringify(e.name)} at position ${e.pos} could mean more than one column here (${list(matches.map((m) => m.id))}). Qualify it with the sheet it belongs to.`,
      e.pos)
  }
  // After a group, the columns the group CONSUMED are gone. "no such column" is
  // true and useless; the author's actual mistake has a name.
  if (ctx.grouped) {
    for (const [, t] of ctx.tables) {
      if (!t.table?.columns.some((c) => sameName(c.name, e.name) || sameName(c.id, e.name))) continue
      return fail('sql-not-grouped',
        `SQL: ${JSON.stringify(e.name)} (position ${e.pos}) is neither one of the GROUP BY keys nor inside an aggregate, so this query does not say WHICH ${JSON.stringify(e.name)} it means — a group holds many rows. Add it to GROUP BY, or wrap it in MIN/MAX/COUNT. The columns this query has after grouping are ${list(ctx.scope.map((b) => b.name))}.`,
        e.pos)
    }
  }
  const hint = e.quoted
    ? ' (double quotes mean a NAME in SQL — if you meant a text value, use \'single quotes\')'
    : ''
  return fail('sql-unknown-column',
    `SQL: there is no column ${JSON.stringify(e.name)} here (position ${e.pos})${hint}. The columns available at this point are ${list(ctx.scope.map((b) => b.name))}.`,
    e.pos)
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * Add a column the pipeline computed, SHADOWING any column of the same id.
 *
 * `stepDerive` does exactly this to the frame (`columns.filter(c => c.id !==
 * id)` and then push), so a scope that kept both would see two columns where
 * the frame has one — and `SELECT owner AS owner` would then read as an
 * ambiguous reference to a column that is not ambiguous at all.
 */
function addColumn(ctx: Ctx, bound: Bound): void {
  const at = ctx.scope.findIndex((b) => b.id === bound.id)
  if (at >= 0) ctx.scope.splice(at, 1)
  ctx.scope.push(bound)
}

/** Every column reference an expression makes, for working out which fields a
 *  join has to carry. */
function refsIn(e: Expr, out: Array<Expr & { k: 'col' }>): void {
  switch (e.k) {
    case 'col': out.push(e); break
    case 'bin': refsIn(e.l, out); refsIn(e.r, out); break
    case 'not': case 'neg': refsIn(e.e, out); break
    case 'isnull': refsIn(e.e, out); break
    case 'like': refsIn(e.e, out); refsIn(e.pat, out); break
    case 'in': refsIn(e.e, out); e.list.forEach((x) => refsIn(x, out)); break
    case 'between': refsIn(e.e, out); refsIn(e.lo, out); refsIn(e.hi, out); break
    case 'call': e.args.forEach((a) => refsIn(a, out)); break
    case 'case':
      for (const w of e.whens) { refsIn(w.when, out); refsIn(w.then, out) }
      if (e.other) refsIn(e.other, out)
      break
    default: break
  }
}

/** Does this expression contain an aggregate call? */
function hasAgg(e: Expr): boolean {
  if (aggKeyOf(e)) return true
  switch (e.k) {
    case 'bin': return hasAgg(e.l) || hasAgg(e.r)
    case 'not': case 'neg': case 'isnull': return hasAgg(e.e)
    case 'like': return hasAgg(e.e)
    case 'in': return hasAgg(e.e) || e.list.some(hasAgg)
    case 'between': return hasAgg(e.e) || hasAgg(e.lo) || hasAgg(e.hi)
    case 'call': return e.args.some(hasAgg)
    case 'case': return e.whens.some((w) => hasAgg(w.when) || hasAgg(w.then)) || (e.other ? hasAgg(e.other) : false)
    default: return false
  }
}

/** Collect the aggregate calls in an expression, outermost first. */
function aggsIn(e: Expr, out: Array<Expr & { k: 'call' }>): void {
  if (e.k === 'call' && aggKeyOf(e)) { out.push(e); return }
  switch (e.k) {
    case 'bin': aggsIn(e.l, out); aggsIn(e.r, out); break
    case 'not': case 'neg': case 'isnull': aggsIn(e.e, out); break
    case 'like': aggsIn(e.e, out); break
    case 'in': aggsIn(e.e, out); e.list.forEach((x) => aggsIn(x, out)); break
    case 'between': aggsIn(e.e, out); aggsIn(e.lo, out); aggsIn(e.hi, out); break
    case 'call': e.args.forEach((a) => aggsIn(a, out)); break
    case 'case':
      for (const w of e.whens) { aggsIn(w.when, out); aggsIn(w.then, out) }
      if (e.other) aggsIn(e.other, out)
      break
    default: break
  }
}

// --- the statement compiler ---------------------------------------------------

interface Builder {
  /** every frame emitted so far, in run order */
  frames: QueryFrame[]
  /** CTE/arm name (lowercased) → its output columns, so later frames type-check */
  made: Map<string, SqlTable>
  catalogue: readonly SqlTable[]
  /** auto-names for union arms, unique within one compile */
  n: number
}

function findTable(b: Builder, ref: string): SqlTable | undefined {
  const made = b.made.get(ref.toLowerCase())
  if (made) return made
  return b.catalogue.find((t) => sameName(t.name, ref)) ?? b.catalogue.find((t) => t.id === ref)
}

/**
 * One SELECT arm → one `QueryFrame`. This is the whole compile table:
 *
 *     JOIN … ON      → join   (+ filter, for INNER — see the header)
 *     WHERE          → filter (pushed BEFORE the joins when it can be)
 *     GROUP BY       → group  (+ derive, for a computed key or measure)
 *     HAVING         → filter
 *     SELECT expr    → derive
 *     SELECT cols    → the projection, which is not a step
 *     ORDER BY       → sort   (one per key, emitted in reverse — see `tailSteps`)
 *     LIMIT/OFFSET   → limit
 *     UNION          → union  (each arm is its own frame)
 *     WITH           → a named frame, run first
 *
 * `tail` is the statement's ORDER BY, which belongs to the whole statement but
 * has to be seen HERE: `ORDER BY SUM(value)` names an aggregate, and the group
 * step that makes it is this arm's.
 */
function compileCore(
  core: Core, b: Builder, name: string, typed: boolean, tail: Expr[] = [],
): { frame: QueryFrame; ctx: Ctx } {
  const steps: Step[] = []

  // ---- FROM
  const baseTable = typed ? findTable(b, core.from.table) : undefined
  if (typed && !baseTable) {
    fail('sql-unknown-table',
      `SQL: there is no sheet called ${JSON.stringify(core.from.table)} in this workbook (position ${core.from.pos}). It holds ${list(b.catalogue.map((t) => t.name))}.`,
      core.from.pos)
  }
  const ctx: Ctx = {
    scope: [], aggs: new Map(), keys: new Map(), derivedFor: new Map(), tables: new Map(), bound: new Map(),
    typed, grouped: false, base: core.from.alias.toLowerCase(),
  }
  ctx.tables.set(core.from.alias.toLowerCase(), { table: baseTable, alias: ctx.base })
  if (!sameName(core.from.alias, core.from.table)) {
    ctx.tables.set(core.from.table.toLowerCase(), { table: baseTable, alias: ctx.base })
  }
  for (const c of baseTable?.columns ?? []) {
    const bound: Bound = { id: c.id, name: c.name, from: ctx.base }
    ctx.scope.push(bound)
    ctx.bound.set(`${ctx.base}${SEP}${c.id}`, bound)
  }

  // ---- JOIN … ON
  //
  // Two passes, because `fields` (which right columns come across) decides the
  // NAMES of the joined columns — steps.ts renames a column only when its id is
  // already taken — and the query's own references decide `fields`.
  if (core.joins.length && !typed) {
    fail('sql-no-schema',
      `SQL: this query joins sheets, and it was compiled without the workbook's column list. A join needs the schema: which columns to carry across, and what to call them when both sides have a column of the same name.`,
      core.joins[0].pos)
  }
  for (const j of core.joins) {
    const t = findTable(b, j.ref.table)
    if (!t) {
      fail('sql-unknown-table',
        `SQL: there is no sheet called ${JSON.stringify(j.ref.table)} to join to (position ${j.ref.pos}). This workbook holds ${list(b.catalogue.map((x) => x.name))}.`,
        j.ref.pos)
    }
    ctx.tables.set(j.ref.alias.toLowerCase(), { table: t, alias: j.ref.alias.toLowerCase() })
    if (!sameName(j.ref.alias, j.ref.table)) ctx.tables.set(j.ref.table.toLowerCase(), { table: t, alias: j.ref.alias.toLowerCase() })
  }
  const wanted = new Map<string, Set<string>>()   // join alias → source column ids
  if (core.joins.length) {
    const all: Array<Expr & { k: 'col' }> = []
    for (const it of core.items) refsIn(it.expr, all)
    if (core.where) refsIn(core.where, all)
    for (const g of core.groupBy) refsIn(g, all)
    if (core.having) refsIn(core.having, all)
    for (const e of tail) refsIn(e, all)
    const stars = core.items.filter((it) => it.expr.k === 'star') as Array<SelectItem & { expr: Expr & { k: 'star' } }>
    for (const j of core.joins) {
      const alias = j.ref.alias.toLowerCase()
      const t = ctx.tables.get(alias)!.table!
      const set = new Set<string>()
      // the join key always travels: an INNER join tests it, and a LEFT join's
      // reader deserves to see which key matched.
      const rk = keyColumn(j.on, alias, ctx, t, 'right')
      set.add(rk.id)
      for (const r of all) {
        if (!r.table) continue
        if (r.table.toLowerCase() !== alias) continue
        const c = t.columns.find((x) => sameName(x.name, r.name) || sameName(x.id, r.name))
        if (c) set.add(c.id)
      }
      // an unqualified reference that only this sheet can satisfy
      for (const r of all) {
        if (r.table) continue
        const here = t.columns.find((x) => sameName(x.name, r.name) || sameName(x.id, r.name))
        if (!here) continue
        const onBase = (baseTable?.columns ?? []).some((x) => sameName(x.name, r.name) || sameName(x.id, r.name))
        if (!onBase) set.add(here.id)
      }
      for (const s of stars) {
        if (!s.expr.table || s.expr.table.toLowerCase() === alias) for (const c of t.columns) set.add(c.id)
      }
      wanted.set(alias, set)
    }
  }
  for (const j of core.joins) {
    const alias = j.ref.alias.toLowerCase()
    const t = ctx.tables.get(alias)!.table!
    const taken = new Set(ctx.scope.map((s) => s.id))
    const left = keyColumn(j.on, alias, ctx, t, 'left')
    const right = keyColumn(j.on, alias, ctx, t, 'right')
    const fields = t.columns.filter((c) => wanted.get(alias)!.has(c.id)).map((c) => c.id)
    steps.push({
      op: 'join', with: t.id, on: [left.id, right.id],
      card: j.many ? 'many' : 'one', fields,
    })
    let keyBound: Bound | undefined
    for (const id of fields) {
      const c = t.columns.find((x) => x.id === id)!
      const clash = taken.has(c.id)
      const bound: Bound = {
        id: clash ? `${t.id}.${c.id}` : c.id,
        name: clash ? `${t.name}.${c.name}` : c.name,
        from: alias,
      }
      ctx.scope.push(bound)
      ctx.bound.set(`${alias}${SEP}${c.id}`, bound)
      if (c.id === right.id) keyBound = bound
    }
    // INNER JOIN = the engine's left join, plus the filter that drops the rows
    // which found nothing. Visible in the step list, not hidden in a flag.
    if (j.kind === 'inner') {
      steps.push({ op: 'filter', where: `NOT(ISBLANK(${refText(keyBound!.id, j.pos)}))` })
    }
  }

  // ---- WHERE
  //
  // Emitted BEFORE the joins when it can be: a predicate that names only the
  // base sheet's columns decides the same rows either side of a join (a left
  // join keeps every left row; a declared fan-out repeats them), so pushing it
  // down is free and shrinks the frame the join has to index. When the predicate
  // touches a joined column it stays where it was written.
  if (core.where) {
    if (hasAgg(core.where)) {
      const a: Array<Expr & { k: 'call' }> = []
      aggsIn(core.where, a)
      fail('sql-aggregate-in-where',
        `SQL: WHERE cannot see ${a[0].name}(…) (position ${a[0].pos}) — WHERE chooses ROWS, and an aggregate does not exist until the rows have been grouped. Move that condition to HAVING.`,
        a[0].pos)
    }
    const where = emit(core.where, ctx, 0)
    const refs: Array<Expr & { k: 'col' }> = []
    refsIn(core.where, refs)
    // RESOLVED, not merely unqualified: `WHERE team = 'Alpha'` names no sheet
    // and still comes from the joined one, and pushing that predicate above its
    // own join would filter on a column that does not exist yet.
    const baseOnly = refs.every((r) => resolveCol(r, ctx).from === ctx.base)
    if (baseOnly && core.joins.length) steps.unshift({ op: 'filter', where })
    else steps.push({ op: 'filter', where })
  }

  // ---- GROUP BY, and the aggregates that force one
  const aggCalls: Array<Expr & { k: 'call' }> = []
  for (const it of core.items) aggsIn(it.expr, aggCalls)
  if (core.having) aggsIn(core.having, aggCalls)
  for (const e of tail) aggsIn(e, aggCalls)
  const grouping = core.groupBy.length > 0 || aggCalls.length > 0

  const projected: Array<{ id: string; name: string }> = []
  if (grouping) {
    const by: string[] = []
    const byNames = new Map<string, string>()
    for (const g of core.groupBy) {
      if (hasAgg(g)) {
        fail('sql-aggregate-in-group',
          `SQL: GROUP BY cannot group by an aggregate (position ${g.pos}) — the aggregate is what the grouping produces.`, g.pos)
      }
      if (g.k === 'col') {
        const bnd = resolveCol(g, ctx)
        by.push(bnd.id)
        byNames.set(bnd.id, bnd.name)
        ctx.keys.set(exprKey(g), bnd.id)
        continue
      }
      // A computed key is a derive first, so the group has a real column to key
      // on and a reader can see what the key WAS.
      const id = `_g${by.length + 1}`
      steps.push({ op: 'derive', col: id, name: id, expr: emit(g, ctx, 0) })
      addColumn(ctx, { id, name: id, from: '' })
      by.push(id)
      byNames.set(id, id)
      ctx.keys.set(exprKey(g), id)
    }
    // Aggregate arguments that are expressions become derived columns too — the
    // step's `of` names a column, and `SUM(price * qty)` names a computation.
    const aggSpecs: Array<{ fn: string; of?: string; as: string }> = []
    const used = new Set<string>(by)
    let derivedN = 0
    for (const call of aggCalls) {
      const key = aggKeyOf(call)!
      if (ctx.aggs.has(key)) continue
      const fn = AGG_FN[call.name]
      let of: string | undefined
      if (!call.star) {
        const arg = call.args[0]
        if (!arg) {
          fail('sql-aggregate-argument',
            `SQL: ${call.name}() at position ${call.pos} has nothing to aggregate.`, call.pos)
        }
        if (arg.k === 'col') of = resolveCol(arg, ctx).id
        else {
          const ek = exprKey(arg)
          const already = ctx.derivedFor.get(ek)
          if (already) of = already
          else {
            const id = `_a${++derivedN}`
            steps.push({ op: 'derive', col: id, name: id, expr: emit(arg, ctx, 0) })
            addColumn(ctx, { id, name: id, from: '' })
            ctx.derivedFor.set(ek, id)
            of = id
          }
        }
      } else if (call.name !== 'COUNT') {
        fail('sql-star-aggregate',
          `SQL: ${call.name}(*) at position ${call.pos} has no meaning — only COUNT(*) counts rows. ${call.name} needs a column.`, call.pos)
      }
      // COUNT(*) is the number of ROWS in the group, which is a different
      // question from "how many numbers are in this column", so it alone gets
      // the engine's `count` with no `of`. COUNT(x) counts NON-NULLS, which is
      // COUNTA — and NOT the engine's `count`, which counts numbers and would
      // report 0 deals on a column of names.
      const stepFn = call.star ? 'count' : call.distinct ? 'countdistinct' : fn
      const alias = aliasFor(call, core.items)
      const base = alias ?? defaultAggName(call, of)
      let as = base
      let k = 2
      while (used.has(as)) as = `${base}_${k++}`
      used.add(as)
      aggSpecs.push({ fn: stepFn, ...(of ? { of } : {}), as })
      ctx.aggs.set(key, as)
    }
    steps.push({ op: 'group', by, agg: aggSpecs })
    // The frame is now the group's OUTPUT and nothing else: keys and aggregates.
    ctx.scope = [
      ...by.map((id) => ({ id, name: byNames.get(id) ?? id, from: '' })),
      ...aggSpecs.map((a) => ({ id: a.as, name: a.as, from: '' })),
    ]
    ctx.grouped = true
    ctx.bound.clear()
    for (const bnd of ctx.scope) {
      for (const [k, v] of ctx.tables) {
        if (v.table?.columns.some((c) => c.id === bnd.id)) ctx.bound.set(`${k}${SEP}${bnd.id}`, bnd)
      }
    }
  }

  // ---- HAVING
  if (core.having) {
    if (!grouping) {
      fail('sql-having-without-group',
        `SQL: HAVING at position ${core.having.pos ?? 0} filters GROUPS, and this query does not group anything. WHERE is the one that filters rows.`, 0)
    }
    steps.push({ op: 'filter', where: emit(core.having, ctx, 0) })
  }

  // ---- SELECT — derives for the expressions, and the projection
  let derived = 0
  for (const it of core.items) {
    if (it.expr.k === 'star') {
      if (grouping) {
        fail('sql-star-grouped',
          `SQL: "*" at position ${it.expr.pos} cannot follow a GROUP BY — after grouping, the only columns that exist are the keys and the aggregates. Name them.`,
          it.expr.pos)
      }
      const t = it.expr.table?.toLowerCase()
      if (t && !ctx.tables.has(t)) {
        fail('sql-unknown-table',
          `SQL: "${it.expr.table}.*" at position ${it.expr.pos} names something this query does not read. The names in scope are ${list([...ctx.tables.keys()])}.`,
          it.expr.pos)
      }
      const want = t ? ctx.tables.get(t)!.alias : null
      for (const bnd of ctx.scope) {
        if (want !== null && bnd.from !== want) continue
        projected.push({ id: bnd.id, name: bnd.name })
      }
      continue
    }
    // A bare column is a projection and nothing more: no step, no copy. That is
    // most of what a SELECT list is. An alias that says what the column is
    // already called (`SELECT deals.owner AS owner`, which is how people
    // disambiguate) renames nothing and costs nothing either.
    if (it.expr.k === 'col') {
      const bnd = resolveCol(it.expr, ctx)
      if (!it.as || sameName(it.as, bnd.name)) {
        projected.push({ id: bnd.id, name: bnd.name })
        continue
      }
    }
    // An aggregate that IS the whole item already has its column, under the
    // alias if one was given.
    const key = aggKeyOf(it.expr)
    if (key && ctx.aggs.has(key) && (!it.as || ctx.aggs.get(key) === it.as)) {
      const id = ctx.aggs.get(key)!
      projected.push({ id, name: id })
      continue
    }
    // An expression, or a column being renamed. Either way it is one `derive`,
    // and a renamed column costs one column of memory — the honest price for a
    // format whose only projection mechanism is a column list.
    const id = it.as ?? `_c${++derived}`
    steps.push({ op: 'derive', col: id, name: id, expr: emit(it.expr, ctx, 0) })
    addColumn(ctx, { id, name: id, from: '' })
    projected.push({ id, name: id })
  }
  if (!projected.length) {
    fail('sql-empty-select', 'SQL: the SELECT list produced no columns.', core.pos)
  }

  return {
    frame: {
      name,
      from: baseTable ? baseTable.id : core.from.table,
      steps,
      select: projected.map((c) => c.id),
      names: projected.map((c) => c.name),
    },
    ctx,
  }
}

/** The alias an aggregate should take: only when the select item is EXACTLY
 *  that aggregate, so `SUM(a) AS x` names the column and `SUM(a)/2 AS x` does
 *  not steal the name from the aggregate it contains. */
function aliasFor(call: Expr & { k: 'call' }, items: SelectItem[]): string | undefined {
  for (const it of items) if (it.expr === call && it.as) return it.as
  return undefined
}

/** `SUM(value)` → `sum_value`, `COUNT(*)` → `count`. The SQL spelling, not the
 *  step's `fn`: an author who wrote COUNT(owner) should not have to know that
 *  the step says `counta` because that is the one that counts what SQL counts. */
function defaultAggName(call: Expr & { k: 'call' }, of?: string): string {
  if (call.star) return 'count'
  return `${call.distinct ? 'countdistinct' : call.name.toLowerCase()}_${of ?? 'rows'}`
}

/** One side of a join's ON. It must name a column, and the two sides must name
 *  DIFFERENT tables — otherwise the join has no key on one side. */
function keyColumn(
  on: { l: Expr; r: Expr; pos: number }, alias: string, ctx: Ctx, right: SqlTable,
  which: 'left' | 'right',
): Bound {
  const sideOf = (e: Expr): 'left' | 'right' | null => {
    if (e.k !== 'col') return null
    if (e.table) return e.table.toLowerCase() === alias ? 'right' : 'left'
    return right.columns.some((c) => sameName(c.name, e.name) || sameName(c.id, e.name))
      && !ctx.scope.some((b) => sameName(b.name, e.name) || sameName(b.id, e.name))
      ? 'right' : 'left'
  }
  const ls = sideOf(on.l)
  const rs = sideOf(on.r)
  if (!ls || !rs || ls === rs) {
    fail('sql-join-condition',
      `SQL: the ON at position ${on.pos} must name one column from each side of the join — "ON <this side>.key = ${alias}.key". ${ls === rs ? 'Both sides here name the same sheet, so the join has no key.' : 'One side is not a plain column.'}`,
      on.pos)
  }
  const pick = ls === which ? on.l : on.r
  if (pick.k !== 'col') fail('sql-join-condition', `SQL: the ON at position ${on.pos} must compare two columns.`, on.pos)
  if (which === 'right') {
    const c = right.columns.find((x) => sameName(x.name, pick.name) || sameName(x.id, pick.name))
    if (!c) {
      fail('sql-unknown-column',
        `SQL: ${JSON.stringify(right.name)} has no column ${JSON.stringify(pick.name)} to join on (position ${pick.pos}). It has ${list(right.columns.map((x) => x.name))}.`,
        pick.pos)
    }
    return { id: c.id, name: c.name, from: alias }
  }
  return resolveCol(pick, ctx)
}

/** ORDER BY and LIMIT, which belong to the whole statement. */
function tailSteps(stmt: Stmt, frame: QueryFrame, ctx: Ctx): void {
  // Multiple keys become multiple sort steps applied in REVERSE. steps.ts's
  // comparator tie-breaks on position, which makes it a TOTAL order and
  // therefore stable by construction — so sorting by the least significant key
  // first and the most significant last is exactly SQL's multi-key ordering.
  for (let i = stmt.order.length - 1; i >= 0; i--) {
    const term = stmt.order[i]
    let id: string
    if (term.expr.k === 'num') {
      const n = term.expr.v
      if (!Number.isInteger(n) || n < 1 || n > frame.select.length) {
        fail('sql-order-ordinal',
          `SQL: ORDER BY ${n} at position ${term.pos} names select item ${n}, and there ${frame.select.length === 1 ? 'is 1' : `are ${frame.select.length}`}.`,
          term.pos)
      }
      id = frame.select[n - 1]
    } else if (term.expr.k === 'col') {
      id = resolveCol(term.expr, ctx).id
    } else {
      const key = aggKeyOf(term.expr)
      if (key && ctx.aggs.has(key)) id = ctx.aggs.get(key)!
      else {
        id = `_o${i + 1}`
        frame.steps.push({ op: 'derive', col: id, name: id, expr: emit(term.expr, ctx, 0) })
        addColumn(ctx, { id, name: id, from: '' })
      }
    }
    frame.steps.push({ op: 'sort', by: id, dir: term.desc ? 'desc' : 'asc' })
  }
  if (stmt.limit !== undefined) {
    frame.steps.push({
      op: 'limit', n: stmt.limit,
      ...(stmt.offset ? { offset: stmt.offset } : {}),
    })
  }
}

/** A statement (its CTEs, its arms, its tail) → the frames that answer it. */
function compileStmt(stmt: Stmt, b: Builder, name: string, typed: boolean): QueryFrame {
  for (const cte of stmt.ctes) {
    if (b.made.has(cte.name.toLowerCase())) {
      fail('sql-duplicate-cte',
        `SQL: ${JSON.stringify(cte.name)} is declared twice in the same WITH clause (position ${cte.pos}).`, cte.pos)
    }
    const f = compileStmt(cte.body, b, cte.name, typed)
    b.made.set(cte.name.toLowerCase(), {
      id: cte.name, name: cte.name,
      columns: f.select.map((id, i) => ({ id, name: f.names[i] })),
    })
  }

  const arms: QueryFrame[] = []
  let headCtx: Ctx | undefined
  for (let i = 0; i < stmt.arms.length; i++) {
    const armName = i === 0 ? name : `${name || 'query'}__union${++b.n}`
    // The statement's ORDER BY is compiled against the FIRST arm, because that
    // is the arm whose group step could have made the column it names. A union
    // may only be ordered by an output column, which is SQL's own rule.
    const tail = stmt.arms.length === 1 ? stmt.order.map((o) => o.expr) : []
    const f = compileCore(stmt.arms[i], b, armName, typed, tail)
    if (i === 0) headCtx = f.ctx
    arms.push(f.frame)
  }

  const head = arms[0]
  if (arms.length > 1) {
    // Every arm is materialised and stacked onto the first. steps.ts's union
    // matches columns BY NAME (model.ts: dash's columns have identity and SQL's
    // do not), so mismatched names would file amounts under dates. Refusing is
    // the only answer that cannot print a table half full of blanks.
    for (let i = 1; i < arms.length; i++) {
      const a = arms[i]
      if (a.names.length !== head.names.length) {
        fail('sql-union-width',
          `SQL: the UNION's arms return different numbers of columns (${head.names.length} and ${a.names.length}).`,
          stmt.arms[i].pos)
      }
      for (let c = 0; c < a.names.length; c++) {
        if (!sameName(a.names[c], head.names[c])) {
          fail('sql-union-names',
            `SQL: column ${c + 1} of the UNION is ${JSON.stringify(head.names[c])} in the first arm and ${JSON.stringify(a.names[c])} in arm ${i + 1}. This format unions by column NAME, not by position — that is what stops two sheets with the same columns in a different order from stacking amounts onto dates — so alias them to match: "${a.names[c]} AS ${head.names[c]}".`,
            stmt.arms[i].pos)
        }
      }
      b.frames.push(a)
      head.steps.push({ op: 'union', with: a.name, all: stmt.unionAll[i - 1] })
    }
  }

  // A single-arm statement orders against the arm's own scope, so `ORDER BY
  // pipeline DESC` finds the aggregate column the group step made. After a
  // union the frame is the union's OUTPUT, and only the projected columns exist.
  const ctx: Ctx = arms.length === 1 ? headCtx! : {
    scope: head.select.map((id, i) => ({ id, name: head.names[i], from: '' })),
    aggs: new Map(), keys: new Map(), derivedFor: new Map(), tables: new Map(),
    bound: new Map(), typed, grouped: false, base: '',
  }
  tailSteps(stmt, head, ctx)
  b.frames.push(head)
  return head
}

/**
 * Compile SQL to steps. NEVER throws: a failure is `{ok:false, issues}`.
 */
export function compileSql(sql: string, opts: SqlOpts = {}): CompiledSql {
  const catalogue = opts.tables ?? (opts.doc ? tablesOf(opts.doc) : undefined)
  const typed = catalogue !== undefined
  const b: Builder = { frames: [], made: new Map(), catalogue: catalogue ?? [], n: 0 }
  try {
    const head = firstWord(sql)
    if (head && DML.has(head.up)) {
      return {
        ok: false, frames: [], sql,
        issues: [issue('sql-not-a-question', 'fatal',
          `${head.up} is not a query. An edit to a workbook is a PATCH — it is undoable, it merges under collaboration and it carries who changed what and why — and a query is a question asked of the data as it stands. Change data through the grid, an import or a patch step; ask questions with SELECT.`,
          { pos: head.pos })],
      }
    }
    const stmt = parseSql(sql)
    const main = compileStmt(stmt, b, '', typed)
    return { ok: true, issues: [], frames: b.frames, main, sql }
  } catch (e) {
    if (isFail(e)) {
      return { ok: false, frames: [], sql, issues: [issue(e.code, 'fatal', e.message, { pos: e.pos })] }
    }
    return {
      ok: false, frames: [], sql,
      issues: [issue('sql-compiler-threw', 'fatal',
        `The query could not be compiled: ${e instanceof Error ? e.message : String(e)}`)],
    }
  }
}

function firstWord(sql: string): { up: string; pos: number } | null {
  try {
    const toks = lexSql(sql)
    const t = toks[0]
    return t && t.t === 'word' ? { up: t.up, pos: t.pos } : null
  } catch { return null }
}

// --- running ------------------------------------------------------------------

export interface SqlRunOpts extends SqlOpts {
  /** frozen `TODAY()`/`NOW()`, exactly as steps.ts takes it */
  now?: string
}

export interface SqlResult {
  ok: boolean
  issues: SqlIssue[]
  compiled: CompiledSql
  /** the answer, projected to the SELECT list. Absent when the query failed. */
  frame?: Frame
  /** the intermediates, by name, for a caller that wants to show a CTE */
  made: Map<string, TableSheet>
}

/**
 * Narrow a frame to a projection.
 *
 * NOT A STEP, and not a copy: `Frame.columns` is metadata, and dropping entries
 * from it drops the columns from every reader downstream — `values`, `materialize`
 * and the grid all walk that list. A SELECT list therefore costs one array.
 */
export function project(frame: Frame, ids: readonly string[]): Frame {
  const columns = []
  for (const id of ids) {
    const c = columnOf(frame, id)
    if (c) columns.push(c)
  }
  return { src: frame.src, rows: frame.rows, n: frame.n, columns, derived: frame.derived }
}

/**
 * Compile and run. The ordinary call, and the one the query editor will make.
 *
 * Every intermediate frame (a CTE, a UNION arm) is materialised and offered to
 * the frames after it through `RunOpts.sheets` — the hook steps.ts documents for
 * exactly this. The FINAL frame is not materialised: it is handed back as a
 * frame so the caller decides whether it becomes a sheet, a preview or a chart.
 */
export function runSql(sql: string, opts: SqlRunOpts = {}): SqlResult {
  const compiled = compileSql(sql, opts)
  const made = new Map<string, TableSheet>()
  if (!compiled.ok || !compiled.main) {
    return { ok: false, issues: compiled.issues, compiled, made }
  }
  const issues: SqlIssue[] = []
  const doc = opts.doc
  const sheets = (ref: string): TableSheet | undefined =>
    made.get(ref) ?? made.get(ref.toLowerCase())

  for (const f of compiled.frames) {
    const src = sheets(f.from) ?? findSheet(doc, f.from)
    if (!src) {
      issues.push(issue('sql-missing-source', 'fatal',
        `The query reads ${JSON.stringify(f.from)}, which is not a table sheet in this workbook.`))
      return { ok: false, issues, compiled, made }
    }
    const r = runSteps(src, f.steps, { doc, sheets, now: opts.now })
    for (const i of r.issues) {
      issues.push(f.name ? { ...i, message: `${f.name}: ${i.message}` } : { ...i })
    }
    if (!r.ok) return { ok: false, issues, compiled, made }
    const out = project(r.frame, f.select)
    if (out.columns.length !== f.select.length) {
      const got = new Set(out.columns.map((c) => c.id))
      issues.push(issue('sql-projection-lost', 'fatal',
        `The result should hold ${f.select.join(', ')}, but ${f.select.filter((id) => !got.has(id)).join(', ')} is not in the frame the steps produced. That is a compiler bug, not a data problem.`))
      return { ok: false, issues, compiled, made }
    }
    if (f === compiled.main) {
      return { ok: true, issues, compiled, frame: out, made }
    }
    made.set(f.name, materialize(out, { id: f.name, name: f.name }))
  }
  return { ok: false, issues, compiled, made }
}

function findSheet(doc: DashDoc | undefined, ref: string): TableSheet | undefined {
  for (const s of (doc?.sheets ?? []) as Sheet[]) {
    if (s.kind === 'table' && (s.id === ref || s.name === ref)) return s
  }
  return undefined
}

/**
 * The first `max` rows of a frame as plain objects — the shape an agent or a
 * console wants, and deliberately capped: a query over ten million rows should
 * answer a scripting caller in a screenful, not in a heap.
 */
export function sqlRows(frame: Frame, max = 100): Array<Record<string, unknown>> {
  const n = Math.min(frame.n, Math.max(0, max))
  const cols = frame.columns.map((c) => ({ name: c.name || c.id, v: values(frame, c.id) }))
  const out: Array<Record<string, unknown>> = []
  for (let i = 0; i < n; i++) {
    const row: Record<string, unknown> = {}
    for (const c of cols) {
      const x = c.v ? (c.v[i] ?? null) : null
      row[c.name] = x !== null && typeof x === 'object' ? String(x) : x
    }
    out.push(row)
  }
  return out
}

export const _internals = {
  lexSql, parseSql, AGG_FN, OPMAP, FPREC, likeText, strText, numText, DML,
}
