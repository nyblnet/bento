// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Self-update: a shipped Bento file asks the release origin whether a newer
// app shell exists — automatically at launch (per-browser opt-out in the
// About dialog) or on demand — and rebuilds itself as "same document, newer
// app": the data block re-spliced into the fetched shell via the exact
// machinery every save already uses.
//
// Trust model (see docs/architecture.md):
// - The manifest is SIGNED (ECDSA P-256 / SHA-256) with an offline key; the
//   matching public key is embedded below in every shipped shell. A
//   compromised host or repo cannot forge a release without that key.
// - The manifest pins the new shell's sha256; the download is hashed and
//   compared before anything is spliced.
// - Only strictly NEWER versions are ever offered (no downgrade replay).
// - A check is a bare GET: no identifiers, no telemetry, nothing about the
//   user or the document. The launch check can be disabled (autoCheckEnabled).
//
// The result is always a NEW downloaded file — the update flow never touches
// the file on disk, so the original is its own rollback.

import type { KernelDoc } from './doc.ts'
import { appConfig } from './app.ts'
import {
  serializeDocInto, serializeAuto, suggestedFileName, downloadFile, openedFileName, fileBase,
  hasFileHandle, writeUpdatedFile, writeUpdatedFileAs,
} from './save.ts'
import { lsDel, lsGet, lsSet } from './storage.ts'

declare const __APP_VERSION__: string

/** Version of the running app shell (baked in at build from package.json). */
export const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'

/** Per-browser preference: check for updates automatically at launch. */
/**
 * Offline mode: a hard, viewer-side switch that blocks EVERY network touch —
 * update checks and online collaboration alike. Same-machine tab sync
 * (BroadcastChannel) is not networking and stays on. The guarantee this
 * buys: with the switch on, nothing about you or a document ever leaves
 * this computer.
 */
export const offlineEnabled = (): boolean => {
  try {
    return lsGet('bento-offline') === 'on'
  } catch {
    return false
  }
}
export const setOffline = (on: boolean): void => {
  try {
    lsSet('bento-offline', on ? 'on' : 'off')
  } catch {
    /* storage unavailable */
  }
}

export const autoCheckEnabled = (): boolean => lsGet('bento-auto-check') !== 'off'
export const setAutoCheck = (on: boolean): void => {
  if (on) lsDel('bento-auto-check')
  else lsSet('bento-auto-check', 'off')
}

/** Where shipped files look for releases (per-app, from configureApp).
 *  Dev override: localStorage 'bento-update-url'. */
export const updateManifestUrl = (): string => appConfig().manifestUrl

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
  /**
   * Per-version lead-ins, newest first, e.g. { '1.0.13': ['…'], '1.0.12': ['…'] }.
   * Lets a client show exactly the versions it skipped rather than only the
   * newest. ADDITIVE — `notes` remains the string every already-shipped file
   * reads, because their update code is frozen and cannot learn this field.
   */
  notesFrom?: Record<string, string[]>
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
 * Verify a SIGNED ENVELOPE and return its parsed payload.
 *
 * The envelope is `{ payload: "<json string>", sig: "<base64>" }` and the
 * signature (ECDSA P-256 / SHA-256, made offline by scripts/sign-release.mjs)
 * covers the payload's exact UTF-8 bytes — no JSON canonicalization involved,
 * which is why the payload travels as a string rather than as an object.
 *
 * This is the ONLY place in the kernel that does release-channel crypto.
 * Anything else the channel serves — the release manifest, the language-pack
 * index (slides/src/packs.ts) — verifies through here against the SAME
 * embedded key, then applies its own shape checks to the payload. One trust
 * root, one code path: a second implementation is a second thing to get
 * wrong, and a signature check that is subtly wrong looks exactly like one
 * that is right.
 *
 * Throws on anything short of a good signature. `what` only names the thing
 * in those messages.
 */
export async function verifySigned(raw: string, what = 'signed file'): Promise<unknown> {
  let payload: string, sig: string
  try {
    ;({ payload, sig } = JSON.parse(raw))
  } catch {
    throw new Error(`the ${what} is not valid JSON`)
  }
  if (typeof payload !== 'string' || typeof sig !== 'string')
    throw new Error(`the ${what} is malformed`)

  const key = await crypto.subtle.importKey(
    'jwk', PUBLIC_KEY_JWK as JsonWebKey,
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
  )
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, key,
    b64ToBytes(sig), new TextEncoder().encode(payload),
  )
  if (!ok) throw new Error(`the ${what} signature is INVALID — refusing it`)

  try {
    return JSON.parse(payload)
  } catch {
    throw new Error(`the ${what} payload is not valid JSON`)
  }
}

/** Lowercase hex sha256 of some bytes — the digest form every pin uses. */
const sha256Hex = async (bytes: BufferSource): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', bytes))

/**
 * Fetch an artifact and hand it back ONLY if its bytes hash to `sha256`.
 * Returns null on anything else: unreachable, non-200, malformed pin, or a
 * digest that doesn't match. Fail closed — the caller decides what a refusal
 * means, but it never gets unverified bytes to decide with.
 *
 * The pinned digest must itself come from something signed (a manifest, a
 * signed index) — verifySigned above. Signature over the pin, pin over the
 * bytes: that chain is what makes a plain https GET from a CDN trustworthy,
 * and it is the same two steps the app shell's own update goes through.
 *
 * SCOPE, deliberately: these two helpers verify BYTES. They do not decide
 * what those bytes are, or what is safe to do with them — that is the
 * caller's policy and it is not one-size-fits-all. Language packs are DATA
 * with a bounded failure mode (wrong words on screen), so packs.ts can keep a
 * stale pack when a refresh fails. Anything side-loaded that carries CODE
 * would need much stricter policy — pinned at install, never auto-refreshed —
 * and must not inherit the pack rules by accident just because it reuses this
 * fetch.
 */
export async function fetchPinned(url: string, sha256: string): Promise<ArrayBuffer | null> {
  if (!/^[0-9a-f]{64}$/i.test(sha256 ?? '')) return null
  let bytes: ArrayBuffer
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return null
    bytes = await res.arrayBuffer()
  } catch {
    return null
  }
  return (await sha256Hex(bytes)) === sha256.toLowerCase() ? bytes : null
}

/**
 * Verify the manifest signature and return its payload: the signature check
 * above, plus the shape checks that make a payload a release.
 */
async function verifyManifest(raw: string): Promise<ReleaseInfo> {
  const info = (await verifySigned(raw, 'release manifest')) as any
  if (
    info?.app !== appConfig().appId ||
    typeof info.version !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(info.sha256 ?? '') ||
    typeof info.url !== 'string'
  )
    throw new Error('the release manifest payload is malformed')
  return info as ReleaseInfo
}

/** Ask the release origin for the latest version. */
export async function checkForUpdates(manifestUrl?: string): Promise<UpdateCheck> {
  const url = manifestUrl ?? lsGet('bento-update-url') ?? updateManifestUrl()
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
/**
 * Run by buildUpdatedFile once the new version is known and verified, BEFORE
 * the document is serialized into it. Lets an app bring version-bound extras
 * up to date — language packs are the case this exists for.
 *
 * Kept as a hook rather than baked in because the kernel must not learn what
 * a language pack is; it only knows the app may want a moment before the new
 * shell is written.
 */
let prepareUpdate: ((version: string) => Promise<void>) | null = null

export function registerUpdatePrepare(fn: (version: string) => Promise<void>): void {
  prepareUpdate = fn
}

export async function buildUpdatedFile(release: ReleaseInfo, doc: KernelDoc): Promise<string> {
  const res = await fetch(release.url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`downloading the update failed (${res.status})`)
  const bytes = await res.arrayBuffer()
  // Same pin as fetchPinned, spelled out here because THIS path distinguishes
  // "the download failed" from "the download was tampered with" for the user.
  const digest = await sha256Hex(bytes)
  if (digest !== release.sha256.toLowerCase())
    throw new Error('the downloaded update failed its integrity check — refusing it')

  const shell = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'text/html')
  if (!shell.getElementById('bento-doc'))
    throw new Error('the downloaded update is not a Bento shell')

  // BEST EFFORT, never fatal. If refreshing throws — offline, the new
  // version's packs not published yet, anything — the update must still
  // proceed and carry the EXISTING packs forward. Losing a language the
  // author baked in is far worse than one that is a release out of date,
  // because a stale pack still degrades per string while a missing one
  // takes the whole language with it.
  if (prepareUpdate) {
    try {
      await prepareUpdate(release.version)
    } catch {
      /* keep whatever the file already carries */
    }
  }
  return serializeDocInto(shell, doc)
}

/** Build the updated file and hand it to the user as a fresh download.
 *  Named after the file they have open, not the deck title — an update
 *  REPLACES that file, so "Q3-board.bento.html" is the answer even when the
 *  deck is titled "Q3 Board Review". */
export async function applyUpdate(release: ReleaseInfo, doc: KernelDoc): Promise<void> {
  downloadFile(await buildUpdatedFile(release, doc), openedFileName() ?? suggestedFileName(doc))
}

/** Can we rewrite the open file directly (a FS Access handle is held)? */
export const canUpdateInPlace = hasFileHandle

/**
 * Update the file on disk, then a reload boots the new app with this document.
 *
 * With a held handle: download a backup of the current version first, then
 * overwrite the file in place silently.
 *
 * Without a handle (e.g. the file was double-clicked open — the browser grants
 * no handle on open): use a save picker AND KEEP the resulting handle, so this
 * update and every later one can rewrite the file in place. The picker is
 * pre-filled with the open file's own NAME (taken from the document URL); its
 * DIRECTORY still cannot be set — the API accepts a handle, never a path — so
 * the caller must still tell the user to overwrite the file they have open.
 * Once they do, it is a one-time grant. Returns false if cancelled.
 */
export async function applyUpdateInPlace(release: ReleaseInfo, doc: KernelDoc): Promise<boolean> {
  const html = await buildUpdatedFile(release, doc)
  // Both names below follow the OPEN FILE, not the deck title: the backup sits
  // beside the original, and the picker opens pre-filled with the very file the
  // user is being asked to overwrite.
  const current = openedFileName()
  if (hasFileHandle()) {
    const base = fileBase(current ?? suggestedFileName(doc))
    downloadFile(await serializeAuto(doc), `${base}.v${APP_VERSION}-backup.bento.html`)
    await writeUpdatedFile(html)
    return true
  }
  return writeUpdatedFileAs(html, doc, { keepHandle: true, suggestedName: current ?? undefined })
}
