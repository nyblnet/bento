// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/type: what the screen shows is what the document holds.
//
//   npm run build:single --prefix type && node scripts/test-type-fuzz-browser.mjs
//
// A randomized editing rig. Each seed boots the packaged document, loads a
// small mixed document (headings, paragraphs, a list, a quote, two footnotes),
// and drives it with REAL keystrokes from Playwright: typing, Enter,
// Backspace, Delete, selections inside one block and across blocks, Select
// All, bold, paste, undo/redo and Insert ▸ Table. After every step it takes
// two pictures of the paper:
//
//   screen — the block elements as the user sees them (id + text, and where
//            each footnote marker sits), any text sitting outside a block,
//            and any id the browser duplicated;
//   model  — the same, after a forced `editor.render()` from `bento.doc`.
//
// They must be equal. When they are not, the next redraw or save loses what
// the user sees: the failure class behind every editor-integrity bug in
// bento/type. The rig shrinks a failing run to a short op list and prints it
// with its seed, so `FUZZ_REPLAY='<json>'` reproduces it.
//
// TWO TIERS, both asserted:
//
//   HOLDS   — op classes the editor gets right today. A fuzz over all of them
//             must be clean. Any divergence is a regression.
//   BROKEN  — op classes known to desync (bold across blocks, paste, typing
//             after Insert ▸ Table, whitespace). Each must STILL be caught:
//             this is the rig's positive control, proving the comparison has
//             teeth. The PR that fixes one sees its row go red
//             ("no longer diverges") and moves the op into HOLDS, so the fuzz
//             guards it from then on. That is how Phase 1 is measured.
//
// Environment:
//   SEEDS (16)  STEPS (60)  SEED (first seed, 1)  — the HOLDS fuzz
//   FUZZ_OPS=a,b,c     fuzz only these ops (any tier); the run reports, and
//                      exits 1 on a divergence
//   FUZZ_REPLAY=<json> replay one printed op list and report
//   TYPE_SHELL         the shell under test (default: the type build)
//   CHROME_PATH        a system Chrome; unset = Playwright's bundled browser
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

const SHELL = process.env.TYPE_SHELL || new URL('../type/dist-single/Bento_Type.bento.html', import.meta.url).href
const SEEDS = +(process.env.SEEDS || 16)
const STEPS = +(process.env.STEPS || 60)
const SEED0 = +(process.env.SEED || 1)

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

// ─────────────────────────────────────────────────────────── op classes

/** Op classes the editor handles correctly today; the fuzz must stay clean. */
const HOLDS = ['type', 'enter', 'backspace', 'delete', 'deljoin', 'overtype', 'xdelete', 'xtype', 'xedge', 'selall', 'bold', 'paste1', 'undo', 'redo', 'undoredo']
/** Known divergences, and the roadmap PR that owns each. */
const BROKEN = {
  spaces: 'whitespace: a space at the edge of a block, or two in a row, is collapsed on screen and lost on the next edit',
  xbold: 'A2 marks over ranges: bold over a selection that crosses blocks',
  pastesp: 'A3 paste: a one-line paste right before a space drops that space (inside a mark that ends in it, it also adds a paragraph)',
  pasteN: 'A3 paste: multi-paragraph plain-text paste',
  table: 'A6 caret after Insert: Insert ▸ Table, then type into its first cell',
}

const seedDoc = () => ({
  title: 'Fuzz',
  body: [
    { id: 'h', kind: 'h1', text: 'Terms of the agreement' },
    { id: 'p1', kind: 'para', text: 'The supplier will deliver the work by the end of the month.',
      marks: [{ t: 'i', from: 4, to: 12 }, { t: 'u', from: 39, to: 52 }], notes: [{ id: 'n1', at: 25 }] },
    { id: 'p2', kind: 'para', text: 'Payment is due within thirty days.', marks: [{ t: 'b', from: 0, to: 7 }],
      notes: [{ id: 'n2', at: 14 }] },
    { id: 'l1', kind: 'ul', text: 'First point' },
    { id: 'l2', kind: 'ul', text: 'Second point, longer' },
    { id: 'h2', kind: 'h2', text: 'Notices' },
    { id: 'q', kind: 'quote', text: 'Notices are given in writing.' },
    { id: 'p3', kind: 'para', text: 'Signed on behalf of both parties.' },
  ],
  footnotes: { n1: 'Delivery is to the address on file.', n2: 'Thirty calendar days.' },
})

// ─────────────────────────────────────────────────────────── randomness

function rng(seed) {             // mulberry32: small, seedable, the same everywhere
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const WORDS = ['and', 'the', 'notice', 'x', 'clause', 'fee', 'a b', 'term', 'zq']

/**
 * An op is a class plus raw random numbers. Positions are resolved against
 * the document AT THE TIME IT RUNS, so an op list stays valid when the
 * shrinker drops ops in front of it.
 */
function genOps(seed, steps, classes) {
  const r = rng(seed)
  return Array.from({ length: steps }, () => ({
    op: classes[Math.floor(r() * classes.length)],
    r: [r(), r(), r(), r()].map((x) => Math.round(x * 1e4) / 1e4),
  }))
}

// ─────────────────────────────────────────────────────────── in the page

/** Installed once per page: picture-taking and selection helpers. */
function install() {
  const paper = document.getElementById('paper')
  const norm = (s) => s.replace(/ /g, ' ')
  const atom = (n) => n.nodeType === 1 && n.getAttribute('contenteditable') === 'false'
  /**
   * A block's text plus how it LOOKS: per run, bold / italic / underline /
   * strike as the browser computes them. Text alone misses a paste that
   * rewrites <b> as a styled span the model can't read: same letters, and the
   * bold gone from the file.
   */
  const textOf = (el) => {
    let s = '', runs = '', last = '', marks = ''
    const look = (t) => {
      let u = '', e = t.parentElement
      const cs = getComputedStyle(e)
      if (+cs.fontWeight >= 600) u += 'B'
      if (cs.fontStyle === 'italic') u += 'I'
      for (; e && e !== el.parentElement; e = e.parentElement) {
        const d = getComputedStyle(e).textDecorationLine
        if (d.includes('underline') && !u.includes('U')) u += 'U'
        if (d.includes('line-through') && !u.includes('S')) u += 'S'
      }
      return u
    }
    const walk = (n) => {
      if (n.nodeType === 3) {
        if (!n.nodeValue) return
        const u = look(n)
        if (u !== last) { runs += `${s.length}${u || '-'} `; last = u }
        s += n.nodeValue; return
      }
      if (atom(n)) { if (n.dataset.note) marks += ` ^${n.dataset.note}@${s.length}`; return }
      for (const c of n.childNodes) walk(c)
    }
    walk(el)
    // footnote markers are pictured too: a marker gone from the screen and
    // kept in the model is the same desync as a word gone
    return norm(s) + (runs.trim() && runs.trim() !== '0-' ? `  ⟨${runs.trim()}⟩` : '') + (marks ? `  [${marks.trim()}]` : '')
  }
  /** What the paper shows: blocks in order, text outside any block, duplicated ids. */
  const picture = () => {
    const els = [...paper.querySelectorAll('[data-id]')]
    const seen = new Set(), dups = []
    for (const e of els) { if (seen.has(e.dataset.id)) dups.push(e.dataset.id); seen.add(e.dataset.id) }
    const blocks = els.map((e) => [e.dataset.id, e.dataset.atomic ? '<atomic>' : textOf(e)])
    let orphan = ''
    const walk = (n) => {
      if (n.nodeType === 1 && n.dataset?.id) return
      if (n.nodeType === 3) { if (n.nodeValue.trim()) orphan += norm(n.nodeValue) + '|'; return }
      if (atom(n)) return
      for (const c of n.childNodes) walk(c)
    }
    walk(paper)
    return { blocks, orphan, dups }
  }
  const textKinds = new Set(['para', 'h1', 'h2', 'h3', 'quote', 'ul', 'ol', 'cell', 'caption'])
  /** Editable text blocks in the model: [id, length, text]. */
  const blocks = () => window.bento.doc.body.filter((b) => textKinds.has(b.kind)).map((b) => [b.id, b.text.length, norm(b.text)])
  /** The DOM point `at` characters into block `id`, atoms skipped (the editor's own rule). */
  const point = (id, at) => {
    const el = paper.querySelector(`[data-id="${CSS.escape(id)}"]`)
    if (!el) return null
    let count = 0, last = null
    const walk = (n) => {
      if (n.nodeType === 3) {
        const len = n.nodeValue.length
        if (count + len >= at) return { node: n, offset: at - count }
        count += len; last = { node: n, offset: len }; return null
      }
      if (atom(n)) return null
      for (const c of n.childNodes) { const p = walk(c); if (p) return p }
      return null
    }
    for (const c of el.childNodes) { const p = walk(c); if (p) return p }
    return last ?? { node: el, offset: 0 }
  }
  const select = (a, b, edge) => {
    // edge: the end sits on the block ELEMENT at offset 0, not in its text,
    // which is how Chrome's triple-click ends a selection
    const p = point(a[0], a[1])
    const q = edge ? { node: paper.querySelector(`[data-id="${CSS.escape(b[0])}"]`), offset: 0 } : b ? point(b[0], b[1]) : p
    if (!p || !q) return false
    paper.focus()
    const range = document.createRange()
    range.setStart(p.node, p.offset)
    range.setEnd(q.node, q.offset)
    const s = getSelection()
    s.removeAllRanges(); s.addRange(range)
    return true
  }
  const body = () => window.bento.doc.body
  const text = (id) => { const b = body().find((x) => x.id === id); return b ? norm(b.text) : null }
  const cells = () => body().filter((b) => b.kind === 'cell').map((b) => [b.id, norm(b.text)])
  /** Characters selected from a to b (block-crossing), and how many carry bold. */
  const boldOver = (a, b) => {
    const bs = body(), i = bs.findIndex((x) => x.id === a[0]), j = bs.findIndex((x) => x.id === b[0])
    let chars = 0, bold = 0
    for (let k = i; k <= j && k >= 0; k++) {
      const blk = bs[k]
      if (!textKinds.has(blk.kind)) continue
      const from = k === i ? a[1] : 0, to = k === j ? b[1] : blk.text.length
      for (let c = from; c < to; c++) {
        chars++
        if ((blk.marks ?? []).some((m) => m.t === 'b' && m.from <= c && c < m.to)) bold++
      }
    }
    return { chars, bold }
  }
  /**
   * Each text block as the model holds it: per character, the marks over it;
   * and its footnote markers with their offsets. What a join or a range edit
   * must carry along with the words. (The screen check cannot see this: both
   * of its pictures are renders of the same model.)
   */
  const shapes = () => body().filter((b) => textKinds.has(b.kind)).map((b) => ({
    id: b.id,
    chars: Array.from(b.text, (_, c) => (b.marks ?? []).filter((m) => m.from <= c && c < m.to).map((m) => m.t).sort().join('') || '-'),
    notes: (b.notes ?? []).map((n) => [n.id, n.at]).sort((x, y) => x[1] - y[1]),
  }))
  let last = JSON.stringify(body())
  /** Did the document change since the last ask? Proof that a step did something. */
  const changed = () => { const now = JSON.stringify(body()); const c = now !== last; last = now; return c }
  window.__fz = { picture, blocks, shapes, select, text, cells, boldOver, changed, rerender: () => window.bento.editor.render() }
}

// ─────────────────────────────────────────────────────────── driving

const MOD = 'ControlOrMeta'
const TABLE_LABEL = 'Table'                 // English UI: the rig's context sets no locale
const pick = (x, n) => Math.min(n - 1, Math.floor(x * n))

/**
 * Run one op. Returns what it did, for the report, and optionally an INTENT
 * check: screen == model is necessary but not enough, because a keystroke can
 * land in the wrong place on screen and in the model alike (typing after
 * Insert ▸ Table does exactly that). An intent check reads the model after the
 * step and says what is wrong, or null.
 */
async function apply(p, { op, r }) {
  const blocks = await p.evaluate(() => window.__fz.blocks())
  if (!blocks.length) return { what: `${op}: no text block` }
  const [id, len, txt] = blocks[pick(r[0], blocks.length)]
  const at = Math.round(r[1] * len)
  const word = WORDS[pick(r[2], WORDS.length)]
  const caret = async (where) => p.evaluate(([a]) => window.__fz.select(a), [where])
  const range = async (a, b) => p.evaluate(([x, y]) => window.__fz.select(x, y), [a, b])
  const textOf = (bid) => p.evaluate((x) => window.__fz.text(x), bid)
  const texts = blocks.map((b) => b[2]), idx = blocks.findIndex(([b]) => b === id)
  /** The whole document's text after this op: block k replaced by `repl`. */
  const edit = (k, n, ...repl) => { const w = texts.slice(); w.splice(k, n, ...repl); return w }
  /**
   * Intent as the WHOLE document, block by block — not just the block touched.
   * A merge that leaves its source block behind gets the merged block right
   * and is still wrong (the M6 mutant survived a one-block check).
   */
  const docIs = (want) => async () => {
    const got = (await p.evaluate(() => window.__fz.blocks())).map((b) => b[2])
    if (got.length === want.length && got.every((t, k) => t === want[k])) return null
    let k = 0
    while (k < want.length && got[k] === want[k]) k++
    return `the document should have ${want.length} blocks, block ${k} ${JSON.stringify(want[k] ?? null)}; ` +
      `it has ${got.length}, block ${k} ${JSON.stringify(got[k] ?? null)}`
  }
  const shapes = await p.evaluate(() => window.__fz.shapes())
  /**
   * Formatting and footnote markers after a join or a range edit: block i's
   * head up to `a`, `mid` new characters (formatting not judged), block j's
   * tail from `b`. A marker strictly inside the range goes; one at either end
   * stays. Every other block keeps its own shape.
   */
  const carried = (i, a, j, b, mid) => {
    const A = shapes[i], B = shapes[j]
    const one = {
      id: A.id,                 // the first block keeps its identity, as Backspace's join always did
      chars: [...A.chars.slice(0, a), ...Array(mid).fill('*'), ...B.chars.slice(b)],
      notes: [...A.notes.filter(([, x]) => x <= a), ...B.notes.filter(([, x]) => x >= b).map(([n, x]) => [n, x - b + a + mid])],
    }
    const want = shapes.slice(); want.splice(i, j - i + 1, one)
    return async () => {
      const got = await p.evaluate(() => window.__fz.shapes())
      for (let k = 0; k < Math.max(got.length, want.length); k++) {
        const g = got[k], w = want[k]
        if (!g || !w) return `block ${k}: shape ${JSON.stringify(g ?? null)}, expected ${JSON.stringify(w ?? null)}`
        if (g.id !== w.id) return `block ${k}: id ${g.id}, expected ${w.id}`
        const charsOk = g.chars.length === w.chars.length && w.chars.every((c, n) => c === '*' || c === g.chars[n])
        if (!charsOk) return `block ${k}: formatting ${g.chars.join(' ')}, expected ${w.chars.join(' ')}`
        if (JSON.stringify(g.notes) !== JSON.stringify(w.notes)) return `block ${k}: footnotes ${JSON.stringify(g.notes)}, expected ${JSON.stringify(w.notes)}`
      }
      return null
    }
  }
  /** Both checks; the first that fails is reported. */
  const all = (...checks) => async () => { for (const c of checks) { const w = await c(); if (w) return w } return null }
  /** The two block ends of a random cross-block range, in order. */
  const cross = () => {
    let i = pick(r[0], blocks.length), j = pick(r[3], blocks.length)
    if (i === j) j = i + 1 < blocks.length ? i + 1 : i - 1
    if (i > j) [i, j] = [j, i]
    return [[blocks[i][0], Math.round(r[1] * blocks[i][1])], [blocks[j][0], Math.round(r[2] * blocks[j][1])]]
  }
  switch (op) {
    case 'type': {
      await caret([id, at]); await p.keyboard.type(word)
      return { what: `type ${JSON.stringify(word)} at ${id}:${at}`,
        intent: docIs(edit(idx, 1, txt.slice(0, at) + word + txt.slice(at))) }
    }
    case 'enter': {
      if (txt[at - 1] === ' ' || txt[at] === ' ') return { what: `enter: would leave an edge space at ${id}:${at}: no-op` }
      const listExit = len === 0 && /^(ul|ol)$/.test(await p.evaluate((x) => window.bento.store.block(x)?.kind, id))
      await caret([id, at]); await p.keyboard.press('Enter')
      return { what: `Enter at ${id}:${at}`,
        intent: docIs(listExit ? texts : edit(idx, 1, txt.slice(0, at), txt.slice(at))) }
    }
    case 'backspace': {
      const k = r[3] < 0.3 ? 0 : at
      if (k > 0 && spaceLeft(txt, k - 1)) return { what: `backspace: would leave an edge or double space at ${id}:${k}: no-op` }
      const want = k > 0 ? edit(idx, 1, txt.slice(0, k - 1) + txt.slice(k))
        : idx > 0 ? edit(idx - 1, 2, texts[idx - 1] + txt) : texts
      await caret([id, k]); await p.keyboard.press('Backspace')
      return { what: `Backspace at ${id}:${k}`,
        intent: k === 0 && idx > 0 ? all(docIs(want), carried(idx - 1, blocks[idx - 1][1], idx, 0, 0)) : docIs(want) }
    }
    case 'delete': {            // forward Delete INSIDE a block (the end of a block is 'deljoin')
      if (len === 0) return { what: 'delete: empty block: no-op' }
      const k = Math.min(at, len - 1)
      if (shapes[idx].notes.some(([, x]) => x === k)) {
        // a marker right after the caret is what Delete removes, as one unit; the words stay
        await caret([id, k]); await p.keyboard.press('Delete')
        return { what: `Delete at ${id}:${k}, before a footnote marker`, intent: docIs(texts) }
      }
      if (spaceLeft(txt, k)) return { what: `delete: would leave an edge or double space at ${id}:${k}: no-op` }
      await caret([id, k]); await p.keyboard.press('Delete')
      return { what: `Delete at ${id}:${k}`, intent: docIs(edit(idx, 1, txt.slice(0, k) + txt.slice(k + 1))) }
    }
    case 'spaces': {            // split right after a space, then type at the end of the first half
      const k = txt.indexOf(' ', at) >= 0 ? txt.indexOf(' ', at) + 1 : txt.lastIndexOf(' ') + 1
      if (k <= 0) return { what: 'spaces: no space in the block: no-op' }
      const head = txt.slice(0, k)
      await caret([id, k]); await p.keyboard.press('Enter')
      await caret([id, k]); await p.keyboard.type(word)
      return { what: `Enter after the space at ${id}:${k}, type ${JSON.stringify(word)} at the end`, intent: async () => {
        const t = await textOf(id)
        return t === head + word ? null : `${id} should read ${JSON.stringify(head + word)}: ${JSON.stringify(t)}`
      } }
    }
    case 'deljoin': {           // forward Delete at the END of a block joins the next one onto it
      await caret([id, len]); await p.keyboard.press('Delete')
      return { what: `Delete at the end of ${id} (${len})`,
        intent: idx + 1 < texts.length ? all(docIs(edit(idx, 2, txt + texts[idx + 1])), carried(idx, len, idx + 1, 0, 0)) : docIs(texts) }
    }
    case 'overtype': case 'bold': {
      const a = Math.round(r[1] * len), b = Math.round(r[3] * len)
      const [from, to] = a <= b ? [a, b] : [b, a]
      if (from === to) return { what: `${op}: empty range: no-op` }
      const before = op === 'bold' ? await p.evaluate(([x, y]) => window.__fz.boldOver(x, y), [[id, from], [id, to]]) : null
      await range([id, from], [id, to])
      if (op === 'bold') {
        await p.keyboard.press(`${MOD}+b`)
        return { what: `bold ${id}:${from}-${to}`, intent: async () => {
          const after = await p.evaluate(([x, y]) => window.__fz.boldOver(x, y), [[id, from], [id, to]])
          const want = before.bold === before.chars ? 0 : after.chars
          return after.bold === want ? null : `${after.bold} of ${after.chars} selected characters bold, expected ${want}`
        } }
      }
      await p.keyboard.type(word)
      return { what: `overtype ${id}:${from}-${to} with ${JSON.stringify(word)}`,
        intent: docIs(edit(idx, 1, txt.slice(0, from) + word + txt.slice(to))) }
    }
    case 'xedge': {             // a range ending at the next block's element, offset 0 (triple-click's shape)
      const k = pick(r[0], blocks.length)
      if (k + 1 >= blocks.length) return { what: 'xedge: last block: no-op' }
      const a = Math.round(r[1] * len), want = edit(k, 2, texts[k].slice(0, a) + texts[k + 1])
      if (badSpaces(want[k])) return { what: `xedge: would leave an edge or double space: no-op` }
      await p.evaluate(([x, y]) => window.__fz.select(x, y, true), [[blocks[k][0], a], [blocks[k + 1][0], 0]])
      await p.keyboard.press('Backspace')
      return { what: `Backspace over ${blocks[k][0]}:${a}…<${blocks[k + 1][0]}>:0`,
        intent: all(docIs(want), carried(k, a, k + 1, 0, 0)) }
    }
    case 'xdelete': case 'xtype': case 'xbold': {
      if (blocks.length < 2) return { what: `${op}: one block: no-op` }
      const [a, b] = cross()
      // what the range leaves behind: the first block's head joined to the last block's tail
      const i = blocks.findIndex(([x]) => x === a[0]), j = blocks.findIndex(([x]) => x === b[0])
      const joined = (mid) => edit(i, j - i + 1, texts[i].slice(0, a[1]) + mid + texts[j].slice(b[1]))
      if (op !== 'xbold' && badSpaces(joined(op === 'xtype' ? word : '')[i])) {
        return { what: `${op}: would leave an edge or double space at ${a.join(':')}…${b.join(':')}: no-op` }
      }
      const before = op === 'xbold' ? await p.evaluate(([x, y]) => window.__fz.boldOver(x, y), [a, b]) : null
      await range(a, b)
      const span = `${a.join(':')}…${b.join(':')}`
      if (op === 'xdelete') { await p.keyboard.press('Backspace'); return { what: `Backspace over ${span}`, intent: all(docIs(joined('')), carried(i, a[1], j, b[1], 0)) } }
      if (op === 'xtype') { await p.keyboard.type(word); return { what: `type ${JSON.stringify(word)} over ${span}`, intent: all(docIs(joined(word)), carried(i, a[1], j, b[1], word.length)) } }
      await p.keyboard.press(`${MOD}+b`)
      return { what: `bold over ${span}`, intent: async () => {
        const after = await p.evaluate(([x, y]) => window.__fz.boldOver(x, y), [a, b])
        // a toggle: all bold afterwards, unless it was all bold before
        const want = before.bold === before.chars ? 0 : after.chars
        return after.bold === want ? null : `${after.bold} of ${after.chars} selected characters bold, expected ${want}`
      } }
    }
    case 'selall': {            // Select All, then type: the whole document becomes the typed word
      await caret([id, at]); await p.keyboard.press(`${MOD}+a`); await p.keyboard.type(word)
      return { what: `Select All, type ${JSON.stringify(word)}`,
        intent: all(docIs([word]), carried(0, 0, blocks.length - 1, blocks[blocks.length - 1][1], word.length)) }
    }
    case 'paste1': case 'pastesp': case 'pasteN': {
      const text = op === 'pasteN' ? `one ${word}\ntwo\nthree` : `pasted ${word}`
      let k = at
      if (op === 'paste1' && txt[at] === ' ') return { what: `paste1: right before a space at ${id}:${at} (that is 'pastesp'): no-op` }
      if (op === 'pastesp') {
        k = txt.indexOf(' ', at) >= 0 ? txt.indexOf(' ', at) : txt.indexOf(' ')
        if (k < 0) return { what: 'pastesp: no space in the block: no-op' }
      }
      await caret([id, k]); await paste(p, text)
      return { what: `paste ${JSON.stringify(text)} at ${id}:${k}`,
        intent: op === 'pasteN' ? null : docIs(edit(idx, 1, txt.slice(0, k) + text + txt.slice(k))) }
    }
    case 'undo': await caret([id, at]); await p.keyboard.press(`${MOD}+z`); return { what: 'undo' }
    case 'redo': await caret([id, at]); await p.keyboard.press(`${MOD}+Shift+z`); return { what: 'redo' }
    case 'undoredo': {          // ⌘Z then ⇧⌘Z gives back exactly the document you had
      const body = () => p.evaluate(() => JSON.stringify(window.bento.doc.body))
      // with nothing to undo, ⌘Z does nothing and ⇧⌘Z replays a pending redo — correctly
      if (!(await p.evaluate(() => window.bento.store.canUndo))) return { what: 'undoredo: nothing to undo: no-op' }
      const before = await body()
      await caret([id, at]); await p.keyboard.press(`${MOD}+z`); await p.keyboard.press(`${MOD}+Shift+z`)
      return { what: 'undo, redo', intent: async () => (await body()) === before ? null : 'undo then redo changed the document' }
    }
    case 'table': {
      // the real path: the Insert button, then its Table row, with the mouse
      const cellsBefore = await p.evaluate(() => window.__fz.cells())
      await caret([id, at])
      await p.click('#insertMenuBtn')
      await p.locator('#gInsert .t-menu button', { hasText: TABLE_LABEL }).click()
      await p.keyboard.type(word)
      return { what: `Insert ▸ Table at ${id}:${at}, type ${JSON.stringify(word)}`, intent: async () => {
        const fresh = (await p.evaluate(() => window.__fz.cells())).filter(([c]) => !cellsBefore.some(([o]) => o === c))
        return fresh[0]?.[1] === word ? null
          : `the new table's first cell should hold ${JSON.stringify(word)}: ${JSON.stringify(fresh[0]?.[1] ?? 'no new cell')}`
      } }
    }
    default: throw new Error(`unknown op ${op}`)
  }
}

/**
 * A real paste: the system clipboard, then the paste shortcut. The browser
 * does its own default insertion (bento/type has no paste handler), which is
 * exactly what a user gets.
 */
async function paste(p, text) {
  await p.evaluate((t) => navigator.clipboard.writeText(t), text)
  await p.keyboard.press(`${MOD}+v`)
}

/**
 * Would deleting the character at k leave a space at either edge of the
 * block, or two in a row? The paper collapses those (see BROKEN.spaces), so
 * the HOLDS ops steer around them; the 'spaces' class tests them head on.
 */
function spaceLeft(t, k) {
  return badSpaces(t.slice(0, k) + t.slice(k + 1))
}
const badSpaces = (t) => t.startsWith(' ') || t.endsWith(' ') || t.includes('  ')

const frame = (p) => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())))

/** Compare the screen with a render of the model. Returns null, or what differs. */
async function compare(p) {
  const screen = await p.evaluate(() => window.__fz.picture())
  await p.evaluate(() => window.__fz.rerender())
  const model = await p.evaluate(() => window.__fz.picture())
  const diffs = []
  if (screen.dups.length) diffs.push(`duplicate block ids on screen: ${screen.dups.join(', ')}`)
  if (screen.orphan) diffs.push(`text outside any block on screen: ${JSON.stringify(screen.orphan)}`)
  const n = Math.max(screen.blocks.length, model.blocks.length)
  for (let i = 0; i < n; i++) {
    const s = screen.blocks[i], m = model.blocks[i]
    if (!s || !m || s[0] !== m[0] || s[1] !== m[1]) {
      diffs.push(`block ${i}: screen ${JSON.stringify(s ?? null)} ≠ model ${JSON.stringify(m ?? null)}`)
      if (diffs.length > 4) break
    }
  }
  return diffs.length ? diffs : null
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })
await ctx.route(/^(https?|wss?):/, (r) => r.abort())

/**
 * The seed document as a FILE: the shell with the seed spliced into its
 * #bento-doc block, exactly as a saved document carries it. Loading it with
 * `loadDoc` instead would leave the sample document one ⌘Z behind every run,
 * and the fuzz's undo would walk into it.
 */
const tmp = mkdtempSync(join(tmpdir(), 'bento-type-fuzz-'))
async function seedFile(seed = seedDoc(), name = 'seed') {
  const p = await ctx.newPage()
  await p.goto(SHELL)
  await p.waitForFunction(() => window.bento?.editor && window.bento?.doc)
  const doc = await p.evaluate((d) => {
    const doc = JSON.parse(JSON.stringify(window.bento.doc))
    delete doc.collab                          // dormant: a seed never joins a relay
    return Object.assign(doc, d)
  }, seed)
  await p.close()
  const html = readFileSync(SHELL.startsWith('file:') ? fileURLToPath(SHELL) : SHELL, 'utf8')
  const block = '<script type="application/bento+json" id="bento-doc"></script>'
  if (!html.includes(block)) throw new Error('the shell has no empty #bento-doc block to seed')
  const json = JSON.stringify(doc).replace(/</g, '\\u003c')
  const file = join(tmp, `${name}.bento.html`)
  writeFileSync(file, html.replace(block, () => block.replace('></', `>${json}</`)))
  return pathToFileURL(file).href
}
let SEEDED

/** A booted page holding the seed document, with no undo history behind it. */
async function boot(url = SEEDED) {
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(url)
  await p.waitForFunction(() => window.bento?.editor && window.bento?.doc)
  const title = await p.evaluate(() => window.bento.doc.title)
  if (title !== 'Fuzz') throw new Error(`the seed document did not load (title ${JSON.stringify(title)})`)
  await p.evaluate(install)
  if (url !== SEEDED) return { p, errors }
  // the seed's marks must survive parseDoc and show, or every formatting check is vacuous
  const looks = await p.evaluate(() => window.__fz.picture().blocks.filter(([id]) => id === 'p1' || id === 'p2').map((b) => b[1]))
  if (!/⟨.*I.*U.*⟩/.test(looks[0] ?? '') || !/⟨0B /.test(looks[1] ?? '')) {
    throw new Error(`the seed document's formatting did not render: ${JSON.stringify(looks)}`)
  }
  return { p, errors }
}

/**
 * Run an op list from a fresh boot. Stops at the first divergence (the state
 * after it is already corrupt) and says where.
 */
const tally = { steps: 0, edits: 0 }    // fuzz steps run, and how many changed the document
async function run(ops, { log = false, count = false } = {}) {
  const { p, errors } = await boot()
  try {
    const first = await compare(p)
    if (first) return { step: -1, what: 'seed document', diffs: first }
    for (let i = 0; i < ops.length; i++) {
      const { what, intent } = await apply(p, ops[i])
      await frame(p)
      if (log) console.log(`        ${i}: ${what}`)
      if (process.env.FUZZ_DUMP) console.log('          ' + JSON.stringify(await p.evaluate(() => ({
        model: window.bento.doc.body.map((b) => [b.id, b.kind, b.text]),
        dom: [...document.querySelectorAll('#paper [data-id]')].map((e) => [e.dataset.id, e.tagName, e.textContent]),
        undo: window.bento.store.undoDepth }))))
      const diffs = await compare(p)
      if (errors.length) return { step: i, what, diffs: [`page error: ${errors.join(' | ')}`] }
      if (diffs) return { step: i, what, diffs }
      const wrong = intent && await intent()
      if (wrong) return { step: i, what, diffs: [`intent: ${wrong}`] }
      if (count) {
        tally.steps++
        if (await p.evaluate(() => window.__fz.changed())) tally.edits++
      }
    }
    return null
  } finally {
    await p.close()
  }
}

/** Drop ops one at a time while the run still diverges; at most `budget` runs. */
async function shrink(ops, budget = 30) {
  let cur = ops
  for (let i = cur.length - 2; i >= 0 && budget > 0; i--, budget--) {
    const trial = cur.filter((_, k) => k !== i)
    if (await run(trial)) cur = trial
  }
  return cur
}

/**
 * Print a failure, shrunk. Shrinking replays the run up to 30 times, so only
 * the first failure in a pass is shrunk: a regression that breaks every seed
 * must still finish inside the CI job's timeout. The rest print their step and
 * a full-prefix replay.
 */
let shrunk = false
async function report(label, ops, fail, { always = false } = {}) {
  console.log(`        ${label}: step ${fail.step} (${fail.what})`)
  for (const d of fail.diffs) console.log(`          ${d}`)
  if (shrunk && !always) {
    console.log(`        replay: FUZZ_REPLAY='${JSON.stringify(ops.slice(0, fail.step + 1))}'`)
    return
  }
  shrunk = true
  const min = await shrink(ops.slice(0, fail.step + 1))
  const again = await run(min)
  console.log(`        minimal (${min.length} op${min.length === 1 ? '' : 's'}): FUZZ_REPLAY='${JSON.stringify(min)}'`)
  if (again) for (const d of again.diffs.slice(0, 2)) console.log(`          ${d}`)
}

// ─────────────────────────────────────────────────────────── the runs

try {
  SEEDED = await seedFile()
  // The clipboard path is part of what is tested; say so if it is not there.
  {
    const { p } = await boot()
    const clip = await p.evaluate(() => navigator.clipboard.writeText('probe').then(() => true, (e) => String(e)))
    ok(clip === true, `the system clipboard is writable for real paste (${clip})`)
    await p.close()
  }

  if (process.env.FUZZ_REPLAY) {
    const ops = JSON.parse(process.env.FUZZ_REPLAY)
    console.log(`replay of ${ops.length} op(s):`)
    const fail = await run(ops, { log: true })
    if (fail) for (const d of fail.diffs) console.log(`          ${d}`)
    ok(!fail, fail ? `the replay diverges at step ${fail.step} (${fail.what})` : 'the replay keeps screen and model equal')
  } else if (process.env.FUZZ_OPS) {
    const classes = process.env.FUZZ_OPS.split(',').map((s) => s.trim()).filter(Boolean)
    for (const c of classes) if (!HOLDS.includes(c) && !(c in BROKEN)) throw new Error(`unknown op class ${c}`)
    console.log(`fuzz over ${classes.join(', ')}: ${SEEDS} seeds × ${STEPS} steps from seed ${SEED0}`)
    for (let s = SEED0; s < SEED0 + SEEDS; s++) {
      const ops = genOps(s, STEPS, classes)
      const fail = await run(ops)
      if (fail) await report(`seed ${s}`, ops, fail)
      ok(!fail, `seed ${s}: screen == model, every intent met, over ${STEPS} steps`)
    }
  } else {
    // 1. HOLDS: everything the editor already handles, mixed, must be clean.
    console.log(`HOLDS fuzz (${HOLDS.join(', ')}): ${SEEDS} seeds × ${STEPS} steps from seed ${SEED0}`)
    for (let s = SEED0; s < SEED0 + SEEDS; s++) {
      const ops = genOps(s, STEPS, HOLDS)
      const fail = await run(ops, { count: true })
      if (fail) await report(`seed ${s}`, ops, fail)
      ok(!fail, `seed ${s}: screen == model, every intent met, over ${STEPS} steps`)
    }

    // The fuzz is only evidence if its steps edited something. Most do; undo
    // with nothing to undo, or bold toggled twice, legitimately do not.
    ok(tally.steps > 0 && tally.edits >= tally.steps / 2,
      `the HOLDS steps ran and edited the document (${tally.edits} of ${tally.steps} steps changed it)`)

    // Select All over a document that starts or ends with a table: Chrome puts
    // that end of the selection on the paper itself, between blocks, which no
    // fuzz step reaches. The cells stay, emptied (a range never fuses a cell
    // into a paragraph); the typed word lands in the first text block.
    const cell = (id, head) => ({ id, kind: 'cell', text: `cell ${id}`, cell: { table: 't1', cols: 2, ...(head ? { head: true } : {}) } })
    for (const [name, body, want] of [
      ['table last', [{ id: 'a', kind: 'para', text: 'Before the table' }, cell('c1', 1), cell('c2', 1), cell('c3'), cell('c4')], ['zq', '', '', '', '']],
      ['table first', [cell('c1', 1), cell('c2', 1), { id: 'a', kind: 'para', text: 'After the table' }], ['zq', '', '']],
    ]) {
      const { p, errors } = await boot(await seedFile({ title: 'Fuzz', body }, name.replace(' ', '-')))
      const edge = await p.evaluate(() => { window.__fz.select([window.bento.doc.body[0].id, 0]); return true })
      await p.keyboard.press(`${MOD}+a`)
      const onPaper = await p.evaluate(() => { const r = getSelection().getRangeAt(0); return r.startContainer.id === 'paper' || r.endContainer.id === 'paper' })
      await p.keyboard.type('zq'); await frame(p)
      const diffs = await compare(p)
      const got = (await p.evaluate(() => window.__fz.blocks())).map((b) => b[2])
      ok(edge && onPaper && !diffs && !errors.length && JSON.stringify(got) === JSON.stringify(want),
        `Select All with the ${name}, type: ${onPaper ? 'an end on the paper' : 'NO end on the paper (the row no longer tests that)'}; ` +
        `${diffs ? diffs.join('; ') : errors.length ? errors.join(' | ') : `document ${JSON.stringify(got)}${JSON.stringify(got) === JSON.stringify(want) ? '' : `, expected ${JSON.stringify(want)}`}`}`)
      await p.close()
    }

    // Comment threads through a range delete: one before the range stays, one
    // after it moves onto the surviving block with its words, one on deleted
    // text or on a block that goes is detached (orphan) — and one ⌘Z puts back
    // the blocks and every thread exactly.
    {
      const th = (id, block, from, to) => ({ id, block, from, to, quote: '', messages: [{ id: `${id}m`, author: 'A', at: '2026-11-08T00:00:00Z', text: id }] })
      const body = [{ id: 'a', kind: 'para', text: 'Alpha beta gamma' }, { id: 'm', kind: 'para', text: 'Middle text' }, { id: 'c', kind: 'para', text: 'Delta epsilon zeta' }]
      const comments = { head: th('head', 'a', 0, 5), mid: th('mid', 'm', 0, 6), tail: th('tail', 'c', 14, 18), cut: th('cut', 'c', 0, 5) }
      const { p, errors } = await boot(await seedFile({ title: 'Fuzz', body, comments }, 'comments'))
      const state = () => p.evaluate(() => JSON.stringify({ body: window.bento.doc.body.map((b) => [b.id, b.text]),
        threads: Object.values(window.bento.doc.comments ?? {}).map((t) => [t.id, t.block, t.from, t.to, !!t.orphan]).sort() }))
      const before = await state()
      await p.evaluate(() => window.__fz.select(['a', 6], ['c', 6]))
      await p.keyboard.press('Backspace'); await frame(p)
      const after = JSON.parse(await state())
      const want = { body: [['a', 'Alpha epsilon zeta']],
        threads: [['cut', 'c', 0, 5, true], ['head', 'a', 0, 5, false], ['mid', 'm', 0, 6, true], ['tail', 'a', 14, 18, false]] }
      ok(JSON.stringify(after) === JSON.stringify(want) && !errors.length,
        `comment threads through a range delete: ${JSON.stringify(after)}${JSON.stringify(after) === JSON.stringify(want) ? '' : `, expected ${JSON.stringify(want)}`}`)
      await p.keyboard.press(`${MOD}+z`); await frame(p)
      const undone = await state()
      ok(undone === before, `one ⌘Z restores the blocks and every thread${undone === before ? '' : `: ${undone}, expected ${before}`}`)
      await p.close()
    }

    // 2. BROKEN: each known divergence is still caught. Mixed with typing so a
    //    found case is a realistic one; a few short seeds are plenty.
    console.log('BROKEN (positive control: each must still be caught, minimal case shown)')
    for (const [cls, why] of Object.entries(BROKEN)) {
      let found = null
      for (let s = 1; s <= 6 && !found; s++) {
        const ops = genOps(1000 + s, 8, [cls, cls, 'type'])
        const fail = await run(ops)
        if (fail) { found = fail; await report(`${cls} seed ${1000 + s}`, ops, fail, { always: true }) }
      }
      ok(!!found, found
        ? `${cls} still diverges — ${why}`
        : `${cls} no longer diverges — ${why}. Fixed? Move '${cls}' from BROKEN to HOLDS in this rig, in the same PR`)
    }
  }
} finally {
  await browser.close()
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
