// One more sabotage, sharper than the first attempt at it. Replacing the Map
// with `Object.fromEntries` alone crashed the rig (no `.get`), which proves the
// path runs and NOT that the Map is what stops a prototype key being a page.
// This replaces the lookup itself with the plain-object form somebody would
// actually write.
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const file = 'spaces/src/relations.ts'
const from = `  const byId = pageMap(doc)
  return ids.map((id) => {
    const page = byId.get(id)`
const to = `  const byId = Object.fromEntries((doc.pages ?? []).map((p) => [p.id, p])) as Record<string, Page>
  return ids.map((id) => {
    const page = byId[id]`

const run = () => {
  const r = spawnSync(process.execPath, ['scripts/test-spaces-model.ts'], { encoding: 'utf8' })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  return {
    fails: [...out.matchAll(/^ {2}FAIL {2}(.*)$/gm)].map((m) => m[1]),
    crashed: !/checks passed/.test(out),
  }
}

const orig = readFileSync(file, 'utf8')
if (!orig.includes(from)) { console.log('anchor not found'); process.exit(1) }
writeFileSync(file, orig.replace(from, to))
const broken = run()
writeFileSync(file, orig)
const after = run()
console.log('broken →', broken.crashed ? 'CRASHED' : `${broken.fails.length} FAIL(s)`)
for (const f of broken.fails.slice(0, 6)) console.log('   →', f)
console.log('restored →', after.crashed ? 'CRASHED' : `${after.fails.length} FAIL(s)`)
