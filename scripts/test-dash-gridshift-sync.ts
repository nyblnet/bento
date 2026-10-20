#!/usr/bin/env node
// A grid row insert reaches another replica.
//
//   node scripts/test-dash-gridshift-sync.ts
//
// `shiftCanvas` used to fall through the engine's default arm to a whole-state
// snapshot — described as "slower and always correct". MEASURED here, it was
// neither for a cell move: the snapshot carried the rewritten formulas but not
// the moved cells, and a concurrent edit left the replicas DIVERGED for good.
// The engine now expresses the shift as the position writes it amounts to
// (crdt.ts, case 'shiftCanvas'). Two sessions, frames carried by hand so
// nothing depends on timing; revert that case and the first and third blocks
// fail.

;(globalThis as { window?: unknown }).window = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: number) => clearTimeout(h),
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: (h: number) => clearInterval(h),
  addEventListener: () => {},
}
;(globalThis as { document?: unknown }).document = { hidden: false, addEventListener() {} }

import { registerHooks } from 'node:module'
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

const { parseDoc } = await import('../dash/src/model.ts')
const { Store } = await import('../dash/src/store.ts')
const { SyncSession } = await import('../dash/src/sync/session.ts')
const { planShift } = await import('../dash/src/gridshift.ts')
type DashDoc = import('../dash/src/model.ts').DashDoc
type Rec = Record<string, unknown>

let checks = 0, failures = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms))
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

function book(): DashDoc {
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: `d-${Math.random()}`, title: 'Book',
    sheets: [
      { id: 'g', name: 'Grid', kind: 'canvas', cells: { A1: { v: 1 }, A2: { v: 2 }, A3: { v: 3 }, A5: { f: '=SUM(A1:A3)' } } },
      { id: 't', name: 'T', kind: 'table', rids: [[1, 1]], nextRid: 2, steps: [], placed: { on: 'g', r: 7, c: 2 },
        columns: [{ id: 'x', name: 'X', type: 'number' }], data: { x: { enc: 'raw', v: [7] } } },
    ],
  }))
  if (!r.ok) throw new Error('fixture')
  return r.doc
}

type S = { onFrame: (f: unknown) => void; addTransport: (mk: (id: string, on: (f: unknown) => void) => unknown) => unknown; stop?: () => void }
const thrown: string[] = []
process.on('uncaughtException', (e) => thrown.push(String((e as Error)?.message ?? e)))

/** Two replicas whose frames are captured and delivered by `pump`. */
async function pair() {
  const base = book()
  const A = new Store(clone(base)), B = new Store(clone(base))
  const sA = new SyncSession(A) as unknown as S, sB = new SyncSession(B) as unknown as S
  const outA: Rec[] = [], outB: Rec[] = []
  sA.addTransport(() => ({ send: (f: Rec) => outA.push(f), close() {} }))
  sB.addTransport(() => ({ send: (f: Rec) => outB.push(f), close() {} }))
  await settle(40)
  const pump = async () => {
    for (let i = 0; i < 4; i++) {
      for (const f of outA.splice(0)) { try { sB.onFrame(f) } catch (e) { thrown.push(String(e)) } }
      for (const f of outB.splice(0)) { try { sA.onFrame(f) } catch (e) { thrown.push(String(e)) } }
      await settle()
    }
  }
  return { A, B, sA, sB, pump, outA }
}
const cells = (d: DashDoc) => JSON.stringify(Object.entries((d.sheets[0] as { cells: Rec }).cells).sort())
const placed = (d: DashDoc) => JSON.stringify((d.sheets.find((s) => s.id === 't') as Rec).placed)

console.log('\nA inserts a row; B sees the cells, the formula and the table move')
{
  const { A, B, sA, sB, pump, outA } = await pair()
  const plan = planShift(A.doc, 'g', 'row', 1, 1)
  A.commit(plan.ok ? plan.patches : [])
  await settle()
  ok(outA.some((f) => f.t === 'ops') && !outA.some((f) => f.t === 'snap'), 'the shift ships as ops — the snapshot fallback is not needed')
  await pump()
  ok(cells(B.doc) === cells(A.doc), `B's grid matches A's (B: ${cells(B.doc)})`)
  ok((B.doc.sheets[0] as { cells: Rec }).cells.A6 !== undefined, 'the total landed on its moved row on B')
  ok(placed(B.doc) === placed(A.doc) && placed(B.doc) === '{"on":"g","r":8,"c":2}', 'the table moved on B too')
  sA.stop?.(); sB.stop?.()
}

console.log('\nCONTROL: an ordinary cell edit goes as ops, not a snapshot')
{
  const { A, B, sA, sB, pump, outA } = await pair()
  A.commit({ op: 'setCanvasCells', sheet: 'g', cells: { B1: { v: 'hello' } } } as never)
  await settle()
  ok(!outA.some((f) => f.t === 'snap') && outA.some((f) => f.t === 'ops'), 'a plain write ships ops too')
  await pump()
  ok((B.doc.sheets[0] as { cells: Rec }).cells.B1 !== undefined, 'and B has it')
  sA.stop?.(); sB.stop?.()
}

console.log('\nconcurrent: A inserts a row while B edits a cell — both converge')
{
  const { A, B, sA, sB, pump } = await pair()
  const plan = planShift(A.doc, 'g', 'row', 1, 1)
  A.commit(plan.ok ? plan.patches : [])
  B.commit({ op: 'setCanvasCells', sheet: 'g', cells: { D1: { v: 'from B' } } } as never)
  await pump()
  ok(cells(A.doc) === cells(B.doc), `the two replicas hold the same grid (A: ${cells(A.doc)} | B: ${cells(B.doc)})`)
  sA.stop?.(); sB.stop?.()
}

ok(thrown.length === 0, `nothing threw (${thrown.slice(0, 3).join(' | ') || 'none'})`)
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
