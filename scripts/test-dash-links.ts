#!/usr/bin/env node
// Linked records, lookups and rollups — the Airtable layer's relational half.
//
//   node scripts/test-dash-links.ts
//
// docs/dash-unified.md. Orders link to Clients; Clients carry the derived
// mirror; lookups and rollups read across. Edits are applied with the store's
// own `applyPatch`, so "both sides agree" is checked from storage, not from
// the patch list.

import { applyPatch } from '../dash/src/store.ts'
import { parseDoc } from '../dash/src/model.ts'
import { derivedVectors, linkRids, ridsIn, setLinkPatches, fold } from '../dash/src/links.ts'
import { formatValue } from '../dash/src/format.ts'
import type { DashDoc, TableSheet } from '../dash/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const J = JSON.stringify

function workbook(): DashDoc {
  return {
    format: 'bento/dash', version: 1, docId: 'd', title: 't',
    sheets: [
      {
        id: 'clients', name: 'Clients', kind: 'table', rids: [[1, 3]], nextRid: 4, steps: [],
        columns: [
          { id: 'name', name: 'Name', type: 'text' },
          { id: 'email', name: 'Email', type: 'text', kind: 'email' },
          { id: 'orders', name: 'Orders', type: 'text', kind: 'link', inverseOf: { table: 'orders', col: 'client' } },
          { id: 'spent', name: 'Spent', type: 'number', kind: 'rollup', via: 'orders', field: 'amount', agg: 'sum' },
          { id: 'n', name: 'Order count', type: 'number', kind: 'rollup', via: 'orders', field: 'item', agg: 'counta' },
          { id: 'items', name: 'Items', type: 'text', kind: 'lookup', via: 'orders', field: 'item' },
          { id: 'big', name: 'Doubled spend', type: 'number', kind: 'rollup', via: 'orders', field: 'double', agg: 'sum' },
        ],
        data: {
          name: { enc: 'raw', v: ['Ada', 'Bo', 'Cy'] },
          email: { enc: 'raw', v: ['ada@x.io', 'bo@x.io', 'cy@x.io'] },
        },
      },
      {
        id: 'orders', name: 'Orders', kind: 'table', rids: [[10, 4]], nextRid: 14, steps: [],
        columns: [
          { id: 'item', name: 'Item', type: 'text' },
          { id: 'amount', name: 'Amount', type: 'money' },
          { id: 'client', name: 'Client', type: 'text', kind: 'link', to: 'clients' },
          { id: 'mail', name: 'Client email', type: 'text', kind: 'lookup', via: 'client', field: 'email' },
          { id: 'double', name: 'Double', type: 'number', formula: 'Amount * 2' },
        ],
        data: {
          item: { enc: 'raw', v: ['Tea', 'Cake', 'Jam', 'Pie'] },
          amount: { enc: 'raw', v: [3, 5, 7, 11] },
          // Tea→Ada, Cake→Ada+Bo, Jam→Bo, Pie→nobody
          client: { enc: 'raw', v: [[1], [1, 2], [2], null] },
          double: { enc: 'raw', v: [null, null, null, null] },
        },
      },
    ],
  } as unknown as DashDoc
}
const sheet = (d: DashDoc, id: string) => d.sheets.find((s) => s.id === id) as TableSheet
const col = (t: TableSheet, id: string) => t.columns.find((c) => c.id === id)!
const vec = (d: DashDoc, t: string, c: string) => derivedVectors(d, sheet(d, t)).vectors.get(c)

console.log('\nstored link cells')
ok(J(ridsIn([2, 2, '3', 0, -1, 'x'])) === '[2,3]', 'rids are de-duplicated; junk, zero and negatives are dropped')
ok(J(ridsIn(5)) === '[5]' && J(ridsIn(null)) === '[]', 'a lone rid and an empty cell both read as lists')

console.log('\nthe owner side reads storage; the mirror is DERIVED')
{
  const d = workbook()
  ok(J(linkRids(d, sheet(d, 'orders'), col(sheet(d, 'orders'), 'client'))) === '[[1],[1,2],[2],[]]', 'Orders.Client is what is stored')
  ok(J(linkRids(d, sheet(d, 'clients'), col(sheet(d, 'clients'), 'orders'))) === '[[10,11],[11,12],[]]',
    'Clients.Orders lists the orders pointing at each client, in order-row order — Cy has none')
  ok(!('orders' in (sheet(d, 'clients').data as object)), 'and the mirror has no stored data at all')
  ok(J(vec(d, 'orders', 'client')) === '["Ada","Ada, Bo","Bo",null]', 'a link displays as the linked rows\' names')
  ok(J(vec(d, 'clients', 'orders')) === '["Tea, Cake","Cake, Jam",null]', 'so does its mirror')
}

console.log('\nlookups and rollups read across the link')
{
  const d = workbook()
  ok(J(vec(d, 'orders', 'mail')) === '["ada@x.io","ada@x.io, bo@x.io","bo@x.io",null]', 'lookup: each order\'s client email(s)')
  ok(J(vec(d, 'clients', 'spent')) === '[8,12,0]', 'rollup sum through the MIRROR: Ada 3+5, Bo 5+7, Cy nothing → 0')
  ok(J(vec(d, 'clients', 'n')) === '[2,2,0]', 'rollup counta counts linked non-empty values')
  ok(J(vec(d, 'clients', 'items')) === '["Tea, Cake","Cake, Jam",null]', 'lookup through the mirror')
  ok(J(vec(d, 'clients', 'big')) === '[16,24,0]', 'a rollup over a CALCULATED column folds its computed values (Amount × 2)')
  ok(formatValue(vec(d, 'clients', 'spent')![0], { type: 'number', kind: 'rollup' }) === '8', 'a rollup formats as its number')
}

console.log('\nfold matches Airtable\'s aggregates')
for (const [agg, want] of [['sum', 6], ['avg', 2], ['min', 1], ['max', 3], ['count', 3], ['counta', 4], ['concat', '1, 2, 3, x'], ['and', true], ['or', true]] as const) {
  ok(J(fold(agg, [1, 2, 3, 'x', null])) === J(want), `${agg} over [1,2,3,"x",null] = ${J(want)}`)
}

console.log('\nwhat cannot be computed is reported, not guessed')
{
  const d = workbook()
  const c = sheet(d, 'clients')
  c.columns.push({ id: 'bad1', name: 'B1', type: 'text', kind: 'lookup', via: 'email', field: 'item' })
  c.columns.push({ id: 'bad2', name: 'B2', type: 'number', kind: 'rollup', via: 'orders', field: 'nope', agg: 'sum' })
  sheet(d, 'orders').columns.push({ id: 'bad3', name: 'B3', type: 'text', kind: 'link', to: 'gone' })
  const p1 = derivedVectors(d, c).problems.map((p) => `${p.col}:${p.code}`)
  const p2 = derivedVectors(d, sheet(d, 'orders')).problems.map((p) => `${p.col}:${p.code}`)
  ok(p1.includes('bad1:via-not-link') && p1.includes('bad2:no-field'), `lookup via a non-link, rollup of a missing field (got ${J(p1)})`)
  ok(p2.includes('bad3:no-target'), 'a link to a table that does not exist')
  ok(!p1.some((p) => p.startsWith('spent')), 'CONTROL: the good columns report nothing')
}

console.log('\na lookup chain that reads itself is a cycle, not a hang')
{
  const d = workbook()
  sheet(d, 'orders').columns.push({ id: 'loop', name: 'Loop', type: 'text', kind: 'lookup', via: 'client', field: 'loopback' })
  sheet(d, 'clients').columns.push({ id: 'loopback', name: 'Loopback', type: 'text', kind: 'lookup', via: 'orders', field: 'loop' })
  const r = derivedVectors(d, sheet(d, 'orders'))
  ok(r.problems.some((p) => p.col === 'loop' && p.code === 'cycle'), 'reported as a cycle')
}

console.log('\nediting either side writes the ONE stored side, and both sides agree')
{
  const d = workbook()
  const orders = sheet(d, 'orders'), clients = sheet(d, 'clients')
  // From the owner: Pie (rid 13) → Cy (rid 3)
  for (const p of setLinkPatches(d, orders, col(orders, 'client'), 13, [3])) applyPatch(d, p)
  ok(J(linkRids(d, clients, col(clients, 'orders'))[2]) === '[13]', 'set on the owner: Cy\'s mirror now lists Pie')
  // From the mirror: Ada (rid 1) now has only Jam (12) — drop Tea and Cake, add Jam
  const patches = setLinkPatches(d, clients, col(clients, 'orders'), 1, [12])
  ok(patches.every((p) => (p as { sheet: string }).sheet === 'orders'), 'an edit on the mirror is written to the OWNER table only')
  for (const p of patches) applyPatch(d, p)
  ok(J(linkRids(d, orders, col(orders, 'client'))) === '[null,[2],[2,1],[3]]'.replace('null', '[]'),
    `stored: Tea has nobody, Cake keeps Bo, Jam gains Ada, Pie keeps Cy (got ${J(linkRids(d, orders, col(orders, 'client')))})`)
  ok(J(linkRids(d, clients, col(clients, 'orders'))) === '[[12],[11,12],[13]]', 'and the mirror reads the same truth back')
}

console.log('\nthe file round-trips: list cells and the new column fields survive parse')
{
  const r = parseDoc(JSON.stringify(workbook()))
  ok(r.ok, 'parses')
  const d = (r as { doc: DashDoc }).doc
  ok(J((sheet(d, 'orders').data as Record<string, { v: unknown[] }>).client.v) === '[[1],[1,2],[2],null]', 'array cells kept as written')
  ok(J(col(sheet(d, 'clients'), 'orders').inverseOf) === '{"table":"orders","col":"client"}' && col(sheet(d, 'clients'), 'spent').agg === 'sum',
    'inverseOf, via, field and agg kept')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
