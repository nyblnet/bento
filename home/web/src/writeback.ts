// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/home in your browser, stage 2: what a save writes.
//
// The document's own shell saves as it always does: ⌘S (or its autosave
// write-back, or "Save a copy…") serializes the whole file and hands it to
// showSaveFilePicker's writable. Inside the frame that writable is the frame
// script's, which posts the html to the library on the session port. The
// library NEVER writes that html. The frame is the document's realm, so the
// html is only as trustworthy as the least careful release that ever ran there.
// Instead it takes the DATA out of it and puts that data back into the bytes it
// verified and served for this open:
//
//   - the #bento-doc block's text,
//   - every other Bento data block (language packs, extension data: the
//     application/bento+json and application/bento+lang blocks a shell
//     re-declares on save), element for element,
//   - the <title> text, unless the document is an encrypted envelope: then
//     the app's generic name (what the kernel writes for a sealed body), never
//     the posted text, which a hostile frame could fill with the plaintext.
//
// The first-page preview is NEVER carried (security ruling on #998, M2): it is
// markup, and gate 1 reads attribute values raw, so an entity-encoded meta
// refresh in it passes the judge and still navigates before the remover runs.
// A file saved here has no preview until a shell saves it elsewhere, which
// every release reads the same as a file without one.
//
// Everything else, every byte of code and every other byte of markup, is the
// served file's. Then the result is judged again with gate 1 against the held
// histories, and it must be THE SAME release the open was served as. So a
// document that posts a file with other code (a fork, a newer runtime, a
// planted script) still writes the code that was verified.
//
// Pure: the histories come in as an argument, so node rigs run it unchanged.

import { scanBlocks, isDataScript, markupProblems, type Block, type History } from '../../../kernel/src/gate1.ts'
import { judge, APPS } from './verify.ts'

/** What a save is for, by the picker id the kernel passes (kernel/src/save.ts pickerIdFor). */
export const PURPOSES = ['bento-doc', 'bento-copy', 'bento-share', 'bento-backup'] as const
export type Purpose = typeof PURPOSES[number]

/** The data blocks carried besides #bento-doc: those a shell re-declares on save. */
const CARRIED = new Set(['application/bento+json', 'application/bento+lang'])
const ATTR = 'data-bento-preview'
/** How much of the text before a carried element finds its place in the served bytes. */
const ANCHOR = 64

interface Span { start: number; end: number }
interface Parts { doc: Block; extras: Block[]; title: Span | null; preview: Span | null }

const count = (h: string, s: string) => h.split(s).length - 1

function parts(html: string): Parts | { refuse: string } {
  const blocks = scanBlocks(html)
  const docs = blocks.filter((b) => b.id === 'bento-doc')
  if (docs.length !== 1 || !isDataScript(docs[0]) || docs[0].type !== 'application/bento+json') return { refuse: 'not exactly one document block' }
  const doc = docs[0]
  if (doc.text.includes('<')) return { refuse: 'the document block contains "<"' }
  const extras = blocks.filter((b) => b !== doc && isDataScript(b) && CARRIED.has(b.type!))
  if (extras.some((b) => b.text.includes('<'))) return { refuse: 'a data block contains "<"' }
  const t = /<title>([^<]*)<\/title>/.exec(html)
  const title = t ? { start: t.index + 7, end: t.index + 7 + t[1].length } : null
  // the preview: its host element, then the remover straight after it (the
  // shape save.ts writes and gate 1's strict check collapses)
  let preview: Span | null = null
  const first = html.indexOf(ATTR)
  if (first >= 0) {
    const rem = blocks.filter((b) => b.preview && b.tag === 'script')
    const start = html.lastIndexOf('<', first)
    // the attribute twice (host, remover tag) outside the remover's own text
    const outside = rem.length === 1 ? html.slice(0, rem[0].start) + html.slice(rem[0].start + rem[0].text.length) : ''
    if (rem.length !== 1 || count(outside, ATTR) !== 2 || start >= rem[0].tagStart) return { refuse: 'a preview that is not one host and its remover' }
    preview = { start, end: rem[0].end }
  }
  return { doc, extras, title, preview }
}

export type Resplice =
  | { html: string; docText: string; encrypted: boolean; previewDropped: boolean }
  | { refuse: string }

/**
 * The file to write for a save: the posted file's data in the served file's
 * bytes, judged again. `served` must be the bytes this open was served as,
 * `release` that open's verdict (app and version).
 */
export async function resplice(served: string, posted: string, held: History[], release: { appId: string; version: string }): Promise<Resplice> {
  const S = parts(served)
  if ('refuse' in S) return { refuse: `served: ${S.refuse}` }
  const P = parts(posted)
  if ('refuse' in P) return P

  // 1. the served bytes with their variable spans replaced or taken out
  const edits: Array<Span & { text: string }> = [{ start: S.doc.start, end: S.doc.start + S.doc.text.length, text: P.doc.text }]
  const encrypted = isEnvelope(P.doc.text)
  // a sealed body gets the generic title even when the served one was the plaintext's (it became encrypted)
  if (S.title && encrypted) edits.push({ ...S.title, text: genericTitle(release.appId) })
  else if (S.title && P.title) edits.push({ ...S.title, text: posted.slice(P.title.start, P.title.end) })
  // replace, never append: the served preview always goes (a document that
  // became encrypted must LOSE it), and so does every carried block
  if (S.preview) edits.push({ ...S.preview, text: '' })
  for (const b of S.extras) edits.push({ start: b.tagStart, end: b.end, text: '' })
  edits.sort((a, b) => b.start - a.start)
  let out = served
  let last = Infinity
  for (const e of edits) {
    if (e.end > last) return { refuse: 'overlapping spans in the served file' }
    out = out.slice(0, e.start) + e.text + out.slice(e.end)
    last = e.start
  }

  // 2. the posted elements, each where the text before it says, else after the document block
  const place = (el: string, before: string): boolean => {
    const at = before.length === ANCHOR ? out.indexOf(before) : -1
    if (at >= 0 && out.indexOf(before, at + 1) < 0) { out = out.slice(0, at + ANCHOR) + el + out.slice(at + ANCHOR); return true }
    return false
  }
  for (const b of P.extras) {
    const el = posted.slice(b.tagStart, b.end)
    if (!place(el, posted.slice(Math.max(0, b.tagStart - ANCHOR), b.tagStart))) {
      const d = scanBlocks(out).find((x) => x.id === 'bento-doc')!
      out = out.slice(0, d.end) + el + out.slice(d.end)
    }
  }
  // the posted preview stays out (see the head of this file)
  const previewDropped = P.preview !== null

  // 3. judged again: the same app and release this open was served as
  const v = await judge(out, held)
  if (v.verdict !== 'genuine') return { refuse: `the result is not a release (${markupProblems(out)[0] ?? v.reason})` }
  if (v.appId !== release.appId || v.release.version !== release.version) return { refuse: `the result is ${v.appId} ${v.release.version}, not the release served` }
  const O = parts(out)
  if ('refuse' in O || O.doc.text !== P.doc.text || O.extras.length !== P.extras.length || O.extras.some((b, i) => b.text !== P.extras[i].text)) {
    return { refuse: 'the data did not survive the splice' }
  }
  return { html: out, docText: P.doc.text, encrypted, previewDropped }
}

/** The title a sealed body carries: the app's name, as the kernel writes it (kernel/src/save.ts). */
export const genericTitle = (appId: string): string => APPS.find((a) => a.appId === appId)?.name ?? 'Bento'

/** A password or identity envelope: the document is ciphertext. */
export function isEnvelope(docText: string): boolean {
  try { return (JSON.parse(docText) as { format?: unknown })?.format === 'bento/enc' } catch { return false }
}

/** sha256 hex of a string's UTF-8 bytes. */
export async function hashOf(s: string | ArrayBuffer): Promise<string> {
  const bytes = typeof s === 'string' ? new TextEncoder().encode(s) : new Uint8Array(s)
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** A save message from the frame, checked: the exact key set, a purpose from the list, bounded strings. */
export function parseSave(m: unknown, lastN: number, maxBytes: number): { n: number; purpose: Purpose; name: string; html: string } | null {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null
  const keys = Object.keys(m).sort().join(',')
  if (keys !== 'html,kind,n,name,purpose') return null
  const { kind, n, purpose, name, html } = m as Record<string, unknown>
  if (kind !== 'save' || !Number.isInteger(n) || (n as number) <= lastN) return null
  if (typeof purpose !== 'string' || !(PURPOSES as readonly string[]).includes(purpose)) return null
  if (typeof name !== 'string' || name.length > 255 || typeof html !== 'string' || html.length > maxBytes) return null
  return { n: n as number, purpose: purpose as Purpose, name, html }
}
