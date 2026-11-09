// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/home in your browser: which code may run.
//
// The rule (stage 1): a file runs ONLY in a shell whose every code block
// matches exactly one release in a SIGNED release history. Normally that is
// the file's own shell. A file whose code matches no release opens read-only
// in the newest signed release, and only when the person asks. Unverifiable
// code never runs.
//
// Nothing here is new crypto or a new grammar:
//   - the signature check is the extension's mirror of the kernel's
//     (home/webext/src/release.js, pinned to kernel/src/update.ts's key by
//     scripts/test-webext-release.ts);
//   - the verdict is kernel gate 1 (kernel/src/gate1.ts verifyServedHeld),
//     the same served-path check every native host ports.
//
// Pure: fetch, the key and the bundled histories come in as arguments, so the
// same code runs in the page and in node rigs.

import { verifySigned, verifyManifest, fetchPinned } from '../../webext/src/release.js'
import {
  acceptHistory, historyProblems, verifyServedHeld, scanBlocks, executableScripts, isDataScript,
  type History, type HistoryEntry,
} from '../../../kernel/src/gate1.ts'

export type Jwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string }
type Net = (url: string, init?: RequestInit) => Promise<Response>

/** The apps whose signed histories the library holds: directory on the release channel, and the id its histories carry. */
export const APPS: ReadonlyArray<{ key: string; appId: string; name: string; format: string }> = [
  { key: 'slides', appId: 'bento-slides', name: 'bento/slides', format: 'bento/slides' },
  { key: 'spaces', appId: 'bento-spaces', name: 'bento/spaces', format: 'bento/spaces' },
  { key: 'dash', appId: 'bento-dash', name: 'bento/dash', format: 'bento/dash' },
  { key: 'type', appId: 'bento-type', name: 'bento/type', format: 'bento/type' },
]

/** The largest file the library reads (the extension's served-path cap). */
export const MAX_BYTES = 256 * 1024 * 1024

/**
 * The histories the library holds this visit, one per app. Starts from the
 * signed envelopes bundled into the build; a refresh from the release channel
 * replaces one only when kernel's acceptHistory takes it (append-only, so a
 * replayed older history can never hide a release). Held in memory only:
 * stage 1 keeps nothing.
 */
export class Histories {
  private held = new Map<string, History>()
  private refreshed = false
  private readonly key: Jwk
  private readonly base: string
  private readonly net: Net

  constructor(key: Jwk, base: string, net: Net) {
    this.key = key
    this.base = base.endsWith('/') ? base : base + '/'
    this.net = net
  }

  /** Verify and take one signed envelope. Returns the reason it was refused, or null. */
  async take(raw: string, expectApp?: string): Promise<string | null> {
    let h: History
    try { h = (await verifySigned(raw, 'release history', this.key)) as History } catch (e) { return String((e as Error)?.message ?? e) }
    const problems = historyProblems(h)
    if (problems.length) return `malformed: ${problems[0]}`
    if (expectApp && h.app !== expectApp) return `a history for ${h.app}, not ${expectApp}`
    if (!APPS.some((a) => a.appId === h.app)) return `a history for an app this page does not know (${h.app})`
    const ok = acceptHistory(this.held.get(h.app) ?? null, h, h.app)
    if (!ok.ok) return ok.reason
    this.held.set(h.app, h)
    return null
  }

  list(): History[] { return [...this.held.values()] }
  get(appId: string): History | undefined { return this.held.get(appId) }

  /**
   * Fetch every app's history from the signed release channel, at most once
   * per visit. Called only when a file does not verify against what the build
   * carries, so a file from a bundled release costs no request at all.
   * Returns { appId: 'updated' | reason }.
   */
  async refresh(): Promise<Record<string, string>> {
    const report: Record<string, string> = {}
    if (this.refreshed) return report
    this.refreshed = true
    await Promise.all(APPS.map(async ({ key, appId }) => {
      try {
        const r = await this.net(`${this.base}${key}/history.json`, { cache: 'no-store', credentials: 'omit' })
        if (!r.ok) { report[appId] = `http ${r.status}`; return }
        report[appId] = (await this.take(await r.text(), appId)) ?? 'updated'
      } catch (e) { report[appId] = `unreachable: ${String((e as Error)?.message ?? e)}` }
    }))
    return report
  }
}

/** One executable element, as the frame turns it into a blob: script. */
export interface PlanStep { tagStart: number; start: number; end: number; text: string; module: boolean }

export type Verdict =
  | { verdict: 'genuine'; appId: string; release: HistoryEntry; plan: PlanStep[] }
  | { verdict: 'unknown'; reason: string }

/**
 * Gate 1 against every held history (never one the file names: a fresh shell's
 * document block names no app). GENUINE carries the plan: the executable
 * elements gate 1's own scanner found, by offset, in document order. The frame
 * turns exactly those into scripts; its CSP refuses anything else.
 */
export async function judge(html: string, held: History[]): Promise<Verdict> {
  if (!held.length) return { verdict: 'unknown', reason: 'no signed release history is held' }
  const v = await verifyServedHeld(html, held)
  if (v.verdict !== 'genuine') return { verdict: 'unknown', reason: v.reason }
  const plan = executableScripts(scanBlocks(html)).map((b) => ({
    tagStart: b.tagStart, start: b.start, end: b.end, text: b.text, module: (b.type ?? '').toLowerCase() === 'module',
  }))
  return { verdict: 'genuine', appId: v.app!, release: v.release, plan }
}

/** Judge, and if the file is unknown to what is held, refresh once from the channel and judge again. */
export async function judgeWithRefresh(html: string, hs: Histories): Promise<Verdict> {
  const first = await judge(html, hs.list())
  if (first.verdict === 'genuine') return first
  await hs.refresh()
  return judge(html, hs.list())
}

/** Bytes to text, refusing anything that is not exactly UTF-8, so the text verified encodes back to the same bytes. */
export function decodeExact(bytes: ArrayBuffer | Uint8Array): string | null {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { return null }
}

/**
 * The document block of a file whose code did not verify, read with gate 1's
 * own scanner: exactly one `#bento-doc` data block, no "<" in it, valid JSON.
 * Its text is only ever DATA: it goes into a verified shell's empty block.
 * Returns { text, format } or a reason.
 */
export function extractDoc(html: string): { text: string; format: string | null } | { refuse: string } {
  const docs = scanBlocks(html).filter((b) => b.id === 'bento-doc')
  if (docs.length !== 1) return { refuse: `${docs.length} document blocks (exactly one expected)` }
  const b = docs[0]
  if (!isDataScript(b) || b.type !== 'application/bento+json') return { refuse: 'the document block is not a Bento data block' }
  if (b.text.includes('<')) return { refuse: 'the document block contains "<"' }
  const text = b.text.trim()
  if (!text) return { refuse: 'the document block is empty' }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return { refuse: 'the document block is not JSON' } }
  const format = parsed && typeof parsed === 'object' && typeof (parsed as { format?: unknown }).format === 'string'
    ? (parsed as { format: string }).format : null
  return { text, format }
}

/** Put a document's JSON text into a shell's EMPTY document block, by gate 1's offsets. */
export function spliceDoc(shell: string, docText: string): string | null {
  const docs = scanBlocks(shell).filter((b) => b.id === 'bento-doc')
  if (docs.length !== 1 || docs[0].text.trim() !== '' || docText.includes('<')) return null
  const b = docs[0]
  return shell.slice(0, b.start) + docText + shell.slice(b.start + b.text.length)
}

/**
 * The newest signed release of an app, as verified bytes: the signed manifest,
 * its pin over the shell, and the shell's own gate 1 verdict against the held
 * history (it must be genuine and that app's). `resolve` maps the signed
 * URL to the one fetched; trust comes from the pins, never from the URL.
 */
export async function newestShell(appId: string, hs: Histories, key: Jwk, base: string, net: Net,
  resolve: (url: string) => string | null): Promise<{ html: string; version: string } | { refuse: string }> {
  const app = APPS.find((a) => a.appId === appId)
  if (!app) return { refuse: 'no such app' }
  const root = base.endsWith('/') ? base : base + '/'
  let info: { version: string; sha256: string; url: string }
  try {
    const r = await net(`${root}${app.key}/manifest.json`, { cache: 'no-store', credentials: 'omit' })
    if (!r.ok) return { refuse: `the release channel answered ${r.status}` }
    info = await verifyManifest(await r.text(), appId, key)
  } catch (e) { return { refuse: String((e as Error)?.message ?? e) } }
  const url = resolve(info.url)
  if (!url) return { refuse: 'the signed shell is not on the release channel' }
  let bytes: ArrayBuffer
  try { bytes = await fetchPinned(net, url, info.sha256) } catch (e) { return { refuse: String((e as Error)?.message ?? e) } }
  const html = decodeExact(bytes)
  if (html === null) return { refuse: 'the signed shell is not UTF-8' }
  await hs.refresh()
  const v = await judge(html, hs.list())
  if (v.verdict !== 'genuine' || v.appId !== appId) return { refuse: `the signed shell does not verify against the history (${v.verdict === 'unknown' ? v.reason : v.appId})` }
  return { html, version: v.release.version }
}
