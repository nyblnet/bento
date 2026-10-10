# Database mode — SQL over a workbook

Proposal, 2026-08-10. Not built. This exists so the decision is made once and on
the record, because the obvious answer (embed SQLite) is the wrong one for a
reason that is easy to miss.

## The question

"An easy way to do SQL queries on tabular data, like using SQLite."

## Why not SQLite, and why that is not a budget argument

The concepting already weighed the engines and rejected them on measurement.
Worth restating the numbers, because one of them is disqualifying rather than
merely expensive:

| | in-shell cost | fatal problem |
|---|---|---|
| DuckDB-WASM | ~9,400 KB — **17.7× the whole shell** | **Cannot load from `file://` at all** |
| SQL.js | 442 KB — larger than the entire app today (277 KB) | a **row** store; the kernel is columnar |

The DuckDB line is the one that settles it. A Bento document is a file someone
double-clicks. Measured during concepting: from `file://`, module workers from
blob URLs fail, `importScripts` of a blob fails, a worker cannot fetch its
parent's blob URL, and `SharedArrayBuffer` is absent because COOP/COEP headers
cannot exist on a file. So the engine would be absent in precisely the case the
product is built around — a workbook on a laptop, opened without a server. A
feature that works only when the file is served is not a feature of this file
format.

SQL.js *can* load. But it is a row store, so using it means copying every column
into a second representation at boot, holding the data twice, and losing the
layout the kernel's speed comes from. It also means two sources of truth: the
sheet and the database, drifting the moment anyone edits a cell.

**What was rejected was the ENGINE. Nothing rejected the LANGUAGE.** That
distinction is the whole proposal.

## What is already here

The workbook format models a complete relational pipeline. `Step` in `model.ts`:

```
import | bind | type | filter | derive | sort | group | join | union
      | pivot | unpivot | limit | patch
```

That is SQL's shape, already in the file format, already collaborative, already
undoable. And the kernel underneath is fast — measured during concepting, single
threaded, from `file://`, on **10,000,000 rows**: full scan sum 5.9 ms, filter +
sum 10.6 ms, two-dimension group-by with sum and count 11.5 ms, top-100 8.9 ms.
An FK join into a 5,000-row dimension plus a group-by over 100k fact rows: 0.89
ms.

There is one gap, and it is honest to state it plainly: **nothing executes those
steps.** `applySteps` in `store.ts` throws `"patch op applySteps is not
implemented yet"`, and no code handles `group`, `join` or `derive`. Today's
filtering and sorting are grid VIEW state and never touch the step pipeline.

So the work is not "add SQL". It is:

1. **Implement the step engine** — the thing the format has always described.
2. **Put a SQL surface on it** — parse to `Step[]`, hand it to the engine.

Step 1 is owed regardless of whether SQL ever ships. Step 2 is then small.

## The proposal

**SQL compiles to `Step[]`. The query is saved in the workbook as data, and the
result is a real sheet.**

```sql
SELECT   region, SUM(value) AS pipeline, COUNT(*) AS deals
FROM     Pipeline
JOIN     Owners ON Pipeline.owner = Owners.name
WHERE    stage <> 'Lost' AND closed >= '2026-01-01'
GROUP BY region
HAVING   SUM(value) > 10000
ORDER BY pipeline DESC
LIMIT    20
```

→ `filter → join → group → filter(having) → sort → limit`, run on the columnar
kernel, materialised as a sheet with a tab like any other.

### What this buys that an embedded database cannot

- **The result is live.** Edit a source cell and the query re-runs — it is a
  pipeline, not a snapshot. An embedded SQLite result is a dead copy the moment
  anyone types.
- **One copy of the truth.** No import step, no second representation, no drift.
- **It survives the round trip.** Steps are plain JSON in the document, so the
  query is still there after save → email → open on another machine, and an
  agent editing the file can read and rewrite it.
- **It is undoable and collaborative** for free: steps are patches, and patches
  already sync and invert.
- **Lineage.** Because the pipeline is declared rather than opaque, a number in
  a result can be traced back through the steps that produced it — which is the
  thing spreadsheets are worst at and the reason people distrust them.

### Scope — first cut

`SELECT` (columns, expressions, aliases) · `FROM` one sheet · `JOIN … ON`
(inner, left) · `WHERE` · `GROUP BY` with `SUM/COUNT/AVG/MIN/MAX/COUNT DISTINCT`
· `HAVING` · `ORDER BY` · `LIMIT/OFFSET` · `WITH` (CTEs as named intermediate
sheets) · `UNION [ALL]`.

Expressions reuse `formula.ts` — the 91 functions already there — so `SUM`,
`ROUND`, `IF` and the rest mean the same thing in a query as in a cell. One
expression language, not two.

**Deliberately out of the first cut**, and it should say so rather than fail
oddly: window functions, correlated subqueries, `INSERT`/`UPDATE`/`DELETE`
(edits are patches; a query is a question), and anything transactional.

### Refusals, in the house style

The design's own list of hazards includes `join-fanout` — a join whose declared
cardinality the data contradicts, which silently duplicates measures. dash can
detect it because it holds the declaration. A query that would fan out should
say so before it prints a total that is quietly double.

## Estimate

| | |
|---|---|
| Step engine (filter/derive/sort/group/join/union/limit over the columnar store) | the larger half; owed anyway |
| SQL parser → `Step[]` | small — a Pratt parser over the existing tokeniser |
| Query editor, result-as-sheet, re-run on change, error reporting | moderate |
| Rigs: parser, each step, join-fanout detection, 10M-row performance floors | non-trivial and non-optional |

Additional shell cost: **tens of KB, not hundreds** — the kernel is 15–25 KB and
the parser is small, against 442 KB for the smallest engine that can even load.

## The alternative worth naming

If what is actually wanted is "run real SQLite against my data", the honest
shape is not in-shell at all: export to `.sqlite`, or a companion that serves a
workbook to DuckDB. That keeps full SQL semantics and costs the self-contained
file nothing. It is a different product decision, and it is not what the tabs,
the pivot and the step pipeline have been building toward.
