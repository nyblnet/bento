// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Markdown → the bento/spaces block model: how an existing pile of notes
// becomes a space. Nobody adopts a notes app they cannot get their notes into.
//
// PURE, and deliberately DOM-FREE, so the whole of it runs in node under
// `scripts/test-spaces-model.ts`. The cases that decide whether an Obsidian
// vault survives the trip — wikilinks across hundreds of files, frontmatter,
// nested lists, a folder tree — are cheap to assert there and miserable to
// click through in a browser.
//
// IT DOES NOT SANITIZE. Raw inline html is reduced to an allowlisted skeleton
// here so this module needs no parser; `sanitizeInline` — the app's real
// policy, with a real one — runs over every block in the importer afterwards.
// One security gate, in the place that already has the tests for it.

// `.ts` extensions ON PURPOSE: this module is imported directly by
// `scripts/test-spaces-model.ts`, which node resolves without a bundler.
import { type Block, type Page, uid, writeTable } from './model.ts'
import { esc } from './sanitize.ts'
import { keepClasses } from './marks.ts'

/** A tab indents four columns. Nothing here depends on the exact number; it
 *  only has to be the same everywhere so nesting is consistent. */
const TAB = '    '

/** Inline tags a raw html span may keep — sanitize.ts's ALLOWED, carrying no
 *  attributes except a palette `class` on span/mark (see cleanRawTag).
 *  Restated rather than imported because that module's set is a DOM-side
 *  control and this one is a parser convenience; if they ever diverge, the
 *  sanitizer still wins, because it runs last. */
const INLINE_OK = new Set(['b', 'i', 'u', 's', 'em', 'strong', 'code', 'br', 'span', 'mark', 'sub', 'sup'])

/**
 * The href a wikilink carries between parsing and resolution.
 *
 * `#w/` never reaches a saved document: `resolveWikilinks` rewrites every one
 * before the blocks are committed, and `sanitizeInline` would strip any that
 * somehow survived — its allowlist is `https?:`, `mailto:` and `#p/`. So the
 * worst a bug in resolution can do is lose a link; it can never write one that
 * points somewhere unexpected.
 */
const WIKI_SCHEME = '#w/'

// ---- inline ----------------------------------------------------------------

/** One raw html tag, reduced to what the model allows, or null to drop it. */
function cleanRawTag(tag: string): string | null {
  const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)\/?>$/.exec(tag)
  if (!m) return null
  const close = m[1] === '/'
  const name = m[2].toLowerCase()
  if (name === 'a') {
    if (close) return '</a>'
    const h = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[3])
    const url = (h?.[1] ?? h?.[2] ?? h?.[3] ?? '').trim()
    return /^(https?:|mailto:)/i.test(url) ? `<a href="${esc(url)}">` : null
  }
  if (!INLINE_OK.has(name)) return null
  // A PALETTE CLASS SURVIVES ON SPAN AND MARK. Colour has no markdown syntax
  // at all, so the exporter writes it as raw inline html — and an importer that
  // threw the class away would make "export, edit the .md, import" a
  // colour-stripping round trip, which is the failure mode the export was
  // written to avoid in the first place.
  if (!close && (name === 'span' || name === 'mark')) {
    const c = /class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[3])
    const kept = keepClasses(c ? (c[1] ?? c[2] ?? c[3] ?? '') : '')
    if (kept) return `<${name} class="${esc(kept)}">`
  }
  return close ? `</${name}>` : `<${name}>`
}

/**
 * Inline markdown → inline html.
 *
 * Everything this emits as MARKUP is parked in a placeholder first, so the
 * final pass can escape the whole remaining string in one go: text the author
 * typed can never turn into a tag, and a tag we generated can never be
 * double-escaped. Placeholders are `\u0000<n>\u0000` — digits, so they survive
 * escaping untouched, and the input's own NULs are dropped up front.
 */
export function inlineHtml(src: string): string {
  const held: string[] = []
  const hold = (html: string): string => `\u0000${held.push(html) - 1}\u0000`
  let s = src.replace(/\u0000/g, '')

  // code spans first: their content is literal, so nothing below may see it
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _t, code: string) =>
    hold(`<code>${esc(code.replace(/^ (.*) $/, '$1'))}</code>`))

  // backslash escapes — held as text so the marker cannot re-trigger below
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!~>|=])/g, (_m, ch: string) => hold(esc(ch)))

  // <https://…> before the raw-tag sweep, which would otherwise eat it
  // DISPLAY TEXT IS NOT ESCAPED HERE.
  //
  // Everything a hold() placeholder protects is final markup and must carry its
  // own escaping. Everything OUTSIDE a placeholder is ordinary text, and the
  // single esc(s) at the end of this function escapes all of it exactly once.
  // Escaping display text here too ran it through twice: `[Q&A](…)` was written
  // into the file as `Q&amp;amp;A`, and the reader saw the entity. Bold, italic
  // and code were never affected — their text stays outside any placeholder —
  // which is why a spot-check of "inline formatting survived" passed.
  s = s.replace(/<((?:https?|mailto):[^>\s]+)>/gi, (_m, url: string) =>
    hold(`<a href="${esc(url)}">`) + url + hold('</a>'))

  // Raw inline html. A `</a>` is only kept when an `<a>` was kept: dropping a
  // link whose href we refuse (javascript:, obsidian:) must not leave its
  // closing tag behind for the sanitizer to trip over.
  let openA = 0
  s = s.replace(/<\/?[a-zA-Z][^<>]*>/g, (tag) => {
    const ok = cleanRawTag(tag)
    if (!ok) return ''
    if (ok === '</a>' && openA === 0) return ''
    if (ok.startsWith('<a ')) openA++
    else if (ok === '</a>') openA--
    return hold(ok)
  })

  // ![[embed]] and [[wikilink|alias]] before ordinary links: an embed of a
  // note is just a link to it, because there is no transclusion in the model
  s = s.replace(/!?\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
    const [target, alias] = splitOnce(inner, '|')
    return hold(`<a href="${WIKI_SCHEME}${encodeURIComponent(target.trim())}">`) +
      (alias ?? target).trim() + hold('</a>')
  })

  // an inline image cannot be a block, and the model has no inline <img>: keep
  // the alt text, and keep the address as a link when there is one to follow
  s = s.replace(/!\[([^\]]*)\]\(\s*<?([^\s)>]*)>?(?:\s+"[^"]*")?\s*\)/g,
    (_m, alt: string, url: string) => /^(https?:|data:)/i.test(url)
      ? hold(`<a href="${esc(url)}">`) + (alt || url) + hold('</a>')
      : (alt || url))

  // A link whose address the model cannot keep (relative paths, `obsidian://`,
  // `file:`) is left as the markdown the author wrote, address and all. The
  // sanitizer would strip such an href anyway, and text that still says where
  // it pointed beats a link that silently lost its destination.
  s = s.replace(/\[([^\]]*)\]\(\s*<?([^\s)>]*)>?(?:\s+"[^"]*")?\s*\)/g,
    (m: string, text: string, url: string) =>
      /^(https?:|mailto:)/i.test(url)
        ? hold(`<a href="${esc(url)}">`) + text + hold('</a>')
        : m)

  s = s.replace(/~~([\s\S]+?)~~/g, (_m, x: string) => hold('<s>') + x + hold('</s>'))
  s = s.replace(/==([\s\S]+?)==/g, (_m, x: string) => hold('<mark>') + x + hold('</mark>'))
  s = s.replace(/\*\*(?=\S)([\s\S]+?)\*\*/g, (_m, x: string) => hold('<strong>') + x + hold('</strong>'))
  s = s.replace(/(^|[^\w\\])__(?=\S)([\s\S]+?)__(?!\w)/g,
    (_m, pre: string, x: string) => pre + hold('<strong>') + x + hold('</strong>'))
  s = s.replace(/(^|[^*\w])\*(?=\S)([^*]+?)\*/g,
    (_m, pre: string, x: string) => pre + hold('<em>') + x + hold('</em>'))
  // `_` only outside a word, or snake_case_identifiers become italics
  s = s.replace(/(^|[^\w\\])_(?=\S)([^_]+?)_(?!\w)/g,
    (_m, pre: string, x: string) => pre + hold('<em>') + x + hold('</em>'))

  return esc(s).replace(/\u0000(\d+)\u0000/g, (_m, n: string) => held[Number(n)])
}

/** Inline markdown → plain text, for titles (a page title is text, not html). */
export function plainText(src: string): string {
  return src
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m, t: string, a: string) => a ?? t)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`]+/g, '')
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const splitOnce = (s: string, sep: string): [string, string | undefined] => {
  const i = s.indexOf(sep)
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + sep.length)]
}

// ---- one note --------------------------------------------------------------

export interface PendingImage {
  /** the image block, by reference — the importer rewrites it in place */
  block: Block
  /** the address exactly as the note wrote it */
  ref: string
  /** the folder the note lived in, for resolving a relative address */
  dir: string
}

export interface ParsedNote {
  title: string
  blocks: Block[]
  /** the YAML between the leading `---` fences, verbatim */
  frontmatter?: string
  images: PendingImage[]
  /** images pointing at the web: kept, but not loaded until a reader asks */
  remoteImages: number
  /** markdown tables, which this model has no block for yet */
  tables: number
}

const mk = (type: string, extra: Partial<Block> = {}): Block => ({ id: uid('b'), type, ...extra })

const IMG_LINE = /^!\[([^\]]*)\]\(\s*<?([^\s)>]*)>?(?:\s+"([^"]*)")?\s*\)$/
const IMG_EMBED = /^!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i

/** A line that is nothing but an image. `![[x]]` counts only when it names an
 *  image FILE — otherwise it is an embed of another note, which is a link. */
function imageOf(line: string): { ref: string; alt: string; caption?: string } | null {
  const m = IMG_LINE.exec(line.trim())
  if (m) return { ref: m[2], alt: m[1], ...(m[3] ? { caption: m[3] } : {}) }
  const e = IMG_EMBED.exec(line.trim())
  if (e && IMAGE_EXT.test(e[1].trim())) return { ref: e[1].trim(), alt: '' }
  return null
}

/**
 * One markdown file → one page's worth of blocks.
 *
 * THE TITLE RULE, which has to be predictable above all else: a leading
 * `# Heading` becomes the page title AND is removed from the body; otherwise
 * the file name without its extension is the title. Frontmatter is NOT
 * consulted for it — wikilinks resolve by FILE NAME, so a title taken from a
 * `title:` key that disagreed with the file name would leave `[[Note]]`
 * pointing at a page whose name is nowhere in the sidebar.
 */
export function parseNote(text: string, fileTitle: string): ParsedNote {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  const images: PendingImage[] = []
  let remoteImages = 0
  let tables = 0
  let frontmatter: string | undefined
  let i = 0

  if (lines[0]?.trim() === '---') {
    for (let j = 1; j < lines.length; j++) {
      if (/^(---|\.\.\.)\s*$/.test(lines[j])) {
        frontmatter = lines.slice(1, j).join('\n')
        i = j + 1
        break
      }
    }
  }

  let title = ''
  {
    let j = i
    while (j < lines.length && !lines[j].trim()) j++
    const m = /^ {0,3}#\s+(.+?)\s*#*$/.exec(lines[j] ?? '')
    if (m) { title = plainText(m[1]); i = j + 1 }
  }

  /** open list levels, innermost last */
  const stack: Array<{ indent: number; id: string }> = []
  /** the paragraph a soft line break continues, and the quote a `>` continues */
  let para: Block | null = null
  let quote: Block | null = null

  const ownerFor = (indent: number): string | undefined => {
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    return stack[stack.length - 1]?.id || undefined
  }
  const add = (b: Block, parent?: string): Block => {
    if (parent) b.parent = parent
    blocks.push(b)
    return b
  }
  // NOT model.isRemote(): that answers "would loading this touch the network",
  // where a relative path counts as remote. The question here is different —
  // "could a file the user picked satisfy this address" — and a relative path
  // is the one case where the answer is yes.
  const imageBlock = (ref: string, alt: string, caption: string | undefined, parent?: string) => {
    const b = mk('image', { src: ref, ...(alt ? { alt } : {}), ...(caption ? { caption } : {}) })
    add(b, parent)
    if (/^(https?:)?\/\//i.test(ref)) remoteImages++
    else if (!/^data:/i.test(ref)) images.push({ block: b, ref, dir: '' })
    return b
  }

  for (; i < lines.length; i++) {
    const line = lines[i].replace(/\t/g, TAB)
    const indent = /^ */.exec(line)![0].length
    const body = line.slice(indent).trimEnd()

    if (!body) { para = null; quote = null; continue }

    // fenced code — taken whole, so nothing inside is interpreted
    const fence = /^(`{3,}|~{3,})\s*(\S*)/.exec(body)
    if (fence) {
      para = null; quote = null
      const owner = ownerFor(indent)
      const mark = fence[1][0]
      const buf: string[] = []
      let j = i + 1
      for (; j < lines.length; j++) {
        const t = lines[j].trim()
        if (t.length >= 3 && t[0] === mark && t === mark.repeat(t.length)) break
        buf.push(lines[j].startsWith(' '.repeat(indent)) ? lines[j].slice(indent) : lines[j])
      }
      i = j
      add(mk('code', { html: esc(buf.join('\n')), ...(fence[2] ? { lang: fence[2].toLowerCase() } : {}) }), owner)
      continue
    }

    // A PIPE TABLE. This used to be kept verbatim inside a CODE BLOCK —
    // aligned, searchable and exportable, but not a table — under a comment
    // saying it was "mechanically upgradable the day a table block ships".
    // This is that day, and the upgrade is this branch.
    if (body.includes('|') && isTableRule(lines[i + 1])) {
      para = null; quote = null
      const owner = ownerFor(indent)
      const head = splitRow(body)
      const align = splitRow(lines[i + 1]).map(alignOf)
      const raw = [head]
      let j = i + 2
      for (; j < lines.length && lines[j].includes('|'); j++) raw.push(splitRow(lines[j]))
      i = j - 1
      tables++
      // THE HEADER ROW IS THE COLUMN COUNT, which is GFM's own rule: a body row
      // with more cells is cut and one with fewer is padded (tableOf pads at
      // read time, so only the overflow is handled here). A ragged table is
      // completely ordinary in hand-written markdown.
      const w = Math.max(1, head.length)
      const table = mk('table')
      // An EMPTY header row is how a headerless table is written in GFM — there
      // is no other way to say it — and it is what this app's own exporter
      // emits. So it reads back as `header: false` AND the empty row goes: a
      // table that grows a blank first row every time it goes out and comes
      // back is not a round trip.
      const headed = head.some((c) => c.trim() !== '')
      const rows = headed ? raw : raw.slice(1)
      writeTable(table, {
        rows: (rows.length ? rows : [[]]).map((r) => Array.from({ length: w }, (_, k) => inlineHtml(r[k] ?? ''))),
        cols: Array<number>(w).fill(1),
        colAlign: Array.from({ length: w }, (_, k) => align[k] ?? ''),
        header: headed,
      })
      add(table, owner)
      continue
    }

    // setext: `===` under a paragraph promotes it. `---` deliberately does NOT
    // — in a folder of notes a lone rule is a divider far more often than it
    // is a heading, and silently eating the line above it is unforgivable.
    if (para && /^=+$/.test(body)) { para.type = 'h1'; para = null; continue }

    if (/^([-*_])\s*(?:\1\s*){2,}$/.test(body)) {
      para = null; quote = null
      add(mk('divider'), ownerFor(indent))
      continue
    }

    const head = /^(#{1,6})\s+(.*?)\s*#*$/.exec(body)
    if (head) {
      para = null; quote = null
      // h4–h6 land on h3: the model has three heading levels, and dropping a
      // deep heading to a paragraph would lose the outline entirely
      add(mk(`h${Math.min(head[1].length, 3)}`, { html: inlineHtml(head[2]) }), ownerFor(indent))
      continue
    }

    const q = /^>\s?(.*)$/.exec(body)
    if (q) {
      para = null
      const text = inlineHtml(q[1].replace(/^[>\s]+/, ''))
      if (quote) quote.html = `${quote.html}<br>${text}`
      else quote = add(mk('quote', { html: text }), ownerFor(indent))
      continue
    }
    quote = null

    const item = /^([-*+]|\d{1,9}[.)])(?:\s+(.*)|\s*)$/.exec(body)
    if (item) {
      para = null
      const owner = ownerFor(indent)
      const text = item[2] ?? ''
      const todo = /^\[([ xX])\]\s*(.*)$/.exec(text)
      const pic = imageOf(text)
      const block = todo
        ? add(mk('todo', { html: inlineHtml(todo[2]), done: todo[1] !== ' ' }), owner)
        : pic
          ? imageBlock(pic.ref, pic.alt, pic.caption, owner)
          : add(mk(/^\d/.test(item[1]) ? 'number' : 'bullet', { html: inlineHtml(text) }), owner)
      // An IMAGE is not a container and holds no text, so it is neither a
      // continuation target nor a parent.
      //
      // It was both. A continuation line did `${para.html}<br>${text}` against a
      // block with no html, writing the literal string "undefined" into the
      // document and hiding the author's line — invisible in the editor, the
      // reading view, print and the markdown export, but there in the saved
      // file and findable by search. `- ![[pic.png]]` with an indented caption
      // is an ordinary Obsidian shape.
      //
      // Pushing the image's OWNER (not the image) keeps the caption a SIBLING
      // of the image, under the same list item. Parenting it to the image would
      // leave the model saying nested while the renderer, which only opens a
      // body for a registered container, draws it at root.
      stack.push({ indent, id: pic ? (owner ?? '') : block.id })
      para = pic ? null : block
      continue
    }

    const pic = imageOf(body)
    if (pic) {
      para = null
      imageBlock(pic.ref, pic.alt, pic.caption, ownerFor(indent))
      continue
    }

    // a plain line: a continuation of the block above, or a new paragraph.
    //
    // A SOFT LINE BREAK BECOMES <br> rather than a space. Notes are written
    // with the line breaks the author put there (addresses, verse, one-line
    // facts), and joining them into a paragraph is not reversible — while
    // keeping them is, by deleting the break.
    const text = inlineHtml(body)
    if (para) para.html = `${para.html}<br>${text}`
    else para = add(mk('p', { html: text }), ownerFor(indent))
  }

  return {
    title: title || fileTitle,
    blocks,
    ...(frontmatter !== undefined ? { frontmatter } : {}),
    images,
    remoteImages,
    tables,
  }
}

/** `|---|:--:|` — the row that makes the line above it a table header. */
function isTableRule(line: string | undefined): boolean {
  if (!line) return false
  const t = line.trim()
  return t.includes('-') && t.includes('|') && /^\|?[\s:|-]+$/.test(t)
}

/**
 * One pipe-table row into its cells.
 *
 * The leading and trailing pipes are OPTIONAL in GFM — `a | b` is a row — so
 * they are stripped only when present; splitting a fully-piped row without
 * stripping them yields a phantom empty cell at each end, which would shift
 * every column by one against the rule row.
 *
 * `\|` is the escape for a literal pipe and is unescaped after the split, not
 * before: a lookbehind-free split has to keep the backslash to know not to cut
 * there.
 */
function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const out: string[] = []
  let cur = ''
  for (let k = 0; k < t.length; k++) {
    if (t[k] === '\\' && t[k + 1] === '|') { cur += '|'; k++; continue }
    if (t[k] === '|') { out.push(cur.trim()); cur = ''; continue }
    cur += t[k]
  }
  out.push(cur.trim())
  return out
}

/** `:---:` → 'center'. The colons in the rule row are the only thing GFM can
 *  say about alignment, which is why `colAlign` is per column. */
function alignOf(rule: string): string {
  const t = rule.trim()
  const l = t.startsWith(':'), r = t.endsWith(':')
  return l && r ? 'center' : r ? 'right' : l ? 'left' : ''
}

// ---- a folder of notes -----------------------------------------------------

export interface SourceFile {
  /** path relative to the import root, `/` separated (webkitRelativePath) */
  path: string
  text: string
}

export interface ImportStats {
  files: number
  pages: number
  blocks: number
  /** `[[wikilinks]]` that found a page in this import */
  linked: number
  /** …and those that named a note that was not in the selection */
  dangling: number
  frontmatter: number
  /** notes that shared a NAME with an earlier one, so links to them resolved to
   *  the first — the reader is told rather than left to find out */
  duplicateNames: number
  tables: number
  remoteImages: number
}

export interface ImportPlan {
  pages: Page[]
  /** local image references, still to be resolved against picked files */
  images: PendingImage[]
  stats: ImportStats
}

const normalizePath = (p: string): string =>
  p.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+/g, '/').trim()

const dirOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/')))
const fileOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const stemOf = (p: string): string => fileOf(p).replace(/\.[^.]+$/, '')
const lastSeg = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

/**
 * Many notes → the pages of a space, with the folder tree rebuilt.
 *
 * Pure: no files are read here and no ids leave this document, so the whole
 * plan can be asserted in node. The caller does the two things that need a
 * browser — reading image bytes, and running the sanitizer — and then commits
 * the pages in ONE step.
 */
export function planImport(
  files: SourceFile[],
  opts: {
    rootTitle: string
    /**
     * Pages the space ALREADY has, by title — consulted only after the import's
     * own index misses.
     *
     * Order matters and it is this way round on purpose: a vault imported whole
     * must link to itself, never to a stranger page that happens to share a
     * title. But someone adding one note to a space they have been keeping for
     * a year expects `[[Home]]` to mean their Home, and without this it would
     * arrive as dead text.
     */
    resolveExisting?: (target: string) => string | undefined
  },
): ImportPlan {
  const src = files
    .map((f) => ({ path: normalizePath(f.path), text: f.text }))
    .filter((f) => f.path)
    .sort((a, b) => a.path.localeCompare(b.path))

  // A picked FOLDER already has a common first segment, and that folder is the
  // root of the tree — so only a flat, mixed selection needs a container page
  // invented for it. Either way the import lands under exactly one new root:
  // it is undoable in one step and deletable in one gesture.
  const tops = new Set(src.map((f) => (f.path.includes('/') ? f.path.split('/')[0] : '')))
  const wrap = src.length > 1 && !(tops.size === 1 && !tops.has(''))

  const pages: Page[] = []
  const images: PendingImage[] = []
  const stats: ImportStats = {
    files: src.length, pages: 0, blocks: 0, linked: 0, dangling: 0,
    frontmatter: 0, tables: 0, remoteImages: 0, duplicateNames: 0,
  }

  let rootId: string | undefined
  if (wrap) {
    const root: Page = { id: uid('p'), title: opts.rootTitle, icon: 'folder', blocks: [] }
    pages.push(root)
    rootId = root.id
  }

  // A folder note — `Notes/Notes.md` or `Notes/index.md` — IS the folder's
  // page rather than a child of an empty one. That convention is what Obsidian
  // and Foam vaults use for a section's overview, and importing it as a
  // sibling of its own subtree reads as a mistake.
  const folderNote = new Map<string, string>()
  for (const f of src) {
    const dir = dirOf(f.path)
    if (!dir) continue
    const stem = stemOf(f.path).toLowerCase()
    if (stem === 'index' || stem === lastSeg(dir).toLowerCase()) {
      if (!folderNote.has(dir)) folderNote.set(dir, f.path)
    }
  }

  // A folder note falls back to the FOLDER's name, not the file's: measured on
  // a real vault, `Meetings/index.md` otherwise titles the whole section
  // "index". Its own `# Heading` still wins, as everywhere else.
  const parsed = new Map<string, ParsedNote>()
  for (const f of src) {
    const dir = dirOf(f.path)
    const fallback = folderNote.get(dir) === f.path ? lastSeg(dir) : stemOf(f.path)
    parsed.set(f.path, parseNote(f.text, fallback))
  }

  // directories first, parents before children, so `parent` always resolves
  const dirs = new Set<string>()
  for (const f of src) {
    for (let d = dirOf(f.path); d; d = dirOf(d)) dirs.add(d)
  }
  const dirPage = new Map<string, Page>()
  for (const dir of [...dirs].sort()) {
    const note = folderNote.get(dir)
    const page: Page = note
      ? { id: uid('p'), title: parsed.get(note)!.title, icon: 'folder', blocks: [] }
      : { id: uid('p'), title: lastSeg(dir), icon: 'folder', blocks: [] }
    const parent = dirPage.get(dirOf(dir))?.id ?? rootId
    if (parent) page.parent = parent
    dirPage.set(dir, page)
    pages.push(page)
  }

  const filePage = new Map<string, Page>()
  for (const f of src) {
    const dir = dirOf(f.path)
    if (folderNote.get(dir) === f.path) { filePage.set(f.path, dirPage.get(dir)!); continue }
    const page: Page = { id: uid('p'), title: parsed.get(f.path)!.title, blocks: [] }
    const parent = dirPage.get(dir)?.id ?? rootId
    if (parent) page.parent = parent
    filePage.set(f.path, page)
    pages.push(page)
  }

  // ---- fill the pages ------------------------------------------------------
  for (const f of src) {
    const note = parsed.get(f.path)!
    const page = filePage.get(f.path)!
    const dir = dirOf(f.path)

    if (note.frontmatter !== undefined) {
      stats.frontmatter++
      page.blocks.push(...frontmatterBlocks(note.frontmatter))
    }
    page.blocks.push(...note.blocks)
    for (const img of note.images) images.push({ ...img, dir })
    stats.tables += note.tables
    stats.remoteImages += note.remoteImages
  }

  // ---- wikilinks, once every page exists ----------------------------------
  const { index, collisions } = linkIndex(src, parsed, filePage, tops.size === 1 ? [...tops][0] : '')
  for (const page of pages) {
    for (const b of page.blocks) {
      if (!b.html) continue
      const r = resolveWikilinks(b.html, (target) =>
        index.get(linkKey(target)) ?? opts.resolveExisting?.(linkKey(target)))
      b.html = r.html
      stats.linked += r.linked
      stats.dangling += r.dangling
    }
  }

  // NO PAGE ARRIVES WITH ZERO BLOCKS.
  //
  // A folder without a folder note, an empty .md, and the invented root all
  // produced one — and the importer then navigates to plan.pages[0], which in a
  // real vault IS a folder page. A zero-block page has no editable host, no
  // gutter and no `/` menu, so the first thing you saw after importing a vault
  // was a page you could not put a caret in, permanently: nothing ever adds a
  // block to a folder page.
  //
  // The editor cannot produce this state (mergeBack refuses to remove the last
  // block) and validate() grades it `error`. DECISIONS.md recorded the
  // invariant against the editor; the importer landed in the same tree and
  // broke it, which is exactly the kind of gap parallel work opens.
  for (const p of pages) if (!p.blocks.length) p.blocks.push(mk('p', { html: '' }))

  for (const p of pages) stats.blocks += p.blocks.length
  stats.duplicateNames = collisions
  stats.pages = pages.length
  return { pages, images, stats }
}

/**
 * WHERE FRONTMATTER GOES, and this is a permanent decision because it is in
 * every file an import writes: verbatim, into a `code` block marked
 * `frontmatter: true`, folded inside a toggle so it does not shout from the
 * top of every page.
 *
 * NOT parsed into fields. Spaces has no properties model yet, and a properties
 * model designed here — in an importer, from whatever keys one person's vault
 * happens to use — would pre-empt the real design and be impossible to change,
 * because the shape would already be in files on disks. Nothing is interpreted
 * and nothing is lost: the yaml is still exactly the author's text, it is
 * searchable, it prints (toggles always print open), it exports back out as a
 * fenced yaml block, and `frontmatter: true` is the marker that makes adopting
 * these into real properties a mechanical sweep on the day that ships.
 */
function frontmatterBlocks(yaml: string): Block[] {
  const fold = mk('toggle', { html: 'Frontmatter', open: false })
  const body = mk('code', { html: esc(yaml), lang: 'yaml', frontmatter: true, parent: fold.id })
  return [fold, body]
}

/** Everything a `[[wikilink]]` may name, lowercased. First writer wins, so the
 *  result does not depend on the order a file picker happened to hand us. */
function linkIndex(
  src: SourceFile[],
  parsed: Map<string, ParsedNote>,
  filePage: Map<string, Page>,
  root: string,
): { index: Map<string, string>; collisions: number } {
  const index = new Map<string, string>()
  // Two notes can share a NAME in different folders, and a [[wikilink]] names
  // only the name. First one wins — which is the standard behaviour and the
  // only thing a bare name CAN mean — but it must be reported: silently, every
  // link to the second note pointed at the first, including that note's links
  // to ITSELF, and the import claimed unqualified success. Counted here and
  // surfaced in the summary, so the reader knows which links to check.
  const collisions = new Set<string>()
  const put = (k: string, id: string) => {
    const key = linkKey(k)
    if (key && index.has(key) && index.get(key) !== id) collisions.add(key)
    if (key && !index.has(key)) index.set(key, id)
  }
  for (const f of src) {
    const id = filePage.get(f.path)!.id
    put(stemOf(f.path), id)                                   // [[Note]]
    put(f.path.replace(/\.[^.]+$/, ''), id)                   // [[folder/Note]]
    if (root && f.path.startsWith(`${root}/`)) {
      put(f.path.slice(root.length + 1).replace(/\.[^.]+$/, ''), id)  // vault-relative
    }
    put(parsed.get(f.path)!.title, id)                        // [[The title]]
  }
  return { index, collisions: collisions.size }
}

/** Wikilink targets ignore case, a `.md` suffix, and a `#heading`/`^block`
 *  anchor — the model has no in-page anchors, so those land on the page. */
const linkKey = (raw: string): string =>
  raw.replace(/^\.?\//, '').replace(/[#^].*$/, '').replace(/\.(md|markdown)$/i, '')
    .trim().toLowerCase()

export interface Resolution { html: string; linked: number; dangling: number }

/**
 * Turn the parser's `#w/` placeholders into real `#p/<id>` links.
 *
 * A target that is not in this import stays as the literal `[[Name]]` the
 * author wrote: honest, searchable, and still correct markdown if it is
 * exported again — and it resolves for real if the missing note is imported
 * later and the author re-links it. A silent unlink would be a lie about what
 * the file said.
 */
export function resolveWikilinks(html: string, lookup: (target: string) => string | undefined): Resolution {
  let linked = 0
  let dangling = 0
  const out = html.replace(
    /<a href="#w\/([^"]*)">([\s\S]*?)<\/a>/g,
    (_m, enc: string, text: string) => {
      let target = enc
      try { target = decodeURIComponent(enc) } catch { /* keep the raw form */ }
      const id = lookup(target)
      if (id) { linked++; return `<a href="#p/${esc(id)}">${text}</a>` }
      dangling++
      const shown = esc(target)
      return text === shown ? `[[${text}]]` : `[[${shown}|${text}]]`
    },
  )
  return { html: out, linked, dangling }
}
