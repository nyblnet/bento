#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The code-morph identity engine, held to its answers.
//
//   node scripts/test-codediff.ts
//
// WHAT THIS PROVES. HeckelDiff decides WHICH token on slide N is the same
// token as on slide N-1; every wrong answer is a token that jumps, tears, or
// steals another token's journey on screen. Each case here is either a bug
// found during the #259 review (kept as a regression) or an invariant the
// renderer builds on.

import { HeckelDiff, type State, type Match } from '../slides/src/diff.ts'

const FAILS: string[] = []
const check = (name: string, cond: boolean) => {
  if (!cond) FAILS.push(name)
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`)
}

/** A minimal doc: one code element per slide, all in one morph group. */
const codeDoc = (contents: Array<string | null>, lang = 'js') => ({
  slides: contents.map((content, i) => ({
    id: `s${i}`,
    elements: content === null ? [] : [{
      type: 'code', id: `c${i}`, morphId: 'g', content, grammarName: lang,
    }],
  })),
}) as any

const idsOf = (states: State[] | undefined) =>
  (states ?? []).filter((s) => s.kind !== 'empty').map((s: any) =>
    (s.kind === 'match' ? s.current : s.token).morphId())
const toksOf = (states: State[] | undefined) =>
  (states ?? []).filter((s) => s.kind !== 'empty').map((s: any) =>
    (s.kind === 'match' ? s.current : s.token))

// 1. LOSSLESS THROUGH THE ADAPTER — the rendered text is rebuilt from these
//    tokens, multiline splitting included.
{
  const src = `function f() {\n  /* multi\n  line\n  comment */\n  x = '''nope'''\n}`
  const doc = codeDoc([src])
  const states = new HeckelDiff(doc).computeDiffs('g')
  const rebuilt = toksOf(states.get(0)).map((t: any) => t.content).join('')
  check('adapter is lossless (multiline comment split included)', rebuilt === src)
  check('no ink token carries a newline after splitting',
    toksOf(states.get(0)).every((t: any) => !/\S/.test(t.content) || !t.content.includes('\n')))
}

// 2. SLIDE 0 GETS IDS — zipIndex results were checked by truthiness, and
//    index 0 is falsy: a group starting on the deck's first slide got nothing.
{
  const states = new HeckelDiff(codeDoc(['a()', 'a()\nb()'])).computeDiffs('g')
  check('a group starting on slide 0 gets ids', idsOf(states.get(0)).every(Boolean))
  const id0 = idsOf(states.get(0))
  const id1 = idsOf(states.get(1))
  check('slide 0 ids carry into slide 1', id0.length > 0 && id0.every((id) => id1.includes(id)))
}

// 3. NO DOUBLE CLAIM — duplicating a token beside an anchor (X B Y -> X B B Y)
//    let the backward pass claim one previous token twice: two current-side
//    tokens shared one morph id. Verified live against the pre-fix engine.
{
  const states = new HeckelDiff(codeDoc(['X\nB\nY', 'X\nB\nB\nY'])).computeDiffs('g')
  const after = idsOf(states.get(1))
  check('duplicating a line yields no duplicate ids', new Set(after).size === after.length)
}

// 4. ODD REPEATS ARE NOT ANCHORS — the old add/delete counting re-added a key
//    on its third occurrence, making it a false "unique" anchor. Three
//    close-parens are enough. Observable invariant: ids stay unique per slide
//    and every previous-side id claimed on the current side exists.
{
  const A = `a()\nb()\nc()`      // ')' appears 3x, '(' 3x
  const B = `c()\na()\nb()`
  const states = new HeckelDiff(codeDoc([A, B])).computeDiffs('g')
  const after = idsOf(states.get(1))
  check('odd-repeat punctuation causes no duplicate ids', new Set(after).size === after.length)
  // the three call names are unique anchors and must keep their ids
  const names = ['a', 'b', 'c']
  const t0 = toksOf(states.get(0)), t1 = toksOf(states.get(1))
  check('moved lines keep their identities', names.every((n) => {
    const before = t0.find((t: any) => t.content === n)
    const moved = t1.find((t: any) => t.content === n)
    return before && moved && before.morphId() === moved.morphId()
  }))
}

// 5. RENAME — unchanged tokens keep ids; the renamed token is genuinely new.
{
  const states = new HeckelDiff(codeDoc(['const total = sum(xs)\nreturn total',
                                         'const acc = sum(xs)\nreturn acc'])).computeDiffs('g')
  const t0 = toksOf(states.get(0)), t1 = toksOf(states.get(1))
  const keep = ['const', 'sum', 'xs', 'return']
  check('rename: unchanged tokens keep ids', keep.every((n) => {
    const a = t0.find((t: any) => t.content === n)
    const b = t1.find((t: any) => t.content === n)
    return a && b && a.morphId() === b.morphId()
  }))
  const acc = t1.filter((t: any) => t.content === 'acc')
  check('rename: the new name has fresh ids', acc.every((t: any) =>
    !t0.some((p: any) => p.morphId() === t.morphId())))
}

// 6. PERSISTENCE ACROSS THE CHAIN — a token surviving three slides keeps one
//    id the whole way; a slide with no code in the group does not break it.
{
  const states = new HeckelDiff(codeDoc(['f(x)', 'f(x)\ng(y)', null, 'g(y)\nf(x)'])).computeDiffs('g')
  const at = (i: number, name: string) =>
    toksOf(states.get(i)).find((t: any) => t.content === name)?.morphId()
  check('id survives slides 0 -> 1 -> 3 (2 has no code)',
    at(0, 'f') !== undefined && at(0, 'f') === at(1, 'f') && at(1, 'f') === at(3, 'f'))
}

// 7. DETERMINISM — same input, same ids: canvas, thumbnails and present must
//    agree without sharing state.
{
  const doc = codeDoc(['a()\nb()', 'b()\na()'])
  const one = new HeckelDiff(doc).computeDiffs('g')
  const two = new HeckelDiff(doc).computeDiffs('g')
  check('two independent runs agree exactly',
    JSON.stringify([...one.entries()].map(([k, v]) => [k, idsOf(v)])) ===
    JSON.stringify([...two.entries()].map(([k, v]) => [k, idsOf(v)])))
}

// 8. SHARED-PREFIX SWAP — the case greedy spreading lost. Two lines starting
//    with `const` trade places; each const must travel WITH ITS LINE, claimed
//    by the anchor two steps away (b / a), not by the header cascade three
//    steps above. Regression for the breadth-first spread: before it, one
//    const paired top-to-top and the other was minted fresh — it vanished for
//    40% of the morph and faded back in, on screen.
{
  const A = `function f() {\n  const a = one()\n  const b = two()\n  done()\n}`
  const B = `function f() {\n  const b = two()\n  const a = one()\n  done()\n}`
  const states = new HeckelDiff(codeDoc([A, B])).computeDiffs('g')
  const consts = (i: number) => toksOf(states.get(i))
    .filter((t: any) => t.content === 'const')
    .sort((a: any, b: any) => a.lineNumber - b.lineNumber)
  const [p1, p2] = consts(0)
  const [c1, c2] = consts(1)
  check('shared-prefix swap: both consts pair', !!c1?.morphId() && !!c2?.morphId())
  check('shared-prefix swap: each const travels with its line',
    c1.morphId() === p2.morphId() && c2.morphId() === p1.morphId())
  const inserts = (states.get(1) ?? []).filter((s: any) => s.kind === 'insert')
    .map((s: any) => s.token.content)
  check('shared-prefix swap: no ink token is minted fresh',
    inserts.every((v: string) => !/\S/.test(v)))
}

// 9. A WORD THAT CHANGES CLASS KEEPS ITS IDENTITY — `render(` is classed a
//    call, `.then(render)` a plain reference. The tokenizer flips the class
//    exactly when a refactor changes style, so keying identity on the class
//    made the word die and respawn instead of travelling. The audience pairs
//    tokens by their glyphs; the key buckets call/identifier together and
//    rendering still colours by the true class.
{
  const states = new HeckelDiff(codeDoc(['render(deck)\nship()', 'queue(render)\nship()'])).computeDiffs('g')
  const t0 = toksOf(states.get(0)), t1 = toksOf(states.get(1))
  const a = t0.find((t: any) => t.content === 'render')
  const b = t1.find((t: any) => t.content === 'render')
  check('call -> plain reference keeps identity', !!a && !!b && a.morphId() === b.morphId())
}

console.log(FAILS.length ? `\n${FAILS.length} FAILED` : '\nall passed')
process.exit(FAILS.length ? 1 : 0)
