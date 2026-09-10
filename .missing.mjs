import { readFileSync, readdirSync } from 'node:fs'
const dir = '/Users/andy/devel/bento/.claude/worktrees/agent-ae75bcffed021c7d4/spaces/src'
const keys = new Set()
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const full = `${d}/${e.name}`
    if (e.isDirectory()) { if (e.name !== 'i18n') walk(full); continue }
    if (!e.name.endsWith('.ts')) continue
    const src = readFileSync(full, 'utf8')
    const re = /\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g
    let m
    while ((m = re.exec(src))) keys.add(m[2].replace(/\\'/g, "'").replace(/\\"/g, '"'))
  }
}
walk(dir)
for (const loc of ['ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'de', 'it', 'pt']) {
  const cat = readFileSync(`${dir}/i18n/${loc}.ts`, 'utf8')
  const have = new Set()
  const re = /^\s*"((?:\\.|[^"])*)":/gm
  let m
  while ((m = re.exec(cat))) have.add(m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
  const missing = [...keys].filter((k) => !have.has(k))
  console.log(loc, missing.length)
  if (loc === 'fr') for (const k of missing) console.log('  ' + JSON.stringify(k))
}
