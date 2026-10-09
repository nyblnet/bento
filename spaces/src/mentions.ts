// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// ALIASES AND UNLINKED MENTIONS.
//
// Two features that are one idea: a page is known by more than one NAME, and
// those names appear in prose whether or not anybody typed `[[ ]]` around them.
//
//   · `Page.aliases` — additive, absent on every page written before this. A
//     page answering to "NYC" and "New York" is reachable by either from the
//     `[[…]]` resolver, ⌘K, and the page picker, so a link made through an
//     alias produces an ordinary `#p/<id>` href and an ordinary backlink. That
//     is the whole reason aliases resolve at LINK time rather than at render
//     time: nothing downstream of the resolver has to learn what an alias is.
//   · Unlinked mentions — every place a page's names appear as plain words in
//     some OTHER page, offered beside the backlinks with a one-click link.
//
// ---------------------------------------------------------------------------
// WHY THIS IS NOT QUADRATIC
//
// "Every page's title matched against every page's text" is N×M, and this app
// is one file that may hold hundreds of pages. It is not computed that way.
//
// The UI only ever asks about ONE page — the one you are reading. So
// `mentionsOf(doc, index, pageId)` builds a single regex from THAT page's names
// and makes one pass over the document's text: O(total text), independent of
// how many pages exist. Opening a page therefore costs the same whether the
// space has 20 pages or 2000, which is the property that matters, because
// this runs on every repaint.
//
// `mentionIndex()` computes the all-pairs answer for the agent surface and for
// measurement. It is still not N passes: names are compiled into CHUNKED
// alternations (`NAMES_PER_RE`), so the cost is (total text) × (chunks), and a
// space small enough to fit in one chunk gets a single pass. Measured numbers
// live in the rig, scripts/test-spaces-mentions.ts.
//
// ---------------------------------------------------------------------------
// THE MATCHING RULE, and why every clause of it is load-bearing
//
// False positives are the entire design problem: a page called "Notes" that
// claims to be mentioned by every page in the space is worse than no feature,
// because it teaches the reader to stop looking at the panel.
//
//   1. MINIMUM LENGTH, by script. Three code points for a name written in a
//      script that uses spaces, TWO for one containing Han/kana/Hangul. Latin
//      "It", "AI" and "PR" mention everything; two Han characters are a whole
//      word. Under the minimum a name still LINKS — it is only excluded from
//      the mention scan.
//   2. WORD BOUNDARIES, applied per SIDE of each name and only where they mean
//      something. `\b` is a Latin rule wearing a Unicode coat: applied to
//      Japanese it requires a non-letter beside the name, and since every
//      neighbouring kana IS a letter it produces exactly ZERO matches in ja,
//      zh-Hans and zh-Hant — a silent total failure in three of this app's
//      nine locales. So a boundary is required only where the name's own edge
//      character is a spacing-script word character. Where the edge is CJK the
//      match is a plain substring, which is what every CJK-aware search in the
//      world does and carries the known cost that 京都 matches inside 東京都.
//      That cost is visible and bounded; the alternative is a feature that
//      does not exist for a third of the supported languages.
//   3. CASE-INSENSITIVE, because "the roadmap" is a mention of "Roadmap".
//   4. NEVER inside a code block, a code span, an existing `<a>`, a bare URL,
//      or the page's own text. `scanRuns` below is the single decision about
//      what text is eligible; everything else reads its output.
//   5. NEVER in a block that already links to the target — you did link it,
//      the panel telling you that you did not is a lie.
//
// UNTRUSTED INPUT. Names come out of a file somebody mailed you. Every one is
// escaped before it reaches a RegExp (`escapeRe`) — a page titled `a(b` is an
// obvious crash and an obvious attack. Map lookups on document data use
// `Object.hasOwn`, never a bare `in` or a truthiness test.

import type { SpacesDoc, Page, SpaceIndex } from './model.ts'

// ---------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------

/** Han, kana or Hangul anywhere: the scripts that do not separate words. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
/** A word character in a script that DOES separate words, for boundary tests. */
const WORDY = /[\p{L}\p{N}_]/u

/** Shortest name that may be scanned for, by script. See rule 1. */
export const MIN_LATIN = 3
export const MIN_CJK = 2

/** Every regex metacharacter, neutralised. Nothing builds a RegExp without it. */
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Comparison form for a name: trimmed, NFC-folded, case-folded. */
export const nameKey = (raw: string): string => {
  let s = String(raw ?? '').trim()
  try { s = s.normalize('NFC') } catch { /* an exotic engine: uncomposed is still consistent */ }
  return s.toLowerCase()
}

/**
 * A page's declared aliases, defended against the file.
 *
 * `aliases` arrives from a document nobody validated. Anything that is not an
 * array of non-empty strings yields none, and the field is left ALONE on the
 * page so it round-trips untouched (format additivity: this build must not
 * repair what it does not understand).
 */
export function aliasesOf(page: Page): string[] {
  const raw = (page as { aliases?: unknown }).aliases
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const a of raw) {
    if (typeof a !== 'string') continue
    const trimmed = a.trim()
    if (!trimmed) continue
    const k = nameKey(trimmed)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(trimmed)
  }
  return out
}

/** Title first, then aliases — every name this page answers to. */
export function namesOf(page: Page): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (n: string) => {
    const trimmed = String(n ?? '').trim()
    if (!trimmed) return
    const k = nameKey(trimmed)
    if (seen.has(k)) return
    seen.add(k)
    out.push(trimmed)
  }
  push(page.title)
  for (const a of aliasesOf(page)) push(a)
  return out
}

/** Is this name long enough to be scanned for? Rule 1. */
export function scannable(name: string): boolean {
  const n = name.trim()
  if (!n) return false
  const len = [...n].length
  return len >= (CJK.test(n) ? MIN_CJK : MIN_LATIN)
}

// ---------------------------------------------------------------------------
// the name index — aliases reaching resolution, search and the picker
// ---------------------------------------------------------------------------

export interface NameIndex {
  /** nameKey → the page it names. First claimant wins; see `collisions`. */
  byName: Map<string, string>
  /** nameKey → every page claiming it, only where more than one does */
  collisions: Map<string, string[]>
}

/**
 * THE ONE PLACE a name becomes a page id.
 *
 * Titles are laid down first, all of them, and only then aliases — so an alias
 * can never shadow a real page's title, however the pages happen to be
 * ordered. That ordering is the whole collision policy for the common case: a
 * page aliased "Projects" while another page is TITLED "Projects" resolves to
 * the titled one, deterministically, and validate() reports the clash rather
 * than the app silently picking by array order.
 *
 * Among two aliases, or two identical titles, the FIRST in document order
 * wins — deterministic, and the same answer in every replica, which matters
 * because two collaborators must not resolve one `[[name]]` differently.
 */
export function nameIndex(doc: SpacesDoc): NameIndex {
  const byName = new Map<string, string>()
  const claims = new Map<string, string[]>()
  const pages = Array.isArray(doc.pages) ? doc.pages : []

  const claim = (name: string, id: string) => {
    const k = nameKey(name)
    if (!k) return
    const list = claims.get(k)
    if (list) { if (!list.includes(id)) list.push(id) }
    else claims.set(k, [id])
    if (!byName.has(k)) byName.set(k, id)
  }

  for (const p of pages) if (p && typeof p.id === 'string') claim(String(p.title ?? ''), p.id)
  for (const p of pages) if (p && typeof p.id === 'string') for (const a of aliasesOf(p)) claim(a, p.id)

  const collisions = new Map<string, string[]>()
  for (const [k, ids] of claims) if (ids.length > 1) collisions.set(k, ids)
  return { byName, collisions }
}

// ---------------------------------------------------------------------------
// eligible text
// ---------------------------------------------------------------------------

/**
 * A run of scannable text, and where its bytes are in the html.
 *
 * Offsets are kept so a mention can be LINKED in place: the panel's button
 * wraps exactly the characters that matched, in the block's own html, without
 * re-finding them by string search (which would hit the wrong occurrence when
 * a name appears twice).
 *
 * Every run is entity-free, so within one run `htmlStart + (i - textStart)` is
 * exact. An entity gets a run of its own, whose text length and html length
 * differ — hence `atomic`, which stops a partial offset being computed inside
 * it.
 */
interface Run {
  htmlStart: number
  htmlEnd: number
  textStart: number
  text: string
  /** html and text lengths differ (an entity): offsets inside are not linear */
  atomic: boolean
}

/**
 * The separator written where a skipped region was.
 *
 * NOT a space. With a space, `New<a>x</a>York` collapses to `New York` and the
 * scanner reports a mention of the page "New York" that nobody wrote — the
 * separator has to be a character no name can contain, and U+0000 is the one
 * the markdown parser already strips from every input.
 */
const SEP = '\u0000'
const SEP_RE = /\u0000/g

/** A region of html a mention may never be found in. */
const SKIP_RE = /<code\b[^>]*>[\s\S]*?<\/code>|<a\b[^>]*>[\s\S]*?<\/a>|<[^>]*>/gi
/**
 * An address sitting in TEXT rather than in an href.
 *
 * A URL is a name-shaped haystack — `example.com/Roadmap/2026` contains the
 * word and means nothing by it — and so is a mail address. Both are masked
 * before matching. Addresses inside an `<a>` are already gone; this is for the
 * ones an author typed as plain text.
 */
const BARE_URL_RE = /(?:https?:\/\/|www\.|mailto:)\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi
/** No address can exist without one of these; the cheap gate in front of it. */
const ADDRESSY = /[:@]|www\./i
/** Entities, kept atomic so an offset is never computed halfway through one. */
const ENTITY_RE = /&(?:#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
}

function decodeEntity(ent: string): string {
  const body = ent.slice(1, -1)
  if (body.startsWith('#')) {
    const n = body[1] === 'x' || body[1] === 'X'
      ? parseInt(body.slice(2), 16)
      : parseInt(body.slice(1), 10)
    if (Number.isFinite(n) && n >= 0 && n <= 0x10ffff) {
      try { return String.fromCodePoint(n) } catch { return ent }
    }
    return ent
  }
  // `Object.hasOwn`, not `ENTITIES[body]`: `constructor` and `__proto__` are
  // both legal entity-shaped names and both truthy on a bare object lookup.
  return Object.hasOwn(ENTITIES, body) ? ENTITIES[body] : ent
}

/**
 * Split a block's html into runs of text a mention may be found in.
 *
 * The separator between eligible runs is a U+0000, which no name can contain
 * (`nameKey` never produces one and the parser strips them from input), so a
 * match can never span a skipped region — a title cannot be assembled out of
 * half a link and half the prose after it.
 */
export function scanRuns(html: string): { text: string; runs: Run[] } {
  const src = String(html ?? '')
  const runs: Run[] = []
  let text = ''

  const pushPlain = (chunk: string, at: number) => {
    if (!chunk) return
    // Entities inside a plain chunk become atomic runs of their own.
    let last = 0
    ENTITY_RE.lastIndex = 0
    for (const m of chunk.matchAll(ENTITY_RE)) {
      const i = m.index ?? 0
      if (i > last) {
        const s = chunk.slice(last, i)
        runs.push({ htmlStart: at + last, htmlEnd: at + i, textStart: text.length, text: s, atomic: false })
        text += s
      }
      const dec = decodeEntity(m[0])
      runs.push({
        htmlStart: at + i, htmlEnd: at + i + m[0].length,
        textStart: text.length, text: dec, atomic: true,
      })
      text += dec
      last = i + m[0].length
    }
    if (last < chunk.length) {
      const s = chunk.slice(last)
      runs.push({ htmlStart: at + last, htmlEnd: at + chunk.length, textStart: text.length, text: s, atomic: false })
      text += s
    }
  }

  /**
   * A chunk of raw text between tags: mask bare addresses, keep the rest.
   *
   * THE `:@.` GUARD IS NOT DECORATION. `BARE_URL_RE`'s mail branch begins
   * `[\w.+-]+`, so without a guard it starts an attempt at every word in the
   * document and then backtracks — it took the per-page scan on the 2.5MB rig
   * space from 7ms to 21ms, three times the cost of the matching it exists to
   * protect. An address needs one of these three characters, and prose that
   * has none cannot contain one.
   */
  const pushText = (chunk: string, at: number) => {
    if (!ADDRESSY.test(chunk)) { pushPlain(chunk, at); return }
    let last = 0
    BARE_URL_RE.lastIndex = 0
    for (const m of chunk.matchAll(BARE_URL_RE)) {
      const i = m.index ?? 0
      pushPlain(chunk.slice(last, i), at + last)
      text += SEP
      last = i + m[0].length
    }
    pushPlain(chunk.slice(last), at + last)
  }

  let last = 0
  SKIP_RE.lastIndex = 0
  for (const m of src.matchAll(SKIP_RE)) {
    const i = m.index ?? 0
    if (i > last) pushText(src.slice(last, i), last)
    text += SEP
    last = i + m[0].length
  }
  if (last < src.length) pushText(src.slice(last), last)
  return { text, runs }
}

/** Text offset → html offset, exact. `end` picks the run's trailing edge. */
function htmlOffset(runs: Run[], at: number, end: boolean): number {
  // linear is fine: a block's runs are counted in tens
  for (const r of runs) {
    const lo = r.textStart
    const hi = r.textStart + r.text.length
    if (end ? (at > lo && at <= hi) : (at >= lo && at < hi)) {
      if (r.atomic) return end ? r.htmlEnd : r.htmlStart
      return r.htmlStart + (at - lo)
    }
  }
  return end ? (runs.length ? runs[runs.length - 1].htmlEnd : 0) : 0
}

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

/**
 * The boundary assertions, and why they are an ALTERNATION rather than a class.
 *
 * What a boundary has to exclude is "a word character in a script that
 * separates words". `[\p{L}\p{N}_]` is the obvious spelling and it is wrong at
 * exactly one place: a Latin-initial name inside Japanese prose. `Bento日本` in
 * `これはBento日本です` is preceded by `は`, which IS a letter, so a plain
 * lookbehind rejects it and the name is unfindable in the only language it was
 * written for.
 *
 * The `v` flag can subtract one class from another and would say this in one
 * term. It is NOT used, and the reason is not taste: `v` is Safari 17, while
 * this app's floor is Safari 16.4 — where `DecompressionStream` (which the
 * shell's own loader needs) and lookbehind both land. A regex the engine
 * cannot COMPILE throws at construction, so getting that wrong is not a
 * missing feature, it is a panel that throws on every page open. The
 * alternation below says the same thing under `u`: "no word character before"
 * OR "a CJK character before" — which is exactly "no non-CJK word character
 * before". Measured, the four ways of spelling this boundary (plain `\p{L}`,
 * this alternation, a lookbehind wrapping a lookahead, and the `v` set
 * difference) all run within noise of each other on a 210KB haystack — 0.03 to
 * 0.05ms a pass. So the choice is decided entirely by the browser floor, and
 * not at all by speed. Worth saying because the first draft of this comment
 * claimed the `v` form was three times slower: that was a per-page timing
 * moving for an unrelated reason, and it would have sent the next person
 * optimising the wrong line.
 */
const UNSPACED = '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]'
const WORD_CLASS = '[\\p{L}\\p{N}_]'
const LEAD = `(?:(?<!${WORD_CLASS})|(?<=${UNSPACED}))`
const TAIL = `(?:(?!${WORD_CLASS})|(?=${UNSPACED}))`

/**
 * One alternative for `name`, with a boundary on each side that needs one.
 *
 * The side is decided by the NAME's own edge character: an edge that is not a
 * spacing-script word character (a bracket, a symbol, a Han character) needs no
 * boundary, because there is nothing there to be glued to.
 */
function alternative(name: string): string {
  const chars = [...name]
  const first = chars[0] ?? ''
  const lastCh = chars[chars.length - 1] ?? ''
  const lead = WORDY.test(first) && !CJK.test(first) ? LEAD : ''
  const tail = WORDY.test(lastCh) && !CJK.test(lastCh) ? TAIL : ''
  return lead + escapeRe(name) + tail
}

/** Names per compiled RegExp. Alternation is fast; an unbounded one is not. */
const NAMES_PER_RE = 256

/**
 * Compile names into as few case-insensitive Unicode regexes as possible.
 *
 * LONGEST FIRST: alternation in JS is first-match-wins, so with "New" before
 * "New York" every mention of the city would be reported as a mention of
 * "New". Sorting by code-point length fixes that for every pair at once.
 */
export function compileNames(names: string[]): RegExp[] {
  const usable = names.filter(scannable)
  usable.sort((a, b) => [...b].length - [...a].length)
  const out: RegExp[] = []
  for (let i = 0; i < usable.length; i += NAMES_PER_RE) {
    const part = usable.slice(i, i + NAMES_PER_RE).map(alternative).join('|')
    // `u` for the script escapes, `i` because "the roadmap" mentions "Roadmap",
    // `g` to walk every occurrence in a block.
    out.push(new RegExp(part, 'giu'))
  }
  return out
}

export interface Mention {
  /** the page the name belongs to */
  pageId: string
  /** the page the name was found in */
  fromPage: string
  fromBlock: string
  /** the text exactly as written where it was found, not the name as declared */
  matched: string
  /** offsets into the block's html, for `linkMention` */
  htmlStart: number
  htmlEnd: number
  /** a readable line of context, the match included */
  snippet: string
}

/** Block types whose content is literal and must never be scanned. */
const CODE_TYPES = new Set(['code', 'katex', 'math', 'mermaid', 'embed'])

const SNIPPET_PAD = 60

/**
 * How many names still make a substring pre-filter cheaper than the regex.
 *
 * `String.prototype.includes` is a tuned substring search and a compiled
 * alternation with two lookarounds per branch is not, so for a handful of
 * names it is far cheaper to ask "could this block possibly match" first and
 * skip the regex on the overwhelming majority that cannot. Past a few names
 * the probes cost more than they save, and the all-pairs path (hundreds of
 * names) must not pay them at all.
 */
const MAX_PROBES = 8

/**
 * Every mention of the compiled names in the document, skipping `skipPages`.
 *
 * `owner` maps the text that matched back to the page that owns the name, so
 * the per-page and all-pairs callers share one scanner and one reading of
 * rules 4 and 5 — neither of them re-parses hrefs or re-decides what counts.
 */
function scanDoc(
  doc: SpacesDoc,
  res: RegExp[],
  owner: (matched: string) => string | undefined,
  skipPages: Set<string>,
  limit: number,
  probes: string[] = [],
): Mention[] {
  const out: Mention[] = []
  const pages = Array.isArray(doc.pages) ? doc.pages : []
  const probe = probes.length && probes.length <= MAX_PROBES ? probes : null
  for (const p of pages) {
    if (!p || typeof p.id !== 'string') continue
    if (skipPages.has(p.id)) continue
    const blocks = Array.isArray(p.blocks) ? p.blocks : []
    for (const b of blocks) {
      if (!b || typeof b.id !== 'string') continue
      if (typeof b.type === 'string' && CODE_TYPES.has(b.type)) continue
      const html = typeof b.html === 'string' ? b.html : ''
      if (!html) continue
      const { text, runs } = scanRuns(html)
      if (!text) continue
      // The pre-filter may only ever say "definitely not here", so it runs on
      // the SAME decoded text the regex will see. Probing the raw html instead
      // is faster and wrong: `R&D Team` is written `R&amp;D Team`, so the probe
      // misses it and the mention silently disappears — which is how this was
      // found. What it skips is the alternation, not the decode; a hit that
      // turns out to be inside a code span is still rejected properly below.
      if (probe) {
        const lc = text.toLowerCase()
        let maybe = false
        for (const q of probe) if (lc.includes(q)) { maybe = true; break }
        if (!maybe) continue
      }
      for (const re of res) {
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(text))) {
          if (m[0] === '') { re.lastIndex++; continue }
          const target = owner(m[0])
          // `p.id !== target` is rule 4's last clause and it is DELIBERATELY
          // redundant with `skipPages` on the per-page path: skipPages is the
          // fast path (the page is never scanned), this is the one that holds
          // for the all-pairs path, where every page is scanned for every
          // name. Removing either alone changes nothing, which is worth
          // knowing before someone deletes one as dead code.
          //
          // Rule 5: the block already links there, so it is not "unlinked".
          if (target && p.id !== target && !html.includes(`#p/${target}`)) {
            const s = m.index
            const e = s + m[0].length
            const from = Math.max(0, s - SNIPPET_PAD)
            const to = Math.min(text.length, e + SNIPPET_PAD)
            out.push({
              pageId: target,
              fromPage: p.id,
              fromBlock: b.id,
              matched: m[0],
              htmlStart: htmlOffset(runs, s, false),
              htmlEnd: htmlOffset(runs, e, true),
              snippet: (from > 0 ? '…' : '') +
                text.slice(from, to).replace(SEP_RE, ' ').replace(/\s+/g, ' ').trim() +
                (to < text.length ? '…' : ''),
            })
            if (out.length >= limit) return out
          }
        }
      }
    }
  }
  return out
}

/** How many mentions one page's panel will ever show. */
export const MENTION_LIMIT = 200

/**
 * Unlinked mentions of ONE page — the path the reader's panel takes.
 *
 * One regex built from one page's names, one pass over the document. Cost is
 * O(total text) and does NOT grow with the number of pages, which is why
 * opening a page in a 2000-page space costs what it costs in a 20-page one.
 */
export function mentionsOf(doc: SpacesDoc, index: SpaceIndex, pageId: string): Mention[] {
  const page = index.page.get(pageId)
  if (!page) return []
  const names = namesOf(page).filter(scannable)
  if (!names.length) return []
  const res = compileNames(names)
  if (!res.length) return []
  // Rule 4's last clause: never the page's own text.
  return scanDoc(doc, res, () => pageId, new Set([pageId]), MENTION_LIMIT,
    names.map((n) => n.toLowerCase()))
}

/**
 * Every unlinked mention in the document, grouped by mentioned page.
 *
 * The agent/measurement path. Not used by the panel — see the header — but the
 * one call that answers "what is this space not linking".
 */
export function mentionIndex(doc: SpacesDoc, limit = 5000): Map<string, Mention[]> {
  const pages = Array.isArray(doc.pages) ? doc.pages : []
  const owner = new Map<string, string>()
  const all: string[] = []
  for (const p of pages) {
    if (!p || typeof p.id !== 'string') continue
    for (const n of namesOf(p)) {
      if (!scannable(n)) continue
      const k = nameKey(n)
      // first claimant wins, exactly as nameIndex resolves it
      if (!owner.has(k)) { owner.set(k, p.id); all.push(n) }
    }
  }
  const res = compileNames(all)
  const found = scanDoc(doc, res, (matched) => owner.get(nameKey(matched)), new Set(), limit)
  const byPage = new Map<string, Mention[]>()
  for (const m of found) {
    const list = byPage.get(m.pageId)
    if (list) list.push(m)
    else byPage.set(m.pageId, [m])
  }
  return byPage
}

/**
 * The block html with one mention turned into a real link.
 *
 * Returns null when the offsets no longer describe the html they were computed
 * from — the document may have been edited since the panel was painted, and
 * splicing a link into a moved offset would corrupt the block. The caller
 * re-derives and tries again rather than writing anything.
 */
export function linkMention(html: string, m: Mention, targetId: string): string | null {
  const src = String(html ?? '')
  if (m.htmlStart < 0 || m.htmlEnd > src.length || m.htmlStart >= m.htmlEnd) return null
  const inner = src.slice(m.htmlStart, m.htmlEnd)
  // the bytes must still be the text that matched, entities and all
  if (scanRuns(inner).text !== m.matched) return null
  const href = String(targetId).replace(/[^A-Za-z0-9_-]/g, '')
  if (!href) return null
  return src.slice(0, m.htmlStart) + `<a href="#p/${href}">` + inner + '</a>' + src.slice(m.htmlEnd)
}
