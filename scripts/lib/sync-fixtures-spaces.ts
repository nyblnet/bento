// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Random bento/spaces documents and edits, for the sync rigs.
//
// SEPARATE FROM sync-fixtures.ts ON PURPOSE. That file picks its mutation with
// `Math.floor(rnd() * 13)` and is shared by two slides rigs — adding a case
// there would re-roll the kind mapping for every seed in both, silently
// changing what years of slides coverage mean while the diff looked purely
// additive. Per-shape fixture modules behind one interface keep each app's
// generator frozen with respect to the other's.
//
// WHAT A SPACES DOCUMENT HAS THAT A DECK DOES NOT, and therefore what this
// generator must produce:
//
//  · BLOCKS NEST INSIDE A PAGE, via `Block.parent`, in a FLAT PRE-ORDER array.
//    Tab indents a block — one property write, no key change. The engine sees
//    `parent` as an ordinary register, and the array order as position keys.
//    Those are two independent merge domains for one visual tree, which is the
//    single most dangerous thing about this shape.
//  · PAGES NEST TOO, via `Page.parent`, with the same split.
//  · `html` is optional on a block, where a slides text element always has one.
//  · Property REMOVAL is ordinary (a to-do's `done`, a code block's `lang`) —
//    the mutation class that hid two crashes in this engine already.

export type Doc = Record<string, unknown> & {
  pages: Array<Record<string, unknown> & {
    id: string
    parent?: string
    blocks: Array<Record<string, unknown> & { id: string; parent?: string }>
  }>
}

/** deterministic PRNG — same one the slides fixtures use */
export function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const stable = (v: unknown): string => JSON.stringify(v)

const block = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, type: 'p', html: `text ${id}`, ...extra })

/** A space with two pages, one nested; a toggle with two children; a to-do. */
export function baseDoc(): Doc {
  return {
    format: 'bento/spaces',
    version: 1,
    docId: 'fixture',
    title: 'Fixture space',
    modified: '2026-01-01T00:00:00.000Z',
    home: 'p1',
    theme: { background: '#fff', color: '#1E2A3A', accent: '#F7A600', fontFamily: 'x' },
    assets: {},
    pages: [
      {
        id: 'p1',
        title: 'One',
        blocks: [
          block('b1'),
          { id: 'b2', type: 'toggle', html: 'a toggle', open: true },
          block('b3', { parent: 'b2' }),
          block('b4', { parent: 'b2' }),
          { id: 'b5', type: 'todo', html: 'a task', done: false },
        ],
      },
      {
        id: 'p2',
        title: 'Two',
        parent: 'p1',
        blocks: [
          { id: 'b6', type: 'code', html: 'const x = 1', lang: 'js' },
          block('b7'),
        ],
      },
    ],
  }
}

let seq = 0
const fresh = (p: string) => `${p}${(seq++).toString(36)}`

/**
 * One random edit, as a mutation applied to the document in place.
 *
 * Every case is something the editor actually does. The ones that matter most
 * are the re-parents (Tab / ⇧Tab, and dragging a page in the sidebar), because
 * they are the operations with no slides equivalent at all.
 */
export function randomMutation(doc: Doc, rnd: () => number): (d: Doc) => void {
  const kind = Math.floor(rnd() * 12)
  const pg = doc.pages[Math.floor(rnd() * doc.pages.length)]
  const blocks = pg?.blocks ?? []
  const bl = blocks[Math.floor(rnd() * blocks.length)]

  switch (kind) {
    case 0: // type into a block
      return (d) => {
        const p = d.pages.find((x) => x.id === pg?.id)
        const b = p?.blocks.find((x) => x.id === bl?.id)
        if (b) b.html = `${String(b.html ?? '')}${Math.floor(rnd() * 10)}`
      }
    case 1: // add a block
      return (d) => {
        const p = d.pages.find((x) => x.id === pg?.id)
        if (p) p.blocks.push(block(fresh('nb')))
      }
    case 2: // INDENT: re-parent a block under an earlier sibling
      return (d) => {
        const p = d.pages.find((x) => x.id === pg?.id)
        if (!p || p.blocks.length < 2) return
        const i = 1 + Math.floor(rnd() * (p.blocks.length - 1))
        p.blocks[i].parent = p.blocks[i - 1].id
      }
    case 3: // OUTDENT: drop the parent link
      return (d) => {
        const p = d.pages.find((x) => x.id === pg?.id)
        const b = p?.blocks.find((x) => x.id === bl?.id)
        if (b) delete b.parent
      }
    case 4: // reorder TOP-LEVEL blocks, subtree in tow — the drag gesture
      return (d) => {
        const p = d.pages.find((x) => x.id === pg?.id)
        if (!p || p.blocks.length < 2) return
        const roots = p.blocks.map((b, i) => ({ b, i })).filter((x) => x.b.parent === undefined)
        if (roots.length < 2) return
        const pick = roots[Math.floor(rnd() * roots.length)]
        // the run is the block plus everything nested under it, which in a
        // pre-order array is a contiguous slice
        // the descendant set, by fixed point — a contiguous walk misses a
        // grandchild whose own parent was added to the set after it was passed
        const kin = new Set([pick.b.id])
        for (let pass = 0; pass < p.blocks.length; pass++) {
          for (const b of p.blocks) if (b.parent && kin.has(String(b.parent))) kin.add(b.id)
        }
        let end = pick.i + 1
        while (end < p.blocks.length && kin.has(p.blocks[end].id)) end++
        const run0 = p.blocks.splice(pick.i, end - pick.i)
        const dest = roots.filter((r) => r.b.id !== pick.b.id)
        const target = dest.length ? p.blocks.findIndex((x) => x.id === dest[Math.floor(rnd() * dest.length)].b.id) : 0
        p.blocks.splice(Math.max(0, target), 0, ...run0)
      }
    case 5: // delete a block AND its subtree — a local edit must stay legal
      return (d) => {
        const p = d.pages.find((x) => x.id === pg?.id)
        if (!p || !bl) return
        const doomed = new Set([bl.id])
        for (let pass = 0; pass < p.blocks.length; pass++) {
          for (const b of p.blocks) if (b.parent && doomed.has(String(b.parent))) doomed.add(b.id)
        }
        p.blocks = p.blocks.filter((b) => !doomed.has(b.id))
      }
    case 6: // move a block and its SUBTREE to another page
      // The subtree has to travel: leaving children behind pointing at a
      // parent that is now on another page is a dangling reference, and this
      // rig's control asserts a lone replica never produces one.
      return (d) => {
        if (d.pages.length < 2 || !bl) return
        const from = d.pages.find((x) => x.id === pg?.id)
        const to = d.pages[Math.floor(rnd() * d.pages.length)]
        if (!from || !to || from.id === to.id) return
        const kin = new Set([bl.id])
        for (let pass = 0; pass < from.blocks.length; pass++) {
          for (const b of from.blocks) if (b.parent && kin.has(String(b.parent))) kin.add(b.id)
        }
        const moving = from.blocks.filter((b) => kin.has(b.id))
        if (!moving.length) return
        from.blocks = from.blocks.filter((b) => !kin.has(b.id))
        delete moving[0].parent            // the root of the run detaches
        to.blocks.push(...moving)
      }
    case 7: // add a page (sometimes nested)
      return (d) => {
        const id = fresh('np')
        const parent = rnd() < 0.5 && d.pages.length ? d.pages[0].id : undefined
        d.pages.push({ id, title: `Page ${id}`, ...(parent ? { parent } : {}), blocks: [block(fresh('nb'))] })
      }
    case 8: // re-parent a PAGE, refusing a cycle the way editor.ts does
      return (d) => {
        if (d.pages.length < 2) return
        const a = d.pages[Math.floor(rnd() * d.pages.length)]
        const b = d.pages[Math.floor(rnd() * d.pages.length)]
        if (a.id === b.id) return
        // would b end up inside a? walk b's ancestors
        const seen = new Set<string>()
        for (let up: string | undefined = b.id; up && !seen.has(up);
             up = d.pages.find((q) => q.id === up)?.parent as string | undefined) {
          seen.add(up)
          if (up === a.id) return
        }
        a.parent = b.id
        // keep the array in pre-order: a page must follow its parent, and its
        // OWN descendants must follow it — so the whole subtree relocates to
        // just after b
        const kin = new Set([a.id])
        for (let pass = 0; pass < d.pages.length; pass++) {
          for (const q of d.pages) if (q.parent && kin.has(String(q.parent))) kin.add(q.id)
        }
        const moving = d.pages.filter((q) => kin.has(q.id))
        d.pages = d.pages.filter((q) => !kin.has(q.id))
        const bi = d.pages.findIndex((x) => x.id === b.id)
        d.pages.splice(bi + 1, 0, ...moving)
      }
    case 9: // delete a page AND its descendants — the editor cascades
      return (d) => {
        if (d.pages.length < 2) return
        const victim = d.pages[Math.floor(rnd() * d.pages.length)]
        const doomed = new Set([victim.id])
        for (let pass = 0; pass < d.pages.length; pass++) {
          for (const q of d.pages) if (q.parent && doomed.has(String(q.parent))) doomed.add(q.id)
        }
        if (doomed.size >= d.pages.length) return   // never empty the space
        d.pages = d.pages.filter((q) => !doomed.has(q.id))
      }
    case 10: // REMOVE a property — the class that hid two crashes
      return (d) => {
        const p = d.pages.find((x) => x.id === pg?.id)
        const b = p?.blocks.find((x) => x.id === bl?.id)
        if (!b) return
        for (const k of ['done', 'lang', 'open', 'parent']) {
          if (k in b) { delete b[k]; return }
        }
      }
    default: // set a page property
      return (d) => {
        const p = d.pages.find((x) => x.id === pg?.id)
        if (p) p.title = `T${Math.floor(rnd() * 100)}`
      }
  }
}
