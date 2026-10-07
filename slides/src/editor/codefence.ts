// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Code in a TEXT box, two ways (maintainer request, 2026-10-07):
//
// 1. A fence. Lines between ``` and ``` (optionally ```js, ```python…) become
//    a real Code element when the edit is committed, or when such text is
//    pasted onto the canvas: highlighted, language-aware, and able to morph.
//    A box that is ONLY a fence turns into the Code element in place (same id,
//    so its morph pairing survives); a box with text around the fence splits
//    into text / code / text, stacked where the parts were.
// 2. A selection. Selecting text and pressing ` wraps each selected line in
//    <code> (pressed again on code, it unwraps), like ⌘B for bold.
//
// The fence rules are DOM-free (the rig drives them in node); only
// toggleCodeOnSelection touches the document.

import { LANGS } from '../../../kernel/src/tokenize.ts'
import { defaultCode, uid, type CodeElement, type SlideElement, type TextElement } from '../model.ts'

/** A fence line: ``` with an optional info string (the language). Spaces and
 *  NBSPs around it are allowed — contentEditable turns spaces into NBSPs. */
const FENCE = /^[ \t ]*```[ \t ]*([\w+#.-]*)[ \t ]*$/

const isOpen = (line: string) => FENCE.test(line)
const isClose = (line: string) => { const m = line.match(FENCE); return !!m && m[1] === '' }

/** Common info-string spellings → the built-in tokenizer's language ids. */
const ALIASES: Record<string, string> = {
  javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
  typescript: 'ts', tsx: 'ts', mts: 'ts',
  python: 'py', py3: 'py', python3: 'py',
  bash: 'sh', shell: 'sh', console: 'sh', shellscript: 'sh', shellsession: 'sh',
  'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', h: 'c',
  'c#': 'csharp', cs: 'csharp', 'f#': 'fsharp', fs: 'fsharp',
  rb: 'ruby', rs: 'rust', golang: 'go', kt: 'kotlin', kts: 'kotlin',
  yml: 'yaml', markdown: 'md', htm: 'html', xhtml: 'html', svg: 'xml',
  docker: 'dockerfile', tf: 'hcl', terraform: 'hcl',
  'objective-c': 'objc', objectivec: 'objc', ps1: 'powershell', pwsh: 'powershell',
  ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', ml: 'ocaml', pl: 'perl',
  psql: 'sql', postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql',
  patch: 'diff', make: 'makefile', mk: 'makefile', jl: 'julia', clj: 'clojure',
  scm: 'scheme', tex: 'latex', bat: 'batch', cmd: 'batch', vbnet: 'vb',
  sol: 'solidity', protobuf: 'proto', gql: 'graphql', j2: 'jinja', jinja2: 'jinja',
}

/** The Code element language for a fence's info string, or undefined when it
 *  names nothing built in (the element then keeps its default). */
export function codeLanguage(info: string): string | undefined {
  const k = info.trim().toLowerCase()
  if (!k) return undefined
  const id = ALIASES[k] ?? k
  return id in LANGS || id === 'diff' || id === 'md' ? id : undefined
}

export type FencePart =
  | { kind: 'text'; lines: string[] }
  | { kind: 'code'; lines: string[]; lang?: string }

/**
 * Split plain text (lines) into text and fenced-code parts. Only a CLOSED fence
 * counts: an opener with no closer stays text, so a half-typed fence is never
 * swallowed. Blank lines at the edges of a text part are dropped, and a part
 * that is all blank disappears (the line between a heading and its fence).
 */
export function splitFences(text: string): FencePart[] {
  const lines = text.replace(/​/g, '').replace(/\r\n?/g, '\n').split('\n')
  const parts: FencePart[] = []
  let buf: string[] = []
  const flush = () => {
    while (buf.length && !buf[0].trim()) buf.shift()
    while (buf.length && !buf[buf.length - 1].trim()) buf.pop()
    if (buf.length) parts.push({ kind: 'text', lines: buf })
    buf = []
  }
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(FENCE)
    if (m) {
      let j = i + 1
      while (j < lines.length && !isClose(lines[j])) j++
      if (j < lines.length) {
        flush()
        const lang = codeLanguage(m[1])
        parts.push({ kind: 'code', lines: lines.slice(i + 1, j), ...(lang ? { lang } : {}) })
        i = j
        continue
      }
    }
    buf.push(lines[i])
  }
  flush()
  return parts
}

/** True when the text holds at least one closed fence. */
export const hasFence = (text: string): boolean => splitFences(text).some((p) => p.kind === 'code')

/** True when the END of `before` (the text up to the caret) is inside an open
 *  fence: markdown autoformat must leave code alone, or a template literal's
 *  backticks — `hello` — would vanish into a <code> tag. */
export function insideOpenFence(before: string): boolean {
  let open = false
  for (const line of before.replace(/​/g, '').split('\n')) {
    if (!open && isOpen(line)) open = true
    else if (open && isClose(line)) open = false
  }
  return open
}

/** The fields an element keeps whatever its type. The first part keeps the
 *  box's identity; later parts get fresh ids and drop what must stay unique on
 *  a slide (the morph key) or names one specific box (its role). */
const BASE_KEYS = ['morphId', 'rotation', 'opacity', 'shadow', 'blur', 'blend', 'backdropFilter',
  'fx', 'link', 'group', 'groupId', 'showOnHover', 'role'] as const
const UNIQUE_KEYS = ['morphId', 'role'] as const

export type PartFrame = { y: number; h: number; html?: string }

/**
 * The elements a fenced text box becomes, in order. `frames[i]` places part i
 * (slide units) and, for a text part, may carry its html (formatting kept);
 * without it the part's lines are used as plain text.
 */
export function fencedElements(src: TextElement, parts: FencePart[], frames: PartFrame[]): SlideElement[] {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return parts.map((part, i) => {
    const { y, h } = frames[i]
    const id = i === 0 ? src.id : uid(part.kind === 'code' ? 'code' : 'text')
    const base: Record<string, unknown> = {}
    for (const k of BASE_KEYS) if ((src as unknown as Record<string, unknown>)[k] !== undefined) base[k] = structuredClone((src as unknown as Record<string, unknown>)[k])
    if (i > 0) for (const k of UNIQUE_KEYS) delete base[k]
    if (part.kind === 'code') {
      const themeColor = src.themeRefs?.color
      return defaultCode({
        ...(base as Partial<CodeElement>),
        id, x: src.x, y, w: src.w, h,
        fontSize: src.fontSize, color: src.color, align: 'left', valign: 'top',
        content: part.lines.join('\n'),
        ...(part.lang ? { grammarName: part.lang } : {}),
        ...(themeColor ? { themeRefs: { color: themeColor } } : {}),
      })
    }
    const text: TextElement = structuredClone(src)
    if (i > 0) for (const k of UNIQUE_KEYS) delete (text as unknown as Record<string, unknown>)[k]
    text.id = id
    text.y = y
    text.h = h
    text.html = frames[i].html ?? part.lines.map(esc).join('<br>')
    return text
  })
}

/** Heights when there is no rendered DOM to measure (a paste): one line box per
 *  line at the text's size, code at the Code element's own line height. */
export function estimatedFrames(src: Pick<TextElement, 'y' | 'fontSize' | 'lineHeight'>, parts: FencePart[], gap = 16): PartFrame[] {
  let y = src.y
  return parts.map((p) => {
    const lh = p.kind === 'code' ? 1.25 : (src.lineHeight || 1.2)
    const h = Math.ceil(Math.max(1, p.lines.length) * src.fontSize * lh + (p.kind === 'code' ? src.fontSize : 0))
    const frame = { y, h }
    y += h + gap
    return frame
  })
}

/** The plain text of `root` up to (node, offset), with a newline at every <br>
 *  and block boundary — what insideOpenFence needs, which Range.toString()
 *  (no line breaks) cannot give. */
export function textUpTo(root: HTMLElement, node: Node, offset: number): string {
  const r = document.createRange()
  r.setStart(root, 0)
  r.setEnd(node, offset)
  const box = document.createElement('div')
  box.append(r.cloneContents())
  return lineHtml(box).map((l) => l.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).join('\n')
}

// --- 2. selection → <code> (DOM) --------------------------------------------

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const BLOCK = new Set(['DIV', 'P', 'LI', 'H1', 'H2'])

/** A fragment's content as html, one string per rendered line (<br> and block
 *  boundaries split lines). Inline formatting inside a line is kept. */
function lineHtml(root: Node): string[] {
  const lines = ['']
  const walk = (n: Node) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeName === 'BR') { lines.push(''); continue }
      if (c instanceof Element && BLOCK.has(c.tagName)) {
        if (lines[lines.length - 1] !== '') lines.push('')
        walk(c)
        lines.push('')
        continue
      }
      if (c instanceof Element) {
        if (c.querySelector('br,div,p,li,h1,h2')) walk(c) // a wrapper spanning lines: keep its lines, not the wrapper
        else lines[lines.length - 1] += c.outerHTML
        continue
      }
      if (c.nodeType === Node.TEXT_NODE) lines[lines.length - 1] += escapeHtml((c as Text).data)
    }
  }
  walk(root)
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Toggle inline code on the selection inside `root` (the editing text box).
 * Every selected line is wrapped in its own <code>; when everything selected
 * is already code, the touched code is unwrapped instead. Goes through
 * insertHTML so the browser's own ⌘Z undoes it. Returns false — and does
 * nothing — when there is no selection inside `root` (a plain ` keystroke).
 */
export function toggleCodeOnSelection(root: HTMLElement): boolean {
  const sel = document.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return false
  const range = sel.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return false
  const codeOf = (n: Node | null): HTMLElement | null => {
    const c = (n instanceof Element ? n : n?.parentElement)?.closest('code') ?? null
    return c && root.contains(c) ? c as HTMLElement : null
  }
  // the text the selection actually covers, ignoring caret spacers
  const texts: Text[] = []
  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT)
  for (let n = walker.currentNode; n; n = walker.nextNode() as Node) {
    if (n.nodeType === Node.TEXT_NODE && range.intersectsNode(n) && (n as Text).data.replace(/​/g, '').trim()) texts.push(n as Text)
  }
  if (!texts.length) return false
  const allCode = texts.every((t) => codeOf(t))
  // never insert INSIDE a code element: widen the range over any code element
  // it starts or ends in, so the result replaces it rather than nesting
  const startCode = codeOf(range.startContainer)
  const endCode = codeOf(range.endContainer)
  if (startCode) range.setStartBefore(startCode)
  if (endCode) range.setEndAfter(endCode)
  const box = document.createElement('div')
  box.append(range.cloneContents())
  box.querySelectorAll('code').forEach((c) => c.replaceWith(...Array.from(c.childNodes)))
  const lines = lineHtml(box)
  const html = allCode
    ? lines.join('<br>')
    : lines.map((l) => (l.replace(/​/g, '').trim() ? `<code>${l}</code>` : l)).join('<br>')
  sel.removeAllRanges()
  sel.addRange(range)
  document.execCommand('insertHTML', false, html)
  return true
}
