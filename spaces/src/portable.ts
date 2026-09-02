// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The two portability exits: a page LEAVES as its own space, and a space
// ARRIVES nested inside this one.
//
// PURE, and deliberately DOM-FREE, for the same reason markdown.ts is: the
// cases that decide whether either direction loses data — an id that collides,
// a link that points outside what travelled, two spaces holding the same image
// under different keys — are cheap to assert in node under
// `scripts/test-spaces-model.ts` and miserable to click through. The browser
// halves (writing a shell, reading a file, sanitizing, committing) live in
// editor.ts and main.ts.
//
// IT DOES NOT SANITIZE. Both directions move html between documents; the
// importer runs `sanitizeInline` over every grafted block before it reaches the
// document, exactly as the Markdown import does. One security gate, in the
// place that already has the tests for it.

// `.ts` extensions ON PURPOSE: node resolves this module directly for the rig.
import { type SpacesDoc, type Page, type Block, repairId, pageAssetKeys } from './model.ts'
import { esc } from './sanitize.ts'

/** An `<a href="#p/…">` in a block, however many attributes it carries. */
const PAGE_LINK = /<a\s([^>]*?)href="#p\/([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g

/**
 * What a link that no longer has a target becomes.
 *
 * The literal `[[Name]]` the Markdown importer leaves behind, and for the same
 * reason it does: text that still says which page was meant is honest,
 * searchable, exports as correct Markdown, and RE-RESOLVES if the two halves
 * are ever brought back together (planImport resolves `[[wikilinks]]` against
 * the pages a space already has). A silent unlink is a lie about what the file
 * said; a link left pointing at an id that is not in the file is worse — it
 * looks live and goes nowhere, and after an import it can even land on a
 * STRANGER page that happens to hold that id.
 */
function literalLink(name: string, label: string): string {
  const shown = esc(name)
  return label === shown || !label ? `[[${shown}]]` : `[[${shown}|${label}]]`
}

/**
 * Rewrite every `#p/<id>` in one block's html.
 *
 * `map` answers with the id the link should carry now, or `null` to make it
 * text. Returns the html and how many of each happened.
 */
function relink(
  html: string,
  map: (target: string) => { id: string } | { text: string },
): { html: string; changed: number; cut: number } {
  let changed = 0
  let cut = 0
  const out = html.replace(PAGE_LINK, (whole, pre: string, target: string, post: string, label: string) => {
    const r = map(target)
    if ('id' in r) {
      if (r.id === target) return whole
      changed++
      return `<a ${pre}href="#p/${esc(r.id)}"${post}>${label}</a>`
    }
    cut++
    return literalLink(r.text, label)
  })
  return { html: out, changed, cut }
}

/** Every asset key a block references (`asset:<key>`). */
function assetKeysOf(b: Block): string[] {
  const out: string[] = []
  for (const v of [b.src, (b as Record<string, unknown>).poster]) {
    if (typeof v === 'string' && v.startsWith('asset:')) out.push(v.slice(6))
  }
  return out
}

const rewriteAssetRefs = (b: Block, map: Map<string, string>): void => {
  for (const k of ['src', 'poster'] as const) {
    const v = (b as Record<string, unknown>)[k]
    if (typeof v === 'string' && v.startsWith('asset:')) {
      const next = map.get(v.slice(6))
      if (next) (b as Record<string, unknown>)[k] = `asset:${next}`
    }
  }
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

// ---------------------------------------------------------------------------
// OUT: a page (and, by choice, its subtree) as its own space
// ---------------------------------------------------------------------------

export interface ExtractStats {
  pages: number
  blocks: number
  assets: number
  /** links that pointed OUT of what travelled, and are now text */
  unlinked: number
}

export interface ExtractOpts {
  /** carry the pages nested under the root as well */
  subtree?: boolean
  /**
   * The new document's id — SUPPLIED, never minted here.
   *
   * A fresh `docId` is not cosmetic. `docId` keys autosave recovery and, with
   * the credentials below, collaboration identity: an extract that kept its
   * parent's id is a FORK of that document, and opening it joins the parent's
   * room and syncs a three-page extract over a two-hundred-page space. The
   * caller passes the value so this stays pure and the rig can assert on it.
   */
  docId: string
  /** ISO stamp for `modified`; the caller owns the clock */
  now?: string
}

/**
 * The pages that travel: `rootId`, plus its descendants when asked.
 *
 * Walks the page tree by `parent`, carrying a visited set — store.ts records
 * why (two people dragging pages onto each other converge on a cycle, and a
 * subtree walk from inside one recurses until the stack gives out).
 */
export function subtreeIds(doc: SpacesDoc, rootId: string, subtree = true): string[] {
  const out = [rootId]
  if (!subtree) return out
  const seen = new Set(out)
  for (let i = 0; i < out.length; i++) {
    const parent = out[i]
    for (const p of doc.pages) {
      if (p.parent === parent && !seen.has(p.id)) { seen.add(p.id); out.push(p.id) }
    }
  }
  // document order, so the extract reads the way the sidebar did
  const order = new Map(doc.pages.map((p, i) => [p.id, i]))
  return out.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
}

/**
 * A page (and its subtree) as a complete, self-contained bento/spaces document.
 *
 * Everything the format guarantees survives: unknown top-level fields, unknown
 * per-page fields and unknown block types are all carried through untouched
 * (PLATFORM §3). Exactly three things are deliberately NOT:
 *
 *   · `collab` — every credential in it. The room, the read key, the writer and
 *     owner private keys and the invite chain are the capability to read and
 *     write the WHOLE space; an extract of three pages that carries them hands
 *     the recipient the other two hundred. The copy paths strip private keys
 *     for reader copies; an extract is a different document, so it keeps none.
 *   · `template` — it re-mints `docId` on every open (model.ts), and a document
 *     that was just given a deliberate identity must keep it.
 *   · assets nobody in the extract references. An export that carries the whole
 *     document's images is a copy with pages hidden, not an extract — and the
 *     images are the only thing in a space with real weight.
 *
 * `readonly` IS kept: a reading copy that extracts into an editable file would
 * quietly upgrade what the sender chose.
 */
export function extractSpace(
  doc: SpacesDoc,
  rootId: string,
  opts: ExtractOpts,
): { doc: SpacesDoc; stats: ExtractStats } {
  const ids = subtreeIds(doc, rootId, opts.subtree !== false)
  const inSet = new Set(ids)
  const titleOf = new Map(doc.pages.map((p) => [p.id, p.title]))
  const pages: Page[] = doc.pages.filter((p) => inSet.has(p.id)).map((p) => clone(p))

  let unlinked = 0
  const target = (id: string): { id: string } | { text: string } =>
    inSet.has(id) ? { id } : { text: titleOf.get(id) ?? id }

  for (const p of pages) {
    // the root becomes the home page of its own document, so it has no parent;
    // a child whose parent did not travel is re-homed onto the root rather than
    // left dangling (parseDoc drops such a parent anyway — doing it here keeps
    // the shape the author saw)
    if (p.id === rootId) delete p.parent
    else if (p.parent && !inSet.has(p.parent)) p.parent = rootId
    for (const b of p.blocks) {
      if (b.html) {
        const r = relink(b.html, target)
        b.html = r.html
        unlinked += r.cut
      }
      if (b.type === 'pagelink' && typeof b.page === 'string' && !inSet.has(b.page)) {
        // a pagelink IS its target; with the target gone there is no block left
        // to be, so it becomes the same honest text an inline link becomes
        unlinked++
        b.type = 'p'
        b.html = literalLink(titleOf.get(b.page) ?? b.page, '')
        delete b.page
      }
    }
  }

  // ---- assets: only what travelled references ------------------------------
  const used = new Set<string>()
  for (const p of pages) {
    for (const k of pageAssetKeys(p)) used.add(k)
    for (const b of p.blocks) for (const k of assetKeysOf(b)) used.add(k)
  }
  // Fonts are the exception, and they are not an exception to the rule: a
  // `@font-face` the theme names is referenced by every page in the document.
  // Dropping it changes how the extract LOOKS, which an export must not do.
  const fonts = (doc.fonts ?? []).filter((f) => (doc.assets ?? {})[f.asset] !== undefined)
  for (const f of fonts) used.add(f.asset)
  const assets: Record<string, string> = {}
  for (const k of used) {
    const v = (doc.assets ?? {})[k]
    if (v !== undefined) assets[k] = v
  }

  const out: SpacesDoc = {
    ...clone(doc),
    docId: opts.docId,
    title: titleOf.get(rootId) || doc.title,
    pages,
    // The home page MUST exist in the new file. `homePage()` falls back to
    // pages[0], so a stale `home` would open on whichever page happened to sort
    // first — silently the wrong page, in the one file where the author chose.
    home: rootId,
    ...(Object.keys(assets).length ? { assets } : {}),
    ...(fonts.length ? { fonts } : {}),
    modified: opts.now ?? new Date().toISOString(),
  }
  if (!Object.keys(assets).length) delete out.assets
  if (!fonts.length) delete out.fonts
  delete out.collab
  delete out.template

  return {
    doc: out,
    stats: {
      pages: pages.length,
      blocks: pages.reduce((n, p) => n + p.blocks.length, 0),
      assets: Object.keys(assets).length,
      unlinked,
    },
  }
}

// ---------------------------------------------------------------------------
// IN: another space, nested under a page of this one
// ---------------------------------------------------------------------------

export interface GraftStats {
  pages: number
  blocks: number
  /** ids this space already used, so the arriving copy was renamed */
  renamed: number
  /** links inside the import, repointed at the renamed ids */
  relinked: number
  /** links that named nothing in the imported file, and are now text */
  dropped: number
  /** images that travelled (a shared image is stored once, not twice) */
  assets: number
}

export interface GraftPlan {
  pages: Page[]
  /** asset entries to add — already keyed so nothing in the host is overwritten */
  assets: Record<string, string>
  fonts: NonNullable<SpacesDoc['fonts']>
  stats: GraftStats
}

/**
 * Another space's pages, ready to be pushed into this one under `under`.
 *
 * ID POLICY: an arriving id is KEPT when this space does not already use it,
 * and only a collision is renamed — the same rule parseDoc applies to a
 * duplicate within one file (first occurrence keeps the id). Keeping ids where
 * it is safe means a link, a backlink and a future CRDT node key all survive an
 * import that changes nothing; renaming everything unconditionally would churn
 * every id in a file for no reason.
 *
 * A replacement is derived from the BYTES with model.ts's `repairId`, not from
 * `Math.random` and not from `docId` — the reasoning is written beside that
 * function and applies unchanged here: two readers must be able to derive the
 * same answer from the same input, and `docId` moves under `template: true`.
 * Deterministic also means this rig can assert on it.
 *
 * Ids are unique across the WHOLE document and are never reused, so pages and
 * blocks are claimed from ONE namespace.
 */
export function planGraft(
  host: SpacesDoc,
  incoming: SpacesDoc,
  opts: { under?: string } = {},
): GraftPlan {
  const taken = new Set<string>()
  for (const p of host.pages) {
    taken.add(p.id)
    for (const b of p.blocks) taken.add(b.id)
  }

  let renamed = 0
  const idMap = new Map<string, string>()
  const claim = (id: string, scope: string, ordinal: number, content: string): string => {
    if (id && !taken.has(id)) { taken.add(id); idMap.set(id, id); return id }
    let salt = 0
    let next = repairId(scope, ordinal, content, salt)
    while (taken.has(next)) next = repairId(scope, ordinal, content, ++salt)
    taken.add(next)
    if (id) { idMap.set(id, next); renamed++ }
    return next
  }

  const pages: Page[] = incoming.pages.map((p) => clone(p))
  // pages first, in pre-order, so a block's owning page id is final before its
  // own replacement is derived from it — parseDoc claims ids the same way
  pages.forEach((p, pi) => {
    const own = p.id
    p.id = claim(own, String(p.parent ?? ''), pi, p.title ?? '')
    p.blocks.forEach((b, bi) => {
      b.id = claim(b.id, p.id, bi, `${b.type}${b.html ?? ''}`)
    })
  })

  const arrived = new Set(incoming.pages.map((p) => p.id))
  const titleOf = new Map(incoming.pages.map((p) => [p.id, p.title]))

  // parents: inside the import they follow the rename; a root page is re-homed
  // under the chosen page of THIS space
  const hostPages = new Set(host.pages.map((p) => p.id))
  const under = opts.under && hostPages.has(opts.under) ? opts.under : undefined
  pages.forEach((p, i) => {
    const parent = incoming.pages[i].parent
    if (parent && arrived.has(parent)) p.parent = idMap.get(parent) ?? parent
    else if (under) p.parent = under
    else delete p.parent
  })

  // ---- links ---------------------------------------------------------------
  let relinked = 0
  let dropped = 0
  const target = (id: string): { id: string } | { text: string } => {
    if (!arrived.has(id)) return { text: titleOf.get(id) ?? id }
    return { id: idMap.get(id) ?? id }
  }
  for (const p of pages) {
    for (const b of p.blocks) {
      if (b.html) {
        const r = relink(b.html, target)
        b.html = r.html
        dropped += r.cut
        relinked += r.changed
      }
      if (b.type === 'pagelink' && typeof b.page === 'string') {
        if (arrived.has(b.page)) {
          const next = idMap.get(b.page) ?? b.page
          if (next !== b.page) { b.page = next; relinked++ }
        } else {
          dropped++
          b.type = 'p'
          b.html = literalLink(titleOf.get(b.page) ?? b.page, '')
          delete b.page
        }
      }
    }
  }

  // ---- assets --------------------------------------------------------------
  //
  // CONTENT-ADDRESSED IS WHAT MAKES THIS SAFE: assets.ts derives a key from a
  // hash of the bytes, so the same image in two spaces already carries the same
  // key and a merge is a no-op rather than a duplicate. The two ways a key can
  // clash are handled the way internAsset handles them — BYTE-COMPARE on a key
  // hit, and mint a `~n` variant when the bytes differ (a hash collision, or a
  // hand-written file). Trusting the key alone would replace the host's image
  // with the visitor's, silently, in a file the author then mails.
  const assets: Record<string, string> = {}
  const keyMap = new Map<string, string>()
  const inAssets = incoming.assets ?? {}
  const hostAssets = host.assets ?? {}
  const intern = (key: string): void => {
    if (keyMap.has(key)) return
    const bytes = inAssets[key]
    if (bytes === undefined) return           // a reference with no image behind it
    let k = key
    for (let n = 1; ; n++) {
      const held = hostAssets[k] ?? assets[k]
      if (held === undefined) break           // free
      if (held === bytes) { keyMap.set(key, k); return }  // genuinely the same image
      k = `${key}~${n}`
    }
    assets[k] = bytes
    keyMap.set(key, k)
  }
  for (const p of pages) {
    for (const k of pageAssetKeys(p)) intern(k)
    for (const b of p.blocks) for (const k of assetKeysOf(b)) intern(k)
  }

  const haveFont = new Set((host.fonts ?? []).map((f) => `${f.family}|${f.weight ?? ''}|${f.style ?? ''}`))
  const fonts: NonNullable<SpacesDoc['fonts']> = []
  for (const f of incoming.fonts ?? []) {
    if (haveFont.has(`${f.family}|${f.weight ?? ''}|${f.style ?? ''}`)) continue
    intern(f.asset)
    const mapped = keyMap.get(f.asset)
    if (mapped) fonts.push({ ...f, asset: mapped })
  }

  for (const p of pages) {
    // a grafted page's cover follows its bytes to their new key, like any other
    // reference — otherwise a page pasted into another space keeps a cover that
    // points at nothing
    const c = (p as { cover?: unknown }).cover
    if (typeof c === 'string' && c.startsWith('asset:')) {
      const next = keyMap.get(c.slice(6))
      if (next) p.cover = `asset:${next}`
    }
    for (const b of p.blocks) rewriteAssetRefs(b, keyMap)
  }

  return {
    pages,
    assets,
    fonts,
    stats: {
      pages: pages.length,
      blocks: pages.reduce((n, p) => n + p.blocks.length, 0),
      renamed,
      relinked,
      dropped,
      assets: Object.keys(assets).length,
    },
  }
}
