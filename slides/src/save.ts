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

/** Serialize a raw data-block body into an app shell. */
function serializeBody(shell: Document, body: string, title: string): string {
  const clone = shell.cloneNode(true) as Document

  let block = clone.getElementById(DATA_BLOCK_ID)
  if (!block) {
    block = clone.createElement('script')
    block.setAttribute('type', 'application/bento+json')
    block.id = DATA_BLOCK_ID
    clone.head.appendChild(block)
  }
  // <-escape so the JSON can never contain "</script>" and break the file.
  block.textContent = '\n' + body.replace(/</g, '\\u003c') + '\n'

  const titleEl = clone.querySelector('title')
  if (titleEl) titleEl.textContent = title + ' — Bento Slides'

  const html = '<!DOCTYPE html>\n' + clone.documentElement.outerHTML
  // Belt-and-braces: an unescaped close tag anywhere in generated output would
  // corrupt the file; this should never trigger given the escaping above.
  if (html.split(SCRIPT_CLOSE).length !== clone.querySelectorAll('script').length + 1) {
    console.warn('bento: unexpected script-close count in serialized file')
  }
  return html
}

/**
 * Serialize `doc` into an arbitrary app shell (a parsed Bento HTML document).
 * Used with the boot-time pristine copy on every save, and by the self-update
 * flow with a freshly fetched NEWER shell — same document, new app around it.
 * PLAIN output — encryption-aware callers use serializeDocInto/serializeAuto.
 */
export function serializeWith(shell: Document, doc: BentoDoc): string {
  return serializeBody(shell, JSON.stringify(doc), doc.title)
}

/** The full .bento.html file content with `doc` embedded (plain). */
export function serializeFile(doc: BentoDoc): string {
  if (!pristine) throw new Error('capturePristine() was not called at boot')
  return serializeWith(pristine, doc)
}

// --- password encryption ----------------------------------------------------
//
// An encrypted file keeps the SAME plaintext #bento-doc block (the splice
// contract old updaters rely on) — but the block holds a bento/enc envelope
// instead of the document: AES-GCM-256 over the doc JSON, key derived from
// the password with PBKDF2-SHA-256. The password is held in memory for the
// session so ⌘S and self-update keep writing encrypted output.

export interface EncEnvelope {
  format: 'bento/enc'
  v: 1
  it: number
  salt: string
  iv: string
  data: string
}

const ENC_ITERATIONS = 300_000

const eb64 = {
  enc(bytes: Uint8Array): string {
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s)
  },
  dec(s: string): Uint8Array {
    const b = atob(s)
    const out = new Uint8Array(b.length)
    for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
    return out
  },
}

let encPassword: string | null = null

/** Set (or clear with null) the password used for every subsequent save. */
export function setEncryptionPassword(p: string | null) {
  encPassword = p
}

export const isEncryptionActive = () => encPassword !== null

/** Parse a data-block body as an encryption envelope; null if it is not one. */
export function parseEnvelope(text: string): EncEnvelope | null {
  try {
    const env = JSON.parse(text)
    if (env && env.format === 'bento/enc' && env.v === 1 && env.data && env.salt && env.iv) {
      return env as EncEnvelope
    }
  } catch {
    /* not an envelope */
  }
  return null
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

async function encryptBody(json: string, password: string): Promise<string> {
  const salt = new Uint8Array(16)
  const iv = new Uint8Array(12)
  crypto.getRandomValues(salt)
  crypto.getRandomValues(iv)
  const key = await deriveKey(password, salt, ENC_ITERATIONS)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(json))
  const env: EncEnvelope = {
    format: 'bento/enc', v: 1, it: ENC_ITERATIONS,
    salt: eb64.enc(salt), iv: eb64.enc(iv), data: eb64.enc(new Uint8Array(ct)),
  }
  return JSON.stringify(env)
}

/** Decrypt an envelope with a candidate password; null on wrong password. */
export async function decryptEnvelope(env: EncEnvelope, password: string): Promise<string | null> {
  try {
    const key = await deriveKey(password, eb64.dec(env.salt), env.it || ENC_ITERATIONS)
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: eb64.dec(env.iv) as BufferSource }, key, eb64.dec(env.data) as BufferSource)
    return new TextDecoder().decode(pt)
  } catch {
    return null
  }
}

/**
 * Encryption-aware serialization into an arbitrary shell — THE path for
 * saves and self-updates. Plain when no password is active.
 */
export async function serializeDocInto(shell: Document, doc: BentoDoc): Promise<string> {
  const body = encPassword
    ? await encryptBody(JSON.stringify(doc), encPassword)
    : JSON.stringify(doc)
  return serializeBody(shell, body, doc.title)
}

/** Encryption-aware serializeFile. */
export async function serializeAuto(doc: BentoDoc): Promise<string> {
  if (!pristine) throw new Error('capturePristine() was not called at boot')
  return serializeDocInto(pristine, doc)
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
  const html = await serializeAuto(doc)
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
