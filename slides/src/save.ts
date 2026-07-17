// Self-saving: a Bento file writes itself back to disk with updated data.
//
// At boot (before the app mutates the DOM) we deep-clone the document. On save
// we swap the clone's data block content for the current model JSON and
// serialize the clone back to an HTML string — byte-for-byte the same app
// shell, new document inside. TiddlyWiki pioneered this trick.

import type { BentoDoc } from './model'

const DATA_BLOCK_ID = 'bento-doc'
// Split so the literal never appears in the bundle (it would terminate the
// inline <script> that carries this very code inside a built Bento file).
const SCRIPT_CLOSE = '</scr' + 'ipt>'

let pristine: Document | null = null

/** Call first thing at boot, before any DOM mutation. */
export function capturePristine() {
  pristine = document.cloneNode(true) as Document
}

export function readEmbeddedDoc(): string | null {
  const block = document.getElementById(DATA_BLOCK_ID)
  const text = block?.textContent?.trim()
  return text || null
}

/**
 * Serialize `doc` into an arbitrary app shell (a parsed Bento HTML document).
 * Used with the boot-time pristine copy on every save, and by the self-update
 * flow with a freshly fetched NEWER shell — same document, new app around it.
 */
export function serializeWith(shell: Document, doc: BentoDoc): string {
  const clone = shell.cloneNode(true) as Document

  let block = clone.getElementById(DATA_BLOCK_ID)
  if (!block) {
    block = clone.createElement('script')
    block.setAttribute('type', 'application/bento+json')
    block.id = DATA_BLOCK_ID
    clone.head.appendChild(block)
  }
  // <-escape so the JSON can never contain "</script>" and break the file.
  block.textContent = '\n' + JSON.stringify(doc).replace(/</g, '\\u003c') + '\n'

  const title = clone.querySelector('title')
  if (title) title.textContent = doc.title + ' — Bento Slides'

  const html = '<!DOCTYPE html>\n' + clone.documentElement.outerHTML
  // Belt-and-braces: an unescaped close tag anywhere in generated output would
  // corrupt the file; this should never trigger given the escaping above.
  if (html.split(SCRIPT_CLOSE).length !== clone.querySelectorAll('script').length + 1) {
    console.warn('bento: unexpected script-close count in serialized file')
  }
  return html
}

/** The full .bento.html file content with `doc` embedded. */
export function serializeFile(doc: BentoDoc): string {
  if (!pristine) throw new Error('capturePristine() was not called at boot')
  return serializeWith(pristine, doc)
}

export function suggestedFileName(doc: BentoDoc): string {
  const base = doc.title.replace(/[^\w\d-]+/g, '_').replace(/^_+|_+$/g, '') || 'Untitled'
  return `${base}.bento.html`
}

// --- writing to disk --------------------------------------------------------

type SaveResult = 'saved' | 'saved-as' | 'downloaded' | 'cancelled'

interface FsFileHandle {
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>
  name: string
}

let fileHandle: FsFileHandle | null = null

const hasFsAccess = () => typeof (window as any).showSaveFilePicker === 'function'

async function pickHandle(doc: BentoDoc): Promise<FsFileHandle | null> {
  try {
    return await (window as any).showSaveFilePicker({
      suggestedName: suggestedFileName(doc),
      types: [{ description: 'Bento Slides', accept: { 'text/html': ['.html'] } }],
    })
  } catch (err: any) {
    if (err?.name === 'AbortError') return null
    throw err
  }
}

async function writeHandle(handle: FsFileHandle, html: string) {
  const writable = await handle.createWritable()
  await writable.write(new Blob([html], { type: 'text/html' }))
  await writable.close()
}

export function downloadFile(html: string, name: string) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/**
 * Save the document. Chrome/Edge: File System Access API (picker on first
 * save, silent rewrite after). Firefox/Safari: download a copy.
 */
export async function saveFile(doc: BentoDoc, forcePicker = false): Promise<SaveResult> {
  const html = serializeFile(doc)
  if (hasFsAccess()) {
    if (forcePicker || !fileHandle) {
      const handle = await pickHandle(doc)
      if (!handle) return 'cancelled'
      fileHandle = handle
      await writeHandle(handle, html)
      return 'saved-as'
    }
    await writeHandle(fileHandle, html)
    return 'saved'
  }
  downloadFile(html, suggestedFileName(doc))
  return 'downloaded'
}

export const currentFileName = () => fileHandle?.name ?? null

// --- self-update writing ----------------------------------------------------

/** Whether we hold a writable handle to the file (in-place update possible). */
export const hasFileHandle = () => fileHandle !== null

/** Overwrite the held file with arbitrary html (the freshly updated shell). */
export async function writeUpdatedFile(html: string): Promise<void> {
  if (!fileHandle) throw new Error('no file handle')
  await writeHandle(fileHandle, html)
}

/**
 * Save updated html via a picker (user points it at the file they have open,
 * or anywhere else). Returns false if cancelled. Keeps the picked handle so
 * subsequent ⌘S saves go to the same place.
 */
export async function writeUpdatedFileAs(html: string, doc: BentoDoc): Promise<boolean> {
  if (!hasFsAccess()) {
    downloadFile(html, suggestedFileName(doc))
    return true
  }
  const handle = await pickHandle(doc)
  if (!handle) return false
  fileHandle = handle
  await writeHandle(handle, html)
  return true
}
