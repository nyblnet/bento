// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// kernel/src/svgsafe.ts: every policy option ONLY TIGHTENS slides' default.
//
// Run: node scripts/test-svgsafe-policy-browser.mjs   (PLAYWRIGHT_MODULE, as in CI)
//
// The default policy is slides' renderer, held by test-sanitize.ts and the egress
// rigs. This rig holds the options an app adds on top of it (type's embed
// pictures use all of them), in Chromium, because the walk runs on parsed DOM:
//   - each option REMOVES something the default keeps (it is not a no-op);
//   - under every option and under all of them at once, every kept element and
//     attribute was also kept by the default (no option is ever looser).

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

// bundle the module for the page (esbuild, as the other kernel rigs)
const dir = mkdtempSync(join(tmpdir(), 'svgsafe-'))
const entry = join(dir, 'entry.ts'), out = join(dir, 'bundle.js')
await import('node:fs').then((fs) => fs.writeFileSync(entry,
  `import { cleanSvgChildren } from ${JSON.stringify(join(ROOT, 'kernel/src/svgsafe.ts'))}\n` +
  `;(globalThis as any).__run = (markup: string, policy: any) => {\n` +
  `  const doc = new DOMParser().parseFromString(markup, 'text/html')\n` +
  `  try { cleanSvgChildren(doc.body, policy) } catch (e) { return ['THREW: ' + e] }\n` +
  `  // what was KEPT: every element by its tag path (no sibling indexes, which a\n` +
  `  // removed sibling would shift), with its attributes; compared as multisets\n` +
  `  const kept: string[] = []\n` +
  `  const walk = (n: Element, path: string) => Array.from(n.children).forEach((c) => {\n` +
  `    const p = path + '/' + c.localName\n` +
  `    kept.push(p); for (const a of Array.from(c.attributes)) kept.push(p + '@' + a.name.toLowerCase() + '=' + a.value)\n` +
  `    walk(c, p) })\n` +
  `  walk(doc.body, '')\n` +
  `  return kept\n}\n` +
  `;(globalThis as any).__sheetOf = (markup: string) => {\n` +
  `  const doc = new DOMParser().parseFromString(markup, 'text/html')\n` +
  `  cleanSvgChildren(doc.body, { scopeStyle: (css: string) => css })\n` +
  `  return doc.body.querySelector('style')?.textContent ?? null\n}\n`))
execFileSync(join(ROOT, 'slides/node_modules/.bin/esbuild'), [entry, '--bundle', '--format=iife', '--log-level=error', `--outfile=${out}`])
const bundle = readFileSync(out, 'utf8')
rmSync(dir, { recursive: true, force: true })

const S = 'script'
const scoped = 'css => css' // the default's scopeStyle hook: a no-op scope (scoping is not under test)
const OPTIONS = {
  'scopeStyle: null': { scopeStyle: null },
  'refuseTags: [a]': { refuseTags: ['a'] },
  'refuseAttrs: [cursor, title]': { refuseAttrs: ['cursor', 'title'] },
  'dataAttrs: false': { dataAttrs: false },
  'remoteHref: false': { remoteHref: false },
  'strictValues: true': { strictValues: true },
}
// one input per option where the DEFAULT keeps something that option must remove
const BITES = {
  'scopeStyle: null': '<svg><style>rect{fill:red}</style><rect width="5" height="5" style="fill:red"/></svg>',
  'refuseTags: [a]': '<svg><a href="#x"><circle r="5"/></a></svg>',
  'refuseAttrs: [cursor, title]': '<svg><rect width="5" height="5" cursor="pointer" title="t"/></svg>',
  'dataAttrs: false': '<svg><rect width="5" height="5" data-part="bar"/></svg>',
  'remoteHref: false': '<svg><image href="https://example.test/x.png" width="5" height="5"/><image href="data:image/svg+xml;base64,PHN2Zy8+" width="5" height="5"/></svg>',
  'strictValues: true': '<svg><rect width="5" height="5" fill="url(data:image/png;base64,iVBORw0KGgo=)" font-family="A\\42 C"/></svg>',
}
// a broad set: benign pictures and hostile markup alike
const INPUTS = [
  ...Object.values(BITES),
  '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>',
  '<svg viewBox="0 0 10 10"><symbol id="s"><circle r="2"/></symbol><use href="#s"/><use href="https://example.test/s.svg#a"/></svg>',
  '<svg><circle r="5"><animate attributeName="r" from="2" to="4" dur="1s"/><set attributeName="onclick" to="x"/></circle></svg>',
  '<svg><a href="https://example.test"><text>x</text></a><a href="javascript:alert(1)"><text>y</text></a></svg>',
  `<svg><${S}>x()</${S}><foreignObject><img src=x onerror=x()></foreignObject><circle/onmouseover="x()" r="1"/></svg>`,
  '<svg><style>@import "https://example.test/x.css"; rect{fill:url(https://example.test/p)}</style></svg>',
  '<svg><rect width="5" height="5" data-el-id="x" data-foo="y" aria-label="f(x)" tabindex="0" style="fill:url(#g)"/></svg>',
  '<svg><feImage href="https://example.test/x.png"/><image href="data:image/png;base64,iVBORw0KGgo="/></svg>',
]

/** What `tight` keeps beyond `base`, counting repeats (a multiset difference). */
function beyond(base, tight) {
  const left = new Map()
  for (const k of base) left.set(k, (left.get(k) ?? 0) + 1)
  return tight.filter((k) => { const n = left.get(k) ?? 0; if (n) { left.set(k, n - 1); return false } return true })
}

const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH })
try {
  const page = await browser.newPage()
  await page.setContent('<!doctype html><html><body></body></html>')
  await page.addScriptTag({ content: bundle })
  const run = (markup, extra) => page.evaluate(([m, e, hook]) => {
    const policy = { scopeStyle: eval(hook), ...e }
    return globalThis.__run(m, policy)
  }, [markup, extra, scoped])

  console.log('\neach option removes something the default keeps')
  for (const [name, opt] of Object.entries(OPTIONS)) {
    const base = await run(BITES[name], {}), tight = await run(BITES[name], opt)
    ok(tight.length < base.length && beyond(base, tight).length === 0, `${name}: ${base.length - tight.length} kept item(s) fewer`)
  }

  console.log('\nnever looser: whatever an option keeps, the default kept too')
  const all = Object.assign({}, ...Object.values(OPTIONS))
  for (const [name, opt] of [...Object.entries(OPTIONS), ['all options at once', all]]) {
    let extra = []
    for (const x of INPUTS) {
      extra.push(...beyond(await run(x, {}), await run(x, opt)))
    }
    ok(extra.length === 0, `${name}, over ${INPUTS.length} inputs${extra.length ? ' — kept beyond the default: ' + extra.slice(0, 3).join('; ') : ''}`)
  }

  console.log('\nthe style hook only scopes: the walk sanitizes every kept sheet itself (security)')
  // an app passing the identity hook still gets a SANITIZED sheet, never the raw one
  const raw = '<svg><style>@import "https://example.test/x.css"; rect{fill:url(https://example.test/p)} @\\69mport "https://example.test/y.css";</style></svg>'
  const text = await page.evaluate((m) => globalThis.__sheetOf(m), raw)
  // both at-rules renamed (the escaped one too), so the parser drops them whole;
  // the url() to a remote target rewritten to none
  ok(typeof text === 'string' && !/@import|@\\69/i.test(text) && (text.match(/@bento-refused/g) ?? []).length === 2 && !/url\(\s*['"]?https/i.test(text) && text.includes('fill:none'),
    `with css => css as the hook, the kept sheet is still sanitized: ${JSON.stringify(text).slice(0, 90)}`)
  const noHook = await page.evaluate((m) => { try { return globalThis.__run(m, { scopeStyle: null }) } catch (e) { return String(e) } }, BITES['scopeStyle: null'])
  ok(Array.isArray(noHook) && !noHook.some((k) => k.endsWith('/style') || k.includes('@style=')), 'scopeStyle: null drops <style> and style= alike')
} finally {
  await browser.close()
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
