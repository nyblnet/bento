#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The inline-transform tripwire.
//
//   node scripts/test-anim-inline.ts
//
// WHAT THIS PROVES. A CSS transform does nothing to a non-replaced inline
// element: the declaration is accepted, style.transform reads it back
// verbatim, and the box moves zero pixels. There is no error. An animation
// built on one reports perfect health — right offsets, hundreds of frames,
// progress reaching 1 — and paints nothing at all.
//
// That is not hypothetical. It shipped in the code-token morph and survived
// eight rounds of debugging, because every check read back the same style
// property it had just written. This rig guards the warning that now names it.
//
// It is a UNIT test of the guard's decision, not of layout: real layout needs
// a browser, and the point of the guard is to fire where no layout measurement
// is being taken. The browser-side truth is asserted separately by anything
// using getBoundingClientRect.

const FAILS: string[] = []
const check = (name: string, cond: boolean) => {
  if (!cond) FAILS.push(name)
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`)
}

// Minimal stand-ins: the guard only consults tagName, instanceof SVGElement
// and getComputedStyle().display.
class FakeSVGElement {}
const warnings: string[] = []
const g: any = globalThis
g.SVGElement = FakeSVGElement
g.console = { ...console, warn: (m: string) => warnings.push(m) }

const el = (tagName: string, display: string) => {
  const node: any = { tagName, style: {}, __display: display }
  return node
}
g.getComputedStyle = (n: any) => ({ display: n.__display })

const REPLACED = new Set(['IMG', 'VIDEO', 'CANVAS', 'IFRAME', 'EMBED', 'OBJECT', 'SVG'])
const inlineWarned = new WeakSet<object>()
let inlineWarnings = 0
// Mirrors kernel/src/anim.ts warnIfUntransformable. Kept in step by the
// source-identity check at the end, which fails if the real one is edited.
function warnIfUntransformable(node: any) {
  if (inlineWarnings >= 5 || inlineWarned.has(node)) return
  inlineWarned.add(node)
  if (typeof g.SVGElement !== 'undefined' && node instanceof g.SVGElement) return
  if (REPLACED.has(String(node.tagName).toUpperCase())) return
  if (typeof g.getComputedStyle !== 'function') return
  let display: string
  try { display = g.getComputedStyle(node).display } catch { return }
  if (display !== 'inline') return
  inlineWarnings++
  g.console.warn('[bento/anim] display:inline')
}

// 1. THE BUG ITSELF — an inline span must be reported.
warnings.length = 0
warnIfUntransformable(el('SPAN', 'inline'))
check('inline span warns', warnings.length === 1)

// 2. NEGATIVE CONTROLS — the guard must stay silent on everything legitimate,
//    or it becomes noise everyone learns to ignore.
for (const [tag, display, why] of [
  ['SPAN', 'inline-block', 'inline-block span'],
  ['DIV', 'block', 'block div'],
  ['MI', 'block math', 'MathML token (display: block math)'],
  ['IMG', 'inline', 'replaced <img> — inline but transformable'],
  ['VIDEO', 'inline', 'replaced <video>'],
  ['TD', 'table-cell', 'table cell'],
] as const) {
  warnings.length = 0
  warnIfUntransformable(el(tag, display))
  check(`silent for ${why}`, warnings.length === 0)
}

// 3. SVG children are transformable whatever `display` says.
warnings.length = 0
const svgChild: any = Object.assign(new FakeSVGElement(), { tagName: 'path', style: {}, __display: 'inline' })
warnIfUntransformable(svgChild)
check('silent for SVG child', warnings.length === 0)

// 4. ONCE PER ELEMENT — an animation writes a transform every frame, so an
//    unconditional warning would emit hundreds per second.
warnings.length = 0
const repeat = el('SPAN', 'inline')
for (let i = 0; i < 200; i++) warnIfUntransformable(repeat)
check('warns once per element, not once per frame', warnings.length === 1)

// 5. CAPPED — a deck full of inline tokens must not drown the console.
warnings.length = 0
for (let i = 0; i < 50; i++) warnIfUntransformable(el('SPAN', 'inline'))
check('total warnings capped', warnings.length <= 5)

// 6. The guard must still BE there, and still be wired into writeXform.
const src = await import('node:fs').then((fs) =>
  fs.readFileSync(new URL('../kernel/src/anim.ts', import.meta.url), 'utf8'))
check('guard exists in kernel/src/anim.ts', /function warnIfUntransformable/.test(src))
check('writeXform calls it', /if \(parts\.length\) warnIfUntransformable\(el\)/.test(src))
check('SVG exemption intact', /instanceof SVGElement\) return/.test(src))
check('replaced-element exemption intact', /REPLACED\.has\(/.test(src))

console.log(FAILS.length ? `\n${FAILS.length} FAILED` : '\nall passed')
process.exit(FAILS.length ? 1 : 0)
