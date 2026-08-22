#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The bento/spaces agent surface: validate() and the seven patch verbs.
//
//   node scripts/test-spaces-agent.ts
//
// WHY THIS EXISTS. `spaces/src/agent.ts` is ~900 lines and shipped with ZERO
// automated coverage — the slides validator has its own rig, and the spaces
// model rig never imported this file. Two of the five defects an adversarial
// review found in round 2 were in here, including a page-cycle walk that hung
// the tab forever, and both were found by a person reading code rather than by
// anything that runs.
//
// WHAT IS WORTH ASSERTING, and what is not:
//
//  · validate() is only useful if it is TRUSTED, and trust is destroyed by
//    false positives, not by misses. An agent that gets warnings for good
//    documents learns to ignore warnings — so "silent on documents that are
//    unusual but CORRECT" matters more here than any single check firing.
//
//  · The patch verbs are an API other code will be built on. Each one must
//    refuse a read-only document, refuse input it cannot honour, and — the
//    thing that actually bites — never produce a document THIS BUILD COULD NOT
//    HAVE PRODUCED ITSELF: no unsanitized html, no duplicate ids, no parent
//    cycles, no block parented across pages.
//
//  · Termination. A walk over author-supplied parent links must end. The
//    review found one that did not, and `parseDoc` preserves the cycle that
//    triggers it, so it arrives from any hand-edited or mailed file.
//
// These run in node against the real modules. agent.ts is DOM-free by
// construction (it plans mutations; the editor applies them), which is what
// makes this rig possible at all — and is worth preserving.

import { parseDoc, buildIndex, FORMAT, type SpacesDoc } from '../spaces/src/model.ts'
import { starterDoc } from '../spaces/src/starter.ts'
import {
  validateDoc, outlineDoc, statsDoc,
  planInsertBlocks, planUpdateBlock, planRemoveBlocks, planMoveBlock,
  planUpdatePage, planRemovePage,
  fieldsReport, issuesReport, planSetField, planNewIssue, commentsReport,
} from '../spaces/src/agent.ts'
import { DEFAULT_FIELDS, ISSUE_FIELDS, propHtml, isIssue, valuesOf, columnMoves } from '../spaces/src/fields.ts'

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

/** A document, through the real loader, so ids and defaults are real. */
function load(pages: unknown[], extra: Record<string, unknown> = {}): SpacesDoc {
  const r = parseDoc(JSON.stringify({
    format: FORMAT, version: 1, docId: 'test', title: 'Test', home: (pages[0] as { id: string })?.id,
    theme: { background: '#fff', color: '#1E2A3A', accent: '#F7A600', measure: 720 },
    pages, ...extra,
  }))
  if (!r.ok) throw new Error('fixture did not parse')
  return r.doc
}

const p = (id: string, blocks: unknown[], extra: Record<string, unknown> = {}) =>
  ({ id, title: id, blocks, ...extra })
const b = (id: string, type = 'p', extra: Record<string, unknown> = {}) =>
  ({ id, type, html: `text ${id}`, ...extra })

/** Apply a plan the way main.ts's run() does, so the test exercises the real path. */
function apply<T extends object>(plan: ReturnType<typeof planInsertBlocks> | any): any {
  if (!plan.ok) return plan
  const { apply: fn, ...rest } = plan
  fn()
  return rest
}

console.log('bento/spaces agent surface\n')

// ---- validate() is SILENT on documents that are correct --------------------
// The failure mode that makes a validator worthless is the false positive.
{
  const starter = starterDoc()
  const v = validateDoc(starter as unknown as SpacesDoc)
  ok(v.findings.length === 0,
    `the shipped starter space is clean (${v.findings.length} finding(s): ${v.findings.map((f) => f.code).join(', ')})`)

  // unusual, but perfectly legal documents
  const odd: Array<[string, SpacesDoc]> = [
    ['a page holding only an image', load([p('p1', [b('b1', 'image', { src: 'asset:k', alt: 'a photo', w: 10, h: 10 })])], { assets: { k: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' } })],
    ['a single empty paragraph', load([p('p1', [{ id: 'b1', type: 'p', html: '' }])])],
    ['a deeply nested toggle', load([p('p1', [
      b('t1', 'toggle', { open: true }), b('t2', 'toggle', { open: true, parent: 't1' }), b('b3', 'p', { parent: 't2' }),
    ])])],
    ['an unknown block type from a newer build', load([p('p1', [b('b1', 'somethingnew')])])],
    ['a page with no children and no links', load([p('p1', [b('b1')]), p('p2', [b('b2')])])],
  ]
  for (const [label, doc] of odd) {
    const r = validateDoc(doc)
    const errs = r.findings.filter((f) => f.severity === 'error')
    ok(errs.length === 0, `${label}: no ERRORS (${errs.map((f) => f.code).join(', ') || 'none'})`)
  }

  // …and a 500-page space is not itself a problem
  const many = load(Array.from({ length: 500 }, (_, i) => p(`p${i}`, [b(`b${i}`)])))
  const big = validateDoc(many)
  ok(big.findings.filter((f) => f.severity === 'error').length === 0,
    'a 500-page space raises no errors')
}

// ---- the starter space SHOWS the tracker ----------------------------------
// A feature nothing in the starter demonstrates is a feature nobody finds. The
// tracker shipped invisible: a fresh space opened on the notes tour, and the
// board, the fields and ⌘⇧I existed only for someone who already knew to look.
// Asserted structurally, because the way this regresses is silent — a starter
// edited for prose, with the demo quietly dropped.
{
  const starter = starterDoc() as unknown as SpacesDoc
  const issues = starter.pages.filter((pg) => isIssue(pg as never))
  const boards = starter.pages.flatMap((pg) => pg.blocks.filter((bl) => bl.type === 'view'))

  ok(boards.length >= 1, `the starter carries a board (${boards.length} view block(s))`)
  ok(issues.length >= 3, `…with issues on it (${issues.length})`)
  ok(new Set(issues.map((pg) => String(valuesOf(pg as never).get('status')))).size >= 3,
    'the demo issues span several columns — a one-column board demonstrates nothing')

  // every value on them has to be one the schema declares: a starter issue
  // carrying a status no option matches renders an empty pill and teaches the
  // format wrong on the one document everybody reads first
  const opts = new Map(DEFAULT_FIELDS.map((f) => [f.key, new Set((f.options ?? []).map((o) => o.id))]))
  const strays = issues.flatMap((pg) => [...valuesOf(pg as never)]
    .filter(([k, v]) => opts.get(k)?.size && v !== '' && !opts.get(k)!.has(String(v)))
    .map(([k, v]) => `${pg.title}: ${k}=${String(v)}`))
  ok(strays.length === 0, `every starter value is in the schema (${strays.join('; ') || 'all good'})`)

  // and the readable `html` matches the value — the pairing the whole format
  // degrades through, generated here rather than typed out
  const mismatched = issues.flatMap((pg) => pg.blocks
    .filter((bl) => bl.type === 'prop')
    .filter((bl) => {
      const f = DEFAULT_FIELDS.find((x) => x.key === (bl as { key?: string }).key)
      return !f || bl.html !== propHtml(f, (bl as { value?: unknown }).value)
    })
    .map((bl) => `${pg.title}/${(bl as { key?: string }).key}`))
  ok(mismatched.length === 0, `every starter prop's html matches its value (${mismatched.join(', ') || 'all good'})`)

  // an issue is REACHABLE — a card opens the page, and the sidebar shows it
  // where the board says it is
  ok(issues.every((pg) => !!pg.parent && starter.pages.some((q) => q.id === pg.parent)),
    'every starter issue is nested under a page that exists')
}

// ---- the starter is DETERMINISTIC -----------------------------------------
// Ids here are CRDT node keys, not tidiness. Two people opening the shipped
// file have to agree on every one of them, and `starterDoc()` mints them from
// a counter — so anything that reads the clock, calls uid() or depends on an
// iteration order gives two readers two documents that look identical and
// cannot merge. Compared as JSON because that is exactly what gets saved.
{
  ok(JSON.stringify(starterDoc()) === JSON.stringify(starterDoc()),
    'starterDoc() emits the same document twice, byte for byte')
}

// ---- the starter's own links all land -------------------------------------
// The starter is the one document nobody proof-reads twice, and every defect in
// it ships to every new user. validate() covers broken links and dead hrefs
// already; these are the structural invariants it does NOT check.
{
  const starter = starterDoc() as unknown as SpacesDoc
  const byId = new Map(starter.pages.map((pg) => [pg.id, pg]))

  // PRE-ORDER, not merely "the parent exists": a child that precedes its parent
  // in doc.pages breaks the invariant the sidebar, the export and the journal
  // insertion all rest on.
  const seen = new Set<string>()
  const badParents: string[] = []
  for (const pg of starter.pages) {
    const parent = (pg as { parent?: string }).parent
    if (parent && !seen.has(parent)) badParents.push(`${pg.title} → ${parent}`)
    seen.add(pg.id)
  }
  ok(badParents.length === 0,
    `every page's parent exists and comes before it (${badParents.join('; ') || 'all good'})`)

  // and no page is stranded: walking parents from anywhere reaches a root
  const orphans = starter.pages.filter((pg) => {
    let cur: string | undefined = (pg as { parent?: string }).parent
    for (let i = 0; cur && i < starter.pages.length; i++) {
      const up: unknown = byId.get(cur)
      if (!up) return true
      cur = (up as { parent?: string }).parent
    }
    return !!cur
  })
  ok(orphans.length === 0, `no starter page is orphaned (${orphans.map((pg) => pg.title).join(', ') || 'all reachable'})`)

  // every `#p/` href and every pagelink card lands on a page that is here
  const dead: string[] = []
  for (const pg of starter.pages) {
    for (const bl of pg.blocks) {
      for (const m of String(bl.html ?? '').matchAll(/href="#p\/([^"]+)"/g)) {
        const raw = m[1]
        const cut = raw.lastIndexOf('/')
        const target = byId.has(raw) || cut <= 0 ? raw : raw.slice(0, cut)
        if (!byId.has(target)) dead.push(`${pg.title}: #p/${raw}`)
      }
      if (bl.type === 'pagelink' && !byId.has(String((bl as { page?: unknown }).page))) {
        dead.push(`${pg.title}: pagelink → ${String((bl as { page?: unknown }).page)}`)
      }
    }
  }
  ok(dead.length === 0, `every starter link resolves (${dead.join('; ') || 'all good'})`)

  // …and the ones the starter CLAIMS produce backlinks actually do. The table
  // on "Tables, pictures and clips" says its link shows up in Writing's
  // "Linked from", which is only true because the table went through
  // writeTable and its fallback html carries the cell's link: a hand-written
  // `rows` puts a working link on the page that back-links to nothing.
  const ix = buildIndex(starter)
  const from = new Set((ix.backlinks.get('sd-writing') ?? []).map((r) => r.pageId))
  ok(from.has('sd-media'), `the link in the starter's table back-links (from: ${[...from].join(', ') || 'nobody'})`)
}

// ---- the starter DEMONSTRATES what shipped --------------------------------
// "A feature the starter does not demonstrate is a feature the starter denies"
// (spaces/src/starter.ts). Every one of these arrived AFTER the starter was
// written and was absent from it until somebody read the changelog beside it —
// which is the failure this asserts against, because it is silent: the app
// works, the tour simply stops mentioning half of it.
{
  const starter = starterDoc() as unknown as SpacesDoc
  const blocks = starter.pages.flatMap((pg) => pg.blocks)
  const has = (type: string) => blocks.some((bl) => bl.type === type)

  const demos: Array<[string, boolean]> = [
    ['a table', has('table')],
    ['a clip', has('media')],
    ['a link card', has('link')],
    ['a picture, embedded as an asset', blocks.some((bl) => bl.type === 'image' && String(bl.src ?? '').startsWith('asset:'))],
    ['a page-link card', has('pagelink')],
    ['a callout', has('callout')],
    ['a toggle that starts FOLDED, so print-expanded is visible', blocks.some((bl) => bl.type === 'toggle' && bl.open === false)],
    ['a calculating line', blocks.some((bl) => /=\s*$/.test(String(bl.html ?? '')))],
    ['a highlight and a colour from the palette', blocks.some((bl) => /class="sp-(bg|fg)-/.test(String(bl.html ?? '')))],
    ['a comment thread', blocks.some((bl) => Array.isArray(bl.comments) && bl.comments.length > 0)],
    ['an archived page', starter.pages.some((pg) => pg.archived === true)],
    ['a journal home for ⌘⇧J to hang entries from', starter.pages.some((pg) => pg.journalHome === true)],
    ['a page that sets its own width', starter.pages.some((pg) => !!pg.width)],
  ]
  for (const [what, present] of demos) ok(present, `the starter shows ${what}`)

  // the archived page is the ⌘K-only one: nothing may link to it, or the
  // demonstration on the Welcome page is a lie
  const archived = starter.pages.filter((pg) => pg.archived === true).map((pg) => pg.id)
  const linked = blocks.some((bl) =>
    archived.some((id) => String(bl.html ?? '').includes(`#p/${id}`) || bl.page === id))
  ok(!linked, 'nothing links to the archived page — ⌘K is the way in, as the starter says')

  // every asset it ships is used, and every used asset ships
  const keys = Object.keys(starter.assets ?? {})
  const refs = new Set(blocks.flatMap((bl) => [String(bl.src ?? ''), String(bl.poster ?? '')])
    .filter((s) => s.startsWith('asset:')).map((s) => s.slice(6)))
  ok(keys.length > 0 && keys.every((k) => refs.has(k)) && [...refs].every((k) => keys.includes(k)),
    `the starter's assets and its references agree (${keys.length} asset(s))`)
}

// ---- a title has to BE a title --------------------------------------------
// `{ title: 'Tracker' }` is the object shape every other verb here takes, so it
// is the mistake a caller actually makes — and coercion answered it with a page
// called "[object Object]" and an ok result.
{
  const doc = load([p('p1', [b('b1')])])
  const bad: unknown[] = [{ title: 'x' }, ['x'], 42, true]
  for (const t of bad) {
    const made = planNewIssue(doc, { title: t })
    const set = planUpdatePage(doc, 'p1', { title: t })
    ok(made.ok === false && (made as { err?: string }).err === 'bad-title',
      `newIssue refuses a title of type ${Array.isArray(t) ? 'array' : typeof t}`)
    ok(set.ok === false && (set as { err?: string }).err === 'bad-title',
      `updatePage refuses a title of type ${Array.isArray(t) ? 'array' : typeof t}`)
  }

  // …and still accepts the things that ARE titles, including none
  ok(planNewIssue(doc, { title: 'A real one' }).ok, 'a string title is accepted')
  ok(planNewIssue(doc, {}).ok, 'no title at all is accepted — it has a default')
  ok(planNewIssue(doc, { title: null }).ok, 'an explicitly empty title is accepted')
  ok(planUpdatePage(doc, 'p1', { title: '<b>markup</b> is still flattened' }).ok,
    'updatePage still takes a string and strips its markup')
}

// ---- …and specific on documents that are broken ---------------------------
{
  const broken = load([
    p('p1', [
      { id: 'dup', type: 'p', html: 'see <a href="#p/ghost">a dead link</a>' },
      { id: 'dup', type: 'p', html: 'a duplicate id' },
      { id: 'b3', type: 'wat', html: 'unknown type' },
      { id: 'b4', type: 'image', src: 'https://example.com/x.png' },
      { id: 'b5', type: 'p', html: '<p>block markup inside inline html</p>' },
    ]),
  ], { home: 'nope' })
  const codes = new Set(validateDoc(broken).findings.map((f) => f.code))
  for (const want of ['broken-link', 'unknown-block-type', 'no-such-home', 'block-markup']) {
    ok(codes.has(want), `a broken document reports ${want} (got: ${[...codes].join(', ')})`)
  }
  ok(validateDoc(broken).findings.every((f) => !!f.fix && !!f.message),
    'every finding says what is wrong AND how to fix it')

  // a LEGAL block anchor is not a broken link — the review found this reported
  // as severity ERROR with a fix that would have destroyed a working link
  const anchored = load([p('p1', [{ id: 'b1', type: 'p', html: 'see <a href="#p/p2/b9">that block</a>' }]), p('p2', [b('b9')])])
  ok(!validateDoc(anchored).findings.some((f) => f.code === 'broken-link'),
    'a #p/<page>/<block> anchor is not reported as broken')
}

// ---- every write verb refuses what it cannot honour ------------------------
{
  const doc = load([p('p1', [b('b1'), b('b2')]), p('p2', [b('b3')])])

  const refusals: Array<[string, { ok: boolean }]> = [
    ['insertBlocks into a page that does not exist', planInsertBlocks(doc, 'nope', null, [{ type: 'p' }]) as never],
    ['updateBlock on a block that does not exist', planUpdateBlock(doc, 'nope', { html: 'x' }) as never],
    ['updateBlock deleting `type`', planUpdateBlock(doc, 'b1', { type: undefined, __delete: ['type'] }) as never],
    ['moveBlock to a page that does not exist', planMoveBlock(doc, 'b1', { pageId: 'nope' }) as never],
    ['updatePage making a page its own parent', planUpdatePage(doc, 'p1', { parent: 'p1' }) as never],
    ['removePage that does not exist', planRemovePage(doc, 'nope') as never],
  ]
  for (const [label, plan] of refusals) ok(plan.ok === false, `refuses: ${label}`)

  // a refusal must SAY why — an agent cannot act on a bare null
  const bad = planUpdatePage(doc, 'p1', { parent: 'p1' }) as { ok: false; err?: string; detail?: string }
  ok(bad.ok === false && !!bad.err, 'a refusal carries a machine-readable code')
}

// ---- the verbs cannot produce a document this build could not produce ------
{
  // 1. html goes through the sanitizer on the way IN
  const doc = load([p('p1', [b('b1')])])
  apply(planInsertBlocks(doc, 'p1', null, [{ type: 'p', html: '<img src=x onerror="alert(1)"><p>block</p>hi' }]))
  const added = doc.pages[0].blocks[doc.pages[0].blocks.length - 1]
  ok(!/onerror|<img|<p>/i.test(added.html ?? ''),
    `inserted html is sanitized (${(added.html ?? '').slice(0, 40)})`)

  // 2. ids are unique, and minted rather than taken from the caller
  const doc2 = load([p('p1', [b('b1')])])
  apply(planInsertBlocks(doc2, 'p1', null, [{ id: 'b1', type: 'p', html: 'tries to reuse an id' }]))
  const ids = doc2.pages.flatMap((pg) => pg.blocks.map((x) => x.id))
  ok(new Set(ids).size === ids.length, 'an insert cannot reuse an existing block id')

  // 3. a type change runs the registry's init, so the block is complete
  const doc3 = load([p('p1', [b('b1')])])
  apply(planUpdateBlock(doc3, 'b1', { type: 'todo' }))
  ok(doc3.pages[0].blocks[0].done === false, 'retyping to `todo` initialises `done`')
  apply(planUpdateBlock(doc3, 'b1', { type: 'callout' }))
  ok(typeof doc3.pages[0].blocks[0].tone === 'string', 'retyping to `callout` initialises `tone`')

  // 4. a removed container takes its children with it, or they resurrect
  const doc4 = load([p('p1', [b('t1', 'toggle', { open: true }), b('c1', 'p', { parent: 't1' }), b('after')])])
  apply(planRemoveBlocks(doc4, ['t1']))
  const left = doc4.pages[0].blocks.map((x) => x.id)
  ok(!left.includes('c1'), `removing a container removes its children (left: ${left.join(', ')})`)
  ok(left.includes('after'), '…and nothing else')
}

// ---- walks over author-supplied links must TERMINATE -----------------------
// parseDoc keeps a cycle (it only drops parents naming no page), so this
// arrives from any hand-edited or mailed file — and the sequence is the
// RECOMMENDED one: validate() reports the cycle, an agent re-homes a page to
// fix it, and that call used to hang the tab with every unsaved edit in it.
{
  const cyclic = load([
    p('A', [b('a1')], { parent: 'B' }),
    p('B', [b('b1')], { parent: 'A' }),
    p('C', [b('c1')]),
  ])
  ok(cyclic.pages.find((x) => x.id === 'A')?.parent === 'B', 'a page cycle survives loading (so it must be handled)')

  // IN A CHILD PROCESS, with a hard timeout.
  //
  // Measuring elapsed time AFTER the call cannot report a call that never
  // returns: the first version of this hung the whole rig, so CI would have
  // timed out with nothing to read instead of naming the defect. A non-
  // terminating walk is exactly the failure being guarded, so the guard has to
  // survive it.
  const { execFileSync } = await import('node:child_process')
  const probe = (expr: string, label: string) => {
    const src =
      `import { parseDoc, FORMAT } from '${new URL('../spaces/src/model.ts', import.meta.url).pathname}';` +
      `import * as A from '${new URL('../spaces/src/agent.ts', import.meta.url).pathname}';` +
      `const r = parseDoc(JSON.stringify({format:FORMAT,version:1,docId:'c',title:'c',home:'A',pages:[` +
      `{id:'A',title:'A',parent:'B',blocks:[{id:'a1',type:'p',html:'a'}]},` +
      `{id:'B',title:'B',parent:'A',blocks:[{id:'b1',type:'p',html:'b'}]},` +
      `{id:'C',title:'C',blocks:[{id:'c1',type:'p',html:'c'}]}]}));` +
      `${expr};`
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', src], { timeout: 8000, stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }
  ok(probe(`A.planUpdatePage(r.doc, 'C', { parent: 'A' })`, ''), 'updatePage terminates on a page cycle')
  ok(probe(`A.validateDoc(r.doc)`, ''), 'validate terminates on a page cycle')
  ok(probe(`A.outlineDoc(r.doc)`, ''), 'outline terminates on a page cycle')
  ok(probe(`A.statsDoc(r.doc)`, ''), 'stats terminates on a page cycle')
}

// ---- outline() and stats() describe the document they were given -----------
{
  const doc = load([
    p('p1', [b('b1', 'h1'), b('b2'), b('b3')]),
    p('p2', [b('b4')], { parent: 'p1' }),
    p('p3', [b('b5')], { archived: true }),
  ])
  const o = outlineDoc(doc)
  ok(o.pages === 3 && o.blocks === 5, `outline counts the space (${o.pages} pages, ${o.blocks} blocks)`)
  // FLAT and in pre-order, with `depth` and `parent` — the same convention the
  // document itself uses for pages and blocks, so an agent that can read one
  // can read the other. (Nested children would be a second shape to learn.)
  const tree = o.tree as Array<{ id: string; depth: number; parent?: string }>
  ok(tree.length === 3, `outline's tree holds every page (${tree.length})`)
  ok(tree.every((n) => typeof n.depth === 'number'), 'every node carries its depth')
  const child = tree.find((x) => x.id === 'p2')
  ok(child?.depth === 1 && child?.parent === 'p1', 'a child page reports depth 1 and names its parent')
  ok(tree.findIndex((x) => x.id === 'p1') < tree.findIndex((x) => x.id === 'p2'),
    'and a child always follows its parent, so one forward pass rebuilds the tree')

  const s = statsDoc(doc)
  ok(s.pages === 3 && s.blocks === 5, `stats counts pages and blocks (${s.pages}/${s.blocks})`)
  ok(s.archived === 1, 'stats counts archived pages separately')
  ok(s.bytes.document > 0, 'stats reports a document size, so "why is this file large" is answerable')
  ok(typeof s.todos.total === 'number', 'stats reports to-do progress')
}

// ===========================================================================
// THE TRACKER: an issue is a page, its values are prop blocks
// ===========================================================================
//
// The permanent risk in this half is not a crash — it is a value that says one
// thing to this build and another to everything else that will ever read the
// file. `html` is what an older build, a thumbnailer, a grep and the markdown
// export see, and it is ALL they see, so every assertion below that looks
// cosmetic is really about that.

/** An issue page, written the way the editor writes one. */
const issue = (id: string, values: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id, title: id,
  blocks: [
    ...Object.entries(values).map(([k, v], i) => {
      const f = DEFAULT_FIELDS.find((x) => x.key === k)!
      return { id: `${id}-${i}`, type: 'prop', key: k, value: v, html: propHtml(f, v) }
    }),
    { id: `${id}-body`, type: 'p', html: 'the body' },
  ],
  ...extra,
})

// ---- validate() stays SILENT on tracker documents that are correct ---------
{
  const clean = load([
    issue('i1', { status: 'todo', priority: 'high', assignee: 'ana', estimate: 3 }),
    issue('i2', { status: 'done', priority: 'none', assignee: '', estimate: '' }),
    p('board', [{ id: 'v1', type: 'view', layout: 'board', groupBy: 'status', html: 'Issues by status' }]),
  ])
  const v = validateDoc(clean)
  ok(v.findings.length === 0,
    `a correct tracker raises nothing (${v.findings.map((f) => `${f.code}@${f.block}`).join(', ') || 'silent'})`)

  // A SELECT WITH NO DEFAULT. `makeIssue` writes `f.def ?? ''`, so an empty
  // select is a document THIS BUILD produced — flagging it would be a false
  // positive on the editor's own output.
  const nodef = load([{
    id: 'i1', title: 'i1',
    blocks: [{ id: 'b1', type: 'prop', key: 'phase', value: '', html: 'Phase: —' },
      { id: 'b2', type: 'prop', key: 'status', value: 'todo', html: 'Status: Todo' }],
  }], { fields: [...DEFAULT_FIELDS, { key: 'phase', label: 'Phase', vt: 'select', options: [{ id: 'a', label: 'A' }] }] })
  ok(!validateDoc(nodef).findings.some((f) => f.code === 'unknown-field-value'),
    'an empty select is "not set", not an unknown option')

  // A VALUE FROM A NEWER BUILD, with the label that build knew. Its html is
  // RIGHT and ours would be the guess, so the staleness check must stand down.
  const newer = load([{
    id: 'i1', title: 'i1',
    blocks: [{ id: 'b1', type: 'prop', key: 'status', value: 'blocked', html: 'Status: Blocked' }],
  }])
  const nf = validateDoc(newer).findings
  ok(!nf.some((f) => f.code === 'prop-html-stale'),
    'an unknown option\'s readable form is not reported stale — the newer build knew the label')
  ok(nf.some((f) => f.code === 'unknown-field-value' && f.severity === 'info'),
    'an unknown option is INFO — the format keeps what a newer build wrote')
  ok(!nf.some((f) => f.severity === 'error'), 'and a newer build\'s value is never an error')

  // A field key this schema does not declare: the same story, one level up.
  const extraKey = load([{
    id: 'i1', title: 'i1',
    blocks: [{ id: 'b1', type: 'prop', key: 'status', value: 'todo', html: 'Status: Todo' },
      { id: 'b2', type: 'prop', key: 'sprint', value: '24', html: 'Sprint: 24' }],
  }])
  const ef = validateDoc(extraKey).findings
  ok(ef.length === 1 && ef[0].code === 'unknown-field-key' && ef[0].severity === 'info',
    `a field key from a newer build is one INFO and nothing else (${ef.map((f) => f.code).join(', ')})`)
}

// ---- …and names the ways a field value goes silently wrong -----------------
{
  const broken = load([
    // html that disagrees with the value: the degradation guarantee, broken
    { id: 'i1', title: 'i1', blocks: [
      { id: 'b1', type: 'prop', key: 'status', value: 'done', html: 'Status: In progress' },
      { id: 'b2', type: 'p', html: 'body' },
    ] },
    // two values for one field, and a prop naming no field at all
    { id: 'i2', title: 'i2', blocks: [
      { id: 'b3', type: 'prop', key: 'status', value: 'todo', html: 'Status: Todo' },
      { id: 'b4', type: 'prop', key: 'status', value: 'done', html: 'Status: Done' },
      { id: 'b5', type: 'prop', value: 'orphan', html: 'x' },
    ] },
  ])
  const codes = new Map(validateDoc(broken).findings.map((f) => [f.code, f]))
  for (const want of ['prop-html-stale', 'duplicate-prop', 'prop-no-key']) {
    ok(codes.has(want), `reports ${want} (got: ${[...codes.keys()].join(', ')})`)
  }
  ok(codes.get('prop-html-stale')?.block === 'b1' && codes.get('prop-html-stale')?.path === 'html',
    'a stale readable form names the block and the field it is in')
  ok([...codes.values()].every((f) => !!f.message && !!f.fix), 'every tracker finding says what to do')

  // a schema entry that cannot be used: propHtml THROWS on it, so the editor's
  // field picker dies on click — an error, not a note
  const badSchema = load([p('p1', [b('b1')])], { fields: [{ key: 'status' }, { label: 'no key', vt: 'text' }] })
  const bs = validateDoc(badSchema).findings.filter((f) => f.code === 'bad-field-schema')
  ok(bs.length === 2 && bs.every((f) => f.severity === 'error'),
    `a malformed doc.fields entry is an error (${bs.length} found)`)
}

// ---- fields(): the schema, as data an agent can act on ---------------------
{
  const doc = load([p('p1', [b('b1')])])
  const fields = fieldsReport(doc)
  const status = fields.find((f) => f.key === 'status')!
  ok(status.options?.some((o) => o.id === 'doing' && o.label === 'In progress'),
    'fields() carries the option IDS, which are not the labels')
  ok(status.options?.some((o) => o.group === 'started'),
    'fields() carries the phase group, so "open" needs no filter to be configured')

  // The default schema is MODULE STATE shared by every document in the
  // session: handing it out live means one agent's push() edits the schema of
  // documents that have not been loaded yet.
  fields[0].options!.length = 0
  ok(fieldsReport(doc).find((f) => f.key === 'status')!.options!.length === 6,
    'fields() hands back a copy — mutating it cannot corrupt the default schema')
}

// ---- setField(): value and html, together, always -------------------------
{
  const doc = load([issue('i1', { status: 'todo', assignee: '' }), p('plain', [b('b1')])])
  const r = apply(planSetField(doc, 'i1', 'status', 'doing'))
  const blk = doc.pages[0].blocks[0] as Record<string, unknown>
  ok(r.ok && blk.value === 'doing' && blk.html === 'Status: In progress',
    `setField writes the readable form with the value (${String(blk.html)})`)
  ok(r.html === blk.html && r.blocks[0] === blk.id, 'and reports exactly what it wrote')

  // a value for a field the page does not carry yet joins the HEADER STRIP —
  // prop blocks before the first non-prop block — not the end of the prose
  const r2 = apply(planSetField(doc, 'i1', 'due', '2026-09-01'))
  const types = doc.pages[0].blocks.map((x) => x.type)
  ok(r2.created === true && types.join(',') === 'prop,prop,prop,p',
    `a new value joins the header strip (${types.join(',')})`)
  ok((doc.pages[0].blocks[2] as Record<string, unknown>).html === 'Due: 2026-09-01',
    'and it is created with its readable form, not without one')

  // a page becomes an issue by carrying a status; nothing else changes
  ok(!isIssue(doc.pages[1] as never), 'a plain page is not an issue')
  apply(planSetField(doc, 'plain', 'status', 'backlog'))
  ok(isIssue(doc.pages[1] as never) && doc.pages[1].blocks.length === 2,
    'setField(status) is what makes a page an issue — no flag, no type')

  // …and clearing it makes it a document again, body intact
  const cleared = apply(planSetField(doc, 'plain', 'status', null))
  ok(cleared.removed === true && !isIssue(doc.pages[1] as never) && doc.pages[1].blocks.length === 1,
    'clearing the status makes it a page again, with its body')
  ok(apply(planSetField(doc, 'plain', 'status', null)).ok === true,
    'clearing a field that is not set is not an error — the call is idempotent')

  // while a duplicate exists, BOTH are written: a reader takes the last, so
  // writing one of them would be a set that changes nothing anyone can see
  const dup = load([{ id: 'i1', title: 'i1', blocks: [
    { id: 'b1', type: 'prop', key: 'status', value: 'todo', html: 'Status: Todo' },
    { id: 'b2', type: 'prop', key: 'status', value: 'todo', html: 'Status: Todo' },
  ] }])
  apply(planSetField(dup, 'i1', 'status', 'done'))
  ok(dup.pages[0].blocks.every((x) => (x as Record<string, unknown>).value === 'done'),
    'a duplicated field is written in every copy, so the page cannot disagree with itself')
}

// ---- setField(): what it refuses, and what it deliberately allows ----------
{
  const doc = load([issue('i1', { status: 'todo' })])
  const refusals: Array<[string, string, { ok: boolean; err?: string }]> = [
    ['a page that does not exist', 'no-such-page', planSetField(doc, 'nope', 'status', 'todo') as never],
    ['a key that is in no schema', 'no-such-field', planSetField(doc, 'i1', 'staus', 'todo') as never],
    ['a value JSON cannot carry', 'not-serializable', planSetField(doc, 'i1', 'assignee', () => 1) as never],
  ]
  for (const [label, err, plan] of refusals) {
    ok(plan.ok === false && plan.err === err, `setField refuses ${label} with err:${err} (got ${plan.err})`)
  }
  const why = planSetField(doc, 'i1', 'staus', 'todo') as { detail?: string }
  ok(!!why.detail && why.detail.includes('status'),
    'and the refusal names the keys that DO exist, so the caller can correct itself')

  // A VALUE THIS BUILD DOES NOT KNOW IS WRITTEN, NOT REFUSED. The format is
  // permanent: an option a newer build declared has to survive this one. But
  // an agent typing the LABEL where the id belongs must be told, or it is
  // wrong and confident.
  const w = apply(planSetField(doc, 'i1', 'status', 'In progress')) as {
    ok: boolean; warning?: { code: string; options: string[]; detail: string }
  }
  ok(w.ok === true && (doc.pages[0].blocks[0] as Record<string, unknown>).value === 'In progress',
    'an unknown option is written verbatim — the format keeps what it is given')
  ok(w.warning?.code === 'unknown-option' && w.warning.options.includes('doing'),
    'and comes back with a warning naming the ids that exist')
  ok(!apply(planSetField(doc, 'i1', 'status', 'doing')).warning,
    'a known option warns about nothing')
  ok(!apply(planSetField(doc, 'i1', 'assignee', 'In progress')).warning,
    'and a free-text field has no options to be wrong about')
  // "not set" is not a wrong option. `makeIssue` writes '' for a select with
  // no default, so warning here would fire on the editor's own output.
  ok(!apply(planSetField(doc, 'i1', 'status', '')).warning,
    'clearing a select to "not set" warns about nothing')
}

// ---- a value from a NEWER build survives a round trip untouched ------------
// The whole degradation contract in one assertion: this build must be able to
// open, read, filter and edit a document written by a build that knew more
// than it does, and give back every byte it did not itself change.
{
  const original = {
    format: FORMAT, version: 1, docId: 'rt', title: 'Round trip', home: 'i1',
    theme: { background: '#fff', color: '#1E2A3A', accent: '#F7A600', measure: 720 },
    fields: [
      { key: 'status', label: 'Status', vt: 'select', def: 'todo', options: [
        ...DEFAULT_FIELDS[0].options!,
        { id: 'blocked', label: 'Blocked', color: '#E5484D', group: 'started', escalation: 'page-the-owner' },
      ] },
      { key: 'assignee', label: 'Assignee', vt: 'person' },
      { key: 'squad', label: 'Squad', vt: 'text' },
    ],
    pages: [{ id: 'i1', title: 'A newer issue', blocks: [
      { id: 'b1', type: 'prop', key: 'status', value: 'blocked', html: 'Status: Blocked', pinned: true },
      { id: 'b2', type: 'prop', key: 'squad', value: 'platform', html: 'Squad: platform' },
      { id: 'b3', type: 'p', html: 'body' },
    ] }],
  }
  const r = parseDoc(JSON.stringify(original))
  if (!r.ok) throw new Error('the newer-build fixture did not parse')
  const doc = r.doc

  ok(JSON.stringify(doc.pages) === JSON.stringify(original.pages),
    'a page written by a newer build loads byte-identical')
  ok(validateDoc(doc).ok, 'and raises no errors')

  const rows = issuesReport(doc, { group: 'open' })
  ok(rows.length === 1 && rows[0].group === 'started',
    'a status this build could not have written is still grouped by the schema the FILE declares')

  // editing a DIFFERENT field must not rewrite the one it does not understand
  apply(planSetField(doc, 'i1', 'assignee', 'ana'))
  ok(JSON.stringify(doc.pages[0].blocks[0]) === JSON.stringify(original.pages[0].blocks[0]),
    'setField on another field leaves the newer build\'s block untouched, extra keys and all')
  ok((doc.pages[0].blocks[1] as Record<string, unknown>).value === 'platform',
    '…and the field this build has no editor for keeps its value')

  // and writing the SAME field keeps the file's own vocabulary
  apply(planSetField(doc, 'i1', 'status', 'blocked'))
  ok((doc.pages[0].blocks[0] as Record<string, unknown>).html === 'Status: Blocked',
    'writing a value declared only by the FILE uses the file\'s label')
}

// ---- issues(): the backlog, in one call -----------------------------------
{
  const doc = load([
    issue('i1', { status: 'todo', priority: 'high', assignee: '', estimate: 2 }),
    issue('i2', { status: 'doing', priority: 'low', assignee: 'ana', estimate: 3 }),
    issue('i3', { status: 'done', priority: 'none', assignee: 'sam', estimate: 1 }),
    issue('i4', { status: 'cancelled', priority: 'none', assignee: '' }),
    issue('i5', { status: 'off-world', priority: 'urgent', assignee: '' }),
    issue('old', { status: 'todo' }, { archived: true }),
    p('doc1', [b('b1')]),
  ])
  const all = issuesReport(doc)
  ok(all.length === 5, `issues() returns the issues and not the documents (${all.length})`)
  ok(all[0].id === 'i1' && all[0].url === '#p/i1' && all[0].title === 'i1',
    'each row carries the page id, its title and the href a link would use')
  ok(all[0].fields.priority === 'high' && all[0].fields.estimate === 2,
    'every field value comes back, by key')
  ok(!all.some((x) => x.archived), 'archived issues are out by default')
  ok(issuesReport(doc, { archived: true }).length === 6 &&
     issuesReport(doc, { archived: true }).some((x) => x.archived === true),
    'and are asked for explicitly, and say so')

  ok(all.find((x) => x.id === 'i2')!.group === 'started', 'a row reports the PHASE of its status')
  ok(all.find((x) => x.id === 'i5')!.group === 'unknown',
    'a status this build does not know reports "unknown", never a phase it guessed')

  const open = issuesReport(doc, { group: 'open' }).map((x) => x.id)
  ok(open.join(',') === 'i1,i2,i5',
    `"open" means NOT FINISHED, so an unknown status counts as work (${open.join(',')})`)
  ok(issuesReport(doc, { group: 'done' }).map((x) => x.id).join(',') === 'i3',
    'and a finished phase is asked for by name')
  ok(issuesReport(doc, { group: ['unstarted', 'unknown'] }).map((x) => x.id).join(',') === 'i1,i5',
    'phases can be asked for together')

  // the call the whole thing exists for
  const triage = issuesReport(doc, { group: 'open', where: { assignee: null } }).map((x) => x.id)
  ok(triage.join(',') === 'i1,i5', `"open and unassigned" is one call (${triage.join(',')})`)
  ok(issuesReport(doc, { where: { status: ['todo', 'doing'] } }).map((x) => x.id).join(',') === 'i1,i2',
    'a filter takes a list for any-of')
  ok(issuesReport(doc, { where: { estimate: '3' } }).map((x) => x.id).join(',') === 'i2',
    'and compares as text, so 3 and "3" are the same estimate')
  ok(issuesReport(doc, { where: { assignee: 'nobody' } }).length === 0, 'a filter that matches nothing is empty')
}

// ---- newIssue(): one step, fields through the same path -------------------
{
  const doc = load([p('home', [b('b1')])])
  const r = apply(planNewIssue(doc, { title: 'Login is slow', priority: 'urgent', assignee: 'ana' })) as
    { ok: boolean; id: string; blocks: string[] }
  ok(r.ok && doc.pages.length === 2, 'newIssue adds one page')
  const page = doc.pages[1]
  const values = valuesOf(page as never)
  ok(page.title === 'Login is slow', 'with the title it was given')
  ok(isIssue(page as never) && values.get('status') === 'todo',
    'an issue, from the schema\'s own default status')
  ok(values.get('priority') === 'urgent' && values.get('assignee') === 'ana',
    'carrying the values it was given')
  // SPELLED OUT, not `ISSUE_FIELDS.every(...)`: asserting the list against
  // itself passes however the list is edited, which is not a test of anything.
  // These four are what ⌘⇧I seeds, and a `prop` cannot be added from the /
  // menu — a field missing here is a field a human cannot then set at all.
  ok(['status', 'priority', 'assignee', 'estimate'].every((k) => values.has(k)),
    `and every field a ⌘⇧I issue starts with (${[...values.keys()].join(', ')})`)
  ok(ISSUE_FIELDS.join(',') === 'status,priority,assignee,estimate',
    'the shared seed list is those four')
  ok(page.blocks.every((x) => x.type !== 'prop' || x.html === propHtml(
    DEFAULT_FIELDS.find((f) => f.key === (x as Record<string, unknown>).key)!,
    (x as Record<string, unknown>).value)),
    'every value written with its readable form — the same path as setField')
  ok(page.blocks[page.blocks.length - 1].type === 'p',
    'and it ends in a paragraph: a page of nothing but props has nowhere to put the caret')
  ok(validateDoc(doc).findings.length === 0, 'the issue it produces is one validate() is silent about')

  // a typo in an ARGUMENT is a mistake, not additivity: refusing it is the
  // difference between an agent that knows it failed and one that does not
  const typo = planNewIssue(doc, { title: 'x', prioritty: 'urgent' }) as { ok: boolean; err?: string }
  ok(typo.ok === false && typo.err === 'no-such-field', 'newIssue refuses a field key that is in no schema')
  ok(doc.pages.length === 2, '…and a refused call adds no page at all')
  ok((planNewIssue(doc, { title: 'x', parent: 'ghost' }) as { err?: string }).err === 'no-such-page',
    'and refuses a parent that does not exist')

  const w = apply(planNewIssue(doc, { title: 'y', status: 'In progress' })) as
    { warnings?: Array<{ code: string; key: string }> }
  ok(w.warnings?.[0]?.code === 'unknown-option' && w.warnings[0].key === 'status',
    'a label typed where an option id belongs is written, and reported')

  const bare = apply(planNewIssue(doc, undefined)) as { ok: boolean; id: string }
  ok(bare.ok && doc.pages.find((x) => x.id === bare.id)?.title === 'New issue',
    'newIssue with no argument is still a complete issue')
}

// ---- the tracker verbs go through the same undo/read-only gate -------------
// planSetField and planNewIssue are refused for a read-only document by
// main.ts's run(), which is also what takes the undo checkpoint. Calling a
// plan's apply() directly would bypass both — and nothing else in this rig
// would notice, because the plans themselves are correct.
{
  const fs = await import('node:fs')
  const main = fs.readFileSync(new URL('../spaces/src/main.ts', import.meta.url), 'utf8')
  for (const verb of ['planSetField', 'planNewIssue']) {
    ok(new RegExp(`run\\(${verb}\\(`).test(main),
      `${verb} is wired through run(), so read-only refuses it and undo records it`)
  }
  ok(/fields: \(\) => fieldsReport|issues: \(query/.test(main), 'fields() and issues() are on window.bento')

  // …and the editor seeds a new issue from the SAME list this does, or ⌘⇧I and
  // bento.newIssue() make two different kinds of issue.
  const editor = fs.readFileSync(new URL('../spaces/src/editor.ts', import.meta.url), 'utf8')
  ok(/ISSUE_FIELDS\.includes\(f\.key\)/.test(editor) &&
     !/'status', 'priority', 'assignee', 'estimate'/.test(editor),
    'the editor seeds a new issue from the shared list, not a second copy of it')
}

// ---- five defects a review reproduced in the tracker ----------------------
{
  // 1. THE DEGRADATION GUARANTEE, enforced rather than claimed. setField kept
  //    value and html in step; updateBlock and insertBlocks did not — measured,
  //    updateBlock({value:'doing'}) left html:'Status: Todo', so the file SAID
  //    Todo to every older build, thumbnailer, grep and markdown export while
  //    its value said doing. A guarantee one writer keeps and three break is
  //    not a guarantee, so it moved to where blocks are WRITTEN.
  const d = load([p('p1', [{ id: 'ps', type: 'prop', key: 'status', value: 'todo', html: 'Status: Todo' }])])
  apply(planUpdateBlock(d, 'ps', { value: 'doing' }))
  ok((d.pages[0].blocks[0] as { html?: string }).html === 'Status: In progress',
    'updateBlock re-derives the readable form from the new value')

  apply(planInsertBlocks(d, 'p1', 'ps', [{ type: 'prop', key: 'priority', value: 'urgent' }]))
  ok((d.pages[0].blocks[1] as { html?: string }).html === 'Priority: Urgent',
    'insertBlocks writes a readable form for a field it was given without one')

  apply(planInsertBlocks(d, 'p1', null, [{ type: 'prop', key: 'from-the-future', value: 'x', html: 'From the future: x' }]))
  const last = d.pages[0].blocks[d.pages[0].blocks.length - 1] as { html?: string }
  ok(last.html === 'From the future: x',
    '…and leaves a key it does not know exactly as a newer build wrote it')

  // 2. A malformed schema entry must not CRASH a write verb. It comes out of a
  //    file, validate() reports it, and every other bad input is a tagged
  //    refusal — this one threw a TypeError out of the public API.
  for (const [name, spec] of [
    ['no label', { key: 'owner', vt: 'text' }],
    ['a numeric label', { key: 'o', label: 42, vt: 'text' }],
    ['neither', { vt: 'text' }],
  ] as Array<[string, unknown]>) {
    let threw: string | null = null
    let out = ''
    try { out = propHtml(spec as never, 'ana') } catch (e) { threw = (e as Error).message }
    ok(threw === null, `a schema entry with ${name} does not throw (${threw ?? out})`)
  }

  // 3. A new issue must BE an issue, or the verb reports a success nothing can
  //    see: invisible to issues(), to every board, and to a follow-up setField.
  const noStatus = load([p('p1', [b('b1')])], { fields: [{ key: 'state', label: 'State', vt: 'text' }] })
  const made = planNewIssue(noStatus, { title: 'filed by an agent' }) as { ok: boolean; err?: string }
  ok(made.ok === false && made.err === 'no-status-field',
    `a space with no status field refuses to make an issue (${made.err ?? 'ok'})`)

  // 4. An UNSET status is not an UNKNOWN one — they want opposite handling:
  //    "leave it alone" versus "this needs triaging".
  const mixed = load([
    p('a', [{ id: 'a1', type: 'prop', key: 'status', value: '', html: 'Status: —' }]),
    p('c', [{ id: 'c1', type: 'prop', key: 'status', value: 'from-a-newer-build', html: 'Status: from-a-newer-build' }]),
  ])
  const rows = issuesReport(mixed, {})
  ok(rows.find((r) => r.id === 'a')?.group === undefined, 'an unset status reports no group')
  ok(rows.find((r) => r.id === 'c')?.group === 'unknown', 'a status from a newer build reports "unknown"')
}

// ---- a drop that changes nothing must WRITE nothing ------------------------
// reorderPages judged adjacency in doc.pages, and page order is not column
// order: a board with two columns interleaves them. Measured on
// [board,i1,i2,i3,i4,i5] with i1,i3,i5 in one column — dropping i1 back into
// its own slot rewrote doc.pages, took an undo entry, set the dirty flag, and
// visibly reshuffled the SIDEBAR, because board order is sidebar order. The rig
// missed it because its fixture had ONE column, the only shape where the two
// orders agree.
{
  const col = ['i1', 'i3', 'i5']
  for (const [label, aim] of [
    ['before its own next card', { before: 'i3' }],
    ['after its own previous card', { after: 'i3' }],
    ['onto itself', { after: 'i1' }],
  ] as Array<[string, never]>) {
    const moved = label.includes('previous') ? 'i5' : 'i1'
    ok(!columnMoves(col, moved, aim), `dropping ${label} moves nothing`)
  }
  ok(columnMoves(col, 'i5', { before: 'i1' } as never), 'a real move is a move')
  ok(columnMoves(col, 'newcomer', { before: 'i3' } as never), 'a card from another column always moves')
}


// ---- comments(): the flat typed-anchor list ---------------------------------
// This is what an agent reads before it acts on what a human flagged, so the
// two things that must be true are that the ANCHOR is stated rather than
// implied by where the thread was stored, and that a hostile or hand-edited
// file cannot make the report throw halfway through — a verb that dies on the
// third page has told the agent the first two are all there is.
{
  const doc = load([
    p('p1', [
      { id: 'b1', type: 'p', html: 'one', comments: [
        { id: 'c1', author: 'Ada', at: '2026-08-20T10:00:00Z', text: 'is this right?',
          replies: [{ id: 'c2', author: 'Bo', at: '2026-08-20T11:00:00Z', text: 'no' }] },
      ] },
      { id: 'b2', type: 'p', html: 'two', comments: [
        { id: 'c3', author: 'Bo', at: '2026-08-20T12:00:00Z', text: 'settled', resolved: true },
      ] },
    ]),
    p('p2', [b('b3')]),
  ])
  ;(doc.pages[1] as { comments?: unknown }).comments = [
    { id: 'c4', author: 'Ada', at: '2026-08-20T13:00:00Z', text: 'this page needs a title' },
  ]

  const all = commentsReport(doc)
  ok(all.length === 3, `every thread on every page, flat (${all.length})`)
  const c1 = all.find((c) => c.id === 'c1')!
  ok(c1.anchor === 'block' && c1.blockId === 'b1' && c1.pageId === 'p1',
    'a block thread reports anchor "block", its block and its page')
  ok(c1.url === '#p/p1', 'and the href that reaches it')
  ok(c1.replies.length === 1 && c1.replies[0].author === 'Bo', 'replies come with it')
  const c4 = all.find((c) => c.id === 'c4')!
  ok(c4.anchor === 'page' && c4.blockId === undefined,
    'a page thread reports anchor "page" and NO block id')
  ok(all.every((c) => typeof c.resolved === 'boolean'),
    'resolved is always a boolean — absent means open, never undefined')

  ok(commentsReport(doc, { resolved: false }).length === 2, 'the open ones filter out the settled')
  ok(commentsReport(doc, { resolved: true }).map((c) => c.id).join() === 'c3', '…and back again')
  ok(commentsReport(doc, { pageId: 'p2' }).map((c) => c.id).join() === 'c4', 'one page at a time')

  // The one thing this must not do is act. A comment is half a conversation,
  // and a verb that resolved the remark it was asked to address would make the
  // record untrue.
  ok(commentsReport(doc).length === 3 && doc.pages[0].blocks[0].comments!.length === 1,
    'reporting changes nothing in the document')

  // hostile shapes: everything below arrives in a file somebody mailed you
  const nasty = load([p('h1', [
    { id: 'x1', type: 'p', html: 'a', comments: 'yes' },
    { id: 'x2', type: 'p', html: 'b', comments: [null, 7, { noId: true }] },
    { id: 'x3', type: 'p', html: 'c', comments: [{ id: 'k1', author: 3, at: null, text: { evil: 1 }, replies: 3 }] },
  ])])
  const rep = commentsReport(nasty)
  ok(rep.length === 1 && rep[0].id === 'k1',
    'a comments field that is not an array, and entries with no id, are ignored')
  ok(rep[0].author === '' && rep[0].text === '' && rep[0].at === '' && rep[0].replies.length === 0,
    'every field is coerced to the type the report promises')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
