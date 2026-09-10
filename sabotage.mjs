// Sabotage driver: break one thing, run the model rig, record WHICH assertions
// go red, restore, confirm green. An assertion nobody has watched fail is not
// evidence. Throwaway — deleted before the commit.
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const CASES = [
  ['hasOwn on the rollup spec', 'spaces/src/relations.ts',
    "const via = Object.hasOwn(o, 'via') && typeof o.via === 'string' ? o.via.trim() : ''",
    "const via = 'via' in o && typeof o.via === 'string' ? (o.via as string).trim() : ''"],

  ['page lookup is a Map', 'spaces/src/relations.ts',
    "new Map((Array.isArray(doc.pages) ? doc.pages : []).map((p) => [p.id, p]))",
    "(Object.fromEntries((Array.isArray(doc.pages) ? doc.pages : []).map((p) => [p.id, p])) as unknown as Map<string, Page>)"],

  ['the cycle guard', 'spaces/src/relations.ts',
    "if (chain.includes(me)) return none('cycle', LOOP)",
    "if (false) return none('cycle', LOOP)"],

  ['the depth cap', 'spaces/src/relations.ts',
    "if (chain.length >= ROLLUP_MAX_DEPTH) return none('depth', LOOP)",
    "if (false) return none('depth', LOOP)"],

  ['the loop propagating outward', 'spaces/src/relations.ts',
    "if (loop) return { ok: false, why: loop, text: LOOP, from, dangling }",
    "if (false) return { ok: false, why: loop, text: LOOP, from, dangling }"],

  ['defaults never stored in a rollup spec', 'spaces/src/relations.ts',
    "return { via, ...(of ? { of } : {}), ...(fn === 'count' ? {} : { fn }) }",
    "return { via, of, fn }"],

  ['a dangling id is not written as a link', 'spaces/src/relations.ts',
    '      : `[[${escText(tt.id)}]]`).join(\', \')',
    '      : `<a href="#p/${esc(tt.id)}">${escText(tt.id)}</a>`).join(\', \')'],

  ['relations reach the backlink index', 'spaces/src/model.ts',
    "      const rels = relationRefs(doc, b as { type?: string; key?: unknown; value?: unknown })",
    "      const rels: string[] = []"],

  ['the index reads a relation ONCE, not twice', 'spaces/src/model.ts',
    "      const linkSrc = rels.length ? '' : b.html || (Array.isArray(b.rows) ? tableCellsText(b.rows) : '')",
    "      const linkSrc = b.html || (Array.isArray(b.rows) ? tableCellsText(b.rows) : '')"],

  ['the graph counts a relation apart from prose', 'spaces/src/graph.ts',
    "      if (s.rel) edgeFor(a, b).rel++\n      else edgeFor(a, b).links++",
    "      edgeFor(a, b).links++"],

  ['propHtmlOf resolves a relation', 'spaces/src/relations.ts',
    "  if (f?.vt !== 'relation') return propHtml(f, value)",
    "  if (true) return propHtml(f, value)"],

  ['extract drops a relation that did not travel', 'spaces/src/portable.ts',
    "      const relF = relationFieldOf(doc, b)\n      if (relF) {",
    "      const relF = relationFieldOf(doc, b)\n      if (false && relF) {"],

  ['graft repoints a relation onto the renamed id', 'spaces/src/portable.ts',
    "      const relF = relationFieldOf(incoming, b)\n      if (relF) {",
    "      const relF = relationFieldOf(incoming, b)\n      if (false && relF) {"],

  ['validate reports a dangling relation', 'spaces/src/agent.ts',
    "            add({ ...at, code: 'broken-relation', severity: 'error', path: 'value',",
    "            if (false) add({ ...at, code: 'broken-relation', severity: 'error', path: 'value',"],

  ['validate refuses a STORED rollup', 'spaces/src/agent.ts',
    "        } else if (f.vt === 'rollup') {",
    "        } else if (false) {"],

  ['validate reports a rollup cycle', 'spaces/src/agent.ts',
    "      if (r.why !== 'cycle' && r.why !== 'depth') continue",
    "      if (true) continue"],

  ['validate reports a rollup with no relation to follow', 'spaces/src/agent.ts',
    "    const via = fieldOf.get(spec.via)",
    "    const via = fieldOf.get(spec.via) ?? { key: 'x', label: 'x', vt: 'relation' as const }"],

  ['a title that drifted is not called stale', 'spaces/src/agent.ts',
    "          const live = want.filter((id) => pageIx.has(id))\n          if (got.join('\\u001f') !== live.join('\\u001f')) {",
    "          const live = want.filter((id) => pageIx.has(id))\n          if (b.html !== propHtml(f, value)) {"],
]

const run = () => {
  const r = spawnSync(process.execPath, ['scripts/test-spaces-model.ts'], { encoding: 'utf8' })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const fails = [...out.matchAll(/^ {2}FAIL {2}(.*)$/gm)].map((m) => m[1])
  const crashed = !/checks passed/.test(out)
  return { fails, crashed, tail: out.slice(-400) }
}

const base = run()
if (base.fails.length || base.crashed) {
  console.log('BASELINE IS NOT GREEN — stopping'); console.log(base.tail); process.exit(1)
}
console.log('baseline green\n')

let bad = 0
for (const [name, file, from, to] of CASES) {
  const orig = readFileSync(file, 'utf8')
  if (!orig.includes(from)) { console.log(`?? ${name}: anchor not found in ${file}`); bad++; continue }
  writeFileSync(file, orig.replace(from, to))
  const r = run()
  writeFileSync(file, orig)
  const after = run()
  const ok = (r.fails.length > 0 || r.crashed) && after.fails.length === 0 && !after.crashed
  if (!ok) bad++
  console.log(`${ok ? 'CAUGHT ' : 'MISSED '} ${name}`)
  if (r.crashed) console.log('           (the rig CRASHED rather than failing an assertion)')
  for (const f of r.fails.slice(0, 4)) console.log(`           → ${f}`)
  if (r.fails.length > 4) console.log(`           → …and ${r.fails.length - 4} more`)
  if (!ok && !r.crashed && r.fails.length === 0) console.log('           → NOTHING went red. The assertion proves nothing.')
}
console.log(bad ? `\n${bad} sabotage(s) NOT caught` : `\nall ${CASES.length} sabotages caught, tree restored green`)
