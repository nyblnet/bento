// Self-update: a shipped Bento file can, ON USER REQUEST ONLY, ask the
// release origin whether a newer app shell exists, and rebuild itself as
// "same document, newer app" — the data block re-spliced into the fetched
// shell via the exact machinery every save already uses.
//
// Trust model (see docs/architecture.md):
// - The manifest is SIGNED (ECDSA P-256 / SHA-256) with an offline key; the
//   matching public key is embedded below in every shipped shell. A
//   compromised host or repo cannot forge a release without that key.
// - The manifest pins the new shell's sha256; the download is hashed and
//   compared before anything is spliced.
// - Only strictly NEWER versions are ever offered (no downgrade replay).
// - Nothing is automatic and nothing identifies the user or the document:
//   the check is a bare GET, fired only from the About dialog / scripting.
//
// The result is always a NEW downloaded file — the update flow never touches
// the file on disk, so the original is its own rollback.

import type { BentoDoc } from './model'
import {
  serializeWith, serializeFile, suggestedFileName, downloadFile,
  hasFileHandle, writeUpdatedFile, writeUpdatedFileAs,
} from './save'

declare const __APP_VERSION__: string

/** Version of the running app shell (baked in at build from package.json). */
export const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'

/** Where shipped files look for releases. Dev override: localStorage 'bento-update-url'. */
export const UPDATE_MANIFEST_URL = 'https://bento.page/releases/slides/manifest.json'

// Release signing PUBLIC key. The private half lives offline with the
// maintainer (scripts/keygen.mjs → ~/.bento/release-key.json) and signs
// manifests via scripts/sign-release.mjs. Rotating this key orphans every
// previously shipped file — guard the private key instead.
const PUBLIC_KEY_JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: 'GMHSKwWcAoJVq-Dz1ZxWZM6TXATWIKbaQBpjoTystH8',
  y: 'flFNzbdXCmJN8RQYCeG71rBZnnbN-MCEnp1EbCLFrj0',
} as const

export interface ReleaseInfo {
  app: string
  version: string
  /** hex sha256 of the release shell's bytes */
  sha256: string
  /** absolute URL of the release shell */
  url: string
  notes?: string
  at?: string
}

export type UpdateCheck =
  | { status: 'current'; version: string }
  | { status: 'update'; release: ReleaseInfo }
  | { status: 'error'; message: string }

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Dotted-numeric compare: 0.2.0 > 0.1.9 > 0.1 — positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

/**
 * Verify the manifest signature and return its payload. The signature covers
 * the payload's exact string bytes — no JSON canonicalization involved.
 */
async function verifyManifest(raw: string): Promise<ReleaseInfo> {
  let payload: string, sig: string
  try {
    ;({ payload, sig } = JSON.parse(raw))
  } catch {
    throw new Error('the release manifest is not valid JSON')
  }
  if (typeof payload !== 'string' || typeof sig !== 'string')
    throw new Error('the release manifest is malformed')

  const key = await crypto.subtle.importKey(
    'jwk', PUBLIC_KEY_JWK as JsonWebKey,
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
  )
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, key,
    b64ToBytes(sig), new TextEncoder().encode(payload),
  )
  if (!ok) throw new Error('the release signature is INVALID — refusing this update')

  const info = JSON.parse(payload)
  if (
    info?.app !== 'bento-slides' ||
    typeof info.version !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(info.sha256 ?? '') ||
    typeof info.url !== 'string'
  )
    throw new Error('the release manifest payload is malformed')
  return info as ReleaseInfo
}

/** Ask the release origin for the latest version. User-initiated only. */
export async function checkForUpdates(manifestUrl?: string): Promise<UpdateCheck> {
  const url = manifestUrl ?? localStorage.getItem('bento-update-url') ?? UPDATE_MANIFEST_URL
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) throw new Error(`release server answered ${res.status}`)
    const release = await verifyManifest(await res.text())
    if (compareVersions(release.version, APP_VERSION) <= 0)
      return { status: 'current', version: APP_VERSION }
    return { status: 'update', release }
  } catch (err: any) {
    return { status: 'error', message: err?.message ?? String(err) }
  }
}

/**
 * Fetch the release shell, verify its hash against the signed manifest, and
 * return the full updated .bento.html: this document inside the new app.
 */
export async function buildUpdatedFile(release: ReleaseInfo, doc: BentoDoc): Promise<string> {
  const res = await fetch(release.url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`downloading the update failed (${res.status})`)
  const bytes = await res.arrayBuffer()
  const digest = hex(await crypto.subtle.digest('SHA-256', bytes))
  if (digest !== release.sha256.toLowerCase())
    throw new Error('the downloaded update failed its integrity check — refusing it')

  const shell = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'text/html')
  if (!shell.getElementById('bento-doc'))
    throw new Error('the downloaded update is not a Bento shell')
  return serializeWith(shell, doc)
}

/** Build the updated file and hand it to the user as a fresh download. */
export async function applyUpdate(release: ReleaseInfo, doc: BentoDoc): Promise<void> {
  downloadFile(await buildUpdatedFile(release, doc), suggestedFileName(doc))
}

/** Can we rewrite the open file directly (a FS Access handle is held)? */
export const canUpdateInPlace = hasFileHandle

/**
 * Update the file on disk. With a held handle: download a backup of the
 * current version first, then overwrite in place — a reload then boots the
 * new app with this document. Without one: a save picker lets the user point
 * at the file they have open (or anywhere). Returns false if cancelled.
 */
export async function applyUpdateInPlace(release: ReleaseInfo, doc: BentoDoc): Promise<boolean> {
  const html = await buildUpdatedFile(release, doc)
  if (hasFileHandle()) {
    const base = suggestedFileName(doc).replace(/\.bento\.html$/, '')
    downloadFile(serializeFile(doc), `${base}.v${APP_VERSION}-backup.bento.html`)
    await writeUpdatedFile(html)
    return true
  }
  return writeUpdatedFileAs(html, doc)
}
