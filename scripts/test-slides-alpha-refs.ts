#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// A palette-linked colour keeps its opacity in every released shell.
//
//     node scripts/test-slides-alpha-refs.ts
//
// A colour linked to a palette slot keeps the field's own opacity when the
// slot changes (palette.ts keepAlpha). Every released shell (1.0.19 to
// 1.2.13) re-derives a linked literal at BOOT as the bare slot colour, so a
// translucent linked field opened in one of them came back opaque, and stayed
// opaque on save: 87 fields of the starter deck alone, and through component
// mains, their copies too. The fix marks such a ref with a trailing ` /a`
// that the released parser rejects, so those shells leave the literal alone.
//
// The released parser is pinned below as RELEASED_REF, byte for byte from
// the shipped palette.ts, and every row that asks "would an older shell lose
// this?" runs the released derivation (that regex, the slot colour written
// with its own alpha) over the document this build would save.
//
// Rows: the starter deck loses nothing; opaque links keep their token byte
// for byte; a file in the old form is marked on opening without touching a
// literal and the derive pass is a fixed point; the mark comes off when the
// field turns opaque; components carry the mark to copies and a copy's own
// translucent colour marks its own ref; every intake (file open, Replace from
// JSON and loadDoc, compact JSON, a restored snapshot, a paste, live sync by
// op and by snapshot merge) keeps the marked ref, and the colour gate still
// judges the literal beside it.

import { register } from 'node:module'
register('./lib/ts-resolve-hooks.mjs', import.meta.url)
const { starterDoc } = await import('../slides/src/starterdeck.ts')
const { derive, deriveMemory } = await import('../slides/src/derive.ts')
const { paletteOf, parseThemeRef, shiftLightness } = await import('../slides/src/palette.ts')
const { parseDoc } = await import('../slides/src/model.ts')
const { guardOpenedDoc, gateRestored } = await import('../slides/src/restoregate.ts')
const { parseDocInputReport } = await import('../slides/src/compactload.ts')
const { compactJson } = await import('../slides/src/compact.ts')
const { parseClip, serializeElements, insertElements } = await import('../slides/src/editor/clipboard.ts')
const { SyncState } = await import('../slides/src/sync/crdt.ts')
const { validateDoc } = await import('../slides/src/validate.ts')
import type { BentoDoc } from '../slides/src/model.ts'

let failures = 0, checks = 0
const ok = (cond: boolean, msg: string, extra = '') => { checks++; if (!cond) failures++; console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}${extra ? `  (${extra})` : ''}`) }
const H = (s: string) => console.log(`\n${s}\n`)
type Rec = Record<string, any>
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

/** The token regex of every released palette.ts (1.0.19 through 1.2.13). */
const RELEASED_REF = /^\s*([A-Za-z][A-Za-z0-9]*)\s*(?:([+-])\s*(\d{1,3})\s*%)?\s*$/

const alpha = (c: unknown): number => {
  if (typeof c !== 'string') return 1
  const s = c.trim()
  const h = /^#[0-9a-f]{6}([0-9a-f]{2})$/i.exec(s)
  if (h) return Math.round(parseInt(h[1], 16) / 255 * 1000) / 1000
  const m = /^rgba?\(([^)]+)\)$/i.exec(s)
  const a = m ? Number(m[1].split(/[\s,/]+/)[3]) : NaN
  return a >= 0 && a <= 1 ? a : 1
}
const readPath = (o: any, p: string) => p.split('.').reduce((c, k) => (c == null ? c : c[k]), o)
const holders = (d: BentoDoc): Rec[] => [...d.slides, ...(d.layouts ?? [])].flatMap((s: Rec) => [s, ...s.elements])

/** What a released shell does to this document at boot: every literal whose
 *  token its parser accepts becomes the slot colour, shifted, alpha of the
 *  slot's own. Returns the fields whose opacity that changes. */
function releasedLoses(d: BentoDoc): string[] {
  const palette = paletteOf(d) as Rec
  const lost: string[] = []
  for (const h of holders(d)) for (const [path, token] of Object.entries((h.themeRefs ?? {}) as Record<string, string>)) {
    const m = RELEASED_REF.exec(token)
    if (!m || !palette[m[1]]) continue
    const shift = m[2] ? (m[2] === '-' ? -1 : 1) * Math.min(100, Number(m[3])) : 0
    const old = shiftLightness(palette[m[1]], shift)
    const have = readPath(h, path)
    if (typeof have === 'string' && alpha(have) !== alpha(old)) lost.push(`${h.id}:${path} ${have} -> ${old}`)
  }
  return lost
}
const settle = (d: BentoDoc) => { derive(d, deriveMemory(d)); return d }
const own = (d: BentoDoc) => holders(d).flatMap((h) => Object.values((h.themeRefs ?? {}) as Record<string, string>)).filter((t) => / \/a$/.test(t)).length
/** the document with every ` /a` taken off: a file saved before this fix */
const oldForm = (d: BentoDoc): BentoDoc => { const c = clone(d); for (const h of holders(c)) for (const k of Object.keys(h.themeRefs ?? {})) h.themeRefs[k] = h.themeRefs[k].replace(/\s*\/a$/, ''); return c }

H('the parser: the new form is ours alone')
{
  ok(!RELEASED_REF.test('tx2 +70% /a') && !RELEASED_REF.test('accent1 /a'), 'the released parser rejects a marked ref')
  ok(RELEASED_REF.test('tx2 +70%') && RELEASED_REF.test('accent1'), 'and still reads an unmarked one (the pin is the real regex)')
  const p = parseThemeRef('tx2 +70% /a')
  ok(!!p && p.slot === 'tx2' && p.shift === 70 && p.ownAlpha === true, 'this build reads slot, shift and the mark')
  ok(parseThemeRef('tx2 +70%')?.ownAlpha === undefined, 'an unmarked ref has no mark')
  ok(parseThemeRef('tx2 /b') === null && parseThemeRef('tx2 /a /a') === null, 'nothing else after the shift parses')
}

H('the starter deck in every released shell')
const start = settle(starterDoc())
{
  const translucent = holders(start).flatMap((h) => Object.entries((h.themeRefs ?? {}) as Record<string, string>)
    .filter(([p, t]) => !t.startsWith('$') && alpha(readPath(h, p)) < 1))
  ok(translucent.length >= 50, `the starter deck has translucent palette-linked colours to lose (${translucent.length})`)
  const before = releasedLoses(oldForm(start))
  ok(before.length >= 50, `POSITIVE CONTROL: in the old form a released shell makes them opaque (${before.length})`, before[0])
  const lost = releasedLoses(start)
  ok(lost.length === 0, 'as this build saves it, a released shell changes no opacity', lost.slice(0, 2).join(' ; '))
  ok(own(start) === translucent.length, `exactly the translucent links carry the mark (${own(start)})`)
}

H('opaque links are left as they were')
{
  // against the deck's own source, paired by place (ids repeat across slides)
  const raw = starterDoc()
  const was0 = holders(raw)
  let same = 0, moved = 0
  for (const [i, h] of holders(start).entries()) for (const [p, t] of Object.entries((h.themeRefs ?? {}) as Record<string, string>)) {
    if (t.endsWith(' /a')) continue
    const was = was0[i]?.themeRefs?.[p]
    if (was === undefined) continue
    if (was === t) same++; else moved++
  }
  ok(same > 100 && moved === 0, `every unmarked token is byte-identical to the deck's source (${same} kept, ${moved} rewritten)`)
}

H('a file saved in the old form')
{
  const old = oldForm(start)
  const opened = parseDoc(JSON.stringify(old))!
  guardOpenedDoc(opened)
  settle(opened)
  ok(own(opened) === own(start), `opening it marks the translucent links (${own(opened)})`)
  const lit = (d: BentoDoc) => JSON.stringify(holders(d).map((h) => { const c = clone(h); delete c.themeRefs; delete c.component; delete c.elements; return c }))
  ok(lit(opened) === lit(old), 'without changing a single literal')
  const again = clone(opened)
  ok(!derive(again, deriveMemory(again)) && JSON.stringify(again) === JSON.stringify(opened), 'and a second derive pass changes nothing')
  ok(releasedLoses(opened).length === 0, 'its next save survives a released shell')
}

H('the mark follows the field')
{
  const d = settle(starterDoc())
  const h = holders(d).find((x) => Object.values(x.themeRefs ?? {}).some((t: any) => t.endsWith(' /a')))!
  const [path] = Object.entries(h.themeRefs).find(([, t]: any) => t.endsWith(' /a'))!
  const lit = readPath(h, path) as string
  // make it opaque (the editor writes the full colour)
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+)/.exec(lit)
  const hex = m ? '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('') : lit.slice(0, 7)
  const segs = path.split('.'); let cur: any = h; for (const s of segs.slice(0, -1)) cur = cur[s]; cur[segs[segs.length - 1]] = hex
  settle(d)
  ok(!h.themeRefs[path].endsWith(' /a') && parseThemeRef(h.themeRefs[path]) !== null, `an opaque field loses the mark (${h.themeRefs[path]})`)
  cur[segs[segs.length - 1]] = lit
  settle(d)
  ok(h.themeRefs[path].endsWith(' /a'), 'and gets it back when it turns translucent again (no palette change needed)')
}

H('components')
{
  const d = settle(starterDoc())
  const comp = holders(d).filter((h) => h.component)
  const mains = comp.filter((h) => h.component.main && Object.values(h.themeRefs ?? {}).some((t: any) => t.endsWith(' /a')))
  ok(mains.length > 0, `a component main carries a marked link (${mains.length})`)
  const copies = comp.filter((h) => !h.component.main && mains.some((m) => m.component.id === h.component.id && m.component.key === h.component.key))
  ok(copies.length > 0 && copies.every((c) => JSON.stringify(c.themeRefs) === JSON.stringify(mains.find((m) => m.component.key === c.component.key)!.themeRefs)),
    `its copies carry the same marked refs (${copies.length})`)
  // a copy's own translucent colour over an opaque main
  const m = comp.find((h) => h.component.main && h.type === 'text' && h.themeRefs?.color && !h.themeRefs.color.endsWith(' /a') && alpha(h.color) === 1)
  const c = m && comp.find((h) => !h.component.main && h.component.id === m.component.id && h.component.key === m.component.key)
  if (m && c) {
    // the same linked colour, at 40%: what the opacity field writes
    const hx = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(c.color)!
    const want = `rgba(${parseInt(hx[1], 16)}, ${parseInt(hx[2], 16)}, ${parseInt(hx[3], 16)}, 0.4)`
    c.color = want
    const once = settle(d)
    ok(c.themeRefs.color.endsWith(' /a') && c.color === want, `a copy's own translucent colour marks its own ref (${c.themeRefs.color}, ${c.color})`)
    ok(!m.themeRefs.color.endsWith(' /a'), 'and leaves its main unmarked')
    const again = clone(once)
    ok(!derive(again, deriveMemory(again)), 'one derive pass settles it (the next changes nothing)')
    ok(releasedLoses(once).length === 0, 'and a released shell loses nothing')
    // the main turns translucent and back: its copies follow its ref, and the
    // copy whose own colour is translucent must end marked all the same
    const hm = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(m.color)!
    const opaque = m.color
    m.color = `rgba(${parseInt(hm[1], 16)}, ${parseInt(hm[2], 16)}, ${parseInt(hm[3], 16)}, 0.5)`
    settle(d)
    ok(m.themeRefs.color.endsWith(' /a'), `a main turned translucent is marked (${m.themeRefs.color})`)
    m.color = opaque
    const back = settle(d)
    ok(!m.themeRefs.color.endsWith(' /a') && c.themeRefs.color.endsWith(' /a') && c.color === want,
      `turned opaque again, the main is unmarked and its translucent copy stays marked (${m.themeRefs.color} / ${c.themeRefs.color})`)
    const again2 = clone(back)
    ok(!derive(again2, deriveMemory(again2)) && releasedLoses(back).length === 0, 'settled in one pass, nothing lost')

    // a copy that follows its main's (marked) ref with a translucent colour of
    // its own, then the main turns opaque: the copy takes the main's now
    // unmarked ref, and only a pass AFTER components can mark it again
    const d2 = settle(starterDoc())
    const all = holders(d2)
    const m2 = all.find((h) => h.id === m.id && h.component?.main)!
    const c2 = all.find((h) => h.id === c.id && !h.component?.main && h.component?.key === m2.component.key)!
    m2.color = `rgba(${parseInt(hm[1], 16)}, ${parseInt(hm[2], 16)}, ${parseInt(hm[3], 16)}, 0.5)`
    settle(d2)
    c2.color = want
    settle(d2)
    ok(c2.themeRefs.color === m2.themeRefs.color && c2.themeRefs.color.endsWith(' /a'), `setup: copy and main share the marked ref (${c2.themeRefs.color})`)
    m2.color = opaque
    const after = settle(d2)
    ok(!m2.themeRefs.color.endsWith(' /a') && c2.color === want && c2.themeRefs.color.endsWith(' /a'),
      `the main turns opaque: its copy's translucent colour keeps its own mark (${m2.themeRefs.color} / ${c2.themeRefs.color})`)
    const again3 = clone(after)
    ok(!derive(again3, deriveMemory(again3)) && releasedLoses(after).length === 0, 'settled in one pass, nothing lost')
  } else ok(false, 'the starter deck has an opaque linked text main with a copy to override')
}

H('every intake keeps the marked ref; the colour gate still judges the literal')
{
  const d = settle(starterDoc())
  const h = holders(d).find((x) => x.type === 'text' && x.themeRefs?.color?.endsWith(' /a'))!
  const token = h.themeRefs.color, lit = h.color
  const find = (doc: BentoDoc) => holders(doc).find((x) => x.id === h.id && x.type === 'text')
  const keeps = (doc: BentoDoc | undefined | null) => !!doc && find(doc)?.themeRefs?.color === token && find(doc)?.color === lit

  const opened = parseDoc(JSON.stringify(d))!; guardOpenedDoc(opened)
  ok(keeps(opened), `file open (parseDoc + guardOpenedDoc): ${token}`)
  const rep = parseDocInputReport(JSON.stringify(d), { live: d })
  ok(keeps(rep?.doc) && !rep!.report.dropped.some((x: Rec) => /themeRefs/.test(x.path)), 'Replace from JSON / loadDoc: kept, nothing dropped')
  const comp = parseDocInputReport(compactJson(d), { live: d })
  ok(keeps(comp?.doc), 'compact JSON: kept')
  const restored = gateRestored(JSON.stringify(d), d)
  ok(keeps(restored?.doc) && !restored!.dropped.some((x: Rec) => /themeRefs/.test(x.path)), 'a restored snapshot: kept, nothing dropped')
  const slide = d.slides.find((s) => s.elements.some((e) => e === h))!
  const clip = parseClip(serializeElements([h as never], d))
  const pasted = clip && insertElements(clip, clone(d), clone(slide))
  ok(!!pasted && pasted.some((e: Rec) => e.themeRefs?.color === token && e.color === lit), 'a paste: kept')

  // the colour gate is the literal's, whatever the ref says
  const bad = clone(d); const bh = find(bad)!; bh.color = 'red}'
  const g = parseDocInputReport(JSON.stringify(bad), { live: bad })
  ok(!!g && find(g.doc)?.color !== 'red}' && g.report.dropped.some((x: Rec) => /color$/.test(x.path)), 'a literal the colour gate refuses is still refused beside a marked ref')
  const v = validateDoc(d)
  ok(!v.findings.some((f: Rec) => /theme-ref/.test(f.code)), 'validate() takes the marked refs as well-formed')

  // live sync: an op, and a snapshot merge, from a peer whose deck has the mark
  const unmarked = oldForm(d)
  const A = new SyncState('alice'); const a = clone(unmarked); A.adopt(a as never)
  const B = new SyncState('bob'); const b = clone(unmarked); B.adopt(b as never)
  const before = clone(b)
  const fb = find(b)!; fb.themeRefs.color = token
  const ops = B.diff(before, b as never, { text: true })
  A.apply(a as never, ops as never)
  ok(find(a)?.themeRefs?.color === token, `live sync, op apply: the peer's marked ref lands (${ops.length} op)`)
  const C = new SyncState('carol'); const c = clone(unmarked); C.adopt(c as never)
  C.mergeSnapshot(c as never, b as never, B.toJSON())
  ok(find(c)?.themeRefs?.color === token, 'live sync, snapshot merge: the marked ref lands')
  settle(a); settle(c)
  ok(find(a)?.themeRefs?.color === token && find(c)?.themeRefs?.color === token, 'and each replica\'s own derive pass agrees with it')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
