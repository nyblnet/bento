// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The block-type registry: ONE declaration per type.
//
// Adding a block type used to mean editing four files in five places — the
// renderer's tag map and list map, the / menu, the markdown-autoformat table,
// and the markdown exporter — with nothing connecting them. A type added to
// four of the five looked finished and silently exported as a bare paragraph.
//
// Now each type is one entry here and every consumer derives from it. That is
// worth stating as a rule rather than a convenience: several people (and
// several agents) add block types in parallel, and a registry turns four
// simultaneous edits to the same hot files into four independent entries.
//
// PURE DATA — no DOM, no imports from render.ts or editor.ts. That keeps the
// dependency arrow one-way (consumers import the registry, never the reverse)
// and lets a node test read it directly.
//
// Types with genuinely custom layout (image, todo, toggle, pagelink, code,
// divider) still have their rendering in render.ts and say so with
// `custom: true`; everything the registry can express lives here.

import type { Block } from './model'
import { effectiveParents } from './model.ts'
import type { IconName } from './icons'

export interface BlockSpec {
  type: string
  /**
   * Menu label and hint, in ENGLISH.
   *
   * Not translated here: t() at module scope freezes the string at import,
   * before the reader's locale is known (CLAUDE.md). English IS the key, so
   * consumers call t(spec.label) at render time.
   */
  label: string
  hint: string
  icon: IconName
  /**
   * Markdown prefixes that turn the block being typed into this type.
   *
   * A LIST, because the real ones have aliases: `- ` and `* ` both start a
   * bullet, `[] ` and `[ ] ` both start a to-do. Collapsing those to one
   * pattern each would quietly drop half the triggers people already use.
   */
  md?: RegExp[]
  /**
   * Fields a block of this type needs beyond id/type.
   *
   * MUST NOT CLOBBER a value that is already there: this runs both on a fresh
   * block and when an EXISTING block is converted (editor.setType), and a
   * bullet turned into a to-do must not lose a `done` someone had already
   * ticked. `m` is the markdown trigger's match, so a trigger can carry a
   * value — `[!warning] ` sets the tone it named.
   */
  init?: (b: Block, m?: RegExpMatchArray) => void
  /** Semantic element, when the default renderer (tag + inline text) applies. */
  tag?: string
  /** Adjacent siblings of the same kind share one list element. */
  list?: 'ul' | 'ol'
  /**
   * This type owns the blocks whose `parent` is its id, and the renderer gives
   * it a body element to hold them.
   *
   * `'fold'` means the body is hidden unless `open` — the `toggle` idiom.
   * `'always'` means it is never hidden, which is the whole difference between
   * a callout and a toggle and is why this is a value rather than a boolean.
   */
  container?: 'always' | 'fold'
  /**
   * In markdown, this type's whole subtree lives inside its blockquote.
   *
   * A GitHub alert is a blockquote: the box ends at the first line that does
   * not start with `>`, and everything after it renders as loose prose. So a
   * container that exports as one needs every descendant line marked, which is
   * what mdLayout() below works out.
   */
  mdQuoteChildren?: boolean
  /** Rendered by a dedicated case in render.ts, not by tag + inline host. */
  custom?: boolean
  /** Carries editable inline html. False for divider, image, pagelink. */
  text?: boolean
  /** Hidden from the / menu (a type reachable only another way). */
  unlisted?: boolean
  /**
   * Markdown export. `text` is the block's inline html already converted to
   * inline markdown; `indent` is set for a nested block. Absent = the text
   * alone, which is also what an UNKNOWN type gets.
   */
  toMd?: (b: Block, text: string, indent: string, titleOf: (id: string) => string | undefined) => string[]
}

export const SPECS: BlockSpec[] = [
  {
    type: 'p', label: 'Text', hint: 'Plain paragraph', icon: 'text',
    tag: 'p', text: true,
  },
  {
    type: 'h1', label: 'Heading 1', hint: '#', icon: 'h1',
    tag: 'h1', text: true, md: [/^# $/],
    toMd: (_b, text) => [`# ${text}`],
  },
  {
    type: 'h2', label: 'Heading 2', hint: '##', icon: 'h2',
    tag: 'h2', text: true, md: [/^## $/],
    toMd: (_b, text) => [`## ${text}`],
  },
  {
    type: 'h3', label: 'Heading 3', hint: '###', icon: 'h3',
    tag: 'h3', text: true, md: [/^### $/],
    toMd: (_b, text) => [`### ${text}`],
  },
  {
    type: 'bullet', label: 'Bulleted list', hint: '-', icon: 'bullet',
    tag: 'li', list: 'ul', text: true, md: [/^- $/, /^\* $/],
    toMd: (_b, text, indent) => [`${indent}- ${text}`],
  },
  {
    type: 'number', label: 'Numbered list', hint: '1.', icon: 'number',
    tag: 'li', list: 'ol', text: true, md: [/^1\. $/],
    toMd: (_b, text, indent) => [`${indent}1. ${text}`],
  },
  {
    type: 'todo', label: 'To-do', hint: '[]', icon: 'todo',
    tag: 'li', list: 'ul', text: true, custom: true,
    md: [/^\[\] $/, /^\[ \] $/],
    init: (b) => { if (b.done === undefined) b.done = false },
    toMd: (b, text, indent) => [`${indent}- [${b.done ? 'x' : ' '}] ${text}`],
  },
  {
    type: 'toggle', label: 'Toggle', hint: 'Collapsible section', icon: 'toggle',
    tag: 'div', text: true, custom: true, container: 'fold',
    init: (b) => { if (b.open === undefined) b.open = true },
    toMd: (_b, text, indent) => [`${indent}- ${text}`],
  },
  {
    type: 'callout', label: 'Callout', hint: 'A note, tip or warning', icon: 'callout',
    // <aside> is the semantic element, and inside our <article class="sp-page">
    // it maps to role=generic rather than to a `complementary` LANDMARK (that
    // mapping only applies to a top-level aside). So a page of callouts does
    // not fill a screen-reader's landmark list with fifteen entries.
    tag: 'aside', text: true, custom: true, container: 'always', mdQuoteChildren: true,
    // `> ` converts to a quote at the space, so `> [!NOTE] ` can never be typed
    // as one trigger — MEASURED, the block is already a quote by the time the
    // bracket arrives. The trigger is therefore the tag ALONE, which fires just
    // as well in the quote it lands in as on an empty paragraph.
    md: [/^\[!(note|tip|important|warning|caution)\] $/i],
    init: (b, m) => {
      const named = m?.[1]?.toLowerCase()
      if (named) b.tone = named
      else if (b.tone === undefined) b.tone = 'note'
    },
    toMd: (b, text) => {
      // The tone comes from a file someone MAILED you. A newline or a `]` in it
      // would end the alert tag early and turn the rest of the callout into
      // prose, so the exported tag is the sanitised form — while `b.tone` in
      // the document is left exactly as it was found.
      const tag = String(b.tone ?? 'note').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24) || 'NOTE'
      // one `> ` per LINE: htmlToMd turns <br> into a newline, and a bare
      // newline inside a blockquote ends it
      return [`> [!${tag}]`, ...(text ? text.split('\n') : ['']).map((l) => (l ? `> ${l}` : '>'))]
    },
  },
  {
    type: 'quote', label: 'Quote', hint: '>', icon: 'quote',
    tag: 'blockquote', text: true, md: [/^> $/],
    toMd: (_b, text) => [`> ${text}`],
  },
  {
    type: 'code', label: 'Code', hint: '``` ', icon: 'code',
    tag: 'div', text: true, custom: true,
    // The fence CARRIES ITS LANGUAGE: ```py, ```sh, ```json.
    //
    // Completed by a SPACE, where a bare ``` used to convert on the third
    // backtick. A deliberate change to an existing trigger: every other rule
    // here is space-completed (`# `, `- `, `> `, `--- `), and while ```
    // converted instantly there was no keystroke left in which to type the
    // language — which is the muscle memory everyone brings from GitHub and
    // every other markdown box.
    //
    // The tag is stored VERBATIM, never normalised. `lang` is document data, so
    // a language this build cannot highlight still round-trips, still exports
    // as ```rust, and lights up by itself the day the lexer learns it.
    md: [/^```(\w*) $/],
    init: (b, m) => { const lang = m?.[1]; if (lang) b.lang = lang },
    toMd: (b, text) => ['```' + String(b.lang ?? ''), text, '```'],
  },
  {
    type: 'divider', label: 'Divider', hint: '---', icon: 'divider',
    tag: 'div', custom: true, md: [/^--- $/],
    toMd: () => ['---'],
  },
  {
    type: 'pagelink', label: 'Link to page', hint: 'A card that opens a page', icon: 'link',
    tag: 'div', custom: true,
    toMd: (b, _text, _indent, titleOf) => [`→ [[${titleOf(String(b.page)) ?? '?'}]]`],
  },
  {
    // A FIELD VALUE on a page. Unlisted: fields are added from the issue header,
    // not the / menu — "Field" in a block list would be a block whose value you
    // then have to go and find somewhere else.
    //
    // It renders its own `html` on any build that does not know the type, which
    // is the whole reason values are blocks rather than page keys.
    type: 'prop', label: 'Field', hint: 'A typed value on this page', icon: 'tag',
    tag: 'div', custom: true, unlisted: true,
    toMd: (b) => [`**${String((b as { key?: unknown }).key ?? 'field')}:** ${String((b as { value?: unknown }).value ?? '')}`],
  },
  {
    // A SAVED VIEW — a board or a list of the issues in this space. Also just a
    // block, so it lives on a page, moves, duplicates, deletes and prints like
    // anything else, and an older build shows its description instead.
    type: 'view', label: 'Board or list', hint: 'Issues, grouped or listed', icon: 'board',
    tag: 'div', custom: true,
    toMd: (b) => [`_${String(b.html ?? 'View')}_`],
  },
  {
    type: 'image', label: 'Image', hint: 'Embedded in the file', icon: 'image',
    tag: 'div', custom: true,
    toMd: (b) => [`![${String(b.alt ?? '')}](${String(b.src ?? '')})`],
  },
]

/**
 * Callout tones — a PERMANENT vocabulary.
 *
 * These five are GitHub's alert types, spelled exactly as GitHub spells them,
 * so `tone` → `> [!TONE]` and back is the IDENTITY function. Every other
 * candidate set (Docusaurus's note/tip/info/warning/danger, MkDocs' thirteen)
 * needs a mapping table in the exporter, and a mapping table is a thing that
 * can be got wrong once and then cannot be corrected — the wrong tone would
 * already be in files on disks.
 *
 * FIVE, not thirteen, and no `success`: the format is additive, so a sixth tone
 * can be added later and older builds will render it neutrally and keep both
 * the word and its spelling (render.ts). Removing or renaming one is
 * impossible. When a decision is one-way, ship the smaller set.
 *
 * The MARK IS A SHAPE, not a hue: circle, bulb, square, triangle, octagon. With
 * the tone's name spelled out beside it, a callout is identifiable with no
 * colour vision at all, on a black-and-white printout, and at a glance. The
 * tints are decoration and carry no meaning on their own — deliberately, since
 * amber/red/green are the pair-of-hues most readers cannot separate.
 *
 * There is deliberately no `label` here. The i18n sweep reads t() calls with a
 * LITERAL STRING out of the source, so a label sitting in a data table ships
 * English in all eight locales — which is exactly what has happened to the
 * block MENU labels above. Tone names are written out as t() calls in render.ts,
 * and a check in scripts/test-spaces-model.ts fails if a tone here has no case
 * there.
 */
export interface ToneSpec {
  tone: string
  icon: IconName
}

export const CALLOUT_TONES: ToneSpec[] = [
  { tone: 'note', icon: 'toneNote' },
  { tone: 'tip', icon: 'toneTip' },
  { tone: 'important', icon: 'toneImportant' },
  { tone: 'warning', icon: 'toneWarning' },
  { tone: 'caution', icon: 'toneCaution' },
]

export const TONE: ReadonlyMap<string, ToneSpec> = new Map(CALLOUT_TONES.map((t) => [t.tone, t]))

/** Lookup by type. An UNKNOWN type returns undefined and must still render — a
 *  file written by a newer build opens here, and it opens as text. */
export const SPEC: ReadonlyMap<string, BlockSpec> = new Map(SPECS.map((s) => [s.type, s]))

/** The / menu and the Insert dropdown, in declaration order. */
export const MENU_SPECS = SPECS.filter((s) => !s.unlisted)

/** Markdown autoformat rules, derived so a type cannot have a menu entry and
 *  no trigger by accident — or a trigger nobody can find in a menu. */
export type MdRule = [RegExp, string, (b: Block, m?: RegExpMatchArray) => void]

export const MD_SPECS: MdRule[] =
  SPECS.flatMap((s) => (s.md ?? []).map((re) => [re, s.type, s.init ?? (() => {})] as MdRule))

/**
 * `type -> semantic element`, for EVERY type.
 *
 * `custom` says the renderer fills the element itself; it does not change what
 * the element IS. `todo` is both custom and an `li` — filtering custom types
 * out of this map would silently move to-do items out of their list.
 */
export const TAG_OF: Record<string, string> =
  Object.fromEntries(SPECS.filter((s) => s.tag).map((s) => [s.type, s.tag!]))

/** Types whose adjacent siblings share one <ul>/<ol>. */
export const LIST_OF: Record<string, 'ul' | 'ol'> =
  Object.fromEntries(SPECS.filter((s) => s.list).map((s) => [s.type, s.list!]))

/**
 * How each block's markdown lines are decorated, for one page's flat list.
 *
 * The three parts a line needs that a single block cannot know on its own:
 * `quote` (the `> ` markers that keep it inside the alert it belongs to),
 * `indent` (list nesting), and `sep` (what goes BETWEEN this block and the
 * next — a blank line normally, but a bare `>` inside an alert, because a blank
 * line closes a blockquote and would split one callout into a box followed by
 * loose text).
 *
 * It lives here, not in the exporter, for two reasons: it is derived entirely
 * from registry facts (`mdQuoteChildren`), and about.ts drags in the kernel's
 * update and save modules, so a node test cannot import it to check any of
 * this. This is the part with the edge cases, so this is the part that has to
 * be reachable from a test.
 */
export function mdLayout(blocks: Block[]): Array<{ quote: string; indent: string; sep: string }> {
  const byId = new Map(blocks.map((b) => [b.id, b]))
  // HOP-CAPPED: `parent` is a plain id in a file anyone can hand-edit, so two
  // blocks can name each other. The renderer is a pre-order pass and cannot
  // loop; an ancestor walk can, and would hang an export of a document that
  // displays perfectly well.
  // The ancestor chain, by model.ts's ONE rule — `parent` must exist in this
  // page AND appear strictly earlier. This followed the raw `parent` graph with
  // a hop cap of 32, which is a cap because the graph can cycle; under the
  // positional rule it cannot, so the walk terminates by construction and the
  // cap is gone. (Held: an EXPORT that silently truncated at depth 32 would
  // have been a quiet wrong answer, not an error.)
  const eff = effectiveParents({ blocks } as never)
  const owners = (b: Block): Block[] => {
    const chain: Block[] = []
    for (let id = eff.get(b.id); id; id = eff.get(id)) {
      const o = byId.get(id)
      if (!o) break
      chain.push(o)
    }
    return chain
  }
  const wraps = (b: Block | undefined): boolean => !!b && SPEC.get(b.type)?.mdQuoteChildren === true
  const alert = (b: Block): string | undefined => owners(b).find(wraps)?.id
  const depth = (b: Block): number => owners(b).filter(wraps).length

  return blocks.map((b, i) => {
    const parent = b.parent ? byId.get(b.parent) : undefined
    // Inside a callout a child is the alert's BODY, not a nested list item.
    // Indenting it makes GitHub read it as a nested list — or, at four spaces,
    // as a code block.
    const indent = parent && !wraps(parent) ? '  ' : ''
    const next = blocks[i + 1]
    // "same alert" compares the alert the NEXT block is in against the alert
    // this one IS or is in, so a callout and its first child are joined, and so
    // are two children of one callout — but two adjacent callouts are not.
    const mine = wraps(b) ? b.id : alert(b)
    const sep = next && alert(next) && alert(next) === mine ? '> '.repeat(depth(next)).trimEnd() : ''
    return { quote: '> '.repeat(depth(b)), indent, sep }
  })
}
