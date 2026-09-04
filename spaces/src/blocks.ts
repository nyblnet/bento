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
import { effectiveParents, tableOf, writeTable, linkCard } from './model.ts'
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
  toMd?: (b: Block, text: string, indent: string, ctx: MdCtx) => string[]
}

/**
 * What the exporter can answer for a block that describes OTHER content.
 *
 * A pagelink needs one title; a view needs the issues it stands for. Both are
 * questions about the document, and a block cannot see the document — so they
 * arrive here rather than as a second export path that would drift from this
 * one. A context object rather than a growing parameter list, because the next
 * derived block type will want a third question.
 */
export interface MdCtx {
  titleOf: (id: string) => string | undefined
  /** the rows a `view` block stands for, already filtered and ordered */
  rowsOf: (b: Block) => Array<{ id: string; title: string; group?: string; fields: string }>
  /**
   * Inline html → inline markdown.
   *
   * The exporter hands every block its own `html` already converted, which is
   * the whole of the text for every type that HAS one string of it. A table has
   * one per cell, and the converter needs a DOM (about.ts htmlToMd parses
   * inert), which this file deliberately does not — so it arrives through the
   * context, exactly like the two questions above.
   */
  inline: (html: string) => string
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
    // A CONTENT table: rows and columns of inline html, no formulas and nothing
    // that recalculates (working/design/spaces-design.md §2.6). Custom, because a
    // <table> is structure the default tag-plus-inline-host renderer cannot
    // express, and `text: false` because its editable text lives in the CELLS —
    // a block-level inline host beside them would be a second place to type
    // that nothing displays.
    type: 'table', label: 'Table', hint: 'Rows and columns', icon: 'table',
    tag: 'div', custom: true,
    // Also the CONVERSION path (editor.setType), so it must not clobber: a
    // table turned into a paragraph and back keeps its rows. A paragraph turned
    // INTO a table keeps its words, in the first header cell — the alternative
    // is a block menu entry that silently discards the line you typed.
    init: (b) => {
      if (Array.isArray(b.rows) && b.rows.length) return
      const first = typeof b.html === 'string' ? b.html : ''
      writeTable(b, {
        rows: [[first, '', ''], ['', '', ''], ['', '', '']],
        cols: [1, 1, 1], colAlign: ['', '', ''], header: true,
      })
    },
    toMd: (b, _text, indent, ctx) => tableToMd(b, indent, ctx.inline),
  },
  {
    type: 'pagelink', label: 'Link to page', hint: 'A card that opens a page', icon: 'link',
    tag: 'div', custom: true,
    toMd: (b, _text, _indent, ctx) => [`→ [[${ctx.titleOf(String(b.page)) ?? '?'}]]`],
  },
  {
    // A LINK TO SOMEWHERE ON THE WEB — the outward-facing sibling of pagelink.
    //
    // Every field is STORED. Notion and Slack build this card by fetching the
    // url on a server and reading its OpenGraph tags; there is no server here
    // and there is not going to be one, so what the card shows is what the
    // author typed. See docs/DECISIONS.md for why not even an editor-time,
    // opt-in fetch is on the table.
    type: 'link', label: 'Link to the web', hint: 'A card for an address you type', icon: 'globe',
    tag: 'div', custom: true,
    // A LINK CARD IN MARKDOWN IS A LINK. Not a table, not a blockquote, not an
    // html <div> — every one of those is a card-shaped thing that stops being a
    // link the moment it leaves this app, and the ONE fact a link card carries
    // that cannot be reconstructed is where it points.
    //
    // Built from the FIELDS rather than from `text`. `html` holds the same
    // link, so the default export would already be close — but `html` is a
    // fallback for old builds, and an export that reads it would silently
    // export nothing at all for a card an agent wrote fields-only.
    toMd: (b) => {
      const c = linkCard(b)
      // no url, no link: a card that is not clickable must not export as
      // something a reader will click
      if (!c.url) return [[c.title, c.desc].filter(Boolean).join(' — ')]
      const tail = c.desc ? ` — ${c.desc}` : ''
      // `[` and `]` in a title end the link text early and leave the url as
      // loose parenthesised prose; a url holding a space or a bracket needs the
      // angle form, which is what <> is FOR in CommonMark
      const label = c.title.replace(/([[\]])/g, '\\$1')
      const href = /[\s()<>]/.test(c.url) ? `<${c.url}>` : c.url
      return [`[${label}](${href})${tail}`]
    },
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
    // FROM THE READABLE FORM, not from the raw value. `html` already says
    // "Status: In progress" — that string is the entire reason a prop block
    // degrades instead of vanishing, and exporting `**status:** doing` from
    // beside it published the option ID to the one audience that has no schema
    // to look it up in. `text` is that html, already converted.
    //
    // The label is bolded by splitting at the first ": " the readable form
    // itself uses; anything unexpected is emitted whole rather than guessed at.
    toMd: (b, text) => {
      const at = text.indexOf(': ')
      const raw = String((b as { value?: unknown }).value ?? '')
      if (at < 0) return [`**${text || String((b as { key?: unknown }).key ?? 'field')}**`]
      const shown = text.slice(at + 2)
      return [`**${text.slice(0, at)}:** ${shown || raw || '—'}`]
    },
  },
  {
    // A SAVED VIEW — a board or a list of the issues in this space. Also just a
    // block, so it lives on a page, moves, duplicates, deletes and prints like
    // anything else, and an older build shows its description instead.
    type: 'view', label: 'Board or list', hint: 'Issues, grouped or listed', icon: 'board',
    tag: 'div', custom: true,
    // THE ISSUES, not the word "Issues". A board exported as its own italic
    // title and nothing else — so a tracker downloaded as Markdown showed a
    // heading where the work was, and a reader had to reconstruct the board
    // from the pages that follow. The rows are derived (the export applies the
    // same filter and sort the screen does), which is why they arrive through
    // the context rather than off the block.
    toMd: (b, text, indent, ctx) => {
      const rows = ctx.rowsOf(b)
      const out = [`**${text || 'Issues'}**`, '']
      if (!rows.length) return [...out, `${indent}_No issues._`]
      let group: string | undefined
      for (const r of rows) {
        // grouped exactly as the board groups, and a flat list when it is one
        if (r.group !== undefined && r.group !== group) {
          group = r.group
          out.push('', `${indent}**${group}**`, '')
        }
        const meta = r.fields ? ` — ${r.fields}` : ''
        out.push(`${indent}- [${r.title}](#p/${r.id})${meta}`)
      }
      return out
    },
  },
  {
    // A SPATIAL SURFACE — a storyboard, a roadmap, a mind map. Its cards are
    // the blocks whose `parent` is its id, exactly like a callout's body, and
    // each one carries where it sits as two flat numbers. The whole argument
    // for that shape (rather than an array of cards on this block) is at the
    // top of canvas.ts; the short version is that a card is a block, so it is
    // already searchable, exportable, backlinked and individually mergeable.
    //
    // `text: true`: the canvas's own `html` is its NAME. That is also what a
    // build with no `canvas` type renders — and because the cards fall out to
    // the top level on such a build (renderBlocks opens no container for an
    // unknown type), the name must NOT duplicate them. A table's fallback has
    // to hold its cells' text and pays for it in bytes; a canvas's does not.
    type: 'canvas', label: 'Canvas', hint: 'Cards you place by hand', icon: 'canvas',
    tag: 'div', text: true, custom: true, container: 'always',
    // THE NAME, then the cards — which arrive on their own, as the indented
    // lines of the blocks they are. A canvas is a picture and Markdown has no
    // pictures, so the honest export is the list of what is on it, in document
    // order. Positions are what does not survive, and saying so in the export
    // would be a comment in someone else's document.
    toMd: (_b, text) => [`**${text || 'Canvas'}**`],
  },
  {
    type: 'image', label: 'Image', hint: 'Embedded in the file', icon: 'image',
    tag: 'div', custom: true,
    toMd: (b) => [`![${String(b.alt ?? '')}](${String(b.src ?? '')})`],
  },
  {
    type: 'media', label: 'Video or audio', hint: 'Plays in the page', icon: 'play',
    tag: 'div', custom: true,
    // A fresh block has no src yet — the renderer draws a chooser and the
    // editor wires it. `kind` is set the moment a file or a link arrives, from
    // what the file actually IS, so the default here only has to be the shape
    // that degrades usefully.
    init: (b) => { if (b.kind === undefined) b.kind = 'video' },
    // MARKDOWN HAS NO VIDEO, and pretending otherwise loses the block.
    //
    // Three candidates, and only one of them is right in more than one place.
    // `![](clip.mp4)` is IMAGE syntax: every renderer that has ever existed
    // draws a broken-image glyph for it. A bare URL on its own line becomes a
    // player on github.com and on nothing else, so it exports as a naked
    // string everywhere a reader is likelier to open the file. A LINK is
    // correct in all of them: it says what the thing is and where it is, and
    // the one renderer that could do better still shows something you can
    // click.
    //
    // The target is `src` verbatim, `asset:` and data: included, exactly as
    // the image exporter already writes it. That link does not resolve outside
    // the space — which is the truth about an embedded clip, and a truthful
    // dead link beats a silently dropped block.
    toMd: (b) => {
      const kind = String(b.kind ?? 'video') === 'audio' ? 'Audio' : 'Video'
      const label = String(b.alt ?? '') || kind
      const src = String(b.src ?? '')
      return [src ? `[${label}](${src})` : `_${kind}_`]
    },
  },
]

/** The `:---:` rule row's four forms, which are the whole of what GFM can say
 *  about alignment — and the reason `colAlign` is per column, not per cell. */
const RULE: Record<string, string> = { left: ':---', center: ':---:', right: '---:' }

/**
 * A table as a GitHub-flavoured pipe table.
 *
 * THE HEADER ROW IS NOT OPTIONAL IN GFM: a table without one is not a table,
 * it is three lines of prose full of pipes. So a `header: false` table exports
 * with an EMPTY header row, which is the form every generator uses and which
 * this app's own importer reads back as `header: false`.
 *
 * Two characters end a cell early and both can arrive from a file someone
 * mailed you: a literal `|` (escaped) and a newline, which `<br>` in a cell
 * becomes on the way through the inline converter (turned back into `<br>`,
 * which GFM renders inside a cell — a real newline would end the row).
 * An EMPTY cell is emitted as a space: `||` is a column count nobody meant.
 */
export function tableToMd(b: Block, indent: string, inline: (html: string) => string): string[] {
  const t = tableOf(b)
  const cell = (html: string): string =>
    inline(html).replace(/\|/g, '\\|').replace(/\n/g, '<br>').trim() || ' '
  const line = (cells: string[]): string => `${indent}| ${cells.join(' | ')} |`
  const head = t.header ? t.rows[0] : Array<string>(t.w).fill('')
  const body = t.header ? t.rows.slice(1) : t.rows
  return [
    line(head.map(cell)),
    line(t.colAlign.map((a) => RULE[a] ?? '---')),
    ...body.map((r) => line(r.map(cell))),
  ]
}

/**
 * THE PLAYBACK FLAGS A SURFACE MAY APPLY — and the one it may not.
 *
 * `autoplay` IS ALWAYS FALSE HERE, whatever the block says. Slides learned
 * this the expensive way: autoplay set at render time fires on the editing
 * canvas and in every thumbnail, so it lives in present mode, which is the one
 * surface that owns playback. A space has no such surface. It has an editor, a
 * reading view, a printout and a file-manager still, and a clip that starts
 * itself is wrong in every one of them — the reading view because a page you
 * scrolled past should not start talking, the still because it is a picture.
 *
 * So the rule is not "the renderer happens not to set it" — that is a property
 * of one function that the next surface would have to rediscover. It is this
 * function, which every surface goes through, and which cannot return true.
 * `Block.autoplay` still round-trips (PLATFORM §3); it is simply not obeyed.
 *
 * Pure and DOM-free, so scripts/test-spaces-model.ts pins it directly.
 */
export interface MediaPlayback {
  kind: 'video' | 'audio'
  /** absent = shown: a player with no controls is a rectangle you cannot use */
  controls: boolean
  loop: boolean
  /** browsers require muted for video autoplay — kept as a plain author choice
   *  here, because nothing in this app autoplays for it to unlock */
  muted: boolean
  /** ALWAYS false. See above. */
  autoplay: false
}

export function mediaPlayback(b: Block): MediaPlayback {
  return {
    kind: String(b.kind ?? 'video') === 'audio' ? 'audio' : 'video',
    controls: b.controls !== false,
    loop: b.loop === true,
    muted: b.muted === true,
    autoplay: false,
  }
}

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
