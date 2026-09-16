#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// spike-still-splash rig: the constraints the spike must not break, and the
// pure half of the still-copy logic.
//
//   node scripts/test-still-splash.ts            (bundled with esbuild in CI)
//
// WHAT THIS PROVES. (1) The preview machinery is untouched: preview.ts, the
// kernel's writePreview/remover/pristine capture and shell-gate's preview
// invariant are byte-identical to the branch base. (2) still.ts reuses
// preview.ts's own page-one render (same first-page rule, same markup) and
// never carries a literal splash opener or script tag into the bundle (the
// compressor greps the built HTML for those — a literal inside the bundle is
// found first; measured: it carried 1.6 MB of bundle as "the splash").
// (3) Replace-never-append: a second save strips the first save's copy.
// (4) The splash is at its resting state at frame zero — no entrance
// animation — and a still hides on mount, not on a timer. (5) The loader's
// approximation path uses no rAF and no timers.

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stripStill, previewTier, STILL_ATTR } from '../slides/src/still.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f: string) => readFileSync(join(root, f), 'utf8')
const GIT = process.env.GIT ?? 'git'

console.log('constraints: the preview machinery is untouched\n')
const BASE = process.env.STILL_BASE ?? 'origin/slides-loader-cascade'
let diffOk = true
try {
  const out = execFileSync(GIT, ['diff', BASE, '--stat', '--', 'slides/src/preview.ts', 'kernel/src/save.ts', 'scripts/shell-gate.mjs'], { cwd: root, encoding: 'utf8' })
  diffOk = out.trim() === ''
  ok(diffOk, `preview.ts, kernel/src/save.ts and shell-gate.mjs are byte-identical to ${BASE}${diffOk ? '' : ':\n' + out}`)
} catch (e) {
  ok(false, `could not diff against ${BASE}: ${(e as Error).message.split('\n')[0]}`)
}

console.log('\nstill.ts reuses the preview and hides from the compressor\n')
const still = read('slides/src/still.ts')
ok(/import \{ buildSlidePreview \} from '\.\/preview'/.test(still), 'page one comes from preview.ts buildSlidePreview — the same first-page rule (first slide in the linear flow) and the same markup')
ok(/import \{ previewAllowed, previewIsSafe \} from '\.\.\/\.\.\/kernel\/src\/save\.ts'/.test(still), 'the encryption veto and the output-safety check are the kernel\'s own')
ok(!/<div id="bento-splash"/.test(still), 'no literal splash opener in the module (the compressor would find it inside the bundle first)')
ok(!/<script[\s>]/.test(still), 'no literal script tag in the module')
ok(/\.join\(''\)/.test(still), 'tags are assembled with Array.join — a `+` of two literals is constant-folded by esbuild back into the literal (measured)')

console.log('\nreplace-never-append, pure\n')
const splash = '<div id="bento-splash" aria-hidden="true"><div class="bs-mark"></div></div>'
const copy = (n: string) => `<div id="bento-splash" aria-hidden="true" ${STILL_ATTR}="1"><div ${STILL_ATTR}="1">${n}</div><!--bento-still-end--><div class="bs-mark"></div></div>`
ok(stripStill(copy('<div>PAGE ONE</div>')) === splash, 'a saved copy is stripped back to the bare splash (attribute and copy)')
ok(stripStill(splash) === splash, 'a splash without a copy is returned unchanged')
const two = `<div id="bento-splash" aria-hidden="true" ${STILL_ATTR}="1"><div ${STILL_ATTR}="1">A</div><!--bento-still-end--><div ${STILL_ATTR}="1">B</div><!--bento-still-end--><div class="bs-mark"></div></div>`
ok(stripStill(two) === splash, 'two stacked copies (should never happen) both go')
const tierEl = (html: string) => ({ outerHTML: html } as HTMLElement)
const doc = { theme: { accent: '#f7a600' } } as never
ok(previewTier(tierEl('<div><div class="bento-slide">…</div></div>'), doc) === 1, 'tier 1: a rendered page with its images')
ok(previewTier(tierEl('<div><div class="bento-slide"><div style="background:linear-gradient(135deg,#f7a6002E,#f7a60012)"></div></div></div>'), doc) === 2, 'tier 2: the accent-tinted image boxes')
ok(previewTier(tierEl('<div><div style="font-weight:800">Title</div></div>'), doc) === 3, 'tier 3: a title card, no .bento-slide')
ok(/previewTier\(el, doc\) !== 1\) return out/.test(still), 'only a tier-1 preview becomes the still; tiers 2–3 keep the blue splash')
ok(/if \(!previewAllowed\(body, encrypted\)\) return out/.test(still) && /if \(!previewIsSafe\(markup\)\) return out/.test(still), 'no still for an encrypted deck; unsafe markup is refused')

console.log('\nthe splash at frame zero\n')
const index = read('slides/index.html')
ok(!/bsIn|bsTile|bsUp/.test(index), 'no entrance keyframes: bsIn, bsTile and bsUp are gone')
ok(!/\.bs-mark i\{[^}]*opacity:0/.test(index), 'the tiles are visible at rest (no opacity:0)')
ok(/#bento-splash\[data-bento-still\]>:not\(\[data-bento-still\]\)\{display:none\}/.test(index), 'with a still present the logo, wordmark and bar are hidden, not animated')
const mainTs = read('slides/src/main.ts')
ok(/splash\.hasAttribute\('data-bento-still'\) \? 0 : Math\.max\(0, 1250 - performance\.now\(\)\)/.test(mainTs), 'a still hides the instant the editor mounts; the blue splash keeps its 1250 ms brand hold')

console.log('\nthe loader\'s approximation uses no clock\n')
const comp = read('scripts/postbuild-compress.mjs')
const block = comp.slice(comp.indexOf('const STILL_APPROX = `'), comp.indexOf('\n`', comp.indexOf('const STILL_APPROX = `')))
ok(block.length > 1000, 'the approximation block exists')
ok(!/requestAnimationFrame|setTimeout|setInterval|\.then\(|await /.test(block), 'it paints synchronously — no rAF, no timers, no promises')
ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(block), 'it never injects document strings as HTML (createTextNode only)')
ok(/createTextNode/.test(block), 'text goes in as text nodes')
ok(/const stillMode = flag\('still', 'none'\)/.test(comp), 'the approximation is opt-in (--still approx); the shipped default is unchanged')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
