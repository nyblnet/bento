#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash SQL surface rig.
//
//   node scripts/test-dash-sql.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. sql.ts compiles a query to `Step[]` and runs NOTHING, so
// every failure here is a pipeline that does not say what the query said — and
// a pipeline that answers a slightly different question looks exactly like a
// pipeline that answers yours.
//
//   1. THE COMPILE TABLE IS EXACT. The showcase query from docs/dash-sql.md is
//      asserted against the literal `Step[]` it must produce — clause by clause,
//      in order. A compiler that emitted the right steps in the wrong ORDER
//      (HAVING before GROUP BY, WHERE after a fan-out) would still "work" on
//      easy data and be wrong on real data.
//   2. THE TRANSLATIONS ARE REAL. SQL's `<>`, `'text'`, `"identifier"`,
//      `IS NULL`, `IN`, `BETWEEN`, `AND`/`OR` and `||` are not formula.ts's
//      spelling of the same ideas. Each translation is asserted on the emitted
//      string AND executed, because a string that looks right and evaluates to
//      #NAME? is the failure this rig exists to catch.
//   3. THE REFUSALS FIRE. Everything out of scope has a code and a sentence
//      saying what to do instead. A query language that fails oddly teaches
//      people to distrust the answers it DOES give.
//   4. A JOIN INHERITS THE ENGINE'S REFUSAL. A SQL `JOIN` declares `card:'one'`,
//      so a key that is not unique STOPS the pipeline instead of silently
//      doubling every total below it. `JOIN MANY` is the only way to opt in.
//   5. THE NUMBERS. Several queries are compiled AND run through `runSteps`, and
//      the totals are asserted. That is the only check that cannot be satisfied
//      by a plausible-looking step list.

import { registerHooks } from 'node:module'

registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

const {
  compileSql, runSql, project, sqlRows, tablesOf, _internals: sqlInternals,
} = await import('../dash/src/sql.ts')
const { runSteps, values, _internals: stepInternals } = await import('../dash/src/steps.ts')
const { FUNCTIONS } = await import('../dash/src/formula.ts')

type TableSheet = import('../dash/src/model.ts').TableSheet
type DashDoc = import('../dash/src/model.ts').DashDoc
type Step = import('../dash/src/model.ts').Step
type SqlResult = import('../dash/src/sql.ts').SqlResult
type CompiledSql = import('../dash/src/sql.ts').CompiledSql

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string): void {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// ----------------------------------------------------------------- fixtures

interface ColSpec { id: string; name?: string; type?: string }

function sheet(id: string, name: string, specs: ColSpec[], data: Record<string, unknown[]>): TableSheet {
  const n = Math.max(0, ...Object.values(data).map((v) => v.length))
  const out: TableSheet = {
    id, name, kind: 'table',
    rids: n ? [[1, n]] : [],
    nextRid: n + 1,
    columns: specs.map((s) => ({ id: s.id, name: s.name ?? s.id, type: (s.type ?? 'text') as never })) as never,
    data: {},
    steps: [{ op: 'import', from: 'rig', at: '2026-08-12T00:00:00.000Z' }],
  }
  for (const s of specs) out.data[s.id] = { enc: 'raw', v: (data[s.id] ?? new Array(n).fill(null)) as never }
  return out
}

// The running fixture. Deliberately awkward: a case-different region, a blank
// region, and one owner who is in no dimension row.
const DEALS = sheet('deals', 'deals',
  [
    { id: 'region', type: 'text' }, { id: 'owner', type: 'text' },
    { id: 'stage', type: 'text' }, { id: 'value', type: 'number' },
    { id: 'qty', type: 'number' },
  ],
  {
    region: ['North', 'north', 'South', 'South', null, 'North', 'East'],
    owner: ['ana', 'bo', 'ana', 'cy', 'bo', 'cy', 'zz'],
    stage: ['Won', 'Won', 'Lost', 'Won', 'Won', 'Lost', 'Won'],
    value: [100, 200, 50, 400, 25, 75, 10],
    qty: [1, 2, 1, 4, 1, 3, 1],
  },
)
const OWNERS = sheet('owners', 'owners',
  [{ id: 'name', type: 'text' }, { id: 'team', type: 'text' }],
  { name: ['ana', 'bo', 'cy'], team: ['Alpha', 'Beta', 'Alpha'] },
)
/** A dimension whose key is NOT unique — the fan-out the engine refuses. */
const DUPES = sheet('dupes', 'dupes',
  [{ id: 'name', type: 'text' }, { id: 'team', type: 'text' }],
  { name: ['ana', 'ana', 'bo', 'cy'], team: ['Alpha', 'Gamma', 'Beta', 'Alpha'] },
)
/** A sheet whose NAME has a space in it, and a column whose name does too. */
const Q3 = sheet('q3', 'Q3 pipeline',
  [{ id: 'region', type: 'text' }, { id: 'unit_price', name: 'unit price', type: 'number' }],
  { region: ['North', 'South'], unit_price: [10, 20] },
)
/** For UNION: the same shape under different column ids. */
const ARCHIVE = sheet('archive', 'archive',
  [{ id: 'region', type: 'text' }, { id: 'value', type: 'number' }],
  { region: ['West', 'North'], value: [7, 3] },
)
/** A dimension whose column NAME collides with the fact table's while its ID
 *  does not — steps.ts renames a joined column only when the ID is taken, so
 *  this is the case that genuinely leaves two columns called "owner". */
const PEOPLE = sheet('people', 'people',
  [{ id: 'pkey', type: 'text' }, { id: 'pname', name: 'owner', type: 'text' }],
  { pkey: ['ana', 'bo'], pname: ['Ana Ruiz', 'Bo Vinter'] },
)
/** Deterministic multi-key ordering: no blanks, no case tricks. */
const PAIRS = sheet('pairs', 'pairs',
  [{ id: 'region', type: 'text' }, { id: 'value', type: 'number' }],
  { region: ['A', 'B', 'A', 'B'], value: [1, 5, 9, 2] },
)
/** A dimension that shares a column NAME with the fact table, to exercise the
 *  clash renaming steps.ts performs when a joined id is already taken. */
const REGIONS = sheet('regions', 'regions',
  [{ id: 'region', type: 'text' }, { id: 'owner', type: 'text' }],
  { region: ['North', 'South', 'East'], owner: ['boss-n', 'boss-s', 'boss-e'] },
)

const DOC: DashDoc = {
  format: 'bento/dash', version: 1, docId: 'rig', title: 'sql rig',
  sheets: [DEALS, OWNERS, DUPES, Q3, ARCHIVE, PAIRS, REGIONS, PEOPLE],
} as DashDoc

const steps = (sql: string): Step[] => {
  const c = compileSql(sql, { doc: DOC })
  // A compile failure is REPORTED, not thrown: a rig that dies on the first
  // regression hides every other one, and the whole point of running it is to
  // see the shape of what broke.
  if (!c.ok) {
    checks++; failures++
    console.log(`  FAIL  ${sql.trim().slice(0, 50)} — did not compile: ${c.issues[0]?.message}`)
    return []
  }
  return c.main!.steps
}
/** The `where` of the nth filter step. */
const whereOf = (sql: string, n = 0): string => {
  const f = steps(sql).filter((s) => s.op === 'filter') as Array<{ where: string }>
  return f[n]?.where ?? '(no filter)'
}
const refuse = (sql: string): CompiledSql => compileSql(sql, { doc: DOC })
const code = (c: CompiledSql): string => (c.issues[0]?.code ?? '(none)')
const codes = (r: SqlResult): string[] => r.issues.map((i) => i.code)
const rows = (r: SqlResult): Array<Record<string, unknown>> => (r.frame ? sqlRows(r.frame) : [])

// ============================================================ 1. translations

console.log('\n--- the two dialects, translated')
{
  ok(whereOf("SELECT region FROM deals WHERE stage <> 'Lost'") === '[stage] <> "Lost"',
    `SQL <> and 'text' become formula.ts's <> and "text"  →  ${whereOf("SELECT region FROM deals WHERE stage <> 'Lost'")}`)
  ok(whereOf("SELECT region FROM deals WHERE stage != 'Lost'") === '[stage] <> "Lost"',
    '!= is not a formula operator, so it translates to <>')
  ok(whereOf('SELECT region FROM deals WHERE region IS NULL') === 'ISBLANK([region])',
    'IS NULL becomes ISBLANK')
  ok(whereOf('SELECT region FROM deals WHERE region IS NOT NULL') === 'NOT(ISBLANK([region]))',
    'IS NOT NULL becomes NOT(ISBLANK(…))')
  ok(whereOf("SELECT region FROM deals WHERE value > 10 AND stage = 'Won'")
    === 'AND([value] > 10, [stage] = "Won")', 'AND is a FUNCTION in formula.ts, not an operator')
  ok(whereOf("SELECT region FROM deals WHERE value > 10 OR stage = 'Won'")
    === 'OR([value] > 10, [stage] = "Won")', 'OR likewise')
  ok(whereOf("SELECT region FROM deals WHERE NOT stage = 'Won'") === 'NOT([stage] = "Won")',
    'NOT likewise')
  ok(whereOf('SELECT region FROM deals WHERE value BETWEEN 10 AND 20')
    === 'AND([value] >= 10, [value] <= 20)', 'BETWEEN expands to a pair of comparisons')
  ok(whereOf('SELECT region FROM deals WHERE value NOT BETWEEN 10 AND 20')
    === 'NOT(AND([value] >= 10, [value] <= 20))', 'NOT BETWEEN wraps it')
  ok(whereOf("SELECT region FROM deals WHERE owner IN ('ana','bo')")
    === 'OR([owner] = "ana", [owner] = "bo")', 'IN becomes an OR of equalities')
  ok(whereOf("SELECT region FROM deals WHERE owner NOT IN ('ana','bo')")
    === 'NOT(OR([owner] = "ana", [owner] = "bo"))', 'NOT IN wraps it')
  ok(whereOf("SELECT region FROM deals WHERE owner IN ('ana')") === '[owner] = "ana"',
    'a one-value IN does not need an OR at all')
  ok(whereOf("SELECT region FROM deals WHERE region = 'it''s'") === '[region] = "it\'s"',
    "'' inside a SQL string is one quote")
  ok(whereOf('SELECT region FROM deals WHERE value % 2 = 0') === 'MOD([value], 2) = 0',
    '% is MOD, because formula.ts has no modulo operator')
}
{
  const d = steps("SELECT region || '-' || owner AS tag FROM deals")
    .find((s) => s.op === 'derive') as { expr: string }
  ok(d.expr === '[region] & "-" & [owner]', `|| is formula.ts's &  →  ${d.expr}`)
}
{
  // Precedence is preserved by EMISSION, so a saved query reads like the query.
  const a = (steps('SELECT value * qty + 1 AS t FROM deals')[0] as { expr: string }).expr
  const b = (steps('SELECT (value + qty) * 2 AS t FROM deals')[0] as { expr: string }).expr
  const c = (steps('SELECT value - (qty - 1) AS t FROM deals')[0] as { expr: string }).expr
  ok(a === '[value] * [qty] + 1', `no gratuitous brackets  →  ${a}`)
  ok(b === '([value] + [qty]) * 2', `brackets kept where they carry meaning  →  ${b}`)
  ok(c === '[value] - ([qty] - 1)', `right-hand subtraction keeps its brackets  →  ${c}`)
}
{
  const e = (steps("SELECT CASE WHEN value > 100 THEN 'big' ELSE 'small' END AS s FROM deals")[0] as { expr: string }).expr
  ok(e === 'IFS([value] > 100, "big", TRUE, "small")', `CASE becomes IFS  →  ${e}`)
  const f = (steps("SELECT CASE WHEN value > 100 THEN 'big' END AS s FROM deals")[0] as { expr: string }).expr
  ok(f === 'IFS([value] > 100, "big", TRUE, "")',
    'a CASE with no ELSE falls through to blank, not to an error')
}
{
  ok(whereOf("SELECT region FROM deals WHERE region LIKE 'Nor%'") === 'LEFT(LOWER([region]), 3) = "nor"',
    "LIKE 'x%' is a LEFT comparison")
  ok(whereOf("SELECT region FROM deals WHERE region LIKE '%th'") === 'RIGHT(LOWER([region]), 2) = "th"',
    "LIKE '%x' is a RIGHT comparison")
  ok(whereOf("SELECT region FROM deals WHERE region LIKE '%ort%'") === 'ISNUMBER(FIND("ort", LOWER([region])))',
    "LIKE '%x%' is a FIND")
}

console.log('\n--- identifiers with spaces in them, which is what people type')
{
  const a = compileSql('SELECT region FROM "Q3 pipeline"', { doc: DOC })
  const b = compileSql('SELECT region FROM [Q3 pipeline]', { doc: DOC })
  const c = compileSql('SELECT region FROM `Q3 pipeline`', { doc: DOC })
  ok(a.ok && a.main!.from === 'q3', 'FROM "Q3 pipeline" resolves to the sheet id')
  ok(b.ok && b.main!.from === 'q3', 'FROM [Q3 pipeline] does too')
  ok(c.ok && c.main!.from === 'q3', 'and so does a backtick, because someone will type it')
  const jp = compileSql('SELECT 売上 FROM 会計', {
    tables: [{ id: 'kaikei', name: '会計', columns: [{ id: 'uriage', name: '売上' }] }],
  })
  ok(jp.ok && jp.main!.from === 'kaikei' && eq(jp.main!.select, ['uriage']),
    'a query in Japanese needs no quotes — dash ships in eight languages, and a column called 売上 is a column')
  const d = steps('SELECT "unit price" * 2 AS t FROM [Q3 pipeline]')[0] as { expr: string }
  ok(d.expr === '[unit_price] * 2',
    `a quoted column name compiles to its ID, so renaming the column cannot break the query  →  ${d.expr}`)
}
{
  // A double-quoted token is an IDENTIFIER in SQL. When someone means a value,
  // the error has to say so rather than "no such column".
  const c = refuse('SELECT region FROM deals WHERE stage <> "Lost"')
  ok(!c.ok && code(c) === 'sql-unknown-column' && c.issues[0].message.includes('single quotes'),
    'a double-quoted VALUE is diagnosed as the identifier SQL says it is, with the fix named')
}

// ============================================================ 2. clause → step

console.log('\n--- the compile table')
{
  ok(eq(steps("SELECT region FROM deals WHERE stage <> 'Lost'"),
    [{ op: 'filter', where: '[stage] <> "Lost"' }]), 'WHERE → filter, and nothing else')
  ok(eq(steps('SELECT region, SUM(value) AS total FROM deals GROUP BY region'),
    [{ op: 'group', by: ['region'], agg: [{ fn: 'sum', of: 'value', as: 'total' }] }]),
    'GROUP BY → group')
  ok(eq(steps('SELECT region FROM deals ORDER BY value DESC'),
    [{ op: 'sort', by: 'value', dir: 'desc' }]), 'ORDER BY → sort')
  ok(eq(steps('SELECT region FROM deals LIMIT 5 OFFSET 2'),
    [{ op: 'limit', n: 5, offset: 2 }]), 'LIMIT/OFFSET → limit')
  ok(eq(steps('SELECT region FROM deals LIMIT 5'), [{ op: 'limit', n: 5 }]),
    'a limit with no offset does not carry one')
  ok(eq(steps('SELECT value * qty AS revenue FROM deals'),
    [{ op: 'derive', col: 'revenue', name: 'revenue', expr: '[value] * [qty]' }]),
    'a SELECT expression → derive')
  ok(eq(steps('SELECT region FROM deals'), []),
    'a plain projection is NOT a step — narrowing the column list costs nothing')
  ok(eq(steps('SELECT deals.region AS region FROM deals'), []),
    'nor is an alias that says what the column is already called, which is how people disambiguate')
  ok(eq(steps('SELECT region AS area FROM deals'),
    [{ op: 'derive', col: 'area', name: 'area', expr: '[region]' }]),
    'a rename that RENAMES is a derive — the format has no project op, and one column of memory is the honest price')
}
{
  const s = steps('SELECT COUNT(*) AS deals, COUNT(stage) AS stages, COUNT(DISTINCT owner) AS owners, AVG(value) AS mean FROM deals')
  ok(eq(s, [{
    op: 'group',
    by: [],
    agg: [
      { fn: 'count', as: 'deals' },
      { fn: 'counta', of: 'stage', as: 'stages' },
      { fn: 'countdistinct', of: 'owner', as: 'owners' },
      { fn: 'avg', of: 'value', as: 'mean' },
    ],
  }]), 'COUNT(*) counts ROWS; COUNT(x) is COUNTA, because SQL counts non-NULLs and dash COUNT counts numbers')
}
{
  const s = steps('SELECT region, SUM(value * qty) AS rev FROM deals GROUP BY region')
  ok(eq(s, [
    { op: 'derive', col: '_a1', name: '_a1', expr: '[value] * [qty]' },
    { op: 'group', by: ['region'], agg: [{ fn: 'sum', of: '_a1', as: 'rev' }] },
  ]), 'an aggregate over an EXPRESSION derives the column first — a step\'s `of` names a column')
}
{
  const s = steps("SELECT UPPER(region) AS r, SUM(value) AS t FROM deals GROUP BY UPPER(region)")
  ok(eq(s, [
    { op: 'derive', col: '_g1', name: '_g1', expr: 'UPPER([region])' },
    { op: 'group', by: ['_g1'], agg: [{ fn: 'sum', of: 'value', as: 't' }] },
    { op: 'derive', col: 'r', name: 'r', expr: '[_g1]' },
  ]), 'a computed GROUP BY key is derived first — and the SELECT list READS that key rather than recomputing it over a column the group consumed')
}
{
  const s = steps('SELECT region, SUM(value) AS total FROM deals GROUP BY region HAVING SUM(value) > 100')
  ok(eq(s, [
    { op: 'group', by: ['region'], agg: [{ fn: 'sum', of: 'value', as: 'total' }] },
    { op: 'filter', where: '[total] > 100' },
  ]), 'HAVING → a filter AFTER the group, reusing the aggregate the SELECT list already named')
}
{
  const s = steps('SELECT region, value FROM pairs ORDER BY region ASC, value DESC')
  ok(eq(s, [
    { op: 'sort', by: 'value', dir: 'desc' },
    { op: 'sort', by: 'region', dir: 'asc' },
  ]), 'multi-key ORDER BY becomes sorts in REVERSE — steps.ts\'s comparator is a total order, so the last sort is the primary key')
  ok(eq(steps('SELECT region, value FROM pairs ORDER BY 2 DESC'), [{ op: 'sort', by: 'value', dir: 'desc' }]),
    'ORDER BY <ordinal> names a select item')
}

console.log('\n--- joins, and what a SQL JOIN declares')
{
  const s = steps('SELECT deals.region, owners.team FROM deals JOIN owners ON deals.owner = owners.name')
  ok(eq(s, [
    { op: 'join', with: 'owners', on: ['owner', 'name'], card: 'one', fields: ['name', 'team'] },
    { op: 'filter', where: 'NOT(ISBLANK([name]))' },
  ]), 'INNER JOIN = the engine\'s left join PLUS the visible filter that drops unmatched rows')
  const l = steps('SELECT deals.region, owners.team FROM deals LEFT JOIN owners ON deals.owner = owners.name')
  ok(eq(l, [{ op: 'join', with: 'owners', on: ['owner', 'name'], card: 'one', fields: ['name', 'team'] }]),
    'LEFT JOIN is the join alone — unmatched rows stay, blank and counted')
  const m = steps('SELECT deals.region FROM deals LEFT JOIN MANY dupes ON deals.owner = dupes.name')
  ok((m[0] as { card: string }).card === 'many',
    'JOIN MANY is the only way to declare a fan-out — SQL itself says nothing about grain')
  ok((s[0] as { card: string }).card === 'one',
    'and a plain JOIN declares card:"one", so the engine can refuse a key that is not unique')
}
{
  const s = steps('SELECT deals.region, regions.owner FROM deals LEFT JOIN regions ON deals.region = regions.region')
  ok(eq(s[0], { op: 'join', with: 'regions', on: ['region', 'region'], card: 'one', fields: ['region', 'owner'] }),
    'a join whose columns clash on both sides still names its key by id')
  const d = steps("SELECT regions.owner AS boss FROM deals LEFT JOIN regions ON deals.region = regions.region")
    .find((x) => x.op === 'derive') as { expr: string }
  ok(d.expr === '[regions.owner]',
    `a clashing joined column is referenced by the prefixed id steps.ts gives it  →  ${d.expr}`)
}
{
  // The pushdown, and the case where it must NOT happen.
  const base = steps("SELECT deals.region FROM deals JOIN owners ON deals.owner = owners.name WHERE deals.stage <> 'Lost'")
  ok(base[0].op === 'filter' && base[1].op === 'join',
    'a predicate over the base sheet alone is pushed BEFORE the join — same rows, smaller join')
  const joined = steps("SELECT deals.region FROM deals JOIN owners ON deals.owner = owners.name WHERE owners.team = 'Alpha'")
  ok(joined[0].op === 'join' && joined.map((s) => s.op).join(',') === 'join,filter,filter',
    'a predicate over a JOINED column stays after the join, where its column exists')
  const bare = steps("SELECT deals.region FROM deals JOIN owners ON deals.owner = owners.name WHERE team = 'Alpha'")
  ok(bare[0].op === 'join',
    'and that is decided by RESOLVING the reference, not by whether it was written with a qualifier')
}
{
  const s = steps('SELECT deals.region FROM deals LEFT JOIN owners ON deals.owner = owners.name')
  ok(eq((s[0] as { fields: string[] }).fields, ['name']),
    'a join carries only the columns the query names, plus its key')
  const star = steps('SELECT * FROM deals LEFT JOIN owners ON deals.owner = owners.name')
  ok(eq((star[0] as { fields: string[] }).fields, ['name', 'team']), 'SELECT * carries all of them')
}

console.log('\n--- WITH and UNION become named frames')
{
  const c = compileSql(
    "WITH won AS (SELECT region, value FROM deals WHERE stage = 'Won') SELECT region, SUM(value) AS total FROM won GROUP BY region",
    { doc: DOC })
  ok(c.ok && c.frames.length === 2, 'a CTE is its own frame, run first')
  ok(c.frames[0].name === 'won' && c.frames[0].from === 'deals', 'named, and reading the base sheet')
  ok(c.main!.from === 'won', 'and the main query reads the name')
  ok(eq(c.frames[0].select, ['region', 'value']), 'the CTE projects what its SELECT list said')
}
{
  const c = compileSql('SELECT region, value FROM deals UNION ALL SELECT region, value FROM archive', { doc: DOC })
  const u = c.main!.steps.find((s) => s.op === 'union') as { with: string; all: boolean }
  ok(c.ok && c.frames.length === 2, 'each UNION arm is a frame')
  ok(u.all === true, 'UNION ALL keeps duplicates')
  const d = compileSql('SELECT region, value FROM deals UNION SELECT region, value FROM archive', { doc: DOC })
  ok((d.main!.steps.find((s) => s.op === 'union') as { all: boolean }).all === false,
    'a bare UNION dedupes — steps.ts reads `all:false` as "not union all"')
  ok(u.with === c.frames[0].name, 'the union names the arm frame it stacks on')
}

console.log('\n--- the showcase query from docs/dash-sql.md, step for step')
{
  const sql = `
    SELECT   region, SUM(value) AS pipeline, COUNT(*) AS deals
    FROM     deals
    JOIN     owners ON deals.owner = owners.name
    WHERE    stage <> 'Lost'
    GROUP BY region
    HAVING   SUM(value) > 100
    ORDER BY pipeline DESC
    LIMIT    20
  `
  const c = compileSql(sql, { doc: DOC })
  ok(c.ok, 'it compiles')
  ok(eq(c.main!.steps, [
    { op: 'filter', where: '[stage] <> "Lost"' },
    { op: 'join', with: 'owners', on: ['owner', 'name'], card: 'one', fields: ['name'] },
    { op: 'filter', where: 'NOT(ISBLANK([name]))' },
    { op: 'group', by: ['region'], agg: [{ fn: 'sum', of: 'value', as: 'pipeline' }, { fn: 'count', as: 'deals' }] },
    { op: 'filter', where: '[pipeline] > 100' },
    { op: 'sort', by: 'pipeline', dir: 'desc' },
    { op: 'limit', n: 20 },
  ]), `filter → join → group → filter(having) → sort → limit, exactly\n        ${JSON.stringify(c.main!.steps)}`)
  ok(eq(c.main!.select, ['region', 'pipeline', 'deals']), 'and the projection is the SELECT list')
  const known = new Set(['import', 'bind', 'type', 'filter', 'derive', 'sort', 'group', 'join', 'union', 'pivot', 'unpivot', 'limit', 'patch'])
  ok(c.main!.steps.every((s) => known.has(s.op)),
    'every op it emits is one the format already declares — the SQL surface invents no ops')
}

// ============================================================ 3. the refusals

console.log('\n--- out of scope, and saying so')
const REFUSALS: Array<[string, string]> = [
  ["INSERT INTO deals (region) VALUES ('North')", 'sql-not-a-question'],
  ["UPDATE deals SET region = 'North'", 'sql-not-a-question'],
  ['DELETE FROM deals', 'sql-not-a-question'],
  ['CREATE TABLE t (a int)', 'sql-not-a-question'],
  ['BEGIN', 'sql-not-a-question'],
  ['DROP TABLE deals', 'sql-not-a-question'],
  ['SELECT SUM(value) OVER (PARTITION BY region) AS t FROM deals', 'sql-window-unsupported'],
  ['SELECT region FROM deals WHERE value > (SELECT AVG(value) FROM deals)', 'sql-subquery-unsupported'],
  ['SELECT region FROM deals WHERE owner IN (SELECT name FROM owners)', 'sql-subquery-unsupported'],
  ['SELECT region FROM deals WHERE EXISTS (SELECT 1 FROM owners)', 'sql-subquery-unsupported'],
  ['SELECT region FROM (SELECT region FROM deals)', 'sql-derived-table-unsupported'],
  ['SELECT deals.region FROM deals RIGHT JOIN owners ON deals.owner = owners.name', 'sql-join-unsupported'],
  ['SELECT deals.region FROM deals FULL JOIN owners ON deals.owner = owners.name', 'sql-join-unsupported'],
  ['SELECT deals.region FROM deals CROSS JOIN owners ON deals.owner = owners.name', 'sql-join-unsupported'],
  ['SELECT region FROM deals, owners', 'sql-cross-join'],
  ['SELECT DISTINCT region FROM deals', 'sql-distinct-unsupported'],
  ['SELECT region FROM deals INTERSECT SELECT region FROM archive', 'sql-setop-unsupported'],
  ['SELECT region FROM deals EXCEPT SELECT region FROM archive', 'sql-setop-unsupported'],
  ['WITH RECURSIVE t AS (SELECT region FROM deals) SELECT region FROM t', 'sql-recursive-cte'],
  ['WITH a AS (WITH b AS (SELECT region FROM deals) SELECT region FROM b) SELECT region FROM a', 'sql-nested-with'],
  ['SELECT region FROM deals; SELECT region FROM archive', 'sql-one-statement'],
  ['SELECT revenu FROM deals', 'sql-unknown-column'],
  ['SELECT region FROM nowhere', 'sql-unknown-table'],
  ['SELECT SQUONK(value) AS t FROM deals', 'sql-unknown-function'],
  ['SELECT region FROM deals WHERE SUM(value) > 10', 'sql-aggregate-in-where'],
  ["SELECT owner FROM deals JOIN people ON deals.owner = people.pkey WHERE owner = 'x'", 'sql-ambiguous-column'],
  ['SELECT deals.region FROM deals JOIN owners ON deals.owner > owners.name', 'sql-join-condition'],
  ['SELECT deals.region FROM deals JOIN owners ON deals.owner = deals.stage', 'sql-join-condition'],
  ['SELECT region FROM deals WHERE region = NULL', 'sql-null-comparison'],
  ['SELECT region FROM deals LIMIT 10, 5', 'sql-limit-comma'],
  ['SELECT region FROM deals OFFSET 5', 'sql-offset-without-limit'],
  ['SELECT region FROM deals ORDER BY region NULLS FIRST', 'sql-nulls-ordering'],
  ['SELECT * FROM deals GROUP BY region', 'sql-star-grouped'],
  ['SELECT region FROM deals ORDER BY 9', 'sql-order-ordinal'],
  ["SELECT region FROM deals WHERE region LIKE 'N_rth'", 'sql-like-underscore'],
  ["SELECT region FROM deals WHERE region LIKE 'N%h%'", 'sql-like-pattern'],
  ['SELECT region FROM deals WHERE region = \'say "hi"\'', 'sql-unquotable-text'],
  ['SELECT region WHERE value > 1', 'sql-parse'],
  ["SELECT region FROM deals WHERE region = 'unterminated", 'sql-unterminated-string'],
  ['SELECT region, value FROM deals UNION ALL SELECT region, unit_price FROM q3', 'sql-union-names'],
  ['SELECT region, value FROM deals UNION ALL SELECT region FROM archive', 'sql-union-width'],
  ['SELECT MAX(*) AS t FROM deals', 'sql-star-aggregate'],
  ['SELECT region FROM deals HAVING value > 1', 'sql-having-without-group'],
  ['SELECT region FROM deals HAVING SUM(value) > 1', 'sql-not-grouped'],
  ['SELECT region, SUM(value) AS t FROM deals GROUP BY owner', 'sql-not-grouped'],
]
for (const [sql, want] of REFUSALS) {
  const c = refuse(sql)
  const got = code(c)
  ok(!c.ok && got === want, `${want.padEnd(30)} ${sql.trim().slice(0, 62)}${got === want ? '' : `   [got ${got}]`}`)
}
{
  const c = refuse('SELECT revenu FROM deals')
  ok(c.issues[0].message.includes('region') && c.issues[0].message.includes('value'),
    'an unknown column names the columns that DO exist — dash holds the schema, so the error can answer the real question')
  ok(typeof c.issues[0].pos === 'number' && c.issues[0].pos === 7,
    `a finding carries the character position (${c.issues[0].pos})`)
  const p = refuse('SELECT region WHERE value > 1')
  ok(p.issues[0].message.includes('position') && p.issues[0].message.includes('expected'),
    `a parse error says where and what was expected  →  ${p.issues[0].message}`)
  ok(c.issues[0].severity === 'fatal' && typeof c.issues[0].code === 'string',
    'and every finding is {code, severity, message}, the shape showFindings already renders')
  const dml = refuse('DELETE FROM deals')
  ok(dml.issues[0].message.includes('patch'),
    'the DML refusal says what to do instead: an edit is a patch, a query is a question')
}
{
  const c = compileSql('SELECT deals.region FROM deals JOIN owners ON deals.owner = owners.name')
  ok(!c.ok && code(c) === 'sql-no-schema',
    'a join compiled without the workbook refuses rather than guessing which columns to carry')
  const bare = compileSql("SELECT region FROM deals WHERE stage <> 'Lost'")
  ok(bare.ok && (bare.main!.steps[0] as { where: string }).where === '[stage] <> "Lost"',
    'a query with no join still compiles with no schema, for tooling that has only the text')
}

// ============================================================ 4. end to end

console.log('\n--- compiled AND run: the numbers')
const run = (sql: string): SqlResult => runSql(sql, { doc: DOC })
{
  const r = run("SELECT region, SUM(value) AS total, COUNT(*) AS deals FROM deals WHERE stage <> 'Lost' GROUP BY region ORDER BY total DESC")
  const got = rows(r)
  ok(r.ok, `it runs${r.ok ? '' : `: ${r.issues.map((i) => i.message).join(' | ')}`}`)
  ok(eq(got, [
    { region: 'South', total: 400, deals: 1 },
    { region: 'North', total: 300, deals: 2 },
    { region: null, total: 25, deals: 1 },
    { region: 'East', total: 10, deals: 1 },
  ]), `filter → group → sort gives the totals, with "North"/"north" one group\n        ${JSON.stringify(got)}`)
}
{
  const r = run("SELECT owners.team AS team, SUM(deals.value) AS total FROM deals JOIN owners ON deals.owner = owners.name GROUP BY owners.team ORDER BY total DESC")
  ok(r.ok && eq(rows(r), [{ team: 'Alpha', total: 625 }, { team: 'Beta', total: 225 }]),
    `an INNER JOIN drops the owner who is in no dimension row (zz, 10) — 625 and 225, not 635\n        ${JSON.stringify(rows(r))}`)
}
{
  const r = run('SELECT deals.owner AS owner, owners.team AS team FROM deals LEFT JOIN owners ON deals.owner = owners.name')
  const got = rows(r)
  ok(r.ok && got.length === 7 && got[6].owner === 'zz' && got[6].team === null,
    'a LEFT JOIN keeps the unmatched row, blank — dropping it is the other way to make a total quietly wrong')
  ok(codes(r).includes('join-unmatched'),
    'and the engine SAYS one row found no match; a key that misses is data telling you something')
}
{
  const r = run('SELECT COUNT(stage) AS n, COUNT(value) AS m FROM deals')
  ok(r.ok && eq(rows(r), [{ n: 7, m: 7 }]),
    `COUNT over a TEXT column counts the 7 non-blank rows — dash's own \`count\` counts numbers and would say 0\n        ${JSON.stringify(rows(r))}`)
}
{
  const r = run("WITH won AS (SELECT region, value FROM deals WHERE stage = 'Won') SELECT region, SUM(value) AS total FROM won GROUP BY region ORDER BY total DESC")
  ok(r.ok && eq(rows(r), [
    { region: 'South', total: 400 }, { region: 'North', total: 300 },
    { region: null, total: 25 }, { region: 'East', total: 10 },
  ]), `a CTE is materialised and read by name  →  ${JSON.stringify(rows(r))}`)
  ok(r.made.has('won') && r.made.get('won')!.kind === 'table',
    'and the intermediate is a real table sheet, which is why the result can become a tab')
}
{
  // A CTE joined to: the right side of the join is resolved through the frames
  // this compile built, not through the workbook — steps.ts's `sheets` hook.
  const r = run("WITH big AS (SELECT name, team FROM owners WHERE team = 'Alpha') SELECT deals.owner AS owner, big.team AS team FROM deals JOIN big ON deals.owner = big.name ORDER BY owner")
  ok(r.ok && eq(rows(r), [
    { owner: 'ana', team: 'Alpha' }, { owner: 'ana', team: 'Alpha' },
    { owner: 'cy', team: 'Alpha' }, { owner: 'cy', team: 'Alpha' },
  ]), `a JOIN whose right side is a CTE resolves through the frames this compile built  →  ${JSON.stringify(rows(r))}`)
}
{
  const r = run('SELECT region, value FROM archive UNION ALL SELECT region, value FROM archive')
  ok(r.ok && r.frame!.n === 4, 'UNION ALL stacks both arms')
  const d = run('SELECT region, value FROM archive UNION SELECT region, value FROM archive')
  ok(d.ok && d.frame!.n === 2 && codes(d).includes('union-deduped'),
    'a bare UNION dedupes, and says how many it removed')
}
{
  const r = run('SELECT region, value FROM pairs ORDER BY region ASC, value DESC')
  ok(r.ok && eq(rows(r).map((x) => `${x.region}${x.value}`), ['A9', 'A1', 'B5', 'B2']),
    `two sort steps in reverse give SQL's multi-key order  →  ${JSON.stringify(rows(r).map((x) => `${x.region}${x.value}`))}`)
}
{
  const r = run('SELECT region, SUM(value) AS total FROM deals GROUP BY region HAVING SUM(value) > 100')
  ok(r.ok && eq(rows(r), [{ region: 'North', total: 375 }, { region: 'South', total: 450 }]),
    `HAVING filters GROUPS, after the group step  →  ${JSON.stringify(rows(r))}`)
}
{
  const r = run('SELECT region, value FROM deals ORDER BY value DESC LIMIT 2 OFFSET 1')
  ok(r.ok && eq(rows(r).map((x) => x.value), [200, 100]), 'ORDER BY + LIMIT + OFFSET is a window of the sorted frame')
}
{
  const r = run('SELECT region, value * qty AS revenue FROM deals WHERE region IS NOT NULL ORDER BY revenue DESC LIMIT 1')
  ok(r.ok && eq(rows(r), [{ region: 'South', revenue: 1600 }]),
    'a derived expression, a translated IS NOT NULL and a top-1 in one pipeline')
}
{
  const r = run("SELECT region, value FROM deals WHERE owner IN ('ana','cy') AND value BETWEEN 60 AND 500")
  ok(r.ok && eq(rows(r).map((x) => x.value), [100, 400, 75]),
    `IN and BETWEEN evaluate to the rows they name  →  ${JSON.stringify(rows(r).map((x) => x.value))}`)
}
{
  const r = run("SELECT region, CASE WHEN value >= 100 THEN 'big' ELSE 'small' END AS size FROM deals LIMIT 3")
  ok(r.ok && eq(rows(r).map((x) => x.size), ['big', 'big', 'small']), 'CASE evaluates through IFS')
}
{
  const r = run("SELECT region FROM deals WHERE region LIKE '%th' LIMIT 9")
  ok(r.ok && r.frame!.n === 5,
    `LIKE '%th' matches North, north, South, South and North — five rows, case-insensitively  →  ${r.frame!.n}`)
}

console.log('\n--- the refusal a SQL join inherits')
{
  const r = run('SELECT deals.region AS region, dupes.team AS team FROM deals LEFT JOIN dupes ON deals.owner = dupes.name')
  ok(!r.ok && codes(r).includes('join-fanout'),
    'a plain JOIN declares card:"one", so a key that is not unique STOPS the pipeline')
  ok(r.issues.some((i) => i.severity === 'fatal' && i.message.includes('duplicate row')),
    'and the finding says how many rows it would have added, not merely that something is odd')
  const m = run('SELECT deals.region AS region, dupes.team AS team FROM deals LEFT JOIN MANY dupes ON deals.owner = dupes.name')
  ok(m.ok && m.frame!.n === 9 && codes(m).includes('join-fanned'),
    `JOIN MANY runs the same join and reports the fan-out as declared: 7 rows became ${m.frame?.n}`)
}
{
  // The refusal must not be routed around by a query that only reads one column.
  const r = run('SELECT SUM(deals.value) AS total FROM deals JOIN dupes ON deals.owner = dupes.name')
  ok(!r.ok && codes(r).includes('join-fanout'),
    'including when the query never selects a column from the fanning sheet — which is exactly when the doubled total is invisible')
}

console.log('\n--- one expression language, checked rather than asserted')
{
  const alias = stepInternals.AGG_ALIAS as Record<string, string>
  const missing = Object.values(sqlInternals.AGG_FN as Record<string, string>)
    .concat(['count', 'countdistinct'])
    .filter((fn) => {
      const name = alias[fn] ?? fn.toUpperCase()
      return !FUNCTIONS.includes(name)
    })
  ok(missing.length === 0,
    `every aggregate this compiler can emit resolves through steps.ts's alias table into formula.ts (${missing.join(', ') || 'none missing'})`)
}
{
  // The whole point of compiling to steps: the answer is a FRAME over the same
  // column store, not a copy. A projection must not move a single cell.
  stepInternals.resetStats()
  const r = run("SELECT region, value FROM deals WHERE stage <> 'Lost'")
  const s = stepInternals.stats as Record<string, number>
  ok(r.ok && s.retainedCells === 0,
    `a filtered, projected query retains no cells at all (${s.retainedCells}) — the projection is a column list, not a copy`)
  const f = project(r.frame!, ['value'])
  ok(f.columns.length === 1 && f.n === r.frame!.n && f.src === r.frame!.src,
    'project() narrows the column list and keeps the same source and rows')
}
{
  // Errors are visible, never zero: a query over a column that cannot be read
  // must fail loudly rather than total nothing.
  const r = run("SELECT SUM(value) AS total FROM deals WHERE stage = 'Nothing'")
  ok(r.ok && r.frame!.n === 0 && r.issues.every((i) => i.severity !== 'fatal'),
    `a grand total over NO rows is NO rows here, where SQL would return one row of NULL — a documented divergence, and the honest one: this format has no NULL row to return  →  ${JSON.stringify(rows(r))}`)
  const bad = runSteps(DEALS, [{ op: 'filter', where: '[stagg] = "Won"' } as Step], { doc: DOC })
  ok(!bad.ok && bad.issues[0].code === 'filter-unresolved',
    'while a misspelt column is fatal in the engine — which is why the compiler checks names BEFORE emitting a step')
}
{
  const r = run('SELECT region, value FROM deals')
  const cols = r.frame!.columns.map((c) => c.id)
  ok(eq(cols, ['region', 'value']), 'the answer carries exactly the SELECT list, in order')
  ok(!r.frame!.columns.some((c) => c.id === 'qty') && values(r.frame!, 'value') !== undefined,
    'an unprojected column is not in the column list, while a projected one still reads through the same source')
  ok(sqlRows(r.frame!, 2).length === 2, 'sqlRows caps what it hands a scripting caller')
}
{
  const c = compileSql("SELECT region FROM deals WHERE stage <> 'Lost'", { tables: tablesOf(DOC) })
  ok(c.ok, 'tablesOf(doc) is the catalogue, so a caller with only a schema can compile')
}

{
  // "The query is saved in the workbook as data" — so it has to BE data.
  const s = steps("SELECT region, SUM(value) AS t FROM deals WHERE stage <> 'Lost' GROUP BY region ORDER BY t DESC LIMIT 3")
  ok(eq(JSON.parse(JSON.stringify(s)), s),
    'the compiled steps are plain JSON — which is what makes the query survive save → email → open, and lets an agent read and rewrite it')
}
{
  const r = run('SELECT * FROM deals LEFT JOIN owners ON deals.owner = owners.name LIMIT 1')
  ok(r.ok && eq(r.frame!.columns.map((c) => c.id), ['region', 'owner', 'stage', 'value', 'qty', 'name', 'team']),
    `SELECT * over a join projects both sides, in order  →  ${JSON.stringify(r.frame!.columns.map((c) => c.id))}`)
}
{
  const c = refuse('SELECT region, SUM(value) AS t FROM deals GROUP BY owner')
  ok(c.issues[0].message.includes('GROUP BY') && c.issues[0].message.includes('aggregate'),
    'a column that is neither grouped nor aggregated is named, with both ways out')
  const a = refuse("SELECT owner FROM deals JOIN people ON deals.owner = people.pkey WHERE owner = 'x'")
  ok(a.issues[0].message.includes('deals') && a.issues[0].message.includes('people'),
    'an ambiguous column names BOTH sheets that could have meant it')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
