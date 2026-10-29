// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Slides' Portuguese is Brazilian, and the theme picker never says "thin".
//
//   node scripts/test-slides-pt-br.mjs
//
// WHAT THIS PROVES.
//   1. slides/src/i18n/pt.ts carries no European-Portuguese markers. Its header
//      says pt-BR, but strings added later drifted to pt-PT: "ficheiro",
//      "guardar" for save, "diapositivo", "separador", "ecrã", "palavra-passe",
//      "bilhetes", "a seguir" progressives. Each marker is a word pt-BR does
//      not use in UI copy, so one in a value is a regression.
//   2. The Appearance picker uses its OWN keys ("Light mode", "Dark mode").
//      "Light" is also the 300 font weight, and the catalogs translate it as the
//      weight ("Fino", "Fin", "Leicht"), so a picker on t('Light') read "Fino".
//      Every catalog translates "Light mode", and never as its weight word.
import { readFileSync } from 'node:fs'

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const root = new URL('..', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')
// the VALUE side of each "key": "value", entry (the English keys say "share" etc.)
const values = (src) => [...src.matchAll(/^ {2}("(?:[^"\\]|\\.)*"): ("(?:[^"\\]|\\.)*"),$/gm)].map((m) => [JSON.parse(m[1]), JSON.parse(m[2])])

console.log('\nslides pt is pt-BR\n')
{
  const entries = values(read('slides/src/i18n/pt.ts'))
  ok(entries.length > 900, `the pt catalog parses (${entries.length} entries)`)
  // \b is ASCII-only in JS without the u flag; bound by non-letters explicitly
  const W = (w) => new RegExp(`(^|[^\\p{L}])(?:${w})($|[^\\p{L}])`, 'iu')
  const MARKERS = [
    ['ficheiro', W('ficheiros?')], ['diapositivo', W('diapositivos?')], ['separador (tab)', W('separador(es)?')],
    ['ecrã', W('ecrã')], ['palavra-passe', W('palavra-passe')], ['telemóvel', W('telemóvel')], ['rato (mouse)', W('rato')],
    ['consola', W('consola')], ['logótipo', W('logótipos?')], ['bilhete', W('bilhetes?')], ['Aspeto', W('aspeto')],
    ['guardar = save', /n[ãa]o guardad|\bguarda uma cópia|guardará|guarde uma nova|ao guardar|até guardar|[^\p{L}]guardar[^\p{L}]*$/iu],
    ['"a" + infinitive progressive', W('a (seguir|navegar|enviar|carregar|sincronizar)')],
    ['tu forms', W('(tuas?|teus?|estás|podes|tens|queres|continuas)')],
    ['"novo em folha"', /em folha/i], ['premir', W('premir')], ['excerto', W('excertos?')], ['num/numa', W('num|numa')],
  ]
  for (const [name, re] of MARKERS) {
    const hits = entries.filter(([, v]) => re.test(v))
    ok(hits.length === 0, `no ${name}${hits.length ? ` — ${hits.length}: ${hits.slice(0, 3).map(([k, v]) => `"${k.slice(0, 40)}" → "${v.slice(0, 60)}"`).join('; ')}` : ''}`)
  }
}

console.log('\nthe Appearance picker has its own words\n')
{
  const editor = read('slides/src/editor/editor.ts')
  const panels = read('slides/src/editor/inspector/text.ts')
  ok(/c === 'light' \? t\('Light mode'\) : t\('Dark mode'\)/.test(editor), "the picker reads t('Light mode') / t('Dark mode')")
  ok(/\[300, 'Light'\]/.test(panels), "the 300 font weight keeps 'Light'")
  for (const l of ['ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'de', 'it', 'pt']) {
    const m = new Map(values(read(`slides/src/i18n/${l}.ts`)))
    const light = m.get('Light mode'), dark = m.get('Dark mode'), weight = m.get('Light')
    ok(!!light && !!dark && light !== weight && light !== dark, `${l}: "${light}" / "${dark}" (the weight is "${weight}")`)
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
