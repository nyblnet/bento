// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The agent surface: what `window.bento` reports, and how it is patched.
//
// WHY THIS EXISTS. An agent authoring a space is working blind in a way a human
// author is not. Everything that goes wrong here goes wrong SILENTLY: a link to
// a page that was renamed away still looks like a link in the JSON, a `<p>` in
// a block's html is unwrapped at render with no complaint, an unknown block
// type falls back to its text, an `asset:` reference that nothing points at is
// just megabytes. None of it throws, and none of it is visible in the document
// the agent just wrote. `validate()` is the pass that says so out loud.
//
// The other half is writing. Before this, the only structural verbs were
// `insertBlocks` and `newPage`; everything else meant `loadDoc(JSON.stringify(
// wholeDocument))`, which flattens undo to one entry, clobbers whatever a human
// typed while the agent was thinking, and re-mints nothing but is trusted with
// everything. The verbs here are each ONE undoable step and touch only what
// they name.
//
// THE INVARIANT THAT SHAPES THIS FILE: an agent must not be able to write a
// document this build could not itself have produced. So html goes through the
// sanitizer on the way IN (not only on the way to the screen), a patch value
// that JSON cannot carry is refused rather than silently dropped at save time,
// and a page can never be left with zero blocks — the editor has no way to
// place a caret in one, so it would be a page nobody can ever type in again.
//
// PLAN/APPLY. Every write verb returns a PLAN: it validates against the
// document and hands back a thunk. `store.commit` checkpoints undo BEFORE it
// mutates, so planning inside a commit would mean a refused patch still pushed
// an undo entry that undoes nothing. Planning first also makes the whole write
// path testable in node, where there is no store and no DOM.

import { type SpacesDoc, type Page, type Block, buildIndex, isRemote, newBlock, newPage, uid, descendantsOf } from './model.ts'
import { SPECS, SPEC } from './blocks.ts'
import { sanitizeInline, textOf, inertBody, esc, UNWRAP } from './sanitize.ts'
import { orphanAssets, humanBytes } from './assets.ts'
import {
  type FieldSpec, ISSUE_FIELDS, fieldsOf, fieldByKey, optionOf, propBlock, propHtml, valuesOf, isIssue, headerLength,
} from './fields.ts'

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

// The block REGISTRY is the one list of known types (blocks.ts). A second
// const here would drift the first time someone adds a block type — which is
// precisely what the registry exists to prevent, and validate() reporting a
// real type as unknown would have an agent 'fix' working documents.
const KNOWN_BLOCK_TYPES = SPECS.map((s) => s.type)
const KNOWN = new Set<string>(KNOWN_BLOCK_TYPES)

const words = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0)

const utf8len = (s: string): number =>
  typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length

export interface BlockAt { block: Block; page: Page; index: number }

export function findBlock(doc: SpacesDoc, id: string): BlockAt | null {
  for (const page of doc.pages) {
    const index = page.blocks.findIndex((b) => b.id === id)
    if (index >= 0) return { block: page.blocks[index], page, index }
  }
  return null
}

/**
 * Every block nested under `id`.
 *
 * Delegates to model.ts's ONE rule. It used to sweep the `parent` graph to a
 * fixed point "rather than trusting the order", which is the right instinct and
 * the wrong rule: on a merged document a `parent` cycle makes that sweep return
 * the whole connected component INCLUDING `id` itself, so planRemoveBlocks
 * would delete blocks the caller never named. The positional rule cannot cycle.
 */
function descendants(page: Page, id: string): Set<string> {
  return descendantsOf(page, id)
}

/**
 * Would JSON.stringify carry this value unchanged?
 *
 * A function, a DOM node, a Map or a Date all assign fine and then either
 * VANISH at save time or throw on a cycle — either way the failure surfaces
 * hours later, in the file, with no clue where it came from. The format is
 * additive, so unknown keys are welcome; unknown SHAPES are not.
 */
export function jsonSafe(v: unknown, depth = 0): boolean {
  if (v === null) return true
  const t = typeof v
  if (t === 'string' || t === 'boolean') return true
  if (t === 'number') return Number.isFinite(v as number)
  if (depth > 12) return false
  if (Array.isArray(v)) return v.every((x) => jsonSafe(x, depth + 1))
  if (t === 'object') {
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) return false
    return Object.values(v as Record<string, unknown>).every((x) => jsonSafe(x, depth + 1))
  }
  return false
}

const hasElements = (html: string): boolean =>
  typeof document === 'undefined'
    ? /<[a-z][a-z0-9]*(\s|\/|>)/i.test(html)
    : !!inertBody(html).querySelector('*')

/**
 * The stored form of a block's html, as the EDITOR would have stored it.
 *
 * Rich blocks are sanitized inline html. A `code` block is different: the
 * renderer takes its textContent, and a contentEditable `<code>` stores what
 * you type ESCAPED — so `<div>` in a code block lives in the file as
 * `&lt;div&gt;`. Sanitizing code would delete the sample someone was showing,
 * so code is escaped instead, and only when it actually carries live tags:
 * already-escaped text passes through untouched, which keeps this idempotent
 * (a patch replayed twice must not double-escape).
 */
export function normalizeHtml(html: string, type: string): string {
  if (type === 'code') return hasElements(html) ? esc(html) : html
  return sanitizeInline(html)
}

/** A page title renders as TEXT, so markup in one would show literally. */
export const plainTitle = (v: unknown): string => textOf(String(v ?? ''))

/**
 * A title has to BE a string.
 *
 * `plainTitle` coerces, and that is right for what it was written for: markup
 * pasted into a title, a number someone used for a heading. But coercion
 * applied to the wrong TYPE is not forgiveness, it is a lie —
 * `newPage({ title: 'Tracker' })`, written in the object shape every other verb
 * on this surface takes, made a page called "[object Object]" and reported
 * success. Every other verb here refuses input it cannot honour, and a title is
 * a poor place to start guessing: the page is created either way, so the caller
 * finds out by reading the sidebar.
 *
 * `null`/absent stays legal — that is "no title", and each caller has its own
 * default for it.
 */
export const badTitle = (v: unknown): boolean => v != null && typeof v !== 'string'

// ---------------------------------------------------------------------------
// validate()
// ---------------------------------------------------------------------------

export type Severity = 'error' | 'warning' | 'info'

export interface Finding {
  /** stable machine-readable code, e.g. 'broken-link' */
  code: string
  severity: Severity
  /** what is wrong, in one line, actionable on its own */
  message: string
  /** how to fix it */
  fix: string
  page?: string
  block?: string
  /** the field it is about, when it is about one */
  path?: string
}

export interface ValidateResult {
  /** no errors. Warnings and info do not make a document invalid. */
  ok: boolean
  counts: Record<Severity, number>
  findings: Finding[]
}

/** Inline tags a block may keep (sanitize.ts ALLOWED, lowercased). */
const INLINE_OK = new Set(['b', 'i', 'u', 's', 'em', 'strong', 'code', 'br', 'span', 'mark', 'sub', 'sup', 'a'])
/** Tags the sanitizer unwraps: the tag goes, the words stay (sanitize.ts UNWRAP). */
// Derived from the sanitizer, never restated: this list IS what sanitizeInline
// unwraps, and a copy would drift the moment that policy changes.
const UNWRAPPED = new Set([...UNWRAP].map((t) => t.toLowerCase()))

const TAG_RE = /<\/?([a-z][a-z0-9]*)\b/gi
const LINK_RE = /href\s*=\s*["']([^"']*)["']/gi

/**
 * WHAT IS DELIBERATELY NOT CHECKED: unknown property names.
 *
 * Slides warns about them, because its element schema is closed. This format's
 * unknown fields are a FEATURE — they are how a future build's data survives an
 * older one, and how an agent parks its own metadata on a block. Warning about
 * them would fire on documents that are working exactly as designed, and a
 * validator that cries wolf on good documents is one an agent learns to skip.
 */
export function validateDoc(doc: SpacesDoc): ValidateResult {
  const findings: Finding[] = []
  const add = (f: Finding) => findings.push(f)
  const pages = Array.isArray(doc.pages) ? doc.pages : []
  const assets = doc.assets ?? {}

  if (!pages.length) {
    add({ code: 'no-pages', severity: 'error', message: 'This space has no pages.',
      fix: 'Add at least one page — the reader shows "This space has no pages." until there is one.' })
  }

  // ---- identity ----------------------------------------------------------
  // Every id is unique across the WHOLE document: links, backlinks and (later)
  // collaboration key on them. parseDoc repairs duplicates deterministically,
  // but a repaired id is a NEW id, so whatever pointed at the old one is now
  // pointing somewhere else. Emitting them unique is the only way to keep the
  // references an author wrote.
  const seen = new Set<string>()
  const claim = (id: unknown, where: Pick<Finding, 'page' | 'block'>, what: string) => {
    if (typeof id !== 'string' || !id) {
      add({ ...where, code: 'missing-id', severity: 'error', path: 'id',
        message: `A ${what} has no id.`,
        fix: 'Give it a unique string id. Loading assigns one derived from the bytes, which is not the id you meant to link to.' })
      return
    }
    if (seen.has(id)) {
      add({ ...where, code: 'duplicate-id', severity: 'error', path: 'id',
        message: `The id "${id}" is used more than once. Ids are unique across the whole document, not per page.`,
        fix: 'Rename the later one. Loading repairs it to a derived id, which silently breaks every link that pointed at it.' })
      return
    }
    seen.add(id)
  }
  for (const p of pages) {
    claim(p.id, { page: p.id }, 'page')
    for (const b of Array.isArray(p.blocks) ? p.blocks : []) claim(b.id, { page: p.id, block: b.id }, 'block')
  }

  const pageIx = new Map(pages.map((p) => [p.id, p]))

  // ---- the page tree ------------------------------------------------------
  for (const p of pages) {
    if (p.parent && !pageIx.has(p.parent)) {
      add({ page: p.id, code: 'no-such-page-parent', severity: 'warning', path: 'parent',
        message: `Page "${p.title}" names parent "${p.parent}", which is not a page in this space.`,
        fix: 'Point parent at a real page id, or remove it. Loading drops it and the page becomes a root page.' })
    }
    // a parent CHAIN that loops never reaches the root, so the page is not in
    // the sidebar at all — the one way a page can be genuinely unreachable
    const walked = new Set<string>([p.id])
    for (let up = p.parent; up; up = pageIx.get(up)?.parent) {
      if (walked.has(up)) {
        add({ page: p.id, code: 'page-cycle', severity: 'error', path: 'parent',
          message: `Page "${p.title}" is inside its own subtree, so the tree never reaches the root and the page never appears in the sidebar.`,
          fix: 'Break the loop: give it a parent outside its own descendants, or none.' })
        break
      }
      walked.add(up)
    }
  }
  if (doc.home && !pageIx.has(doc.home)) {
    add({ code: 'no-such-home', severity: 'warning', path: 'home',
      message: `home names "${doc.home}", which is not a page in this space.`,
      fix: 'Set home to a real page id. Readers land on the first page instead, which may not be the one you wrote to be landed on.' })
  }

  // ---- the field schema ----------------------------------------------------
  // Only a DECLARED `doc.fields` can be wrong; a document without one gets
  // DEFAULT_FIELDS, which is code.
  const fieldOf = new Map<string, FieldSpec>()
  for (const f of fieldsOf(doc)) {
    if (f && typeof f.key === 'string' && f.key && typeof f.label === 'string') { fieldOf.set(f.key, f); continue }
    add({ code: 'bad-field-schema', severity: 'error', path: 'fields',
      message: `A field in doc.fields has no string key and label (${JSON.stringify(f ?? null).slice(0, 60)}). Writing a value for it THROWS while building its readable form, so the editor's field picker fails on click and the page does not repaint.`,
      fix: 'Give every entry a string `key`, a string `label`, and a `vt` of select | person | number | date | text | labels.' })
  }

  // ---- pages and blocks ---------------------------------------------------
  const usedAssets = new Set<string>()
  for (const p of pages) {
    const blocks = Array.isArray(p.blocks) ? p.blocks : []
    const own = new Set(blocks.map((b) => b.id))
    /** field keys already seen on THIS page — one value per field, per page */
    const propKeys = new Set<string>()

    if (!blocks.length) {
      // Not cosmetic: the editor's caret, gutter and / menu all hang off a
      // block, so a page with none cannot be typed into at all. The editor
      // never produces one — model.newPage() always mints a paragraph.
      add({ page: p.id, code: 'no-blocks', severity: 'error', path: 'blocks',
        message: `Page "${p.title}" has no blocks, so there is nothing in it to put a caret in — it cannot be typed into.`,
        fix: 'Give it at least one block, e.g. { "type": "p", "html": "" }.' })
    } else if (!blocks.some((b) => textOf(b.html).trim() || b.type === 'image' || b.type === 'pagelink' || b.type === 'divider')) {
      add({ page: p.id, code: 'empty-page', severity: 'info',
        message: `Page "${p.title}" has blocks but no content.`,
        fix: 'Write something, or remove the page. A deliberately blank page (an inbox, a stub) is fine — this is only a note.' })
    }

    for (const b of blocks) {
      const at = { page: p.id, block: b.id }

      if (!KNOWN.has(b.type)) {
        add({ ...at, code: 'unknown-block-type', severity: 'warning', path: 'type',
          message: `"${b.type}" is not a block type this build renders — it falls back to showing its html as plain text.`,
          fix: `Use one of: ${KNOWN_BLOCK_TYPES.join(', ')}. The block and its fields survive untouched either way, so a future build can render it.` })
      }

      if (b.parent && !own.has(b.parent)) {
        add({ ...at, code: 'no-such-block-parent', severity: 'warning', path: 'parent',
          message: `Block parent "${b.parent}" is not a block on this page — nesting only works inside one page.`,
          fix: 'Name a block on the same page, or drop parent. Loading drops it and the block un-nests.' })
      }

      // ---- html ----------------------------------------------------------
      if (typeof b.html === 'string' && b.html.includes('<')) {
        const unwrapped: string[] = []
        const dropped: string[] = []
        for (const m of b.html.matchAll(TAG_RE)) {
          const tag = m[1].toLowerCase()
          if (INLINE_OK.has(tag)) continue
          if (UNWRAPPED.has(tag)) { if (!unwrapped.includes(tag)) unwrapped.push(tag) }
          else if (!dropped.includes(tag)) dropped.push(tag)
        }
        if (b.type === 'code' && (unwrapped.length || dropped.length)) {
          add({ ...at, code: 'markup-in-code', severity: 'warning', path: 'html',
            message: `A code block's html is plain TEXT — the renderer shows its textContent, so <${(unwrapped[0] ?? dropped[0])}> disappears and takes its markup with it.`,
            fix: 'Escape it: write &lt;div&gt; rather than <div>. That is what typing into a code block stores.' })
        } else if (b.type !== 'code') {
          if (unwrapped.length) {
            add({ ...at, code: 'block-markup', severity: 'warning', path: 'html',
              message: `html is inline only, and carries block markup (<${unwrapped.join('>, <')}>). The tags are unwrapped at render and the structure is lost.`,
              fix: 'Split it into separate blocks — structure is Block.type, never markup.' })
          }
          if (dropped.length) {
            add({ ...at, code: 'dropped-markup', severity: 'error', path: 'html',
              message: `<${dropped.join('>, <')}> is outside the inline allowlist, so the tag AND everything inside it is removed before anything is shown. That content is invisible to every reader.`,
              fix: 'Use a block type that can carry it (image, code, quote), or inline tags only: b i u s em strong code a span mark sub sup br.' })
          }
        }
        for (const m of b.html.matchAll(LINK_RE)) {
          const href = m[1]
          if (href.startsWith('#p/')) {
            // The SAME last-slash rule the resolver and the backlink index use
            // (editor.resolveAnchor / model.linkTarget): `#p/<page>/<block>` is
            // a legal href — sanitize.ts admits it and navigation resolves it to
            // the page — so looking the whole remainder up as a page id reported
            // every block anchor as a broken link, at severity ERROR, with a fix
            // ("remove the link") that would destroy a working link. An agent
            // acting on a false error does more damage than one told nothing.
            const raw = href.slice(3)
            const cut = raw.lastIndexOf('/')
            const target = pageIx.has(raw) || cut <= 0 ? raw : raw.slice(0, cut)
            if (!pageIx.has(target)) {
              add({ ...at, code: 'broken-link', severity: 'error', path: 'html',
                message: `Links to page "${target}", which does not exist — the link renders and does nothing when clicked.`,
                fix: 'Point it at a real page id, create that page, or remove the link.' })
            }
          } else if (!/^(https?:|mailto:)/i.test(href)) {
            add({ ...at, code: 'dead-href', severity: 'warning', path: 'html',
              message: `href "${href.slice(0, 40)}" is outside the allowlist (https:, mailto:, #p/), so the sanitizer drops the link and leaves only its text.`,
              fix: 'Use #p/<pageId> for a page in this space, or an https:/mailto: url.' })
          }
        }
      }

      // ---- per type --------------------------------------------------------
      if (b.type === 'pagelink') {
        const target = typeof b.page === 'string' ? b.page : ''
        if (!target || !pageIx.has(target)) {
          add({ ...at, code: 'broken-link', severity: 'error', path: 'page',
            message: `A pagelink card points at "${target || '(nothing)'}", which is not a page — it renders as "(missing page)".`,
            fix: 'Set page to a real page id, or remove the block.' })
        }
      }

      // ---- field values ----------------------------------------------------
      // An ISSUE IS A PAGE and its values are `prop` blocks. Everything that
      // can be wrong here is wrong SILENTLY: the page still renders, the board
      // still draws, and the file still says something — just not what the
      // author meant.
      if (b.type === 'prop') {
        const key = String((b as { key?: unknown }).key ?? '')
        const f = fieldOf.get(key)
        const value = (b as { value?: unknown }).value
        const unset = value === undefined || value === null || value === ''
        if (!key) {
          add({ ...at, code: 'prop-no-key', severity: 'warning', path: 'key',
            message: 'A prop block has no `key`, so it names no field: nothing reads it, the header strip cannot label it, and a board cannot group by it.',
            fix: `Set key to one of: ${[...fieldOf.keys()].join(', ')}.` })
        } else if (!f) {
          // INFO, not a warning: `doc.fields` is additive, so a key this
          // schema does not declare is how a NEWER build's field arrives. The
          // value keeps rendering — the block carries its own html — but this
          // build cannot label it or edit it.
          add({ ...at, code: 'unknown-field-key', severity: 'info', path: 'key',
            message: `"${key}" is not a field in doc.fields, so its value shows only as the text in its html and cannot be edited or grouped by here.`,
            fix: `Add { "key": "${key}", "label": "…", "vt": "text" } to doc.fields, or use one of: ${[...fieldOf.keys()].join(', ')}.` })
        } else if (f.vt === 'select' && !unset && !optionOf(f, value)) {
          // INFO for the same reason: an option a newer build declared must
          // survive this one untouched. It is still worth saying, because the
          // OTHER way to get here is typing a label ('In progress') where an
          // id ('doing') belongs, and then wondering why the board files it
          // under "Other".
          add({ ...at, code: 'unknown-field-value', severity: 'info', path: 'value',
            message: `"${String(value)}" is not one of ${key}'s options, so it is shown verbatim and grouped apart from the rest.`,
            fix: `Use an option id — ${(f.options ?? []).map((o) => o.id).join(', ')} — or declare this one in doc.fields. The value is kept either way.` })
        } else if (b.html !== propHtml(f, value)) {
          // THE ONE THAT MATTERS. `html` is what an older build, a
          // thumbnailer, a grep and the markdown export see, and it is ALL
          // they see. A value edited without it says one thing to this build
          // and another to every one of them, forever, with nothing to notice
          // it — which is the whole degradation guarantee, broken silently.
          //
          // Deliberately NOT checked when the value names no known option
          // (above): the writer knew a label this build does not, so its html
          // is RIGHT and ours would be the guess.
          add({ ...at, code: 'prop-html-stale', severity: 'warning', path: 'html',
            message: `This value's readable form disagrees with its value: html is ${JSON.stringify(b.html ?? '')} where the value reads "${propHtml(f, value)}". An older build, a thumbnailer, a grep and the markdown export show the html — so they all show the wrong value.`,
            fix: 'Write both together: bento.setField(page, key, value) does, and so does the editor. Never assign `value` on its own.' })
        }
        if (key) {
          if (propKeys.has(key)) {
            add({ ...at, code: 'duplicate-prop', severity: 'warning', path: 'key',
              message: `This page carries more than one value for "${key}". A reader takes the LAST one, so the earlier block is a value that is shown in the header, found by search, and ignored by every query.`,
              fix: 'Remove the duplicate block. bento.setField writes all of them at once while they exist, so the page at least cannot disagree with itself.' })
          }
          propKeys.add(key)
        }
      }

      const src = typeof b.src === 'string' ? b.src : ''
      if (src.startsWith('asset:')) usedAssets.add(src.slice(6))
      if (b.type === 'image') {
        if (!src) {
          add({ ...at, code: 'image-no-src', severity: 'error', path: 'src',
            message: 'An image block has no src, so nothing renders.',
            fix: 'Set src to asset:<key>, or a data: URI.' })
        } else if (src.startsWith('asset:') && !(src.slice(6) in assets)) {
          add({ ...at, code: 'missing-asset', severity: 'error', path: 'src',
            message: `src references asset "${src.slice(6)}", which is not in doc.assets — nothing renders.`,
            fix: 'Add the data: URI to doc.assets under that key, or point src at one that is there.' })
        } else if (isRemote(src)) {
          add({ ...at, code: 'remote-image', severity: 'warning', path: 'src',
            message: `src is remote (${src.slice(0, 48)}), so it shows a placeholder naming the host until the reader clicks "Load this image". Opening a document never contacts a third party.`,
            fix: 'Embed the bytes: put the data: URI in doc.assets and reference it as asset:<key>.' })
        }
        if (!String(b.alt ?? '').trim()) {
          add({ ...at, code: 'image-no-alt', severity: 'warning', path: 'alt',
            message: 'This image has no alt text — screen readers get nothing, and alt is what a reader SEES if the image is remote and unloaded.',
            fix: 'Write what the image shows, in a sentence.' })
        }
        if (!b.w || !b.h) {
          add({ ...at, code: 'image-no-size', severity: 'info', path: 'w',
            message: 'No intrinsic w/h, so the page reflows under the reader as the image decodes.',
            fix: 'Set w and h to the image\'s pixel size.' })
        }
      }
    }
  }

  // ---- assets --------------------------------------------------------------
  for (const f of doc.fonts ?? []) {
    if (f.asset && !(f.asset in assets)) {
      add({ code: 'missing-asset', severity: 'error', path: `fonts.${f.family}`,
        message: `Font "${f.family}" names asset "${f.asset}", which is not in doc.assets — the face never loads and text silently falls back.`,
        fix: 'Add the woff2 data: URI under that key, or drop the font entry.' })
    }
    usedAssets.add(f.asset)
  }
  const orphans = orphanAssets(doc)
  if (orphans.length) {
    // ONE finding, not one per key: an author who deleted a photo-heavy page
    // has dozens, and the actionable fact is the total.
    let bytes = 0
    for (const k of orphans) bytes += (assets[k] ?? '').length
    add({ code: 'orphan-asset', severity: 'info', path: 'assets',
      message: `${orphans.length} asset(s) (${humanBytes(bytes)}) are in doc.assets but referenced by nothing.`,
      fix: `Delete these keys to shrink the file: ${orphans.slice(0, 8).join(', ')}${orphans.length > 8 ? ', …' : ''}` })
  }

  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 }
  for (const f of findings) counts[f.severity]++
  return { ok: counts.error === 0, counts, findings }
}

// ---------------------------------------------------------------------------
// outline()
// ---------------------------------------------------------------------------

export interface OutlineHeading { id: string; level: 1 | 2 | 3; text: string }

export interface OutlineNode {
  id: string
  title: string
  /** 0 for a root page */
  depth: number
  parent?: string
  icon?: string
  archived?: true
  /** the landing page */
  home?: true
  blocks: number
  words: number
  headings?: OutlineHeading[]
  /** page ids this page links to, deduped — inline #p/ links and pagelink cards */
  links?: string[]
}

export interface OutlineResult {
  title: string
  docId: string
  pages: number
  blocks: number
  words: number
  tree: OutlineNode[]
}

/**
 * The whole space in one call, in sidebar order.
 *
 * Orientation used to cost one `getPage` per page — for a 200-page handbook
 * that is 200 round trips and the entire document in context, to answer "where
 * does the onboarding material live". Headings carry their block id so the
 * answer is directly actionable: what comes back can be passed straight to
 * updateBlock or moveBlock.
 */
export function outlineDoc(doc: SpacesDoc): OutlineResult {
  const ix = buildIndex(doc)
  const tree: OutlineNode[] = []
  const emitted = new Set<string>()

  const node = (p: Page, depth: number): OutlineNode => {
    const headings: OutlineHeading[] = []
    const links: string[] = []
    let w = 0
    for (const b of p.blocks) {
      const text = textOf(b.html)
      w += words(text)
      if (b.type === 'h1' || b.type === 'h2' || b.type === 'h3') {
        headings.push({ id: b.id, level: Number(b.type.slice(1)) as 1 | 2 | 3, text })
      }
      if (b.type === 'pagelink' && typeof b.page === 'string' && !links.includes(b.page)) links.push(b.page)
      for (const m of (b.html ?? '').matchAll(/href\s*=\s*["']#p\/([^"']+)["']/g)) {
        if (!links.includes(m[1])) links.push(m[1])
      }
    }
    return {
      id: p.id, title: p.title, depth,
      ...(p.parent ? { parent: p.parent } : {}),
      ...(p.icon ? { icon: p.icon } : {}),
      ...(p.archived ? { archived: true as const } : {}),
      ...(doc.home === p.id ? { home: true as const } : {}),
      blocks: p.blocks.length,
      words: w,
      ...(headings.length ? { headings } : {}),
      ...(links.length ? { links } : {}),
    }
  }

  const walk = (parent: string, depth: number) => {
    for (const p of ix.children.get(parent) ?? []) {
      if (emitted.has(p.id)) continue // a parent cycle would otherwise recurse forever
      emitted.add(p.id)
      tree.push(node(p, depth))
      walk(p.id, depth + 1)
    }
  }
  walk('', 0)
  // A page inside its own subtree is in no walk from the root. It is still in
  // the file and still linkable, so it must appear here — an outline that
  // silently omits pages is worse than no outline. validate() names the cycle.
  for (const p of doc.pages) if (!emitted.has(p.id)) tree.push(node(p, 0))

  return {
    title: doc.title,
    docId: doc.docId,
    pages: doc.pages.length,
    blocks: doc.pages.reduce((n, p) => n + p.blocks.length, 0),
    words: tree.reduce((n, t) => n + t.words, 0),
    tree,
  }
}

// ---------------------------------------------------------------------------
// stats()
// ---------------------------------------------------------------------------

export interface AssetStat { key: string; bytes: number; mime: string; used: number }

export interface StatsResult {
  pages: number
  archived: number
  blocks: number
  words: number
  characters: number
  blockTypes: Record<string, number>
  todos: { done: number; total: number }
  assets: { count: number; bytes: number; orphans: number; orphanBytes: number }
  /** UTF-8 bytes of the document JSON. The shell adds a fixed ~600 KB on top. */
  bytes: { document: number; assets: number; text: number }
  /** the ten largest assets, biggest first */
  biggest: AssetStat[]
}

/**
 * Where the weight is — the call that answers "why is this file 30MB".
 *
 * Prose is free (2,000 pages of it is ~5MB); images are the entire story, and
 * an asset nothing references costs exactly as much as one that does. So the
 * breakdown is by asset, largest first, with a use count beside each.
 */
export function statsDoc(doc: SpacesDoc): StatsResult {
  const assets = doc.assets ?? {}
  const blockTypes: Record<string, number> = {}
  const use = new Map<string, number>()
  const todos = { done: 0, total: 0 }
  let blocks = 0
  let wordCount = 0
  let characters = 0
  let textBytes = 0

  for (const p of doc.pages) {
    for (const b of p.blocks) {
      blocks++
      blockTypes[b.type] = (blockTypes[b.type] ?? 0) + 1
      if (b.type === 'todo') { todos.total++; if (b.done) todos.done++ }
      const text = textOf(b.html)
      wordCount += words(text)
      characters += text.length
      textBytes += utf8len(b.html ?? '')
      for (const v of [b.src, (b as Record<string, unknown>).poster]) {
        if (typeof v === 'string' && v.startsWith('asset:')) {
          const k = v.slice(6)
          use.set(k, (use.get(k) ?? 0) + 1)
        }
      }
    }
  }
  for (const f of doc.fonts ?? []) use.set(f.asset, (use.get(f.asset) ?? 0) + 1)

  let assetBytes = 0
  const each: AssetStat[] = []
  for (const [key, value] of Object.entries(assets)) {
    // a data: URI is ASCII, so length IS bytes and this stays O(1) per asset
    const bytes = value.length
    assetBytes += bytes
    each.push({ key, bytes, mime: /^data:([^;,]+)/.exec(value)?.[1] ?? 'unknown', used: use.get(key) ?? 0 })
  }
  each.sort((a, b) => b.bytes - a.bytes)
  const orphans = each.filter((a) => !a.used)

  return {
    pages: doc.pages.length,
    archived: doc.pages.filter((p) => p.archived).length,
    blocks,
    words: wordCount,
    characters,
    blockTypes,
    todos,
    assets: {
      count: each.length,
      bytes: assetBytes,
      orphans: orphans.length,
      orphanBytes: orphans.reduce((n, a) => n + a.bytes, 0),
    },
    bytes: { document: utf8len(JSON.stringify(doc)), assets: assetBytes, text: textBytes },
    biggest: each.slice(0, 10),
  }
}

// ---------------------------------------------------------------------------
// the write verbs
// ---------------------------------------------------------------------------

export type Plan<T> = ({ ok: true; apply: () => void } & T) | PlanError

export interface PlanError {
  ok: false
  /** machine-readable: 'readonly' | 'no-such-block' | 'no-such-page' | 'bad-patch' |
   *  'immutable' | 'not-serializable' | 'cycle' | 'last-page' */
  err: string
  detail?: string
}

const fail = (err: string, detail?: string): PlanError => ({ ok: false, err, ...(detail ? { detail } : {}) })

const isPatch = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** Split a patch into writes and deletes; `null`/`undefined` means delete. */
function splitPatch(patch: Record<string, unknown>): { sets: Record<string, unknown>; dels: string[] } | PlanError {
  const sets: Record<string, unknown> = {}
  const dels: string[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) { dels.push(k); continue }
    if (!jsonSafe(v)) {
      return fail('not-serializable', `"${k}" holds something JSON cannot carry (a function, a DOM node, a Date, a cycle). It would vanish or throw at save time.`)
    }
    sets[k] = v
  }
  return { sets, dels }
}

/**
 * Insert blocks into a page. Ids are minted here, never taken from the caller,
 * so an agent cannot collide with an id that already exists in the document.
 *
 * Because the ids are re-minted, a block in the batch could not previously name
 * another block in the same batch as its `parent` — the id it would have to
 * name does not exist yet. So `parent` is REMAPPED against the batch's own
 * supplied ids: send a toggle and its body in one call and the nesting holds.
 * A parent that resolves to neither the batch nor the page is dropped, because
 * a dangling parent renders un-nested and is deleted at the next load anyway.
 *
 * `afterId` naming a block that is not on the page is an ERROR, not an append.
 * It used to append silently, which put the content somewhere the agent did not
 * ask for and reported success.
 */
/**
 * A `prop` block's readable form, re-derived from its value. ALWAYS.
 *
 * The degradation guarantee — "an older build, a thumbnailer, a grep and the
 * markdown export all see 'Status: In progress'" — was claimed by setField and
 * enforced nowhere else. Measured on this build: `updateBlock(id,{value:'doing'})`
 * left `html:'Status: Todo'`, so the file SAID Todo while its value said doing;
 * and `insertBlocks` with a prop block wrote no `html` at all. A guarantee that
 * one writer keeps and three writers break is not a guarantee.
 *
 * So it is applied where blocks are WRITTEN, not where fields are set: every
 * verb goes through here, and a verb added later gets it without knowing.
 * An unknown key has no spec and keeps whatever it was given — that is a value
 * from a newer build, not an error.
 */
function syncProp(doc: SpacesDoc, b: Block): void {
  if (b.type !== 'prop') return
  const key = String((b as Record<string, unknown>).key ?? '')
  const f = key ? fieldByKey(doc, key) : undefined
  if (!f || typeof f.label !== 'string') return
  ;(b as Record<string, unknown>).html = propHtml(f, (b as Record<string, unknown>).value)
}

export function planInsertBlocks(
  doc: SpacesDoc, pageId: string, afterId: string | null, blocks: unknown,
): Plan<{ ids: string[]; page: string }> {
  if (!Array.isArray(blocks)) return fail('bad-patch', 'pass an array of blocks')
  const page = doc.pages.find((p) => p.id === pageId)
  if (!page) return fail('no-such-page', String(pageId))
  if (afterId != null && !page.blocks.some((b) => b.id === afterId)) {
    return fail('no-such-block', `"${afterId}" is not a block on page "${pageId}"`)
  }

  const remap = new Map<string, string>()
  const made: Block[] = []
  for (const raw of blocks) {
    if (raw != null && !jsonSafe(raw)) return fail('not-serializable', 'a block holds something JSON cannot carry')
    const src = isPatch(raw) ? raw : {}
    const type = typeof src.type === 'string' && src.type ? src.type : 'p'
    const b = { ...src, id: uid('b'), type } as Block
    if (typeof src.id === 'string' && src.id) remap.set(src.id, b.id)
    if (typeof b.html === 'string') b.html = normalizeHtml(b.html, type)
    syncProp(doc, b)   // a field value is nothing without its readable form
    made.push(b)
  }
  for (const b of made) {
    if (typeof b.parent !== 'string') continue
    const within = remap.get(b.parent)
    if (within) b.parent = within
    else if (!page.blocks.some((x) => x.id === b.parent)) delete b.parent
  }

  return {
    ok: true, ids: made.map((b) => b.id), page: page.id,
    apply() {
      const at = afterId == null ? page.blocks.length : page.blocks.findIndex((b) => b.id === afterId) + 1
      page.blocks.splice(at, 0, ...made)
    },
  }
}

/**
 * Change fields on one block. `null` deletes a field.
 *
 * `id` is refused rather than ignored: a silent no-op on the one field that
 * links, backlinks and undo all key on is how an agent ends up believing it
 * renamed something.
 */
export function planUpdateBlock(doc: SpacesDoc, id: string, patch: unknown): Plan<{ id: string; page: string }> {
  if (!isPatch(patch)) return fail('bad-patch', 'patch must be an object of block fields')
  const at = findBlock(doc, id)
  if (!at) return fail('no-such-block', id)
  if ('id' in patch) return fail('immutable', 'a block id never changes — links, backlinks and undo key on it')

  const { block, page } = at
  const type = 'type' in patch ? patch.type : block.type
  if (typeof type !== 'string' || !type) return fail('bad-patch', 'type must be a non-empty string')

  if ('parent' in patch && patch.parent != null) {
    const owner = String(patch.parent)
    if (owner === id) return fail('cycle', 'a block cannot be its own parent')
    if (!page.blocks.some((b) => b.id === owner)) return fail('no-such-block', `parent "${owner}" is not a block on page "${page.id}"`)
    if (descendants(page, id).has(owner)) return fail('cycle', `parent "${owner}" is nested inside "${id}"`)
  }

  const split = splitPatch(patch)
  if ('ok' in split) return split
  const { sets, dels } = split
  if (dels.includes('type')) return fail('bad-patch', 'type cannot be deleted; set it to another type instead')

  if (typeof sets.html === 'string') sets.html = normalizeHtml(sets.html, type)
  else if (sets.type && typeof block.html === 'string' && (sets.type === 'code') !== (block.type === 'code')) {
    // code stores escaped text and everything else stores inline html, so a
    // retype in either direction has to re-normalize what is already there
    sets.html = normalizeHtml(block.html, type)
  }

  return {
    ok: true, id, page: page.id,
    apply() {
      for (const k of dels) delete (block as Record<string, unknown>)[k]
      const retyped = typeof sets.type === 'string' && sets.type !== block.type
      Object.assign(block, sets)
      syncProp(doc, block)   // value and readable form move together, always
      // A TYPE CHANGE RUNS THE REGISTRY'S init, exactly as the editor's setType
      // does. Without it an agent-written callout has no `tone` and an
      // agent-written to-do has no `done` — documents the app itself could not
      // have produced, from the API whose whole promise is that it produces
      // documents the app could have produced.
      if (retyped) SPEC.get(block.type)?.init?.(block)
    },
  }
}

/**
 * Remove blocks, with anything nested under them.
 *
 * The cascade is not a convenience: a toggle's body is `parent`-linked, so
 * deleting the toggle alone would leave blocks pointing at an id that no longer
 * exists — loading re-homes them and they reappear, un-nested, in a document
 * the agent believed it had emptied.
 *
 * A page emptied down to nothing gets one fresh paragraph, because the editor's
 * caret, gutter and / menu all hang off a block: a page with none can never be
 * typed into again.
 */
export function planRemoveBlocks(doc: SpacesDoc, ids: unknown): Plan<{ removed: string[]; missing: string[]; added: string[] }> {
  if (!Array.isArray(ids)) return fail('bad-patch', 'pass an array of block ids')
  const perPage = new Map<Page, Set<string>>()
  const missing: string[] = []
  const removed: string[] = []

  for (const raw of ids) {
    const id = String(raw)
    const at = findBlock(doc, id)
    if (!at) { missing.push(id); continue }
    const set = perPage.get(at.page) ?? new Set<string>()
    perPage.set(at.page, set)
    for (const victim of [id, ...descendants(at.page, id)]) {
      if (!set.has(victim)) { set.add(victim); removed.push(victim) }
    }
  }

  const refills: Array<[Page, Block]> = []
  for (const [page, set] of perPage) {
    if (page.blocks.every((b) => set.has(b.id))) refills.push([page, newBlock('p')])
  }

  return {
    ok: true, removed, missing, added: refills.map(([, b]) => b.id),
    apply() {
      for (const [page, set] of perPage) page.blocks = page.blocks.filter((b) => !set.has(b.id))
      for (const [page, fresh] of refills) page.blocks.push(fresh)
    },
  }
}

export interface MoveTarget {
  /** the page to move to; omit to stay on the current one */
  pageId?: string
  /** place it after this block */
  afterId?: string
  /** place it before this block (wins over afterId) */
  beforeId?: string
  /** re-nest under this block; null clears nesting */
  parent?: string | null
}

/**
 * Move a block, with its nested blocks, within or across pages.
 *
 * Neither anchor given = the end of the page, which is what `insertBlocks(page,
 * null, …)` already means. `beforeId` exists because otherwise the first
 * position in a page is unreachable.
 */
export function planMoveBlock(doc: SpacesDoc, id: string, to: unknown): Plan<{ id: string; pageId: string; moved: string[] }> {
  if (to !== undefined && !isPatch(to)) return fail('bad-patch', 'pass { pageId?, afterId?, beforeId?, parent? }')
  const spec = (to ?? {}) as MoveTarget
  const at = findBlock(doc, id)
  if (!at) return fail('no-such-block', id)
  const from = at.page

  const dest = spec.pageId ? doc.pages.find((p) => p.id === spec.pageId) : from
  if (!dest) return fail('no-such-page', String(spec.pageId))

  const kin = descendants(from, id)
  const group = from.blocks.filter((b) => b.id === id || kin.has(b.id))
  const anchorId = spec.beforeId ?? spec.afterId
  if (anchorId != null) {
    if (kin.has(String(anchorId)) || String(anchorId) === id) return fail('cycle', 'a block cannot be moved inside its own subtree')
    if (!dest.blocks.some((b) => b.id === anchorId)) return fail('no-such-block', `"${anchorId}" is not a block on page "${dest.id}"`)
  }

  let parent: string | null | undefined = spec.parent
  if (parent != null) {
    const owner = String(parent)
    if (owner === id || kin.has(owner)) return fail('cycle', 'a block cannot be nested under itself')
    if (!dest.blocks.some((b) => b.id === owner)) return fail('no-such-block', `parent "${owner}" is not a block on page "${dest.id}"`)
  } else if (parent === undefined) {
    // keep the nesting only while it still names something on the destination
    // page — carried across pages it would be a parent that does not exist,
    // which renders un-nested and is dropped at the next load
    parent = at.block.parent && dest.blocks.some((b) => b.id === at.block.parent) ? at.block.parent : null
  }

  return {
    ok: true, id, pageId: dest.id, moved: group.map((b) => b.id),
    apply() {
      from.blocks = from.blocks.filter((b) => !group.includes(b))
      if (parent) at.block.parent = parent
      else delete at.block.parent
      const anchor = anchorId != null ? dest.blocks.findIndex((b) => b.id === anchorId) : -1
      const cut = anchor < 0 ? dest.blocks.length : spec.beforeId != null ? anchor : anchor + 1
      dest.blocks.splice(cut, 0, ...group)
    },
  }
}

/**
 * Change a page's own fields. `blocks` is refused — block structure goes
 * through insertBlocks/updateBlock/removeBlocks/moveBlock, each of which keeps
 * ids, nesting and undo coherent; assigning the array wholesale keeps none of
 * them.
 */
export function planUpdatePage(doc: SpacesDoc, id: string, patch: unknown): Plan<{ id: string }> {
  if (!isPatch(patch)) return fail('bad-patch', 'patch must be an object of page fields')
  const page = doc.pages.find((p) => p.id === id)
  if (!page) return fail('no-such-page', id)
  if ('id' in patch) return fail('immutable', 'a page id never changes — every #p/ link and backlink keys on it')
  if ('blocks' in patch) return fail('immutable', 'use insertBlocks / updateBlock / removeBlocks / moveBlock for block structure')

  const split = splitPatch(patch)
  if ('ok' in split) return split
  const { sets, dels } = split

  if ('title' in sets) {
    if (badTitle(sets.title)) return fail('bad-title', 'title must be a string')
    // the title renders as textContent, so markup in it would show literally
    sets.title = plainTitle(sets.title)
  }
  if ('parent' in sets) {
    const owner = String(sets.parent)
    if (owner === id) return fail('cycle', 'a page cannot contain itself')
    if (!doc.pages.some((p) => p.id === owner)) return fail('no-such-page', `parent "${owner}"`)
    // BOUNDED. A cycle already in the document (A.parent=B, B.parent=A)
    // survives parseDoc — it only drops parents that name no page — so it
    // arrives from any hand-edited or mailed file, and this walk ran forever:
    // measured, the call never returns and the tab dies with every unsaved edit
    // in it. The reachable sequence is the RECOMMENDED one — validate() reports
    // `page-cycle`, the agent re-homes a page to fix it, and that call hangs.
    // validateDoc next door already carries this set.
    const seen = new Set<string>()
    for (let up: string | undefined = owner; up && !seen.has(up); up = doc.pages.find((p) => p.id === up)?.parent) {
      seen.add(up)
      if (up === id) return fail('cycle', `"${owner}" is inside "${id}"`)
    }
    sets.parent = owner
  }
  if ('archived' in sets) {
    // the editor DELETES the key rather than writing false, and two spellings
    // of "not archived" in saved files is the kind of drift that costs a
    // format its simplicity
    if (sets.archived) sets.archived = true
    else { delete sets.archived; dels.push('archived') }
  }

  return {
    ok: true, id,
    apply() {
      for (const k of dels) delete (page as Record<string, unknown>)[k]
      Object.assign(page, sets)
    },
  }
}

export interface RemovePageOpts {
  /** delete the pages nested under it too; default re-homes them a level up */
  descendants?: boolean
}

/**
 * Remove a page.
 *
 * Children are re-homed to the removed page's parent by default — the editor's
 * rule, and for its reason: deleting a middle page should not silently take a
 * subtree nobody was looking at. `{ descendants: true }` is the explicit way to
 * take the subtree.
 *
 * `links` in the result counts the inbound links that just went dead. There is
 * no undoing someone else's expectation of what a link meant, so the number is
 * reported rather than the removal refused.
 */
export function planRemovePage(doc: SpacesDoc, id: string, opts: RemovePageOpts = {}): Plan<{ removed: string[]; rehomed: number; links: number }> {
  const page = doc.pages.find((p) => p.id === id)
  if (!page) return fail('no-such-page', id)
  if (doc.pages.length <= 1) return fail('last-page', 'a space needs at least one page')

  const doomed = new Set<string>([id])
  if (opts.descendants) {
    let grew = true
    while (grew) {
      grew = false
      for (const p of doc.pages) {
        if (p.parent && doomed.has(p.parent) && !doomed.has(p.id)) { doomed.add(p.id); grew = true }
      }
    }
  }
  if (doomed.size >= doc.pages.length) return fail('last-page', 'that would remove every page in the space')

  const rehome = opts.descendants ? [] : doc.pages.filter((p) => p.parent === id)
  const ix = buildIndex(doc)
  let links = 0
  for (const gone of doomed) {
    for (const ref of ix.backlinks.get(gone) ?? []) if (!doomed.has(ref.pageId)) links++
  }

  return {
    ok: true, removed: [...doomed], rehomed: rehome.length, links,
    apply() {
      for (const p of rehome) {
        if (page.parent) p.parent = page.parent
        else delete p.parent
      }
      doc.pages = doc.pages.filter((p) => !doomed.has(p.id))
      if (doc.home && doomed.has(doc.home)) delete doc.home
    },
  }
}

// ---------------------------------------------------------------------------
// the tracker: the schema, the values, the backlog
// ---------------------------------------------------------------------------
//
// AN ISSUE IS A PAGE (docs/DECISIONS.md, 2026-08-05). Its field values are
// `prop` BLOCKS; the schema they draw on is `doc.fields`. Nothing here is a
// page-level key and nothing is a new page type.
//
// WHY THESE VERBS EXIST AT ALL. An agent could already write a prop block by
// hand through insertBlocks — and get the `html` wrong, which is the one thing
// that must never happen: that string is what an older build, a thumbnailer, a
// grep and the markdown export see, and it is ALL they see. A value written
// without it is a value those readers cannot read. So the only supported way to
// set a value goes through fields.ts propHtml(), exactly as the editor's own
// field picker does, and the two cannot drift because they are the same call.

/** The schema in force, as data. */
export function fieldsReport(doc: SpacesDoc): FieldSpec[] {
  // A COPY. `fieldsOf` hands back DEFAULT_FIELDS itself when the document
  // declares no schema of its own, and that array is module state shared by
  // every document opened in this session — one `bento.fields()[0].options.pop()`
  // would edit the schema of documents that have not been loaded yet.
  return JSON.parse(JSON.stringify(fieldsOf(doc))) as FieldSpec[]
}

export interface FieldWarning {
  code: 'unknown-option'
  key: string
  detail: string
  /** the ids that ARE options, so the caller can correct itself */
  options: string[]
}

/**
 * Is this a value the field's own options know?
 *
 * DELIBERATELY A WARNING, NOT A REFUSAL. The format is permanent and additive:
 * a status a NEWER build declared must round-trip through this one verbatim,
 * and a verb that refused it would make an older build unable to edit a
 * document a newer one wrote — the exact failure the additivity rule exists to
 * prevent. But an agent typing 'In progress' where the option id is 'doing' has
 * made a mistake, and silence would leave it believing otherwise: the value
 * would be stored, the board would file it under "Other", and nothing would
 * have said so. So it is written AND reported, with the ids listed.
 *
 * An empty value is "not set", never an unknown option — the editor itself
 * writes `''` for a select with no default (fields.ts `def`), so flagging it
 * would fire on documents this build produced.
 */
function optionWarning(f: FieldSpec, value: unknown): FieldWarning | undefined {
  if (f.vt !== 'select' || value === '' || value === null || value === undefined) return undefined
  if (optionOf(f, value)) return undefined
  const options = (f.options ?? []).map((o) => o.id)
  return {
    code: 'unknown-option', key: f.key, options,
    detail: `"${String(value)}" is not one of ${f.key}'s options (${options.join(', ')}). It was written unchanged — the format keeps a value a newer build may have declared — but if you meant an existing option, use its id, not its label.`,
  }
}

/** ONE refusal, worded once: both write verbs reject the same mistake. */
const noSuchField = (k: string, schema: FieldSpec[]): PlanError =>
  fail('no-such-field', `"${k}" is not a field in this space. The schema is doc.fields, which declares: ${schema.map((x) => x.key).join(', ')}. Add the field there first — a value whose field nothing declares cannot be labelled, edited or grouped by.`)

export interface SetFieldResult {
  pageId: string
  key: string
  value: unknown
  /** the readable form written with it — what an older build shows */
  html?: string
  /** the prop blocks that now hold the value (or that were just removed) */
  blocks: string[]
  /** the page had no value for this field and one was added to the header */
  created: boolean
  /** the value was cleared: those prop blocks are gone */
  removed: boolean
  warning?: FieldWarning
}

/**
 * Set one field on one page — the ONE undoable step that writes a field value.
 *
 * `null` (or `undefined`) CLEARS the field: the prop block goes, which is the
 * convention the patch verbs already use, and is how a page stops being an
 * issue (clear its status and it is a document again, body intact). Clearing a
 * field that is not set is not an error; the call is idempotent.
 *
 * The page need not already be an issue. Setting `status` on any page is
 * precisely what makes it one — there is no flag to set and no type to change.
 */
export function planSetField(doc: SpacesDoc, pageId: string, key: unknown, value: unknown): Plan<SetFieldResult> {
  const page = doc.pages.find((p) => p.id === pageId)
  if (!page) return fail('no-such-page', String(pageId))
  const k = String(key ?? '')
  const schema = fieldsOf(doc)
  const f = schema.find((x) => x.key === k)
  if (!f) return noSuchField(k, schema)
  if (value !== null && value !== undefined && !jsonSafe(value)) {
    return fail('not-serializable', `the value for "${k}" holds something JSON cannot carry (a function, a DOM node, a Date, a cycle). It would vanish or throw at save time.`)
  }

  // Normally exactly one. A page carrying TWO prop blocks for one key is a
  // defect validate() reports as `duplicate-prop` — and while it exists a
  // reader takes the LAST (fields.ts valuesOf), so writing only the first would
  // be a set that changes nothing anyone can see, and reports success.
  const mine = page.blocks.filter((b) => b.type === 'prop' && (b as { key?: unknown }).key === k)

  if (value === null || value === undefined) {
    return {
      ok: true, pageId: page.id, key: k, value: null,
      blocks: mine.map((b) => b.id), created: false, removed: true,
      apply() { page.blocks = page.blocks.filter((b) => !mine.includes(b)) },
    }
  }

  const html = propHtml(f, value)
  const fresh = mine.length ? null : propBlock(f, value, uid('b'))
  const warning = optionWarning(f, value)
  return {
    ok: true,
    pageId: page.id, key: k, value, html,
    blocks: fresh ? [fresh.id] : mine.map((b) => b.id),
    created: !!fresh, removed: false,
    ...(warning ? { warning } : {}),
    apply() {
      // VALUE AND html TOGETHER, always, through propHtml — the whole reason
      // this verb exists instead of an insertBlocks the caller writes itself.
      for (const b of mine) {
        ;(b as Record<string, unknown>).value = value
        b.html = html
      }
      // A new value joins the HEADER STRIP: prop blocks before the first
      // non-prop block are the header, by position (render.ts), so appending
      // one to the end of the page would leave a field stranded under the prose.
      if (fresh) page.blocks.splice(headerLength(page), 0, fresh)
    },
  }
}

export interface IssueReport {
  id: string
  title: string
  /** the href an inline link would use: `#p/<id>` */
  url: string
  archived?: true
  /**
   * The PHASE of its status (FieldOption.group) — what makes "open" mean
   * something without anyone configuring a filter. `'unknown'` when the status
   * names no option this schema declares: never silently folded in with the
   * rest, because that is exactly the value a newer build wrote.
   */
  group?: string
  /** every field value on the page, by key */
  fields: Record<string, unknown>
}

export interface IssueQuery {
  /**
   * Field equality. `{ status: 'todo' }`, an array for any-of
   * (`{ status: ['backlog', 'todo'] }`), `null` for "not set" — which covers
   * both an absent prop block and an empty one, because the editor writes `''`
   * for a field it has seeded and nobody has filled in.
   */
  where?: Record<string, unknown>
  /**
   * Status phase: 'unstarted' | 'started' | 'done' | 'cancelled' | 'unknown',
   * an array of those, or 'open'.
   */
  group?: string | string[]
  /** include archived issues too; they are excluded by default */
  archived?: boolean
}

const FINISHED = new Set(['done', 'cancelled'])

/** Compared as TEXT, so `3` and `"3"` are the same estimate. This document is
 *  hand-written JSON as often as not, and a filter that missed on the type of a
 *  number would look exactly like an empty backlog. */
function matches(actual: unknown, want: unknown): boolean {
  if (Array.isArray(want)) return want.some((w) => matches(actual, w))
  if (want === null || want === undefined) return actual === undefined || actual === null || actual === ''
  return String(actual ?? '') === String(want)
}

/**
 * The backlog, as data.
 *
 * One call rather than a page-by-page scan: "everything unstarted and
 * unassigned" is `issues({ group: 'open', where: { assignee: null } })`.
 */
export function issuesReport(doc: SpacesDoc, query: IssueQuery = {}): IssueReport[] {
  const status = fieldsOf(doc).find((f) => f.key === 'status')
  const want = query.group == null ? null
    : (Array.isArray(query.group) ? query.group : [query.group]).map(String)
  const out: IssueReport[] = []

  for (const page of doc.pages) {
    if (!isIssue(page)) continue
    if (page.archived && !query.archived) continue
    const values = valuesOf(page)
    const raw = values.get('status')
    const opt = status && optionOf(status, raw)
    // An UNSET status is not an UNKNOWN one. Reporting 'unknown' for a field
    // nobody has filled in tells an agent the value came from a build we do not
    // understand, when in fact there is no value — and those want opposite
    // handling: one is "leave it alone", the other is "this needs triaging".
    const group = raw === undefined || raw === null || raw === ''
      ? undefined
      : opt ? opt.group : 'unknown'

    // OPEN MEANS NOT FINISHED — one predicate, so a status with no group and a
    // status this build has never heard of both count as work. That is the safe
    // direction: an issue wrongly shown in a backlog costs a glance, an issue
    // wrongly hidden from one costs the issue.
    if (want && !want.some((g) => (g === 'open' ? !(group && FINISHED.has(group)) : g === group))) continue

    let keep = true
    for (const [k, w] of Object.entries(query.where ?? {})) {
      if (!matches(values.get(k), w)) { keep = false; break }
    }
    if (!keep) continue

    out.push({
      id: page.id, title: page.title, url: `#p/${page.id}`,
      ...(page.archived ? { archived: true as const } : {}),
      ...(group ? { group } : {}),
      fields: Object.fromEntries(values),
    })
  }
  return out
}

export interface NewIssueResult {
  id: string
  blocks: string[]
  warnings?: FieldWarning[]
}

/**
 * A new issue: one page, its fields already on it, in ONE undoable step.
 *
 * `title` and `parent` are the page's; every OTHER key is a field key, and one
 * that is not in the schema is REFUSED rather than parked on the page. Unknown
 * keys in a DOCUMENT are a feature — they are how a future build's data
 * survives this one — but an unknown key in an ARGUMENT is a typo, and an agent
 * that wrote `{ prioritty: 'high' }` would otherwise be told it had set a
 * priority it had not set.
 *
 * The page ends with an empty paragraph, exactly as ⌘⇧I does: a page whose
 * every block is a prop has nowhere to put a caret and nowhere to write the
 * issue down.
 */
export function planNewIssue(doc: SpacesDoc, spec: unknown): Plan<NewIssueResult> {
  if (spec !== undefined && !isPatch(spec)) return fail('bad-patch', 'pass { title?, parent?, ...fieldValues }')
  const src = (spec ?? {}) as Record<string, unknown>
  if (badTitle(src.title)) return fail('bad-title', 'title must be a string')
  const parent = src.parent == null ? '' : String(src.parent)
  if (parent && !doc.pages.some((p) => p.id === parent)) return fail('no-such-page', `parent "${parent}"`)

  const schema = fieldsOf(doc)
  const values: Record<string, unknown> = {}
  const warnings: FieldWarning[] = []
  for (const [k, v] of Object.entries(src)) {
    if (k === 'title' || k === 'parent') continue
    const f = schema.find((x) => x.key === k)
    if (!f) return noSuchField(k, schema)
    if (v !== null && v !== undefined && !jsonSafe(v)) return fail('not-serializable', `the value for "${k}" holds something JSON cannot carry`)
    values[k] = v ?? ''
    const w = optionWarning(f, values[k])
    if (w) warnings.push(w)
  }

  const page = newPage(plainTitle(src.title) || 'New issue', parent ? { parent } : {})
  // The SEED LIST is fields.ts's, never a second copy here: a fresh issue from
  // an agent and a fresh issue from ⌘⇧I must carry the same fields, or one of
  // them makes an issue a human cannot assign — there is no "add a field"
  // gesture, because `prop` is unlisted in the / menu on purpose.
  const seed = schema.filter((f) => ISSUE_FIELDS.includes(f.key) || f.key in values)

  // A NEW ISSUE MUST BE AN ISSUE. A space that declares its own schema without
  // a `status` seeded nothing recognisable: the verb returned ok, and the page
  // it made was invisible to issues(), to every board, and to a follow-up
  // setField('status') that then failed `no-such-field`. Reporting success for
  // a page that is not an issue is worse than refusing to make one.
  if (!seed.some((f) => f.key === 'status')) {
    return fail('no-status-field',
      'this space declares no `status` field, and a page is an issue because it has one — '
      + 'add a status field to doc.fields (see bento.fields()) before creating issues')
  }

  const props = seed
    .map((f) => propBlock(f, f.key in values ? values[f.key] : (f.def ?? ''), uid('b')))
  page.blocks = [...props, newBlock('p')]

  return {
    ok: true, id: page.id, blocks: page.blocks.map((b) => b.id),
    ...(warnings.length ? { warnings } : {}),
    apply() { doc.pages.push(page) },
  }
}
